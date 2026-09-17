import { useLayoutEffect, useRef } from 'react'
import type { DeletedTurnData } from './turn-deletion.ts'

interface HiddenRow {
  readonly element: HTMLElement
  readonly hidden: boolean
}

let ownerSequence = 0

function turnRows(marker: HTMLElement): HTMLElement[] {
  const tail = marker.closest<HTMLElement>('[data-turn-tail]')
  const tailRow = tail?.closest<HTMLElement>('[data-chat-flow-kind="turn-tail"]')
  if (tailRow === undefined || tailRow === null) return []
  const rows = [tailRow]
  let cursor = tailRow.previousElementSibling
  while (cursor instanceof HTMLElement) {
    if (cursor.querySelector('[data-turn-tail]') !== null) break
    rows.push(cursor)
    cursor = cursor.previousElementSibling
  }
  return rows
}

export function concealDeletedTurn(marker: HTMLElement, turn: number): () => void {
  const owner = `${String(turn)}-${String(++ownerSequence)}`
  const changed: HiddenRow[] = []
  for (const element of turnRows(marker)) {
    changed.push({ element, hidden: element.hidden })
    element.dataset.dshTurnDeleteOwner = owner
    element.hidden = true
  }
  return () => {
    for (const entry of changed) {
      if (entry.element.dataset.dshTurnDeleteOwner !== owner) continue
      delete entry.element.dataset.dshTurnDeleteOwner
      entry.element.hidden = entry.hidden
    }
  }
}

/**
 * Conceal the deletion target immediately, from the delete action itself.
 *
 * The durable tombstone reaches the Conversation engine and publishes its
 * turn-delete Location data, but the chat's turn-tail row is memoized on its own
 * view node: a live append that produces no new node never re-renders that row,
 * so the chain slot rendering {@link DeletedTurnMarker} stays stale until the
 * next full render (a Session switch performs one). The action button renders
 * inside that very row, so the action can apply the same concealment at once;
 * whenever the row is rendered again the durable marker re-applies it from the
 * tombstone.
 *
 * @param anchor - the action's own element (any node inside the target turn).
 */
export function concealTurnFromAction(anchor: HTMLElement | null): void {
  if (anchor === null) return
  const marker = anchor.closest<HTMLElement>('[data-turn-tail]')
  if (marker === null) return
  const turn = Number(marker.getAttribute('data-turn-tail'))
  concealDeletedTurn(marker, Number.isFinite(turn) ? turn : 0)
}

export function DeletedTurnMarker({ matched }: { matched: DeletedTurnData }) {
  const markerRef = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const marker = markerRef.current
    if (marker === null) return
    const tailRow = marker.closest<HTMLElement>('[data-chat-flow-kind="turn-tail"]')
    const list = tailRow?.parentElement
    if (list === undefined || list === null) return
    let restore = concealDeletedTurn(marker, matched.turn)
    const observer = new MutationObserver(() => {
      restore()
      restore = concealDeletedTurn(marker, matched.turn)
    })
    observer.observe(list, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      restore()
    }
  }, [matched.turn])
  return <span ref={markerRef} data-dsh-deleted-turn={matched.turn} hidden />
}
