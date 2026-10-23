/**
 * Run with:  pnpm --filter @agent-runtime/example-express-sse start
 *
 * Environment:
 *   PROVIDER=fake | managed-agents | agentcore   (default: fake, a simulated agent)
 *   DATABASE_URL=postgres://...                  (default: in-memory store, single instance)
 *   ANTHROPIC_API_KEY, MA_AGENT_ID, MA_ENVIRONMENT_ID           for managed-agents
 *   AWS_REGION, AGENTCORE_RUNTIME_ARN | AGENTCORE_LOCAL_WS_URL  for agentcore
 *   PORT=3000
 */
import Anthropic from '@anthropic-ai/sdk'
import pg from 'pg'
import WebSocket from 'ws'
import { type Bus, type ProviderAdapter, type Store, createRuntime } from '@agent-runtime/core'
import { MemoryBus, MemoryStore } from '@agent-runtime/stores-memory'
import { FakeProvider } from '@agent-runtime/core/testing'
import { agentCore } from '@agent-runtime/providers-agentcore'
import { managedAgents } from '@agent-runtime/providers-managed-agents'
import { PgBus, PgStore, migrate } from '@agent-runtime/stores-postgres'
import { createApp } from './app.js'
import { simulateAgent } from './simulated-agent.js'

const providerName = process.env.PROVIDER ?? 'fake'

let store: Store = new MemoryStore()
let bus: Bus = new MemoryBus()
if (process.env.DATABASE_URL) {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
  await migrate(pool)
  store = new PgStore({ pool })
  const pgBus = new PgBus({ pool, listenConfig: { connectionString: process.env.DATABASE_URL } })
  await pgBus.start()
  bus = pgBus
}

const providers: Record<string, ProviderAdapter<any>> = {}
if (providerName === 'fake') {
  const fake = new FakeProvider()
  simulateAgent(fake)
  providers.fake = fake
}
if (providerName === 'managed-agents') providers['managed-agents'] = managedAgents({ client: new Anthropic() })
if (providerName === 'agentcore') {
  const localUrl = process.env.AGENTCORE_LOCAL_WS_URL
  providers.agentcore = agentCore(
    localUrl
      ? { connectWebSocket: () => new WebSocket(localUrl) }
      : { endpoint: { region: process.env.AWS_REGION ?? 'us-east-1', runtimeArn: process.env.AGENTCORE_RUNTIME_ARN ?? '' } },
  )
}

const runtime = createRuntime({
  store,
  bus,
  providers,
  tools: {
    get_time: {
      description: 'Current server time',
      inputSchema: { type: 'object', properties: {} },
      handler: () => new Date().toISOString(),
    },
  },
  approvals: { policy: (req) => (req.name === 'Read' ? 'allow' : 'ask'), timeoutMs: 5 * 60_000 },
  logger: console,
})

const app = createApp(runtime, {
  defaultProvider: providerName,
  defaultConfig: () =>
    providerName === 'managed-agents' ? { agent: process.env.MA_AGENT_ID, environmentId: process.env.MA_ENVIRONMENT_ID } : {},
})

const port = Number(process.env.PORT ?? 3000)
const server = app.listen(port, () => console.log(`listening on http://localhost:${port} (provider: ${providerName}, instance ${runtime.instanceId})`))

const shutdown = async () => {
  server.close()
  await runtime.close()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
