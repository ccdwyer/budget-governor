import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Caps, Ledger, Spend, TurnCost } from '../types'

const caps = atom({ plugin: 'budget-governor', key: 'caps' } as const, { session: null, day: null })
const spend = atom({ plugin: 'budget-governor', key: 'spend' } as const, { session: 0, day: 0, date: '' })
const turns = atom({ plugin: 'budget-governor', key: 'turns' } as const, [])
const turnMark = atom({ plugin: 'budget-governor', key: 'turnMark' } as const, 0)
const toasted = atom({ plugin: 'budget-governor', key: 'toasted' } as const, null)
const costKnown = atom({ plugin: 'budget-governor', key: 'costKnown' } as const, true)

const WARN = 0.8
// Day keys are kept a week; ledgers (each session's running total) much longer,
// so resuming an old conversation cannot earn a fresh session allowance.
const KEEP_DAYS = 7
const KEEP_LEDGER_DAYS = 365
const TICK_MS = 60_000
// How stale the numbers may be when a tool call checks the cap mid-turn.
const TOOL_CHECK_MS = 5_000
const SPARK = '▁▂▃▄▅▆▇█'
const DAY_MS = 86_400_000

// The store is shared by every session of this plugin and is the source of truth.
// Each session id writes only its own keys, so concurrent sessions never
// overwrite each other; the day's total is the sum over every session's day key.
// Each cap has a key of its own, so changing one never writes back a stale other.
const CAP_KEYS = { session: 'cap:session', day: 'cap:day' } as const
const dayPrefix = (date: string) => `day:${date}:`
const ledgerKey = (id: string) => `ledger:${id}`

const money = (usd: number) => `$${usd.toFixed(2)}`

function localDate(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function parseUsd(text: string | undefined): number | null {
  const n = Number(String(text ?? '').replace(/^\$/, ''))
  return Number.isFinite(n) && n > 0 ? n : null
}

const isAmount = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0
const asCap = (n: unknown): number | null => (isAmount(n) && n > 0 ? n : null)

// A stored ledger, or undefined when it is missing or not one (never trusted blindly).
function asLedger(value: unknown): Ledger | undefined {
  const v = value as Partial<Ledger> | undefined
  if (v === undefined || v === null || typeof v !== 'object') return undefined
  const ok =
    isAmount(v.startedAt) && isAmount(v.billed) && isAmount(v.session) && isAmount(v.mine) &&
    typeof v.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.date)
  return ok ? (v as Ledger) : undefined
}

type Level = { ratio: number; which: 'session' | 'day' | null; cap: number | null; spent: number }

function levels(c: Caps, s: Spend): Level[] {
  const out: Level[] = []
  if (c.session !== null) out.push({ ratio: s.session / c.session, which: 'session', cap: c.session, spent: s.session })
  if (c.day !== null) out.push({ ratio: s.day / c.day, which: 'day', cap: c.day, spent: s.day })
  return out.sort((a, b) => b.ratio - a.ratio)
}

// The tightest cap: how close this session is to whichever limit it hits first.
function level(c: Caps, s: Spend): Level {
  return levels(c, s)[0] ?? { ratio: 0, which: null, cap: null, spent: 0 }
}

const hasCaps = (c: Caps) => c.session !== null || c.day !== null

async function dayTotal($: EngineInterface, date: string): Promise<number> {
  const keys = (await $.store.keys()).filter(k => k.startsWith(dayPrefix(date)))
  let total = 0
  for (const key of keys) {
    const n = await $.store.get(key)
    if (isAmount(n)) total += n
  }
  return total
}

async function loadCaps($: EngineInterface): Promise<Caps> {
  return { session: asCap(await $.store.get(CAP_KEYS.session)), day: asCap(await $.store.get(CAP_KEYS.day)) }
}

