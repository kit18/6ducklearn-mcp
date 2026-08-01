#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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

function codexIsAvailable() {
  const result = spawnSync('codex', ['--version'], { stdio: 'ignore' });
  return !result.error || result.error.code !== 'ENOENT';
}

function runCommand(command) {
  const [bin, ...args] = command;
  const result = spawnSync(bin, args, { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (typeof result.status === 'number' && result.status !== 0) {
    process.exit(result.status);
  }
}

function commandSucceeds(command) {
  const [bin, ...args] = command;
  const result = spawnSync(bin, args, { stdio: 'ignore' });
  return !result.error && result.status === 0;
}

function readCodexServer(name) {
  const listResult = spawnSync('codex', ['mcp', 'list', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (!listResult.error && listResult.status === 0) {
    try {
      const servers = JSON.parse(listResult.stdout);
      if (Array.isArray(servers)) {
        return servers.find((server) => server?.name === name) ?? null;
      }
    } catch {
      // Fall back to `mcp get` for Codex versions without JSON list output.
    }
  }

  const getResult = spawnSync('codex', ['mcp', 'get', name, '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (getResult.error || getResult.status !== 0) return null;
  try {
    return JSON.parse(getResult.stdout);
  } catch {
    return null;
  }
}

function codexServerMatches(server, url) {
  return server?.transport?.type === 'streamable_http'
    && server.transport.url === url;
}

function codexOAuthIsReady(server) {
  return server?.auth_status === 'o_auth' || server?.auth_status === 'oauth';
}

function shouldRunCodexOAuthLogin(server, url, noLogin) {
  return !noLogin && !(codexServerMatches(server, url) && codexOAuthIsReady(server));
}

function codexSetupResultMessage({ serverMatches, oauthReady, noLogin }) {
  if (serverMatches && oauthReady) {
    return 'Hosted 6DuckLearn MCP is already connected in Codex. No changes were needed.';
  }
  if (noLogin) {
    return 'Hosted 6DuckLearn MCP is configured in Codex. OAuth login was skipped because --no-login was set.';
  }
  return 'Hosted 6DuckLearn MCP is connected in Codex. Open a new Codex chat to load the approved tools.';
}

function manualCommands(commands) {
  return commands.map(commandText).join('\n');
}

function codexConfigPath() {
  const codexHome = process.env.CODEX_HOME || path.join(homedir(), '.codex');
  return path.join(codexHome, 'config.toml');
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
  if (next !== current) writeFileSync(configPath, next);
}

function setupCodex(args) {
  assertNoUnknownOptions(args);

  const name = readOption(args, '--name', DEFAULT_NAME);
  const url = readOption(args, '--url', DEFAULT_URL);
  const noLogin = hasFlag(args, '--no-login');
  const dryRun = hasFlag(args, '--dry-run');
  const removeCommand = ['codex', 'mcp', 'remove', name];
  const commands = [
    ['codex', 'mcp', 'add', name, '--url', url],
  ];

  if (!noLogin) {
    commands.push([
      'codex',
      'mcp',
      'login',
      name,
      '--scopes',
      DEFAULT_CODEX_OAUTH_SCOPES.join(','),
    ]);
  }

  if (dryRun) {
    console.log(`# Inspect the existing entry first:
${commandText(['codex', 'mcp', 'get', name, '--json'])}

# Keep an existing streamable HTTP entry when its URL already matches.
# Only replace a missing or different entry with:
${commandText(removeCommand)} # only when a different entry exists
${commandText(commands[0])}
${noLogin ? '' : `# Run OAuth only when Codex does not report auth_status=o_auth:\n${commandText(commands[1])}`}

# Ensure Codex sends a browser-compatible user agent to hosted OAuth/MCP endpoints:
# ${headersTableName(name)}
# ${userAgentLine()}`);
    return;
  }

  if (!codexIsAvailable()) {
    console.error('Codex CLI was not found on PATH.');
    console.error('Install or open Codex with CLI support, then run:');
    console.error(manualCommands(commands));
    process.exit(127);
  }

  const existingServer = readCodexServer(name);
  const serverMatches = codexServerMatches(existingServer, url);
  const oauthReady = serverMatches && codexOAuthIsReady(existingServer);
  const shouldLogin = shouldRunCodexOAuthLogin(existingServer, url, noLogin);
  if (!serverMatches) {
    if (existingServer || commandSucceeds(['codex', 'mcp', 'get', name])) {
      runCommand(removeCommand);
    }
    runCommand(commands[0]);
  }
  ensureCodexUserAgentHeader(name);

  if (shouldLogin) runCommand(commands[1]);

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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

export {
  codexOAuthIsReady,
  codexSetupResultMessage,
  codexServerMatches,
  shouldRunCodexOAuthLogin,
  withUserAgentHeader,
};
