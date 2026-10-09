export type Risk = { reason: string; targets: string[]; uncertain: boolean }
type Token = { text: string; op: boolean; quoted: boolean; expands?: boolean }
export function lex(source: string): Token[] {
  const out: Token[] = []
  let text = '', active = false, quoted = false, quote = '', expands = false
  const push = () => { if (active) out.push({ text, op: false, quoted, expands }); text = ''; active = false; quoted = false; expands = false }
  for (let i = 0; i < source.length; i++) {
    const c = source[i]!
    if (quote) {
      if (c === quote) { quote = ''; continue }
      if (c === '\\' && quote === '"' && /["\\$\x60]/.test(source[i + 1] ?? '')) { text += source[++i]; continue }
      if (quote !== "'" && (c === '$' || c.charCodeAt(0) === 96)) expands = true
      text += c; continue
    }
    if (c === '"' || c === "'") { quote = c; quoted = true; active = true; continue }
    if (c === '\\' && i + 1 < source.length) { text += source[++i]; active = true; continue }
    if (c === '#' && !active) { while (i < source.length && source[i] !== '\n') i++; push(); out.push({ text: ';', op: true, quoted: false }); continue }
    if (/[\s]/.test(c)) { push(); if (c === '\n') out.push({ text: ';', op: true, quoted: false }); continue }
    if (';&|()'.includes(c)) { push(); out.push({ text: c, op: true, quoted: false }); continue }
    if (c === '$' || c.charCodeAt(0) === 96) expands = true
    text += c; active = true
  }
  push()
  if (quote) out.push({ text: '[unclosed-quote]', op: false, quoted: false })
  return out
}
const base = (s: string) => s.replace(/\\/g, '/').split('/').pop()!.toLowerCase().replace(/\.exe$/, '')
export function analyze(source: string, depth = 0): Risk | null {
  if (depth > 4) return { reason: 'слишком вложенная команда: проверь вручную', targets: [], uncertain: true }
  const groups: Token[][] = [[]]
  for (const t of lex(source)) { if (t.op) groups.push([]); else groups[groups.length - 1]!.push(t) }
  for (const group of groups) {
    let args = group.map(t => t.text)
    while (args.length) {
      if (/^[A-Za-z_]\w*=/.test(args[0]!)) { args.shift(); continue }
      const wrapper = base(args[0]!)
      if (!['sudo', 'command', 'builtin', 'env', 'nohup'].includes(wrapper)) break
      args.shift()
      while (args[0]?.startsWith('-')) {
        const option = args.shift()!
        if ((wrapper === 'sudo' && ['-u','-g','-h','-p','-C','-T','-R','-D','--user','--group','--host','--prompt','--chdir'].includes(option)) ||
            (wrapper === 'env' && ['-u','--unset','-C','--chdir'].includes(option))) args.shift()
      }
    }
    if (base(args[0] ?? '') === 'busybox') args.shift()
    const name = base(args[0] ?? '')
    if (['bash','sh','zsh','dash','pwsh','powershell','cmd'].includes(name)) {
      const at = args.findIndex(a => ['-c','-command','/c'].includes(a.toLowerCase()))
      if (at >= 0) { const nested = analyze(args.slice(at + 1).join(' '), depth + 1); if (nested) return nested }
    }
    if (name === 'rm' || name === 'unlink') {
      let options = true
      const targets = args.slice(1).filter(a => { if (options && a === '--') { options = false; return false }; return !options || !a.startsWith('-') })
      return { reason: 'удалить файлы или папки', targets: targets.slice(0, 20), uncertain: targets.some(p => /[$*?\x60]/.test(p)) || targets.length === 0 }
    }
    if (name === 'git') {
      if (args.includes('push') && args.some(a => /^-[a-z]*f[a-z]*$/i.test(a) || /^--force(?:=|-|$)/.test(a))) return { reason: 'перезаписать историю на сервере', targets: [], uncertain: false }
      if (args.includes('reset') && args.includes('--hard')) return { reason: 'стереть незакоммиченные правки', targets: [], uncertain: false }
      if (args.includes('clean') && args.some(a => /^-[a-z]*f/.test(a) || a === '--force')) return { reason: 'удалить неотслеживаемые файлы', targets: [], uncertain: false }
      if (args.includes('restore') && (args.includes('--worktree') || args.includes('.'))) return { reason: 'отменить изменения файлов', targets: [], uncertain: false }
    }
    if (name === 'find' && (args.includes('-delete') || args.includes('-exec') && args.some(a => base(a) === 'rm'))) return { reason: 'удалить найденные файлы', targets: [], uncertain: true }
    if (['remove-item','ri','del','erase','rmdir','rd'].includes(name)) return { reason: 'удалить файлы или папки', targets: [], uncertain: true }
    if (['psql','mysql','mariadb','sqlite3','sqlcmd'].includes(name) && /\b(?:drop\s+(?:table|database|schema)|truncate\s+(?:table\s+)?\w+)\b/i.test(args.slice(1).join(' '))) {
      return { reason: 'удалить данные из базы', targets: [], uncertain: true }
    }
    for (const t of group) {
      if (!t.expands) continue
      const sub = /\$\(([\s\S]*?)\)|\x60([^\x60]+)\x60/g
      for (const m of t.text.matchAll(sub)) {
        const risk = analyze(m[1] ?? m[2]!, depth + 1)
        if (risk) return { ...risk, targets: [], uncertain: true }
      }
    }
  }
  return null
}
export function literalPath(path: string, home: string, cwd: string): string | null {
  if (!path || /[$*?\x60\x00\r\n]/.test(path)) return null
  if ((path === '~' || path.startsWith('~/')) && !home) return null
  const p = path === '~' || path.startsWith('~/') ? home + path.slice(1) : path
  return /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(p) ? p : cwd.replace(/[\\/]$/, '') + '/' + p
}
