-- Invites a Mac created for a friend, and the memberships made when an account accepts one.
-- The cloud only records who accepted what: the Mac decides the person and the role, and the cloud can
-- only remove access (revoked_at), never grant it.
CREATE TABLE invites (
  invite_id   TEXT PRIMARY KEY,
  computer_id TEXT NOT NULL REFERENCES computers(id),
  token_hash  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  accepted_by TEXT REFERENCES accounts(user_id),
  accepted_at INTEGER,
  revoked_at  INTEGER
);
CREATE INDEX invites_computer ON invites(computer_id);

CREATE TABLE memberships (
  membership_id TEXT PRIMARY KEY,
  computer_id   TEXT NOT NULL REFERENCES computers(id),
  user_id       TEXT NOT NULL REFERENCES accounts(user_id),
  invite_id     TEXT NOT NULL REFERENCES invites(invite_id),
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);
CREATE UNIQUE INDEX memberships_active ON memberships(computer_id, user_id) WHERE revoked_at IS NULL;
CREATE INDEX memberships_user ON memberships(user_id) WHERE revoked_at IS NULL;
