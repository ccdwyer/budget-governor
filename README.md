# Budget Governor

![Budget Governor demo: the gauge turns yellow past 80%, then the next prompt is refused at the cap until /budget raise](media/demo.gif)

[Full-quality video](https://github.com/ccdwyer/claude-mods/raw/main/media/budget-governor.mp4)

A Claude Code mod that enforces spending caps instead of just showing them.

- **Gauge above the prompt.** When a cap is set, it shows a fill bar, `$3.20 / $10 today · $1.10 / $5 session`, the burn rate in $/hr over the last hour of turns, and a sparkline of what each recent turn cost.
- **80% nudge.** Once you pass 80% of a cap, each prompt you send carries a note asking the model to finish concisely, take the direct path and skip broad exploration.
- **Hard stop at 100%.** At the cap, new prompts are refused, with a message naming the cap and how to raise it. That includes scheduled prompts, relayed prompts and background-task notifications, since each of those starts a billed turn. Real slash commands always go through, so `/budget` stays available. That includes skills and `/compact`, which do cost money. Text that only starts with a `/` is gated like any other prompt.
- **Mid-turn stop.** A turn that crosses the cap gets one refused tool call telling it to stop and summarize. If it, or one of its subagents, calls another tool after that, the turn is ended. Spend is checked at most every 5 seconds while tools run, and on every call once past 80%. The request already in flight, and that one summary, can still overshoot a little.
- **Daily cap across sessions.** Each session records only its own spend in a shared store, and the daily total adds up every session. Two terminals running at once can't overwrite each other's numbers, and a cap changed in one terminal applies in the others on their next check (within a minute, or sooner on a prompt or tool call). Each cap is stored on its own, so changing one never resets the other.
- **Fail closed.** If a check fails while a cap is set, or the cap settings can't be read at all, prompts are held and tools refused instead of slipping through.
- **Sessions.** The session cap applies to each session. `/clear` starts a new session with its own count, but its spend still adds to today's total. Resuming a session that began on an earlier day doesn't count its earlier spend against today. That earlier spend does still count toward its session cap. Session totals are kept for a year, so resuming an old conversation doesn't earn it a fresh session allowance.

## Commands

| Command | Effect |
|---|---|
| `/budget` | Show session and daily spend against the caps |
| `/budget session 5` | Cap this session (and later ones) at $5 |
| `/budget day 20` | Cap all sessions combined at $20 per local day |
| `/budget raise 5` | Raise whichever cap is blocking by $5 |
| `/budget off` | Remove all caps |

Caps are saved and carry over to later sessions. Costs are what Claude Code's `/cost` reports. They're booked as they're observed (at every prompt and turn end, and once a minute), so a turn that runs past midnight counts toward the new day. If the host stops reporting cost, the gauge says so, and caps keep being enforced against the last recorded spend.

## Install

```
/plugin marketplace add ccdwyer/claude-mods
/plugin install budget-governor@ccdwyer-mods
/reload-plugins
```

## Develop

```
claude plugin validate .
claude plugin test .
```

## What it hooks

Events this mod hooks, as `claude plugin validate` reads the module:

- `session.start`
- `session.end`
- `command.run{command=budget}`
- `turn.start`
- `turn.complete`
- `prompt.submit`
- `tool.call`
- `ui.render{component=AbovePrompt}`

Engine calls it makes: `$.clock.after`, `$.clock.every (via setUp)`, `$.clock.now`, `$.clock.sleep`, `$.command.list (via isCommand)`, `$.command.register (via setUp)`, `$.session.id (via refresh`, `settled)`, `$.session.usage (via refresh`, `settled)`, `$.state.get`, `$.state.set`, `$.store.delete`, `$.store.get`, `$.store.keys`, `$.store.set (via refresh`, `setCap)`, `$.turn.abort`, `$.ui.resolve`, `$.ui.toast`.

A `tool.call` hook sits in the middle of every tool call: it can see the call, refuse it, or add context to its result. This mod uses that only for the behaviour described above.

## Privacy

It runs entirely on your machine. It sends nothing over the network. It reads the session's cost from Claude Code and keeps a daily ledger in Claude Code's local plugin store.

The mod collects no analytics or telemetry, and its author receives no data from it.

Full policy: [PRIVACY.md](PRIVACY.md).

## License

MIT
