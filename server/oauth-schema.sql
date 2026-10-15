-- Additive migration. No activity, device, password or existing session changes.
CREATE TABLE IF NOT EXISTS mcp_oauth_grants (
  id uuid PRIMARY KEY, username text NOT NULL REFERENCES users(username),
  client_id text NOT NULL, resource text NOT NULL, scopes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS mcp_oauth_grants_user ON mcp_oauth_grants(username);
CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  code_hash text PRIMARY KEY, grant_id uuid NOT NULL REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
  redirect_uri text NOT NULL, challenge text NOT NULL, challenge_method text NOT NULL CHECK(challenge_method='S256'),
  expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
  access_hash text PRIMARY KEY, refresh_hash text UNIQUE,
  grant_id uuid NOT NULL REFERENCES mcp_oauth_grants(id) ON DELETE CASCADE,
  scopes text[] NOT NULL, access_expires_at timestamptz NOT NULL, refresh_expires_at timestamptz,
  refresh_consumed_at timestamptz
);
CREATE INDEX IF NOT EXISTS mcp_oauth_tokens_grant ON mcp_oauth_tokens(grant_id);
CREATE TABLE IF NOT EXISTS mcp_oauth_interactions (
  id_hash text PRIMARY KEY, csrf_hash text NOT NULL, parameters jsonb NOT NULL,
  expires_at timestamptz NOT NULL
);
