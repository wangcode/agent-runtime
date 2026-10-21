# Operations

Configuration, logging, troubleshooting and maintenance for running `agent-runtime` in production.
For multi-instance setup and failover, see [Scaling and failover](scaling-and-failover.md).

## Configuration reference

All runtime options are passed to `createRuntime()`.

| Option | Default | What it controls | When to change it |
| --- | --- | --- | --- |
| `store` | *required* | Where state is kept | `PgStore` in production |
| `bus` | *required* | Cross-instance notifications | `PgBus` in production |
| `providers` | *required* | `{ key: adapter }` | — |
| `tools` | `{}` | Custom tool handlers | — |
| `approvals.policy` | always `'ask'` | Automatic permission decisions | — |
| `approvals.timeoutMs` | 10 min | How long an approval waits for a human | Match your UI's expectations |
| `approvals.defaultOnTimeout` | `'deny'` | Decision when nobody answers | Rarely; `'allow'` is unsafe for most tools |
| `instanceId` | random UUID | Identity of this process in leases and logs | Set to the pod/host name for readable logs. Must be unique |
| `lease.ttlMs` | 15 000 | How long ownership survives without renewal | Lower for faster failover; higher if the database is slow or far away |
| `lease.renewIntervalMs` | ttl ÷ 3 | Renewal frequency | Keep well below `ttlMs` |
| `idleReleaseMs` | 60 000 | How long an idle session keeps its provider connection | Lower to save connections; higher if users reply quickly |
| `orphanScanIntervalMs` | 5 000 | How often each instance looks for sessions to take over | Lower for faster failover, at the cost of more queries |
| `pollIntervalMs` | 2 000 | Safety-net polling for subscribers and command waiters | Only if notifications are unreliable |
| `commandTimeoutMs` | 60 000 | How long `send()`, `interrupt()`, … wait for execution | Raise if providers are slow to accept messages |
| `toolCallWaitMs` | 2 000 | How long a tool result waits for its `tool.call` when a provider reports them out of order | Rarely |
| `reconnect.baseMs` / `maxMs` | 500 / 30 000 | Backoff when the provider connection fails | — |
| `logger` | silent | Where log lines go | Always set in production |

