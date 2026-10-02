import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// 2026-10-02, midday local time.
const NOON = new Date(2026, 9, 2, 12).getTime()
const TODAY = '2026-10-02'

type World = { usd: number; id: string; startedAt: number; registered: string[]; known: boolean }

// A session that began an hour ago, today.
function world(on: On, store: Record<string, unknown> = {}): World & { clock: ReturnType<typeof mock.clock> } {
  const w: World = { usd: 0, id: 'S1', startedAt: NOON - 3_600_000, registered: [], known: true }
  const clock = mock.clock(on, { now: NOON })
  mock.store(on, store)
  on('session.id', () => ({ value: w.id }))
  on('session.usage', () => ({
    value: { startedAt: w.startedAt, context: {} as never, rateLimits: [], ...(w.known ? { cost: { usd: w.usd } } : {}) },
  }))
  on('prompt.submit', (_$, e) => ({ text: e.text, context: e.context }))
  on('command.list', () => ({ value: [{ name: 'compact', description: '', source: 'builtin' } as never] }))
  on('command.register', (_$, e) => {
    w.registered.push(e.name)
    return { value: undefined } as never
  })
  return Object.assign(w, { clock })
}

const budget = (args: string) => ({
  command: 'budget',
  args,
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 100 },
})
const person = (text: string) => ({ text, wait: false, origin: { kind: 'composer' as const } })

test('under 80% a prompt passes untouched', async ($, on) => {
  const w = world(on)
  await $.command.run(budget('session 10'))
  w.usd = 5
  const out = await $.prompt.submit(person('hello'))
  expect(out.drop).toBeUndefined()
  expect(out.context ?? []).toEqual([])
})

test('at 80% a prompt gets a wrap-up note', async ($, on) => {
  const w = world(on)
  await $.command.run(budget('session 10'))
  w.usd = 8.5
  const out = await $.prompt.submit(person('keep going'))
  expect(out.drop).toBeUndefined()
  expect(String(out.context?.[0])).toMatch(/Budget note/)
})

test('at the cap every prompt is refused, scheduled and task notifications too; slash commands pass', async ($, on) => {
  const w = world(on)
  await $.command.run(budget('session 10'))
  w.usd = 10.5
  expect((await $.prompt.submit(person('one more thing'))).drop).toMatch(/\/budget raise/)
  const cron = await $.prompt.submit({ text: 'nightly', wait: false, origin: { kind: 'scheduled-trigger' } as never })
  expect(cron.drop).toMatch(/cap/)
  expect((await $.prompt.submit(person('/budget raise 5'))).drop).toBeUndefined()
  const note = await $.prompt.submit({ text: 'task done', wait: false, origin: { kind: 'task-notification' } })
  expect(note.drop).toMatch(/cap/)
})

test('raise lifts the cap that is blocking', async ($, on) => {
  const w = world(on)
  await $.command.run(budget('session 10'))
  w.usd = 10.5
  const raised = await $.command.run(budget('raise 5'))
  expect(raised.text).toMatch(/Raised the session cap by \$5\.00/)
  expect((await $.prompt.submit(person('continue'))).drop).toBeUndefined()
})

