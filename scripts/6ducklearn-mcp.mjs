#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_NAME = '6ducklearn';
const DEFAULT_URL = 'https://6ducklearn.com/mcp';
const DEFAULT_CODEX_OAUTH_SCOPES = [
  'mcp:read',
  'mcp:write',
];
const CODEX_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36';

function usage() {
  console.log(`6DuckLearn MCP setup

Usage:
  6ducklearn-mcp setup-codex [--name <key>] [--url <url>] [--no-login] [--dry-run]
  6ducklearn-mcp --help

Examples:
  npx github:kit18/6ducklearn-mcp setup-codex
  6ducklearn-mcp setup-codex --dry-run
  6ducklearn-mcp setup-codex --name 6ducklearn --url https://6ducklearn.com/mcp

The setup command inspects an existing Codex entry first. It keeps a matching
hosted endpoint, replaces a different entry, and ensures the Codex HTTP
compatibility header without creating duplicate configuration.
`);
}

function shellQuote(value) {
  if (/^[a-zA-Z0-9_./:=@+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandText(command) {
  return command.map(shellQuote).join(' ');
}

function readOption(args, name, fallback) {
  const index = args.indexOf(name);
  if (index === -1) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

function hasFlag(args, name) {
  return args.includes(name);
}

function assertNoUnknownOptions(args) {
  const known = new Set(['--name', '--url', '--no-login', '--dry-run']);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) continue;
    if (!known.has(arg)) throw new Error(`Unknown option: ${arg}`);
    if (arg === '--name' || arg === '--url') index += 1;
  }
}

function spawnCodexSync(args, options) {
  const nodeShim = process.env.SIXDUCK_CODEX_NODE_SHIM;
  return nodeShim
    ? spawnSync(process.execPath, [nodeShim, ...args], options)
    : spawnSync('codex', args, options);
}

function assertCodexAvailable() {
  const result = spawnCodexSync(['--version'], { stdio: 'ignore' });
  if (result.error?.code === 'ENOENT') {
    throw new Error('Codex CLI was not found on PATH. Install or open Codex with CLI support, then rerun this setup command.');
  }
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Codex CLI version check was terminated by ${result.signal}`);
  if (result.status !== 0) {
    throw new Error(`Codex CLI version check failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function runCommand(command) {
  const [bin, ...args] = command;
  const result = bin === 'codex'
    ? spawnCodexSync(args, { stdio: 'inherit' })
    : spawnSync(bin, args, { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(`${commandText(command)} was terminated by ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(`${commandText(command)} failed with exit code ${result.status ?? 'unknown'}`);
  }
}

function isRecognizedCodexServer(server, name) {
  if (!server || typeof server !== 'object' || Array.isArray(server)) return false;
  if (typeof server.name === 'string' && server.name !== name) return false;
  if (
    server.transport
    && typeof server.transport === 'object'
    && !Array.isArray(server.transport)
  ) {
    return server.transport.type === 'streamable_http'
      && typeof server.transport.url === 'string'
      && server.transport.url.length > 0;
  }
  return server.transport === 'streamable_http'
    && typeof server.url === 'string'
    && server.url.length > 0;
}

function parseCodexServerList(rawText, name) {
  const servers = JSON.parse(rawText);
  if (!Array.isArray(servers)) {
    throw new Error('Codex returned an unfamiliar MCP list response');
  }
  const server = servers.find((candidate) => candidate?.name === name);
  if (server && !isRecognizedCodexServer(server, name)) {
    throw new Error('Codex returned an unfamiliar MCP server schema');
  }
  return server
    ? { status: 'found', server }
    : { status: 'missing', server: null };
}

function readCodexServer(name) {
  const listResult = spawnCodexSync(['mcp', 'list', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (!listResult.error && listResult.status === 0) {
    try {
      return parseCodexServerList(listResult.stdout, name);
    } catch {
      // Fall back to `mcp get` for Codex versions without JSON list output.
    }
  }

  const getResult = spawnCodexSync(['mcp', 'get', name, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!getResult.error && getResult.status === 0) {
    try {
      const server = JSON.parse(getResult.stdout);
      if (isRecognizedCodexServer(server, name)) {
        return { status: 'found', server };
      }
    } catch {
      // Fall through to a conservative inspection failure.
    }
  }

  const failureText = `${getResult.stdout ?? ''}\n${getResult.stderr ?? ''}`;
  if (!getResult.error && /not found|does not exist|no MCP server/i.test(failureText)) {
    return { status: 'missing', server: null };
  }
  return {
    status: 'failed',
    server: null,
    reason: getResult.error?.message || failureText.trim() || 'Codex MCP inspection failed',
  };
}

function codexServerMatches(server, url) {
  return server?.transport?.type === 'streamable_http'
    && server.transport.url === url;
}

function codexOAuthIsReady(server) {
  return server?.auth_status === 'o_auth' || server?.auth_status === 'oauth';
}

function codexOAuthState(server) {
  if (codexOAuthIsReady(server)) return 'ready';
  if (server?.auth_status === 'not_logged_in') return 'not-ready';
  return 'unknown';
}

function shouldRunCodexOAuthLogin(server, url, noLogin) {
  return !noLogin && !(codexServerMatches(server, url) && codexOAuthIsReady(server));
}

function codexSetupResultMessage({ serverMatches, oauthReady, noLogin }) {
  if (noLogin) {
    return 'Hosted 6DuckLearn MCP is configured in Codex. OAuth login was skipped because --no-login was set.';
  }
  if (serverMatches && oauthReady) {
    return 'Hosted 6DuckLearn MCP is already connected in Codex. No changes were needed.';
  }
  return 'Hosted 6DuckLearn MCP is connected in Codex. Open a new Codex chat to load the approved tools.';
}

function codexConfigPath() {
  const codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex');
  return path.join(codexHome, 'config.toml');
}

function assertSafeServerName(name) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error('--name must contain only letters, numbers, underscores, or hyphens');
  }
}

function assertSupportedServerUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('--url must be a valid HTTP or HTTPS URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('--url must use HTTP or HTTPS');
  }
}

function serverTableName(name) {
  return `[mcp_servers.${name}]`;
}

function headersTableName(name) {
  return `[mcp_servers.${name}.http_headers]`;
}

function userAgentLine() {
  return `User-Agent = ${JSON.stringify(CODEX_USER_AGENT)}`;
}

function hostedServerConfigBlock(name, url) {
  return `${serverTableName(name)}\nurl = ${JSON.stringify(url)}\n\n${headersTableName(name)}\n${userAgentLine()}\n`;
}

function writeCodexConfigAtomically(configPath, text) {
  const directory = path.dirname(configPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const mode = existsSync(configPath) ? statSync(configPath).mode & 0o777 : 0o600;
  const temporaryPath = `${configPath}.6ducklearn-${process.pid}.tmp`;
  writeFileSync(temporaryPath, text, { mode });
  renameSync(temporaryPath, configPath);
}

function configureCodexHostedServer(name, url) {
  const configPath = codexConfigPath();
  const current = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';
  if (current.split(/\r?\n/).some((line) => line.trim() === serverTableName(name))) {
    throw new Error(`Codex config still contains ${serverTableName(name)}; no replacement was written`);
  }
  const separator = current.trim().length > 0 ? '\n\n' : '';
  writeCodexConfigAtomically(
    configPath,
    `${current.trimEnd()}${separator}${hostedServerConfigBlock(name, url)}`,
  );
}

function withUserAgentHeader(text, name) {
  const serverTable = serverTableName(name);
  const headersTable = headersTableName(name);
  if (!text.includes(serverTable)) {
    throw new Error(`Codex config does not contain ${serverTable}`);
  }

  if (!text.includes(headersTable)) {
    return `${text.trimEnd()}\n\n${headersTable}\n${userAgentLine()}\n`;
  }

  const start = text.indexOf(headersTable);
  const nextTable = text.indexOf('\n[', start + headersTable.length);
  const end = nextTable === -1 ? text.length : nextTable;
  const before = text.slice(0, start);
  const section = text.slice(start, end);
  const after = text.slice(end);
  const updatedSection = section.includes('User-Agent =')
    ? section.replace(/^User-Agent\s*=.*$/m, userAgentLine())
    : `${section.trimEnd()}\n${userAgentLine()}\n`;
  return `${before}${updatedSection}${after}`;
}

function ensureCodexUserAgentHeader(name) {
  const configPath = codexConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(`Codex config was not found at ${configPath}`);
  }

  const current = readFileSync(configPath, 'utf8');
  const next = withUserAgentHeader(current, name);
  if (next !== current) writeCodexConfigAtomically(configPath, next);
}

function setupCodex(args) {
  assertNoUnknownOptions(args);

  const name = readOption(args, '--name', DEFAULT_NAME);
  const url = readOption(args, '--url', DEFAULT_URL);
  assertSafeServerName(name);
  assertSupportedServerUrl(url);
  const noLogin = hasFlag(args, '--no-login');
  const dryRun = hasFlag(args, '--dry-run');
  const removeCommand = ['codex', 'mcp', 'remove', name];
  const loginCommand = [
    'codex',
    'mcp',
    'login',
    name,
    '--scopes',
    DEFAULT_CODEX_OAUTH_SCOPES.join(','),
  ];

  if (dryRun) {
    console.log(`# Inspect the existing entry first:
${commandText(['codex', 'mcp', 'get', name, '--json'])}

# Keep an existing streamable HTTP entry when its URL already matches.
# The helper writes this config directly so "mcp add" cannot start an unscoped OAuth request:
${hostedServerConfigBlock(name, url)}
${noLogin ? '# OAuth login skipped because --no-login was set.' : `# Run only the explicitly scoped OAuth login:\n${commandText(loginCommand)}`}`);
    return;
  }

  assertCodexAvailable();

  const inspection = readCodexServer(name);
  if (inspection.status === 'failed') {
    throw new Error(`Unable to inspect the existing Codex MCP entry. No changes were made. ${inspection.reason}`);
  }
  const existingServer = inspection.server;
  const serverMatches = codexServerMatches(existingServer, url);
  const oauthState = serverMatches ? codexOAuthState(existingServer) : 'not-ready';
  if (serverMatches && oauthState === 'unknown' && !noLogin) {
    throw new Error('Codex did not report a recognized OAuth status. No OAuth login was started; update Codex and rerun setup.');
  }
  const oauthReady = serverMatches && oauthState === 'ready';
  const shouldLogin = shouldRunCodexOAuthLogin(existingServer, url, noLogin);
  if (!serverMatches) {
    if (inspection.status === 'found') {
      runCommand(removeCommand);
    }
    configureCodexHostedServer(name, url);
    const configured = readCodexServer(name);
    if (configured.status !== 'found' || !codexServerMatches(configured.server, url)) {
      throw new Error('Codex did not recognize the hosted MCP configuration; OAuth was not started');
    }
  }
  ensureCodexUserAgentHeader(name);

  if (shouldLogin) runCommand(loginCommand);

  console.log(codexSetupResultMessage({ serverMatches, oauthReady, noLogin }));
}

function main() {
  const [command, ...args] = process.argv.slice(2);

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    usage();
    return;
  }

  if (command === 'setup-codex') {
    setupCodex(args);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export {
  codexOAuthIsReady,
  codexOAuthState,
  codexSetupResultMessage,
  codexServerMatches,
  hostedServerConfigBlock,
  isDirectExecution,
  isRecognizedCodexServer,
  readCodexServer,
  shouldRunCodexOAuthLogin,
  withUserAgentHeader,
};
