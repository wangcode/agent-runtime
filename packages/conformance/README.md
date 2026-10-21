# @agent-runtime/conformance *(private)*

The suite that keeps every provider behaving identically. It plays the same conversations through
each provider's **native** protocol and requires them to produce the **same unified events**, as
defined by the [behaviour spec](../../docs/behavior-spec.md).

This package is not published. It runs as part of `pnpm test`.

## How it works

```
scenario (provider-neutral steps)
   │
   ├─▶ Managed Agents harness ── mocked Managed Agents API ──▶ ManagedAgentsProvider ─┐
   │                                                                                  ├─▶ runtime ─▶ events ─▶ normalize ─▶ must equal expectedEvents(scenario)
   └─▶ AgentCore harness ── mocked Agent SDK in a real container ──▶ AgentCoreProvider ┘
```

- **Scenarios** (`src/scenarios.ts`): plain reply with thinking and two text blocks, custom tool
  round-trip, approval allowed, approval denied, interrupt mid-turn, provider connection dropped
  mid-turn, and a multi-turn conversation. `expectedEvents()` derives the single required event
  sequence from the steps.
- **Harnesses** (`src/harnesses/`): each turns scenario steps into what that provider really sends,
  such as Managed Agents stream and list events, or Agent SDK messages inside a real
  `agentcore-runtime` server over the real WebSocket. The real adapter code does the mapping.
- **Normalization** (`src/normalize.ts`) strips transport details (ids, timestamps, `raw`) and
  replaces provider ids with placeholders in order of appearance. It removes only the divergences
  listed under *Open questions* in the behaviour spec.
- **Live deltas** are checked separately: each delta must follow a `message.start` with the same
  `messageId`, and must belong to a block that completed.

## Adding a provider

1. Write a harness implementing `Harness` (`src/harness.ts`). It drives your provider's native
   protocol for each `AgentStep`; it must not emit unified events itself.
2. Add it to `HARNESSES` in `test/conformance.test.ts`.
3. Make every scenario pass. The provider is integrated only then.

## Adding a scenario

Add it to `SCENARIOS`. If it needs a new kind of step, add the step to `AgentStep`, extend
`expectedEvents()`, and implement the step in **every** harness.
