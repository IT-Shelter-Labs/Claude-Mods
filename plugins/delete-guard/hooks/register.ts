import type { Register } from 'claude-code'
import { analyze, literalPath } from './analyze'
let interactive = false
let asking = false
export const register: Register = on => {
  on('session.start', async ($, e, next) => { interactive = e.isInteractive === true; return next(e) })
  on('tool.call', async ($, e, next) => {
    if (!['Bash', 'PowerShell', 'powershell', 'Cmd'].includes(e.tool)) return next(e)
    const command = String(e.command ?? '')
    const risk = analyze(command)
    if (!risk) return next(e)
    if (!interactive || asking || (await $.session.surfaces()).length === 0) {
      return { deny: 'Delete Guard: опасная команда требует ручного подтверждения в интерактивной сессии.' }
    }
    asking = true
    try {
      const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
      const cwd = await $.session.cwd()
      const preview: string[] = []
      for (const target of risk.targets.slice(0, 8)) {
        const path = literalPath(target, home, cwd)
        if (!path) { preview.push(target + ' — вычисляемый путь, проверь вручную'); continue }
        try {
          const stat = await $.fs.stat(path)
          preview.push(target + (typeof stat?.size === 'number' ? ' — метаданные: ' + stat.size + ' байт' : ''))
        } catch { preview.push(target + ' — недоступен для проверки') }
      }
      const answer = await $.ui.ask('Claude хочет ' + risk.reason + '.\n' + command.slice(0, 1200) +
        (preview.length ? '\nПути (без рекурсивного подсчёта):\n' + preview.join('\n') : '') +
        (risk.uncertain ? '\nТочные последствия автоматически не определены.' : '') + '\nВыполнить?', {
        header: 'Delete Guard', options: ['Отменить', 'Выполнить'],
      })
      return answer === 'Выполнить' ? next(e) : { deny: 'Delete Guard: пользователь отменил действие. Не повторяй его без нового запроса.' }
    } catch {
      return { deny: 'Delete Guard: подтверждение не получено, действие отменено.' }
    } finally { asking = false }
  })
}
