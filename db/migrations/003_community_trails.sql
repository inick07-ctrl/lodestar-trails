-- 003: user-created trails, optionally shared with the Lodestar community.
-- Applied automatically by ensureSchema() in lib/server.js (idempotent). Kept here for review / manual runs.
CREATE TABLE IF NOT EXISTS community_trails (
  id text PRIMARY KEY,
  owner_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- deleting an account deletes its trails
  name text NOT NULL,
  best_for text[] NOT NULL DEFAULT '{}',
  difficulty smallint NOT NULL DEFAULT 1,          -- 0 easy, 1 moderate, 2 hard, 3 expert
  clearance text NOT NULL DEFAULT 'any',           -- any | awd | high | 4wd
  notes text NOT NULL DEFAULT '',
  shared boolean NOT NULL DEFAULT false,           -- false = private to the owner
  source text NOT NULL DEFAULT 'drawn',            -- drawn | recorded
  coords jsonb NOT NULL,                           -- [[lon,lat], ...] up to 5000 points
  preview jsonb NOT NULL,                          -- decimated copy (<= 160 points) for lists/map
  len_m double precision NOT NULL,
  min_lon double precision NOT NULL, min_lat double precision NOT NULL,
  max_lon double precision NOT NULL, max_lat double precision NOT NULL,
  start_lon double precision NOT NULL, start_lat double precision NOT NULL,
  report_count int NOT NULL DEFAULT 0,
  created bigint NOT NULL, updated bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS ctrails_owner ON community_trails(owner_id);
CREATE INDEX IF NOT EXISTS ctrails_shared_box ON community_trails(shared, min_lat, max_lat, min_lon, max_lon);
CREATE TABLE IF NOT EXISTS trail_reports (
  trail_id text NOT NULL REFERENCES community_trails(id) ON DELETE CASCADE,
  reporter_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason text NOT NULL DEFAULT '',
  created bigint NOT NULL,
  PRIMARY KEY (trail_id, reporter_id)
);
-- Moderation (no admin UI yet): reported trails
--   SELECT t.id, t.name, t.report_count, r.reason, r.created FROM community_trails t JOIN trail_reports r ON r.trail_id = t.id ORDER BY t.report_count DESC;
-- Trails with >= 5 distinct reports are hidden from other users automatically; the owner still sees them.