Provider options are listed in each provider's README:
[Managed Agents](../packages/provider-managed-agents/README.md#provider-options),
[AgentCore](../packages/provider-agentcore/README.md#options).

## Logging

Pass any object with `debug`, `info`, `warn`, and `error` methods. Each method receives a message
and a metadata object, usually containing `sessionId`:

```ts
import pino from 'pino'
const log = pino()
createRuntime({
  // …
  instanceId: process.env.HOSTNAME,
  logger: {
    debug: (msg, meta) => log.debug(meta, msg),
    info: (msg, meta) => log.info(meta, msg),
    warn: (msg, meta) => log.warn(meta, msg),
    error: (msg, meta) => log.error(meta, msg),
  },
})
```

Pass the same logger to `PgBus` and the provider adapters (their `logger` option).

### What the messages mean

| Level | Message | Meaning | Action |
| --- | --- | --- | --- |
| warn | `provider connection failed` | The provider stream failed; reconnecting with backoff | Investigate if it repeats for one session |
| warn | `managed agents stream failed` | Same, from the Managed Agents adapter, with the API error | Check API status, rate limits, API key |
| warn | `agentcore connection failed` | Could not open or keep the AgentCore WebSocket | Check IAM permissions, runtime ARN, region |
| info | `provider stream ended` | The provider closed the session (e.g. deleted); the worker stops | — |
| warn | `command failed` | A `send`/`interrupt`/… was rejected by the provider; the caller got `CommandError` | See the error in the metadata |
| warn | `delivering action result failed` | A tool result or approval decision could not be sent; retried, and re-sent by the next owner if needed | Investigate if persistent |
| warn | `lease lost` | Another instance took this session (this one was too slow to renew) | Check database latency and event-loop blocking |
| warn | `lease renew failed` | Database error while renewing | Check database health |
| warn | `orphan scan failed` | Database error while looking for sessions to take over | Check database health |
| warn | `tool.call never arrived; emitting dependent events anyway` | A provider sent a tool result without the call | Report to the adapter's maintainers |
| warn | `bus connection error` / `bus connect failed` | The `LISTEN` connection dropped; reconnecting. Delivery continues by polling meanwhile | Check database connectivity |
| warn | `bus payload too large; dropped` | A notification over 8 KB was dropped. Persisted events are unaffected | — |
| error | `approval policy threw; asking instead` | Your policy has a bug; the call went to a human | Fix the policy |
| error | `approval policy returned updatedInput, …` | Your policy used `updatedInput` on a provider that doesn't allow it | Fix the policy or enable the capability |
| error | `session worker crashed` | Unexpected error in the worker; the session is picked up again by an orphan scan | Report it |
| debug | `releasing idle session` | Normal idle release | — |

## Troubleshooting

| Symptom | Likely cause | What to check |
| --- | --- | --- |
| `send()` throws `CommandError: Timed out waiting for send to be executed` | No instance can own the session (all crashed or overloaded), or the provider is slow to accept | The command stays queued and runs when an owner appears. Check instance health and `command failed` logs |
| `send()` throws `CommandError` with a provider message | The provider rejected the message (invalid content, session archived, rate limit) | The message text |
| `send()` throws `Session … is terminated` | The session was terminated | Create a new session |
| `resolveApproval` throws `already resolved` | Someone else answered, the policy decided, or the timeout fired | Normal; refresh the UI |
| `resolveApproval` throws `CapabilityError` | `updatedInput` on a provider that doesn't allow it | `session.capabilities()` |
| Browser receives no events | `EventSource` uses `onmessage`, but every frame has a named event | Use `addEventListener('<type>')` ([Frontend guide](frontend-guide.md)) |
| Events arrive with a few seconds' delay | Bus notifications aren't reaching this instance; delivery falls back to polling | `PgBus` must reach Postgres directly or through a session-mode pooler, not a transaction-mode pooler |
| Session stuck in `running` with nothing happening | Provider connection keeps failing, or a custom tool handler never returns | `provider connection failed` logs; your handler's timeouts |
| Session stuck in `requires_action` | An approval waits for a human; or a Managed Agents custom tool is still running | `session.pendingApprovals()`, handler logs |
| Thinking text is empty or partial (Managed Agents) | Managed Agents only exposes thinking through live deltas, which are lost on reconnect | Expected (`thinkingContent: 'best_effort'`) |
| A tool handler ran twice | An instance crashed during the call; the next owner re-ran it | Make handlers idempotent with `ctx.toolUseId` |

## Inspecting state in Postgres

All tables live in the `agent_runtime` schema, unless you configured another.

```sql
-- Who owns which busy session, and until when
SELECT id, provider, status, owner_instance, lease_expires_at, last_seq, updated_at
FROM agent_runtime.sessions WHERE status <> 'idle' ORDER BY updated_at DESC LIMIT 50;

-- The event log of one session
SELECT seq, type, data, created_at FROM agent_runtime.events WHERE session_id = $1 ORDER BY seq;

-- Commands that have not been executed
SELECT * FROM agent_runtime.commands WHERE status = 'pending' ORDER BY created_at;

-- Tool calls and approvals still open
SELECT session_id, kind, name, status, delivered, expires_at
FROM agent_runtime.actions WHERE status = 'pending' OR NOT delivered;
```

## Maintenance

**Retention.** Nothing is deleted automatically. Deleting a session row deletes its events,
commands, and actions (`ON DELETE CASCADE`). Agent SDK transcripts are keyed separately:

```sql
-- Sessions untouched for 90 days
DELETE FROM agent_runtime.sessions WHERE updated_at < now() - interval '90 days';

-- Executed commands older than 7 days (they are only needed while pending)
DELETE FROM agent_runtime.commands WHERE status <> 'pending' AND created_at < now() - interval '7 days';
```

Terminate or archive sessions at the provider before deleting them here.

**Migrations.** `migrate(pool)` applies new migrations when you upgrade. It takes an advisory
lock, so every instance can call it at boot. To use your own migration tool, take the SQL from
`migrationSql()`.

**Upgrading provider SDKs.** `pnpm typecheck` fails if a new SDK version adds event types the
runtime doesn't handle yet. See [Event coverage](event-coverage.md#upgrading-a-provider-sdk).

## Security notes

- **Access control is yours.** The runtime does not authenticate users. Your routes must check that
  the caller may access the session; store the owner in `metadata` when you create it.
- **Tool handlers run with your backend's privileges.** Validate inputs; the model chooses them.
- **Raw payloads.** `raw` on events contains provider payloads. `toSSE()` leaves it out by default;
  keep it that way for browsers.
- **Approvals.** `defaultOnTimeout: 'allow'` lets tools run when nobody answers. Use it only for
  harmless tools. Enable `allowUpdatedInput` only if your approval UI shows the final input.
