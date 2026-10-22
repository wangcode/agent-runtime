import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@agent-runtime/core/rxjs': fileURLToPath(new URL('./packages/core/src/rxjs.ts', import.meta.url)),
      '@agent-runtime/core/testing': fileURLToPath(new URL('./packages/core/src/testing/index.ts', import.meta.url)),
      '@agent-runtime/agentcore-runtime/claude-agent-sdk': fileURLToPath(new URL('./packages/agentcore-runtime/src/claude-agent-sdk/index.ts', import.meta.url)),
      '@agent-runtime/core': pkg('core'),
      '@agent-runtime/protocol': pkg('protocol'),
      '@agent-runtime/store-postgres': pkg('store-postgres'),
      '@agent-runtime/provider-managed-agents': pkg('provider-managed-agents'),
      '@agent-runtime/provider-agentcore': pkg('provider-agentcore'),
      '@agent-runtime/agentcore-runtime': pkg('agentcore-runtime'),
      '@agent-runtime/nestjs': pkg('nestjs'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'examples/*/test/**/*.test.ts'],
    testTimeout: 20000,
  },
})
