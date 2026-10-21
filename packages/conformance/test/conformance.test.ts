import { describe, expect, it } from 'vitest'
import { type Harness, runScenario } from '../src/harness.js'
import { agentCoreHarness } from '../src/harnesses/agentcore.js'
import { managedAgentsHarness } from '../src/harnesses/managed-agents.js'
import { deltaViolations } from '../src/normalize.js'
import { SCENARIOS, expectedEvents } from '../src/scenarios.js'

/**
 * Every provider must turn the same conversation into the same unified events
 * (docs/behavior-spec.md). Add a harness here to integrate a new provider.
 */
const HARNESSES: Harness[] = [managedAgentsHarness, agentCoreHarness]

describe.each(HARNESSES)('$name', (harness) => {
  it.each(SCENARIOS)('$name', async (scenario) => {
    const { normalized, all } = await runScenario(harness, scenario)
    expect(normalized).toEqual(expectedEvents(scenario))
    expect(deltaViolations(all, { requireCompletion: true })).toEqual([])
  })
})