// Module variables: a hot reload starts them over, which is harmless here.
let queue: Promise<unknown> = Promise.resolve()
let lastRefreshAt = 0
let ticker: { cancel: () => void } | null = null
// The main turn now running, and whether it was already told to stop at the cap.
let running: { turnId: string; told: boolean } | null = null
// True once this process has read the caps from the store at least once.
let capsLoaded = false

// What a refresh read, straight from the store. Callers decide from this, never
// from a state read: every read in one dispatch sees the moment it began, so a
// value written during the dispatch is invisible to it.
type Now = { spend: Spend; caps: Caps; known: boolean }

// Refreshes in this process run one at a time: each reads the ledger, books the
// delta and writes it back, so two overlapping refreshes never book a dollar twice.
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work)
  queue = run.catch(() => undefined)
  return run
}

// Book what this session cost since it was last booked, then reload the shared
// caps and the day's total so the gate and the gauge see every session.
function refresh($: EngineInterface): Promise<Now> {
  return serial(async () => {
    const now = await $.clock.now()
    const date = localDate(now)
    const id = await $.session.id()
    const usage = await $.session.usage()
    const usd = usage.cost?.usd
    const known = isAmount(usd)
    if (known !== (await read($, costKnown))) await update($, costKnown, () => known)

    if (known) {
      const saved = asLedger(await $.store.get(ledgerKey(id)))
      let ledger: Ledger
      if (saved === undefined) {
        // First sight of this session: all of its cost counts toward the session
        // cap. Toward today only if the run began today; a resumed older one spent
        // it on earlier days.
        const today = localDate(usage.startedAt) === date
        ledger = { startedAt: usage.startedAt, billed: usd, session: usd, date, mine: today ? usd : 0 }
      } else {
        // Same run: the gap since the last booking is new spend (a lower reading is
        // a blip, never negative). A resumed session keeps its first launch's
        // startedAt, so a different one means a new run whose counter began at
        // zero: all of its reading is new spend.
        const delta = saved.startedAt === usage.startedAt ? Math.max(0, usd - saved.billed) : usd
        // Spend is booked to the date it is observed on; the minute ticker keeps
        // the share that lands on the wrong side of midnight small.
        const mine = (saved.date === date ? saved.mine : 0) + delta
        const billed = saved.startedAt === usage.startedAt ? Math.max(usd, saved.billed) : usd
        ledger = { startedAt: usage.startedAt, billed, session: saved.session + delta, date, mine }
      }
      // Today's key first: if the process dies between the two writes, the ledger
      // still holds the old reading and the next refresh books the delta again
      // onto the same key, instead of losing it.
      if (ledger.mine > 0) await $.store.set(`${dayPrefix(date)}${id}`, ledger.mine)
      await $.store.set(ledgerKey(id), ledger)
    }

    const shared = await loadCaps($)
    const current = await read($, caps)
    if (shared.session !== current.session || shared.day !== current.day) await update($, caps, () => shared)

    const ledger = asLedger(await $.store.get(ledgerKey(id)))
    const next: Spend = { session: ledger?.session ?? 0, day: await dayTotal($, date), date }
    const was = await read($, spend)
    if (next.session !== was.session || next.day !== was.day || next.date !== was.date) await update($, spend, () => next)
    lastRefreshAt = now
    capsLoaded = true
    return { spend: next, caps: shared, known }
  })
}

function setCap($: EngineInterface, which: 'session' | 'day', value: number | null): Promise<void> {
  return serial(async () => {
    if (value === null) await $.store.delete(CAP_KEYS[which])
    else await $.store.set(CAP_KEYS[which], value)
    // Mirror every cap from the store, so this write never puts back a stale other.
    const shared = await loadCaps($)
    await update($, caps, () => shared)
    await update($, toasted, () => null)
  })
}

function describe(c: Caps, s: Spend, known: boolean): string {
  const line = (label: string, spent: number, cap: number | null) =>
    cap === null ? `${label}: ${money(spent)} (no cap)` : `${label}: ${money(spent)} of ${money(cap)} (${Math.floor((spent / cap) * 100)}%)`
  return [
    ...(known ? [] : ['Current cost is not reported right now; caps use the last recorded spend.', '']),
    line('This session', s.session, c.session),
    line('Today, all sessions', s.day, c.day),
    '',
    'Commands: /budget session <$>, /budget day <$>, /budget raise <$>, /budget off',
  ].join('\n')
}

