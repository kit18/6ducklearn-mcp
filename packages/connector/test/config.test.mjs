import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../dist/config.js';

const ENV_KEYS = [
  'HOME',
  'SIXDUCK_SUPABASE_URL',
  'SIXDUCK_RUNTIME_TYPE',
  'SIXDUCK_OAUTH_SESSION_PATH',
  'SIXDUCK_OAUTH_TOKEN_ID',
  'SIXDUCK_AGENT_ID',
  'SIXDUCK_TOKEN_ID',
  'SIXDUCK_HMAC_SECRET',
  'DUCK_SUPABASE_URL',
  'DUCK_RUNTIME_TYPE',
  'DUCK_OAUTH_SESSION_PATH',
  'DUCK_OAUTH_TOKEN_ID',
  'DUCK_AGENT_ID',
  'DUCK_TOKEN_ID',
  'DUCK_HMAC_SECRET',
];

function withEnv(overrides, fn) {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(overrides)) {
    process.env[key] = value;
  }

  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function writeSession(path, overrides = {}) {
  writeFileSync(path, `${JSON.stringify({
    client_id: 'client-1',
    access_token: 'stored-access-token',
    refresh_token: 'stored-refresh-token',
    token_endpoint: 'https://example.supabase.co/functions/v1/oauth/mcp/token',
    runtime_type: 'codex',
    token_id: 'token-a',
    agent_id: 'agent-a',
    ...overrides,
  })}\n`);
}

test('loadConfig uses a saved OAuth session that matches the requested token binding', () => {
  const home = mkdtempSync(join(tmpdir(), '6ducklearn-connector-config-'));
  const sessionPath = join(home, 'oauth-session-codex-token-a.json');
  writeSession(sessionPath);

  withEnv({
    HOME: home,
    SIXDUCK_SUPABASE_URL: 'https://example.supabase.co',
    SIXDUCK_RUNTIME_TYPE: 'codex',
    SIXDUCK_OAUTH_SESSION_PATH: sessionPath,
    SIXDUCK_OAUTH_TOKEN_ID: 'token-a',
    SIXDUCK_AGENT_ID: 'agent-a',
  }, () => {
    const config = loadConfig();
    assert.equal(config.oauthAccessToken, 'stored-access-token');
    assert.equal(config.oauthTokenId, 'token-a');
    assert.equal(config.oauthAgentId, 'agent-a');
    assert.equal(config.oauthRuntimeType, 'codex');
  });
});

test('loadConfig rejects a stale saved OAuth session for a different requested token', () => {
  const home = mkdtempSync(join(tmpdir(), '6ducklearn-connector-config-'));
  const sessionPath = join(home, 'oauth-session-codex-token-a.json');
  writeSession(sessionPath, { token_id: 'token-a' });

  withEnv({
    HOME: home,
    SIXDUCK_SUPABASE_URL: 'https://example.supabase.co',
    SIXDUCK_RUNTIME_TYPE: 'codex',
    SIXDUCK_OAUTH_SESSION_PATH: sessionPath,
    SIXDUCK_OAUTH_TOKEN_ID: 'token-b',
  }, () => {
    assert.throws(
      () => loadConfig(),
      /Missing connector credentials/,
    );
  });
});
