# Build from the repository root:
#   docker build --platform linux/arm64 -f examples/agentcore-container/Dockerfile -t agent-runtime-container .
# AgentCore Runtime requires ARM64 images listening on 0.0.0.0:8080.
FROM --platform=linux/arm64 node:22-slim
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @agent-runtime/example-agentcore-container... \
 && pnpm --filter "./packages/*" build
RUN mkdir -p /workspace
ENV NODE_ENV=production PORT=8080 AGENT_WORKDIR=/workspace
EXPOSE 8080
CMD ["pnpm", "--filter", "@agent-runtime/example-agentcore-container", "start"]
