export const TURN_DELETE_PATH = '/dsh-turn-delete'
/**
 * Identity stamped on every deletion tombstone.
 *
 * Current kernels write a `system/message` whose `source.plugin` is this value.
 * Legacy `assistant/message` tombstones (DSH <= 0.1.2 era) used it as the
 * provider instead, so one constant covers both generations.
 */
export const TOMBSTONE_PLUGIN = 'dsh-turn-delete'
/** Legacy tombstone provider (`assistant/message` tombstones only). */
export const TOMBSTONE_PROVIDER = TOMBSTONE_PLUGIN
/** Legacy tombstone model (`assistant/message` tombstones only). */
export const TOMBSTONE_MODEL = 'tombstone'
