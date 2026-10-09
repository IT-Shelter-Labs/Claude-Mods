export type AskAt = number
export type HandoffPending = { path: string; transferId: string; startedAt: number; writeTurnId: string | null }
export type HandoffSessionMark = { askAt: AskAt; pending: HandoffPending | null; at: number }
declare module 'claude-code' { interface PluginState { handoff: { askAt: AskAt } } }
