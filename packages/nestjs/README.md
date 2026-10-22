# @agent-runtime/nestjs

NestJS integration for `agent-runtime`:

- **`AgentRuntimeModule`** registers a `Runtime` for injection. It starts the runtime when the app
  has bootstrapped and closes it on shutdown.
- **`sessionEvents()`** turns a session's event stream into an `Observable` for `@Sse()` routes,
  with `Last-Event-ID` resume and heartbeats.
- **`AgentRuntimeExceptionFilter`** maps runtime errors to HTTP status codes.

You write your own controllers; this package doesn't add routes. For a walkthrough, see the
[NestJS guide](../../docs/nestjs.md).

Supports NestJS 10 and 11.

## Install

```bash
pnpm add @agent-runtime/nestjs @agent-runtime/core
```

`@nestjs/common`, `@nestjs/core`, and `rxjs` are peer dependencies.

## Register the module

With static options:

```ts
import { Module } from '@nestjs/common'
import { MemoryBus, MemoryStore } from '@agent-runtime/core'
import { AgentRuntimeModule } from '@agent-runtime/nestjs'

@Module({
  imports: [AgentRuntimeModule.forRoot({ store: new MemoryStore(), bus: new MemoryBus(), providers: { ma } })],
})
export class AppModule {}
```

With options built from other providers. This is the usual way with Postgres:

```ts
AgentRuntimeModule.forRootAsync({
  imports: [DatabaseModule],
  inject: [PG_POOL, PG_BUS],
  useFactory: (pool: pg.Pool, bus: PgBus) => ({
    store: new PgStore({ pool }),
    bus,
    providers: { ma: managedAgents({ client: new Anthropic() }) },
    tools: { lookup_order: { /* … */ } },
  }),
})
```

| Option | Default | Description |
| --- | --- | --- |
| everything in `RuntimeOptions` | | See [`@agent-runtime/core`](../core/README.md#createruntimeoptions-runtime) |
| `global` | `true` | Register globally, so feature modules can inject the runtime without importing the module |
| `forRootAsync`: `imports`, `inject`, `useFactory` | | Standard Nest async-provider fields. `useFactory` returns (or resolves to) `RuntimeOptions` |

## Inject the runtime

```ts
import type { Runtime } from '@agent-runtime/core'
import { InjectRuntime } from '@agent-runtime/nestjs'

@Injectable()
export class ChatService {
  constructor(@InjectRuntime() private readonly runtime: Runtime) {}
}
```

The runtime is also registered under the `Runtime` class itself. If your build emits decorator
metadata (`tsc` with `emitDecoratorMetadata`), `constructor(private runtime: Runtime)` works too.
`@InjectRuntime()` works with every build tool, including esbuild, swc without metadata, and
vitest.

## Stream events with `@Sse()`

```ts
import { sessionEvents, lastEventId, getSessionOr404 } from '@agent-runtime/nestjs'

@Sse('sessions/:id/events')
async events(@Param('id') id: string, @Req() req: Request) {
  const session = await getSessionOr404(this.runtime, id)
  return sessionEvents(session, { after: lastEventId(req) })
}
```

On the wire:

- **One SSE message per event.** `event:` is the event type and `data:` the event as JSON, the
  same as `toSSE()` in core, so the [frontend guide](../../docs/frontend-guide.md) applies
  unchanged.
- **`id:` is always the latest persisted `seq`, on deltas and heartbeats too.** Nest assigns its
  own counter to messages without an id, which would break the browser's `Last-Event-ID`.
  Repeating the last `seq` keeps reconnects exact: the client gets every persisted event after it
  once, and no duplicates.
- **Heartbeat.** A `: ping` comment every `heartbeatMs` (default 15 s) keeps proxies from closing
  idle streams.
- **Disconnects.** When the client disconnects, the stream stops. The agent keeps working.

| `sessionEvents` option | Default | Description |
| --- | --- | --- |
| `after` | — | Replay persisted events after this `seq`. Pass `lastEventId(req)` |
| `includeDeltas` | `true` | Live token deltas (`agent.text.delta`, …) |
| `heartbeatMs` | `15000` | `0` disables |
| `includeRaw` | `false` | Include the provider's original payload as `raw` |

`lastEventId(req)` reads the `Last-Event-ID` header that `EventSource` sends on reconnect, or an
`?after=` query parameter. It works with Express and Fastify.

## Map errors to status codes

```ts
@Controller('sessions')
@UseFilters(AgentRuntimeExceptionFilter)
export class SessionsController {}
```

Register it globally with `{ provide: APP_FILTER, useClass: AgentRuntimeExceptionFilter }`. Let
Nest create it rather than calling `new`.

| Error | Status |
| --- | --- |
| `CommandError` (the command failed or timed out, e.g. an approval already resolved) | 409 |
| `CapabilityError` (the provider can't do it, e.g. `updatedInput` on Managed Agents) | 422 |
| Unknown session | 404 |
| Terminated session | 409 |
| Anything else | Nest's default handling |

`toHttpException(err)` performs the same mapping if you handle errors yourself.
`getSessionOr404(runtime, id)` throws `NotFoundException` for unknown ids.

## Lifecycle

| Nest hook | What happens |
| --- | --- |
| Module init | `new Runtime(options)`; nothing runs in the background yet |
| `onApplicationBootstrap` | `runtime.start()`: this instance begins adopting sessions whose owner died |
| `beforeApplicationShutdown` | `runtime.close()`: owned sessions are released so other instances pick them up immediately |
| `onApplicationShutdown` (yours) | Close your bus and pool here. They are still open while the runtime closes |

Two settings matter in `main.ts`:

```ts
const app = await NestFactory.create(AppModule, { forceCloseConnections: true })
app.enableShutdownHooks()
```

- **`enableShutdownHooks()`.** Without it, Nest doesn't run shutdown hooks on `SIGTERM`, so the
  runtime isn't closed. Its sessions are then taken over only after their leases expire.
- **`forceCloseConnections: true`.** Open SSE streams never end on their own, so without this
  `app.close()` waits for every client to disconnect.

## Exports

| Export | Description |
| --- | --- |
| `AgentRuntimeModule`, `AgentRuntimeModuleOptions`, `AgentRuntimeModuleAsyncOptions` | The module |
| `InjectRuntime()`, `AGENT_RUNTIME`, `AGENT_RUNTIME_OPTIONS` | Injection decorator and tokens |
| `sessionEvents()`, `lastEventId()`, `SessionEventsOptions`, `SseMessage` | SSE helpers |
| `AgentRuntimeExceptionFilter`, `toHttpException()`, `getSessionOr404()` | Error handling |

## Further reading

- [NestJS guide](../../docs/nestjs.md)
- [`examples/nestjs`](../../examples/nestjs/README.md), a runnable app
