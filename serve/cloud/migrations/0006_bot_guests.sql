-- Bot invites a Mac made, and the bot devices made when a client accepts one. A bot has no Clerk account, so its
-- device lives here and not in `devices`. The cloud only records the accept; the Mac decides (docs/kith-bot-guests.md).
CREATE TABLE bot_invites (
  invite_id   TEXT PRIMARY KEY,
  computer_id TEXT NOT NULL REFERENCES computers(id),
  token_hash  TEXT NOT NULL,                 -- hex sha256 of the proof the client sends (= sha256hex of sha256hex(t))
  expires_at  INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  accepted_at INTEGER,
  revoked_at  INTEGER
);
CREATE INDEX bot_invites_computer ON bot_invites(computer_id);

CREATE TABLE bot_devices (
  bot_device_id TEXT PRIMARY KEY,            -- bd_...
  computer_id   TEXT NOT NULL REFERENCES computers(id),
  invite_id     TEXT NOT NULL UNIQUE REFERENCES bot_invites(invite_id),
  sign_pub      TEXT NOT NULL,               -- the bot's Ed25519 key, b64url (the relay's dk)
  name          TEXT NOT NULL,               -- as the client said; the host shows its own name
  provider      TEXT,
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);
CREATE UNIQUE INDEX bot_devices_active ON bot_devices(computer_id, sign_pub) WHERE revoked_at IS NULL;
CREATE INDEX bot_devices_computer ON bot_devices(computer_id) WHERE revoked_at IS NULL;
