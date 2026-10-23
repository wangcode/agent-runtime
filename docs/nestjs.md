# NestJS

How to use `agent-runtime` in a NestJS application. It covers registering the runtime, writing the
HTTP routes a frontend needs, and shutting down cleanly. The API reference is in
[`@agent-runtime/nestjs`](../packages/nestjs/README.md), and a runnable app is in
[`examples/nestjs`](../examples/nestjs/README.md).

## 1. Install

```bash
pnpm add @agent-runtime/core @agent-runtime/nestjs
# plus a store and providers, for example:
pnpm add @agent-runtime/stores-postgres pg @agent-runtime/providers-managed-agents @anthropic-ai/sdk
```

## 2. Register the runtime

Import `AgentRuntimeModule` once, in your root module. It is global by default.

```ts
@Module({
  imports: [
    AgentRuntimeModule.forRootAsync({
      imports: [DatabaseModule],
      inject: ['PG_POOL', 'PG_BUS'],
      useFactory: (pool: pg.Pool, bus: PgBus) => ({
        store: new PgStore({ pool }),
        bus,
        providers: { ma: managedAgents({ client: new Anthropic() }) },
        tools: {
          lookup_order: {
            description: 'Look up an order by id',
            inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
            handler: ({ id }) => orders.find(id),
          },
        },
        approvals: { policy: ({ name }) => (name === 'Read' ? 'allow' : 'ask') },
      }),
    }),
  ],
  controllers: [SessionsController],
})
export class AppModule {}
```

`useFactory` returns the same options as `createRuntime()`. Your own modules create and close the
database pool and the bus; the runtime module only starts and stops the runtime. A complete
`DatabaseModule` is in the [example README](../examples/nestjs/README.md#going-to-production).

> Tool handlers often need other services, such as a repository. Inject them into `useFactory`
> with `inject: [...]` and close over them in `handler`.

## 3. Write the routes

A frontend needs five routes. Inject the runtime with `@InjectRuntime()`:

```ts
@Controller('sessions')
@UseFilters(AgentRuntimeExceptionFilter)
export class SessionsController {
  constructor(@InjectRuntime() private readonly runtime: Runtime) {}

  @Post()
  async create(@Body() body: { userId: string }) {
    const session = await this.runtime.createSession({
      provider: 'ma',
      config: { agent: 'agent_…', environmentId: 'env_…' },
      metadata: { userId: body.userId },
    })
    return { id: session.id }
  }

  @Post(':id/messages')
  @HttpCode(202)
  async send(@Param('id') id: string, @Body() body: { text: string }) {
    await (await getSessionOr404(this.runtime, id)).send(body.text)
  }

  @Post(':id/interrupt')
  @HttpCode(202)
  async interrupt(@Param('id') id: string) {
    await (await getSessionOr404(this.runtime, id)).interrupt()
  }

  @Post(':id/approvals/:approvalId')
  @HttpCode(202)
  async resolve(@Param('id') id: string, @Param('approvalId') approvalId: string, @Body() body: { decision: 'allow' | 'deny' }) {
    await (await getSessionOr404(this.runtime, id)).resolveApproval(approvalId, body.decision)
  }

  @Sse(':id/events')
  async events(@Param('id') id: string, @Req() req: Request) {
    const session = await getSessionOr404(this.runtime, id)
    return sessionEvents(session, { after: lastEventId(req) })
  }
}
```

What each piece does:

- **`getSessionOr404`** returns 404 for unknown session ids.
- **`AgentRuntimeExceptionFilter`** turns runtime errors into status codes. For example,
  resolving an approval that was already resolved gives 409.
- **`sessionEvents` + `lastEventId`** replay everything after the client's `Last-Event-ID`, then
  stream live events. A browser `EventSource` reconnects with that header automatically, so it
  never misses or duplicates an event. Consume the stream as described in the
  [frontend guide](frontend-guide.md).
- **Any instance can serve any route.** Commands are routed to the instance that holds the
  provider stream, and events reach every instance (see [Scaling and failover](scaling-and-failover.md)).

Add your own authentication and authorization, for example a guard that checks that
`session.info().metadata.userId` matches the caller. The library has no notion of users.

## 4. Bootstrap and shut down

```ts
const app = await NestFactory.create(AppModule, { forceCloseConnections: true })
app.enableShutdownHooks()
await app.listen(3000)
```

The module starts the runtime in `onApplicationBootstrap`. From then on, this instance takes over
sessions whose owner died. On shutdown it closes the runtime in `beforeApplicationShutdown`: the
sessions this instance owned are released, and other instances pick them up within one orphan
scan. Agents keep working throughout. Your pool and bus close afterwards, in their own
`onApplicationShutdown`.

- **Without `enableShutdownHooks()`,** a `SIGTERM` skips all of this. Other instances take the
  sessions over only after the leases expire (about 15 seconds by default).
- **Without `forceCloseConnections`,** `app.close()` waits until every SSE client disconnects.

## Testing

Use the in-memory store and the scriptable fake provider. No database or API keys are needed:

```ts
import { MemoryBus, MemoryStore } from '@agent-runtime/stores-memory'
import { FakeProvider } from '@agent-runtime/core/testing'

const fake = new FakeProvider()
fake.onSend = (sessionId) => fake.emit(sessionId, { kind: 'event', event: { type: 'runtime.turn.completed', data: { stopReason: 'end_turn' } } })

const moduleRef = await Test.createTestingModule({
  imports: [AgentRuntimeModule.forRoot({ store: new MemoryStore(), bus: new MemoryBus(), providers: { ma: fake } })],
  controllers: [SessionsController],
}).compile()
```

The example's [`test/app.test.ts`](../examples/nestjs/test/app.test.ts) boots a real HTTP server
and checks streaming, resume, approvals, and error codes.
