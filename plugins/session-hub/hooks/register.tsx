import { atom, read, update } from 'claude-code'
import type { Hook, Register, RenderChildren } from 'claude-code'

import type { HubSelf, HubSession, HubState, HubView } from '../types'

const PANE = 'session-hub'
const VERSION = '1.15.0'
// Инструменты сессий даёт только приложение Claude (вкладка Code)
const SERVER = 'ccd_session_mgmt'
const VIEW_SERVER = 'ccd_view'
const POLL_IDLE = 15_000
const POLL_BUSY = 5_000
// Диалог не на экране: его панель никто не видит — опрос редкий
const POLL_HIDDEN = 30_000
// Новый диалог стартует раньше, чем приложение подключит ему инструменты сессий: первые неудачи — повтор, не ошибка
const POLL_RETRY = 3_000
const SILENT_FAILURES = 4
const DONE_PREVIEW = 5
const HOUR = 60 * 60_000
// Ход закончился, а активность диалога растёт — работают фоновые субагенты; столько держим его «в работе»
const BG_HOLD = 60_000
// Активность без замеченного конца хода: «ждёт ответа» только после стольких секунд тишины
const QUIET = 30_000
// Как часто живой диалог сверяется с общим переключателем панели
const SYNC_MS = 2_000
const SEEN_SELF_EVERY = 30_000
const LOG_KEEP = 40
const SEEN_KEEP = 200

// Открыта панель и скрыты ли завершённые — одно на все диалоги: файл, а не $.store, чтобы каждый
// процесс диалога читал свежее значение с диска, а не свою копию
const FLAG_FILE = '.claude/session-hub/pane.json'
const K_CACHE = 'lastSessions'
const K_SEEN = 'seenAt'
const K_BASELINE = 'baselineAt'
const K_LOG = 'log'
// Когда диалог начал работать — общий для всех панелей, чтобы секундомеры совпадали
const K_RUN = 'runStart'
// Ключи версии 1.1.0, когда открытость помнилась по диалогу
const LEGACY_PREFIX = 'open:'
const LEGACY_DEFAULT = 'defaultOpen'

const EMPTY: HubView = { sessions: [], error: null, isStale: false, hasData: false }

const view = atom({ plugin: 'session-hub', key: 'view' } as const, EMPTY)
const self = atom({ plugin: 'session-hub', key: 'self' } as const, {
  title: 'Этот диалог',
  isRunning: false,
  startedAt: null as number | null,
})
const showAllDone = atom({ plugin: 'session-hub', key: 'showAllDone' } as const, false)
const hideDone = atom({ plugin: 'session-hub', key: 'hideDone' } as const, false)
const query = atom({ plugin: 'session-hub', key: 'query' } as const, '')

type Dollar = Parameters<Hook<'session.start'>>[0]

type RawSession = {
  sessionId: string
  title?: string
  cwd?: string
  link?: string
  isRunning?: boolean
  isArchived?: boolean
  lastActivityAt?: string
}

type Seen = { isRunning: boolean; at: number }
type PaneFlag = { isOpen: boolean; hideDone: boolean; at: number; by: string }

// Модульные переменные живут, пока жив процесс диалога; приложение усыпляет простаивающие диалоги,
// и при возврате модуль загружается заново — всё, что должно пережить сон, лежит в $.store и в файле
let cliId = ''
let selfId = ''
let flagPath = ''
let isReady = false
let paneUp = false
let timer: { cancel: () => void } | null = null
let syncTimer: { cancel: () => void } | null = null
let failures = 0
let cachedJson = ''
let flagMtime = -1
let selfSeenAt = 0
// Закрытие, которое сделала сама синхронизация, — не действие человека, флаг не трогает
let isSyncClosing = false
// Последний сырой список и что видели на прошлом опросе — по ним отличаем конец хода от фоновых субагентов
let raw: RawSession[] = []
const prev = new Map<string, Seen>()
// Кнопки панели между перерисовками — те же объекты. Движок выдаёт кнопке номер при её создании,
// а нажатие приходит с номером, который кнопка имела на экране. Создай её заново — и клик, пришедший
// во время перерисовки (а панель перерисовывается, например, когда забирает клавиатуру после первого
// клика), уходит по старому номеру и теряется. Пока подпись та же — отдаём прежний объект с прежним номером
const buttons = new Map<string, { sig: string; el: any }>()
const bgUntil = new Map<string, number>()
const sawStop = new Set<string>()

