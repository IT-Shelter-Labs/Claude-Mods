import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { Gauge } from '../types'
import { cells, percent, remaining } from './helpers'

const gauge = atom({ plugin: 'ctx', key: 'gauge' } as const, { ctx: null, h5: null, d7: null, cacheMin: null, h5Reset: '', d7Reset: '' })
const lastTurnAt = atom({ plugin: 'ctx', key: 'lastTurnAt' } as const, 0)
const isTerminal = atom({ plugin: 'ctx', key: 'isTerminal' } as const, false)
let measuring = false
let hidden = false
let cacheTTL: number | null = null // Не угадываем TTL: /ctx cache 5, /ctx cache 60 или /ctx cache off.
let timer: { cancel: () => void } | undefined

function line(g: Gauge, width = 120): string {
  const n = width >= 90 ? 8 : width >= 60 ? 4 : 0
  const item = (name: string, p: number | null, reset = '') => p === null ? '' :
    name + ' ' + (n ? cells(p, n) + ' ' : '') + Math.round(p) + '%' + (reset ? ' ↻ ' + reset : '')
  return [item('CTX', g.ctx), item('5H', g.h5, g.h5Reset), item('7D', g.d7, g.d7Reset),
    g.cacheMin === null ? '' : 'кэш ≈' + g.cacheMin + 'м'].filter(Boolean).join('\u2003')
}
async function measure($: any) {
  if (measuring) return
  measuring = true
  try {
    const u = await $.session.usage()
    const now = await $.clock.now()
    const limits = Array.isArray(u.rateLimits) ? u.rateLimits : []
    const five = limits.find((l: any) => l.kind === 'five_hour')
    const seven = limits.find((l: any) => l.kind === 'seven_day')
    const last = await read($, lastTurnAt)
    const g: Gauge = {
      ctx: percent(u.context?.percent), h5: percent(five?.percentUsed), d7: percent(seven?.percentUsed),
      h5Reset: remaining(five?.resetsAt ?? five?.resetAt, now), d7Reset: remaining(seven?.resetsAt ?? seven?.resetAt, now),
      cacheMin: cacheTTL !== null && last > 0 ? Math.max(0, Math.ceil(cacheTTL - (now - last) / 60000)) : null,
    }
    await update($, gauge, () => g)
    $.ui.status(hidden || await read($, isTerminal) ? undefined : line(g) || undefined)
  } catch {
    // Не выводим ответ API/секреты и не затираем последний успешный замер.
  } finally { measuring = false }
}
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const settings: any = await $.store.get('display').catch(() => null)
    hidden = settings?.hidden === true
    cacheTTL = settings?.cacheTTL === 5 || settings?.cacheTTL === 60 ? settings.cacheTTL : null
    await update($, isTerminal, () => e.surface === 'terminal')
    timer?.cancel()
    timer = $.clock.every(30000, () => void measure($))
    await $.command.register({ name: 'ctx', description: 'Шкалы: hide/show, cache 5|60|off. Кэш — оценка, выключена по умолчанию.' })
    await measure($)
    return next(e)
  })
  // Отсчитываем от последнего успешного запроса модели, а не от конца всего хода.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const now = await $.clock.now()
    await update($, lastTurnAt, () => now)
    await measure($)
    return result
  })
  on('session.measure', async ($, e, next) => { void measure($); return next(e) })
  on('command.run', { command: 'clear' }, async ($, e, next) => {
    const result = await next({ ...e, args: String(e.args ?? '') })
    await update($, lastTurnAt, () => 0)
    await measure($)
    return result
  })
  on('command.run', { command: 'ctx' }, async ($, e) => {
    const args = String(e.args ?? '').trim().toLowerCase()
    if (args === 'hide') hidden = true
    else if (args === 'show') hidden = false
    else if (args === 'cache off') cacheTTL = null
    else if (args === 'cache 5') cacheTTL = 5
    else if (args === 'cache 60') cacheTTL = 60
    else if (args) return { text: 'Команды: /ctx hide, /ctx show, /ctx cache 5|60|off.' }
    await $.store.set('display', { hidden, cacheTTL })
    await measure($)
    return { text: hidden ? 'Шкалы скрыты.' : line(await read($, gauge)) || 'Данные появятся после первого запроса.' }
  })
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (e.surface !== 'terminal') return next(e)
    if (hidden || e.props.isDraft) return next(e)
    const g = await read($, gauge)
    if (g.ctx === null && g.h5 === null && g.d7 === null) return next(e)
    const { Text } = $.ui.resolve(e)
    const highest = Math.max(g.ctx ?? 0, g.h5 ?? 0, g.d7 ?? 0)
    return <Text color={highest >= 90 ? 'red' : highest >= 70 ? 'yellow' : 'green'} wrap="wrap">{line(g, e.viewport?.columns ?? 120)}</Text>
  })
}
