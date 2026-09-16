CREATE TABLE IF NOT EXISTS users (
  username text PRIMARY KEY, password_hash text NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY, username text NOT NULL REFERENCES users(username),
  expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY, name text NOT NULL, revision integer NOT NULL DEFAULT 0,
  time_zone text NOT NULL, day_boundary_hour integer NOT NULL DEFAULT 4,
  status jsonb NOT NULL DEFAULT '{}', categories jsonb NOT NULL DEFAULT '[]',
  last_sync_at timestamptz
);
CREATE TABLE IF NOT EXISTS source_days (
  device_id uuid NOT NULL REFERENCES devices(id), day date NOT NULL,
  source_hash text NOT NULL, PRIMARY KEY (device_id, day)
);
CREATE TABLE IF NOT EXISTS activities (
  device_id uuid NOT NULL REFERENCES devices(id), record_id bigint NOT NULL,
  day date NOT NULL, start_at timestamptz NOT NULL, end_at timestamptz NOT NULL,
  content_hash text NOT NULL, payload jsonb NOT NULL,
  source_deleted boolean NOT NULL DEFAULT false, deleted_at timestamptz,
  screenshot_hash text, first_synced_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (device_id, record_id)
);
CREATE INDEX IF NOT EXISTS activities_day ON activities(day, start_at);
CREATE INDEX IF NOT EXISTS activities_active_day ON activities(day) WHERE NOT source_deleted;
CREATE TABLE IF NOT EXISTS documents (
  device_id uuid NOT NULL REFERENCES devices(id), kind text NOT NULL CHECK (kind IN ('daily','weekly')),
  day date NOT NULL, source_hash text NOT NULL, payload jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (device_id, kind, day)
);
CREATE TABLE IF NOT EXISTS sync_batches (
  device_id uuid NOT NULL REFERENCES devices(id), batch_id uuid NOT NULL,
  revision integer NOT NULL, received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(device_id, batch_id)
);
