import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const ignoredDirs = new Set(['.git', 'node_modules', 'dist']);
const ignoredFiles = new Set(['package-lock.json']);

const serviceRoleName = 'SUPABASE_' + 'SERVICE_' + 'ROLE_' + 'KEY';
const serviceRoleSuffix = 'SERVICE_' + 'ROLE_KEY';
const privateProjectRef = 'fqhjwdrnllsobj' + 'xiygky';
const localDeveloperPath = String.raw`/Users/` + 'kit18';
const checks = [
  { name: 'service role key reference', pattern: new RegExp(`${serviceRoleName}|${serviceRoleSuffix}`, 'i') },
  { name: 'private Supabase project ref', pattern: new RegExp(privateProjectRef) },
  { name: 'local developer path', pattern: new RegExp(localDeveloperPath.replaceAll('/', '\\/')) },
  { name: 'agent-mcp-tools token hash URL', pattern: /agent-mcp-tools\/[a-f0-9]{32,}/i },
];

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirs.has(entry.name)) yield* walk(join(dir, entry.name));
      continue;
    }
    if (entry.isFile() && !ignoredFiles.has(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

const findings = [];
for await (const file of walk(root)) {
  const text = await readFile(file, 'utf8').catch(() => '');
  for (const check of checks) {
    if (check.pattern.test(text)) {
      findings.push(`${relative(root, file)}: ${check.name}`);
    }
  }
}

if (findings.length > 0) {
  console.error('Public-release secret scan failed:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log('Public-release secret scan passed.');
