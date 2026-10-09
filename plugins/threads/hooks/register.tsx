import { atom, read as readAtom, update as updateAtom } from 'claude-code'
import type { Register } from 'claude-code'

import type { Thread } from '../types'
import { reportMatches, validSessionId } from './helpers'

// Потоки: главный диалог запускает отдельные сессии Claude Code на выбранных моделях, у каждой свой контекст.
// В приложении Claude поток — обычный чат: заготовка сессии в CLI (задача и порядок отчёта видны первым
// сообщением, работа не начата) → импорт в приложение → сигнал «Начинай» в этот чат; работа идёт в чате
// вживую, итог поток присылает сообщением в главный чат. В терминале — фоновая сессия claude -p, сводка —
// когда все закончат.
const list = atom({ plugin: 'threads', key: 'list' } as const, [])

const PANE = 'threads'
const VERSION = '1.5.0'
let maxThreads = 3
const LOG_LINES = 40 // столько последних шагов фонового потока держим в состоянии
const MARK = '[threads]' // первая строка итога, по которой главный чат узнаёт поток
// Только модели с auto-режимом: Haiku его не поддерживает, и поток на нём молча работал бы в Manual
const MODELS = ['sonnet', 'opus']
const RESULT_IN_STATE = 4000 // столько символов результата держим в состоянии и отдаём в сводку
const SYSTEM = 'Ты — поток, запущенный главным диалогом. Сделай задачу целиком и закончи коротким итогом: что сделано, где лежит результат, что осталось. Если не хватает существенных данных, сообщи об этом в результате; не выдумывай требования. Новые потоки сам не запускай.'
const GO = 'Начинай.'

// В фоне недоступно подтверждение прав: неподтверждённые действия не выполняются.
const MODE = 'dontAsk' // Фоновые потоки не повышают права без участия пользователя.
// Заготовка — холодный старт CLI со всеми MCP и ход модели; $.process.run по умолчанию ждёт всего 30 с
const SEED_TIMEOUT_MS = 180_000
const IMPORT_WAIT_SEC = 60 // столько ждём, пока приложение импортирует сессию потока
const SEND_TRIES = 30 // попыток доставить «Начинай», раз в секунду: чат после импорта поднимается не сразу

// Список живёт в $.state процесса чата, а процесс приложение перезапускает: усыпляет простаивающий чат,
// поднимает заново после обновления плагина. Копия — в $.store под постоянным адресом чата (local_<id>), иначе
// итог потока, пришедший в проснувшийся чат, не нашёл бы своего потока, а вкладка «Потоки» осталась бы пустой
const STORE_LIST = 'list:'
const STORE_PANE_CLOSED = 'paneClosed:'
const STORE_DAYS = 14
let chatKey = ''
let isLoaded = false

async function keyOf($: any): Promise<string> {
  if (!chatKey) chatKey = (await $.env.get('CLAUDE_CODE_HOST_SESSION_ID'))?.trim() || (await $.session.id())
  return chatKey
}

async function ensureLoaded($: any) {
  if (isLoaded) return
  if ((await readAtom($, list)).length > 0) { isLoaded = true; return }
  const saved: any = await $.store.get(STORE_LIST + (await keyOf($))).catch(() => undefined)
  if (Array.isArray(saved?.list) && saved.list.length > 0) await updateAtom($, list, () => saved.list.filter((t: any) => validSessionId(t.sessionId)))
  isLoaded = true
}

// Атом у модуля один, поэтому обёртки берут его сами: второй аргумент — только ради прежних вызовов
async function read($: any, _: typeof list): Promise<Thread[]> {
  await ensureLoaded($)
  return readAtom($, list)
}

async function update($: any, _: typeof list, fn: (all: Thread[]) => Thread[]) {
  await ensureLoaded($)
  await updateAtom($, list, fn)
  await $.store.set(STORE_LIST + (await keyOf($)), { at: Date.now(), list: await readAtom($, list) }).catch(() => undefined)
}

// Старые копии списков чатов — прочь, чтобы $.store не рос бесконечно
async function pruneStore($: any) {
  const edge = Date.now() - STORE_DAYS * 24 * 3600_000
  for (const key of await $.store.keys().catch(() => [])) {
    if (!key.startsWith(STORE_LIST)) continue
    const saved: any = await $.store.get(key).catch(() => undefined)
    if (!(saved?.at > edge)) {
      await $.store.delete(key).catch(() => undefined)
      await $.store.delete(STORE_PANE_CLOSED + key.slice(STORE_LIST.length)).catch(() => undefined)
    }
  }
}

async function openPane($: any) {
  await $.store.delete(STORE_PANE_CLOSED + (await keyOf($))).catch(() => undefined)
  await $.ui.open({ id: PANE, title: 'Потоки' })
}

// Новый процесс чата не знает о вкладке, которую приложение сохранило от прежнего, и не рисует в неё
// («has not drawn in this pane»): занимаем её снова, если она была открыта, а человек её не закрывал
async function reclaimPane($: any) {
  if (await $.store.get(STORE_PANE_CLOSED + (await keyOf($))).catch(() => undefined)) return
  const isUp = (await $.ui.panes().catch(() => [])).some((p: any) => p.id === PANE)
  if (isUp || (await read($, list)).length > 0) await $.ui.open({ id: PANE, title: 'Потоки' })
}

const running = new Map<string, { stop?: () => void }>()
let bin = ''
let entry = ''
let mainChat = '' // постоянный адрес главного чата в приложении, local_<id>: номер сессии меняется, он — нет
// Чаты потоков создаются параллельно; по одному — только открытие чата: две ссылки claude:// разом и
// переключения окна мешают друг другу, а сам шаг занимает пару секунд
let openLock: Promise<unknown> = Promise.resolve()
// Запуски чатов в полёте: окно возвращаем в главный чат, только когда закончился последний, — возврат может
// перезапустить главный чат и унести ответ ещё не закончившегося вызова start
let launching = 0
let isReturnWanted = false
let isBatchFailed = false

