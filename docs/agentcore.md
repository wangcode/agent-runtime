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

`config` is sent to the container. For the Claude Agent SDK driver, `config.options` is
shallow-merged over the driver's base SDK options.

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
| Typing effect | `includePartialMessages: true`; stream events become `text.delta` / `thinking.delta` |
| Your custom tools | Exposed to the SDK as an in-process MCP server named `runtime`; each call is forwarded to your backend's handler. The SDK sees them as `mcp__runtime__<name>`; events show the plain name |
| Permissions | `canUseTool` forwards to your backend's approval policy; the session shows `requires_action` while waiting |
| Bedrock | Configure through `env` (`CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, optional `ANTHROPIC_DEFAULT_*_MODEL`) |
| Resume | The SDK session id is derived from the runtime session id. The transcript is stored through `sessionStore`; if a transcript exists when a new microVM starts, the SDK resumes it |
| Interrupt | `query.interrupt()`; the turn ends with `stopReason: 'interrupted'` |
| Approving with modified input | Supported by the SDK, but **off by default**: enable with `agentCore({ allowUpdatedInput: true })`. The setting is sent to the container, which ignores `updatedInput` unless it is enabled |
| Sub-agents | Messages from sub-agents carry `threadId` (the id of the Task tool call that started them) |
| Event mapping | Driven by a coverage table over every SDK message type, content block, and delta; see [Event coverage](event-coverage.md) |

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

## Not yet verified on AWS

The integration is tested end to end against a local container with a mocked Agent SDK. Before
production, verify against a real deployment: SigV4 handshake, IAM permissions, Bedrock model
access, and the transcript resume path. Browser-direct connections (presigned URLs) are not
implemented.
