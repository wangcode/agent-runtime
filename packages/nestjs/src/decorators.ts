import { Inject } from '@nestjs/common'
import { AGENT_RUNTIME } from './tokens.js'

/** Inject the `Runtime`: `constructor(@InjectRuntime() private readonly runtime: Runtime) {}`. */
export const InjectRuntime = (): ParameterDecorator & PropertyDecorator => Inject(AGENT_RUNTIME)
