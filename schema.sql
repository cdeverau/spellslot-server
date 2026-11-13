-- Fallen Challenger ghost pool. Re-running this file is safe. Once deployed, changes must be additive
-- (new tables / ALTER ADD COLUMN); until then a reshaped table is dropped locally and recreated.

-- trust: 0 probation, 1 trusted, 2 flagged (shadow pool). New accounts start trusted until the ingest checker ships.
CREATE TABLE IF NOT EXISTS accounts (
  uuid        TEXT PRIMARY KEY,
  trust       INTEGER NOT NULL DEFAULT 1,
  first_seen  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  platform_id TEXT
);

-- the pool: one row per account per floor, replaced on resubmit. payload = the AsyncPlayerData dict, stored as an opaque blob.
CREATE TABLE IF NOT EXISTS submissions (
  account_uuid   TEXT NOT NULL,
  floor          INTEGER NOT NULL,
  compat_key     TEXT NOT NULL,
  run_id         TEXT NOT NULL,
  display_name   TEXT NOT NULL,
  payload        TEXT NOT NULL,
  log            TEXT NOT NULL,
  log_version    INTEGER NOT NULL,
  received_at    INTEGER NOT NULL,
  quarantined_at INTEGER,
  PRIMARY KEY (account_uuid, floor)
);
CREATE INDEX IF NOT EXISTS submissions_pool ON submissions (floor, compat_key, received_at);

-- one row per ghost served (ghost_uuid NULL when the pool was empty). Reports reference id.
CREATE TABLE IF NOT EXISTS encounters (
  id             TEXT PRIMARY KEY,
  requester_uuid TEXT NOT NULL,
  ghost_uuid     TEXT,
  floor          INTEGER NOT NULL,
  compat_key     TEXT NOT NULL,
  received_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS encounters_ghost ON encounters (ghost_uuid, floor);

-- pool hygiene: a client could not rebuild the ghost it was served. One per encounter, and at most one per
-- (reporter, run, ghost row) - run_id is the reporter's run, so a new run may report the same ghost again.
CREATE TABLE IF NOT EXISTS rebuild_failures (
  encounter_id TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  reason       TEXT NOT NULL,
  received_at  INTEGER NOT NULL
);

-- player reports ("this ghost looked cheated"). Same dedupe as rebuild_failures. Flags for review only; never served on.
CREATE TABLE IF NOT EXISTS reports (
  encounter_id TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  received_at  INTEGER NOT NULL
);
