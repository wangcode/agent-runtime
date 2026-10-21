/**
 * Container entrypoint for Bedrock AgentCore Runtime: serves /ping, /ws and /invocations on :8080
 * and runs the Claude Agent SDK against Bedrock.
 *
 * Locally: `pnpm --filter @agent-runtime/example-agentcore-container start`, then point the
 * caller's `agentCore({ connectWebSocket: () => new WebSocket('ws://localhost:8080/ws') })` at it.
 */
import { startAgentCoreServer } from '@agent-runtime/agentcore-runtime'
import { claudeAgentSdkDriver } from '@agent-runtime/agentcore-runtime/claude-agent-sdk'

const server = await startAgentCoreServer({
  port: Number(process.env.PORT ?? 8080),
  logger: console,
  driver: claudeAgentSdkDriver({
    options: {
      cwd: process.env.AGENT_WORKDIR ?? '/workspace',
      permissionMode: 'default',
      allowedTools: ['Read', 'Glob', 'Grep'],
      env: {
        ...process.env,
        CLAUDE_CODE_USE_BEDROCK: '1',
        AWS_REGION: process.env.AWS_REGION ?? 'us-east-1',
      },
    },
  }),
})
console.log(`agentcore runtime listening on :${server.port} (boot ${server.bootId})`)

process.on('SIGTERM', () => void server.close().then(() => process.exit(0)))
