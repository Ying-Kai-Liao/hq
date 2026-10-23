// Invites and memberships. The Mac (Sig(host)) posts an invite it made, an account accepts it, and the cloud
// records "account X is a member of computer Y". The host decides what that means; the cloud can only remove access.

import { randomId, sha256, utf8 } from "../auth";
import { ApiError, audit, body, host, notify, revokeMembership, str, user, type Ctx } from "./common";

/** The host makes 24 h invites; a longer ask is a bug or a hostile host, not clock skew. */
const MAX_INVITE_TTL_MS = 48 * 3600_000;
const HEX64 = /^[0-9a-f]{64}$/;
const INVITE_ID = /^[A-Za-z0-9_-]{1,64}$/;

interface InviteRow {
  invite_id: string;
  computer_id: string;
  token_hash: string;
  expires_at: number;
  accepted_by: string | null;
  revoked_at: number | null;
}

interface MembershipRow {
  membership_id: string;
  computer_id: string;
  user_id: string;
  revoked_at: number | null;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("");

export async function hostCreateInvite(c: Ctx) {
  const comp = await host(c);
  const b = body(c);
  const inviteId = str(b, "inviteId", 64);
  const tokenHash = str(b, "tokenHash", 64);
  const expiresAt = b.expiresAt;
  if (!INVITE_ID.test(inviteId)) throw new ApiError("badRequest", "Invalid inviteId");
  if (!HEX64.test(tokenHash)) throw new ApiError("badRequest", "Invalid tokenHash");
  if (!Number.isSafeInteger(expiresAt) || (expiresAt as number) <= c.now || (expiresAt as number) > c.now + MAX_INVITE_TTL_MS) {
    throw new ApiError("badRequest", "Invalid expiresAt");
  }
  // Invitees join an account's computer; an unclaimed one has no account to invite them into.
  if (!comp.owner_user_id) throw new ApiError("forbidden", "Sign in on the computer to invite people");
  const inserted = await c.env.DB.prepare(
    "INSERT OR IGNORE INTO invites(invite_id, computer_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(inviteId, comp.id, tokenHash, expiresAt, c.now)
    .run();
  if (inserted.meta.changes === 0) {
    // Re-posting the same invite is a no-op; the same id with another hash or computer is a clash.
    const row = await c.env.DB.prepare("SELECT * FROM invites WHERE invite_id = ?").bind(inviteId).first<InviteRow>();
    if (!row || row.computer_id !== comp.id || row.token_hash !== tokenHash) throw new ApiError("conflict", "inviteId is taken");
    return { ok: true };
  }
  await audit(c.env, `computer:${comp.id}`, "invite.create", inviteId, "ok", c.now).run();
  return { ok: true };
}

export async function hostRevokeInvite(c: Ctx, [inviteId]: string[]) {
  const comp = await host(c);
  const row = await c.env.DB.prepare("SELECT * FROM invites WHERE invite_id = ? AND computer_id = ?")
    .bind(inviteId, comp.id)
    .first<InviteRow>();
  if (!row) throw new ApiError("notFound");
  if (row.accepted_by) throw new ApiError("conflict", "The invite was accepted; revoke the membership instead");
  if (row.revoked_at) return { ok: true };
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE invites SET revoked_at = ? WHERE invite_id = ? AND accepted_by IS NULL AND revoked_at IS NULL").bind(
      c.now,
      inviteId,
    ),
    audit(c.env, `computer:${comp.id}`, "invite.revoke", inviteId!, "ok", c.now),
  ]);
  return { ok: true };
}

export async function hostRevokeMembership(c: Ctx, [membershipId]: string[]) {
  const comp = await host(c);
  const m = await c.env.DB.prepare("SELECT * FROM memberships WHERE membership_id = ? AND computer_id = ?")
    .bind(membershipId, comp.id)
    .first<MembershipRow>();
  if (!m) throw new ApiError("notFound");
  if (m.revoked_at) return { ok: true };
  await revokeMembership(c.env, comp.id, m.user_id, `computer:${comp.id}`, membershipId!, c.now);
  return { ok: true };
}

