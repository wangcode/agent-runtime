# @agent-runtime/provider-agentcore

The caller-side half of the Bedrock AgentCore integration. Your backend uses it as a runtime
provider. It connects over a WebSocket to a container running
[`@agent-runtime/agentcore-runtime`](../agentcore-runtime/README.md).

## Install

```bash
pnpm add @agent-runtime/provider-agentcore
```

## Usage

```ts
import { createRuntime } from '@agent-runtime/core'
import { agentCore } from '@agent-runtime/provider-agentcore'

const runtime = createRuntime({
  store,
  bus,
  providers: {
    ac: agentCore({
      endpoint: {
        region: 'us-west-2',
        runtimeArn: 'arn:aws:bedrock-agentcore:us-west-2:123456789012:runtime/my_agent-abc',
      },
    }),
  },
  tools: { /* run in your backend when the agent calls them */ },
})

const session = await runtime.createSession({
  provider: 'ac',
  config: { options: { model: 'claude-sonnet-5-5', maxTurns: 20 } }, // forwarded to the container driver
})
```

### Local development

Point the provider at a container running on your machine instead of AWS:

```ts
import WebSocket from 'ws'

agentCore({ connectWebSocket: () => new WebSocket('ws://localhost:8080/ws') })
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `endpoint` | — | `{ region, runtimeArn, qualifier?, host? }`. Required unless `connectWebSocket` is given |
| `credentials` | AWS default chain | Credentials, or a credential provider, for SigV4 signing |
| `bearerToken` | — | `() => token`; use OAuth bearer auth instead of SigV4 (runtimes with a JWT authorizer) |
| `connectWebSocket` | — | Custom socket factory, for local containers and tests |
| `maxConnectionMs` | 55 min | Reconnect before AgentCore's 60-minute WebSocket limit |
| `commandTimeoutMs` | 30 s | How long a command waits for a live connection and an acknowledgement |
| `allowUpdatedInput` | `false` | Let approvals change the tool's input (`resolveApproval(id, { behavior: 'allow', updatedInput })`). Off by default; enable it only if your approval UI or policy takes responsibility for modified input |
| `stopRuntimeSession` | — | Optional hook called on `terminate()`, for example to call the `StopRuntimeSession` API |
| `reconnect` | `{ baseMs: 500, maxMs: 30000 }` | Reconnect backoff |
| `logger` | silent | `{ debug, info, warn, error }` |

**IAM.** The caller needs `bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream` on the
runtime.

## Behaviour

- **Session id.** Each runtime session maps to one AgentCore runtime session,
  `agent-runtime-<session id>`, and therefore to one microVM.
- **Resume.** The cursor is `(bootId, seq)`. On reconnect the container replays events after
  `seq` and re-sends outstanding requests.
- **New microVM.** A different `bootId` means the old microVM is gone. Pending tool calls and
  approvals are cancelled, and the conversation resumes from the transcript stored in your
  database.
- **Commands.** `send`, `interrupt`, tool results, and approval decisions are acknowledged by the
  container. If no connection is open, they wait for one (up to `commandTimeoutMs`).
- **Transcript requests.** The container's transcript reads and writes are served from the
  runtime's `Store`.

## Capabilities

`approvalUpdatedInput`: the value of `allowUpdatedInput`. `thinkingContent`: `full`. `turnCost`: `true`. See the [behaviour spec](../../docs/behavior-spec.md#capabilities).

## Exports

| Export | Description |
| --- | --- |
| `agentCore(options)` / `AgentCoreProvider` | The provider |
| `signWebSocketRequest(endpoint, runtimeSessionId, credentials)` | SigV4-signs the WebSocket upgrade; returns `{ url, headers }` |
| `agentCoreWsTarget(endpoint)` | Host, path, and query of the runtime's WebSocket endpoint |
| `SESSION_ID_HEADER` | `X-Amzn-Bedrock-AgentCore-Runtime-Session-Id` |

## Further reading

- [Bedrock AgentCore guide](../../docs/agentcore.md)
- [`@agent-runtime/agentcore-runtime`](../agentcore-runtime/README.md), the container side
- [`@agent-runtime/protocol`](../protocol/README.md), the wire protocol
