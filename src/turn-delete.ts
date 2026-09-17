import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createSystemMessage, type MessageId } from '@deepseek-ai/dsh-llm'
import { SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { isAppendSurfaceEvent, isReplacementSurfaceEvent } from '@deepseek-ai/dsh-session/surface'
import { TOMBSTONE_MODEL, TOMBSTONE_PLUGIN, TOMBSTONE_PROVIDER } from './shared.ts'

export { TOMBSTONE_MODEL, TOMBSTONE_PLUGIN, TOMBSTONE_PROVIDER } from './shared.ts'

export type TurnDeleteErrorCode =
  | 'TARGET_NOT_FOUND'
  | 'TURN_NOT_CLOSED'
  | 'TURN_COMPACTED'
  | 'AGENT_BUSY'
  | 'DELETE_FAILED'

export interface TurnDeleteReceipt {
  readonly turn: number
  readonly seq: number
}

export class TurnDeleteError extends Error {
  override readonly name = 'TurnDeleteError'

  constructor(readonly code: TurnDeleteErrorCode, message: string) {
    super(message)
  }
}

/** The message-producing event types a deletion tombstone may live on. */
type TombstoneEventType = 'system/message' | 'assistant/message'

type TombstoneEvent = SessionEvent<TombstoneEventType> & {
  surfaceOp: { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }
}

/**
 * Whether one event is a turn-deletion tombstone written by this plugin.
 *
 * Current kernels write a `system/message` replacement: it is the only surface
 * event type that both cites `sourceEventSeqs` (required to shadow a range) and
 * projects to no wire message (empty system content is dormant). DSH 0.1.5
 * forbids `sourceEventSeqs` on `assistant/message`, so the older tombstone shape
 * is read-only replay compatibility: recognizing it keeps old deletions
 * idempotent and keeps them hidden in the browser.
 */
export function isTurnDeleteEvent(event: SessionEvent): event is TombstoneEvent {
  if (event.type !== 'system/message' && event.type !== 'assistant/message') return false
  if (!isReplacementSurfaceEvent(event)) return false
  const message = event.data.message
  if (message.content.length !== 0) return false
  const source = message.source
  if (event.type === 'system/message') {
    return source.kind === 'plugin' && source.plugin === TOMBSTONE_PLUGIN
  }
  return source.kind === 'model'
    && source.provider === TOMBSTONE_PROVIDER
    && source.model === TOMBSTONE_MODEL
}

function eventTurn(event: SessionEvent): number | undefined {
  if (event.type === 'assistant/message' || event.type === 'tool/result') return event.data.turn
  return undefined
}

/**
 * Read a Session's event array.
 *
 * DSH 0.1.2-alpha.1 removed the `Session.events` property; the public API is
 * `snapshotEvents()` (plus `ownEvents()` / `eventAt(seq)`). Reading through
 * this helper keeps one build readable on both kernels.
 */
function sessionEvents(session: {
  snapshotEvents?: () => readonly SessionEvent[]
  events?: readonly SessionEvent[]
}): readonly SessionEvent[] {
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  return session.events ?? []
}

function turnBracket(
  events: readonly SessionEvent[],
  turn: number,
  targetSeq: SessionSeq,
): { start: number; end: number } | undefined {
  const start = events.findLast(event =>
    event.seq <= targetSeq && event.type === 'turn/start' && event.data.turn === turn)
  const end = events.find(event =>
    event.seq >= targetSeq && event.type === 'turn/end' && event.data.turn === turn)
  return start === undefined || end === undefined ? undefined : { start: start.seq, end: end.seq }
}

function originBelongsToTurn(
  event: SessionEvent,
  turn: number,
  bracket: { start: number; end: number },
): boolean {
  return (event.seq > bracket.start && event.seq < bracket.end) || eventTurn(event) === turn
}

/**
 * Whether one event carries the Session's system-prompt state rather than turn
 * content.
 *
 * The kernel appends the system prompt lazily, so the first turn's bracket can
 * contain surface node 0. Node 0 is protected: a replacement spanning it is
 * rejected unless it is a single-node `system/message` replacement, and the
 * prompt is infrastructure the Session must keep. Excluding system nodes from
 * the turn's origin set keeps the prompt out of the replaced span while the
 * remaining turn nodes stay contiguous.
 */
function isSystemPromptEvent(event: SessionEvent): boolean {
  return event.type === 'system/message'
}

function surfaceOrigins(
  seq: number,
  events: readonly SessionEvent[],
  memo: Map<number, ReadonlySet<number>>,
  visiting = new Set<number>(),
): ReadonlySet<number> {
  const cached = memo.get(seq)
  if (cached !== undefined) return cached
  if (visiting.has(seq)) return new Set()
  visiting.add(seq)
  const event = events[seq]
  const origins = new Set<number>()
  if (event !== undefined) {
    if (isAppendSurfaceEvent(event)) origins.add(seq)
    const sources = (event as SessionEvent & { sourceEventSeqs?: readonly number[] }).sourceEventSeqs ?? []
    for (const source of sources) {
      for (const origin of surfaceOrigins(source, events, memo, visiting)) origins.add(origin)
    }
  }
  visiting.delete(seq)
  memo.set(seq, origins)
  return origins
}

async function deleteUnderMaintenance(
  ctx: Context,
  agent: Agent,
  assistantMessageId: MessageId,
  signal: AbortSignal,
): Promise<TurnDeleteReceipt> {
  signal.throwIfAborted()
  const session = agent.session
  if (ctx.sessions.get(session.id) !== session) {
    throw new TurnDeleteError('TARGET_NOT_FOUND', `session "${session.id}" is no longer live`)
  }
  const events = sessionEvents(session)
  const target = events.find((event): event is SessionEvent<'assistant/message'> =>
    event.type === 'assistant/message'
    && isAppendSurfaceEvent(event)
    && event.data.message.id === assistantMessageId)
  if (target === undefined) {
    throw new TurnDeleteError('TARGET_NOT_FOUND', `assistant message "${assistantMessageId}" was not found`)
  }
  const turn = target.data.turn
  const existing = events.find(event => isTurnDeleteEvent(event) && event.data.turn === turn)
  if (existing !== undefined) return { turn, seq: existing.seq }

  const bracket = turnBracket(events, turn, target.seq)
  if (bracket === undefined) {
    throw new TurnDeleteError('TURN_NOT_CLOSED', `turn ${String(turn)} is not closed`)
  }

  const originSeqs = new Set<number>(events
    .filter(event => !isSystemPromptEvent(event)
      && isAppendSurfaceEvent(event)
      && originBelongsToTurn(event, turn, bracket))
    .map(event => event.seq))
  const currentNodes = session.surface.nodes
  if (!currentNodes.includes(target.seq)) {
    throw new TurnDeleteError('TURN_COMPACTED', `turn ${String(turn)} is no longer independently deletable`)
  }

  const memo = new Map<number, ReadonlySet<number>>()
  const selected: SessionSeq[] = []
  const covered = new Set<number>()
  for (const seq of currentNodes) {
    const origins = surfaceOrigins(seq, events, memo)
    const targetOrigins = [...origins].filter(origin => originSeqs.has(origin))
    if (targetOrigins.length === 0) continue
    if ([...origins].some(origin => !originSeqs.has(origin))) {
      throw new TurnDeleteError('TURN_COMPACTED', `turn ${String(turn)} shares a compacted surface node`)
    }
    const current = events[seq]
    if (current !== undefined && !originSeqs.has(seq)
      && !(current.type === 'tool/result' && current.data.turn === turn)) {
      throw new TurnDeleteError('TURN_COMPACTED', `turn ${String(turn)} contains a non-local replacement`)
    }
    selected.push(seq)
    for (const origin of targetOrigins) covered.add(origin)
  }
  if ([...originSeqs].some(origin => !covered.has(origin)) || selected.length === 0) {
    throw new TurnDeleteError('TURN_COMPACTED', `turn ${String(turn)} is partially compacted`)
  }
  const positions = selected.map(seq => currentNodes.indexOf(seq))
  const first = positions[0]
  if (first === undefined || positions.some((position, index) => position !== first + index)) {
    throw new TurnDeleteError('TURN_COMPACTED', `turn ${String(turn)} is not a contiguous surface span`)
  }
  const firstSeq = selected[0]
  const lastSeq = selected.at(-1)
  if (firstSeq === undefined || lastSeq === undefined) {
    throw new TurnDeleteError('TURN_COMPACTED', `turn ${String(turn)} has no deletable surface span`)
  }

  signal.throwIfAborted()
  // DSH 0.1.5+ requires `startSeq`/`endSeq` and forbids `sourceEventSeqs` on
  // `assistant/message`; an empty `system/message` is the only carrier that both
  // cites its sources and projects to no wire message.
  const tombstone = session.append('system/message', {
    turn,
    step: target.data.step,
    message: createSystemMessage('', TOMBSTONE_PLUGIN),
  }, {
    surfaceOp: { op: 'replace', startSeq: firstSeq, endSeq: lastSeq },
    sourceEventSeqs: selected,
  })
  await ctx.sessions.flush(session)
  return { turn, seq: tombstone.seq }
}

/**
 * Whether the session still has a turn that has not ended yet.
 *
 * Used to tell "the agent is really working" apart from "the agent status is
 * stuck outside `idle` while the durable events show the turn already closed".
 */
function hasOpenTurn(session: {
  snapshotEvents?: () => readonly SessionEvent[]
  events?: readonly SessionEvent[]
}): boolean {
  const open = new Set<number>()
  for (const event of sessionEvents(session)) {
    if (event.type === 'turn/start') open.add(event.data.turn)
    else if (event.type === 'turn/end') open.delete(event.data.turn)
  }
  return open.size > 0
}

const BUSY_PHASE_RE = /already has active work/i

/**
 * Run one maintenance job, tolerating a status that has not returned to idle yet.
 *
 * `agent.runMaintenance` rejects synchronously while the agent phase is anything
 * but `idle` (`agent "<id>" already has active work`), which can outlive the turn
 * the UI already shows as finished. Wait briefly for idle and retry once; a
 * genuinely stuck phase is handled by the caller's fallback.
 *
 * Failures raised *inside* the job are never retried: only the maintenance claim
 * itself can report a busy phase.
 */
async function runMaintenanceIdleAware<T>(
  agent: Agent,
  job: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  let insideJob = false
  const wrapped = (signal: AbortSignal): Promise<T> => {
    insideJob = true
    return job(signal)
  }
  try {
    return await agent.runMaintenance(wrapped)
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    if (insideJob || !BUSY_PHASE_RE.test(message)) throw error
    await Promise.race([
      Promise.resolve().then(() => agent.whenIdle()).catch(() => {}),
      new Promise(resolve => setTimeout(resolve, 4000)),
    ])
    return await agent.runMaintenance(wrapped)
  }
}

export async function deleteTurn(
  ctx: Context,
  agent: Agent,
  assistantMessageId: MessageId,
): Promise<TurnDeleteReceipt> {
  try {
    try {
      return await runMaintenanceIdleAware(agent, signal =>
        deleteUnderMaintenance(ctx, agent, assistantMessageId, signal))
    } catch (error: unknown) {
      if (error instanceof TurnDeleteError) throw error
      const message = error instanceof Error ? error.message : String(error)
      if (!BUSY_PHASE_RE.test(message)) throw error
      if (hasOpenTurn(agent.session)) throw new TurnDeleteError('AGENT_BUSY', message)
      // Stuck-phase fallback: the agent claims active work, but the durable events
      // hold no open turn — the deletion is safe to perform directly.
      ctx.logger?.warn?.(
        `turn-delete: agent "${agent.id}" status is ${agent.status} `
        + 'but no turn is open; deleting directly')
    }
    return await deleteUnderMaintenance(ctx, agent, assistantMessageId,
      new AbortController().signal)
  } catch (error: unknown) {
    if (error instanceof TurnDeleteError) throw error
    // Everything else is an internal failure (kernel/plugin incompatibility,
    // invalid stored metadata, …). It must never surface as "the task is
    // running": that wording sent every real failure to the wrong diagnosis.
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger?.error?.(`turn-delete: deleting a turn from session "${agent.session.id}" failed: ${message}`)
    throw new TurnDeleteError('DELETE_FAILED', message)
  }
}
