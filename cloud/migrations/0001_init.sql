-- ISS position snapshots: one row per successful refresh, per user.
-- The column carrying the API's own unix timestamp is named snapshot_ts
-- because `timestamp` is a reserved type name in Postgres.
CREATE TABLE iss_snapshots (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner       text NOT NULL DEFAULT app.user_id() REFERENCES _app_users(app_uid) ON DELETE CASCADE,
  snapshot_ts bigint NOT NULL,
  latitude    double precision NOT NULL,
  longitude   double precision NOT NULL,
  altitude    double precision,
  velocity    double precision,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE iss_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE iss_snapshots FORCE ROW LEVEL SECURITY;

-- Each user sees and maintains only their own history.
CREATE POLICY iss_snapshots_read ON iss_snapshots
  FOR SELECT USING (owner = app.user_id());

CREATE POLICY iss_snapshots_insert ON iss_snapshots
  FOR INSERT WITH CHECK (owner = app.user_id());

CREATE POLICY iss_snapshots_update ON iss_snapshots
  FOR UPDATE USING (owner = app.user_id()) WITH CHECK (owner = app.user_id());

CREATE POLICY iss_snapshots_delete ON iss_snapshots
  FOR DELETE USING (owner = app.user_id());

-- Serving "newest 10" and the 500-row prune per user.
CREATE INDEX iss_snapshots_owner_id_idx ON iss_snapshots (owner, id DESC);
