import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
  MessageId,
} from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  deleteTurn,
  isTurnDeleteEvent,
  tombstoneSource,
  TurnDeleteError,
} from '../src/turn-delete.ts'

type TestSession = ReturnType<Context['sessions']['create']>

const BUSY_MESSAGE = 'agent "test" already has active work'

function idleAgent(session: TestSession, overrides: Partial<Agent> = {}): Agent {
  return {
    id: session.id,
    session,
    status: 'idle',
    options: {},
    ctx: new Context(),
    inbox: {} as Agent['inbox'],
    cancel: () => {},
    whenIdle: () => Promise.resolve(),
    runMaintenance: (task: (signal: AbortSignal) => Promise<unknown>) => task(new AbortController().signal),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => {},
    ...overrides,
  } as unknown as Agent
}

function appendTurn(
  session: TestSession,
  turn: number,
  question: string,
  answer: string,
) {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  const user = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: question }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const assistant = session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: answer }],
      source: { provider: 'test', model: 'test' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return { user, assistant }
}

function textBlocks(session: Session): string[] {
  return session.deriveMessages().flatMap(message => message.content)
    .filter(block => block.type === 'text').map(block => block.text)
}

describe('deleteTurn', () => {
  it('removes one middle turn from the model surface and survives replay', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('middle-turn'))
    appendTurn(session, 1, 'q1', 'a1')
    const middle = appendTurn(session, 2, 'q2-secret', 'a2-secret')
    appendTurn(session, 3, 'q3', 'a3')

    const receipt = await deleteTurn(ctx, idleAgent(session), middle.assistant.data.message.id)

    expect(receipt.turn).toBe(2)
    const tombstone = session.eventAt(SessionSeq(receipt.seq))
    expect(tombstone).toBeDefined()
    if (tombstone === undefined) throw new Error('missing turn deletion tombstone')
    expect(tombstone.type).toBe('system/message')
    expect(isTurnDeleteEvent(tombstone)).toBe(true)
    if (tombstone.type === 'system/message') {
      expect(tombstone.data.turn).toBe(2)
      expect(tombstone.data.message.content).toEqual([])
      expect(tombstone.surfaceOp).toMatchObject({ op: 'replace' })
    }
    expect(session.surface.nodes).not.toContain(middle.user.seq)
    expect(session.surface.nodes).not.toContain(middle.assistant.seq)
    expect(textBlocks(session)).toEqual(['q1', 'a1', 'q3', 'a3'])

    const replayed = Session.create(SessionId('middle-turn-replay'), structuredClone(session.snapshotEvents()))
    expect(textBlocks(replayed)).toEqual(['q1', 'a1', 'q3', 'a3'])
  })

  it('deletes a first turn whose bracket contains the protected system-prompt node', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('first-turn'))
    session.append('turn/start', { turn: 1 })
    const prompt = session.append('system/message', {
      turn: 1,
      step: 1,
      message: createSystemMessage('you are helpful', 'system-prompt'),
    }, { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'q1-secret' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const assistant = session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'a1-secret' }],
        source: { provider: 'test', model: 'test' },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    appendTurn(session, 2, 'q2', 'a2')

    const receipt = await deleteTurn(ctx, idleAgent(session), assistant.data.message.id)

    expect(receipt.turn).toBe(1)
    expect(session.surface.nodes[0]).toBe(prompt.seq)
    expect(textBlocks(session)).toEqual(['you are helpful', 'q2', 'a2'])
  })

  it('is idempotent for a stale retry', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('retry'))
    const target = appendTurn(session, 1, 'q', 'a')
    const agent = idleAgent(session)

    const first = await deleteTurn(ctx, agent, target.assistant.data.message.id)
    const second = await deleteTurn(ctx, agent, target.assistant.data.message.id)

    expect(second).toEqual(first)
    expect(session.snapshotEvents().filter(isTurnDeleteEvent)).toHaveLength(1)
  })

  it('refuses open, missing, and compacted targets', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)

    const open = ctx.sessions.create(SessionId('open'))
    open.append('turn/start', { turn: 1 })
    open.append('step/start', { turn: 1, step: 1 })
    const assistant = open.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'running' }],
        source: { provider: 'test', model: 'test' },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    await expect(deleteTurn(ctx, idleAgent(open), assistant.data.message.id))
      .rejects.toMatchObject({ code: 'TURN_NOT_CLOSED' } satisfies Partial<TurnDeleteError>)

    const compacted = ctx.sessions.create(SessionId('compacted'))
    const target = appendTurn(compacted, 1, 'secret', 'answer')
    compacted.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'summary' }],
      source: { kind: 'plugin', plugin: 'compact' },
    }), {
      surfaceOp: { op: 'replace', startSeq: target.user.seq, endSeq: target.assistant.seq },
      sourceEventSeqs: [target.user.seq, target.assistant.seq],
    })
    await expect(deleteTurn(ctx, idleAgent(compacted), target.assistant.data.message.id))
      .rejects.toMatchObject({ code: 'TURN_COMPACTED' } satisfies Partial<TurnDeleteError>)

    await expect(deleteTurn(ctx, idleAgent(compacted), MessageId('missing')))
      .rejects.toMatchObject({ code: 'TARGET_NOT_FOUND' } satisfies Partial<TurnDeleteError>)
  })

  it('reports an internal failure as DELETE_FAILED, never as AGENT_BUSY', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('internal'))
    const target = appendTurn(session, 1, 'q', 'a')
    const agent = idleAgent(session, {
      runMaintenance: () => { throw new Error('surface replace: start seq 7 not found in surface') },
    })

    await expect(deleteTurn(ctx, agent, target.assistant.data.message.id))
      .rejects.toMatchObject({ code: 'DELETE_FAILED' } satisfies Partial<TurnDeleteError>)
  })

  it('reports AGENT_BUSY only while a durable turn is still open', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('busy-open'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const assistant = session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createAssistantMessage({
        content: [{ type: 'text', text: 'running' }],
        source: { provider: 'test', model: 'test' },
      }),
      stream: [],
    }, { surfaceOp: 'append' })
    const agent = idleAgent(session, {
      status: 'running',
      runMaintenance: () => { throw new Error(BUSY_MESSAGE) },
    })

    await expect(deleteTurn(ctx, agent, assistant.data.message.id))
      .rejects.toMatchObject({ code: 'AGENT_BUSY' } satisfies Partial<TurnDeleteError>)
  })

  it('falls back to a direct append when the status is stuck but no turn is open', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('stuck-status'))
    const target = appendTurn(session, 1, 'q', 'a')
    const agent = idleAgent(session, {
      status: 'running',
      runMaintenance: () => { throw new Error(BUSY_MESSAGE) },
    })

    const receipt = await deleteTurn(ctx, agent, target.assistant.data.message.id)

    expect(receipt.turn).toBe(1)
    expect(session.snapshotEvents().filter(isTurnDeleteEvent)).toHaveLength(1)
  })

  it('stamps the tombstone source kind the session format demands', async () => {
    // Format 4 (DSH 0.2.x) forces `system-prompt` on every system message
    // ("message must have system-prompt source") and rejects the legacy bare
    // `plugin` kind at admission; the 0.1.x seed validator is the exact opposite
    // ("seed system/message … must have plugin source").
    expect(tombstoneSource(4)).toEqual({ kind: 'system-prompt' })
    expect(tombstoneSource(5)).toEqual({ kind: 'system-prompt' })
    expect(tombstoneSource(3)).toEqual({ kind: 'plugin', plugin: 'dsh-turn-delete' })
    expect(tombstoneSource(undefined)).toEqual({ kind: 'plugin', plugin: 'dsh-turn-delete' })

    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(SessionId('source-kind'))
    const target = appendTurn(session, 1, 'q', 'a')

    const receipt = await deleteTurn(ctx, idleAgent(session), target.assistant.data.message.id)

    const tombstone = session.eventAt(SessionSeq(receipt.seq))
    if (tombstone === undefined || tombstone.type !== 'system/message') {
      throw new Error('missing turn deletion tombstone')
    }
    const version = (session.header as { version?: number }).version
    expect(tombstone.data.message.source).toEqual(tombstoneSource(version))
    expect(isTurnDeleteEvent(tombstone)).toBe(true)
  })

  it('keeps recognizing legacy assistant-message tombstones without trusting plain messages', () => {
    const legacy = {
      type: 'assistant/message',
      seq: SessionSeq(9),
      time: 1,
      surfaceOp: { op: 'replace', startSeq: SessionSeq(1), endSeq: SessionSeq(2) },
      sourceEventSeqs: [SessionSeq(1)],
      data: {
        turn: 4,
        step: 1,
        message: createAssistantMessage({
          content: [],
          source: { provider: 'dsh-turn-delete', model: 'tombstone' },
        }),
        stream: [],
      },
    } as unknown as SessionEvent
    expect(isTurnDeleteEvent(legacy)).toBe(true)

    const ordinary = structuredClone(legacy) as unknown as {
      data: { message: { content: unknown[] } }
    }
    ordinary.data.message.content = [{ type: 'text', text: 'visible answer' }]
    expect(isTurnDeleteEvent(ordinary as unknown as SessionEvent)).toBe(false)

    const systemPrompt = {
      type: 'system/message',
      seq: SessionSeq(1),
      time: 1,
      surfaceOp: 'append',
      data: {
        turn: 0,
        step: 0,
        message: { id: 'm', role: 'system', content: [], source: { kind: 'plugin', plugin: 'system-prompt' } },
      },
    } as unknown as SessionEvent
    expect(isTurnDeleteEvent(systemPrompt)).toBe(false)

    const v4Tombstone = {
      type: 'system/message',
      seq: SessionSeq(12),
      time: 1,
      surfaceOp: { op: 'replace', startSeq: SessionSeq(1), endSeq: SessionSeq(2) },
      sourceEventSeqs: [SessionSeq(1)],
      data: {
        turn: 4,
        step: 1,
        // Format v4 forces `system-prompt` on every system message, so a v4
        // tombstone carries no producer identity: an empty system replacement is
        // the tombstone (verified against the real 0.2.0-rc.1 kernel).
        message: { id: 'm', role: 'system', content: [], source: { kind: 'system-prompt' } },
      },
    } as unknown as SessionEvent
    expect(isTurnDeleteEvent(v4Tombstone)).toBe(true)

    const foreignPlugin = structuredClone(v4Tombstone) as unknown as {
      data: { message: { source: { kind: string; plugin?: string } } }
    }
    foreignPlugin.data.message.source = { kind: 'plugin', plugin: '@scope/other-plugin' }
    expect(isTurnDeleteEvent(foreignPlugin as unknown as SessionEvent)).toBe(false)
  })
})
