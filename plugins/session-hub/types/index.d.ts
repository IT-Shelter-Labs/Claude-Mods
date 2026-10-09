/** Где диалог стоит в панели */
export type HubState = 'running' | 'background' | 'waiting' | 'done'

/** Строка панели: только то, что видно, — поэтому снимок меняется (и панель перерисовывается) редко */
export type HubSession = {
  id: string
  title: string
  project: string
  link: string | null
  state: HubState
  /** «10 мин назад»; у работающих пусто */
  when: string
  /** Когда начал работать (мс эпохи) — секундомер карточки; у остальных null */
  startedAt: number | null
}

/** Снимок списка: пишется одним значением и только когда изменился — одна перерисовка на изменение */
export type HubView = {
  sessions: HubSession[]
  error: string | null
  /** Показан снимок из кэша прошлых диалогов, свежий ещё не пришёл */
  isStale: boolean
  /** Хоть один снимок есть — иначе «Загружаю…» */
  hasData: boolean
}

/** Этот диалог: list_sessions его не возвращает, поэтому статус — из его собственных ходов */
export type HubSelf = {
  title: string
  isRunning: boolean
  /** Начало текущего хода этого диалога */
  startedAt: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-hub': {
      view: HubView
      self: HubSelf
      showAllDone: boolean
      /** Завершённые скрыты — общий выбор всех диалогов */
      hideDone: boolean
      query: string
    }
  }
}
