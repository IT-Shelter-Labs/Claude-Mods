import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { HandoffPending } from '../types'
import { validDocument } from './document'
const askAt = atom({ plugin: 'handoff', key: 'askAt' } as const, 60)
const WAIT_MS = 15 * 60_000
let sessionId = '', pending: HandoffPending | null = null
let asking = false, transitioning = false, armed = true, threshold = 60
let interactive = false
async function save($: any) {
  if (sessionId) await $.store.set('s:' + sessionId, { askAt: await read($, askAt), pending, at: await $.clock.now() })
}
async function cancel($: any, message: string) {
  pending = null
  await save($)
  $.ui.toast(message)
}
async function written($: any, p: HandoffPending): Promise<boolean> {
  try {
    const stat = await $.fs.stat(p.path)
    if (!stat || stat.mtimeMs < p.startedAt - 2000) return false
    return validDocument(await $.fs.read(p.path), p.transferId)
  } catch { return false }
}
async function start($: any) {
  if (pending || transitioning) return
  armed = false
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE'))
  if (!home) { $.ui.toast('Не удалось определить домашнюю папку. Контекст сохранён.'); return }
  const id = crypto.randomUUID()
  const path = home.replace(/\\/g, '/') + '/.claude/handoffs/handoff-' + id + '.md'
  pending = { path, transferId: id, startedAt: await $.clock.now(), writeTurnId: null }
  await save($)
  $.clock.after(WAIT_MS + 1000, () => void expire($).catch(() => undefined))
  try {
    await $.command.run({ command: 'handoff:write', args: 'Файл: ' + JSON.stringify(path) + '\nID передачи: ' + id })
  } catch {
    await cancel($, 'Не удалось начать запись документа. Контекст не очищен.')
  }
}
async function expire($: any) {
  if (pending && !transitioning && await $.clock.now() - pending.startedAt > WAIT_MS) {
    await cancel($, 'Время передачи истекло. Контекст не очищен; файл можно проверить вручную.')
  }
}
async function fresh($: any, p: HandoffPending) {
  if (transitioning || pending?.transferId !== p.transferId) return
  transitioning = true
  try {
    if (!await written($, p)) { await cancel($, 'Документ пустой или неполный. Контекст не очищен.'); return }
    // До clear остаётся сохранённая запись для восстановления после сбоя.
    await $.command.run({ command: 'clear' })
    const previousId = sessionId
    sessionId = await $.session.id()
    if (sessionId !== previousId) await $.store.delete('s:' + previousId)
    pending = null
    await update($, askAt, () => threshold)
    await save($)
    // prompt.submit ждёт простоя. Этот метод вызывается из отложенного callback, не из turn.complete.
    await $.prompt.submit({ text: 'Прочитай документ ' + JSON.stringify(p.path) +
      ' и продолжай задачу. Сначала проверь текущее состояние файлов; сводка может не содержать всех деталей.' })
  } catch {
    // Документ не удаляем: даже после clear пользователь может прочитать его снова.
    pending = p
    await save($).catch(() => undefined)
    $.ui.toast('Автоматическое продолжение не удалось. Документ: ' + p.path + '. Команда восстановления: /handoff-resume.')
  } finally { transitioning = false }
}
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    interactive = e.isInteractive === true
    sessionId = await $.session.id()
    const configured = await $.store.get('threshold')
    threshold = configured === 1000 || typeof configured === 'number' && configured >= 30 && configured <= 90 ? configured : 60
    const mark: any = await $.store.get('s:' + sessionId)
    if (mark?.pending?.transferId && typeof mark.pending.path === 'string') {
      pending = mark.pending
      armed = false
      $.ui.toast('Есть незавершённая передача. /handoff-status, /handoff-resume или /handoff-cancel.')
    }
    await update($, askAt, () => Number.isFinite(mark?.askAt) ? mark.askAt : threshold)
    for (const name of ['handoff-now','handoff-status','handoff-cancel','handoff-resume','handoff-threshold']) {
      await $.command.register({ name, description: 'Handoff: перенос, состояние, отмена, восстановление или порог 30–90/off.' })
    }
    return next(e)
  })
  on('command.run', { command: 'handoff-now' }, async $ => {
    if (pending || transitioning) return { text: 'Передача уже идёт. /handoff-status или /handoff-cancel.' }
    if (!interactive) return { text: 'Передача с очисткой доступна только в интерактивной сессии.' }
    $.clock.after(1, () => void start($).catch(() => undefined))
    return { text: 'Сначала сохраняю документ. Контекст будет очищен только после проверки полной записи.' }
  })
  on('command.run', { command: 'handoff-status' }, async $ => ({
    text: pending ? 'Документ: ' + pending.path + (await written($, pending) ? ' — записан полностью.' : ' — ещё не готов.') : 'Передача не запущена.',
  }))
  on('command.run', { command: 'handoff-cancel' }, async $ => {
    if (transitioning) return { text: 'Переключение уже началось; документ останется сохранённым.' }
    await cancel($, 'Передача отменена. Контекст не очищен.')
    return { text: 'Отменено. Запись документа, если она уже началась, может завершиться без очистки чата.' }
  })
  on('command.run', { command: 'handoff-resume' }, async $ => {
    if (!interactive || !pending || transitioning || !await written($, pending)) return { text: 'Полного документа для восстановления нет или переключение уже идёт.' }
    const p = pending
    $.clock.after(1, () => void fresh($, p).catch(() => undefined))
    return { text: 'Продолжаю по проверенному документу.' }
  })
  on('command.run', { command: 'handoff-threshold' }, async ($, e) => {
    const arg = String(e.args ?? '').trim()
    const n = arg === 'off' ? 1000 : Number(arg)
    if (!arg || !Number.isFinite(n) || n < 30 || n > 90 && arg !== 'off') return { text: 'Укажи процент 30–90 или off. Например /handoff-threshold 70.' }
    threshold = n
    await $.store.set('threshold', n)
    await update($, askAt, () => n)
    await save($)
    return { text: n === 1000 ? 'Автоматическое предложение выключено.' : 'Предложение передачи при ' + n + '% контекста.' }
  })
  on('turn.start', async ($, e, next) => {
    if (pending && !pending.writeTurnId && String(e.text ?? '').includes(pending.path)) {
      pending = { ...pending, writeTurnId: e.turnId }; await save($)
    }
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    const p = pending
    if (p && !e.agentId && p.writeTurnId === e.turnId) {
      if (e.isAborted || !await written($, p)) await cancel($, 'Документ не завершён. Контекст не очищен.')
      else $.clock.after(1, () => void fresh($, p).catch(() => undefined))
    }
    return next(e)
  })
  on('session.measure', async ($, e, next) => {
    const ctx = e.context?.percent
    if (typeof ctx !== 'number' || !Number.isFinite(ctx)) return next(e)
    const at = await read($, askAt)
    if (ctx < at && !pending) armed = true
    if (interactive && threshold <= 90 && ctx >= at && armed && !pending && !asking && !transitioning) {
      asking = true
      $.clock.after(1, () => void (async () => {
        try {
          if ((await $.session.surfaces()).length === 0) return
          const answer = await $.ui.ask('Контекст ' + Math.round(ctx) + '%. Сохранить задачу и продолжить в чистом чате?', {
            header: 'Handoff', options: ['Передать', 'Не сейчас'],
          })
          if (answer === 'Передать') await start($)
          else { await update($, askAt, () => Math.min(100, Math.round(ctx) + 10)); await save($) }
        } finally { asking = false }
      })().catch(() => undefined))
    }
    return next(e)
  })
}
