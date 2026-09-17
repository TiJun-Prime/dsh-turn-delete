export const zh = {
  'action.delete': '删除这一轮对话',
  'action.busy': '任务运行时不能删除对话',
  'dialog.title': '删除这一轮对话？',
  'dialog.description': '这会从当前 Session 和后续模型上下文中移除本轮的提问、回答与工具记录，但不会删除整个 Session。',
  'dialog.cancel': '取消',
  'dialog.confirm': '删除这一轮',
  'dialog.deleting': '正在删除…',
  'error.busy': '任务正在运行，请结束后再删除。',
  'error.compacted': '这一轮已被压缩进上下文摘要：摘要是整体替换，无法单独摘除其中一轮。',
  'error.failed': '删除失败：插件内部出错或与当前内核不兼容。',
  'error.unavailable': '这一轮已变化或不存在，无法删除。',
  'error.generic': '删除失败，请重试。',
} as const

export type TurnDeleteKey = keyof typeof zh

export const en: Record<TurnDeleteKey, string> = {
  'action.delete': 'Delete this turn',
  'action.busy': 'Turns cannot be deleted while the task is running',
  'dialog.title': 'Delete this turn?',
  'dialog.description': 'This removes the prompt, response, and tool records from this Session and future model context. It does not delete the Session.',
  'dialog.cancel': 'Cancel',
  'dialog.confirm': 'Delete turn',
  'dialog.deleting': 'Deleting…',
  'error.busy': 'Wait for the task to finish before deleting this turn.',
  'error.compacted': 'This turn is already inside a context summary. The summary is replaced as a whole, so this turn cannot be removed on its own.',
  'error.failed': 'Deletion failed: the plugin hit an internal error or is incompatible with this Harness build.',
  'error.unavailable': 'This turn changed or no longer exists and cannot be deleted.',
  'error.generic': 'Could not delete this turn. Try again.',
}