test('the daily cap counts every session for today, not other days', async ($, on) => {
  const w = world(on, { [`day:${TODAY}:OTHER`]: 7, 'day:2026-10-01:OLD': 50 })
  await $.command.run(budget('day 10'))
  w.usd = 2
  expect(String((await $.prompt.submit(person('hi'))).context?.[0])).toMatch(/today's spend is \$9\.00/)
  w.usd = 3.5
  expect((await $.prompt.submit(person('hi again'))).drop).toMatch(/today's cap of \$10\.00/)
})

test('after /clear the new session starts its own count and the day keeps both', async ($, on) => {
  const w = world(on)
  await $.command.run(budget('day 10'))
  w.usd = 6
  await $.prompt.submit(person('a'))
  // /clear: new id, the engine's cost restarts from zero.
  w.id = 'S2'
  w.startedAt = NOON
  w.usd = 0
  await $.prompt.submit(person('b'))
  w.usd = 3
  const out = await $.command.run(budget(''))
  expect(out.text).toMatch(/This session: \$3\.00/)
  expect(out.text).toMatch(/Today, all sessions: \$9\.00 of \$10\.00/)
})

test("resuming an old session does not book its lifetime cost to today", async ($, on) => {
  const w = world(on)
  w.id = 'OLD'
  w.startedAt = NOON - 3 * 86_400_000 // began three days ago
  w.usd = 30 // spent on earlier days
  await $.command.run(budget('day 10'))
  w.usd = 31
  const out = await $.command.run(budget(''))
  expect(out.text).toMatch(/Today, all sessions: \$1\.00/)
  // ...but it still counts toward the session cap.
  expect(out.text).toMatch(/This session: \$31\.00/)
})

test('overlapping refreshes never book the same spend twice', async ($, on) => {
  const w = world(on)
  await $.command.run(budget('day 100'))
  w.usd = 4
  await Promise.all([$.prompt.submit(person('x')), $.prompt.submit(person('y')), $.command.run(budget(''))])
  const out = await $.command.run(budget(''))
  expect(out.text).toMatch(/This session: \$4\.00/)
  expect(out.text).toMatch(/Today, all sessions: \$4\.00/)
})

test('a cap another session set applies here, and per-field writes do not clobber it', async ($, on) => {
  // Another terminal already set a daily cap in the shared store.
  const w = world(on, { 'cap:day': 5 })
  w.usd = 0
  await $.prompt.submit(person('start'))
  w.usd = 6
  expect((await $.prompt.submit(person('go'))).drop).toMatch(/today's cap of \$5\.00/)
  await $.command.run(budget('session 60'))
  const out = await $.command.run(budget(''))
  expect(out.text).toMatch(/Today, all sessions: \$6\.00 of \$5\.00/)
})

test('a turn that crosses the cap stops calling tools', async ($, on) => {
  const w = world(on)
  on('tool.call', () => ({ result: 'ok' }))
  await $.command.run(budget('session 10'))
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toBeUndefined()
  w.usd = 11
  await $.command.run(budget(''))
  const blocked = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(blocked.deny).toMatch(/Do not call more tools/)
})

test('off removes caps and nothing is gated', async ($, on) => {
  const w = world(on)
  await $.command.run(budget('session 1'))
  await $.command.run(budget('off'))
  w.usd = 100
  expect((await $.prompt.submit(person('free'))).drop).toBeUndefined()
})

test('the gauge draws only with a cap, and keeps the band of plugins beneath', async ($, on) => {
  const w = world(on)
  on('ui.render', { component: 'AbovePrompt' }, () => h('Text', {}, 'beneath') as never)
  const props = { hasSurvey: false, isWorking: false, maxRows: 4, bodyColumns: 100 } as never
  for (const surface of ['terminal', 'desktop'] as const) {
    const quiet = await $.ui.mount({ plugin: 'budget-governor', surface, component: 'AbovePrompt', props })
    expect(await quiet.find({ text: /today/ })).toBeUndefined()
    await quiet.unmount()
  }
  await $.command.run(budget('day 10'))
  w.usd = 3
  await $.command.run(budget(''))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'budget-governor', surface, component: 'AbovePrompt', props })
    expect(await ui.find({ text: /\$3\.00 \/ \$10\.00 today/ })).toBeDefined()
    expect(await ui.find({ text: 'beneath' })).toBeDefined()
    await ui.unmount()
  }
})

test('a new session that already spent today is booked in full on first sight', async ($, on) => {
  const w = world(on)
  w.usd = 4 // began an hour ago, before this process saw it
  const out = await $.command.run(budget(''))
  expect(out.text).toMatch(/Today, all sessions: \$4\.00/)
})

test('text that only starts with a slash is still gated; real commands pass', async ($, on) => {
  const w = world(on)
  await $.command.run(budget('session 10'))
  w.usd = 11
  expect((await $.prompt.submit(person('/please continue the migration'))).drop).toMatch(/cap/)
  expect((await $.prompt.submit(person('/compact'))).drop).toBeUndefined()
  expect((await $.prompt.submit(person('/budget'))).drop).toBeUndefined()
})

test('no cost reading: nothing is booked, and /budget says the last recorded spend is used', async ($, on) => {
  const store: Record<string, unknown> = {}
  mock.clock(on, { now: NOON })
  mock.store(on, store)
  on('session.id', () => ({ value: 'S1' }))
  on('session.usage', () => ({ value: { startedAt: NOON, context: {} as never, rateLimits: [] } }))
  on('command.list', () => ({ value: [] }))
  await $.command.run(budget('day 5'))
  const out = await $.command.run(budget(''))
  expect(out.text).toMatch(/last recorded spend/)
  expect(out.text).toMatch(/Today, all sessions: \$0\.00/)
})

