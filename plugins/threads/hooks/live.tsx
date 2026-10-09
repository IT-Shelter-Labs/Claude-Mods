import type { ClientModule } from 'claude-code'

// Невидимый слой поверх карточки потока, который рисует само приложение: клик в любом месте карточки
// открывает поток ({ open: имя }). Как в session-hub: рисуется один раз, ни таймеров, ни своего состояния —
// модули мода делят одну среду приложения, и зависшая среда выгружает их все
export type LiveProps = { part: 'hit'; id: string }

// Нажатые, но ещё не отпущенные слои — общий для всех экземпляров список, без setState
const pressed = new Set<string>()

const Live: ClientModule<LiveProps> = (p, s) => {
  const { Box } = s.elements
  const id = p.id
  s.onPointer(e => {
    if (e.type === 'down' && e.button === 'left') pressed.add(id)
    else if (e.type === 'leave') pressed.delete(id)
    else if (e.type === 'up' && pressed.has(id)) {
      pressed.delete(id)
      if (e.x >= 0 && e.y >= 0 && e.x < s.columns && e.y < s.rows) s.post({ open: id })
    }
  })
  return <Box />
}

export default Live
