export type Gauge = { ctx: number | null; h5: number | null; d7: number | null; cacheMin: number | null; h5Reset: string; d7Reset: string }
declare module 'claude-code' {
  interface PluginState { ctx: { gauge: Gauge; lastTurnAt: number; isTerminal: boolean } }
}
