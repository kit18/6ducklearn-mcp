import { readFile } from 'node:fs/promises';

const MANIFEST_PATH = new URL('../server.json', import.meta.url);
const PACKAGE_PATH = new URL('../package.json', import.meta.url);
const EXPECTED_SCHEMA = 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json';
const EXPECTED_NAME = 'com.6ducklearn/mcp';
const EXPECTED_REMOTE_URL = 'https://6ducklearn.com/mcp';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertUrl(value, message) {
  assert(typeof value === 'string' && value.startsWith('https://'), message);
  new URL(value);
}

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
const packageJson = JSON.parse(await readFile(PACKAGE_PATH, 'utf8'));

assert(manifest.$schema === EXPECTED_SCHEMA, `server.json must use ${EXPECTED_SCHEMA}`);
assert(manifest.name === EXPECTED_NAME, `server.json name must be ${EXPECTED_NAME}`);
assert(packageJson.mcpName === manifest.name, 'package.json mcpName must match server.json name');
assert(manifest.version === packageJson.version, 'server.json version must match package.json version');
assert(typeof manifest.title === 'string' && manifest.title.length > 0, 'server.json title is required');
assert(
  typeof manifest.description === 'string' &&
    manifest.description.length > 0 &&
    manifest.description.length <= 100,
  'server.json description must be 1-100 characters'
);
assertUrl(manifest.websiteUrl, 'server.json websiteUrl must be an HTTPS URL');
assert(manifest.repository?.source === 'github', 'server.json repository.source must be github');
assertUrl(manifest.repository?.url, 'server.json repository.url must be an HTTPS URL');
assert(typeof manifest.repository?.id === 'string' && manifest.repository.id.length > 0, 'server.json repository.id is required');
assert(Array.isArray(manifest.remotes) && manifest.remotes.length === 1, 'server.json must define exactly one hosted remote');
assert(manifest.remotes[0].type === 'streamable-http', 'hosted remote must use streamable-http transport');
assert(manifest.remotes[0].url === EXPECTED_REMOTE_URL, `hosted remote must be ${EXPECTED_REMOTE_URL}`);
assert(!manifest.packages, 'Do not add packages until a real stdio MCP package is published');

console.log('Registry manifest validation passed.');
