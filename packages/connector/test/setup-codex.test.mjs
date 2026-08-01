import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  codexOAuthIsReady,
  codexOAuthState,
  codexSetupResultMessage,
  codexServerMatches,
  shouldRunCodexOAuthLogin,
  withUserAgentHeader,
} from '../../../scripts/6ducklearn-mcp.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const setupScript = path.join(repoRoot, 'scripts/6ducklearn-mcp.mjs');

function createFakeCodex() {
  const root = mkdtempSync(path.join(tmpdir(), '6ducklearn-codex-setup-'));
  const binDir = path.join(root, 'bin');
  const codexHome = path.join(root, 'codex-home');
  const fakeCodex = path.join(binDir, 'codex');
  const logPath = path.join(root, 'calls.jsonl');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(fakeCodex, `#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
const configPath = path.join(process.env.CODEX_HOME, 'config.toml');
const log = () => {
  if (process.env.FAKE_CODEX_LOG) {
    const current = existsSync(process.env.FAKE_CODEX_LOG) ? readFileSync(process.env.FAKE_CODEX_LOG, 'utf8') : '';
    writeFileSync(process.env.FAKE_CODEX_LOG, current + JSON.stringify(args) + '\\n');
  }
};
if (args[0] === '--version') process.exit(0);
log();
if (process.env.FAKE_CODEX_INSPECTION_FAIL === '1' && args[0] === 'mcp' && (args[1] === 'list' || args[1] === 'get')) {
  console.error('inspection unavailable');
  process.exit(2);
}
if (args[0] === 'mcp' && args[1] === 'list' && args[2] === '--json') {
  if (process.env.FAKE_CODEX_LIST_SCHEMA === 'object') {
    console.log('{}');
    process.exit(0);
  }
  const text = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  const table = '[mcp_servers.6ducklearn]';
  const start = text.indexOf(table);
  if (start === -1) {
    console.log('[]');
    process.exit(0);
  }
  const section = text.slice(start);
  const url = section.match(/^url\\s*=\\s*"([^"]+)"/m)?.[1] ?? '';
  console.log(JSON.stringify([{ name: '6ducklearn', transport: { type: 'streamable_http', url }, auth_status: process.env.FAKE_CODEX_AUTH_STATUS ?? 'not_logged_in' }]));
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'remove') {
  writeFileSync(configPath, '');
  process.exit(0);
}
if (args[0] === 'mcp' && args[1] === 'login') {
  if (process.env.FAKE_CODEX_LOGIN_SIGNAL === '1') process.kill(process.pid, 'SIGTERM');
  process.exit(Number(process.env.FAKE_CODEX_LOGIN_EXIT ?? 0));
}
console.error('unexpected fake Codex command', args.join(' '));
process.exit(3);
`);
  chmodSync(fakeCodex, 0o755);
  return { root, codexHome, logPath };
}

function runSetupWithFake(extraArgs = [], extraEnv = {}) {
  const fake = createFakeCodex();
  const result = spawnSync(process.execPath, [setupScript, 'setup-codex', ...extraArgs], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(fake.root, 'bin')}${path.delimiter}${process.env.PATH}`,
      CODEX_HOME: fake.codexHome,
      FAKE_CODEX_LOG: fake.logPath,
      SIXDUCK_CODEX_NODE_SHIM: path.join(fake.root, 'bin', 'codex'),
      ...extraEnv,
    },
  });
  return {
    ...fake,
    result,
    calls: readFileSync(fake.logPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line)),
  };
}

test('public Codex setup requests only hosted MCP scopes', () => {
  const output = execFileSync(process.execPath, [setupScript, 'setup-codex', '--dry-run'], {
    encoding: 'utf8',
  });

  assert.match(output, /--scopes 'mcp:read,mcp:write'/);
  assert.doesNotMatch(output, /approval:decide|approval:request|control:read|control:write|policy:read|runtime:connect/);
  assert.doesNotMatch(output, /codex mcp add/);
});

test('package bin executes through a symlink', () => {
  const root = mkdtempSync(path.join(tmpdir(), '6ducklearn-bin-'));
  const linkedBin = path.join(root, '6ducklearn-mcp');
  symlinkSync(setupScript, linkedBin);
  const output = execFileSync(process.execPath, [linkedBin, '--help'], { encoding: 'utf8' });
  assert.match(output, /6DuckLearn MCP setup/);
});

test('setup writes config directly and starts only explicitly scoped OAuth', () => {
  const { result, calls, codexHome } = runSetupWithFake();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(JSON.stringify(calls), /"add"/);
  assert.deepEqual(calls.at(-1), ['mcp', 'login', '6ducklearn', '--scopes', 'mcp:read,mcp:write']);
  const config = readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
  assert.match(config, /\[mcp_servers\.6ducklearn\]/);
  assert.match(config, /url = "https:\/\/6ducklearn\.com\/mcp"/);
  assert.match(config, /\[mcp_servers\.6ducklearn\.http_headers\]/);
  assert.match(result.stdout, /Hosted 6DuckLearn MCP is connected in Codex/);
});

test('inspection failure is fail-closed and preserves config', () => {
  const fake = createFakeCodex();
  const configPath = path.join(fake.codexHome, 'config.toml');
  const original = '[mcp_servers.keep]\nurl = "https://example.com/mcp"\n';
  writeFileSync(configPath, original);
  const result = spawnSync(process.execPath, [setupScript, 'setup-codex'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(fake.root, 'bin')}${path.delimiter}${process.env.PATH}`,
      CODEX_HOME: fake.codexHome,
      FAKE_CODEX_LOG: fake.logPath,
      SIXDUCK_CODEX_NODE_SHIM: path.join(fake.root, 'bin', 'codex'),
      FAKE_CODEX_INSPECTION_FAIL: '1',
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No changes were made/);
  assert.equal(readFileSync(configPath, 'utf8'), original);
  const calls = readFileSync(fake.logPath, 'utf8');
  assert.doesNotMatch(calls, /"remove"|"add"|"login"/);
});

