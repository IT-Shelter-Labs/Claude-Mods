export function validSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}
export function reportMatches(origin: any, text: string, token: unknown): boolean {
  // API сообщает класс доставки, но не ID отправителя. Токен связывает отчёт с конкретным запуском.
  return ['peer','peer-send-message'].includes(origin?.kind) && validSessionId(token) && text.includes('[report:' + token + ']')
}
