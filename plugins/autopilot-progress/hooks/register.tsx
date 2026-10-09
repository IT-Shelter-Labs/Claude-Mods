import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Run, Seen, Sections, Stage, Ticket, Tests } from '../types'

// Прогресс прогона Autopilot: полоса над вводом и панель со всем, что показывает dashboard.html.
// Мод опрашивает .autopilot/state.js; полоса включается сама, когда в проекте идёт прогон
// (state.js без finishedAt) или когда набрали /autopilot.
const run = atom({ plugin: 'autopilot-progress', key: 'run' } as const, null)
const isActive = atom({ plugin: 'autopilot-progress', key: 'isActive' } as const, false)
const isHidden = atom({ plugin: 'autopilot-progress', key: 'isHidden' } as const, false)
const now = atom({ plugin: 'autopilot-progress', key: 'now' } as const, 0)
const seen = atom({ plugin: 'autopilot-progress', key: 'seen' } as const, { key: '', beats: [] } as Seen)
const open = atom(
  { plugin: 'autopilot-progress', key: 'open' } as const,
  { stages: true, tickets: true, details: null } as Sections,
)

// state.json — прогоны старых версий Autopilot
const STATE_FILES = ['.autopilot/state.json', '.autopilot/state.js']
const PANE = 'autopilot-progress'

// Слова и веса — те же, что в dashboard-template.html, чтобы цифры панели и дашборда совпадали
const NAMES: Record<string, string> = {
  preflight: 'Подготовка', manifest: 'Требования', briefing: 'Брифинг', spec: 'Спецификация',
  plan: 'План', build: 'Разработка', review: 'Код-ревью', final: 'Приёмка',
}
const ORDER = Object.keys(NAMES)
// Веса — доли времени: разработка идёт часами, подготовка минуты
const WEIGHT: Record<string, number> = {
  preflight: 1, manifest: 1, briefing: 1, spec: 2, plan: 1, build: 6, review: 2, final: 1,
}
const MODES: Record<string, string> = { full: 'полный автомат', semi: 'полуавтомат', interview: 'интервью', manual: 'ручной' }
const DEPTHS: Record<string, string> = { strict: 'строго по брифу', normal: 'обычная глубина', deep: 'максимальная глубина' }
// Таск живёт в трёх активных состояниях: пишется — проверяется — чинится
const ACTIVE = ['in-progress', 'review', 'repair']
const PHASE: Record<string, string> = { 'in-progress': 'пишется', review: 'ревью', repair: 'ремонт' }
// Промежуток между метками state.js длиннее 45 минут — простой, а не работа (как в дашборде)
const IDLE_CAP_MS = 2_700_000

// ——— чтение state.js ————————————————————————————————————————————————

const str = (v: any): string | undefined => (typeof v === 'string' && v ? v : undefined)
const num = (v: any): number => (typeof v === 'number' && isFinite(v) ? Math.max(0,v) : 0)
const strs = (v: any): string[] => (Array.isArray(v) ? v.filter(x => x != null).map(String) : [])
const testsOf = (v: any): Tests | null =>
  v && typeof v === 'object' ? { passed: num(v.passed), failed: num(v.failed) } : null

export function parse(s: any, root: string, where?: string): Run {
  if (!s || typeof s !== 'object' || Array.isArray(s)) throw new Error('Invalid state object')
  const given: any[] = Array.isArray(s.stages) ? s.stages.filter(Boolean) : []
  const stages: Stage[] = ORDER.map(id => given.find(x => x.id === id) ?? { id, status: 'pending' })
    .concat(given.filter(x => !ORDER.includes(x.id)))
    .map(x => ({
      id: String(x.id), status: str(x.status) ?? 'pending',
      startedAt: str(x.startedAt), finishedAt: str(x.finishedAt), note: str(x.note),
    }))
  const tickets: Ticket[] = (Array.isArray(s.tickets) ? s.tickets.filter(Boolean) : []).map((t: any) => ({
    id: String(t.id ?? '?'), title: String(t.title ?? ''), status: str(t.status) ?? 'pending',
    wave: num(t.wave) || 1, blockedBy: strs(t.blockedBy),
    startedAt: str(t.startedAt), finishedAt: str(t.finishedAt),
    retries: num(t.retries), repairs: num(t.repairs), tests: testsOf(t.tests),
  }))
  const lastDone = tickets.filter(t => t.status === 'done').pop()
  const R = s.requirements ?? {}
  const sp = s.singlePass
  const r: Run = {
    key: `${root}:${s.slug ?? ''}:${s.startedAt ?? ''}`,
    root, where,
    title: String(s.title ?? s.slug ?? 'прогон'),
    dir: String(s.dir ?? s.slug ?? ''),
    mode: str(s.mode), depth: str(s.depth), tier: s.tier == null ? undefined : String(s.tier),
    startedAt: str(s.startedAt), updatedAt: str(s.updatedAt), finishedAt: str(s.finishedAt),
    stages, tickets,
    req: { total: num(R.total), done: num(R.done), dropped: num(R.dropped), deferred: num(R.deferred), placeholder: num(R.placeholder) },
    // полный прогон, если записан; иначе — тесты последнего таска или T0-сборки
    tests: testsOf(s.tests) ?? lastDone?.tests ?? testsOf(sp?.tests),
    debt: { placeholders: strs(s.debt?.placeholders), assumptions: strs(s.debt?.assumptions), emptyEnv: strs(s.debt?.emptyEnv) },
    additions: strs(s.additions),
    blind: s.blind ? { checked: num(s.blind.checked), matched: num(s.blind.matched), mismatches: strs(s.blind.mismatches) } : null,
    beats: strs(s.beats),
    single: sp ? { startedAt: str(sp.startedAt), finishedAt: str(sp.finishedAt), files: strs(sp.files).length } : null,
    finished: Boolean(s.finishedAt),
  }
  // $.state хранит данные: незаполненные поля убираем, а не пишем undefined
  return JSON.parse(JSON.stringify(r))
}

