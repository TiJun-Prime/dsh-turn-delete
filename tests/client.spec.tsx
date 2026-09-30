// @vitest-environment jsdom

import { useSyncExternalStore } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createSystemMessage, MessageId } from '@deepseek-ai/dsh-llm'
import { concealDeletedTurn, concealTurnFromAction } from '../src/client/DeletedTurnMarker.tsx'
import { FallbackTrashIcon, resolveTrashIcon, TrashIcon } from '../src/client/trash-icon.tsx'
import { TurnDeleteAction, type DeleteTurnResponse } from '../src/client/TurnDeleteAction.tsx'
import { zh } from '../src/client/locales.ts'
import { selectDeletedTurn, turnDeletionDefinition } from '../src/client/turn-deletion.ts'
import { apply } from '../src/client/index.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const React = await import('react')
  return {
    Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
      React.createElement('button', props, children),
    IconTrashOutlineRegular: () => React.createElement('span', null, 'trash'),
    Tooltip: ({ children }: { children: React.ReactNode }) => children,
    Modal: ({ open, title, description, footer, children }: {
      open: boolean
      title: string
      description: string
      footer: React.ReactNode
      children: React.ReactNode
    }) => open ? React.createElement('div', { role: 'dialog' },
      React.createElement('h2', null, title),
      React.createElement('p', null, description),
      children,
      footer) : null,
  }
})

afterEach(cleanup)

function flow(kind: string, child?: HTMLElement): HTMLElement {
  const row = document.createElement('div')
  row.dataset.chatFlowKind = kind
  if (child !== undefined) row.append(child)
  return row
}

function tail(turn: number, marker?: HTMLElement): HTMLElement {
  const root = document.createElement('div')
  root.dataset.turnTail = String(turn)
  if (marker !== undefined) root.append(marker)
  return flow('turn-tail', root)
}

describe('deleted turn presentation', () => {
  it('hides only the rows between adjacent turn tails and restores them on disposal', () => {
    const list = document.createElement('div')
    const firstUser = flow('user')
    const firstAssistant = flow('assistant-step')
    const firstTail = tail(1)
    const secondUser = flow('user')
    const secondTool = flow('tool-call')
    const secondAssistant = flow('assistant-step')
    const marker = document.createElement('span')
    const secondTail = tail(2, marker)
    const thirdUser = flow('user')
    list.append(firstUser, firstAssistant, firstTail, secondUser, secondTool, secondAssistant, secondTail, thirdUser)

    const restore = concealDeletedTurn(marker, 2)

    expect([firstUser, firstAssistant, firstTail, thirdUser].every(row => !row.hidden)).toBe(true)
    expect([secondUser, secondTool, secondAssistant, secondTail].every(row => row.hidden)).toBe(true)
    restore()
    expect([...list.children].every(row => !(row as HTMLElement).hidden)).toBe(true)
  })

  it('conceals the deleted turn immediately from the action inside its tail row', () => {
    const list = document.createElement('div')
    const firstUser = flow('user')
    const firstTail = tail(1)
    const secondUser = flow('user')
    const secondAssistant = flow('assistant-step')
    const marker = document.createElement('span')
    marker.dataset.turnTail = '2'
    const button = document.createElement('button')
    marker.append(button)
    const secondTail = tail(2, marker)
    list.append(firstUser, firstTail, secondUser, secondAssistant, secondTail)

    concealTurnFromAction(button)

    expect([secondUser, secondAssistant, secondTail].every(row => row.hidden)).toBe(true)
    expect([firstUser, firstTail].every(row => !row.hidden)).toBe(true)

    expect(() => { concealTurnFromAction(null) }).not.toThrow()
    expect(() => { concealTurnFromAction(document.createElement('i')) }).not.toThrow()
  })

  it('recognizes the plugin tombstone in both generations', () => {
    const ordinary = {
      type: 'assistant/message', seq: 1, time: 1, surfaceOp: 'append',
      data: { turn: 1, step: 1, message: createAssistantMessage({
        content: [], source: { provider: 'test', model: 'test' },
      }) },
    } as unknown as Parameters<typeof turnDeletionDefinition.match>[0]
    expect(turnDeletionDefinition.match(ordinary)).toBeNull()

    const tombstone = {
      type: 'system/message', seq: 2, time: 2,
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
      sourceEventSeqs: [1],
      data: { turn: 1, step: 1, message: createSystemMessage('', 'dsh-turn-delete') },
    } as unknown as Parameters<typeof turnDeletionDefinition.match>[0]
    expect(turnDeletionDefinition.match(tombstone)).toEqual({ id: '1', role: 'start' })

    const legacyTombstone = {
      type: 'assistant/message', seq: 2, time: 2,
      surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 },
      data: { turn: 1, step: 1, message: createAssistantMessage({
        content: [], source: { provider: 'dsh-turn-delete', model: 'tombstone' },
      }) },
    } as unknown as Parameters<typeof turnDeletionDefinition.match>[0]
    expect(turnDeletionDefinition.match(legacyTombstone)).toEqual({ id: '1', role: 'start' })

    const systemPrompt = {
      type: 'system/message', seq: 0, time: 0, surfaceOp: 'append',
      data: { turn: 0, step: 0, message: createSystemMessage('you are helpful', 'system-prompt') },
    } as unknown as Parameters<typeof turnDeletionDefinition.match>[0]
    expect(turnDeletionDefinition.match(systemPrompt)).toBeNull()
  })
})

