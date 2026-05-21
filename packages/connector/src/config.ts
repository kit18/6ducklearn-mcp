import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { homedir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ConnectorConfig, RuntimeType } from './types.js';
import { defaultOAuthSessionPath, oauthSessionMatchesRequest, readOAuthSession } from './oauthSession.js';

const DEFAULT_ADAPTER_VERSION = '0.0.2';

function readEnv(name: string, alternateName?: string): string | undefined {
  if (alternateName) {
    const alternateValue = process.env[alternateName];
    if (alternateValue) return alternateValue;
  }
  const value = process.env[name];
  if (value) return value;
  return undefined;
}

function requireEnv(name: string, alternateName?: string): string {
  const value = readEnv(name, alternateName);
  if (!value) {
    const alternateHint = alternateName ? ` or ${alternateName}` : '';
    throw new Error(`Missing required environment variable: ${name}${alternateHint}`);
  }
  return value;
}

function parseNumberEnv(name: string, fallback: number, alternateName?: string): number {
  const value = readEnv(name, alternateName);
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBooleanEnv(name: string, fallback = false, alternateName?: string): boolean {
  const value = readEnv(name, alternateName);
  if (!value) {
    return fallback;
  }
  return value === '1' || value.toLowerCase() === 'true' || value.toLowerCase() === 'yes';
}

function resolveDeviceId(): string {
  const configuredDeviceId = readEnv('DUCK_DEVICE_ID', 'SIXDUCK_DEVICE_ID');
  if (configuredDeviceId) {
    return configuredDeviceId;
  }

  const directory = join(homedir(), '.6ducklearn', 'connector');
  const filePath = join(directory, 'device-id');
  if (existsSync(filePath)) {
    return readFileSync(filePath, 'utf8').trim();
  }

  mkdirSync(directory, { recursive: true });
  const deviceId = randomUUID();
  writeFileSync(filePath, `${deviceId}\n`, 'utf8');
  return deviceId;
}

function resolveRuntimeType(): RuntimeType {
  const runtimeType = readEnv('DUCK_RUNTIME_TYPE', 'SIXDUCK_RUNTIME_TYPE');
  if (runtimeType === 'openclaw') return 'openclaw';
  if (runtimeType === 'hermes') return 'hermes';
  return 'codex';
}

export function loadConfig(): ConnectorConfig {
  const runtimeType = resolveRuntimeType();
  const codexCwd = readEnv('DUCK_CODEX_CWD', 'SIXDUCK_CODEX_CWD') ?? process.cwd();
  const codexReasoning = readEnv('DUCK_CODEX_REASONING', 'SIXDUCK_CODEX_REASONING');
  const codexSummary = readEnv('DUCK_CODEX_SUMMARY', 'SIXDUCK_CODEX_SUMMARY');
  const oauthSessionPath = readEnv('DUCK_OAUTH_SESSION_PATH', 'SIXDUCK_OAUTH_SESSION_PATH') ?? defaultOAuthSessionPath();
  const requestedOAuthTokenId = readEnv('DUCK_OAUTH_TOKEN_ID', 'SIXDUCK_OAUTH_TOKEN_ID')
    ?? readEnv('DUCK_TOKEN_ID', 'SIXDUCK_TOKEN_ID')
    ?? null;
  const requestedAgentId = readEnv('DUCK_AGENT_ID', 'SIXDUCK_AGENT_ID') ?? null;
  const storedOAuthSessionCandidate = readOAuthSession(oauthSessionPath);
  const storedOAuthSession = oauthSessionMatchesRequest(storedOAuthSessionCandidate, {
    runtimeType,
    tokenId: requestedOAuthTokenId,
    agentId: requestedAgentId,
  }) ? storedOAuthSessionCandidate : null;
  const oauthAccessToken = readEnv('DUCK_OAUTH_ACCESS_TOKEN', 'SIXDUCK_OAUTH_ACCESS_TOKEN')
    ?? storedOAuthSession?.access_token
    ?? null;
  const oauthRefreshToken = readEnv('DUCK_OAUTH_REFRESH_TOKEN', 'SIXDUCK_OAUTH_REFRESH_TOKEN')
    ?? storedOAuthSession?.refresh_token
    ?? null;
  const oauthClientId = readEnv('DUCK_OAUTH_CLIENT_ID', 'SIXDUCK_OAUTH_CLIENT_ID')
    ?? storedOAuthSession?.client_id
    ?? null;
  const oauthTokenEndpoint = readEnv('DUCK_OAUTH_TOKEN_ENDPOINT', 'SIXDUCK_OAUTH_TOKEN_ENDPOINT')
    ?? storedOAuthSession?.token_endpoint
    ?? null;
  const oauthExpiresAt = readEnv('DUCK_OAUTH_EXPIRES_AT', 'SIXDUCK_OAUTH_EXPIRES_AT')
    ?? storedOAuthSession?.expires_at
    ?? null;
  const oauthScope = readEnv('DUCK_OAUTH_SCOPE', 'SIXDUCK_OAUTH_SCOPE')
    ?? storedOAuthSession?.scope
    ?? null;
  const oauthResource = readEnv('DUCK_OAUTH_RESOURCE', 'SIXDUCK_OAUTH_RESOURCE')
    ?? storedOAuthSession?.resource
    ?? null;
  const tokenId = readEnv('DUCK_TOKEN_ID', 'SIXDUCK_TOKEN_ID') ?? null;
  const hmacSecret = readEnv('DUCK_HMAC_SECRET', 'SIXDUCK_HMAC_SECRET') ?? null;

  if (!oauthAccessToken && (!tokenId || !hmacSecret)) {
    throw new Error(
      'Missing connector credentials: set SIXDUCK_OAUTH_ACCESS_TOKEN, or set both SIXDUCK_TOKEN_ID and SIXDUCK_HMAC_SECRET. Legacy DUCK_* aliases are still accepted.',
    );
  }

  return {
    supabaseUrl: requireEnv('DUCK_SUPABASE_URL', 'SIXDUCK_SUPABASE_URL'),
    tokenId,
    hmacSecret,
    oauthAccessToken,
    oauthRefreshToken,
    oauthClientId,
    oauthTokenEndpoint,
    oauthExpiresAt,
    oauthSessionPath,
    oauthScope,
    oauthResource,
    oauthRuntimeType: storedOAuthSession?.runtime_type ?? runtimeType,
    oauthTokenId: storedOAuthSession?.token_id ?? requestedOAuthTokenId,
    oauthAgentId: storedOAuthSession?.agent_id ?? requestedAgentId,
    deviceId: resolveDeviceId(),
    deviceName: readEnv('DUCK_DEVICE_NAME', 'SIXDUCK_DEVICE_NAME') ?? `${hostname()} · ${basename(codexCwd) || 'workspace'}`,
    runtimeType,
    pollIntervalMs: parseNumberEnv('DUCK_POLL_INTERVAL_MS', 2000, 'SIXDUCK_POLL_INTERVAL_MS'),
    heartbeatIntervalMs: parseNumberEnv('DUCK_HEARTBEAT_INTERVAL_MS', 20_000, 'SIXDUCK_HEARTBEAT_INTERVAL_MS'),
    serviceName: readEnv('DUCK_SERVICE_NAME', 'SIXDUCK_SERVICE_NAME') ?? 'sixducklearn_connector',
    adapterVersion: readEnv('DUCK_CONNECTOR_VERSION', 'SIXDUCK_CONNECTOR_VERSION') ?? DEFAULT_ADAPTER_VERSION,
    codex: {
      model: readEnv('DUCK_CODEX_MODEL', 'SIXDUCK_CODEX_MODEL') ?? 'gpt-5.4',
      reasoningEffort:
        codexReasoning === 'low' || codexReasoning === 'high'
          ? codexReasoning
          : 'medium',
      summary:
        codexSummary === 'auto' || codexSummary === 'detailed'
          ? codexSummary
          : 'concise',
      cwd: codexCwd,
      minVersion: readEnv('DUCK_CODEX_MIN_VERSION', 'SIXDUCK_CODEX_MIN_VERSION') ?? '0.117.0',
      quietProfile: parseBooleanEnv('DUCK_CODEX_QUIET_PROFILE', true, 'SIXDUCK_CODEX_QUIET_PROFILE'),
    },
    openclaw: {
      gatewayUrl: readEnv('DUCK_OPENCLAW_GATEWAY_URL', 'SIXDUCK_OPENCLAW_GATEWAY_URL') ?? 'ws://127.0.0.1:18789',
      gatewayToken: readEnv('DUCK_OPENCLAW_GATEWAY_TOKEN', 'SIXDUCK_OPENCLAW_GATEWAY_TOKEN') ?? null,
      gatewayPassword: readEnv('DUCK_OPENCLAW_GATEWAY_PASSWORD', 'SIXDUCK_OPENCLAW_GATEWAY_PASSWORD') ?? null,
      allowInsecureLocalAuth: parseBooleanEnv('DUCK_OPENCLAW_ALLOW_INSECURE_LOCAL_AUTH', false, 'SIXDUCK_OPENCLAW_ALLOW_INSECURE_LOCAL_AUTH'),
      sessionKey: readEnv('DUCK_OPENCLAW_SESSION_KEY', 'SIXDUCK_OPENCLAW_SESSION_KEY') ?? 'main',
      protocolVersion: parseNumberEnv('DUCK_OPENCLAW_PROTOCOL_VERSION', 3, 'SIXDUCK_OPENCLAW_PROTOCOL_VERSION'),
    },
    hermes: {
      baseUrl: readEnv('DUCK_HERMES_BASE_URL', 'SIXDUCK_HERMES_BASE_URL') ?? 'http://127.0.0.1:8642/v1',
      apiKey: readEnv('DUCK_HERMES_API_KEY', 'SIXDUCK_HERMES_API_KEY') ?? null,
      conversationPrefix: readEnv('DUCK_HERMES_CONVERSATION_PREFIX', 'SIXDUCK_HERMES_CONVERSATION_PREFIX') ?? '6ducklearn',
    },
  };
}
