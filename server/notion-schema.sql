CREATE TABLE IF NOT EXISTS sync_preferences (
  id integer PRIMARY KEY CHECK (id=1), cloud_enabled boolean NOT NULL DEFAULT true,
  notion_enabled boolean NOT NULL DEFAULT false
);
INSERT INTO sync_preferences(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS notion_settings (
  id integer PRIMARY KEY CHECK (id=1), client_id text NOT NULL,
  secret_ciphertext text NOT NULL, template_url text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS notion_connection (
  id integer PRIMARY KEY CHECK (id=1), credentials text NOT NULL,
  workspace_id text NOT NULL, workspace_name text NOT NULL, bot_id text NOT NULL,
  page_id text, data_source_id text, connected_at timestamptz NOT NULL DEFAULT now(),
  last_success_at timestamptz, last_error text, retry_at timestamptz
);
CREATE TABLE IF NOT EXISTS notion_auth_states (
  state_hash text PRIMARY KEY, browser_hash text NOT NULL, session_hash text NOT NULL,
  username text NOT NULL REFERENCES users(username), expires_at timestamptz NOT NULL
);
-- A durable, coalescing outbox. Only pending records retain their source body.
-- page_id survives acknowledgement and retries so updates target the same page.
CREATE TABLE IF NOT EXISTS notion_items (
  key text PRIMARY KEY, device_id uuid NOT NULL REFERENCES devices(id), kind text NOT NULL,
  day date NOT NULL, source_hash text NOT NULL, source_deleted boolean NOT NULL DEFAULT false,
  payload jsonb, page_id text, dirty boolean NOT NULL DEFAULT true,
  version bigint NOT NULL DEFAULT 1, attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), last_error text,
  synced_at timestamptz, source_updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notion_pending ON notion_items(next_attempt_at) WHERE dirty;
CREATE TABLE IF NOT EXISTS notion_days (
  device_id uuid NOT NULL REFERENCES devices(id), day date NOT NULL, source_hash text NOT NULL,
  PRIMARY KEY(device_id, day)
);