// Где искать .autopilot: папка сессии и все рабочие копии репозитория (git worktree).
// Autopilot часто собирает в отдельной копии — тогда в папке сессии лежит прошлый, сданный прогон.
type Root = { path: string; where?: string }
let roots: Root[] = []
let rootsAt = 0

async function findRoots($: any): Promise<Root[]> {
  if (roots.length && Date.now() - rootsAt < 30_000) return roots
  const cwd: string = await $.session.cwd()
  const found: Root[] = [{ path: cwd }]
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'worktree', 'list', '--porcelain'], { timeoutMs: 5000, cwd })
    if (exitCode === 0) {
      for (const block of String(stdout).split(/\n\s*\n/)) {
        const path = /^worktree (.+)$/m.exec(block)?.[1]
        if (!path || path === cwd) continue
        const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1]
        const name = path.split('/').filter(Boolean).pop() ?? path
        found.push({ path, where: branch ? `${name} · ${branch}` : name })
      }
    }
  } catch {}
  roots = found
  rootsAt = Date.now()
  return roots
}

// null — прогона нет; undefined — какой-то state.js пишется прямо сейчас: ждём следующий опрос.
// Из нескольких прогонов берём идущий (самый свежий), а если идущих нет — самый свежий сданный.
async function load($: any): Promise<{ text: string; run: Run } | null | undefined> {
  const found: { text: string; run: Run }[] = []
  let broken = false
  for (const root of await findRoots($)) {
    for (const file of STATE_FILES) {
      let text: string
      try {
        text = await $.fs.read(`${root.path}/${file}`)
      } catch {
        continue
      }
      try {
        const s = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
        found.push({ text: root.path + text, run: parse(s, root.path, root.where) })
      } catch {
        broken = true
        continue
      }
      break
    }
  }
  const fresh = (x: { run: Run }) => Date.parse(x.run.updatedAt ?? x.run.startedAt ?? '') || 0
  const pick = (list: typeof found) => list.sort((a, b) => fresh(b) - fresh(a))[0] ?? null
  return pick(found.filter(x => !x.run.finished)) ?? pick(found) ?? (broken ? undefined : null)
}

// ——— время ——————————————————————————————————————————————————————————
// Часы прогона показывают работу, а не календарь: сумма промежутков между метками
// state.js, каждый обрезан порогом простоя. Ушёл человек на ночь — часы стоят.

function marksOf(r: Run, beats: string[]): number[] {
  const out = new Set<number>()
  const push = (v?: string) => {
    const t = v ? Date.parse(v) : NaN
    if (!isNaN(t)) out.add(t)
  }
  push(r.startedAt); push(r.updatedAt); push(r.finishedAt)
  r.beats.forEach(push); beats.forEach(push)
  r.stages.forEach(x => { push(x.startedAt); push(x.finishedAt) })
  r.tickets.forEach(x => { push(x.startedAt); push(x.finishedAt) })
  return [...out].sort((a, b) => a - b)
}

export function clockOf(r: Run, beats: string[], nowMs: number) {
  const marks = marksOf(r, beats)
  const active = (from?: string, to?: string): number | null => {
    const a = from ? Date.parse(from) : NaN
    if (isNaN(a)) return null
    const b = to ? Date.parse(to) : nowMs
    if (b <= a) return 0
    const pts = [a, ...marks.filter(t => t > a && t < b), b]
    let sum = 0
    for (let i = 1; i < pts.length; i++) sum += Math.min(pts[i]! - pts[i - 1]!, IDLE_CAP_MS)
    return sum
  }
  const calendar = (from?: string, to?: string): number | null => {
    const a = from ? Date.parse(from) : NaN
    return isNaN(a) ? null : Math.max(0, (to ? Date.parse(to) : nowMs) - a)
  }
  const last = marks[marks.length - 1]
  const isIdle = !r.finished && last != null && nowMs - last > IDLE_CAP_MS
  return { active, calendar, isIdle }
}