// What a new session needs, and what a /clear or a resume needs again: the
// command, the numbers, and a minute ticker bound to this session's `$`.
async function setUp($: EngineInterface) {
  await $.command.register({
    name: 'budget',
    description: 'Budget Governor: show spend, or set caps (session <$> | day <$> | raise <$> | off)',
    argumentHint: '[session <$> | day <$> | raise <$> | off]',
    immediate: true,
  })
  const { spend: s } = await refresh($)
  await update($, turnMark, () => s.session)
  await update($, turns, () => [])
  ticker?.cancel()
  ticker = $.clock.every(TICK_MS, () => void refresh($))
}

// After a resume the engine switches the session id first and restores that
// session's cost and startedAt a moment later. Book nothing until two readings
// half a second apart agree, so the old conversation's cost is never booked
// to the new id.
async function settled($: EngineInterface): Promise<void> {
  const reading = async () => {
    const u = await $.session.usage()
    return `${await $.session.id()}|${u.startedAt}|${u.cost?.usd ?? 'none'}`
  }
  let last = await reading()
  for (let i = 0; i < 10; i += 1) {
    await $.clock.sleep(500)
    const now = await reading()
    if (now === last) return
    last = now
  }
}

async function setUpOrSay($: EngineInterface) {
  try {
    await settled($)
    await setUp($)
  } catch {
    $.ui.toast('Budget Governor could not set up after /clear; run /reload-plugins')
  }
}

// Over the cap with a cap set: refuse. A hook that throws is skipped and the
// prompt or tool would go through, so a failed check with a cap set fails closed.
async function capsSet($: EngineInterface): Promise<boolean> {
  try {
    return hasCaps(await loadCaps($))
  } catch {
    // Store unreadable: trust the cached caps only if they were ever loaded;
    // otherwise a cap may exist that this process cannot see, so hold.
    return capsLoaded ? hasCaps(await read($, caps)) : true
  }
}

