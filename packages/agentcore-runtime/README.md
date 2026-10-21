# @agent-runtime/agentcore-runtime

The container-side half of the Bedrock AgentCore integration. It runs **inside** your AgentCore
container and:

- implements AgentCore's container contract (`/ping`, `/ws`, `/invocations` on port 8080);
- speaks the [agent-runtime protocol](../protocol/README.md) to
  [`@agent-runtime/provider-agentcore`](../provider-agentcore/README.md) in your backend;
- keeps a replay log, so the caller can reconnect without losing events;
- hosts an agent through a pluggable **driver**. A driver for the
  [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) is included.

## Install

```bash
pnpm add @agent-runtime/agentcore-runtime @anthropic-ai/claude-agent-sdk
```

`@anthropic-ai/claude-agent-sdk` is an optional peer dependency; you only need it for the bundled
driver.

## Usage

```ts
import { startAgentCoreServer } from '@agent-runtime/agentcore-runtime'
import { claudeAgentSdkDriver } from '@agent-runtime/agentcore-runtime/claude-agent-sdk'

const server = await startAgentCoreServer({
  driver: claudeAgentSdkDriver({
    options: {
      cwd: '/workspace',
      allowedTools: ['Read', 'Glob', 'Grep'],
      env: { ...process.env, CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-west-2' },
    },
  }),
})

process.on('SIGTERM', () => server.close())
```

See [`examples/agentcore-container`](../../examples/agentcore-container/README.md) for a Dockerfile.

## `startAgentCoreServer(options)`

| Option | Default | Description |
| --- | --- | --- |
| `driver` | *required* | The agent implementation (`AgentDriver`) |
| `port` / `host` | `8080` / `0.0.0.0` | Listen address (AgentCore requires `0.0.0.0:8080`) |
| `maxLogEvents` | `10000` | Replay log size per session |
| `helloTimeoutMs` | `10000` | Close sockets that don't complete the handshake in time |
| `logger` | silent | `{ debug, info, warn, error }` |

Returns `{ server, port, bootId, sessions, health(), close() }`.

### Endpoints

| Endpoint | Description |
| --- | --- |
| `GET /ping` | `{ status: 'Healthy' \| 'HealthyBusy', time_of_last_update }`. Busy while a turn, tool call, or approval is in flight. The timestamp only changes on transitions, as AgentCore expects |
| `GET /ws` | The agent-runtime WebSocket protocol |
| `POST /invocations` | HTTP fallback. Body `{ sessionId?, prompt, config? }`; runs one turn and streams events as SSE until `turn.completed`. Tool calls and approvals need a WebSocket client |

## Claude Agent SDK driver

`claudeAgentSdkDriver(options)`, exported from `@agent-runtime/agentcore-runtime/claude-agent-sdk`:

| Option | Default | Description |
| --- | --- | --- |
| `options` | `{}` | Base SDK `Options`, or `(session) => Options`. The caller's `config.options` is shallow-merged on top |
| `mcpServerName` | `'runtime'` | Name of the in-process MCP server that exposes caller-side tools (`mcp__runtime__<tool>`) |
| `persistTranscript` | `true` | Mirror the SDK transcript to the caller's database and resume from it on a fresh microVM |
| `forwardAllMessages` | `false` | Forward every SDK message as `provider.custom` (default: only `init`, `compact_boundary`, `api_retry`) |
| `sdk` | dynamic import | Inject the SDK module, for tests |

What it does:

- **Multi-turn.** Runs `query()` in streaming-input mode and keeps the session open across turns,
  with `includePartialMessages` on for token deltas.
- **Custom tools.** Exposes the caller's custom tools through `createSdkMcpServer`. Each call is
  forwarded to the caller, and a `PreToolUse` hook captures the real `tool_use_id`. These tools are
  pre-allowed.
- **Permissions.** Forwards other permission prompts (`canUseTool`) to the caller's approval
  policy, and reports `requires_action` while waiting.
- **Resume.** Uses a stable SDK session id derived from the runtime session id: a new session
  (`sessionId`) the first time, and `resume` once a transcript exists.
- **Event mapping.** Turns SDK messages into unified events; each text or thinking block becomes
  one `message.completed`.

**Bedrock:** set `CLAUDE_CODE_USE_BEDROCK=1` and `AWS_REGION` in `options.env`. Note that
`options.env` replaces the subprocess environment, so spread `process.env` into it. The
container's IAM role needs Bedrock model access.

## Writing your own driver

Implement `AgentDriver` to host another framework, such as Mastra. The driver receives a
`DriverSession` with `emit`, `requestTool`, `requestApproval`, `sessionStore`, and `setBusy`; the
server handles everything else. See [Writing a provider or driver](../../docs/extending.md#drivers).

## Exports

| Export | Description |
| --- | --- |
| `startAgentCoreServer`, `AgentCoreServer`, `AgentCoreServerOptions` | The server |
| `AgentDriver`, `DriverSession`, `DriverHandle`, `RemoteSessionStore` | Driver contract |
| `ContainerSession` | Per-session state (exported for advanced use and tests) |
| `…/claude-agent-sdk`: `claudeAgentSdkDriver`, `ClaudeAgentSdkDriver`, `SdkEventMapper`, `sdkSessionIdFor`, `jsonSchemaToShape` | Claude Agent SDK driver and helpers |

## Further reading

- [Bedrock AgentCore guide](../../docs/agentcore.md)
- [`@agent-runtime/provider-agentcore`](../provider-agentcore/README.md), the caller side
