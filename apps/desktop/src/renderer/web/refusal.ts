/**
 * After the cloud refuses a user's device key (retired or revoked, a 403 on register) the page must not quietly make and
 * register a new one: that would undo a sign-out made elsewhere. A new key comes only from an explicit reload (this state
 * lives in memory, so a reload clears it).
 */
export class KeyRefusal {
  private user: string | null = null

  refuse(userId: string) {
    this.user = userId
  }

  /** Whether a missing key may be created for this user in this page. */
  mayCreate(userId: string): boolean {
    return this.user !== userId
  }
}
