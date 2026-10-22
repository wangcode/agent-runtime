import {
  type ArgumentsHost,
  Catch,
  ConflictException,
  HttpException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common'
import { BaseExceptionFilter } from '@nestjs/core'
import { CapabilityError, CommandError, type Runtime, type Session } from '@agent-runtime/core'

/**
 * Translate a runtime error into an HTTP exception, or `undefined` if it isn't one:
 * - `CommandError` (the command failed or timed out) → 409 Conflict;
 * - `CapabilityError` (the provider can't do that) → 422 Unprocessable Entity;
 * - unknown or terminated session → 404 / 409.
 */
export function toHttpException(err: unknown): HttpException | undefined {
  if (err instanceof HttpException) return err
  if (err instanceof CommandError) return new ConflictException(err.message)
  if (err instanceof CapabilityError) return new UnprocessableEntityException(err.message)
  if (err instanceof Error && /^Session \S+ not found$/.test(err.message)) return new NotFoundException(err.message)
  if (err instanceof Error && /^Session \S+ is terminated$/.test(err.message)) return new ConflictException(err.message)
  return undefined
}

/**
 * Maps runtime errors to HTTP status codes (see `toHttpException`) and leaves everything else to
 * Nest's default handling. Use it with `@UseFilters(AgentRuntimeExceptionFilter)` or register it
 * globally as an `APP_FILTER` provider; let Nest instantiate it.
 */
@Catch()
export class AgentRuntimeExceptionFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost) {
    super.catch(toHttpException(exception) ?? exception, host)
  }
}

/** `runtime.getSession(id)`, throwing `NotFoundException` when it doesn't exist. */
export async function getSessionOr404(runtime: Runtime, id: string): Promise<Session> {
  const session = await runtime.getSession(id)
  if (!session) throw new NotFoundException(`Session ${id} not found`)
  return session
}
