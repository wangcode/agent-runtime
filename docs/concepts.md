# Concepts

This page defines the terms used throughout the documentation and shows how they relate. Read it
once before the other guides.

## The objects you work with

| Term | What it is |
| --- | --- |
| **Runtime** | The object your backend creates once per process with `createRuntime()`. It knows the providers, your tools, your approval policy, and where state is stored. |
| **Provider** | An agent service, such as Claude Managed Agents or the Claude Agent SDK on Bedrock AgentCore. You register providers on the runtime under a key of your choice (`'ma'`, `'ac'`, …). |
| **Session** | One conversation with an agent, on one provider. Created with `runtime.createSession()`, looked up from any instance with `runtime.getSession(id)`. A session lives until you terminate it. |
| **Turn** | One round of work: it starts when you send a message to an idle session, and ends when the agent stops and waits for the next message (`turn.completed`). A session has many turns. Not to be confused with a provider's *threads* (sub-agents working in parallel inside a turn), which show up as `threadId` on events. |
| **Event** | Something that happened in a session: a message, a tool call, a status change, … Every provider's activity is converted into the same set of events. See [Event model](event-model.md). |
| **Custom tool** | A function you register on the runtime that the agent can call. It runs on your server. See [Tools and approvals](tools-and-approvals.md). |
| **Approval** | A decision whether the agent may run a tool. Your **policy** decides it automatically, or asks a human. |
| **Capability** | Something only some providers can do (for example, approving a tool call with modified input). You can check capabilities at runtime; using a missing one throws an error. |

## What happens behind the scenes

| Term | What it is |
| --- | --- |
| **Store** | Durable state: sessions, events, queued commands, pending tool calls and approvals. `PgStore` (Postgres) for production, `MemoryStore` for tests. |
| **Bus** | Notifications between instances of your backend ("new event", "new command"). `PgBus` uses Postgres `LISTEN/NOTIFY`; `MemoryBus` works inside one process. |
| **Instance** | One process running your backend. You can run many; any instance can serve any request. |
| **Owner** | The one instance currently connected to the provider for a given session. Ownership is a **lease** with an expiry, renewed while the instance is alive. |
| **Worker** | The code on the owner that does the session's work: holds the provider connection, stores events, runs your tools, applies approvals, executes commands. |
| **Command** | `send`, `interrupt`, `resolveApproval`, or `terminate`. Commands are queued in the store and executed by the owner, so you can call them on any instance. |
| **Action** | A tool call or approval the provider is waiting for. Actions are stored, so a new owner can finish them after a crash. |
| **Adapter** | The code that translates between one provider's API and the runtime (for example `ManagedAgentsProvider`). |
| **Cursor** | An adapter's bookmark in the provider's event stream, stored with the session, so a reconnect resumes where it stopped. |
| **Driver** | For AgentCore only: the code inside the container that runs an agent framework (for example the Claude Agent SDK driver). |

## Lifecycle of a session

```
createSession() ──▶ idle ──send()──▶ running ──▶ … ──▶ idle ──send()──▶ running ──▶ … ──terminate()──▶ terminated
                                       │      ▲
                                       ▼      │
                                 requires_action        (waiting for an approval)
```

| Status | Meaning |
| --- | --- |
| `idle` | Waiting for the next user message. No turn in progress. |
| `running` | A turn is in progress. |
| `requires_action` | The agent is waiting for something before it can continue. Its exact meaning still differs between providers; see [Behaviour spec](behavior-spec.md#open-questions). |
| `terminated` | The session is over. Commands are rejected; `events()` ends after the last event. |

## Lifecycle of a turn

```
send("…")
  user.message
  session.status: running
  …  agent.message.completed / tool.call / approval.requested / approval.resolved / tool.result …
  session.status: idle
  turn.completed  { stopReason, usage }
```

Every provider produces this shape. The exact rules are in the [behaviour spec](behavior-spec.md).

## Where things run

```
┌──────────── your backend (any number of instances) ────────────┐
│  HTTP/SSE routes ── Session API ──┐                            │
│                                   │ commands, events           │
│  Worker (on the owner instance) ◀─┘                            │
│    ├─ provider connection                                      │
│    ├─ your custom tool handlers                                │
│    └─ your approval policy                                     │
└───────────────┬────────────────────────────────┬───────────────┘
                │                                │
          Postgres (store + bus)           Provider (Managed Agents / AgentCore)
```

Your browser clients never talk to the provider, and nothing in your frontend depends on which
provider a session uses.
