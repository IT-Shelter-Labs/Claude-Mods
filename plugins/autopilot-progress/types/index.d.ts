export type Tests = { passed: number; failed: number }
export type Stage = { id: string; status: string; startedAt?: string; finishedAt?: string; note?: string }
export type Ticket = {
  id: string
  title: string
  status: string
  wave: number
  blockedBy: string[]
  startedAt?: string
  finishedAt?: string
  retries: number
  repairs: number
  tests: Tests | null
}
export type Run = {
  key: string
  // Папка проекта, где лежит .autopilot: сессия или другая рабочая копия (git worktree)
  root: string
  // Подпись копии, когда прогон идёт не в папке сессии: «platform-ai-redesign · redesign»
  where?: string
  title: string
  dir: string
  mode?: string
  depth?: string
  tier?: string
  startedAt?: string
  updatedAt?: string
  finishedAt?: string
  stages: Stage[]
  tickets: Ticket[]
  req: { total: number; done: number; dropped: number; deferred: number; placeholder: number }
  tests: Tests | null
  debt: { placeholders: string[]; assumptions: string[]; emptyEnv: string[] }
  additions: string[]
  blind: { checked: number; matched: number; mismatches: string[] } | null
  beats: string[]
  // Ярус T0: сборка одним заходом, без тасков
  single: { startedAt?: string; finishedAt?: string; files: number } | null
  finished: boolean
}
// Какие разделы панели раскрыты; details: null — «по умолчанию» (раскрыт, когда прогон сдан)
export type Sections = { stages: boolean; tickets: boolean; details: boolean | null }
// Все значения updatedAt, которые мод видел за прогон: агент перезаписывает метку,
// а без прошлых пульсов активное время прыгало бы назад после простоя
export type Seen = { key: string; beats: string[] }

declare module 'claude-code' {
  interface PluginState {
    'autopilot-progress': {
      run: Run | null
      isActive: boolean
      isHidden: boolean
      now: number
      seen: Seen
      open: Sections
    }
  }
}
