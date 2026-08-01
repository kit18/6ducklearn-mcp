import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  codexOAuthIsReady,
  codexSetupResultMessage,
  codexServerMatches,
  shouldRunCodexOAuthLogin,
  withUserAgentHeader,
} from '../../../scripts/6ducklearn-mcp.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const setupScript = path.join(repoRoot, 'scripts/6ducklearn-mcp.mjs');

test('public Codex setup requests only hosted MCP scopes', () => {
  const output = execFileSync(process.execPath, [setupScript, 'setup-codex', '--dry-run'], {
    encoding: 'utf8',
  });

  assert.match(output, /--scopes 'mcp:read,mcp:write'/);
  assert.doesNotMatch(output, /approval:decide|control:write|policy:read|runtime:connect/);
});

test('matching Codex configuration and compatibility header are idempotent', () => {
  const server = {
    transport: {
      type: 'streamable_http',
      url: 'https://6ducklearn.com/mcp',
    },
  };
  assert.equal(codexServerMatches(server, 'https://6ducklearn.com/mcp'), true);
  assert.equal(codexServerMatches(server, 'https://example.com/mcp'), false);
  assert.equal(codexOAuthIsReady({ ...server, auth_status: 'o_auth' }), true);
  assert.equal(codexOAuthIsReady({ ...server, auth_status: 'not_logged_in' }), false);
  assert.equal(shouldRunCodexOAuthLogin({ ...server, auth_status: 'o_auth' }, 'https://6ducklearn.com/mcp', false), false);
  assert.equal(shouldRunCodexOAuthLogin({ ...server, auth_status: 'not_logged_in' }, 'https://6ducklearn.com/mcp', false), true);
  assert.equal(shouldRunCodexOAuthLogin(server, 'https://example.com/mcp', false), true);
  assert.equal(shouldRunCodexOAuthLogin(server, 'https://example.com/mcp', true), false);

  const initialConfig = [
    '[mcp_servers.6ducklearn]',
    'url = "https://6ducklearn.com/mcp"',
    '',
  ].join('\n');
  const once = withUserAgentHeader(initialConfig, '6ducklearn');
  const twice = withUserAgentHeader(once, '6ducklearn');
  assert.equal(twice, once);
  assert.equal(twice.match(/\[mcp_servers\.6ducklearn\.http_headers\]/g)?.length, 1);
  assert.equal(twice.match(/^User-Agent =/gm)?.length, 1);
});

test('Codex setup reports connected, unchanged, and no-login states truthfully', () => {
  assert.equal(
    codexSetupResultMessage({ serverMatches: true, oauthReady: true, noLogin: false }),
    'Hosted 6DuckLearn MCP is already connected in Codex. No changes were needed.',
  );
  assert.equal(
    codexSetupResultMessage({ serverMatches: false, oauthReady: false, noLogin: false }),
    'Hosted 6DuckLearn MCP is connected in Codex. Open a new Codex chat to load the approved tools.',
  );
  assert.equal(
    codexSetupResultMessage({ serverMatches: true, oauthReady: false, noLogin: true }),
    'Hosted 6DuckLearn MCP is configured in Codex. OAuth login was skipped because --no-login was set.',
  );
});
