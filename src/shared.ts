export const TURN_DELETE_PATH = '/dsh-turn-delete'
/**
 * Identity stamped on every deletion tombstone.
 *
 * Session format v3 wrote the bare `source.plugin` of a `system/message`; the
 * legacy `assistant/message` tombstones (DSH <= 0.1.2 era) used it as the
 * provider instead, so one constant covers every generation.
 */
export const TOMBSTONE_PLUGIN = 'dsh-turn-delete'
/**
 * Source kind session format v4 (DSH 0.2.x) forces on every `system/message`.
 *
 * v4 validates message sources by *role*, not by producer: a system message must
 * be `system-prompt`, an assistant message must be `model` plus provider/model
 * ("seed system/message … message must have system-prompt source"). The v3→v4
 * migration additionally rejects the legacy bare `plugin` kind outright ("format
 * v4 message requires a producer-owned source kind"). A v4 deletion tombstone
 * therefore carries no producer identity in its source — an empty system
 * replacement *is* the tombstone — while v3 keeps `source.plugin`, because the
 * 0.1.x seed validator demands it ("seed system/message … message must have
 * plugin source").
 */
export const SYSTEM_PROMPT_SOURCE_KIND = 'system-prompt'
/** Legacy tombstone provider (`assistant/message` tombstones only). */
export const TOMBSTONE_PROVIDER = TOMBSTONE_PLUGIN
/** Legacy tombstone model (`assistant/message` tombstones only). */
export const TOMBSTONE_MODEL = 'tombstone'
