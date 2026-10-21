# agent-runtime

**One session API and one event stream for every agent provider.**

`agent-runtime` is a TypeScript library for Node.js backends that talk to hosted AI agents. It takes
care of the plumbing that every such backend ends up writing:

- **Keeping provider streams alive.** It holds the long-lived connection to the provider,
  reconnects with backoff, and resumes from a stored cursor.
- **Surviving frontend disconnects.** When a browser closes its SSE connection, the agent keeps
  working. Server-side tools still run, routine permissions are decided by policy, and approvals
  that need a human wait until someone answers or the timeout expires.
- **Running on many instances.** Any instance can serve any request. Commands are routed to the
  instance that holds the provider stream, events reach every instance, and clients resume with
  `Last-Event-ID`.
- **Recovering from crashes.** Session ownership is a lease. If the owning process dies, another
  instance takes over and finishes the work that was in flight.
- **Unifying provider behaviour.** Each provider's events *and* behaviour are mapped onto one
  [behaviour spec](docs/behavior-spec.md), verified by a conformance suite. Real differences are
  declared as capabilities instead of being silently ignored. The original payload stays available
  as `raw`.

Phase 1 supports **Claude Managed Agents** and **the Claude Agent SDK hosted on Amazon Bedrock
AgentCore**.

```ts
const session = await runtime.createSession({ provider: 'ma', config: { agent: 'agent_…', environmentId: 'env_…' } })
await session.send('Where is order 42?')

for await (const event of session.events({ after: lastEventId })) {
  res.write(toSSE(event)) // works on any instance, resumes without gaps or duplicates
}
```

---

## Table of contents

### Guides

| Guide | What you will learn |
| --- | --- |
| [Getting started](docs/getting-started.md) | Install, wire up a runtime, and serve SSE to a browser |
| [Architecture](docs/architecture.md) | Sessions, workers, leases, commands, and how the pieces fit together |
| [Behaviour spec](docs/behavior-spec.md) | The provider-independent contract: turns, messages, tools, approvals, capabilities |
| [Event model](docs/event-model.md) | Every event type, persisted vs. live events, and the SSE format |
| [Event coverage](docs/event-coverage.md) | What happens to every provider event, and how SDK upgrades are kept safe |
| [Tools and approvals](docs/tools-and-approvals.md) | Server-side custom tools, approval policies, human approvals, and timeouts |
| [Scaling and failover](docs/scaling-and-failover.md) | Running several instances, Postgres setup, crash recovery, and tuning |
| [Claude Managed Agents](docs/managed-agents.md) | How the Managed Agents provider connects, maps events, and reconnects |
| [Bedrock AgentCore](docs/agentcore.md) | Hosting the Claude Agent SDK on AgentCore: container, protocol, and deployment |
| [Writing a provider or driver](docs/extending.md) | Adding a new agent backend (Mastra and others) |

### Packages

| Package | Description |
| --- | --- |
| [`@agent-runtime/core`](packages/core/README.md) | The runtime: event model, `Runtime`/`Session` API, orchestration, in-memory store, RxJS adapter, and test helpers |
| [`@agent-runtime/store-postgres`](packages/store-postgres/README.md) | Postgres storage and cross-instance notifications via `LISTEN/NOTIFY` |
| [`@agent-runtime/provider-managed-agents`](packages/provider-managed-agents/README.md) | Provider for Claude Managed Agents |
| [`@agent-runtime/provider-agentcore`](packages/provider-agentcore/README.md) | Provider for agents running on Bedrock AgentCore (caller side) |
| [`@agent-runtime/agentcore-runtime`](packages/agentcore-runtime/README.md) | Server that runs inside the AgentCore container, plus the Claude Agent SDK driver |
| [`@agent-runtime/protocol`](packages/protocol/README.md) | WebSocket protocol shared by the two AgentCore packages |
| [`@agent-runtime/conformance`](packages/conformance/README.md) | *(private)* Scenarios every provider must pass to behave identically |

### Examples

| Example | Description |
| --- | --- |
| [`examples/express-sse`](examples/express-sse/README.md) | An Express backend with SSE, resume, approvals, and a simulated agent |
| [`examples/agentcore-container`](examples/agentcore-container/README.md) | Dockerfile and entrypoint for an AgentCore container running the Claude Agent SDK |

---

## Status

| Area | State |
| --- | --- |
| Core runtime, Postgres store | Implemented and tested, including multi-instance and takeover tests against a real Postgres |
| Managed Agents provider | Implemented and tested against a mocked API. Not yet verified against the live service |
| AgentCore provider and container runtime | Implemented and tested end to end with a local container and a mocked Agent SDK. Not yet deployed to AWS |
| Managed Agents webhooks | Under discussion (see [Managed Agents: open questions](docs/managed-agents.md#open-questions)) |

## Development

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm test                       # Postgres tests are skipped unless a database is configured
AGENT_RUNTIME_PG_URL=postgres://postgres@localhost:5432/postgres pnpm test
```

The monorepo uses pnpm workspaces, tsup (ESM + CJS builds), and vitest. Tests never call external
services: they use a scriptable fake provider, a mocked Anthropic client, a real container server
driven by a mocked Agent SDK, and an optional local Postgres.
