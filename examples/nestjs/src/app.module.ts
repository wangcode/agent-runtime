import { Module } from '@nestjs/common'
import { MemoryBus, MemoryStore } from '@agent-runtime/stores-memory'
import { FakeProvider } from '@agent-runtime/core/testing'
import { AgentRuntimeModule } from '@agent-runtime/nestjs'
import { SessionsController } from './sessions.controller.js'
import { simulateAgent } from './simulated-agent.js'

/** In-memory runtime with a simulated agent; see the README for the Postgres + real provider version. */
export function createAppModule(opts: { wordDelayMs?: number } = {}) {
  const sim = new FakeProvider()
  simulateAgent(sim, opts)

  @Module({
    imports: [
      AgentRuntimeModule.forRoot({
        store: new MemoryStore(),
        bus: new MemoryBus(),
        providers: { sim },
        approvals: { policy: () => 'ask' },
      }),
    ],
    controllers: [SessionsController],
  })
  class AppModule {}

  return AppModule
}