function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const job = openLock.then(fn)
  openLock = job.catch(() => undefined)
  return job
}

async function claudeBin($: any): Promise<string> {
  if (!bin) bin = (await $.env.get('CLAUDE_CODE_EXECPATH'))?.trim() || 'claude'
  return bin
}

async function entrypoint($: any): Promise<string> {
  if (!entry) entry = (await $.env.get('CLAUDE_CODE_ENTRYPOINT'))?.trim() || 'cli'
  return entry
}

function uuid(): string { return crypto.randomUUID() }

function isActive(t: Thread): boolean {
  return t.status === 'создаётся' || t.status === 'ждёт' || t.status === 'работает'
}

// Шаг запуска чата-потока: не перетирает «остановлен», если человек остановил поток, пока тот создавался
async function advance($: any, name: string, fn: (t: Thread) => Thread): Promise<boolean> {
  let isStopped = false
  await patch($, name, x => {
    isStopped = x.status === 'остановлен'
    return isStopped ? x : fn(x)
  })
  return !isStopped
}

// Останавливает поток по номеру его сессии — работает и после перезагрузки мода, когда связи в памяти уже нет
async function stopThread($: any, name: string): Promise<boolean> {
  const t = (await read($, list)).find((x: Thread) => x.name === name)
  if (!t || !isActive(t)) return false
  const stopped = await stopOwnedSession($, t.sessionId).catch(() => false)
  if (!stopped) { $.ui.toast('Остановка не подтверждена. Открой сессию и останови её вручную.'); return false }
  await patch($, name, x => isActive(x) ? { ...x, status: 'остановлен', step: 'остановлен', endedAt: Date.now() } : x)
  return true
}

// После перезагрузки мода: «работает» только то, чей процесс жив. Выгрузка модуля убивает фоновые потоки
// (их процессы — дети цикла $.process.run), так что после неё здесь они честно станут «остановлен»
async function reconcile($: any) {
  for (const t of (await read($, list)) as Thread[]) {
    if (t.kind === 'chat' || !(t.status === 'работает' || t.status === 'создаётся') || running.has(t.name)) continue
    const check = "if (Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(claude|node)(\\.exe)?$' -and $_.CommandLine -match '--(resume|session-id)(=|\\s+)" + t.sessionId + "(\\s|$)' }) { exit 0 } else { exit 3 }"
    const alive = (await $.process.run(['powershell','-NoProfile','-NonInteractive','-Command',check]).catch(() => ({exitCode:-1}))).exitCode
    if (alive === -1) continue
    if (alive !== 0) await patch($, t.name, x => ({ ...x, status: 'остановлен', step: 'остановлен', endedAt: x.endedAt || Date.now() }))
  }
}

async function patch($: any, name: string, fn: (t: Thread) => Thread) {
  await update($, list, (all: Thread[]) => all.map(t => (t.name === name ? fn(t) : t)))
}

function stepOf(ev: any): string {
  if (ev.type !== 'assistant') return ''
  for (const c of ev.message?.content ?? []) {
    if (c.type === 'tool_use') {
      const arg = c.input?.file_path ?? c.input?.command ?? c.input?.pattern ?? c.input?.url ?? ''
      return `${c.name} ${String(arg).slice(0, 60)}`.trim()
    }
    if (c.type === 'text' && c.text) return c.text.replace(/\s+/g, ' ').slice(0, 80)
  }
  return ''
}

// Задача идёт в stdin, а не в argv: текст, начинающийся с «-» (список в markdown), CLI принял бы за флаг
async function runThread($: any, name: string, argv: string[], input: string) {
  const thread = (await read($, list)).find(t => t.name === name)
  if (!thread || thread.status === 'остановлен') return
  running.set(name, { stop: () => undefined })
  let buf = ''
  let done = false
  // Одна строка stream-json: шаг, номер сессии, итог
  const handle = async (line: string) => {
    let ev: any
    try { ev = JSON.parse(line) } catch { return }
    if (ev.type === 'system' && ev.subtype === 'init') {
      // Процесс поднялся — поток из «создаётся» переходит в работу
      await patch($, name, t => ({ ...t, sessionId: ev.session_id ?? t.sessionId, status: t.status === 'создаётся' ? 'работает' : t.status }))
    }
    const step = stepOf(ev)
    if (step) await patch($, name, t => ({
      ...t,
      step,
      actions: t.actions + (ev.message?.content ?? []).filter((c: any) => c.type === 'tool_use').length,
      log: [...(t.log ?? []), step].slice(-LOG_LINES),
    }))
    if (ev.type === 'result') {
      done = true
      if ((await read($, list)).find(t => t.name === name)?.status === 'остановлен') return
      await patch($, name, t => ({
        ...t,
        status: ev.is_error ? 'ошибка' : 'готов',
        step: ev.is_error ? String(ev.result ?? ev.subtype).slice(0, 80) : 'готово',
        costUsd: t.costUsd + (ev.total_cost_usd ?? 0),
        endedAt: Date.now(),
        sessionId: ev.session_id ?? t.sessionId,
        result: String(ev.result ?? '').slice(0, RESULT_IN_STATE),
        reported: false,
      }))
    }
  }
  try {
    // Официальный API возвращает вывод целиком и ограничивает запуск десятью минутами.
    const result = await $.process.run(argv, { stdin: input, cwd: thread.cwd, timeoutMs: 600000 })
    for (const line of result.stdout.split('\n')) if (line.trim()) await handle(line)
    if (!done && result.exitCode !== 0) {
      await patch($, name, t => t.status === 'остановлен' ? t : ({
        ...t, status: 'ошибка', step: 'CLI завершился с кодом ' + result.exitCode, endedAt: Date.now(),
      }))
      done = true
    }
  } catch {
    await patch($, name, t => t.status === 'остановлен' ? t : ({
      ...t, status: 'ошибка', step: 'Запуск прерван или достиг лимита 10 минут. Продолжи по ID сессии.', endedAt: Date.now(),
    }))
    done = true
  }
  running.delete(name)
  if (!done) await patch($, name, t => (t.status === 'работает' || t.status === 'создаётся' ? { ...t, status: 'остановлен', endedAt: Date.now() } : t))
  await report($)
}