const pad = (n: number) => String(n).padStart(2, '0')
function fmtClock(ms: number | null): string {
  if (ms == null) return '—'
  const s = Math.floor(ms / 1000), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}
function fmtMin(m: number | null): string {
  if (m == null) return '—'
  return m < 60 ? `${m} мин` : `${Math.floor(m / 60)} ч ${pad(m % 60)} мин`
}
function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 10, b = Math.abs(n) % 100
  if (a === 1 && b !== 11) return one
  if (a >= 2 && a <= 4 && (b < 12 || b > 14)) return few
  return many
}
function ago(iso: string | undefined, nowMs: number): string {
  const t = iso ? Date.parse(iso) : NaN
  if (isNaN(t)) return '—'
  const s = Math.max(0, Math.floor((nowMs - t) / 1000))
  if (s < 60) return `${s} сек назад`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m} мин назад` : `${Math.floor(m / 60)} ч ${m % 60} мин назад`
}

// ——— цифры дашборда ——————————————————————————————————————————————————

export function stats(r: Run, clock: ReturnType<typeof clockOf>) {
  const T = r.tickets
  const done = T.filter(t => t.status === 'done')
  const count = (st: string) => T.filter(t => t.status === st).length
  const writing = count('in-progress'), inReview = count('review'), inRepair = count('repair'), failed = count('failed')
  const waiting = Math.max(0, T.length - done.length - writing - inReview - inRepair - failed)

  const stageFrac = (s: Stage) => {
    if (s.status === 'done' || s.status === 'skipped') return 1
    if (s.status !== 'active') return 0
    if (s.id === 'build' && T.length) return Math.max(0.05, done.length / T.length)
    return 0.5
  }
  const totalW = r.stages.reduce((a, s) => a + (WEIGHT[s.id] ?? 1), 0)
  const hasFailures = failed > 0 || r.stages.some(s => s.status === 'failed') || (r.tests?.failed ?? 0) > 0
  const overall = r.finished && !hasFailures ? 100
    : totalW ? Math.min(hasFailures ? 99 : 100, Math.max(0, Math.round(r.stages.reduce((a, s) => a + (WEIGHT[s.id] ?? 1) * stageFrac(s), 0) / totalW * 100))) : 0
  const stagesDone = r.stages.filter(s => s.status === 'done' || s.status === 'skipped').length

  const activeStage = r.stages.find(s => s.status === 'active')
  const curStage = activeStage ?? r.stages.find(s => s.status !== 'done' && s.status !== 'skipped')
  const stageNo = curStage ? r.stages.indexOf(curStage) + 1 : r.stages.length

  const live = Math.max(0, r.req.total - r.req.dropped)
  const coverage = live ? Math.max(0, Math.min(100, Math.round((r.req.done / live) * 100))) : 0
  // таск на ревью уже написан — считаем его на три четверти, а не нулём
  const ticketPct = T.length ? Math.round(((done.length + 0.75 * (inReview + inRepair)) / T.length) * 100) : 0
  const retries = T.reduce((a, t) => a + t.retries, 0)

  // Оценка остатка — по цепочке зависимостей, в минутах, от медианы готового таска
  const mins = (t: Ticket) => (t.startedAt && t.finishedAt
    ? Math.max(1, Math.round((clock.active(t.startedAt, t.finishedAt) ?? 0) / 60000)) : null)
  const durs = done.map(mins).filter((x): x is number => x != null).sort((a, b) => a - b)
  const median = durs.length ? durs[Math.floor(durs.length / 2)] : null
  const byId = Object.fromEntries(T.map(t => [t.id, t]))
  const leftFor = (t: Ticket) => {
    const full = median || 10
    if (t.status === 'review') return full * 0.2
    if (t.status === 'repair') return full * 0.5
    if (t.status === 'in-progress' && t.startedAt) return Math.max(1, full - (clock.active(t.startedAt) ?? 0) / 60000)
    return full
  }
  let hasCycle = false
  const chain = (f: (t: Ticket) => number) => {
    const memo: Record<string, number> = {}
    const walk = (id: string, path: Set<string>): number => {
      const t = byId[id]
      if (!t || t.status === 'done') return 0
      if (memo[id] != null) return memo[id]
      if (path.has(id)) { hasCycle = true; return 0 }
      path.add(id)
      const v = f(t) + Math.max(0, ...t.blockedBy.map(b => walk(b, path)))
      path.delete(id)
      return (memo[id] = v)
    }
    return Math.max(0, ...T.map(t => walk(t.id, new Set())))
  }
  const critical = chain(() => 1)
  const cpMin = chain(leftFor)
  const eta: [number, number] | null = !hasCycle && median && cpMin > 0
    ? [Math.max(1, Math.round(cpMin * 0.75)), Math.max(2, Math.round(cpMin * 1.4))] : null

  const build = r.stages.find(s => s.id === 'build')
  const buildMs = build?.startedAt && build.finishedAt ? clock.active(build.startedAt, build.finishedAt) : null
  const debtN = r.debt.placeholders.length + r.debt.assumptions.length + r.debt.emptyEnv.length
  const isT0 = String(r.tier).toUpperCase() === 'T0'

  return {
    done: done.length, writing, inReview, inRepair, failed, waiting, overall, stagesDone, activeStage, curStage,
    stageNo, live, coverage, ticketPct, retries, median, critical, eta, buildMs, debtN, isT0,
  }
}

function bar(p: number, width: number): string {
  const full = Math.max(0, Math.min(width, Math.round((p / 100) * width)))
  return '█'.repeat(full) + '░'.repeat(width - full)
}

// Тона статусов — цвета дашборда. Полупрозрачные заливки ложатся и на светлую, и на тёмную тему
// (как в session-hub): card — фон карточки, badge — бейдж погуще, ink — текст, dot — значок и шкала
type Tone = { card: string; badge: string; ink: string; dot: string }
const TONE = {
  accent: { card: '#0ea5e914', badge: '#0ea5e92e', ink: '#0284c7', dot: '#0ea5e9' },
  ok: { card: '#22c55e14', badge: '#22c55e29', ink: '#16a34a', dot: '#22c55e' },
  run: { card: '#eab3081f', badge: '#eab30838', ink: '#b45309', dot: '#eab308' },
  review: { card: '#3b82f614', badge: '#3b82f62e', ink: '#2563eb', dot: '#3b82f6' },
  repair: { card: '#a855f714', badge: '#a855f72e', ink: '#9333ea', dot: '#a855f7' },
  bad: { card: '#ef444414', badge: '#ef44442e', ink: '#dc2626', dot: '#ef4444' },
  idle: { card: '#8080800d', badge: '#8080801f', ink: '#71717a', dot: '#a1a1aa' },
} satisfies Record<string, Tone>

function stageTone(st: string): [string, Tone] {
  if (st === 'done') return ['✓', TONE.ok]
  if (st === 'skipped') return ['–', TONE.idle]
  if (st === 'active') return ['●', TONE.accent]
  if (st === 'failed') return ['✗', TONE.bad]
  return ['○', TONE.idle]
}
function ticketTone(st: string): [string, Tone] {
  if (st === 'done') return ['✓', TONE.ok]
  if (st === 'in-progress') return ['●', TONE.run]
  if (st === 'review') return ['◇', TONE.review]
  if (st === 'repair') return ['↺', TONE.repair]
  if (st === 'failed') return ['✗', TONE.bad]
  return ['○', TONE.idle]
}

// ——— опрос и часы ————————————————————————————————————————————————————

let stopPoll: { cancel: () => void } | undefined
let stopTick: { cancel: () => void } | undefined
let lastText = ''

function tick($: any, on: boolean) {
  if (on && !stopTick) stopTick = $.clock.every(1000, () => void update($, now, () => Date.now()))
  if (!on && stopTick) {
    stopTick.cancel()
    stopTick = undefined
  }
}

let refreshing = false
let warned = false
async function refresh($: any) {
  if (refreshing) return
  refreshing = true
  try { await refreshInner($); warned = false }
  catch { if (!warned) $.ui.toast('Autopilot: не удалось обновить прогресс, сохраняю последний снимок.'); warned = true }
  finally { refreshing = false }
}
async function refreshInner($: any) {
  const got = await load($)
  if (got === undefined) return
  if ((got?.text ?? '') === lastText) return
  lastText = got?.text ?? ''
  const r = got?.run ?? null
  let wasRunning = false
  await update($, run, old => {
    wasRunning = Boolean(old && !old.finished && old.key === r?.key)
    return r
  })
  const beat = r?.updatedAt
  if (r && beat) {
    await update($, seen, s => {
      const beats = s.key === r.key ? s.beats : []
      return beats.includes(beat) ? { key: r.key, beats } : { key: r.key, beats: [...beats, beat].slice(-600) }
    })
  }
  await update($, now, () => Date.now())
  if (r && !r.finished) await update($, isActive, () => true)
  tick($, Boolean(r && !r.finished))
  if (r?.finished && wasRunning) {
    const failed = r.stages.some(s => s.status === 'failed') || r.tickets.some(t => t.status === 'failed') || (r.tests?.failed ?? 0) > 0
    $.ui.toast('Autopilot: «' + r.title + '» — ' + (failed ? 'завершён с ошибками, проверь результат' : 'завершён'))
  }
}

function startPoll($: any) {
  if (!stopPoll) stopPoll = $.clock.every(3000, () => void refresh($))
}

async function openPane($: any) {
  await $.ui.open({ id: PANE, title: 'Autopilot' })
}

async function openDashboard($: any, root: string) {
  const file = `${root}/.autopilot/dashboard.html`
  for (const argv of [['rundll32', 'url.dll,FileProtocolHandler', file]]) {
    try {
      if ((await $.process.run(argv, { timeoutMs: 5000 })).exitCode === 0) return
    } catch {}
  }
  $.ui.toast('Не получилось открыть .autopilot/dashboard.html')
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'autopilot-progress', description: 'Прогресс Autopilot: этапы, таски, время, покрытие брифа — в панели' })
    lastText = ''
    await refresh($)
    startPoll($)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (/^\s*\/autopilot\b/.test(e.text ?? '')) {
      await update($, isActive, () => true)
      await update($, isHidden, () => false)
      startPoll($)
    }
    return next(e)
  })

  on('command.run', { command: 'autopilot-progress' }, async $ => {
    await update($, isActive, () => true)
    startPoll($)
    await openPane($)
    return { text: 'Панель прогресса Autopilot открыта.' }
  })

  // Полоса одна на все моды: строка прогресса ставится над тем, что рисуют моды ниже
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey || !(await read($, isActive)) || (await read($, isHidden))) return below
    const r = await read($, run)
    const { Box, Text, Button } = $.ui.resolve(e)
    if (!r) {
      return <Box flexDirection="column"><Text color="cyan">Autopilot · запуск — жду первый этап…</Text>{below}</Box>
    }
    const sn = await read($, seen)
    const clock = clockOf(r, sn.key === r.key ? sn.beats : [], (await read($, now)) || Date.now())
    const s = stats(r, clock)
    const stage = r.finished ? (s.failed || (r.tests?.failed ?? 0) > 0 || r.stages.some(st => st.status === 'failed') ? 'завершён с ошибками' : 'готово') : s.curStage ? NAMES[s.curStage.id] ?? s.curStage.id : 'Подготовка'
    // Ширина полосы: на узкой сначала уходят время и бриф, потом таски, шкала короче, кнопки — на новую строку
    const cols = e.props.bodyColumns ?? 120
    const parts = [`Autopilot · ${stage} · ${bar(s.overall, cols < 60 ? 8 : 16)} ${s.overall}%`]
    if (cols >= 70 && r.tickets.length > 0) parts.push(`таски ${s.done}/${r.tickets.length}`)
    if (cols >= 90 && s.live > 0) parts.push(`бриф ${s.coverage}%`)
    if (cols >= 110 && r.startedAt) {
      parts.push(`⏱ ${fmtMin(Math.round((clock.active(r.startedAt, r.finishedAt) ?? 0) / 60000))}${clock.isIdle ? ' (пауза)' : ''}`)
    }
    return (
      <Box flexDirection="column">
        <Box flexWrap="wrap" gap={1}>
          <Box flexShrink={1}>
            <Text color={r.finished ? 'green' : 'cyan'} wrap="truncate-end">{parts.join(' · ')}</Text>
          </Box>
          <Box gap={1}>
            <Button key="more" label="Панель" onPress={() => void openPane($)} />
            <Button key="hide" label="Скрыть" onPress={() => update($, isHidden, () => true)} />
          </Box>
        </Box>
        {below}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const r = await read($, run)
    if (!r) {
      return (
        <Box flexDirection="column" paddingX={2}>
          <Text dimColor>Прогона Autopilot в этом проекте нет.</Text>
          <Text dimColor>Панель оживёт сама, как только он начнётся.</Text>
        </Box>
      )
    }
    const nowMs = (await read($, now)) || Date.now()
    const sn = await read($, seen)
    const o = await read($, open)
    const hidden = await read($, isHidden)
    const clock = clockOf(r, sn.key === r.key ? sn.beats : [], nowMs)
    const s = stats(r, clock)
    const cols = e.props.bodyColumns ?? 40
    const T = r.tickets
    const showDetails = o.details ?? r.finished
    // Заливки и скругления рисуют приложение и редактор; в терминале — цветной текст без фона
    const isRich = e.surface !== 'terminal'
    const main = r.finished ? TONE.ok : TONE.accent

    // ——— кирпичики ———
    // Карточка: скругление даёт рамка round того же цвета, что и фон, — её не видно, а углы круглые
    const card = (key: string, tone: Tone, children: any, gapBottom = 1) => (
      <Box
        key={key}
        flexDirection="column"
        paddingX={1}
        marginX={1}
        marginBottom={gapBottom}
        overflow="hidden"
        {...(isRich ? { backgroundColor: tone.card, borderStyle: 'round', borderColor: tone.card } : {})}
      >
        {children}
      </Box>
    )
    const badge = (key: string, text: string, tone: Tone) =>
      isRich
        ? <Text key={key} backgroundColor={tone.badge} color={tone.ink} bold>{` ${text} `}</Text>
        : <Text key={key} color={tone.ink} bold>{text}</Text>
    // Строка «слева … справа»: minWidth 0 даёт левой части сжаться, и время не уезжает за край
    const line = (key: string, left: any, right?: any) => (
      <Box key={key} flexDirection="row">
        <Box flexGrow={1} flexShrink={1} minWidth={0}>{left}</Box>
        {right != null ? <Box flexShrink={0} marginLeft={1}>{right}</Box> : null}
      </Box>
    )
    const meter = (key: string, p: number, tone: Tone) =>
      isRich ? (
        <Box key={key} flexDirection="row" width="100%" height={1} marginY={1} backgroundColor="#8080802e">
          <Box width={`${Math.max(0, Math.min(100, p))}%`} height={1} backgroundColor={tone.dot} />
        </Box>
      ) : (
        <Text key={key} color={tone.dot}>{bar(p, Math.max(8, Math.min(40, cols - 6)))}</Text>
      )
    const header = (key: keyof Sections, isOpen: boolean, title: string, count: string, tone: Tone) => (
      <Box key={`h-${key}`} flexDirection="row" paddingX={2} marginBottom={1} marginTop={1}>
        <Button
          key={`sec-${key}`}
          plain
          onPress={() => update($, open, x => ({ ...x, [key]: !(x[key] ?? (key === 'details' && r.finished)) }))}
        >
          {`${isOpen ? '▾' : '▸'} ${title}`}
        </Button>
        <Text> </Text>
        {badge(`hb-${key}`, count, tone)}
      </Box>
    )
    const bullets = (key: string, title: string, items: string[], tone: Tone) =>
      card(key, items.length ? tone : TONE.idle, [
        line(`${key}-h`, <Text bold wrap="truncate-end">{title}</Text>, <Text color={tone.ink} bold>{items.length}</Text>),
        ...(items.length
          ? items.map((x, i) => <Box key={`${key}-${i}`}><Text wrap="wrap"><Text color={tone.dot}>• </Text>{x}</Text></Box>)
          : [<Text key={`${key}-0`} dimColor>пусто</Text>]),
      ])

    // ——— шапка: название, где идёт, общий прогресс ———
    const meta = [MODES[r.mode ?? ''] ?? r.mode, DEPTHS[r.depth ?? ''] ?? r.depth, r.tier && `ярус ${r.tier}`]
      .filter(Boolean).join(' · ')
    const curName = r.finished ? 'сдан' : s.curStage ? NAMES[s.curStage.id] ?? s.curStage.id : 'всё пройдено'
    const hero = card('hero', main, [
      <Text key="t" bold wrap="truncate-end">{r.title}</Text>,
      meta ? <Text key="m" dimColor wrap="truncate-end">{meta}</Text> : null,
      r.where ? <Box key="w" marginTop={1}>{badge('wb', `⎇ ${r.where}`, TONE.idle)}</Box> : null,
      <Box key="p" flexDirection="row" marginTop={1} alignItems="flex-end">
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text wrap="truncate-end">
            <Text bold color={main.ink}>{s.overall}%</Text>
            <Text dimColor>  прогресс проекта</Text>
          </Text>
        </Box>
        <Box flexShrink={0} marginLeft={1}>{badge('stage', curName, main)}</Box>
      </Box>,
      meter('bar', s.overall, main),
      <Text key="sub" dimColor wrap="truncate-end">
        {s.stagesDone} из {r.stages.length} этапов{T.length ? ` · ${s.done} из ${T.length} тасков` : ''}
      </Text>,
    ])

    // ——— плитки с главными цифрами, по две в ряд ———
    const work = clock.active(r.startedAt, r.finishedAt)
    const cal = clock.calendar(r.startedAt, r.finishedAt)
    type Tile = { k: string; label: string; value: string; sub?: string; tone: Tone }
    const tiles: Tile[] = [
      {
        k: 'stage', label: 'Этап', tone: main,
        value: r.finished ? 'сдан' : s.curStage ? `${NAMES[s.curStage.id] ?? s.curStage.id}` : '—',
        sub: !r.finished && s.activeStage?.startedAt
          ? `${s.stageNo} из ${r.stages.length} · ${fmtClock(clock.active(s.activeStage.startedAt))}`
          : `${s.stagesDone} из ${r.stages.length}`,
      },
      {
        k: 'cov', label: 'Покрытие брифа', value: `${s.coverage}%`, sub: `${r.req.done} из ${s.live} требований`,
        tone: s.coverage >= 90 ? TONE.ok : TONE.accent,
      },
      {
        k: 'work', label: 'В работе', value: fmtClock(work), tone: clock.isIdle ? TONE.run : TONE.idle,
        sub: clock.isIdle ? 'пауза — часы стоят'
          : cal != null && work != null && cal - work > 60_000 ? `календарных ${fmtClock(cal)}`
          : s.median ? `медиана таска ${s.median} мин` : undefined,
      },
      r.finished
        ? { k: 'build', label: 'Разработка', value: s.buildMs != null ? fmtClock(s.buildMs) : '—', tone: TONE.idle,
            sub: s.median ? `медиана таска ${s.median} мин` : undefined }
        : {
            k: 'eta', label: 'Осталось', tone: TONE.idle,
            value: s.eta ? `${fmtMin(s.eta[0])} … ${fmtMin(s.eta[1])}` : '—',
            sub: s.eta ? `путь: ${s.critical} ${plural(s.critical, 'таск', 'таска', 'тасков')}`
              : s.isT0 ? 'ярус T0' : T.length && s.done === T.length ? 'идёт приёмка' : 'нужно 2+ готовых таска',
          },
      {
        k: 'tests', label: 'Тесты',
        value: r.tests ? (r.tests.failed ? `${r.tests.failed} упало` : `${r.tests.passed} ✓`) : '—',
        sub: r.tests?.failed ? `прошло ${r.tests.passed}` : undefined,
        tone: r.tests?.failed ? TONE.bad : r.tests ? TONE.ok : TONE.idle,
      },
      { k: 'debt', label: 'Долг', value: String(s.debtN), tone: s.debtN ? TONE.run : TONE.idle,
        sub: `заглушки ${r.debt.placeholders.length} · .env ${r.debt.emptyEnv.length}` },
    ]
    const tile = (x: Tile) => (
      <Box
        key={`tile-${x.k}`}
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        minWidth={0}
        width="50%"
        paddingX={1}
        overflow="hidden"
        {...(isRich ? { backgroundColor: x.tone.card, borderStyle: 'round', borderColor: x.tone.card } : {})}
      >
        <Text dimColor wrap="truncate-end">{x.label}</Text>
        <Text bold color={x.tone === TONE.idle ? undefined : x.tone.ink} wrap="truncate-end">{x.value}</Text>
        {x.sub ? <Text dimColor wrap="truncate-end">{x.sub}</Text> : <Text> </Text>}
      </Box>
    )
    const perRow = cols >= 34 ? 2 : 1
    const tileRows: any[] = []
    for (let i = 0; i < tiles.length; i += perRow) {
      tileRows.push(
        <Box key={`tr-${i}`} flexDirection="row" gap={1} marginX={1} marginBottom={1}>
          {tiles.slice(i, i + perRow).map(tile)}
        </Box>,
      )
    }

    // ——— этапы: одна карточка, текущий этап подсвечен ———
    const stageCard = o.stages ? card('stages', TONE.idle, r.stages.map(st => {
      const [mark, tone] = stageTone(st.status)
      const isNow = st.status === 'active'
      const dur = st.status === 'skipped' ? 'пропущен'
        : st.startedAt ? fmtClock(clock.active(st.startedAt, st.finishedAt)) : '—'
      return (
        <Box key={`st-${st.id}`} flexDirection="column">
          {line(`st-l-${st.id}`,
            <Text wrap="truncate-end">
              <Text color={tone.dot}>{mark} </Text>
              <Text bold={isNow} color={isNow ? tone.ink : undefined} dimColor={st.status === 'pending'}>
                {NAMES[st.id] ?? st.id}
              </Text>
            </Text>,
            isNow ? badge(`st-b-${st.id}`, dur, tone)
              : <Text dimColor>{dur}</Text>)}
          {st.note ? <Text dimColor wrap="truncate-end">   {st.note}</Text> : null}
        </Box>
      )
    })) : null

    // ——— таски ———
    const chips = [
      badge('c-done', `готово ${s.done}`, TONE.ok),
      s.writing ? badge('c-run', `пишутся ${s.writing}`, TONE.run) : null,
      s.inReview ? badge('c-rev', `ревью ${s.inReview}`, TONE.review) : null,
      s.inRepair ? badge('c-fix', `ремонт ${s.inRepair}`, TONE.repair) : null,
      s.waiting ? badge('c-wait', `ждут ${s.waiting}`, TONE.idle) : null,
      s.failed ? badge('c-bad', `упало ${s.failed}`, TONE.bad) : null,
    ].filter(Boolean)
    const ticketTime = (t: Ticket) =>
      t.startedAt && t.status !== 'pending' ? fmtClock(clock.active(t.startedAt, t.finishedAt)) : '—'
    // Идущие таски — отдельными карточками сверху: на них и смотрят
    const running = T.filter(t => ACTIVE.includes(t.status))
      .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
    const runningCards = running.map(t => {
      const [, tone] = ticketTone(t.status)
      return card(`now-${t.id}`, tone, [
        line(`now-t-${t.id}`,
          <Text wrap="truncate-end"><Text bold color={tone.ink}>{t.id} </Text><Text bold>{t.title}</Text></Text>),
        line(`now-s-${t.id}`,
          <Text wrap="truncate-end">
            <Text color={tone.dot}>● </Text>
            <Text color={tone.ink}>{PHASE[t.status]}</Text>
            <Text dimColor>{` · волна ${t.wave}${t.retries ? ` · повтор ${t.retries}` : ''}`}</Text>
          </Text>,
          <Text bold color={tone.ink}>{ticketTime(t)}</Text>),
      ])
    })
    const waves = [...new Set(T.map(t => t.wave))].sort((a, b) => a - b)
    const waveCards = waves.map(w => {
      const inWave = T.filter(t => t.wave === w).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
      const doneIn = inWave.filter(t => t.status === 'done').length
      const isAll = doneIn === inWave.length
      return card(`w-${w}`, isAll ? TONE.ok : inWave.some(t => ACTIVE.includes(t.status)) ? TONE.run : TONE.idle, [
        line(`w-h-${w}`,
          <Text bold wrap="truncate-end">
            Волна {w}<Text dimColor>{inWave.length > 1 ? ` · ${inWave.length} параллельно` : ''}</Text>
          </Text>,
          <Text color={isAll ? TONE.ok.ink : undefined} dimColor={!isAll}>{doneIn}/{inWave.length}</Text>),
        ...inWave.map(t => {
          const [mark, tone] = ticketTone(t.status)
          const isLive = ACTIVE.includes(t.status)
          const isWait = t.status === 'pending'
          return line(`t-${t.id}`,
            <Text wrap="truncate-end" dimColor={isWait}>
              <Text color={tone.dot}>{mark} </Text>
              <Text bold color={isLive ? tone.ink : undefined}>{t.id} </Text>
              {t.title}
            </Text>,
            <Text>
              {t.repairs ? <Text color={TONE.repair.ink}>+{t.repairs} </Text> : null}
              {t.tests?.failed ? <Text color={TONE.bad.ink}>{t.tests.failed}✗ </Text> : null}
              <Text bold={isLive} color={isLive ? tone.ink : undefined} dimColor={!isLive}>{ticketTime(t)}</Text>
            </Text>)
        }),
      ])
    })
    const ticketBlock = !o.tickets ? []
      : T.length ? [
        <Box key="chips" flexDirection="row" flexWrap="wrap" gap={1} paddingX={2} marginBottom={1}>{chips}</Box>,
        !r.finished && !running.length && s.done < T.length
          ? <Box key="idle" paddingX={2} marginBottom={1}><Text dimColor>Ни один таск не запущен.</Text></Box> : null,
        ...runningCards,
        ...waveCards,
      ]
      : [card('t0', TONE.idle, s.isT0 || r.single
          ? [
            <Text key="a" wrap="wrap">Ярус T0 — собрано за один заход, без тасков.{r.single?.files ? ` Файлов: ${r.single.files}.` : ''}</Text>,
            r.single?.startedAt ? line('b', <Text dimColor>Время</Text>, <Text bold>{fmtClock(clock.active(r.single.startedAt, r.single.finishedAt))}</Text>) : null,
          ]
          : [<Text key="a" dimColor>Тасков пока нет — идёт подготовка.</Text>])]

    // ——— итоги и долг ———
    const detailBlock = showDetails ? [
      card('d-req', TONE.idle, [
        line('d-req-h', <Text bold>Требования</Text>, <Text bold>{r.req.total}</Text>),
        <Text key="d-req-s" dimColor wrap="truncate-end">
          снято {r.req.dropped} · отложено {r.req.deferred} · заглушки {r.req.placeholder}
        </Text>,
      ]),
      bullets('d-ph', 'Заглушки — нужны твои данные', r.debt.placeholders, TONE.run),
      bullets('d-as', 'Решения, принятые за тебя', r.debt.assumptions, TONE.accent),
      bullets('d-env', 'Переменные в .env', r.debt.emptyEnv, TONE.run),
      r.additions.length ? bullets('d-add', 'Сверх заказанного', r.additions, TONE.accent) : null,
      r.blind ? card('d-blind', r.blind.mismatches.length ? TONE.run : TONE.ok, [
        line('d-bl-h', <Text bold>Слепая приёмка</Text>,
          badge('d-bl-b', `${r.blind.matched}/${r.blind.checked}`, r.blind.mismatches.length ? TONE.run : TONE.ok)),
        ...(r.blind.mismatches.length
          ? r.blind.mismatches.map((x, i) => <Box key={`bm-${i}`}><Text wrap="wrap"><Text color={TONE.run.dot}>• </Text>{x}</Text></Box>)
          : [<Text key="bm-0" dimColor>Расхождений нет.</Text>]),
      ]) : null,
    ] : []

    return (
      <Box flexDirection="column">
        {hero}
        {tileRows}
        {header('stages', o.stages, 'Этапы', `${s.stagesDone}/${r.stages.length}`, main)}
        {stageCard}
        {header('tickets', o.tickets, 'Таски', T.length ? `${s.done}/${T.length} · ${s.ticketPct}%` : '—',
          T.length && s.done === T.length ? TONE.ok : running.length ? TONE.run : TONE.idle)}
        {ticketBlock}
        {header('details', showDetails, 'Итоги и долг', String(s.debtN), s.debtN ? TONE.run : TONE.idle)}
        {detailBlock}
        <Box key="foot" flexDirection="column" paddingX={2} marginTop={1}>
          <Text dimColor wrap="truncate-end">Обновлено {ago(r.updatedAt, nowMs)} · .autopilot/{r.dir}/</Text>
          <Box flexDirection="row" gap={2}>
            <Button key="dash" plain dimColor onPress={() => void openDashboard($, r.root)}>открыть дашборд</Button>
            <Button key="band" plain dimColor onPress={() => update($, isHidden, x => !x)}>
              {hidden ? 'показать полосу' : 'скрыть полосу'}
            </Button>
          </Box>
        </Box>
      </Box>
    )
  })
}
