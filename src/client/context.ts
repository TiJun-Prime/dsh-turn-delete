import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'

/**
 * Structural faces of the client services this plugin consumes.
 *
 * DSH's client packages drift between releases (slot names moved from
 * `dsh-client-ui-conversation` to `dsh-client-ui-chat` in 0.1.5, and the
 * `ClientContext` they export changes shape), so the browser half declares the
 * services it actually calls instead of binding to one release's context type.
 * The Conversation Definition itself stays typed against the real 0.1.5
 * contract because that is the engine boundary.
 */

/** Registration options this plugin passes to the client slots service. */
export interface TurnDeleteSlotOptions {
  name: string
  id?: string
  order?: number
  locale?: string
  select?: (owner: never) => unknown
  inject?: (sessionId: string) => Record<string, unknown>
}

export interface TurnDeleteSlotsService {
  register(options: TurnDeleteSlotOptions, component: unknown): () => void
  inject(name: string, callback: () => () => void): () => void
}

export interface TurnDeleteLocaleService {
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
}

export interface TurnDeleteConversationService {
  events: {
    register(definition: ConversationNodeDefinition): () => void
  }
}

export interface ClientContext {
  effect(body: () => void | (() => void), label?: string): void
  slots: TurnDeleteSlotsService
  locale: TurnDeleteLocaleService
  uiConversation: TurnDeleteConversationService
}