// $.process.run для паузы: вызов $ в полёте не тратит бюджет хука, в отличие от $.clock.sleep
function sleep($: any, sec: number) {
  return (async () => {
    const windows = await $.env.get('OS') === 'Windows_NT'
    return $.process.run(['powershell','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds ' + Math.max(0, Math.floor(sec))])
  })().catch(() => undefined)
}

async function appDirs($: any): Promise<string[]> {
  const windows = await $.env.get('OS') === 'Windows_NT'
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  const base = (await $.env.get('APPDATA') ?? home + '/AppData/Roaming') + '/Claude/claude-code-sessions'
  const out: string[] = []
  for (const acct of await $.fs.list(base).catch(() => [])) {
    if (acct.kind !== 'dir') continue
    for (const org of await $.fs.list(`${base}/${acct.name}`).catch(() => [])) {
      if (org.kind === 'dir') out.push(`${base}/${acct.name}/${org.name}`)
    }
  }
  return out
}

// Запись приложения о чате local_<id>, или null, пока приложение его не знает
async function appRecord($: any, id: string): Promise<any> {
  for (const dir of await appDirs($)) {
    try { return JSON.parse(await $.fs.read(`${dir}/${id}.json`)) } catch {}
  }
  return null
}

// Адрес главного чата: приложение передаёт его процессу сессии; иначе — запись о чате с нашим номером CLI-сессии
async function mainChatId($: any): Promise<string> {
  if (mainChat) return mainChat
  const host = (await $.env.get('CLAUDE_CODE_HOST_SESSION_ID'))?.trim()
  if (host?.startsWith('local_')) return (mainChat = host)
  const me = await $.session.id()
  for (const dir of await appDirs($)) {
    const files = (await $.fs.list(dir).catch(() => []))
      .filter((f: any) => f.name.startsWith('local_') && f.name.endsWith('.json'))
      .sort((a: any, b: any) => b.mtimeMs - a.mtimeMs)
      .slice(0, 40)
    for (const f of files) {
      try {
        const j = JSON.parse(await $.fs.read(`${dir}/${f.name}`))
        if (j.cliSessionId === me) return (mainChat = j.sessionId)
      } catch {}
    }
  }
  return ''
}

// Режим потока-чата = режим главного чата: приложение придерживает сообщения между сессиями с разными режимами
// до ручного подтверждения, и ни «Начинай», ни итог без клика не проходили. Свой режим не повышаем: из
// bypassPermissions и plan главного — auto. «default» приложения у CLI называется manual
async function chatMode($: any, main: string): Promise<string> {
  const m = main ? (await appRecord($, main))?.permissionMode : undefined
  if (m === 'manual') return 'default'
  return ['default', 'acceptEdits', 'auto', 'dontAsk', 'plan'].includes(m) ? m : MODE
}

// Мод не может отправить сообщение в auto-режиме: классификатор не выносит вердикт по отправке, о которой
// пользователь не просил, — её должен сделать сам главный диалог (или человек кнопкой в панели)
function isClassifierRefusal(reason: string): boolean {
  return /classifier/i.test(reason)
}

function handoff(name: string, sid: string, why: string): string {
  return `Чат потока «${name}» создан, но сигнал старта мод доставить не смог (${why.slice(0, 120)}). ` +
    `Чтобы поток начал работу, вызови SendMessage: to = local_${sid}, message = «${GO}». ` +
    'Если не выйдет — пользователь может нажать «Запустить» в панели /threads.'
}

// Поток-чат: заготовка → импорт → «Начинай». Заготовка — один ход модели: задача и порядок отчёта видны в чате
// первым сообщением пользователя (так и классификатор потока видит отправку итога как просьбу пользователя),
// режим чат берёт из неё. Возвращает ответ инструмента start
async function startChat($: any, t: Thread, task: string): Promise<string> {
  launching++
  try {
    return await launchChat($, t, task)
  } finally {
    launching--
    if (launching === 0) {
      const main = isReturnWanted && !isBatchFailed ? await mainChatId($) : ''
      isReturnWanted = false
      isBatchFailed = false
      if (main) await openClaude($, `claude://code/continue?session=${main}`).catch(() => undefined)
    }
  }
}

