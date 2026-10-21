# Event coverage

Providers evolve: new event types, new content blocks, new stop reasons. This page explains how
`agent-runtime` makes sure such changes are **noticed** at upgrade time and **never silently lost**
at runtime, and lists what currently happens to every provider event.

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
   - an unknown content block is passed through inside `message.completed`;
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
| Claude Managed Agents | `packages/provider-managed-agents/src/coverage.ts` | `BetaManagedAgentsStreamSessionEvents['type']` and related SDK types |
| Claude Agent SDK | `packages/agentcore-runtime/src/claude-agent-sdk/coverage.ts` | `SDKMessage` `type` / `type/subtype`, assistant content block types, stream and delta types |
| agent-runtime protocol (AgentCore) | `switch` statements with a `never` check | `ClientCommand`, `ContainerMessage` |

### Why the Agent SDK table is in the container

With AgentCore, the Agent SDK runs **inside the container**, and the container code is ours: the
driver (`agentcore-runtime/claude-agent-sdk`) converts SDK messages into unified events *before*
they leave the container. So:

- **What the SDK can emit** is defined by the Agent SDK. The coverage table keeps us in sync with it.
- **What reaches your backend** is defined by our driver: only unified events, sent over our own
  protocol. The caller side (`provider-agentcore`) never sees raw SDK messages.

Because the container is deployed separately from your backend, the two can run different
versions. A newer container may emit a unified event type an older backend doesn't know. It is
still stored and delivered; frontends should ignore event types they don't recognise.

## Claude Managed Agents

Source: the [Managed Agents event reference](https://platform.claude.com/docs/en/managed-agents/reference)
and `@anthropic-ai/sdk` 0.137.

| Event | Handling | Becomes |
| --- | --- | --- |
| `event_start` | mapped | `message.start` |
| `event_delta` | mapped | `text.delta` / `thinking.delta` |
| `agent.message` | mapped | one `message.completed` per content block (including `redacted`), id `<event id>:<index>` |
| `agent.thinking` | mapped | `message.completed` with a thinking block assembled from deltas |
| `agent.tool_use` | mapped | `tool.call` (`builtin`); plus an approval request when `evaluated_permission` is `ask` |
| `agent.mcp_tool_use` | mapped | `tool.call` (`mcp`); plus an approval request when `ask` |
| `agent.custom_tool_use` | mapped | `tool.call` (`custom`) and a tool request to your handler |
| `agent.tool_result`, `agent.mcp_tool_result` | mapped | `tool.result` |
| `session.status_running` | mapped | `session.status: running` |
| `session.status_idle` | mapped | `turn.completed` (the runtime puts `session.status: idle` before it); `requires_action` → `session.status: requires_action` |
| `session.status_terminated`, `session.deleted` | mapped | `session.status: terminated` |
| `session.error` | mapped | `session.error` |
| `span.model_request_end` | mapped | token counts summed into `turn.completed.usage` |
| `session.usage` | mapped | cumulative cost → per-turn `turn.completed.usage.costUsd` |
| `user.message`, `user.interrupt`, `user.custom_tool_result`, `user.tool_confirmation`, `user.tool_result` | ignored | echoes; the runtime records `user.message`, `tool.result`, and `approval.resolved` itself |
| `system.message` | ignored | echo of `send(…, { system })`, which the runtime records on `user.message` |
| `user.define_outcome` | custom | |
| `agent.thread_context_compacted`, `agent.thread_message_received`, `agent.thread_message_sent` | custom | |
| `session.status_rescheduled`, `session.updated` | custom | |
| `session.thread_created`, `session.thread_status_*` | custom | |
| `span.model_request_start`, `span.outcome_evaluation_*` | custom | |
| `workflow_run.*` | custom | |

| Stop reason (`session.status_idle`) | `turn.completed.stopReason` |
| --- | --- |
| `end_turn` | `end_turn` |
| `requires_action` | *(no turn.completed; status `requires_action`)* |
| `retries_exhausted` | `error` |
| `budget_reached` | `budget` |
| `refusal` | `refusal` |

`evaluated_permission`: only `ask` creates an approval request; `allow` and `deny` were already
decided by the service.

> Because user events are ignored, user messages sent to a session **outside** the runtime (for
> example from the Anthropic Console) do not appear in the runtime's history.

## Claude Agent SDK

Source: `@anthropic-ai/claude-agent-sdk` 0.3.305.

| Message (`type` or `type/subtype`) | Handling | Becomes |
| --- | --- | --- |
| `assistant` | mapped | one event per content block (see below) |
| `user` | mapped | `tool.result` for tool results; your own prompts are recorded by the runtime |
| `stream_event` | mapped | `message.start`, `text.delta`, `thinking.delta` |
| `result/success` | mapped | `session.status: idle` + `turn.completed (end_turn)` |
| `result/error_during_execution`, `result/error_max_structured_output_retries` | mapped | `session.error` + `turn.completed (error)` |
| `result/error_max_turns` | mapped | `session.error` + `turn.completed (max_turns)` |
| `result/error_max_budget_usd` | mapped | `session.error` + `turn.completed (budget)` |
| `system/init`, `system/status`, `system/compact_boundary`, `conversation_reset`, `system/worker_shutting_down` | custom | |
| `system/api_retry`, `rate_limit_event`, `system/model_refusal_fallback`, `system/model_refusal_no_fallback`, `system/mirror_error` | custom | |
| `system/permission_denied`, `tool_use_summary`, `system/elicitation_complete` | custom | |
| `system/task_started`, `system/task_updated`, `system/task_progress`, `system/task_notification`, `system/background_tasks_changed` | custom | |
| `system/notification`, `system/informational`, `system/memory_recall`, `system/files_persisted`, `system/local_command_output` | custom | |
| `system/session_state_changed` | ignored | the runtime derives `session.status` itself |
| `tool_progress` | ignored | periodic heartbeat |
| `system/hook_started`, `system/hook_progress`, `system/hook_response`, `system/control_request_progress`, `system/plugin_install`, `system/commands_changed`, `system/thinking_tokens`, `auth_status`, `prompt_suggestion` | ignored | internal plumbing |

Set `forwardAllMessages: true` on the driver to forward the `ignored` ones as `provider.custom` too.

**Assistant content blocks:**

| Block types | Becomes |
| --- | --- |
| `tool_use`, `server_tool_use`, `mcp_tool_use` | `tool.call` (`custom` for your runtime tools, `mcp` for other MCP tools, otherwise `builtin`) |
| `text`, `thinking`, `redacted_thinking`, `compaction`, `fallback`, `container_upload`, `mcp_tool_result`, `mcp_tool_listing`, `web_search_tool_result`, `web_fetch_tool_result`, `advisor_tool_result`, `code_execution_tool_result`, `bash_code_execution_tool_result`, `text_editor_code_execution_tool_result`, `tool_search_tool_result` | `message.completed` with the block unchanged |

**Stream deltas:** `text_delta` becomes `text.delta` and `thinking_delta` becomes `thinking.delta`.
`input_json_delta`, `citations_delta`, `signature_delta`, and `compaction_delta` are not streamed;
their final content arrives in the assistant message.

## Known semantic gaps

These are preserved, as `provider.custom` or `raw`, but not yet modelled as first-class unified
events:

- **Thread lifecycle.** Events are attributed with `threadId`, but thread lifecycle (Managed Agents
  `session.thread_*`, Agent SDK `system/task_*`) is only available as `provider.custom`.
- **Compaction, retries, rate limits, and permission denials** are available only as
  `provider.custom`.
