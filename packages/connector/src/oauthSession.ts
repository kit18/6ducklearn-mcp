import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { RuntimeType } from './types.js';

export interface ConnectorOAuthSession {
  client_id: string;
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  scope?: string;
  token_endpoint?: string;
  resource?: string;
  runtime_type?: RuntimeType;
  token_id?: string;
  agent_id?: string;
}

export interface ConnectorOAuthSessionRequest {
  runtimeType?: RuntimeType;
  tokenId?: string | null;
  agentId?: string | null;
}

export function defaultOAuthSessionPath(): string {
  return join(homedir(), '.6ducklearn', 'connector', 'oauth-session.json');
}

export function readOAuthSession(path = defaultOAuthSessionPath()): ConnectorOAuthSession | null {
  if (!existsSync(path)) return null;

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ConnectorOAuthSession>;
    if (typeof parsed.client_id !== 'string' || typeof parsed.access_token !== 'string') {
      return null;
    }

    return {
      client_id: parsed.client_id,
      access_token: parsed.access_token,
      refresh_token: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : undefined,
      expires_at: typeof parsed.expires_at === 'string' ? parsed.expires_at : undefined,
      scope: typeof parsed.scope === 'string' ? parsed.scope : undefined,
      token_endpoint: typeof parsed.token_endpoint === 'string' ? parsed.token_endpoint : undefined,
      resource: typeof parsed.resource === 'string' ? parsed.resource : undefined,
      runtime_type:
        parsed.runtime_type === 'codex' || parsed.runtime_type === 'openclaw' || parsed.runtime_type === 'hermes'
          ? parsed.runtime_type
          : undefined,
      token_id: typeof parsed.token_id === 'string' ? parsed.token_id : undefined,
      agent_id: typeof parsed.agent_id === 'string' ? parsed.agent_id : undefined,
    };
  } catch {
    return null;
  }
}

export function oauthSessionMatchesRequest(
  session: ConnectorOAuthSession | null,
  request: ConnectorOAuthSessionRequest,
): session is ConnectorOAuthSession {
  if (!session) return false;

  if (request.runtimeType && session.runtime_type && session.runtime_type !== request.runtimeType) {
    return false;
  }

  if (request.tokenId && session.token_id !== request.tokenId) {
    return false;
  }

  if (request.agentId && session.agent_id !== request.agentId) {
    return false;
  }

  return true;
}

export function writeOAuthSession(session: ConnectorOAuthSession, path = defaultOAuthSessionPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}
