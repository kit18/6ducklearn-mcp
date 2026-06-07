#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const DEFAULT_NAME = '6ducklearn';
const DEFAULT_URL = 'https://6ducklearn.com/mcp';

function usage() {
  console.log(`6DuckLearn MCP setup

Usage:
  6ducklearn-mcp setup-codex [--name <key>] [--url <url>] [--no-login] [--dry-run]
  6ducklearn-mcp --help

Examples:
  npx github:kit18/6ducklearn-mcp setup-codex
  6ducklearn-mcp setup-codex --dry-run
  6ducklearn-mcp setup-codex --name 6ducklearn --url https://6ducklearn.com/mcp
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

function manualCommands(commands) {
  return commands.map(commandText).join('\n');
}

function setupCodex(args) {
  assertNoUnknownOptions(args);

  const name = readOption(args, '--name', DEFAULT_NAME);
  const url = readOption(args, '--url', DEFAULT_URL);
  const noLogin = hasFlag(args, '--no-login');
  const dryRun = hasFlag(args, '--dry-run');
  const commands = [
    ['codex', 'mcp', 'add', name, '--url', url],
  ];

  if (!noLogin) {
    commands.push(['codex', 'mcp', 'login', name]);
  }

  if (dryRun) {
    console.log(manualCommands(commands));
    return;
  }

  if (!codexIsAvailable()) {
    console.error('Codex CLI was not found on PATH.');
    console.error('Install or open Codex with CLI support, then run:');
    console.error(manualCommands(commands));
    process.exit(127);
  }

  for (const command of commands) {
    runCommand(command);
  }

  console.log(`Configured hosted 6DuckLearn MCP as ${name}.`);
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

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