describe('client registration', () => {
  function registerAll() {
    const registrations: Array<{ name: string; id?: string; order?: number; select?: unknown }> = []
    const ctx = {
      effect: (body: () => void | (() => void)) => { body() },
      locale: { register: () => () => {} },
      uiConversation: { events: { register: () => () => {} } },
      slots: {
        register: (options: { name: string; id?: string; order?: number; select?: unknown }) => {
          registrations.push(options)
          return () => {}
        },
        inject: (_name: string, callback: () => () => void) => { callback(); return () => {} },
      },
    }
    apply(ctx as never)
    return registrations
  }

  // DSH 0.2.0-rc.1's slot core throws `list slot "<name>" requires options.id`
  // for a list seat registered without one. The throw fails the plugin's whole
  // `apply`, so the delete action silently disappears together with the tail.
  it('gives every list-slot registration the id DSH 0.2.0-rc.1 requires', () => {
    const list = registerAll().filter(entry =>
      entry.name === 'conversation.chat.assistant-actions' || entry.name === 'conversation.chat.turnTail')
    expect(list.map(entry => entry.name).sort()).toEqual([
      'conversation.chat.assistant-actions',
      'conversation.chat.turnTail',
    ])
    for (const entry of list) expect(typeof entry.id).toBe('string')
  })

  it('keeps selecting the deleted turn through the turn location data', () => {
    const entry = registerAll().find(row => row.name === 'conversation.chat.turnTail')
    expect(entry?.select).toBe(selectDeletedTurn)

    const deleted = { turn: { data: { get: () => ({ hidden: true as const, turn: 3 }) } } }
    expect(selectDeletedTurn(deleted as never)).toEqual({ hidden: true, turn: 3 })
    const live = { turn: { data: { get: () => undefined } } }
    expect(selectDeletedTurn(live as never)).toBeNull()
  })
})

const t = (key: keyof typeof zh): string => zh[key]

function mountAction(result: DeleteTurnResponse = { ok: true, value: { turn: 1, seq: 9 } }) {
  const snapshot = { running: false, subagent: null }
  const useSession = (<T,>(select: (value: typeof snapshot) => T): T =>
    useSyncExternalStore(() => () => {}, () => select(snapshot))) as never
  const deleteTurn = vi.fn(() => Promise.resolve(result))
  const props = {
    messageId: MessageId('assistant-1'),
    deleteTurn,
    useSession,
    t,
  } as unknown as Parameters<typeof TurnDeleteAction>[0]
  return { ...render(<TurnDeleteAction {...props} />), deleteTurn }
}

describe('TurnDeleteAction', () => {
  it('requires confirmation before deleting the addressed assistant turn', async () => {
    const ui = mountAction()
    fireEvent.click(screen.getByLabelText(zh['action.delete']))
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(ui.deleteTurn).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: zh['dialog.confirm'] }))
    await waitFor(() => { expect(ui.deleteTurn).toHaveBeenCalledWith(MessageId('assistant-1')) })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('keeps the dialog open for a compacted-turn refusal', async () => {
    mountAction({ ok: false, error: { code: 'TURN_COMPACTED', message: 'compacted' } })
    fireEvent.click(screen.getByLabelText(zh['action.delete']))
    fireEvent.click(screen.getByRole('button', { name: zh['dialog.confirm'] }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe(zh['error.compacted']) })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('shows an internal failure with its detail instead of the busy text', async () => {
    const detail = 'surface replace: start seq 7 not found in surface'
    mountAction({ ok: false, error: { code: 'DELETE_FAILED', message: detail } })
    fireEvent.click(screen.getByLabelText(zh['action.delete']))
    fireEvent.click(screen.getByRole('button', { name: zh['dialog.confirm'] }))
    await waitFor(() => {
      const alert = screen.getByRole('alert').textContent ?? ''
      expect(alert).toContain(zh['error.failed'])
      expect(alert).toContain(detail)
      expect(alert).not.toContain(zh['error.busy'])
    })
  })
})

describe('trash icon resolution', () => {
  it('prefers the 0.2.0-rc.1 stroke-variant names over the 0.1.x size suffix', () => {
    const regular = () => null
    const medium = () => null
    const legacy = () => null
    expect(resolveTrashIcon({ IconTrashOutlineRegular: regular, IconTrashOutline16: legacy })).toBe(regular)
    expect(resolveTrashIcon({ IconTrashOutlineMedium: medium })).toBe(medium)
    expect(resolveTrashIcon({ IconTrashOutline16: legacy })).toBe(legacy)
  })

  it('resolves nothing for a module without any known icon name', () => {
    expect(resolveTrashIcon({})).toBeNull()
    expect(resolveTrashIcon({ IconTrashOutline16: undefined })).toBeNull()
    expect(resolveTrashIcon(null)).toBeNull()
    expect(resolveTrashIcon(undefined)).toBeNull()
    expect(resolveTrashIcon('IconTrashOutline16')).toBeNull()
  })

  it('resolves the icon exported by this build and renders the fallback glyph', () => {
    expect(TrashIcon).not.toBeNull()
    render(<FallbackTrashIcon />)
    expect(document.querySelector('svg')).toBeTruthy()
  })
})
