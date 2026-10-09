export type Thread = {
  name: string
  model: string
  // «создаётся» — заготовка сессии и открытие чата; «ждёт» — чат есть, но сигнал «Начинай» до него ещё не дошёл
  status: 'создаётся' | 'ждёт' | 'работает' | 'готов' | 'ошибка' | 'остановлен'
  step: string
  actions: number
  cwd: string
  costUsd: number
  startedAt: number
  endedAt: number
  reportToken?: string
  sessionId: string
  result: string
  log: string[]
  kind: 'chat' | 'cli'
  // Итог уже ушёл в сводку главному диалогу (результат при этом остаётся доступен инструменту result)
  reported?: boolean
  // С чем поток запущен — send продолжает его с теми же настройками
  mode?: string
  effort?: string
  readOnly?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    threads: { list: Thread[] }
  }
}
