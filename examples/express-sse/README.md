# Example: Express + SSE

A small Express backend that exposes an `agent-runtime` session to a browser. Use it as a template
for your own API.

It shows:

- SSE streaming with `Last-Event-ID` resume;
- sending messages, interrupting, and answering approvals over HTTP;
- a custom tool (`get_time`) that runs on the server;
- running with an in-memory store (single instance) or Postgres (several instances);
- a simulated agent, so you can try everything without API keys.

## Run it

```bash
pnpm install
pnpm --filter @agent-runtime/example-express-sse start
```

### Configuration (environment variables)

| Variable | Default | Description |
| --- | --- | --- |
| `PROVIDER` | `fake` | `fake` (simulated agent), `managed-agents`, or `agentcore` |
| `DATABASE_URL` | — | Use Postgres instead of memory; required for more than one instance |
| `PORT` | `3000` | HTTP port |
| `ANTHROPIC_API_KEY`, `MA_AGENT_ID`, `MA_ENVIRONMENT_ID` | — | For `PROVIDER=managed-agents` |
| `AWS_REGION`, `AGENTCORE_RUNTIME_ARN` | — | For `PROVIDER=agentcore` on AWS |
| `AGENTCORE_LOCAL_WS_URL` | — | For `PROVIDER=agentcore` against a local container, such as `ws://localhost:8080/ws` |

## Try it with curl

```bash
# create a session
ID=$(curl -s -XPOST localhost:3000/sessions | jq -r .id)

# watch events in one terminal
curl -N localhost:3000/sessions/$ID/events

# send a message in another; "run bash" makes the simulated agent ask for permission
curl -XPOST localhost:3000/sessions/$ID/messages -H 'content-type: application/json' -d '{"text":"please run bash"}'

# answer the approval (no browser needs to be connected)
curl localhost:3000/sessions/$ID/approvals
curl -XPOST localhost:3000/sessions/$ID/approvals/<approvalId> -H 'content-type: application/json' -d '{"decision":"allow"}'

# resume the stream after event 9
curl -N localhost:3000/sessions/$ID/events -H 'Last-Event-ID: 9'
```

## Routes

| Route | Description |
| --- | --- |
| `POST /sessions` | Create a session; body `{ provider?, config?, metadata? }`; returns `{ id }` |
| `GET /sessions/:id/events` | SSE stream; honours `Last-Event-ID` (or `?after=`); sends a heartbeat every 15 s |
| `POST /sessions/:id/messages` | Send `{ text }` |
| `POST /sessions/:id/interrupt` | Stop the current turn |
| `GET /sessions/:id/approvals` | List pending approvals |
| `POST /sessions/:id/approvals/:approvalId` | Answer with `{ decision: 'allow' \| 'deny', message? }`; returns `409` if already resolved |

## Files

| File | Contents |
| --- | --- |
| `src/app.ts` | The Express routes (`createApp(runtime, …)`) |
| `src/main.ts` | Wires store, bus, providers, tools, and approval policy from environment variables |
| `src/simulated-agent.ts` | Makes `FakeProvider` behave like a slow agent that uses a tool and asks for permission |
| `test/app.test.ts` | Runs two instances against one shared store and bus; checks SSE resume across instances and approvals with no client connected |

## Further reading

- [Getting started](../../docs/getting-started.md)
- [Scaling and failover](../../docs/scaling-and-failover.md)
