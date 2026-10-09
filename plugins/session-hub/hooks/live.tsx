import type { ClientModule } from 'claude-code'

// Прозрачный слой поверх карточки диалога: нажатие кнопки мыши в любом её месте открывает диалог
// ({ open: id }). Ничего не рисует и не перерисовывается: ни таймеров, ни своего состояния. Модули мода
// живут в одной общей среде приложения, и если она не отвечает дольше 2 с, приложение выгружает их все
export type LiveProps = { part: 'hit'; id: string }

const Live: ClientModule<LiveProps> = (p, s) => {
  const { Box } = s.elements
  // Открываем по нажатию, а не по отпусканию: между ними панель может перерисоваться, забирая
  // клавиатуру, и отпускание тогда не доходит
  s.onPointer(e => {
    if (e.type === 'down' && e.button === 'left') s.post({ open: p.id })
  })
  return <Box />
}

export default Live
