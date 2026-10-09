export function percent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null
}
export function remaining(reset: unknown, now: number): string {
  const at = typeof reset === 'number' ? (reset < 1e12 ? reset * 1000 : reset) : Date.parse(String(reset ?? ''))
  if (!Number.isFinite(at)) return ''
  const min = Math.max(0, Math.ceil((at - now) / 60000))
  return min < 60 ? String(min) + 'м' : Math.floor(min / 60) + 'ч ' + min % 60 + 'м'
}
export function cells(p: number, count = 8): string {
  const full = Math.max(0, Math.min(count, Math.round((percent(p) ?? 0) * count / 100)))
  return '▪'.repeat(full) + '▫'.repeat(count - full)
}