async function launchChat($: any, t: Thread, task: string): Promise<string> {
  const main = await mainChatId($)
  const mode = t.readOnly ? 'plan' : await chatMode($, main)
  if (!(await advance($, t.name, x => ({ ...x, mode, step: 'заготовка сессии…' })))) return `Поток «${t.name}» остановлен.`
  const back = main ? `на адрес ${main}` : 'на адрес, с которого придёт сообщение «Начинай»'
  const seed = `Ты — поток «${t.name}», тебя запустил главный диалог.\n\nЗадача:\n${task}\n\n` +
    `Порядок работы:\n1. Сейчас ничего не делай и ответь одним словом: жду. Работу начинай, когда сюда придёт сообщение «${GO}».\n` +
    `2. Когда закончишь, отправь итог сообщением (SendMessage) ${back}: первая строка — «${MARK} ${t.name}: готов» ` +
    `(или «${MARK} ${t.name}: ошибка», если сделать не вышло), дальше коротко — что сделано, где результат, что осталось.\n` +
    'Токен отчёта: [report:' + t.reportToken + ']. Обязательно добавь его в итоговое сообщение.\n' +
    '3. Если не хватает существенных данных, сообщи об этом в результате; не выдумывай требования. Новые потоки сам не запускай.'
  const argv = [await claudeBin($), '-p', '--session-id', t.sessionId, '--model', t.model, '--max-turns', '1',
    '--permission-mode', mode, '--output-format', 'json']
  if (t.effort) argv.push('--effort', t.effort)
  const r = await $.process.run(argv, { stdin: seed, cwd: t.cwd, timeoutMs: SEED_TIMEOUT_MS })
    .catch((err: any) => ({ exitCode: 1, stdout: '', stderr: String(err?.message ?? err) }))
  // Ненулевой код при записанной сессии (модель потянулась к инструменту и упёрлась в --max-turns) — не беда
  if (r.exitCode !== 0 && !String(r.stdout ?? '').includes(t.sessionId)) {
    const why = String(r.stderr || r.stdout || '').trim().slice(0, 80)
    if (!(await advance($, t.name, x => ({ ...x, status: 'ошибка', step: `заготовка: ${why}`, endedAt: Date.now() })))) return `Поток «${t.name}» остановлен.`
    return `Поток «${t.name}» не запустился: заготовка сессии упала (${why}).`
  }

  // Импорт открывает чат потока и поднимает его сессию; ждём, пока приложение заведёт о нём запись
  if (!(await advance($, t.name, x => ({ ...x, step: 'открываю чат…' })))) return `Поток «${t.name}» остановлен.`
  const isImported = await exclusive(async () => {
    await openClaude($, `claude://resume?session=${t.sessionId}`).catch(() => undefined)
    for (let i = 0; i < IMPORT_WAIT_SEC; i++) {
      if ((await appRecord($, `local_${t.sessionId}`)) !== null) return true
      await sleep($, 1)
    }
    return false
  })
  if (!isImported) {
    isBatchFailed = true
    await advance($, t.name, x => ({ ...x, status: 'ждёт', step: 'приложение не открыло чат' }))
    return `Сессия потока «${t.name}» готова, но приложение за ${IMPORT_WAIT_SEC} с не открыло её чат. ${handoff(t.name, t.sessionId, 'чат не открылся')}`
  }

  // Чат есть — дальше поток ждёт сигнала «Начинай»
  if (!(await advance($, t.name, x => ({ ...x, status: 'ждёт', step: 'отправляю «Начинай»…' })))) return `Поток «${t.name}» остановлен.`
  let why = ''
  for (let i = 0; i < SEND_TRIES; i++) {
    const sent = await $.session.send({ to: `local_${t.sessionId}`, text: GO })
      .catch((err: any) => ({ isDelivered: false, reason: String(err?.message ?? err) }))
    if (sent.isDelivered) {
      if (!(await advance($, t.name, x => ({ ...x, status: 'работает', step: 'работает в чате' })))) return `Поток «${t.name}» остановлен.`
      // Окно — обратно в главный чат, когда запустятся все (см. startChat)
      isReturnWanted = true
      return `Поток «${t.name}» запущен на ${t.model} отдельным чатом приложения (режим ${mode}): работа видна в нём вживую, итог поток пришлёт сюда сообщением.`
    }
    why = String(sent.reason ?? '')
    // Отказ классификатора не случаен — повторять его незачем (одна повторная попытка, как он сам просит)
    if (isClassifierRefusal(why) && i >= 1) break
    await sleep($, 1)
  }
  // Окно не возвращаем: перезапуск главного чата унёс бы этот ответ, а с ним и просьбу отправить сигнал
  isBatchFailed = true
  await advance($, t.name, x => ({ ...x, step: 'ждёт «Начинай»' }))
  return handoff(t.name, t.sessionId, why || 'чат не ответил')
}

// Сводка фоновых потоков в главный диалог, когда ни один фоновый не работает. Потоки-чаты в ней не участвуют:
// они присылают итог сами, а их «работает» не должно держать сводку остальных
async function report($: any) {
  let fresh: Thread[] = []
  // Отбор и отметка — одной записью: два потока, закончившие разом, иначе прислали бы сводку дважды
  await update($, list, (all: Thread[]) => {
    fresh = []
    if (all.some(t => t.kind !== 'chat' && isActive(t))) return all
    fresh = all.filter(t => t.kind !== 'chat' && t.endedAt > 0 && !t.reported && !isActive(t))
    if (fresh.length === 0) return all
    return all.map(t => (fresh.some(f => f.name === t.name) ? { ...t, reported: true } : t))
  })
  if (fresh.length === 0) return
  const body = fresh
    .map(t => `### ${t.name} (${t.model}, ${t.status})\n${t.result || t.step}`)
    .join('\n\n')
  try {
    await $.prompt.submit({ text: `${MARK} Потоки закончили. Собери из их результатов один общий ответ.\n\n${body}` })
  } catch {
    // Сводка не ушла — снимаем отметку, иначе результаты пропали бы молча
    await update($, list, (all: Thread[]) => all.map(t => (fresh.some(f => f.name === t.name) ? { ...t, reported: false } : t)))
  }
}

