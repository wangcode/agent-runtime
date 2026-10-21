# Example: AgentCore container

A container image that runs the Claude Agent SDK on Amazon Bedrock AgentCore Runtime, using
[`@agent-runtime/agentcore-runtime`](../../packages/agentcore-runtime/README.md). Your backend
connects to it with [`@agent-runtime/provider-agentcore`](../../packages/provider-agentcore/README.md).

## Files

| File | Contents |
| --- | --- |
| `src/server.ts` | Starts the server on port 8080 with the Claude Agent SDK driver configured for Bedrock |
| `Dockerfile` | ARM64 image (required by AgentCore); build it from the repository root |

## Run locally

```bash
pnpm install
pnpm --filter @agent-runtime/example-agentcore-container start
curl localhost:8080/ping   # {"status":"Healthy","time_of_last_update":…}
```

Then point a backend at it, for example the [Express example](../express-sse/README.md):

```bash
PROVIDER=agentcore AGENTCORE_LOCAL_WS_URL=ws://localhost:8080/ws \
  pnpm --filter @agent-runtime/example-express-sse start
```

The SDK needs AWS credentials with Bedrock access in the environment (`AWS_PROFILE` or access
keys, plus `AWS_REGION`).

## Build and deploy

```bash
docker build --platform linux/arm64 -f examples/agentcore-container/Dockerfile -t agent-runtime-container .
```

Push the image to ECR and create an AgentCore runtime from it, following the
[AgentCore documentation](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/).

- **Container role.** The runtime's IAM role needs Bedrock model invocation permissions.
- **Caller role.** Callers need `bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | Listen port (AgentCore requires 8080) |
| `AWS_REGION` | `us-east-1` | Bedrock region |
| `AGENT_WORKDIR` | `/workspace` | Working directory for the agent's file tools |

To change the model, system prompt, or allowed tools, edit the `options` in `src/server.ts`. To
change them per session, pass `config: { options: { … } }` when creating the session in your
backend.

## Further reading

- [Bedrock AgentCore guide](../../docs/agentcore.md)
