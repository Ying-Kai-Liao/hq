/** What the user can do with a memory line: answer a bot that asks first, or undo what a bot saved. */
export function memoryActions(status: string | undefined): 'answer' | 'undo' | null {
  if (status === 'pending') return 'answer'
  if (status === 'done' || status === 'accepted') return 'undo'
  return null
}
