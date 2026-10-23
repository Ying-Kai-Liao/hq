/** A single-setting update: the host merges the keys it gets, so nothing else is re-sent from a stale copy. */
export function partialUpdate<T extends object>(id: string, change: T): { id: string } & T {
  return { ...change, id }
}

/** Runs `send`; if it fails, `rollback` puts the optimistic change back and the error is reported. */
export async function sendOrRollback(send: () => Promise<unknown>, rollback: (() => void) | undefined, report: (message: string) => void) {
  try {
    await send()
  } catch (error) {
    rollback?.()
    report(error instanceof Error ? error.message : String(error))
  }
}