async function start($: any, input: any): Promise<string> {
  const all: Thread[] = await read($, list)
  let name = String(input.name ?? '').trim()
  for (let n = all.length + 1; !name || (!input.name && all.some(x => x.name === name)); n++) name = `поток-${n}`
  if (name.length > 64 || /[\x00-\x1f\x7f]/.test(name)) return 'Имя: до 64 символов, без переносов строк.'
  const model = MODELS.includes(input.model) ? input.model : 'sonnet' // haiku и неизвестное — sonnet
  const task = String(input.task ?? '').trim()
  if (!task) return 'Нужна задача: поле task.'
  if (running.has(name) || all.some(x => x.name === name && isActive(x))) return `Поток «${name}» уже работает.`
  const sid = uuid()
  const cwd = input.cwd ? String(input.cwd).trim() : await $.session.cwd()
  try { await $.fs.list(cwd) } catch { return 'Рабочая папка не существует или недоступна.' }
  const kind = (await entrypoint($)) === 'claude-desktop' ? 'chat' : 'cli'
  const effort = input.effort ? String(input.effort) : undefined
  const readOnly = input.readOnly !== false
  const t: Thread = {
    name, model, status: 'создаётся', step: 'запуск…', actions: 0, cwd, costUsd: 0, startedAt: Date.now(), endedAt: 0,
    sessionId: sid, reportToken: crypto.randomUUID(), result: '', log: [], kind, effort, readOnly, mode: readOnly ? 'plan' : MODE,
  }
  let refused = ''
  await update($, list, (xs: Thread[]) => {
    if (xs.filter(isActive).length >= maxThreads) { refused = 'Достигнут лимит потоков: ' + maxThreads + '. /threads cap 1–8.'; return xs }
    if (xs.some(x => x.name === name && isActive(x))) { refused = 'Поток с таким именем уже работает.'; return xs }
    if (!readOnly && xs.some(x => !x.readOnly && isActive(x) && x.cwd.replace(/\\/g, '/').toLowerCase() === cwd.replace(/\\/g, '/').toLowerCase())) {
      refused = 'В этой папке уже работает поток с записью. Укажи отдельную рабочую копию в cwd.'; return xs
    }
    return [...xs.filter(x => x.name !== name), t]
  })
  if (refused) return refused
  void openPane($).catch(() => undefined)
  if (kind === 'chat') {
    // Ждём создания чата прямо в вызове: так при отказе классификатора модель сразу получает, что отправить.
    // Несколько вызовов start идут параллельно — их чаты создаются одновременно
    return startChat($, t, task).catch(async (err: any) => {
      const why = String(err?.message ?? err).slice(0, 80)
      await patch($, name, x => ({ ...x, status: 'ошибка', step: why, endedAt: Date.now() }))
      return `Поток «${name}» не запустился: ${why}`
    })
  }
  const argv = [await claudeBin($), '-p', '--session-id', sid, '--model', model, '--output-format', 'stream-json', '--verbose',
    '--permission-mode', t.mode!, '--append-system-prompt', SYSTEM]
  if (effort) argv.push('--effort', effort)
  void runThread($, name, argv, task).catch(() => undefined)
  return `Поток «${name}» запущен на ${model}. Когда все потоки закончат, сводка придёт сама; статус — инструмент status.`
}

async function resume($: any, input: any): Promise<string> {
  const name = String(input.name ?? '')
  const text = String(input.text ?? '').trim()
  const t = (await read($, list)).find((x: Thread) => x.name === name)
  if (!t) return `Потока «${name}» нет.`
  if (!text) return 'Нужен текст сообщения: поле text.'
  if ((await read($, list)).filter(isActive).length >= maxThreads && !isActive(t)) return 'Достигнут лимит параллельных потоков.'
  if (!t.readOnly && (await read($, list)).some(x => x.name !== name && isActive(x) && !x.readOnly && x.cwd === t.cwd)) return 'В этой папке уже есть другой поток с записью.'
  if (!t.sessionId) return `У потока «${name}» нет сессии для продолжения.`
  if (t.kind === 'chat') {
    // Чату писать можно и пока он работает: сообщение встанет в очередь его хода
    const sent = await $.session.send({ to: `local_${t.sessionId}`, text })
      .catch((err: any) => ({ isDelivered: false, reason: String(err?.message ?? err) }))
    if (!sent.isDelivered) {
      if (isClassifierRefusal(String(sent.reason))) return `Мод не может отправить это сам в auto-режиме. Вызови SendMessage: to = local_${t.sessionId}, message = текст для потока.`
      return `Чат потока «${name}» не принял сообщение: ${sent.reason}`
    }
    await patch($, name, x => ({ ...x, status: 'работает', step: 'работает в чате', endedAt: 0 }))
    return `Сообщение ушло в чат потока «${name}»; итог он пришлёт сюда.`
  }
  if (isActive(t)) return `Поток «${name}» ещё работает — продолжить можно после завершения.`
  // Те же режим и effort, что при запуске: иначе поток «только чтение» после send стал бы менять файлы
  const argv = [await claudeBin($), '-p', '--resume', t.sessionId, '--model', t.model,
    '--output-format', 'stream-json', '--verbose', '--permission-mode', t.mode ?? (t.readOnly ? 'plan' : MODE)]
  if (t.effort) argv.push('--effort', t.effort)
  await patch($, name, x => ({ ...x, status: 'работает', step: 'продолжает…', endedAt: 0, result: '', reported: false }))
  void runThread($, name, argv, text).catch(() => undefined)
  return `Поток «${name}» продолжает с новым сообщением.`
}

// «Открыть»: поток-чат — переход в его чат штатной ссылкой продолжения сессии; фоновый — окно Терминала
// с той же сессией в PowerShell
async function openThread($: any, name: string) {
  const t = (await read($, list)).find((x: Thread) => x.name === name)
  if (!t?.sessionId) return
  if (t.kind === 'chat') {
    await openClaude($, `claude://code/continue?session=local_${t.sessionId}`)
    return
  }
  $.ui.toast('Открой PowerShell в ' + t.cwd + ' и выполни: claude --resume ' + t.sessionId)

}

