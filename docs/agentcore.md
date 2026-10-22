# Claude Agent SDK on Bedrock AgentCore

[Amazon Bedrock AgentCore Runtime](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/)
runs your agent code in a container, with one isolated microVM per session. `agent-runtime`
provides **both ends** of that setup:

| Side | Package | Runs |
| --- | --- | --- |
| Caller | [`@agent-runtime/provider-agentcore`](../packages/provider-agentcore/README.md) | In your backend, as a runtime provider |
| Container | [`@agent-runtime/agentcore-runtime`](../packages/agentcore-runtime/README.md) | Inside the AgentCore container, hosting the Claude Agent SDK |

They talk over a WebSocket using [`@agent-runtime/protocol`](../packages/protocol/README.md).

```
your backend                                   AgentCore microVM (one per session)
┌──────────────────────┐   WebSocket (SigV4)   ┌──────────────────────────────────┐
│ runtime              │ ────────────────────▶ │ agentcore-runtime server :8080   │
│  AgentCoreProvider   │ ◀──────────────────── │  ContainerSession (replay log)   │
│  tool handlers ◀─────┼── tool_request ────── │   ClaudeAgentSdkDriver           │
│  approval policy ◀───┼── approval_request ── │    Claude Agent SDK ─▶ Bedrock   │
│  Postgres ◀──────────┼── store_request ───── │    (transcript via sessionStore) │
└──────────────────────┘                       └──────────────────────────────────┘
```

## Why two halves?

AgentCore gives you a container and a connection to it. Everything else is up to you: what flows
over the connection, what happens when it drops, how tools and approvals reach your backend. The
container half answers those questions in a way the caller half understands:

- **Tools and approvals run in your backend.** The container never holds your business logic or
  your users' permission decisions. It asks the caller for them.
- **The agent survives disconnects.** The container keeps a log of every event, and replays what
  the caller missed when it reconnects.
- **The conversation survives the microVM.** The Agent SDK transcript is mirrored into your
  Postgres. If AWS replaces the microVM (idle timeout, 8-hour limit), the next one resumes the
  conversation from there.

## Caller side

```ts
import { agentCore } from '@agent-runtime/provider-agentcore'

const runtime = createRuntime({
  // …
  providers: {
    ac: agentCore({
      endpoint: {
        region: 'us-west-2',
        runtimeArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my_agent-abc',
        qualifier: 'DEFAULT', // optional
      },
      // credentials: defaults to the AWS default provider chain
    }),
  },
})

const session = await runtime.createSession({
  provider: 'ac',
  config: { options: { model: 'claude-sonnet-5-5', systemPrompt: 'You are a support agent.', maxTurns: 20 } },
})
```

### Session config

`config` travels to the container as JSON in the WebSocket handshake. For the Claude Agent SDK
driver, `config.options` is shallow-merged over the driver's base SDK options:

| Put in `config.options` (per session) | Put in the container's base options (per deployment) |
| --- | --- |
| `model`, `systemPrompt`, `maxTurns`, `allowedTools`, `permissionMode` and other plain values | anything that is a function or object instance: `hooks`, `mcpServers` with in-process servers, `canUseTool`; plus `env`, `cwd` |

Options that cannot be serialized don't survive the trip, so keep them in the container.

The IAM principal needs `bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream` on the runtime.
For runtimes with a JWT authorizer, pass `bearerToken: () => getToken()` instead of credentials.

## Container side

```ts
import { startAgentCoreServer } from '@agent-runtime/agentcore-runtime'
import { claudeAgentSdkDriver } from '@agent-runtime/agentcore-runtime/claude-agent-sdk'

await startAgentCoreServer({
  driver: claudeAgentSdkDriver({
    options: {
      cwd: '/workspace',
      allowedTools: ['Read', 'Glob', 'Grep'],
      env: { ...process.env, CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-west-2' },
    },
  }),
})
```

This serves the three endpoints AgentCore expects on port 8080:

| Endpoint | Purpose |
| --- | --- |
| `GET /ping` | Health. Returns `HealthyBusy` while a turn, tool call, or approval is in flight, otherwise `Healthy`. The timestamp only changes on transitions, so AgentCore can reclaim idle microVMs |
| `GET /ws` | The agent-runtime WebSocket protocol, used by the caller side |
| `POST /invocations` | Simple HTTP fallback: `{ sessionId?, prompt }` runs one turn and streams events as SSE. Tools and approvals need a WebSocket client |

A ready-made Dockerfile is in [`examples/agentcore-container`](../examples/agentcore-container/README.md).
AgentCore requires **ARM64** images.