// A slash command the session knows passes the gate (so /budget is always the
// way out); text that merely starts with "/" is a prompt like any other.
async function isCommand($: EngineInterface, text: string): Promise<boolean> {
  const match = /^\/([\w:.-]+)(\s|$)/.exec(text.trimStart())
  const name = match?.[1]
  if (name === undefined) return false
  if (name === 'budget') return true
  try {
    return (await $.command.list()).some(c => c.name === name)
  } catch {
    return false
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const now = await $.clock.now()
    const dayCutoff = localDate(now - KEEP_DAYS * DAY_MS)
    const ledgerCutoff = localDate(now - KEEP_LEDGER_DAYS * DAY_MS)
    for (const key of await $.store.keys()) {
      if (key.startsWith('day:') && key.slice(4, 14) < dayCutoff) await $.store.delete(key)
      if (key.startsWith('ledger:')) {
        const l = asLedger(await $.store.get(key))
        if (l === undefined || l.date < ledgerCutoff) await $.store.delete(key)
      }
    }
    await setUp($)
    return next(e)
  })

  // /clear and resume go on under a new session id with no session.start. The
  // set-up is scheduled before the end chain runs: session.end has a short
  // wall-clock budget, and work queued after it might never be reached.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') {
      running = null
      $.clock.after(250, () => void setUpOrSay($))
    }
    // The ending session is still the current one here: book its last spend
    // before the id moves on. Bounded, so the end chain keeps its short budget.
    try {
      await Promise.race([refresh($), $.clock.sleep(800)])
    } catch {
      // Booking is best effort at exit; the next refresh of this id catches up.
    }
    return next(e)
  })

  on('command.run', { command: 'budget' }, async ($, e) => {
    const [verb, amount] = e.args.trim().split(/\s+/)
    const usd = parseUsd(amount)
    let note = ''
    if (verb === 'session' || verb === 'day') {
      if (usd === null) return { text: `Budget Governor: give a dollar amount, e.g. /budget ${verb} 10` }
      await setCap($, verb, usd)
      note = `${verb === 'day' ? 'Daily' : 'Session'} cap set to ${money(usd)}.\n\n`
    } else if (verb === 'raise') {
      if (usd === null) return { text: 'Budget Governor: give a dollar amount, e.g. /budget raise 5' }
      const now = await refresh($)
      if (!hasCaps(now.caps)) return { text: 'Budget Governor: no cap is set. Use /budget session <$> or /budget day <$>.' }
      // Raise every cap that is shut, so one raise always opens the gate;
      // with none shut, raise the tightest.
      const all = levels(now.caps, now.spend)
      const shut = all.filter(l => l.ratio >= 1)
      const targets = shut.length > 0 ? shut : all.slice(0, 1)
      for (const t of targets) {
        if (t.which === null || t.cap === null) continue
        // A shut cap is raised past what is already spent, so the raise is real headroom.
        await setCap($, t.which, Math.max(t.cap, t.spent) + usd)
      }
      const names = targets.map(t => (t.which === 'day' ? 'daily' : 'session')).join(' and ')
      note = `Raised the ${names} cap by ${money(usd)}.\n\n`
    } else if (verb === 'off') {
      await setCap($, 'session', null)
      await setCap($, 'day', null)
      note = 'All caps removed.\n\n'
    } else if (verb !== undefined && verb !== '') {
      const now = await refresh($)
      return { text: `Budget Governor: unknown option "${verb}".\n\n${describe(now.caps, now.spend, now.known)}` }
    }
    const now = await refresh($)
    return { text: `${note}${describe(now.caps, now.spend, now.known)}` }
  })

  on('turn.start', (_$, e, next) => {
    running = { turnId: e.turnId, told: false }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const ran = await next(e)
    if (e.agentId !== undefined) return ran
    if (running?.turnId === e.turnId) running = null
    const { spend: s } = await refresh($)
    const mark = await read($, turnMark)
    const at = await $.clock.now()
    await update($, turns, list => [...list, { at, usd: Math.max(0, s.session - mark) } satisfies TurnCost].slice(-24))
    await update($, turnMark, () => s.session)
    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    // A real slash command always passes: /budget is the way out.
    if (await isCommand($, e.text)) return next(e)
    let lv: Level
    try {
      const now = await refresh($)
      lv = level(now.caps, now.spend)
    } catch {
      if (!(await capsSet($))) return next(e)
      return { drop: 'Budget Governor could not check spend just now, so the prompt was held. Try again, or run /budget off.' }
    }
    if (lv.which === null || lv.cap === null) return next(e)
    const scope = lv.which === 'day' ? "today's" : "this session's"

    // Every origin is gated at the cap: scheduled prompts and task notifications
    // start billed turns too.
    if (lv.ratio >= 1) {
      const mark = `${lv.which}:${lv.cap}`
      if ((await read($, toasted)) !== mark) {
        await update($, toasted, () => mark)
        $.ui.toast(`Budget cap reached: ${money(lv.spent)} of ${money(lv.cap)}`)
      }
      return {
        drop:
          `Budget Governor: ${scope} cap of ${money(lv.cap)} is reached (${money(lv.spent)} spent). ` +
          `Run /budget raise <$> to continue, or /budget off to remove caps.`,
      }
    }
    if (lv.ratio >= WARN) {
      const note =
        `Budget note from the user's Budget Governor: ${scope} spend is ${money(lv.spent)} of a ` +
        `${money(lv.cap)} cap (${Math.floor(lv.ratio * 100)}%). Finish the task concisely: prefer the ` +
        `most direct path, avoid broad exploration, large file reads and speculative work, and ` +
        `stop to ask the user rather than starting long investigations.`
      return next({ ...e, context: [...(e.context ?? []), note] })
    }
    return next(e)
  })

  // A turn that crosses the cap is told once, through a refused tool call, to stop
  // and summarize. Any tool call after that, a subagent's included, ends the main
  // turn (the only turn the host lets a plugin end, and ending it ends its
  // subagents). Only the request already in flight, and that one summary, can
  // overshoot. A failed check with a cap set takes the same path.
  on('tool.call', async ($, e, next) => {
    let lv: Level | null
    try {
      const now = await $.clock.now()
      const before = level(await read($, caps), await read($, spend))
      const isStale = now - lastRefreshAt >= TOOL_CHECK_MS
      // Near the line, check every call; otherwise every few seconds at most.
      if (isStale || before.ratio >= WARN) {
        const fresh = await refresh($)
        lv = level(fresh.caps, fresh.spend)
      } else {
        lv = before
      }
    } catch {
      if (!(await capsSet($))) return next(e)
      lv = null
    }
    if (lv !== null && (lv.ratio < 1 || lv.cap === null)) return next(e)

    const turn = running
    if (turn !== null && turn.told) {
      try {
        await $.turn.abort({ turnId: turn.turnId })
        if (running === turn) running = null
      } catch {
        // Not ended (already ending, or not the running turn): keep it, so the
        // next call tries again. The deny below stands either way.
      }
      return { deny: 'Budget Governor: spend cap reached; the turn was ended.' }
    }
    if (turn !== null) turn.told = true
    if (lv === null) {
      return { deny: 'Budget Governor could not check spend just now. Stop and tell the user; they can run /budget off.' }
    }
    return {
      deny:
        `Budget Governor: the user's ${lv.which === 'day' ? 'daily' : 'session'} spend cap of ` +
        `${money(lv.cap ?? 0)} is reached (${money(lv.spent)} spent). Do not call more tools. Stop now and ` +
        `give the user a short summary of where things stand and what is left. The user can run ` +
        `/budget raise <$> to continue.`,
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const c = await read($, caps)
    if (e.props.hasSurvey || !hasCaps(c)) return next(e)
    const s = await read($, spend)
    const known = await read($, costKnown)
    const history = await read($, turns)
    const lv = level(c, s)
    const { Box, Text } = $.ui.resolve(e)

    const width = 10
    const filled = lv.ratio >= 1 ? width : Math.min(width - 1, Math.floor(lv.ratio * width))
    const color = lv.ratio >= 1 ? 'red' : lv.ratio >= WARN ? 'yellow' : 'green'

    // Burn rate over the last hour of turns, from the first of them; shown once
    // there are two turns to measure between.
    const now = await $.clock.now()
    const recent = history.filter(t => now - t.at <= 3_600_000)
    const first = recent[0]
    const hours = first === undefined ? 0 : Math.max((now - first.at) / 3_600_000, 1 / 60)
    const burn = recent.length >= 2 ? recent.reduce((sum, t) => sum + t.usd, 0) / hours : 0

    const last = history.slice(-12)
    const top = Math.max(...last.map(t => t.usd), 0)
    const spark = last.map(t => SPARK[top > 0 ? Math.min(7, Math.floor((t.usd / top) * 7.999)) : 0]).join('')

    const parts: string[] = []
    if (!known) parts.push('cost unavailable: using last recorded spend')
    if (c.day !== null) parts.push(`${money(s.day)} / ${money(c.day)} today`)
    if (c.session !== null) parts.push(`${money(s.session)} / ${money(c.session)} session`)
    if (lv.ratio >= 1) parts.push('cap reached')
    if (burn > 0) parts.push(`${money(burn)}/hr`)

    // The band is shared: draw ours above whatever the plugins beneath drew.
    const below = await next(e)
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={color}>{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(width - filled)} </Text>
          <Text>{parts.join(' · ')} </Text>
          {spark !== '' && <Text dimColor>{spark}</Text>}
        </Box>
        {below}
      </Box>
    )
  })
}
