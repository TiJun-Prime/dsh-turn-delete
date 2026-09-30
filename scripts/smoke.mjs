/**
 * Artifact smoke test: drive the BUILT host bundle (`lib/index.js`) through its
 * real HTTP route against the real DSH kernel.
 *
 * The unit tests import `src/`; this script proves the published artifact wires
 * the route, takes the maintenance lease, appends the replacement tombstone,
 * flushes, and leaves the model surface without the deleted turn.
 */
import { EventEmitter } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage, MessageId } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { apply, isTurnDeleteEvent, tombstoneSource, TURN_DELETE_PATH } from '../lib/index.js'

function assert(condition, message) {
  if (!condition) throw new Error(`smoke: ${message}`)
}

function appendTurn(session, turn, question, answer) {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: question }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const assistant = session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'text', text: answer }],
      source: { provider: 'smoke', model: 'smoke' },
    }),
    stream: [],
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return assistant
}

class FakeRequest extends EventEmitter {
  constructor(body, { method = 'POST', contentType = 'application/json' } = {}) {
    super()
    this.method = method
    this.headers = { 'content-type': contentType }
    this.body = body
  }

  send() {
    this.emit('data', Buffer.from(this.body))
    this.emit('end')
  }
}

class FakeResponse {
  status = 0
  headers = {}
  body = ''

  writeHead(status, headers = {}) {
    this.status = status
    this.headers = headers
  }

  end(body = '') {
    this.body = body
  }

  json() {
    return JSON.parse(this.body)
  }
}

const ctx = new Context()
await ctx.plugin(SessionStore)

const session = ctx.sessions.create(SessionId('smoke-turn-delete'))
appendTurn(session, 1, 'q1', 'a1')
const middle = appendTurn(session, 2, 'q2-secret', 'a2-secret')
appendTurn(session, 3, 'q3', 'a3')

let route
ctx.provide('webServer', {
  register(entry) {
    route = entry
    return () => {}
  },
})
ctx.provide('agents', {
  get: id => (id === session.id ? agent : undefined),
})

const agent = {
  id: session.id,
  session,
  status: 'idle',
  options: {},
  ctx,
  inbox: {},
  cancel: () => {},
  whenIdle: () => Promise.resolve(),
  runMaintenance: task => task(new AbortController().signal),
  send: () => {},
  followup: () => {},
  steer: () => {},
  inject: () => {},
}

apply(ctx)
assert(route?.path === TURN_DELETE_PATH, `route registered at ${String(route?.path)}`)

const request = new FakeRequest(JSON.stringify({
  sessionId: session.id,
  assistantMessageId: middle.data.message.id,
}))
const response = new FakeResponse()
const handled = route.handler(request, response)
request.send()
await handled

const payload = response.json()
assert(response.status === 200, `HTTP ${String(response.status)} body=${response.body}`)
assert(payload.ok === true, `payload.ok !== true: ${response.body}`)
assert(payload.value.turn === 2, `deleted turn ${String(payload.value.turn)}`)

const tombstone = session.eventAt(payload.value.seq)
assert(tombstone !== undefined && isTurnDeleteEvent(tombstone), 'tombstone event is not recognized')
assert(tombstone.type === 'system/message', `tombstone type is ${tombstone.type}`)
assert(tombstone.data.message.content.length === 0, 'tombstone content is not empty')
const formatVersion = session.header?.version
assert(
  JSON.stringify(tombstone.data.message.source) === JSON.stringify(tombstoneSource(formatVersion)),
  `tombstone source ${JSON.stringify(tombstone.data.message.source)}`
    + ` does not match session format ${String(formatVersion)}`,
)

const texts = session.deriveMessages().flatMap(message => message.content)
  .filter(block => block.type === 'text').map(block => block.text)
assert(JSON.stringify(texts) === JSON.stringify(['q1', 'a1', 'q3', 'a3']),
  `model surface is ${JSON.stringify(texts)}`)

const missing = new FakeRequest(JSON.stringify({
  sessionId: 'no-such-session',
  assistantMessageId: MessageId('nope'),
}))
const missingResponse = new FakeResponse()
const missingHandled = route.handler(missing, missingResponse)
missing.send()
await missingHandled
assert(missingResponse.status === 409, `unknown session returned HTTP ${String(missingResponse.status)}`)
assert(missingResponse.json().error.code === 'TARGET_NOT_FOUND', missingResponse.body)

console.log('smoke: built host bundle deleted a middle turn through its HTTP route')
console.log(`smoke: model surface after delete = ${JSON.stringify(texts)}`)