## What the Claude Agent SDK driver does

| Concern | How it is handled |
| --- | --- |
| Multi-turn conversation | The SDK runs in streaming-input mode; each `send()` pushes a user message into the open session |
| Typing effect | `includePartialMessages: true`; stream events become `agent.text.delta` / `agent.thinking.delta` |
| Your custom tools | Exposed to the SDK as an in-process MCP server named `runtime`; each call is forwarded to your backend's handler. The SDK sees them as `mcp__runtime__<name>`; events show the plain name |
| Permissions | `canUseTool` forwards to your backend's approval policy; the session shows `requires_action` while waiting |
| Bedrock | Configure through `env` (`CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, optional `ANTHROPIC_DEFAULT_*_MODEL`) |
| Resume | The SDK session id is derived from the runtime session id. The transcript is stored through `sessionStore`; if a transcript exists when a new microVM starts, the SDK resumes it |
| System context | The SDK has no mid-conversation system role, so `send(…, { system })` appends a `<system-reminder>…</system-reminder>` text block to the user message (`systemMessages: 'emulated'`). It stays in the transcript and applies to later turns |
| Interrupt | `query.interrupt()`; the turn ends with `stopReason: 'interrupted'` |
| Approving with modified input | Supported by the SDK, but **off by default**: enable with `agentCore({ allowUpdatedInput: true })`. The setting is sent to the container, which ignores `updatedInput` unless it is enabled |
| Sub-agents | Messages from sub-agents carry `threadId` (the id of the Task tool call that started them) |
| Event mapping | Every SDK message becomes unified events or `provider.custom`; see [Event mapping](#event-mapping) |

## Event mapping

With AgentCore, the Agent SDK runs inside the container, and the
[driver](#what-the-claude-agent-sdk-driver-does) converts its messages into
[unified events](event-model.md#event-list-and-sources) **before** they leave the container. Your
backend only ever receives unified events. The tables below match the coverage tables in
`packages/agentcore-runtime/src/claude-agent-sdk/coverage.ts`. An SDK upgrade that adds a message
type, content block, or delta fails the build until it is added there (see
[Event coverage](event-coverage.md)). A message type the installed SDK doesn't know becomes
`provider.custom`.

**SDK messages**

| SDK message (`type` or `type/subtype`) | Our event | Notes |
| --- | --- | --- |
| **Conversation** | | |
| `assistant` | one event per content block (table below) |  |
| `user` | `tool.result` for each `tool_result` block | other user content is the SDK echoing our prompt, which the runtime already recorded as `user.message` |
| `stream_event` | `agent.message.start`, `agent.text.delta`, `agent.thinking.delta` | live; see stream events below |
| `result/success` | `session.status: idle` + `turn.completed` | usage and `costUsd` from the result |
| `result/error_during_execution` | `session.error` + `turn.completed` |  |
| `result/error_max_turns` | `session.error` + `turn.completed` |  |
| `result/error_max_budget_usd` | `session.error` + `turn.completed` |  |
| `result/error_max_structured_output_retries` | `session.error` + `turn.completed` |  |
| **Session lifecycle and context** | | |
| `system/init` | `provider.custom` |  |
| `system/status` | `provider.custom` |  |
| `system/compact_boundary` | `provider.custom` |  |
| `conversation_reset` | `provider.custom` |  |
| `system/worker_shutting_down` | `provider.custom` |  |
| `system/session_state_changed` | – (ignored) | the runtime derives `session.status` itself |
| **Reliability** | | |
| `system/api_retry` | `provider.custom` |  |
| `rate_limit_event` | `provider.custom` |  |
| `system/model_refusal_fallback` | `provider.custom` |  |
| `system/model_refusal_no_fallback` | `provider.custom` |  |
| `system/mirror_error` | `provider.custom` |  |
| **Permissions and tools** | | |
| `system/permission_denied` | `provider.custom` |  |
| `tool_use_summary` | `provider.custom` |  |
| `tool_progress` | – (ignored) | periodic heartbeat while a tool runs |
| `system/elicitation_complete` | `provider.custom` |  |
| **Sub-agents and background tasks** | | |
| `system/task_started` | `provider.custom` |  |
| `system/task_updated` | `provider.custom` |  |
| `system/task_progress` | `provider.custom` |  |
| `system/task_notification` | `provider.custom` |  |
| `system/background_tasks_changed` | `provider.custom` |  |
| **Informational** | | |
| `system/notification` | `provider.custom` |  |
| `system/informational` | `provider.custom` |  |
| `system/memory_recall` | `provider.custom` |  |
| `system/files_persisted` | `provider.custom` |  |
| `system/local_command_output` | `provider.custom` |  |
| **Internal plumbing** | | |
| `system/hook_started` | – (ignored) |  |
| `system/hook_progress` | – (ignored) |  |
| `system/hook_response` | – (ignored) |  |
| `system/control_request_progress` | – (ignored) |  |
| `system/plugin_install` | – (ignored) |  |
| `system/commands_changed` | – (ignored) |  |
| `system/thinking_tokens` | – (ignored) |  |
| `auth_status` | – (ignored) |  |
| `prompt_suggestion` | – (ignored) |  |

`ignored` messages are dropped as noise. Set `forwardAllMessages: true` on the driver to forward
them as `provider.custom` too.

**Content blocks of `assistant` messages.** Each block becomes its own event, with message id
`<API message id>:<block index>`. Messages from a sub-agent get `threadId` set to the
`parent_tool_use_id`.

| Content block | Our event |
| --- | --- |
| `tool_use` | `tool.call`: `kind: custom` for your runtime tools (`mcp__runtime__<name>`, reported with the plain name), `kind: mcp` for other `mcp__…` tools, `kind: builtin` otherwise |
| `server_tool_use` | `tool.call` (`kind: builtin`) |
| `mcp_tool_use` | `tool.call` (`kind: mcp`) |
| `text` | `agent.message.completed` with the block unchanged |
| `thinking` | `agent.message.completed` with the block unchanged |
| `redacted_thinking` | `agent.message.completed` with the block unchanged |
| `compaction` | `agent.message.completed` with the block unchanged |
| `fallback` | `agent.message.completed` with the block unchanged |
| `container_upload` | `agent.message.completed` with the block unchanged |
| `mcp_tool_result` | `agent.message.completed` with the block unchanged |
| `mcp_tool_listing` | `agent.message.completed` with the block unchanged |
| `web_search_tool_result` | `agent.message.completed` with the block unchanged |
| `web_fetch_tool_result` | `agent.message.completed` with the block unchanged |
| `advisor_tool_result` | `agent.message.completed` with the block unchanged |
| `code_execution_tool_result` | `agent.message.completed` with the block unchanged |
| `bash_code_execution_tool_result` | `agent.message.completed` with the block unchanged |
| `text_editor_code_execution_tool_result` | `agent.message.completed` with the block unchanged |
| `tool_search_tool_result` | `agent.message.completed` with the block unchanged |
| anything newer | `agent.message.completed` with the block unchanged |

**Stream events** (inside `stream_event`, live only):

| Stream event / delta | Our event |
| --- | --- |
| `message_start` | none (remembers the message id for the deltas) |
| `content_block_start` (text or thinking) | `agent.message.start` |
| `content_block_delta` `text_delta` | `agent.text.delta` |
| `content_block_delta` `thinking_delta` | `agent.thinking.delta` |
| `input_json_delta`, `citations_delta`, `signature_delta`, `compaction_delta` | none: the final content arrives in the `assistant` message |
| `content_block_stop`, `message_delta`, `message_stop` | none |

**Stop reasons** (`result` subtype):

| `result` subtype | `turn.completed.stopReason` |
| --- | --- |
| `success` | `end_turn` |
| `error_during_execution` | `error` |
| `error_max_turns` | `max_turns` |
| `error_max_budget_usd` | `budget` |
| `error_max_structured_output_retries` | `error` |

After an interrupt the stop reason is always `interrupted`.

**Outside SDK messages.** Two driver callbacks also produce events: `canUseTool` waiting for a
decision produces `session.status: requires_action` and an approval request, and an exception from
the SDK produces `session.error`.

### What the container sends to your backend

| Protocol message | What the runtime does |
| --- | --- |
| `event` | Stores (or, for live deltas, forwards) the unified event as is |
| `tool_request` | Runs your tool handler and replies with `tool_result`; the result is recorded as `tool.result` |
| `approval_request` | Runs your approval policy (`approval.requested` when it says `ask`) and replies with `approval_decision` |
| `store_request` | Reads or writes the SDK transcript in your `Store` |
| `ack`, `error` | Completes or fails the pending command |

## Local development

Run the container code on your machine and point the caller at it, with no AWS involved:

```bash
pnpm --filter @agent-runtime/example-agentcore-container start   # serves :8080
```

```ts
import WebSocket from 'ws'
agentCore({ connectWebSocket: () => new WebSocket('ws://localhost:8080/ws') })
```

The SDK inside still needs model access. Set AWS credentials with Bedrock access (or remove
`CLAUDE_CODE_USE_BEDROCK` and set `ANTHROPIC_API_KEY` for local testing).

## Connection lifecycle

1. **Connect.** The caller opens the WebSocket with the header
   `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id: agent-runtime-<session id>`. The same header
   always reaches the same microVM.
2. **Handshake.** The caller sends `hello` with the last `(bootId, seq)` it saw. The container
   answers `welcome`, replays events after `seq`, and re-sends any tool, approval, or store
   requests that are still waiting.
3. **Rotation.** AgentCore limits a WebSocket to 60 minutes, so the caller reconnects proactively
   after 55 minutes (`maxConnectionMs`). The handshake makes this seamless.
4. **New microVM.** If the `bootId` in `welcome` differs from the stored one, the old microVM is
   gone. Pending requests are cancelled (`actions_reset`), and the driver resumes from the stored
   transcript on the next message.
5. **Idle release.** When the runtime releases an idle session, the WebSocket closes. The microVM
   reports `Healthy` and is reclaimed by AgentCore after its idle timeout (default 15 minutes).

## Limits to keep in mind

| Limit | Value | How it is handled |
| --- | --- | --- |
| WebSocket frame size | 32–64 KB (docs disagree) | Messages over 30 KB are split into chunks |
| WebSocket duration | 60 minutes | Proactive reconnect at 55 minutes |
| Session id length | 33–256 characters | `agent-runtime-` prefix, padded if needed |
| Session idle timeout | 15 minutes by default (configurable 60 s – 8 h) | `/ping` reports busy only while work is in flight |
| Session max lifetime | 8 hours | Transcript resume on the next microVM |

## Deploying to AWS

### 1. Build and push the image

AgentCore runs **ARM64** images that listen on `0.0.0.0:8080`.

```bash
docker build --platform linux/arm64 -f examples/agentcore-container/Dockerfile -t agent-runtime-container .
aws ecr create-repository --repository-name agent-runtime-container
aws ecr get-login-password | docker login --username AWS --password-stdin <account>.dkr.ecr.<region>.amazonaws.com
docker tag agent-runtime-container <account>.dkr.ecr.<region>.amazonaws.com/agent-runtime-container:latest
docker push <account>.dkr.ecr.<region>.amazonaws.com/agent-runtime-container:latest
```

### 2. Create an execution role for the container

The runtime assumes this role. It needs to pull the image, write logs, and call Bedrock models.
Trust principal: `bedrock-agentcore.amazonaws.com`.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["ecr:GetAuthorizationToken", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"], "Resource": "*" },
    { "Effect": "Allow", "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], "Resource": "*" }
  ]
}
```

Narrow `Resource` to your model ARNs, repository and log group in production.

### 3. Create the agent runtime

Create it in the AgentCore console, or with the `CreateAgentRuntime` API, from the image URI and
the execution role. Note the **runtime ARN**. Set the session idle timeout to suit your traffic:
the default is 15 minutes.

> The exact console steps and CLI flags change with AgentCore releases; follow the
> [AgentCore Runtime documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/)
> for this step.

### 4. Allow your backend to connect

The identity your backend runs as (task role, instance profile, …) needs:

```json
{
  "Effect": "Allow",
  "Action": "bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream",
  "Resource": ["arn:aws:bedrock-agentcore:<region>:<account>:runtime/<runtime-id>", "arn:aws:bedrock-agentcore:<region>:<account>:runtime/<runtime-id>/*"]
}
```

### 5. Point the provider at it

```ts
agentCore({ endpoint: { region: '<region>', runtimeArn: '<runtime ARN>' } })
```

Credentials come from the AWS default provider chain unless you pass `credentials`.

### Verification status

The integration is tested end to end against a local container with a mocked Agent SDK; it has
not yet run against a real AgentCore deployment. Check these first in a real deployment: the SigV4
WebSocket handshake, IAM permissions, Bedrock model access, and transcript resume after a
microVM replacement. Browser-direct connections (presigned URLs) are not implemented.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `agentcore connection failed` with `HTTP 403` | The caller's IAM permission (step 4) and the runtime ARN/region |
| `HTTP 404` on connect | Runtime ARN, region, `qualifier` |
| Connects, but the first `send()` times out | Container logs: the driver may fail to start (missing Bedrock access, wrong model id) |
| Every message starts a fresh conversation | Transcripts are not being stored: check `persistTranscript` and the backend's database |
| microVM never goes idle (cost) | Something keeps it busy: a pending approval or a custom tool that never returns |
| Tools/approvals never answered after a long pause | The microVM was replaced: pending requests are cancelled (`approval.resolved` with `by: 'system'`); the user can continue with a new message |