/** The account joins the computer whose Mac made this invite. Single use; the same account may repeat it. */
export async function acceptInvite(c: Ctx, [inviteId]: string[]) {
  const u = await user(c);
  const token = str(body(c), "token", 200);
  const inv = await c.env.DB.prepare("SELECT * FROM invites WHERE invite_id = ?").bind(inviteId).first<InviteRow>();
  if (!inv) throw new ApiError("notFound", "This invite doesn't exist");
  if (hex(await sha256(utf8(token))) !== inv.token_hash) throw new ApiError("forbidden", "This invite link isn't valid");
  const comp = await c.env.DB.prepare("SELECT owner_user_id FROM computers WHERE id = ?")
    .bind(inv.computer_id)
    .first<{ owner_user_id: string | null }>();
  if (!comp?.owner_user_id) throw new ApiError("inviteRevoked", "This invite is no longer valid");
  if (comp.owner_user_id === u.userId) throw new ApiError("forbidden", "This is your own computer");

  const mine = () =>
    c.env.DB.prepare("SELECT membership_id, revoked_at FROM memberships WHERE invite_id = ? AND user_id = ?")
      .bind(inviteId, u.userId)
      .first<{ membership_id: string; revoked_at: number | null }>();

  if (inv.accepted_by === u.userId) {
    const m = await mine();
    // Access ended after joining: a used invite doesn't bring it back, the owner invites again.
    if (!m || m.revoked_at) throw new ApiError("inviteRevoked", "Your access to this computer was removed");
    return { computerId: inv.computer_id, membershipId: m.membership_id };
  }
  if (inv.revoked_at) throw new ApiError("inviteRevoked", "This invite was cancelled");
  if (inv.accepted_by) throw new ApiError("conflict", "This invite was already used");
  if (inv.expires_at <= c.now) throw new ApiError("inviteExpired", "This invite has expired");
  const already = await c.env.DB.prepare("SELECT 1 FROM memberships WHERE computer_id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(inv.computer_id, u.userId)
    .first();
  if (already) throw new ApiError("conflict", "You're already a member of this computer");

  const membershipId = randomId("mem_");
  // One winner when two accounts race: only the UPDATE that still sees accepted_by NULL goes on to insert.
  const [won] = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE invites SET accepted_by = ?1, accepted_at = ?2
       WHERE invite_id = ?3 AND accepted_by IS NULL AND revoked_at IS NULL AND expires_at > ?2`,
    ).bind(u.userId, c.now, inviteId),
    c.env.DB.prepare(
      `INSERT INTO memberships(membership_id, computer_id, user_id, invite_id, created_at)
       SELECT ?1, computer_id, ?2, invite_id, ?3 FROM invites WHERE invite_id = ?4 AND accepted_by = ?2 AND accepted_at = ?3
       ON CONFLICT DO NOTHING`,
    ).bind(membershipId, u.userId, c.now, inviteId),
  ]);
  if (won!.meta.changes === 0) {
    const latest = await c.env.DB.prepare("SELECT * FROM invites WHERE invite_id = ?").bind(inviteId).first<InviteRow>();
    if (latest?.revoked_at) throw new ApiError("inviteRevoked", "This invite was cancelled");
    if (latest?.accepted_by === u.userId) {
      // Our own double click landed first.
      const m = await mine();
      if (m && !m.revoked_at) return { computerId: inv.computer_id, membershipId: m.membership_id };
    }
    if (latest?.accepted_by) throw new ApiError("conflict", "This invite was already used");
    throw new ApiError("inviteExpired", "This invite has expired");
  }
  const saved = await mine();
  await audit(c.env, u.userId, "invite.accept", inviteId!, "ok", c.now).run();
  await notify(c.env, inv.computer_id);
  return { computerId: inv.computer_id, membershipId: saved?.membership_id ?? membershipId };
}
