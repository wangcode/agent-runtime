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

**Start here**

| Guide | What you will learn |
| --- | --- |
| [Concepts](docs/concepts.md) | The terms used everywhere: runtime, session, turn, owner, command, action, capability |
| [Getting started](docs/getting-started.md) | A working SSE backend in one file, then real providers and Postgres |

**Building an application**

| Guide | What you will learn |
| --- | --- |
| [Frontend guide](docs/frontend-guide.md) | Consuming the event stream in a browser: reducer, rendering, approvals, reconnects |
| [Event model](docs/event-model.md) | Every event type and field, where each one comes from in every provider, with examples |
| [NestJS](docs/nestjs.md) | Registering the runtime in a NestJS app, SSE routes, shutdown |
| [Tools and approvals](docs/tools-and-approvals.md) | Custom tools, approval policies, human approvals, timeouts, `updatedInput` |

**Providers**

| Guide | What you will learn |
| --- | --- |
| [Claude Managed Agents](docs/managed-agents.md) | Agent setup, how the provider connects and maps events, capabilities, rate limits |
| [Bedrock AgentCore](docs/agentcore.md) | Hosting the Claude Agent SDK on AgentCore: container, session config, AWS deployment |

**Running in production**

| Guide | What you will learn |
| --- | --- |
| [Scaling and failover](docs/scaling-and-failover.md) | Multiple instances, what happens when one dies, capacity |
| [Operations](docs/operations.md) | Configuration reference, logging, troubleshooting, maintenance, security |

**How it works and extending it**

| Guide | What you will learn |
| --- | --- |
| [Behaviour spec](docs/behavior-spec.md) | The provider-independent contract every provider satisfies |
| [Architecture](docs/architecture.md) | Workers, leases, commands, normalization, delivery guarantees |
| [Event coverage](docs/event-coverage.md) | What happens to every provider event type, and how SDK upgrades stay safe |
| [Writing a provider or driver](docs/extending.md) | Adding a new agent backend, step by step |

### Packages

| Package | Description |
| --- | --- |
| [`@agent-runtime/core`](packages/core/README.md) | The runtime: event model, `Runtime`/`Session` API, orchestration, in-memory store, RxJS adapter, and test helpers |
| [`@agent-runtime/store-postgres`](packages/store-postgres/README.md) | Postgres storage and cross-instance notifications via `LISTEN/NOTIFY` |
| [`@agent-runtime/provider-managed-agents`](packages/provider-managed-agents/README.md) | Provider for Claude Managed Agents |
| [`@agent-runtime/provider-agentcore`](packages/provider-agentcore/README.md) | Provider for agents running on Bedrock AgentCore (caller side) |
| [`@agent-runtime/agentcore-runtime`](packages/agentcore-runtime/README.md) | Server that runs inside the AgentCore container, plus the Claude Agent SDK driver |
| [`@agent-runtime/protocol`](packages/protocol/README.md) | WebSocket protocol shared by the two AgentCore packages |
| [`@agent-runtime/nestjs`](packages/nestjs/README.md) | NestJS module, `@Sse()` helpers with resume, and an exception filter |
| [`@agent-runtime/conformance`](packages/conformance/README.md) | *(private)* Scenarios every provider must pass to behave identically |

### Examples

| Example | Description |
| --- | --- |
| [`examples/express-sse`](examples/express-sse/README.md) | An Express backend with SSE, resume, approvals, and a simulated agent |
| [`examples/nestjs`](examples/nestjs/README.md) | The same API as a NestJS app, using `@agent-runtime/nestjs` |
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

Read these docs as a website: `pnpm docs:dev`, then open http://localhost:5173.

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
