// Caps in US dollars; null means no cap. Shared by every session through the store.
export type Caps = { session: number | null; day: number | null }
// Per session id, in the store: the engine's cost reading already booked
// (`billed`, for the run that began at `startedAt`), this session's total, and
// its spend on the local date `date`.
export type Ledger = { startedAt: number; billed: number; session: number; date: string; mine: number }
// What the gauge draws: this session's spend, every session's spend today.
export type Spend = { session: number; day: number; date: string }
// One finished turn's cost, for the burn rate and the sparkline.
export type TurnCost = { at: number; usd: number }

declare module 'claude-code' {
  interface PluginState {
    'budget-governor': {
      caps: Caps
      spend: Spend
      turns: TurnCost[]
      turnMark: number
      toasted: string | null
      // False while the host reports no cost: nothing can be enforced.
      costKnown: boolean
    }
  }
}
