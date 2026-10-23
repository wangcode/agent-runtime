import { Sha256 } from '@aws-crypto/sha256-js'
import { HttpRequest } from '@smithy/protocol-http'
import { SignatureV4 } from '@smithy/signature-v4'
import type { AwsCredentialIdentity, AwsCredentialIdentityProvider } from '@smithy/types'

export const SESSION_ID_HEADER = 'X-Amzn-Bedrock-AgentCore-Runtime-Session-Id'

export interface AgentCoreEndpoint {
  region: string
  /** ARN of the agent runtime. */
  runtimeArn: string
  /** Endpoint qualifier (e.g. `DEFAULT`). */
  qualifier?: string
  /** Override the host, e.g. for VPC endpoints. */
  host?: string
}

export const agentCoreWsTarget = (ep: AgentCoreEndpoint) => {
  const hostname = ep.host ?? `bedrock-agentcore.${ep.region}.amazonaws.com`
  const path = `/runtimes/${encodeURIComponent(ep.runtimeArn)}/ws`
  const query: Record<string, string> = ep.qualifier ? { qualifier: ep.qualifier } : {}
  return { hostname, path, query }
}

/** SigV4-signed headers for the WebSocket upgrade (`bedrock-agentcore:InvokeAgentRuntimeWithWebSocketStream`). */
export async function signWebSocketRequest(
  ep: AgentCoreEndpoint,
  runtimeSessionId: string,
  credentials: AwsCredentialIdentity | AwsCredentialIdentityProvider,
): Promise<{ url: string; headers: Record<string, string> }> {
  const { hostname, path, query } = agentCoreWsTarget(ep)
  const signer = new SignatureV4({ service: 'bedrock-agentcore', region: ep.region, credentials, sha256: Sha256 })
  const request = new HttpRequest({
    method: 'GET',
    protocol: 'https:',
    hostname,
    path,
    query,
    headers: { host: hostname, [SESSION_ID_HEADER]: runtimeSessionId },
  })
  const signed = await signer.sign(request)
  const qs = new URLSearchParams(query).toString()
  return { url: `wss://${hostname}${path}${qs ? `?${qs}` : ''}`, headers: signed.headers as Record<string, string> }
}