// «Запустить» в панели: сигнал старта от лица человека, нажавшего кнопку, — для чата, до которого мод
// сам достучаться не смог
async function kick($: any, name: string) {
  const t = (await read($, list)).find((x: Thread) => x.name === name)
  if (!t?.sessionId) return
  const r: any = await $.tool.call({
    tool: 'SendMessage',
    to: `local_${t.sessionId}`,
    message: GO,
    consent: `The user pressed "Запустить" for the thread «${t.name}» in the Потоки panel`,
  }).catch((err: any) => ({ deny: String(err?.message ?? err) }))
  if (r.deny || r.isError) {
    $.ui.toast(`Поток «${name}» не запустился: ${String(r.deny ?? r.text ?? '').slice(0, 100)}`)
    return
  }
  await patch($, name, x => (x.status === 'ждёт' ? { ...x, status: 'работает', step: 'работает в чате' } : x))
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`
}

// Для панели — минутами, как в session-hub: текст меняется раз в минуту, и панель перерисовывается так же
// редко. Любая перерисовка выдаёт кнопкам новые адреса, и нажатие, пришедшее по старому, теряется
function workedFor(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000))
  if (min < 1) return 'только начал'
  if (min < 60) return `${min} мин`
  return `${Math.floor(min / 60)} ч ${min % 60} мин`
}

// «Убрать завершённые»: из списка уходят только закончившие; результаты, ещё не переданные в сводку, остаются
async function clearDone($: any) {
  await update($, list, (all: Thread[]) => all.filter(t => isActive(t) || (t.kind === 'cli' && !t.reported)))
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await ensureLoaded($)
    const savedCap = await $.store.get('maxThreads').catch(() => undefined)
    if (typeof savedCap === 'number' && savedCap >= 1 && savedCap <= 8) maxThreads = Math.floor(savedCap)
    void reconcile($)
    void pruneStore($)
    if (e.surface !== 'vscode') void reclaimPane($)
    // Панель сама не перерисуется, пока у потока-чата ничего не меняется, — минуты в ней застыли бы.
    // Раз в минуту, не чаще: каждая перерисовка может съесть нажатие кнопки
    $.clock.every(60_000, () => {
      void (async () => {
        const all: Thread[] = await read($, list)
        if (all.some(isActive)) await update($, list, (xs: Thread[]) => [...xs])
      })()
    })
    await $.command.register({ name: 'threads', description: 'Панель потоков: отдельные сессии на своих моделях' })
    await $.tool.register({
      name: 'start',
      description: 'Запускает поток — отдельную сессию Claude Code со своим контекстом на выбранной модели (sonnet — основная работа, opus — сложное и планирование; Haiku не поддерживается). В приложении Claude поток — отдельный чат в боковой панели, работа в нём видна вживую; вызов ждёт, пока чат создан (обычно 10–30 с). Несколько потоков запускай параллельными вызовами в одном ответе — их чаты создаются одновременно. Используй, когда пользователь просит разделить работу на потоки или запустить помощников на разных моделях. Потоки работают параллельно; итог каждый пришлёт в этот диалог сам. Если ответ просит вызвать SendMessage — вызови.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'короткое имя потока, например «план» или «ревью»' },
          model: { type: 'string', enum: MODELS },
          task: { type: 'string', description: 'полная задача потоку: он не видит этот диалог, дай весь нужный контекст и пути к файлам' },
          effort: { type: 'string', enum: ['low', 'medium', 'high', 'max'] },
          readOnly: { type: 'boolean', description: 'По умолчанию true: только чтение и план. Для изменения файлов явно укажи false.' },
          cwd: { type: 'string', description: 'Существующая рабочая папка или отдельный worktree. Одновременно писать в одну папку может только один поток.' },
        },
        required: ['name', 'model', 'task'],
      },
    })
    await $.tool.register({ name: 'status', description: 'Статус всех потоков: модель, состояние, текущий шаг, время, стоимость.' })
    await $.tool.register({
      name: 'result',
      description: 'Сводка результата потока, до 4000 символов. Полный диалог доступен по ID сессии.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    })
    await $.tool.register({
      name: 'send',
      description: 'Продолжает поток новым сообщением в той же его сессии (уточнение, следующий шаг); поток-чату сообщение уходит в его чат.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' }, text: { type: 'string' } }, required: ['name', 'text'] },
    })
    await $.tool.register({
      name: 'stop',
      description: 'Останавливает работающий поток по имени.',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    })
    return started
  })

  on('tool.call', { tool: 'mcp__threads__start' }, async ($, e) => ({ result: await start($, e) }))
  on('tool.call', { tool: 'mcp__threads__send' }, async ($, e) => ({ result: await resume($, e) }))
  on('tool.call', { tool: 'mcp__threads__status' }, async $ => {
    const all: Thread[] = await read($, list)
    if (all.length === 0) return { result: 'Потоков нет.' }
    const now = Date.now()
    return {
      result: all.map(t => `${t.name} · ${t.model} · ${t.status} · ${ago((t.endedAt || now) - t.startedAt)} · ${t.actions} действ. · ${t.step}`).join('\n'),
    }
  })
  on('tool.call', { tool: 'mcp__threads__result' }, async ($, e: any) => {
    const t = (await read($, list)).find((x: Thread) => x.name === e.name)
    if (!t) return { result: `Потока «${e.name}» нет.` }
    return { result: t.result || `У «${t.name}» пока нет результата (${t.status}: ${t.step}). Сессия потока: ${t.sessionId}` }
  })
  on('tool.call', { tool: 'mcp__threads__stop' }, async ($, e: any) => {
    const t = (await read($, list)).find((x: Thread) => x.name === e.name)
    if (!t || !isActive(t)) return { result: `Поток «${e.name}» не работает.` }
    const stopped = await stopThread($, e.name)
    return { result: stopped ? `Поток «${e.name}» остановлен.` : 'Остановка не подтверждена; проверь сессию вручную.' }
  })

  // Сигнал старта отправил сам главный диалог (после отказа классификатора моду) — поток пошёл в работу
  on('session.send', async ($, e, next) => {
    const sent = await next(e)
    if (sent.isDelivered) {
      await update($, list, (all: Thread[]) => all.map(t => (
        t.kind === 'chat' && t.status === 'ждёт' && String(e.to).includes(t.sessionId)
          ? { ...t, status: 'работает', step: 'работает в чате' }
          : t)))
    }
    return sent
  })

  // Итог потока-чата пришёл сообщением: поток — «готов» (или «ошибка»), текст — в результат. Имя ищем по
  // известным потокам, а не до первого «:», и терпим разметку и регистр: «**[threads] план: Готово**»
  on('session.receive', async ($, e, next) => {
    if (e.text.includes(MARK)) {
      const flat = e.text.replace(/[*_`]/g, '')
      const all: Thread[] = await read($, list)
      for (const t of all) {
        if (t.kind !== 'chat' || !reportMatches(e.origin, e.text, t.reportToken) || t.status === 'остановлен') continue
        const m = flat.match(new RegExp(`${escapeRe(MARK)}\\s*${escapeRe(t.name)}\\s*:\\s*(\\S+)`, 'i'))
        if (!m) continue
        const status = /ошиб|не\s*смог|fail|error/i.test(m[1]) ? 'ошибка' : 'готов'
        await patch($, t.name, x => ({ ...x, status, step: status === 'готов' ? 'готово' : 'ошибка', endedAt: Date.now(), result: e.text.slice(0, RESULT_IN_STATE) }))
      }
    }
    return next(e)
  })

  // Приложение показывает чат (разбуженный или открытый заново) — сразу вернуть вкладку потоков
  on('session.attach', async ($, e, next) => {
    if (e.surface !== 'vscode') void reclaimPane($)
    return next(e)
  })

  // Человек закрыл вкладку сам — при следующем пробуждении чата не открываем её без спроса
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind !== 'unload') await $.store.set(STORE_PANE_CLOSED + (await keyOf($)), true).catch(() => undefined)
    return next(e)
  })

  on('command.run', { command: 'threads' }, async ($, e) => {
    const args = String(e.args ?? '').trim().split(/\s+/)
    if (args[0] === 'cap') {
      const cap = Number(args[1])
      if (!Number.isInteger(cap) || cap < 1 || cap > 8) return { text: 'Укажи /threads cap 1–8.' }
      maxThreads = cap
      await $.store.set('maxThreads', cap)
      return { text: 'Лимит параллельных потоков: ' + cap }
    }
    await openPane($)
    return { text: 'Панель потоков открыта.' }
  })

  // Невидимый слой карточки (live.tsx) присылает { open: имя } по клику
  on('ui.message', async ($, e, next) => {
    const data = e.data as { open?: unknown } | null
    if (e.requestId === PANE && typeof data?.open === 'string') await openThread($, data.open)
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // Модули на стороне приложения есть у десктопа и терминала; в VS Code и на телефоне их нет
    const Client = 'Client' in table ? (table as any).Client : null
    const all: Thread[] = await read($, list)
    const now = Date.now()

    // Работающие — по времени старта, чтобы строки не прыгали
    // Путь потока: создаётся → ждёт запуска → в работе → завершён; внутри раздела — по времени старта
    const byStart = (a: Thread, b: Thread) => a.startedAt - b.startedAt
    const creating = all.filter(t => t.status === 'создаётся').sort(byStart)
    const waiting = all.filter(t => t.status === 'ждёт').sort(byStart)
    const live = all.filter(t => t.status === 'работает').sort(byStart)
    const done = all.filter(t => !isActive(t)).sort((a, b) => b.endedAt - a.endedAt)

    const INSET = 1
    const isDesktop = e.surface === 'desktop'

    // Тон раздела — как в session-hub: карточки слегка подкрашены его цветом, бейдж числа — тем же цветом
    // погуще. Полупрозрачные заливки ложатся и на светлую, и на тёмную тему
    type Tone = { card: string; hover: string; badge: string; ink: string; dot: string | null }
    const TONE: Record<'creating' | 'live' | 'waiting' | 'done' | 'error', Tone> = {
      creating: { card: '#3b82f614', hover: '#3b82f629', badge: '#3b82f626', ink: '#1d4ed8', dot: '#3b82f6' },
      live: { card: '#22c55e14', hover: '#22c55e29', badge: '#22c55e26', ink: '#15803d', dot: '#22c55e' },
      waiting: { card: '#eab3081f', hover: '#eab30838', badge: '#eab30833', ink: '#a16207', dot: '#eab308' },
      done: { card: '#8080800d', hover: '#8080801f', badge: '#8080801f', ink: '#71717a', dot: null },
      error: { card: '#ef444414', hover: '#ef444429', badge: '#ef444426', ink: '#b91c1c', dot: '#ef4444' },
    }
    const toneOf = (t: Thread): Tone =>
      t.status === 'работает' ? TONE.live : t.status === 'создаётся' ? TONE.creating : t.status === 'ждёт' ? TONE.waiting : t.status === 'ошибка' ? TONE.error : TONE.done

    // Скругление даёт рамка round того же цвета, что и фон; в терминале — только подсветка при наведении
    const cardFrame = (tone: Tone) =>
      isDesktop
        ? { backgroundColor: tone.card, borderStyle: 'round', borderColor: tone.card, hover: { backgroundColor: tone.hover, borderColor: tone.hover } }
        : { hover: { backgroundColor: '#3a3a3a' } }

    //  ╭──────────────────────────────────╮
    //  │ ревью                      4 мин │
    //  │ ● opus · Read src/app.ts   остановить │
    //  ╰──────────────────────────────────╯
    // Время — в первой строке: во второй ему и кнопкам не хватало места, и шаг сжимался до «son…»
    const row = (t: Thread) => {
      const tone = toneOf(t)
      const isLive = isActive(t)
      const sub = [t.model, isLive ? t.step : t.status, t.kind === 'cli' && t.costUsd > 0 ? `$${t.costUsd.toFixed(2)}` : '']
        .filter(Boolean)
        .join(' · ')
      const when = isLive ? workedFor(now - t.startedAt) : `за ${workedFor(t.endedAt - t.startedAt)}`
      // Тихие действия справа; слой клика по карточке туда не заходит, чтобы они нажимались сами
      const actions: { key: string; label: string; run: () => unknown }[] = []
      if (t.status === 'ждёт') actions.push({ key: 'kick', label: 'запустить', run: () => kick($, t.name) })
      if (isLive) actions.push({ key: 'stop', label: 'остановить', run: () => stopThread($, t.name) })
      const room = actions.reduce((n, a) => n + a.label.length + 2, 0)
      return (
        <Box key={`row-${t.name}`} flexDirection="column" paddingX={INSET} marginX={INSET} marginBottom={1} overflow="hidden" {...cardFrame(tone)}>
          <Box flexDirection="row">
            {/* minWidth 0: без него гибкий блок не сжимается уже своего текста и выталкивает время за край */}
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              {Client || !t.sessionId ? (
                <Text wrap="truncate-end" bold={t.status === 'ждёт'}>{t.name}</Text>
              ) : (
                <Button key={`open-${t.name}`} plain onPress={() => openThread($, t.name)}>{t.name}</Button>
              )}
            </Box>
            <Box flexShrink={0} marginLeft={1}>
              {isLive ? <Text color={tone.ink}>{when}</Text> : <Text dimColor>{when}</Text>}
            </Box>
          </Box>
          <Box flexDirection="row">
            {tone.dot && <Text color={tone.dot}>● </Text>}
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text dimColor wrap="truncate-end">{sub}</Text>
            </Box>
            {actions.map(a => (
              <Box key={`${a.key}-${t.name}`} flexShrink={0} marginLeft={2}>
                <Button key={`btn-${a.key}-${t.name}`} plain dimColor onPress={a.run}>{a.label}</Button>
              </Box>
            ))}
          </Box>
          {Client && t.sessionId && (
            // Клик в любом месте карточки: невидимый слой поверх неё, высотой в две строки числом
            <Box position="absolute" top={0} left={0} right={room} height={2}>
              <Client key={`hit-${t.name}`} module="./live.tsx" width="100%" height={2} props={{ part: 'hit', id: t.name }} />
            </Box>
          )}
        </Box>
      )
    }

    // Заголовок раздела: название, число в бейдже цвета раздела, тихое действие справа
    const header = (key: string, title: string, count: number, tone: Tone, action?: any) => (
      <Box key={`head-${key}`} flexDirection="row" justifyContent="space-between" paddingX={INSET * 2} marginBottom={1}>
        <Text wrap="truncate-end">
          <Text bold>{title} </Text>
          {isDesktop ? <Text backgroundColor={tone.badge} color={tone.ink} bold>{` ${count} `}</Text> : <Text dimColor>{count}</Text>}
        </Text>
        {action}
      </Box>
    )

    const empty = (text: string) => (
      <Box paddingX={INSET * 2} marginBottom={1}>
        <Text dimColor>{text}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {all.length === 0 && empty('Потоков пока нет. Попроси главный диалог разделить задачу на потоки.')}

        {creating.length > 0 && header('creating', 'Создаются', creating.length, TONE.creating)}
        {creating.map(row)}

        {waiting.length > 0 && header('waiting', 'Ждут запуска', waiting.length, TONE.waiting)}
        {waiting.map(row)}

        {header('live', 'В работе', live.length, TONE.live)}
        {live.length === 0 && empty(creating.length + waiting.length > 0 ? 'скоро начнут' : 'ничего не выполняется')}
        {live.map(row)}

        {header('done', 'Завершены', done.length, TONE.done, done.length > 0 ? (
          <Button key="clear-done" plain dimColor onPress={() => clearDone($)}>убрать</Button>
        ) : undefined)}
        {done.length === 0 && empty('пока никто не закончил')}
        {done.map(row)}

        <Box flexDirection="row" justifyContent="space-between" paddingX={INSET * 2}>
          <Box flexDirection="row" gap={2}>
            {creating.length + waiting.length + live.length > 0 && (
              <Button key="stop-all" plain dimColor onPress={async () => { for (const t of all) if (isActive(t)) await stopThread($, t.name) }}>
                остановить все
              </Button>
            )}
          </Box>
          <Box flexDirection="row" gap={2}>
            <Text dimColor>v{VERSION}</Text>
            <Button key="close" role="dismiss" plain dimColor onPress={() => $.ui.close({ id: PANE })}>закрыть</Button>
          </Box>
        </Box>
      </Box>
    )
  })
}

async function openClaude($: any, url: string) {
  if (!/^claude:\/\/(?:resume|code\/continue)\?session=(?:local_)?[0-9a-f-]+$/i.test(url)) throw new Error('Некорректная ссылка сессии')
  const windows = await $.env.get('OS') === 'Windows_NT'
  if (!windows) throw new Error('Открытие сессии поддерживается в Windows')
  const result = await $.process.run(['rundll32', 'url.dll,FileProtocolHandler', url])
  if (result.exitCode !== 0) throw new Error('Приложение не открыло сессию')
}
async function stopOwnedSession($: any, id: string): Promise<boolean> {
  if (!validSessionId(id) || id === await $.session.id()) return false
  const pattern = '(^|[[:space:]])--(resume|session-id)(=|[[:space:]]+)' + id + '([[:space:]]|$)'
  if (await $.env.get('OS') === 'Windows_NT') {
    const script = "$p = Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(claude|node)(\\.exe)?$' -and $_.CommandLine -match '" + pattern.replace(/\[\[:space:\]\]/g, '\\s') + "' }; if (!$p) { exit 3 }; $p | ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction Stop }"
    return (await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', script])).exitCode === 0
  }
  return false
}
