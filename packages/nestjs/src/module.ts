import {
  type BeforeApplicationShutdown,
  type DynamicModule,
  type FactoryProvider,
  Inject,
  Injectable,
  type ModuleMetadata,
  Module,
  type OnApplicationBootstrap,
  type Provider,
} from '@nestjs/common'
import { Runtime, type RuntimeOptions } from '@agent-runtime/core'
import { AGENT_RUNTIME, AGENT_RUNTIME_OPTIONS } from './tokens.js'

export interface AgentRuntimeModuleOptions extends RuntimeOptions {
  /** Register the module globally, so feature modules can inject the runtime without importing it. Default `true`. */
  global?: boolean
}

export interface AgentRuntimeModuleAsyncOptions {
  imports?: ModuleMetadata['imports']
  inject?: FactoryProvider['inject']
  useFactory: (...args: any[]) => RuntimeOptions | Promise<RuntimeOptions>
  /** Default `true`. */
  global?: boolean
}

/**
 * Starts the runtime once the application has bootstrapped, and closes it (releasing the
 * sessions this instance owns) before other providers shut down. Your store and bus stay open
 * until their own shutdown hooks run.
 */
@Injectable()
class AgentRuntimeLifecycle implements OnApplicationBootstrap, BeforeApplicationShutdown {
  constructor(@Inject(AGENT_RUNTIME) private readonly runtime: Runtime) {}

  onApplicationBootstrap() {
    this.runtime.start()
  }

  async beforeApplicationShutdown() {
    await this.runtime.close()
  }
}

const runtimeProviders: Provider[] = [
  { provide: AGENT_RUNTIME, useFactory: (options: RuntimeOptions) => new Runtime(options), inject: [AGENT_RUNTIME_OPTIONS] },
  { provide: Runtime, useExisting: AGENT_RUNTIME },
  AgentRuntimeLifecycle,
]

const exportsList = [AGENT_RUNTIME, Runtime, AGENT_RUNTIME_OPTIONS]

@Module({})
export class AgentRuntimeModule {
  /** Register the runtime with static options. */
  static forRoot(options: AgentRuntimeModuleOptions): DynamicModule {
    const { global = true, ...runtimeOptions } = options
    return {
      module: AgentRuntimeModule,
      global,
      providers: [{ provide: AGENT_RUNTIME_OPTIONS, useValue: runtimeOptions }, ...runtimeProviders],
      exports: exportsList,
    }
  }

  /** Register the runtime with options built from other providers (database pool, config, …). */
  static forRootAsync(options: AgentRuntimeModuleAsyncOptions): DynamicModule {
    return {
      module: AgentRuntimeModule,
      global: options.global ?? true,
      imports: options.imports ?? [],
      providers: [{ provide: AGENT_RUNTIME_OPTIONS, useFactory: options.useFactory, inject: options.inject ?? [] }, ...runtimeProviders],
      exports: exportsList,
    }
  }
}
