export function validDocument(text: string, transferId: string): boolean {
  return text.trim().length >= 200 &&
    text.includes('## Цель') && text.includes('## Что осталось') &&
    text.trim().endsWith('<!-- handoff-transfer:' + transferId + ':complete -->')
}
