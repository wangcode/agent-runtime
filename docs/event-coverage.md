# Event coverage

Providers evolve: new event types, new content blocks, new stop reasons. This page explains how
`agent-runtime` makes sure such changes are **noticed** at upgrade time and **never silently lost**
at runtime. The per-provider tables are linked under [Current mappings](#current-mappings).

## The rules

1. **One table per provider, one entry per type.** Each provider has a *coverage table* declaring,
   for every event type its SDK defines, one of:

   | Handling | Meaning |
   | --- | --- |
   | `mapped` | Converted into [unified events](event-model.md) |
   | `custom` | Kept as `provider.custom` with the full original payload (`data.name` is the provider's type) |
   | `ignored` | Dropped. Used only for echoes of what the runtime itself sent, and for pure noise |

2. **Upgrades fail the build until someone decides.** The tables are typed with
   `satisfies Record<SdkType, Handling>`, where `SdkType` is taken from the provider SDK's own type
   definitions. When an SDK upgrade adds a type, `pnpm typecheck` (and CI) fails with
   `Property 'new.type' is missing`. When it removes one, it fails with an unknown-property error.
   Fixing the build means making an explicit decision in the table.

3. **Runtime never drops the unknown.** If the live API sends something newer than the installed
   SDK knows about:
   - an unknown event or message type becomes `provider.custom`;
   - an unknown content block is passed through inside `agent.message.completed`;
   - an unknown stop reason is passed through as a string.

4. **Tests keep the code and the tables in sync.** Coverage tests run every table entry through the
   real mapper and check that the outcome matches the declaration: `mapped` produces unified
   events, `custom` produces `provider.custom`, `ignored` produces nothing. Fixtures for `mapped`
   types are typed by the table, so marking a new type `mapped` without a fixture also fails to
   compile.

The same applies to nested enumerations: stop reasons, permission values, delta types, and
content block types each have their own table.

## Upgrading a provider SDK

```bash
pnpm up @anthropic-ai/sdk            # or @anthropic-ai/claude-agent-sdk
pnpm typecheck                       # lists every new or removed type
```

For each error:

1. **Look up the new type** in the provider's documentation.
2. **Decide how to handle it.**
   - `custom` is always safe: nothing is lost, and the frontend can opt in later.
   - Choose `mapped` only when it fits an existing unified event; implement it in the mapper and
     add a fixture to the coverage test.
   - Choose `ignored` only for echoes or noise.
3. **Run the tests**: `pnpm test`.

If a new type means the provider is **waiting for an answer** (like a new kind of confirmation),
it must be `mapped` to a tool or approval request. Otherwise sessions will wait forever.

## Where the tables live

| Provider | File | Keyed by |
| --- | --- | --- |
| Claude Managed Agents | `packages/providers/managed-agents/src/coverage.ts` | `BetaManagedAgentsStreamSessionEvents['type']` and related SDK types |
| Claude Agent SDK | `packages/agentcore-runtime/src/claude-agent-sdk/coverage.ts` | `SDKMessage` `type` / `type/subtype`, assistant content block types, stream and delta types |
| agent-runtime protocol (AgentCore) | `switch` statements with a `never` check | `ClientCommand`, `ContainerMessage` |

### Why the Agent SDK table is in the container

With AgentCore, the Agent SDK runs **inside the container**, and the container code is ours: the
driver (`agentcore-runtime/claude-agent-sdk`) converts SDK messages into unified events *before*
they leave the container. So:

- **What the SDK can emit** is defined by the Agent SDK. The coverage table keeps us in sync with it.
- **What reaches your backend** is defined by our driver: only unified events, sent over our own
  protocol. The caller side (`providers-agentcore`) never sees raw SDK messages.

Because the container is deployed separately from your backend, the two can run different
versions. A newer container may emit a unified event type an older backend doesn't know. It is
still stored and delivered; frontends should ignore event types they don't recognise.

## Current mappings

The full tables, one row per provider type, live in each provider's guide:

| Provider | Mapping | Source |
| --- | --- | --- |
| Claude Managed Agents | [Managed Agents: event mapping](managed-agents.md#event-mapping) | `@anthropic-ai/sdk` 0.137, [event reference](https://platform.claude.com/docs/en/managed-agents/reference) |
| Claude Agent SDK | [Bedrock AgentCore: event mapping](agentcore.md#event-mapping) | `@anthropic-ai/claude-agent-sdk` 0.3.305 |

For the other direction (each unified event and which provider events produce it), see
[Event model: event list and sources](event-model.md#event-list-and-sources).

## Known semantic gaps

These are preserved, as `provider.custom` or `raw`, but not yet modelled as first-class unified
events:

- **Thread lifecycle.** Events are attributed with `threadId`, but thread lifecycle (Managed Agents
  `session.thread_*`, Agent SDK `system/task_*`) is only available as `provider.custom`.
- **Compaction, retries, rate limits, and permission denials** are available only as
  `provider.custom`.
