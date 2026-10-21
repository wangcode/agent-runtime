import type pg from 'pg'
import type {
  ActionRecord,
  CommandRecord,
  NewEvent,
  PersistedEvent,
  SessionRecord,
  Store,
  TranscriptKey,
} from '@agent-runtime/core'
import { MIGRATIONS } from './migrations.js'

export interface PgStoreOptions {
  pool: pg.Pool
  /** Schema holding the agent-runtime tables. Default `agent_runtime`. */
  schema?: string
}

const IDENT = /^[a-z_][a-z0-9_]*$/

export const validateSchema = (schema: string): string => {
  if (!IDENT.test(schema)) throw new Error(`Invalid schema name "${schema}"`)
  return schema
}

/** Migration SQL with the schema name filled in. */
export const migrationSql = (schema = 'agent_runtime') =>
  MIGRATIONS.map((m) => ({ name: m.name, sql: m.sql.replaceAll('{{schema}}', validateSchema(schema)) }))

/** Apply pending migrations under an advisory lock, so concurrent instances can call this at boot. */
export async function migrate(pool: pg.Pool, opts: { schema?: string } = {}): Promise<void> {
  const schema = validateSchema(opts.schema ?? 'agent_runtime')
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [`agent_runtime_migrate:${schema}`])
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`)
    await client.query(`CREATE TABLE IF NOT EXISTS ${schema}.migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`)
    const { rows } = await client.query<{ name: string }>(`SELECT name FROM ${schema}.migrations`)
    const applied = new Set(rows.map((r) => r.name))
    for (const m of migrationSql(schema)) {
      if (applied.has(m.name)) continue
      await client.query('BEGIN')
      try {
        await client.query(m.sql)
        await client.query(`INSERT INTO ${schema}.migrations (name) VALUES ($1)`, [m.name])
        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`agent_runtime_migrate:${schema}`]).catch(() => {})
    client.release()
  }
}

const json = (v: unknown) => (v === undefined ? null : JSON.stringify(v))

/* eslint-disable @typescript-eslint/no-explicit-any */
const toSession = (r: any): SessionRecord => ({
  id: r.id,
  provider: r.provider,
  providerSessionId: r.provider_session_id,
  config: r.config,
  metadata: r.metadata,
  status: r.status,
  providerCursor: r.provider_cursor,
  ownerInstance: r.owner_instance,
  leaseExpiresAt: r.lease_expires_at,
  lastSeq: Number(r.last_seq),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})

const toEvent = (r: any): PersistedEvent =>
  ({
    id: String(r.seq),
    sessionId: r.session_id,
    seq: Number(r.seq),
    ts: (r.created_at as Date).toISOString(),
    type: r.type,
    data: r.data,
    ...(r.raw !== null ? { raw: r.raw } : {}),
    ...(r.provider ? { provider: r.provider } : {}),
  }) as PersistedEvent

const toCommand = (r: any): CommandRecord => ({
  id: r.id,
  sessionId: r.session_id,
  kind: r.kind,
  payload: r.payload,
  status: r.status,
  ...(r.error ? { error: r.error } : {}),
  createdAt: r.created_at,
})

const toAction = (r: any): ActionRecord => ({
  id: r.id,
  sessionId: r.session_id,
  kind: r.kind,
  requestId: r.request_id,
  toolUseId: r.tool_use_id,
  name: r.name,
  input: r.input,
  status: r.status,
  ...(r.result !== null ? { result: r.result } : {}),
  ...(r.resolved_by ? { resolvedBy: r.resolved_by } : {}),
  delivered: r.delivered,
  expiresAt: r.expires_at,
  createdAt: r.created_at,
})
/* eslint-enable @typescript-eslint/no-explicit-any */

export class PgStore implements Store {
  private readonly pool: pg.Pool
  private readonly s: string

  constructor(opts: PgStoreOptions) {
    this.pool = opts.pool
    this.s = validateSchema(opts.schema ?? 'agent_runtime')
  }

  async createSession(input: Parameters<Store['createSession']>[0]) {
    const { rows } = await this.pool.query(
      `INSERT INTO ${this.s}.sessions (id, provider, provider_session_id, config, metadata, status, provider_cursor)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [input.id, input.provider, input.providerSessionId, json(input.config ?? {}), json(input.metadata), input.status, json(input.providerCursor)],
    )
    return toSession(rows[0])
  }

  async getSession(id: string) {
    const { rows } = await this.pool.query(`SELECT * FROM ${this.s}.sessions WHERE id = $1`, [id])
    return rows[0] ? toSession(rows[0]) : null
  }

  async updateSession(id: string, patch: Parameters<Store['updateSession']>[1]) {
    const sets: string[] = []
    const values: unknown[] = [id]
    if (patch.status !== undefined) sets.push(`status = $${values.push(patch.status)}`)
    if ('providerCursor' in patch) sets.push(`provider_cursor = $${values.push(json(patch.providerCursor))}`)
    if (patch.providerSessionId !== undefined) sets.push(`provider_session_id = $${values.push(patch.providerSessionId)}`)
    if (!sets.length) return
    await this.pool.query(`UPDATE ${this.s}.sessions SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, values)
  }

  async tryAcquireLease(id: string, instanceId: string, ttlMs: number) {
    const { rowCount } = await this.pool.query(
      `UPDATE ${this.s}.sessions
          SET owner_instance = $2, lease_expires_at = now() + make_interval(secs => $3::double precision / 1000)
        WHERE id = $1 AND (owner_instance IS NULL OR owner_instance = $2 OR lease_expires_at IS NULL OR lease_expires_at <= now())`,
      [id, instanceId, ttlMs],
    )
    return rowCount === 1
  }

  async renewLease(id: string, instanceId: string, ttlMs: number) {
    const { rowCount } = await this.pool.query(
      `UPDATE ${this.s}.sessions SET lease_expires_at = now() + make_interval(secs => $3::double precision / 1000)
        WHERE id = $1 AND owner_instance = $2`,
      [id, instanceId, ttlMs],
    )
    return rowCount === 1
  }

  async releaseLease(id: string, instanceId: string) {
    await this.pool.query(`UPDATE ${this.s}.sessions SET owner_instance = NULL, lease_expires_at = NULL WHERE id = $1 AND owner_instance = $2`, [
      id,
      instanceId,
    ])
  }

  async findOrphans(limit: number) {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT s.id FROM ${this.s}.sessions s
        WHERE s.status <> 'terminated'
          AND (s.owner_instance IS NULL OR s.lease_expires_at IS NULL OR s.lease_expires_at <= now())
          AND (s.status IN ('running', 'requires_action')
               OR EXISTS (SELECT 1 FROM ${this.s}.commands c WHERE c.session_id = s.id AND c.status = 'pending')
               OR EXISTS (SELECT 1 FROM ${this.s}.actions a WHERE a.session_id = s.id AND (a.status = 'pending' OR NOT a.delivered)))
        LIMIT $1`,
      [limit],
    )
    return rows.map((r) => r.id)
  }

  async appendEvent(sessionId: string, event: NewEvent): Promise<PersistedEvent | null> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // Row lock serializes seq allocation, so commits become visible in seq order.
      const locked = await client.query(`SELECT 1 FROM ${this.s}.sessions WHERE id = $1 FOR UPDATE`, [sessionId])
      if (!locked.rowCount) throw new Error(`Session ${sessionId} not found`)
      if (event.sourceId) {
        const dup = await client.query(`SELECT 1 FROM ${this.s}.events WHERE session_id = $1 AND source_id = $2`, [sessionId, event.sourceId])
        if (dup.rowCount) {
          await client.query('ROLLBACK')
          return null
        }
      }
      const { rows: seqRows } = await client.query<{ last_seq: string }>(
        `UPDATE ${this.s}.sessions SET last_seq = last_seq + 1 WHERE id = $1 RETURNING last_seq`,
        [sessionId],
      )
      const { rows } = await client.query(
        `INSERT INTO ${this.s}.events (session_id, seq, type, data, raw, provider, source_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [sessionId, seqRows[0]?.last_seq, event.type, json(event.data), json(event.raw), event.provider ?? null, event.sourceId ?? null],
      )
      await client.query('COMMIT')
      return toEvent(rows[0])
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }

  async readEvents(sessionId: string, afterSeq: number, limit: number) {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.s}.events WHERE session_id = $1 AND seq > $2 ORDER BY seq LIMIT $3`,
      [sessionId, afterSeq, limit],
    )
    return rows.map(toEvent)
  }

  async enqueueCommand(input: Parameters<Store['enqueueCommand']>[0]) {
    await this.pool.query(
      `INSERT INTO ${this.s}.commands (id, session_id, kind, payload) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
      [input.id, input.sessionId, input.kind, json(input.payload ?? {})],
    )
    return (await this.getCommand(input.id)) as CommandRecord
  }

  async pendingCommands(sessionId: string) {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.s}.commands WHERE session_id = $1 AND status = 'pending' ORDER BY created_at, id`,
      [sessionId],
    )
    return rows.map(toCommand)
  }

  async getCommand(id: string) {
    const { rows } = await this.pool.query(`SELECT * FROM ${this.s}.commands WHERE id = $1`, [id])
    return rows[0] ? toCommand(rows[0]) : null
  }

  async finishCommand(id: string, outcome: { status: 'done' | 'failed'; error?: string }) {
    await this.pool.query(`UPDATE ${this.s}.commands SET status = $2, error = $3 WHERE id = $1`, [id, outcome.status, outcome.error ?? null])
  }

  async upsertAction(input: Parameters<Store['upsertAction']>[0]) {
    const inserted = await this.pool.query(
      `INSERT INTO ${this.s}.actions (id, session_id, kind, request_id, tool_use_id, name, input, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (session_id, kind, request_id) DO NOTHING RETURNING *`,
      [input.id, input.sessionId, input.kind, input.requestId, input.toolUseId, input.name, json(input.input), input.expiresAt],
    )
    if (inserted.rows[0]) return { action: toAction(inserted.rows[0]), created: true }
    const { rows } = await this.pool.query(`SELECT * FROM ${this.s}.actions WHERE session_id = $1 AND kind = $2 AND request_id = $3`, [
      input.sessionId,
      input.kind,
      input.requestId,
    ])
    return { action: toAction(rows[0]), created: false }
  }

  async getAction(id: string) {
    const { rows } = await this.pool.query(`SELECT * FROM ${this.s}.actions WHERE id = $1`, [id])
    return rows[0] ? toAction(rows[0]) : null
  }

  async listActions(sessionId: string, filter: { status?: ActionRecord['status']; kind?: ActionRecord['kind'] } = {}) {
    const { rows } = await this.pool.query(
      `SELECT * FROM ${this.s}.actions WHERE session_id = $1 AND ($2::text IS NULL OR status = $2) AND ($3::text IS NULL OR kind = $3)
        ORDER BY created_at, id`,
      [sessionId, filter.status ?? null, filter.kind ?? null],
    )
    return rows.map(toAction)
  }

  async resolveAction(id: string, outcome: Parameters<Store['resolveAction']>[1]) {
    const { rowCount } = await this.pool.query(
      `UPDATE ${this.s}.actions SET status = $2, result = $3, resolved_by = $4, delivered = (CASE WHEN $2 = 'cancelled' THEN true ELSE delivered END)
        WHERE id = $1 AND status = 'pending'`,
      [id, outcome.status, json(outcome.result), outcome.resolvedBy],
    )
    return rowCount === 1
  }

  async markActionDelivered(id: string) {
    await this.pool.query(`UPDATE ${this.s}.actions SET delivered = true WHERE id = $1`, [id])
  }

  async appendTranscript(key: TranscriptKey, entries: unknown[]) {
    if (!entries.length) return
    await this.pool.query(
      `INSERT INTO ${this.s}.transcripts (project_key, session_id, subpath, entry)
       SELECT $1, $2, $3, e FROM jsonb_array_elements($4::jsonb) WITH ORDINALITY AS t(e, n) ORDER BY n`,
      [key.projectKey, key.sessionId, key.subpath ?? '', JSON.stringify(entries)],
    )
  }

  async loadTranscript(key: TranscriptKey) {
    const { rows } = await this.pool.query<{ entry: unknown }>(
      `SELECT entry FROM ${this.s}.transcripts WHERE project_key = $1 AND session_id = $2 AND subpath = $3 ORDER BY seq`,
      [key.projectKey, key.sessionId, key.subpath ?? ''],
    )
    return rows.length ? rows.map((r) => r.entry) : null
  }

  async listTranscriptSubkeys(key: { projectKey: string; sessionId: string }) {
    const { rows } = await this.pool.query<{ subpath: string }>(
      `SELECT DISTINCT subpath FROM ${this.s}.transcripts WHERE project_key = $1 AND session_id = $2 AND subpath <> ''`,
      [key.projectKey, key.sessionId],
    )
    return rows.map((r) => r.subpath)
  }

  async deleteTranscript(key: TranscriptKey) {
    if (key.subpath === undefined) {
      await this.pool.query(`DELETE FROM ${this.s}.transcripts WHERE project_key = $1 AND session_id = $2`, [key.projectKey, key.sessionId])
    } else {
      await this.pool.query(`DELETE FROM ${this.s}.transcripts WHERE project_key = $1 AND session_id = $2 AND subpath = $3`, [
        key.projectKey,
        key.sessionId,
        key.subpath,
      ])
    }
  }
}
