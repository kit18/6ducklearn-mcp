import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyLocalProfileProjection } from '../dist/localProfile.js';
import { runProfileCommand } from '../dist/profileCommands.js';

const ENV_KEYS = [
  'SIXDUCK_AGENT_ID',
  'SIXDUCK_DEVICE_ID',
  'SIXDUCK_OAUTH_ACCESS_TOKEN',
  'SIXDUCK_RUNTIME_TYPE',
  'SIXDUCK_SUPABASE_URL',
];

function withConnectorEnv(values) {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    process.env[key] = value;
  }
  return () => {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of previous.entries()) {
      if (typeof value === 'string') process.env[key] = value;
    }
  };
}

test('profile propose rejects active agent credentials that do not match local profile metadata', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), '6ducklearn-profile-command-'));
  const restoreEnv = withConnectorEnv({
    SIXDUCK_AGENT_ID: 'agent-other',
    SIXDUCK_DEVICE_ID: 'device-1',
    SIXDUCK_OAUTH_ACCESS_TOKEN: 'oauth-access-token',
    SIXDUCK_RUNTIME_TYPE: 'codex',
    SIXDUCK_SUPABASE_URL: 'https://example.supabase.co/functions/v1',
  });

  try {
    applyLocalProfileProjection({
      profileName: 'Research Analyst',
      runtimeType: 'codex',
      baseDir: tempDir,
      pullResult: {
        projection: {
          id: 'projection-1',
          agent_id: 'agent-local',
          connection_id: 'connection-1',
          runtime_type: 'codex',
          local_profile_key: 'codex:research-analyst',
          status: 'active',
        },
        sync: {
          id: 'sync-1',
          status: 'pending',
          result_profile_hash: 'hash-1',
        },
        runtime_projection: {
          agent_id: 'agent-local',
          runtime_type: 'codex',
          local_profile_key: 'codex:research-analyst',
          system_prompt: 'You are a research analyst.',
          skill_packs: [],
        },
        skipped_locks: [],
      },
    });

    await assert.rejects(
      () => runProfileCommand([
        'profile',
        'propose',
        '--profile',
        'research-analyst',
        '--base-dir',
        tempDir,
        '--memory',
        'Remember to separate facts from interpretation.',
      ]),
      /metadata belongs to Agent ID agent-local/,
    );
  } finally {
    restoreEnv();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
