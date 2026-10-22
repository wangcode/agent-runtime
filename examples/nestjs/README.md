# Example: NestJS

A NestJS app that exposes `agent-runtime` sessions to a browser using
[`@agent-runtime/nestjs`](../../packages/nestjs/README.md). It runs with an in-memory store and a
simulated agent, so it needs no API keys.

It shows:

- registering the runtime with `AgentRuntimeModule.forRoot`;
- a controller that creates sessions, sends messages, interrupts, and answers approvals;
- an `@Sse()` route with `Last-Event-ID` resume;
- runtime errors mapped to HTTP status codes;
- the `main.ts` settings for a clean shutdown.

## Run it

```bash
pnpm install
pnpm --filter @agent-runtime/example-nestjs start
```

```bash
ID=$(curl -s -XPOST localhost:3000/sessions | jq -r .id)
curl -N localhost:3000/sessions/$ID/events          # in one terminal
curl -XPOST localhost:3000/sessions/$ID/messages -H 'content-type: application/json' -d '{"text":"hello"}'

# a message containing "run" makes the agent ask for approval
curl -XPOST localhost:3000/sessions/$ID/messages -H 'content-type: application/json' -d '{"text":"please run ls"}'
curl -XPOST localhost:3000/sessions/$ID/approvals/<approvalId> -H 'content-type: application/json' -d '{"decision":"allow"}'
```

## Files

| File | What it contains |
| --- | --- |
| `src/app.module.ts` | `AgentRuntimeModule.forRoot` with `MemoryStore`, `MemoryBus`, and the simulated agent |
| `src/sessions.controller.ts` | The routes, including the `@Sse()` event stream |
| `src/main.ts` | Bootstrap with `forceCloseConnections` and `enableShutdownHooks()` |
| `src/simulated-agent.ts` | A `FakeProvider` that streams a reply and asks for approval |
| `test/app.test.ts` | Boots the app and checks streaming, resume, approvals, and error codes |

## Going to production

Replace the in-memory setup with Postgres and a real provider using `forRootAsync`:

```ts
import pg from 'pg'
import Anthropic from '@anthropic-ai/sdk'
import { PgBus, PgStore, migrate } from '@agent-runtime/store-postgres'
import { managedAgents } from '@agent-runtime/provider-managed-agents'

@Module({
  providers: [
    {
      provide: 'PG_POOL',
      useFactory: async () => {
        const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
        await migrate(pool)
        return pool
      },
    },
    {
      provide: 'PG_BUS',
      inject: ['PG_POOL'],
      useFactory: (pool: pg.Pool) => new PgBus({ pool, listenConfig: { connectionString: process.env.DATABASE_URL } }),
    },
    DatabaseShutdown, // onApplicationShutdown: await bus.close(); await pool.end()
  ],
  exports: ['PG_POOL', 'PG_BUS'],
})
class DatabaseModule {}

AgentRuntimeModule.forRootAsync({
  imports: [DatabaseModule],
  inject: ['PG_POOL', 'PG_BUS'],
  useFactory: (pool: pg.Pool, bus: PgBus) => ({
    store: new PgStore({ pool }),
    bus,
    providers: { ma: managedAgents({ client: new Anthropic() }) },
  }),
})
```

The runtime closes in `beforeApplicationShutdown`, before your `onApplicationShutdown` closes the
bus and pool.
