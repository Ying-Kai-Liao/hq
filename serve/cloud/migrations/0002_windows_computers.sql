-- Windows hosts: computers.platform also takes 'windows'. SQLite can't alter a CHECK, so
-- computers is rebuilt, together with the tables that reference it (access_requests,
-- grants): with foreign keys enforced, dropping a referenced table would count every
-- referencing row as a violation. The children go first, then their parent; renaming
-- computers_new afterwards updates the new children's references to `computers`.

CREATE TABLE computers_new (
  id            TEXT PRIMARY KEY,               -- computerId
  sign_pub      TEXT NOT NULL UNIQUE,
  box_pub       TEXT NOT NULL,
  owner_user_id TEXT REFERENCES accounts(user_id),
  name          TEXT NOT NULL,
  platform      TEXT NOT NULL CHECK (platform IN ('macos','linux','windows')),
  device        TEXT,                           -- laptop|macmini|…|linux（host 的 Device）
  version       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','blocked')),
  online        INTEGER NOT NULL DEFAULT 0,     -- DO 寫入
  last_seen_at  INTEGER,                        -- DO 寫入
  claimed_at    INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
INSERT INTO computers_new SELECT * FROM computers;

CREATE TABLE access_requests_new (
  id          TEXT PRIMARY KEY,                 -- req_…
  computer_id TEXT NOT NULL REFERENCES computers_new(id),
  device_id   TEXT NOT NULL REFERENCES devices(id),
  user_id     TEXT NOT NULL REFERENCES accounts(user_id),
  status      TEXT NOT NULL CHECK (status IN ('pending','approved','denied','expired','cancelled')),
  commit_hash  TEXT NOT NULL,                   -- SHA-256("codync/sascommit/v1" ‖ dk ‖ nD)
  host_nonce   TEXT,                            -- nH，host 設一次
  device_nonce TEXT,                            -- nD，host_nonce 存在後裝置才可設
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,                 -- created_at + 10 min
  decided_at  INTEGER,
  grant_id    TEXT
);
INSERT INTO access_requests_new SELECT * FROM access_requests;

CREATE TABLE grants_new (
  id             TEXT PRIMARY KEY,              -- grt_…
  computer_id    TEXT NOT NULL REFERENCES computers_new(id),
  device_id      TEXT NOT NULL REFERENCES devices(id),
  scopes         TEXT NOT NULL,                 -- JSON array
  status         TEXT NOT NULL CHECK (status IN ('active','revoked')),
  created_at     INTEGER NOT NULL,
  revoked_at     INTEGER,
  revoked_reason TEXT                           -- owner|deviceRevoked|unclaimed|accountDeleted
);
INSERT INTO grants_new SELECT * FROM grants;

DROP TABLE access_requests;
DROP TABLE grants;
DROP TABLE computers;
ALTER TABLE computers_new RENAME TO computers;
ALTER TABLE access_requests_new RENAME TO access_requests;
ALTER TABLE grants_new RENAME TO grants;

CREATE INDEX computers_owner ON computers(owner_user_id);
CREATE INDEX access_requests_computer ON access_requests(computer_id, status);
CREATE UNIQUE INDEX access_requests_one_pending ON access_requests(computer_id, device_id) WHERE status = 'pending';
CREATE UNIQUE INDEX grants_active ON grants(computer_id, device_id) WHERE status = 'active';