export function projectOf(cwd: string | undefined): string {
  if (!cwd) return '—'
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean)
  const last = parts[parts.length - 1] ?? cwd
  // Сессии без папки живут во временном каталоге приложения
  return cwd.includes('/scratch-workspaces/') ? 'без папки' : last
}

// Крупные ступени: текст меняется редко — и панель не перерисовывается каждую минуту.
// Любая перерисовка выдаёт кнопкам новые адреса, и нажатие, пришедшее по старому, теряется
function ago(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000))
  if (min < 5) return 'сейчас'
  if (min < 60) return `${Math.floor(min / 5) * 5} мин`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h} ч`
  return `${Math.floor(h / 24)} дн`
}

// Сколько работает — минутами: меняется раз в минуту, и панель перерисовывается так же редко
function workedFor(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000))
  if (min < 1) return 'только начал'
  if (min < 60) return `${min} мин`
  return `${Math.floor(min / 60)} ч ${min % 60} мин`
}

function activityOf(s: RawSession): number {
  return s.lastActivityAt ? Date.parse(s.lastActivityAt) : 0
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

// Ответ инструмента — JSON, иногда с пояснением перед ним
export function parseLoose(text: string | undefined): any {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    const at = text.search(/[[{]/)
    if (at < 0) throw new Error(text.slice(0, 120))
    return JSON.parse(text.slice(at))
  }
}

// $.mcp.call — без проверки разрешений и классификатора авто-режима; $.tool.call — запасной путь
// Какой путь сработал — тем и ходим дальше: запасной $.tool.call проходит проверку разрешений,
// и звать его каждые несколько секунд «на всякий случай» дорого
let ccdPath: 'mcp' | 'tool' | null = null

async function callCcd($: Dollar, server: string, name: string, args: Record<string, unknown>): Promise<any> {
  let first: unknown
  if (ccdPath !== 'tool') try {
    const r = await $.mcp.call(server, name, args)
    const text = r.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
    if (r.isError) throw new Error(text ?? 'ошибка инструмента')
    ccdPath = 'mcp'
    return (r as any).structuredContent ?? parseLoose(text)
  } catch (err) {
    first = err
    if (ccdPath === 'mcp') throw err
  }
  try {
    const answer: any = await $.tool.call({ tool: `mcp__${server}__${name}`, ...args } as any)
    if (answer.deny) throw new Error(answer.deny)
    if (answer.isError) throw new Error(answer.text ?? 'ошибка инструмента')
    ccdPath = 'tool'
    return parseLoose(answer.text)
  } catch (err) {
    $.ui.log(`session-hub: ${server}/${name}: mcp — ${errorText(first)}; tool — ${errorText(err)}`, { to: 'debug' })
    throw err
  }
}

async function setView($: Dollar, next: HubView): Promise<void> {
  const cur = await read($, view)
  if (JSON.stringify(cur) === JSON.stringify(next)) return
  await update($, view, () => next)
}

async function setSelf($: Dollar, patch: Partial<HubSelf>): Promise<void> {
  const cur = await read($, self)
  if (Object.entries(patch).every(([k, v]) => (cur as any)[k] === v)) return
  await update($, self, s => ({ ...s, ...patch }))
}

async function seenMap($: Dollar): Promise<Record<string, number>> {
  const v: any = await $.store.get(K_SEEN)
  return v && typeof v === 'object' ? v : {}
}

async function markSeen($: Dollar, marks: Record<string, number>): Promise<void> {
  const seen = { ...(await seenMap($)) }
  for (const [id, at] of Object.entries(marks)) {
    if (id && at > (seen[id] ?? 0)) seen[id] = at
  }
  const kept = Object.entries(seen)
    .sort((a, b) => b[1] - a[1])
    .slice(0, SEEN_KEEP)
  await $.store.set(K_SEEN, Object.fromEntries(kept))
}

// Раскладка по секциям из последнего сырого списка; зовётся после опроса и после «Прочитано»
async function classify($: Dollar): Promise<void> {
  const now = await $.clock.now()
  const seen = await seenMap($)
  const baseline = Number(await $.store.get(K_BASELINE)) || 0
  const stored: any = await $.store.get(K_RUN)
  const runStart: Record<string, number> = stored && typeof stored === 'object' ? { ...stored } : {}
  let isRunChanged = false
  const sessions: HubSession[] = raw.map(s => {
    const at = activityOf(s)
    let state: HubState
    if (s.isRunning) state = 'running'
    else if ((bgUntil.get(s.sessionId) ?? 0) > now) state = 'background'
    else if (at > (seen[s.sessionId] ?? baseline)) {
      // Конец хода видели — ждёт сразу; не видели — ждёт, когда активность затихнет
      state = sawStop.has(s.sessionId) || now - at >= QUIET ? 'waiting' : 'background'
    } else state = 'done'
    const isLive = state === 'running' || state === 'background'
    if (isLive && !runStart[s.sessionId]) {
      runStart[s.sessionId] = now
      isRunChanged = true
    } else if (!isLive && runStart[s.sessionId]) {
      delete runStart[s.sessionId]
      isRunChanged = true
    }
    return {
      id: s.sessionId,
      title: s.title || 'Без названия',
      project: projectOf(s.cwd),
      link: s.link ?? null,
      state,
      when: isLive ? workedFor(now - (runStart[s.sessionId] ?? now)) : ago(now - at),
      startedAt: isLive ? (runStart[s.sessionId] ?? null) : null,
    }
  })
  if (isRunChanged) await $.store.set(K_RUN, runStart)
  await setView($, { sessions, error: null, isStale: false, hasData: true })
}

async function loadSelf($: Dollar): Promise<void> {
  if (selfId) return
  try {
    const me = await callCcd($, SERVER, 'get_session', { session_id: 'self' })
    if (!me?.sessionId) return
    selfId = me.sessionId
    await setSelf($, { title: me.title || 'Этот диалог' })
  } catch {
    // инструменты ещё не подключены — следующий опрос попробует снова
  }
}

// Виден ли этот диалог на экране; не узнали — считаем видимым, чтобы не замедлить панель зря
async function checkShown($: Dollar): Promise<boolean> {
  try {
    const layout = await callCcd($, VIEW_SERVER, 'get_layout', {})
    return !Array.isArray(layout?.views) || layout.views.length > 0
  } catch {
    return true
  }
}

// Диалог на экране — значит, его последний ответ видели: в панелях других диалогов он не «ждёт ответа»
async function markSelfSeenIfShown($: Dollar, isShown?: boolean): Promise<void> {
  if (!selfId) return
  const now = await $.clock.now()
  if (now - selfSeenAt < SEEN_SELF_EVERY) return
  if (!(isShown ?? (await checkShown($)))) return
  selfSeenAt = now
  await markSeen($, { [selfId]: now })
}

async function refresh($: Dollar, isManual = false): Promise<boolean> {
  await loadSelf($)
  try {
    const response = await callCcd($, SERVER, 'list_sessions', { limit: 40 })
    const list: RawSession[] = Array.isArray(response) ? response : Array.isArray(response?.sessions) ? response.sessions : []
    const now = await $.clock.now()
    raw = list.filter(s => !s.isArchived && s.sessionId !== selfId)

    for (const s of raw) {
      const id = s.sessionId
      const at = activityOf(s)
      const p = prev.get(id)
      if (s.isRunning) {
        sawStop.delete(id)
        bgUntil.delete(id)
      } else if (p?.isRunning) {
        sawStop.add(id)
      } else if (p && at > p.at) {
        // Ход давно кончился, а активность растёт: это фоновые субагенты, а не ответ человеку
        bgUntil.set(id, now + BG_HOLD)
        sawStop.delete(id)
      }
      prev.set(id, { isRunning: Boolean(s.isRunning), at })
    }

    failures = 0
    await classify($)

    const json = JSON.stringify(raw)
    if (json !== cachedJson) {
      cachedJson = json
      const cur = await read($, view)
      await $.store.set(K_CACHE, { sessions: cur.sessions, updatedAt: now })
    }
    return true
  } catch (err) {
    failures++
    if (isManual || failures > SILENT_FAILURES) {
      const cur = await read($, view)
      await setView($, { ...cur, isStale: cur.hasData, error: 'Список временно недоступен. Показан последний снимок.' })
    }
    return false
  }
}

function schedule($: Dollar, ms: number): void {
  timer?.cancel()
  timer = $.clock.after(ms, () => void tick($))
}

async function tick($: Dollar): Promise<void> {
  timer = null
  if (!paneUp) return
  const ok = await refresh($)
  if (!paneUp) return
  const isShown = await checkShown($)
  void markSelfSeenIfShown($, isShown)

  const v = await read($, view)
  const isBusy = (await read($, self)).isRunning || v.sessions.some(s => s.state === 'running' || s.state === 'background')
  const next = !ok && failures <= SILENT_FAILURES ? POLL_RETRY : !isShown ? POLL_HIDDEN : isBusy ? POLL_BUSY : POLL_IDLE
  schedule($, next)
}

function startPolling($: Dollar): void {
  paneUp = true
  failures = 0
  schedule($, 1)
}

function stopPolling(): void {
  paneUp = false
  timer?.cancel()
  timer = null
}

// Короткий журнал открытий и закрытий в $.store (ключ log) — чтобы видеть, кто и почему закрыл панель
async function logEvent($: Dollar, event: string): Promise<void> {
  const list: any = await $.store.get(K_LOG)
  const entry = `${new Date(await $.clock.now()).toISOString()} ${cliId.slice(0, 8)} v${VERSION} ${event}`
  await $.store.set(K_LOG, [...(Array.isArray(list) ? list : []), entry].slice(-LOG_KEEP))
}

async function readFlag($: Dollar): Promise<PaneFlag> {
  try {
    const flag = JSON.parse(String(await $.fs.read(flagPath)))
    if (typeof flag?.isOpen === 'boolean') return { hideDone: false, at: 0, by: '', ...flag }
  } catch {
    // файла ещё нет — панель открыта по умолчанию
  }
  return { isOpen: true, hideDone: false, at: 0, by: '' }
}

async function writeFlag($: Dollar, patch: Partial<Pick<PaneFlag, 'isOpen' | 'hideDone'>>): Promise<void> {
  // Путь к файлу появляется в ensureReady; до неё писать некуда
  if (!flagPath) return
  const flag: PaneFlag = { ...(await readFlag($)), ...patch, at: await $.clock.now(), by: cliId }
  await $.fs.write(flagPath, JSON.stringify(flag))
  flagMtime = -1
}

async function showPane($: Dollar): Promise<void> {
  await $.ui.open({ id: PANE, title: 'Диалоги' })
  if (!paneUp) startPolling($)
}

async function closePaneBySync($: Dollar): Promise<void> {
  isSyncClosing = true
  try {
    await $.ui.close({ id: PANE })
  } finally {
    isSyncClosing = false
  }
}

// Привести панель этого диалога к общему переключателю
async function applyFlag($: Dollar, why: string): Promise<void> {
  const flag = await readFlag($)
  if (flag.hideDone !== (await read($, hideDone))) await update($, hideDone, () => flag.hideDone)
  const isUp = (await $.ui.panes()).some(p => p.id === PANE)
  if (flag.isOpen && !isUp) {
    await showPane($)
    void logEvent($, `open (${why})`)
  } else if (!flag.isOpen && isUp) {
    await closePaneBySync($)
    void logEvent($, `close (${why})`)
  } else if (isUp && !paneUp) {
    startPolling($)
  }
}

// Живые диалоги сверяются с файлом раз в 2 с: открыли или закрыли в одном — то же во всех.
// Усыплённые приложением диалоги сверятся, когда проснутся или когда их снова откроют
function scheduleSync($: Dollar): void {
  syncTimer?.cancel()
  syncTimer = $.clock.after(SYNC_MS, () => void syncTick($))
}

async function syncTick($: Dollar): Promise<void> {
  try {
    const stat = await $.fs.stat(flagPath).catch(() => undefined)
    const mtime = stat?.mtimeMs ?? 0
    if (mtime !== flagMtime) {
      flagMtime = mtime
      await applyFlag($, 'sync')
    }
  } finally {
    scheduleSync($)
  }
}

async function dropLegacyKeys($: Dollar): Promise<void> {
  for (const key of await $.store.keys()) {
    if (key.startsWith(LEGACY_PREFIX) || key === LEGACY_DEFAULT) await $.store.delete(key)
  }
}

// Один раз на процесс; зовётся из session.start и из любых событий, что придут раньше него
// (диалог, которому обновление плагина досталось без нового session.start)
async function ensureReady($: Dollar): Promise<void> {
  if (isReady) return
  cliId = await $.session.id()
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
  flagPath = `${home.replace(/\\/g, '/')}/${FLAG_FILE}`
  // Первый запуск мода: «ждут ответа» — то, что закончило ход за последний час
  if (typeof (await $.store.get(K_BASELINE)) !== 'number') await $.store.set(K_BASELINE, (await $.clock.now()) - HOUR)
  void dropLegacyKeys($)

  // Пока свежий список не пришёл — последний известный, с пометкой «из кэша»
  if (!(await read($, view)).hasData) {
    const cached: any = await $.store.get(K_CACHE)
    if (Array.isArray(cached?.sessions) && (cached.sessions.length === 0 || typeof cached.sessions[0]?.state === 'string')) {
      await setView($, { ...EMPTY, sessions: cached.sessions, isStale: true, hasData: true })
    }
  }
  isReady = true
}

// Подхватить общий переключатель и начать сверку; в терминале и VS Code инструментов сессий нет
async function activate($: Dollar, why: string): Promise<void> {
  await ensureReady($)
  const surfaces = await $.session.surfaces()
  if (surfaces.length > 0 && surfaces.every(s => s === 'terminal' || s === 'vscode')) {
    if ((await $.ui.panes()).some(p => p.id === PANE) && !paneUp) startPolling($)
    return
  }
  await applyFlag($, why)
  flagMtime = (await $.fs.stat(flagPath).catch(() => undefined))?.mtimeMs ?? 0
  if (!syncTimer) scheduleSync($)
}

async function openSession($: Dollar, s: HubSession): Promise<void> {
  const t0 = await $.clock.now()
  if (!s.link || !/^claude:\/\/(?:code\/continue|resume)\?session=(?:local_)?[0-9a-f-]+$/i.test(s.link)) {
    $.ui.toast('У этой сессии нет ссылки для открытия')
    return
  }
  // Сначала открыть, потом отметки: так перерисовка от отметки не мешает самому переходу
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  // Windows: системный обработчик ссылок.
  if (!isWindows) { $.ui.toast('Открытие сессии поддерживается в Windows'); return }
  const argv = ['rundll32', 'url.dll,FileProtocolHandler', s.link]
  const run = await $.process.run(argv)
  if (run.exitCode !== 0) $.ui.toast(`Не удалось открыть: ${run.stderr.trim()}`)
  // Замер: сколько занял запуск ссылки
  const t1 = await $.clock.now()
  void logEvent($, `click ${s.id.slice(6, 14)} open=${t1 - t0}ms exit=${run.exitCode}`)
  if (run.exitCode === 0 && s.state === 'waiting') await markRead($, [s.id])
}

// «Прочитано»: диалог уходит в «Завершены», пока в нём снова не появится активность
async function markRead($: Dollar, ids: string[]): Promise<void> {
  const now = await $.clock.now()
  const marks: Record<string, number> = {}
  for (const id of ids) {
    const s = raw.find(r => r.sessionId === id)
    marks[id] = Math.max(s ? activityOf(s) : 0, now)
    sawStop.delete(id)
  }
  await markSeen($, marks)
  await classify($)
}

// Что делает кнопка панели — по её имени; false — имя не наше
async function pressKey($: Dollar, key: string): Promise<boolean> {
  const v = await read($, view)
  const byId = (prefix: string) => v.sessions.find(x => `${prefix}${x.id}` === key)
  let isKnown = true
  if (key.startsWith('open-') || key.startsWith('go-')) {
    const s = byId('open-') ?? byId('go-')
    if (s) await openSession($, s)
  } else if (key.startsWith('read-')) {
    const s = byId('read-')
    if (s) await markRead($, [s.id])
  } else if (key === 'clear-waiting') {
    await markRead($, v.sessions.filter(x => x.state === 'waiting').map(x => x.id))
  } else if (key === 'toggle-hide') {
    await toggleHideDone($)
  } else if (key === 'toggle-done') {
    await update($, showAllDone, x => !x)
  } else if (key === 'refresh') {
    await refresh($, true)
  } else if (key === 'close') {
    await $.ui.close({ id: PANE })
  } else isKnown = false
  return isKnown
}

async function toggleHideDone($: Dollar): Promise<void> {
  const next = !(await read($, hideDone))
  await update($, hideDone, () => next)
  await writeFlag($, { hideDone: next })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'sessions',
      description: 'Открыть или закрыть панель диалогов во всех диалогах',
    })
    $.ui.status(undefined)
    if (!(e.surface === 'terminal' || e.surface === 'vscode')) await activate($, 'start')
    else await ensureReady($)
    if (e.surface === 'desktop') void $.clock.after(3_000, () => void loadSelf($).then(() => markSelfSeenIfShown($)).catch(() => undefined))
    return next(e)
  })

  // Приложение показывает диалог (в том числе старый, давно запущенный) — сверить панель сразу
  on('session.attach', async ($, e, next) => {
    if (e.surface !== 'vscode') void activate($, `attach-${e.surface}`).then(() => paneUp && schedule($, 1))
    return next(e)
  })

  on('command.run', { command: 'sessions' }, async ($, e) => {
    if (!(await $.session.surfaces()).includes('desktop')) return { text: 'Session Hub нужен Claude Desktop с инструментами управления сессиями. В терминале панель недоступна.' }
    await ensureReady($)
    const args = String(e.args ?? '').trim()
    if (args === 'clear' || args.startsWith('search ')) {
      await update($, query, () => args === 'clear' ? '' : args.slice(7).trim().slice(0, 120))
      await showPane($)
      return { text: args === 'clear' ? 'Фильтр сброшен.' : 'Поиск по названию и проекту: ' + args.slice(7) }
    }
    if (args === 'refresh') { await refresh($, true); return { text: 'Список обновлён либо показана причина ошибки.' } }
    const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
    if (isOpen) {
      await $.ui.close({ id: PANE })
      return { text: 'Панель диалогов закрыта во всех диалогах. Открыть снова: /sessions' }
    }
    await writeFlag($, { isOpen: true })
    await showPane($)
    if (!syncTimer) scheduleSync($)
    void logEvent($, 'open (command)')
    return { text: 'Панель диалогов открыта во всех диалогах.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      stopPolling()
      if (e.origin.kind !== 'unload' && !isSyncClosing && isReady) {
        await writeFlag($, { isOpen: false })
        void logEvent($, `close (${e.origin.kind})`)
      }
    }
    return next(e)
  })

  // Этот диалог list_sessions не возвращает: его статус — из собственных ходов (у сабагентов turn.start нет)
  on('turn.start', async ($, e, next) => {
    if (!isReady) void activate($, 'turn')
    if (!(await read($, self)).isRunning) await setSelf($, { isRunning: true, startedAt: await $.clock.now() })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (!e.agentId) {
      await setSelf($, { isRunning: false, startedAt: null })
      void markSelfSeenIfShown($)
    }
    return next(e)
  })

  // Слой клика по карточке (live.tsx) присылает { open: id }
  on('ui.message', async ($, e, next) => {
    const id = (e.data as { open?: unknown } | null)?.open
    if (e.requestId !== PANE || typeof id !== 'string') return next(e)
    const s = (await read($, view)).sessions.find(x => x.id === id)
    void logEvent($, `hit ${id.slice(6, 14)}${s ? '' : ': нет в списке'}`)
    if (s) await openSession($, s)
    return next(e)
  })

  // Кнопки панели — по имени (key), а не по адресу обработчика: каждая перерисовка выдаёт кнопкам новые
  // адреса, и нажатие по адресу из прошлой отрисовки терялось («ui_press not handled»). Имя кнопки
  // от перерисовки не меняется, поэтому нажатие разбирается здесь и до обработчика не доходит
  on('ui.press', { plugin: 'session-hub' }, async ($, e, next) => {
    if (e.requestId !== PANE || !(await pressKey($, e.element))) return next(e)
    void logEvent($, `press ${e.element.slice(0, 22)}`)
    return { element: e.element }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // Слои клика рисует приложение (десктоп и терминал); в VS Code и на телефоне их нет — там кнопки
    const Client = 'Client' in table ? table.Client : null
    type BtnOpts = { dimColor?: boolean; role?: 'dismiss' }
    const btn = (key: string, label: string, opts: BtnOpts = {}) => {
      const id = `${e.surface}|${key}`
      const sig = JSON.stringify([label, opts])
      const hit = buttons.get(id)
      if (hit && hit.sig === sig) return hit.el
      // Обработчик — запасной: нажатия разбирает хук ui.press по имени, и устаревать тут нечему
      const el = (
        <Button key={key} plain {...opts} onPress={() => void pressKey($, key)}>
          {label}
        </Button>
      )
      buttons.set(id, { sig, el })
      if (buttons.size > 800) buttons.delete(buttons.keys().next().value!)
      return el
    }
    const unfiltered = await read($, view)
    const filter = await read($, query)
    const needle = filter.toLocaleLowerCase()
    const v = { ...unfiltered, sessions: unfiltered.sessions.filter(s => !needle || (s.title + ' ' + s.project).toLocaleLowerCase().includes(needle)) }
    const me: HubSelf = await read($, self)
    const showAll = await read($, showAllDone)
    const isHidden = await read($, hideDone)

    // Работающие — по времени старта: время активности у них меняется каждую секунду, и сортировка по нему
    // переставляла строки туда-обратно
    const running = v.sessions
      .filter(s => s.state === 'running' || s.state === 'background')
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id))
    const pending = v.sessions.filter(s => s.state === 'waiting')
    const done = v.sessions.filter(s => s.state === 'done')
    const doneShown = showAll ? done : done.slice(0, DONE_PREVIEW)
    const runningCount = running.length + (me.isRunning ? 1 : 0)

    const INSET = 1
    const isDesktop = e.surface === 'desktop'
    // Ширина текста внутри карточки: отступ панели, рамка и поля карточки с обеих сторон
    const inner = Math.max(12, (e.props.bodyColumns || 40) - INSET * 4 - 2)
    // Кнопка не умеет обрезать подпись сама — режем заранее, иначе длинное название вылезает за карточку
    // Ширина «✓ прочитано» с отступом: слой клика туда не заходит, чтобы кнопка нажималась сама
    const READ_ROOM = 13
    const fit = (text: string, room: number) => (text.length <= room ? text : `${text.slice(0, Math.max(1, room - 1))}…`)

    // Тон раздела: карточки слегка подкрашены его цветом, бейдж числа — тем же цветом погуще.
    // Полупрозрачные заливки ложатся и на светлую, и на тёмную тему
    type Tone = { card: string; hover: string; badge: string; ink: string; dot: string | null }
    const TONE: Record<'live' | 'waiting' | 'done', Tone> = {
      live: { card: '#22c55e14', hover: '#22c55e29', badge: '#22c55e26', ink: '#15803d', dot: '#22c55e' },
      waiting: { card: '#eab3081f', hover: '#eab30838', badge: '#eab30833', ink: '#a16207', dot: '#eab308' },
      done: { card: '#8080800d', hover: '#8080801f', badge: '#8080801f', ink: '#71717a', dot: null },
    }
    const toneOf = (state: HubSession['state']): Tone =>
      state === 'waiting' ? TONE.waiting : state === 'done' ? TONE.done : TONE.live

    // Карточка: скругление даёт рамка round того же цвета, что и фон, — её не видно, а углы круглые.
    // В терминале фон не нужен: только подсветка при наведении
    const cardFrame = (tone: Tone, isInteractive: boolean) =>
      isDesktop
        ? {
            backgroundColor: tone.card,
            borderStyle: 'round',
            borderColor: tone.card,
            ...(isInteractive ? { hover: { backgroundColor: tone.hover, borderColor: tone.hover } } : {}),
          }
        : isInteractive
          ? { hover: { backgroundColor: '#3a3a3a' } }
          : {}

    const dotOf = (tone: Tone) => (tone.dot ? <Text color={tone.dot}>● </Text> : null)

    //  ╭────────────────────────────────────╮
    //  │ Анализ структуры платформы         │
    //  │ ● platform-ai · субагенты   12 мин │
    //  ╰────────────────────────────────────╯
    const row = (s: HubSession) => {
      const tone = toneOf(s.state)
      const isLive = s.state === 'running' || s.state === 'background'
      const sub = [s.project, s.state === 'background' ? 'фоновая активность' : '', s.state === 'waiting' ? s.when : '']
        .filter(Boolean)
        .join(' · ')
      return (
        <Box
          key={`row-${s.id}`}
          flexDirection="column"
          paddingX={INSET}
          marginX={INSET}
          marginBottom={1}
          overflow="hidden"
          {...cardFrame(tone, true)}
        >
          {/* Название и строка проекта — обычные кнопки: клик по ним открывает диалог */}
          {Client ? (
            <Text wrap="truncate-end" bold={s.state === 'waiting'}>
              {s.title}
            </Text>
          ) : (
            btn(`open-${s.id}`, fit(s.title, inner))
          )}
          <Box flexDirection="row">
            {dotOf(tone)}
            {/* minWidth 0: без него гибкий блок не сжимается уже своего текста и выталкивает время за край */}
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text dimColor wrap="truncate-end">
                {sub}
              </Text>
            </Box>
            {isLive && (
              <Box flexShrink={0} marginLeft={1}>
                <Text color={tone.ink}>{s.when}</Text>
              </Box>
            )}
            {s.state === 'done' && (
              <Box flexShrink={0} marginLeft={1}>
                <Text dimColor>{s.when}</Text>
              </Box>
            )}
            {s.state === 'waiting' && (
              <Box flexShrink={0} marginLeft={1}>
                {btn(`read-${s.id}`, '✓ прочитано', { dimColor: true })}
              </Box>
            )}
          </Box>
          {Client && (
            // Прозрачный слой поверх обеих строк карточки: клик по ней открывает диалог. У ждущего диалога
            // справа своя кнопка «✓ прочитано» — слой туда не заходит. Фокус панели слою не запрещать:
            // без него приложение не передаёт слою нажатие. Обёртка без key: Box с ключом — своя зона
            // наведения, и карточка под слоем не подсвечивалась бы
            <Box position="absolute" top={0} left={0} right={s.state === 'waiting' ? READ_ROOM : 0} height={2}>
              <Client key={`hit-${s.id}`} module="./live.tsx" width="100%" height={2} props={{ part: 'hit', id: s.id }} />
            </Box>
          )}
        </Box>
      )
    }

    const selfRow = (
      <Box key="row-self" flexDirection="column" paddingX={INSET} marginX={INSET} marginBottom={1} {...cardFrame(TONE.live, false)}>
        <Text wrap="truncate-end">{me.title}</Text>
        <Box flexDirection="row">
          {dotOf(TONE.live)}
          <Text dimColor wrap="truncate-end">
            этот диалог
          </Text>
        </Box>
      </Box>
    )

    // Заголовок раздела: название, число в бейдже цвета раздела, тихое действие справа
    const header = (key: string, title: string, count: number, tone: Tone, action?: RenderChildren) => (
      <Box key={`head-${key}`} flexDirection="row" justifyContent="space-between" paddingX={INSET * 2} marginBottom={1}>
        <Text wrap="truncate-end">
          <Text bold>{title} </Text>
          {isDesktop ? (
            <Text backgroundColor={tone.badge} color={tone.ink} bold>
              {` ${count} `}
            </Text>
          ) : (
            <Text dimColor>{count}</Text>
          )}
        </Text>
        {action}
      </Box>
    )

    const empty = (text: string) => (
      <Box paddingX={INSET * 2} marginBottom={1}>
        <Text dimColor>{text}</Text>
      </Box>
    )

    const note = !v.hasData ? 'загружаю…' : v.isStale ? 'обновляю…' : null

    return (
      <Box flexDirection="column">
        {filter && <Text dimColor>Поиск: {filter} · сбросить /sessions clear</Text>}
        {v.error && (
          <Box paddingX={INSET * 2} marginBottom={1}>
            <Text color="red" wrap="truncate-end">
              Не удалось получить список: {v.error}
            </Text>
          </Box>
        )}

        {header('running', 'В работе', runningCount, TONE.live)}
        {runningCount === 0 && empty('ничего не выполняется')}
        {me.isRunning && selfRow}
        {running.map(row)}

        {header(
          'waiting',
          'Ждут ответа',
          pending.length,
          TONE.waiting,
          pending.length > 1 ? (
            btn('clear-waiting', 'все прочитаны', { dimColor: true })
          ) : undefined,
        )}
        {pending.length === 0 && empty('никто не ждёт')}
        {pending.map(row)}

        {header(
          'done',
          'Завершены',
          done.length,
          TONE.done,
          done.length > 0 ? (
            btn('toggle-hide', isHidden ? 'показать' : 'скрыть', { dimColor: true })
          ) : undefined,
        )}
        {!isHidden && doneShown.map(row)}
        {!isHidden && done.length > DONE_PREVIEW && (
          <Box paddingX={INSET * 2} marginBottom={1}>
            {btn('toggle-done', showAll ? 'свернуть' : `ещё ${done.length - DONE_PREVIEW}`, { dimColor: true })}
          </Box>
        )}

        <Box flexDirection="row" justifyContent="space-between" paddingX={INSET * 2}>
          <Box flexDirection="row" gap={2}>
            {btn('refresh', 'обновить', { dimColor: true })}
            {note && <Text dimColor>{note}</Text>}
          </Box>
          <Box flexDirection="row" gap={2}>
            <Text dimColor>v{VERSION}</Text>
            {btn('close', 'закрыть', { dimColor: true, role: 'dismiss' })}
          </Box>
        </Box>
      </Box>
    )
  })
}
