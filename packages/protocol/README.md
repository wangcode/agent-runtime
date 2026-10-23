# @agent-runtime/protocol

The WebSocket protocol between [`@agent-runtime/providers-agentcore`](../providers/agentcore/README.md)
(the **client**, in your backend) and [`@agent-runtime/agentcore-runtime`](../agentcore-runtime/README.md)
(the **container**). It contains only types and small helpers. You need it directly only if you
implement one side yourself.

## Install

```bash
pnpm add @agent-runtime/protocol
```

## Overview

- **Format.** JSON text frames.
- **Version.** `PROTOCOL_VERSION` is currently `1`.
- **Frame size.** Messages larger than `MAX_FRAME_BYTES` (30 KB, under AgentCore's frame limit) are
  split into `chunk` frames and reassembled on the other side.

```
client                                    container
  │── hello {sessionId, bootId?, afterSeq?, config, tools, features} ─▶│
  │◀─ welcome {bootId, lastSeq, created} ────────────────────│
  │◀─ event {seq, event} … (replay after afterSeq) ──────────│
  │◀─ tool_request / approval_request / store_request ───────│ (anything still pending)
  │                                                          │
  │── user_message {id, content} ───────────────────────────▶│
  │◀─ ack {id, ok} ──────────────────────────────────────────│
  │◀─ event {event} (live delta, no seq) ────────────────────│
  │◀─ event {seq, event} ────────────────────────────────────│
  │◀─ tool_request {requestId, toolUseId, name, input} ──────│
  │── tool_result {id, requestId, result} ──────────────────▶│
  │◀─ ack {id, ok} ──────────────────────────────────────────│
```

## Messages

### Client → container

| Type | Fields | Purpose |
| --- | --- | --- |
| `hello` | `protocol, sessionId, bootId?, afterSeq?, config, tools, features?` | First message on every connection; creates the session if needed and requests replay. `features.approvalUpdatedInput` tells the container whether approvals may change tool input |
| `user_message` | `id, content` | Send a user message |
| `interrupt` | `id` | Stop the current turn |
| `tool_result` | `id, requestId, result` | Answer a `tool_request` |
| `approval_decision` | `id, requestId, decision` | Answer an `approval_request` |
| `terminate` | `id` | End the session in the container |
| `store_response` | `requestId, ok, data?, error?` | Answer a `store_request` |

Every message with an `id` is acknowledged with `ack`. The container remembers recent ids, so a
retried command is acknowledged again but not executed twice.

### Container → client

| Type | Fields | Purpose |
| --- | --- | --- |
| `welcome` | `protocol, bootId, lastSeq, created` | Handshake reply. A new `bootId` means a new process or microVM |
| `event` | `seq?, event` | A unified event. With `seq` it is replayable; without, it is a live delta |
| `tool_request` | `requestId, toolUseId, name, input` | Run a caller-side tool |
| `approval_request` | `requestId, toolUseId, name, input` | Decide a permission |
| `store_request` | `requestId, op, …` | Transcript storage: `append`, `load`, `listSubkeys`, `delete`, `has` |
| `ack` | `id, ok, error?` | Command acknowledgement |
| `error` | `message` | Protocol error, such as a malformed frame |

## Rules

- **Event identity.** `(bootId, seq)` identifies an event. Replay is only valid within one
  `bootId`, so after a boot change the client starts again from `seq` 0.
- **Re-sent requests.** Outstanding requests are re-sent after each `welcome`, so clients must
  treat `requestId`s idempotently.
- **One client per session.** A newer connection replaces the older one, which is closed with
  code `4000`.

## Helpers

| Export | Description |
| --- | --- |
| `encodeFrames(message, maxBytes?)` | Serialize a message into one or more frames |
| `FrameDecoder` | Reassemble frames; `decode(frame)` returns the message, or `null` while chunks are missing |
| `runtimeSessionIdFor(sessionId)` | Derive a valid AgentCore runtime session id (33–256 characters) |
| `PROTOCOL_VERSION`, `MAX_FRAME_BYTES` | Constants |
| `ClientMessage`, `ContainerMessage`, `HelloMessage`, `WelcomeMessage`, `ClientCommand`, `StoreOp`, … | Types |

## Further reading

- [Bedrock AgentCore guide](../../docs/agentcore.md)
