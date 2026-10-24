-- Web devices (a browser holding a non-extractable key): devices.platform also takes 'web', and a web row is bound to
-- the Clerk session it registered under (clerk_sid). As in 0004, the table is rebuilt together with the tables that
-- reference it, children first. retired_keys holds signed retirements (POST /v1/devices/retire), including for a key
-- the cloud never saw, so a register that lands after a sign-out is refused.
CREATE TABLE devices_web (
  id            TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES accounts(user_id),
  sign_pub      TEXT NOT NULL,
  name          TEXT NOT NULL,
  platform      TEXT NOT NULL CHECK (platform IN ('ios','macos','linux','windows','android','web')),
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked_at    INTEGER,
  clerk_sid     TEXT,                           -- web devices: the Clerk session (JWT sid) the row is bound to
  UNIQUE (owner_user_id, sign_pub)
);
INSERT INTO devices_web(id, owner_user_id, sign_pub, name, platform, created_at, last_used_at, revoked_at) SELECT id, owner_user_id, sign_pub, name, platform, created_at, last_used_at, revoked_at FROM devices;
CREATE TABLE grants_web (
  id             TEXT PRIMARY KEY,
  computer_id    TEXT NOT NULL REFERENCES computers(id),
  device_id      TEXT NOT NULL REFERENCES devices_web(id),
  scopes         TEXT NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('active','revoked')),
  created_at     INTEGER NOT NULL,
  revoked_at     INTEGER,
  revoked_reason TEXT
);
INSERT INTO grants_web SELECT * FROM grants;
CREATE TABLE access_requests_web (
  id           TEXT PRIMARY KEY,
  computer_id  TEXT NOT NULL REFERENCES computers(id),
  device_id    TEXT NOT NULL REFERENCES devices_web(id),
  user_id      TEXT NOT NULL REFERENCES accounts(user_id),
  status       TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired','cancelled')),
  commit_hash  TEXT NOT NULL,
  host_nonce   TEXT,
  device_nonce TEXT,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  decided_at   INTEGER,
  grant_id     TEXT
);
INSERT INTO access_requests_web SELECT * FROM access_requests;
DROP TABLE grants;
DROP TABLE access_requests;
DROP TABLE devices;
ALTER TABLE devices_web RENAME TO devices;
ALTER TABLE grants_web RENAME TO grants;
ALTER TABLE access_requests_web RENAME TO access_requests;
CREATE UNIQUE INDEX grants_active ON grants(computer_id, device_id) WHERE status = 'active';
CREATE INDEX access_requests_computer ON access_requests(computer_id, status);
CREATE UNIQUE INDEX access_requests_one_pending ON access_requests(computer_id, device_id) WHERE status = 'pending';

CREATE TABLE retired_keys (
  sign_pub   TEXT PRIMARY KEY,
  retired_at INTEGER NOT NULL
);

-- The relay looks a device up by key on every upgrade.
CREATE INDEX devices_sign_pub ON devices(sign_pub);
