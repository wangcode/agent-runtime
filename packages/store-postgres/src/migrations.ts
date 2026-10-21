/**
 * Ordered schema migrations. `{{schema}}` is replaced with the configured schema name.
 * Use `migrationSql()` to feed these into your own migration tooling instead of `migrate()`.
 */
export const MIGRATIONS: ReadonlyArray<{ name: string; sql: string }> = [
  {
    name: '001_init',
    sql: `
-- agent-runtime schema. \`{{schema}}\` is replaced by the configured schema name.
CREATE SCHEMA IF NOT EXISTS {{schema}};

CREATE TABLE IF NOT EXISTS {{schema}}.sessions (
  id                  text PRIMARY KEY,
  provider            text NOT NULL,
  provider_session_id text NOT NULL,
  config              jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata            jsonb NOT NULL DEFAULT '{}'::jsonb,
  status              text NOT NULL,
  provider_cursor     jsonb,
  owner_instance      text,
  lease_expires_at    timestamptz,
  last_seq            bigint NOT NULL DEFAULT 0,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_busy_idx ON {{schema}}.sessions (lease_expires_at)
  WHERE status IN ('running', 'requires_action');

CREATE TABLE IF NOT EXISTS {{schema}}.events (
  session_id text NOT NULL REFERENCES {{schema}}.sessions(id) ON DELETE CASCADE,
  seq        bigint NOT NULL,
  type       text NOT NULL,
  data       jsonb NOT NULL,
  raw        jsonb,
  provider   text,
  source_id  text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS events_source_idx ON {{schema}}.events (session_id, source_id) WHERE source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS {{schema}}.commands (
  id         text PRIMARY KEY,
  session_id text NOT NULL REFERENCES {{schema}}.sessions(id) ON DELETE CASCADE,
  kind       text NOT NULL,
  payload    jsonb NOT NULL,
  status     text NOT NULL DEFAULT 'pending',
  error      text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS commands_pending_idx ON {{schema}}.commands (session_id, created_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS {{schema}}.actions (
  id          text PRIMARY KEY,
  session_id  text NOT NULL REFERENCES {{schema}}.sessions(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  request_id  text NOT NULL,
  tool_use_id text NOT NULL,
  name        text NOT NULL,
  input       jsonb,
  status      text NOT NULL DEFAULT 'pending',
  result      jsonb,
  resolved_by text,
  delivered   boolean NOT NULL DEFAULT false,
  expires_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (session_id, kind, request_id)
);
CREATE INDEX IF NOT EXISTS actions_open_idx ON {{schema}}.actions (session_id) WHERE status = 'pending' OR NOT delivered;

CREATE TABLE IF NOT EXISTS {{schema}}.transcripts (
  project_key text NOT NULL,
  session_id  text NOT NULL,
  subpath     text NOT NULL DEFAULT '',
  seq         bigserial,
  entry       jsonb NOT NULL,
  PRIMARY KEY (project_key, session_id, subpath, seq)
);

CREATE TABLE IF NOT EXISTS {{schema}}.migrations (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    name: '002_event_thread',
    sql: `ALTER TABLE {{schema}}.events ADD COLUMN IF NOT EXISTS thread_id text;`,
  },
]