test('a tool call sees a cap set in another window without waiting for a prompt', async ($, on) => {
  const w = world(on, { 'cap:day': 5 })
  on('tool.call', () => ({ result: 'ok' }))
  w.usd = 6
  const blocked = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(blocked.deny).toMatch(/daily spend cap of \$5\.00/)
})

test('raise opens every shut cap', async ($, on) => {
  const w = world(on)
  await $.command.run(budget('session 10'))
  await $.command.run(budget('day 10'))
  w.usd = 12
  const raised = await $.command.run(budget('raise 2'))
  expect(raised.text).toMatch(/Raised the (session and daily|daily and session) cap/)
  expect((await $.prompt.submit(person('go on'))).drop).toBeUndefined()
})

test('after /clear: the last spend is booked, then the command and count come back for the new id', async ($, on) => {
  const w = world(on)
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('session.start', () => ({ cwd: '/' }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: true } as never)
  expect(w.registered).toEqual(['budget'])
  w.usd = 2
  await $.prompt.submit(person('a'))
  w.usd = 3 // spent during the last turn, never refreshed before /clear
  await $.session.end({ reason: 'clear', sessionId: 'S1', resume: {} as never })
  w.id = 'S2'
  w.startedAt = NOON
  w.usd = 0
  for (let i = 0; i < 6; i += 1) await w.clock.advance(500)
  expect(w.registered).toEqual(['budget', 'budget'])
  w.usd = 1
  const out = await $.command.run(budget(''))
  expect(out.text).toMatch(/This session: \$1\.00/)
  expect(out.text).toMatch(/Today, all sessions: \$4\.00/)
})

test('a subagent tool call after the warning ends the main turn; a failed abort still denies', async ($, on) => {
  const w = world(on)
  let failAbort = true
  const aborted: string[] = []
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.abort', (_$, e) => {
    if (failAbort) throw new Error('turn is ending')
    aborted.push(e.turnId)
    return { value: undefined }
  })
  await $.command.run(budget('session 10'))
  await $.turn.start({ turnId: 'T1' } as never)
  w.usd = 11
  await w.clock.advance(6_000)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toMatch(/short summary/)
  const sub = { tool: 'Bash' as const, command: 'ls', agentId: 'A1' } as never
  expect((await $.tool.call(sub)).deny).toMatch(/turn was ended/)
  expect(aborted).toEqual([])
  failAbort = false
  expect((await $.tool.call(sub)).deny).toMatch(/turn was ended/)
  expect(aborted).toEqual(['T1'])
})

test('a new run of the same session (startedAt changed) books its whole reading', async ($, on) => {
  const w = world(on)
  w.usd = 9
  await $.command.run(budget('session 10'))
  w.startedAt = NOON + 1
  w.usd = 3
  const out = await $.command.run(budget(''))
  expect(out.text).toMatch(/This session: \$12\.00/)
})

test('with cost unavailable, spend already recorded still enforces the cap', async ($, on) => {
  const w = world(on)
  await $.command.run(budget('session 10'))
  w.usd = 11
  await $.command.run(budget(''))
  w.known = false
  expect((await $.prompt.submit(person('more'))).drop).toMatch(/cap/)
})

test('a tool call after the stop-and-summarize warning ends the turn', async ($, on) => {
  const w = world(on)
  const aborted: string[] = []
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }) as never)
  on('turn.abort', (_$, e) => {
    aborted.push(e.turnId)
    return { value: undefined }
  })
  await $.command.run(budget('session 10'))
  await $.turn.start({ turnId: 'T1' } as never)
  w.usd = 11
  await w.clock.advance(6_000)
  const first = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(first.deny).toMatch(/short summary/)
  expect(aborted).toEqual([])
  const second = await $.tool.call({ tool: 'Bash', command: 'ls' })
  expect(second.deny).toMatch(/turn was ended/)
  expect(aborted).toEqual(['T1'])
})

test('a fresh process that cannot read the store holds prompts instead of failing open', async ($, on) => {
  mock.clock(on, { now: NOON })
  const broken = () => {
    throw new Error('store unavailable')
  }
  on('store.get', broken)
  on('store.set', broken)
  on('store.keys', broken)
  on('store.delete', broken)
  on('session.id', () => ({ value: 'S1' }))
  on('session.usage', () => ({ value: { startedAt: NOON, context: {} as never, rateLimits: [], cost: { usd: 1 } } }))
  on('command.list', () => ({ value: [] }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('tool.call', () => ({ result: 'ok' }))
  expect((await $.prompt.submit(person('hi'))).drop).toMatch(/could not check spend/)
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).deny).toMatch(/could not check spend/)
})
