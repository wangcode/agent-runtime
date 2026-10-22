# Behaviour spec

Callers of `agent-runtime` should never have to know which provider a session runs on. This page
is the contract that makes that true. It covers what events a session produces, in what order, and
with what meaning. **Every provider must follow it.**

Rules are enforced in two places:

- **The runtime core**, for everything that can be done provider-independently: turn boundaries,
  status, interrupts, usage, and tool ordering. Adapters cannot get these wrong.
- **The [conformance suite](../packages/conformance/README.md)**, for the rest. It plays the same
  conversations through every provider's native protocol and requires identical unified events.

Where a provider genuinely cannot do something, the difference is a declared
[capability](#capabilities) and fails loudly. It is never silently ignored.

## Turns

1. **How a turn starts.** A turn starts when you call `session.send()` on an idle session. The
   first two events are `user.message` and `session.status: running`, emitted by the runtime
   itself, so their timing is the same for every provider.
2. **How a turn ends.** Every turn ends with `session.status: idle` **immediately followed by**
   `turn.completed`. Nothing from that turn comes after `turn.completed`.
3. **Interrupted turns.** A turn ended by `session.interrupt()` has `stopReason: 'interrupted'`,
   whatever the provider reported.
4. **Usage.** `turn.completed.usage` holds the **total for that turn**: tokens, and `costUsd` when
   the provider can report cost. There is no separate usage event. A turn with nothing to report
   has no `usage`.
5. **Repeated status.** `session.status` is never emitted twice in a row with the same value.

## Messages

6. **One block per event.** Every content block the agent produces (text, thinking, server tool
   results, …) becomes **exactly one** `agent.message.completed` whose `content` holds that single block.
7. **Shared message ids.** A block's `messageId` is the same in its `agent.message.start`, its deltas,
   and its `agent.message.completed`. Its format is `<provider message id>:<block index>`; treat it as
   opaque.
8. **Live start before deltas.** `agent.message.start` comes before the first delta of a block. Both are
   live-only and may be missed, so the final content is always in `agent.message.completed`.
9. **Thinking blocks.** Thinking is a `agent.message.completed` with a `thinking` block. How complete it
   is depends on the `thinkingContent` capability.

## Tools

10. **Call before result.** A tool call is announced with `tool.call` **before** any
    `approval.requested`, `approval.resolved`, or `tool.result` for the same `toolUseId`. Providers
    may report these out of order; the runtime restores the order.
11. **Exactly one result.** Every `tool.call` gets **exactly one** `tool.result`. A denied or
    cancelled call gets an error result (`isError: true`) whose text is the denial message.
12. **Custom tools.** Custom tools run on your server (see [Tools and approvals](tools-and-approvals.md));
    their `tool.result` is recorded by the runtime.

## Approvals

13. **Ask, then decide.** An approval that needs a human produces `approval.requested`, then
    exactly one `approval.resolved`. The resolution comes from your policy, a person, a timeout, or
    the system.
14. **No silent changes.** Approving with modified input (`updatedInput`) works only when the
    `approvalUpdatedInput` capability is true; otherwise it throws `CapabilityError`.

## Threads

15. **Sub-agent events.** Events produced by a sub-agent or secondary thread carry `threadId`.
    Main-agent events have none. The value is opaque and stable for one sub-agent or thread.

## Capabilities

`session.capabilities()` and `runtime.capabilities(providerKey)` return:

| Capability | Meaning | Managed Agents | Agent SDK (AgentCore) |
| --- | --- | --- | --- |
| `approvalUpdatedInput` | Approvals may change the tool's input | `false`, not supported | `false` by default; `true` with `allowUpdatedInput: true` |
| `thinkingContent` | `full`: thinking text is complete. `best_effort`: assembled from live deltas, may be partial after a reconnect | `best_effort` | `full` |
| `turnCost` | `turn.completed.usage.costUsd` is reported | `true` | `true` |
| `systemMessages` | How `send(…, { system })` is delivered. `native`: a real system-role message. `emulated`: a `<system-reminder>` block appended to the user message | `native` | `emulated` |

## Open questions

These are known, deliberate gaps. The conformance suite filters them explicitly (see
`packages/conformance/src/normalize.ts`) until they are decided.

- **What `session.status: requires_action` means.** Managed Agents reports it while it waits for
  *any* answer from us, including a custom tool result that the server is computing. The Agent SDK
  only reports it while a human approval is pending. Until this is unified, use
  `approval.requested` and `session.pendingApprovals()` to decide whether to show an approval
  dialog, not the status.
- **Turn state across a takeover.** A takeover is when another instance picks up a session whose
  owner crashed. Interrupt tracking and accumulated usage are kept in memory by the owning
  instance, so a turn that is interrupted, or that reports usage, just before a crash may lose
  that information.
