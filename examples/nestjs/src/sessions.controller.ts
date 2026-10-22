import { Body, Controller, HttpCode, Param, Post, Req, Sse, UseFilters } from '@nestjs/common'
import type { Observable } from 'rxjs'
import type { Runtime } from '@agent-runtime/core'
import {
  AgentRuntimeExceptionFilter,
  InjectRuntime,
  type SseMessage,
  getSessionOr404,
  lastEventId,
  sessionEvents,
} from '@agent-runtime/nestjs'

/**
 * The HTTP surface for a frontend. Any instance can serve any route: the runtime routes commands
 * to the instance that owns the provider stream and fans events out to every instance.
 */
@Controller('sessions')
@UseFilters(AgentRuntimeExceptionFilter)
export class SessionsController {
  constructor(@InjectRuntime() private readonly runtime: Runtime) {}

  @Post()
  async create(@Body() body: { provider?: string; config?: unknown; metadata?: Record<string, unknown> }) {
    const session = await this.runtime.createSession({ provider: body?.provider ?? 'sim', config: body?.config ?? {}, metadata: body?.metadata ?? {} })
    return { id: session.id }
  }

  @Post(':id/messages')
  @HttpCode(202)
  async send(@Param('id') id: string, @Body() body: { text?: string; system?: string }) {
    const session = await getSessionOr404(this.runtime, id)
    await session.send(String(body?.text ?? ''), body?.system ? { system: body.system } : {})
    return { ok: true }
  }

  @Post(':id/interrupt')
  @HttpCode(202)
  async interrupt(@Param('id') id: string) {
    await (await getSessionOr404(this.runtime, id)).interrupt()
    return { ok: true }
  }

  @Post(':id/approvals/:approvalId')
  @HttpCode(202)
  async resolve(@Param('id') id: string, @Param('approvalId') approvalId: string, @Body() body: { decision?: string; message?: string }) {
    const session = await getSessionOr404(this.runtime, id)
    await session.resolveApproval(approvalId, body?.decision === 'allow' ? 'allow' : 'deny', body?.message)
    return { ok: true }
  }

  /** Replays everything after Last-Event-ID, then streams live events. The agent keeps working if the client leaves. */
  @Sse(':id/events')
  async events(@Param('id') id: string, @Req() req: { headers: Record<string, string | undefined>; query: unknown }): Promise<Observable<SseMessage>> {
    const session = await getSessionOr404(this.runtime, id)
    return sessionEvents(session, { after: lastEventId(req) })
  }
}
