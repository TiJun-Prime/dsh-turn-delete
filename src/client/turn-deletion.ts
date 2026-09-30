import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { SYSTEM_PROMPT_SOURCE_KIND, TOMBSTONE_MODEL, TOMBSTONE_PLUGIN, TOMBSTONE_PROVIDER } from '../shared.ts'

export interface DeletedTurnData {
  readonly hidden: true
  readonly turn: number
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    'turn-delete': DeletedTurnData
  }
}

interface TombstoneLikeEvent {
  readonly type: string
  readonly surfaceOp?: unknown
  readonly data?: {
    readonly turn?: number
    readonly message?: {
      readonly content?: readonly unknown[]
      readonly source?: {
        readonly kind?: string
        readonly plugin?: string
        readonly provider?: string
        readonly model?: string
      }
    }
  }
}

/**
 * Read the deleted turn from a deletion tombstone, or `undefined` for any other
 * event.
 *
 * Three generations exist: format v4 (DSH 0.2.x) forces `system-prompt` on every
 * system message, so there an empty system replacement *is* the tombstone; format
 * v3 (DSH 0.1.5+) writes an empty `system/message` with our identity in
 * `source.plugin`; older logs hold an empty `assistant/message` replacement with
 * model/provider identity. All must stay hidden, so all are recognized.
 */
function deletedTurn(event: TombstoneLikeEvent): number | undefined {
  if (event.type !== 'system/message' && event.type !== 'assistant/message') return undefined
  if (typeof event.surfaceOp !== 'object' || event.surfaceOp === null) return undefined
  const message = event.data?.message
  if (message === undefined || (message.content?.length ?? 0) !== 0) return undefined
  const source = message.source
  if (source === undefined) return undefined
  const tombstone = event.type === 'system/message'
    ? source.kind === SYSTEM_PROMPT_SOURCE_KIND
      || (source.kind === 'plugin' && source.plugin === TOMBSTONE_PLUGIN)
    : source.provider === TOMBSTONE_PROVIDER && source.model === TOMBSTONE_MODEL
  if (!tombstone) return undefined
  return typeof event.data?.turn === 'number' ? event.data.turn : undefined
}

interface DeletedTurnState {
  readonly turn: number
}

export const turnDeletionDefinition: ConversationNodeDefinition<DeletedTurnState> = {
  kind: 'turn-delete',
  match: (event) => {
    const turn = deletedTurn(event as unknown as TombstoneLikeEvent)
    return turn === undefined ? null : { id: String(turn), role: 'start' }
  },
  start: (_context, match) => {
    const turn = deletedTurn(match.event as unknown as TombstoneLikeEvent)
    if (turn === undefined) throw new Error('turn-delete start requires a deletion tombstone')
    return { turn }
  },
  update: context => context.state,
  publication: () => 'immediate',
  buildLocationData: (context, scope) => {
    if (scope !== 'turn' || context.state === undefined) return null
    return {
      kind: 'turn',
      turn: context.state.turn,
      key: 'turn-delete',
      value: { hidden: true, turn: context.state.turn },
    }
  },
}

/** Structural owner face of the turn-tail chain slot (the plugin only reads the turn). */
export interface TurnTailOwner {
  readonly turn: {
    readonly data: {
      get(key: 'turn-delete'): DeletedTurnData | undefined
    }
  }
}

export function selectDeletedTurn(owner: TurnTailOwner): DeletedTurnData | null {
  const data = owner.turn.data.get('turn-delete')
  return data?.hidden === true ? data : null
}
