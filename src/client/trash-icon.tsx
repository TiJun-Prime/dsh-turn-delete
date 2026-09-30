import type { ComponentType } from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'

/** Props every primitives icon accepts (`size` defaults to 16). */
export interface TrashIconProps {
  readonly size?: number
  readonly className?: string
}

export type TrashIconComponent = ComponentType<TrashIconProps>

/**
 * Names the trash glyph has carried across the kernel lines this plugin
 * supports, newest first.
 *
 * DSH 0.2.0-rc.1 dropped the size suffix from every icon and split the set into
 * stroke-weight variants: `IconTrashOutline16` (0.1.x) became
 * `IconTrashOutlineRegular` (1px stroke) / `IconTrashOutlineMedium` (1.3px).
 *
 * The browser half resolves the name at runtime on purpose. Reading a renamed
 * export yields `undefined`, and rendering `undefined` as a component throws
 * inside the chat action row — which takes the delete button (and the row it
 * lives in) down with it, with no host-side error to explain why.
 */
const TRASH_ICON_NAMES = [
  'IconTrashOutlineRegular',
  'IconTrashOutline',
  'IconTrashOutline16',
  'IconTrashOutlineMedium',
] as const

/** Pick the first trash icon a primitives module actually exports. */
export function resolveTrashIcon(module: unknown): TrashIconComponent | null {
  if (module === null || typeof module !== 'object') return null
  const table = module as Record<string, unknown>
  for (const name of TRASH_ICON_NAMES) {
    const candidate = table[name]
    if (typeof candidate === 'function' || (typeof candidate === 'object' && candidate !== null)) {
      return candidate as TrashIconComponent
    }
  }
  return null
}

/** Trash glyph exported by the primitives module bundled with this build. */
export const TrashIcon: TrashIconComponent | null = resolveTrashIcon(primitives)

/**
 * Inline stand-in used when no primitives icon answers to any known name, so a
 * future rename degrades to a plain glyph instead of an empty button.
 */
export function FallbackTrashIcon() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false">
      <path d="M2.75 4.25h10.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <path d="M6.45 6.99v4.14M9.55 6.99v4.14" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      <path
        d="M4.15 4.25l.5 8.08a1.1 1.1 0 0 0 1.1 1.02h4.5a1.1 1.1 0 0 0 1.1-1.02l.5-8.08"
        stroke="currentColor"
        strokeWidth="1"
        strokeLinejoin="round"
      />
    </svg>
  )
}