test('signal-terminated OAuth is surfaced and never reports connected', () => {
  const { result } = runSetupWithFake([], { FAKE_CODEX_LOGIN_SIGNAL: '1' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /terminated by SIGTERM/);
  assert.doesNotMatch(result.stdout, /is connected in Codex/);
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
  assert.equal(codexOAuthState({ ...server, auth_status: 'o_auth' }), 'ready');
  assert.equal(codexOAuthState({ ...server, auth_status: 'not_logged_in' }), 'not-ready');
  assert.equal(codexOAuthState({ ...server, auth_status: 'changed_schema' }), 'unknown');
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

test('a positively identified mismatch is removed and replaced without mcp add', () => {
  const fake = createFakeCodex();
  writeFileSync(
    path.join(fake.codexHome, 'config.toml'),
    '[mcp_servers.6ducklearn]\nurl = "https://example.com/old"\n',
  );
  const result = spawnSync(process.execPath, [setupScript, 'setup-codex'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: fake.codexHome,
      FAKE_CODEX_LOG: fake.logPath,
      SIXDUCK_CODEX_NODE_SHIM: path.join(fake.root, 'bin', 'codex'),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(fake.logPath, 'utf8');
  assert.match(calls, /\["mcp","remove","6ducklearn"\]/);
  assert.doesNotMatch(calls, /"add"/);
  assert.match(readFileSync(path.join(fake.codexHome, 'config.toml'), 'utf8'), /https:\/\/6ducklearn\.com\/mcp/);
});

test('unfamiliar inspection schema is fail-closed', () => {
  const fake = createFakeCodex();
  const result = spawnSync(process.execPath, [setupScript, 'setup-codex'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: fake.codexHome,
      FAKE_CODEX_LOG: fake.logPath,
      FAKE_CODEX_LIST_SCHEMA: 'object',
      SIXDUCK_CODEX_NODE_SHIM: path.join(fake.root, 'bin', 'codex'),
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No changes were made/);
  assert.doesNotMatch(readFileSync(fake.logPath, 'utf8'), /"remove"|"add"|"login"/);
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
  assert.equal(
    codexSetupResultMessage({ serverMatches: true, oauthReady: true, noLogin: true }),
    'Hosted 6DuckLearn MCP is configured in Codex. OAuth login was skipped because --no-login was set.',
  );
});

test('--no-login never starts OAuth even for an already authenticated entry', () => {
  const fake = createFakeCodex();
  writeFileSync(
    path.join(fake.codexHome, 'config.toml'),
    '[mcp_servers.6ducklearn]\nurl = "https://6ducklearn.com/mcp"\n',
  );
  const result = spawnSync(process.execPath, [setupScript, 'setup-codex', '--no-login'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${path.join(fake.root, 'bin')}${path.delimiter}${process.env.PATH}`,
      CODEX_HOME: fake.codexHome,
      FAKE_CODEX_LOG: fake.logPath,
      FAKE_CODEX_AUTH_STATUS: 'o_auth',
      SIXDUCK_CODEX_NODE_SHIM: path.join(fake.root, 'bin', 'codex'),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /configured in Codex/);
  assert.doesNotMatch(readFileSync(fake.logPath, 'utf8'), /"login"/);
});

test('a matching unauthenticated entry is kept and receives only the scoped login', () => {
  const fake = createFakeCodex();
  const configPath = path.join(fake.codexHome, 'config.toml');
  writeFileSync(
    configPath,
    '[mcp_servers.6ducklearn]\nurl = "https://6ducklearn.com/mcp"\n',
  );
  const result = spawnSync(process.execPath, [setupScript, 'setup-codex'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CODEX_HOME: fake.codexHome,
      FAKE_CODEX_LOG: fake.logPath,
      FAKE_CODEX_AUTH_STATUS: 'not_logged_in',
      SIXDUCK_CODEX_NODE_SHIM: path.join(fake.root, 'bin', 'codex'),
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(fake.logPath, 'utf8');
  assert.doesNotMatch(calls, /"remove"|"add"/);
  assert.match(calls, /\["mcp","login","6ducklearn","--scopes","mcp:read,mcp:write"\]/);
  assert.match(readFileSync(configPath, 'utf8'), /\[mcp_servers\.6ducklearn\.http_headers\]/);
});
