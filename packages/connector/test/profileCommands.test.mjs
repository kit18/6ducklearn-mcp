import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  'SIXDUCK_TOKEN_ID',
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

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function startControlPlaneTestServer(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to determine test server address');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
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

test('profile switch rejects active agent credentials that do not match source profile metadata', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), '6ducklearn-profile-command-'));
  const targetDir = join(tempDir, 'hermes-target');
  const restoreEnv = withConnectorEnv({
    SIXDUCK_AGENT_ID: 'agent-other',
    SIXDUCK_DEVICE_ID: 'device-1',
    SIXDUCK_OAUTH_ACCESS_TOKEN: 'oauth-access-token',
    SIXDUCK_RUNTIME_TYPE: 'hermes',
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
        'switch',
        '--profile',
        'research-analyst',
        '--from-runtime',
        'codex',
        '--to-runtime',
        'hermes',
        '--source-base-dir',
        tempDir,
        '--target-base-dir',
        targetDir,
      ]),
      /before switching runtime/,
    );
  } finally {
    restoreEnv();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('profile switch rejects one shared custom base directory', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), '6ducklearn-profile-command-'));

  try {
    await assert.rejects(
      () => runProfileCommand([
        'profile',
        'switch',
        '--profile',
        'research-analyst',
        '--from-runtime',
        'codex',
        '--to-runtime',
        'hermes',
        '--base-dir',
        tempDir,
      ]),
      /source and target runtime profiles must stay independent/,
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('profile switch prepares handoff, syncs target projection, and keeps local-only files isolated', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), '6ducklearn-profile-command-'));
  const sourceBaseDir = join(tempDir, 'codex-source');
  const targetBaseDir = join(tempDir, 'hermes-target');
  const requests = [];
  const restoreEnv = withConnectorEnv({
    SIXDUCK_AGENT_ID: 'agent-local',
    SIXDUCK_DEVICE_ID: 'device-1',
    SIXDUCK_OAUTH_ACCESS_TOKEN: 'oauth-access-token',
    SIXDUCK_RUNTIME_TYPE: 'hermes',
    SIXDUCK_TOKEN_ID: 'token-target',
  });

  const server = await startControlPlaneTestServer(async (req, res) => {
    const body = await readJsonBody(req);
    requests.push({ method: req.method, url: req.url, body });

    if (req.url === '/functions/v1/console-register-connection') {
      assert.equal(body.runtime_type, 'hermes');
      sendJson(res, 200, {
        connection: {
          id: 'connection-target',
          runtime_type: 'hermes',
          status: 'online',
        },
      });
      return;
    }

    if (req.url === '/functions/v1/console-heartbeat') {
      assert.equal(body.connection_id, 'connection-target');
      sendJson(res, 200, {
        ok: true,
        connection_id: 'connection-target',
        status: 'online',
      });
      return;
    }

    if (req.url === '/functions/v1/agent-control-plane/handoff') {
      assert.equal(body.agent_id, 'agent-local');
      assert.equal(body.source_projection_id, 'projection-source');
      assert.equal(body.source_profile_hash, 'source-hash');
      assert.equal(body.source_runtime_type, 'codex');
      assert.equal(body.target_connection_id, 'connection-target');
      assert.equal(body.target_local_profile_key, 'hermes:research-analyst');
      assert.equal(body.target_runtime_type, 'hermes');
      sendJson(res, 200, {
        status: 'handoff_ready',
        handoff_contract: {
          agent_id: 'agent-local',
          handoff_event_id: 'event-handoff',
          source_local_profile_key: 'codex:research-analyst',
          source_profile_hash: 'source-hash',
          source_projection_id: 'projection-source',
          source_runtime_type: 'codex',
          target_connection_id: 'connection-target',
          target_local_profile_key: 'hermes:research-analyst',
          target_runtime_type: 'hermes',
          transfer: ['intent', 'memory_projection', 'approval_state', 'experience_packet_context'],
          transfer_policy: 'canonical_profile_context_only',
        },
      });
      return;
    }

    if (req.url === '/functions/v1/agent-control-plane/agents/agent-local/projections') {
      assert.equal(body.runtime_type, 'hermes');
      assert.equal(body.local_profile_key, 'hermes:research-analyst');
      assert.equal(body.connection_id, 'connection-target');
      assert.match(body.local_path_hint, /hermes-target\/research-analyst$/);
      sendJson(res, 200, {
        projection: {
          id: 'projection-target',
          agent_id: 'agent-local',
          connection_id: 'connection-target',
          runtime_type: 'hermes',
          local_profile_key: 'hermes:research-analyst',
          status: 'active',
        },
      });
      return;
    }

    if (req.url === '/functions/v1/agent-control-plane/projections/projection-target/sync/pull') {
      sendJson(res, 200, {
        projection: {
          id: 'projection-target',
          agent_id: 'agent-local',
          connection_id: 'connection-target',
          runtime_type: 'hermes',
          local_profile_key: 'hermes:research-analyst',
          status: 'active',
        },
        sync: {
          id: 'sync-target',
          status: 'pending',
          result_profile_hash: 'target-hash',
        },
        runtime_projection: {
          agent_id: 'agent-local',
          runtime_type: 'hermes',
          local_profile_key: 'hermes:research-analyst',
          system_prompt: 'You are the same research analyst in Hermes.',
          projection_metadata: {
            approval_boundaries: ['pkm_write:require_approval'],
          },
          skill_packs: [],
        },
        skipped_locks: [],
        invariants: {
          memory_policy: 'review_proposals_only',
        },
      });
      return;
    }

    if (req.url === '/functions/v1/agent-control-plane/projections/projection-target/sync/sync-target/ack') {
      assert.equal(body.profile_hash, 'target-hash');
      sendJson(res, 200, {
        projection: {
          id: 'projection-target',
          agent_id: 'agent-local',
          connection_id: 'connection-target',
          runtime_type: 'hermes',
          local_profile_key: 'hermes:research-analyst',
          status: 'active',
        },
        sync: {
          id: 'sync-target',
          status: 'succeeded',
        },
      });
      return;
    }

    sendJson(res, 404, { error: { message: `Unexpected route ${req.url}` } });
  });

  process.env.SIXDUCK_SUPABASE_URL = server.baseUrl;

  try {
    applyLocalProfileProjection({
      profileName: 'Research Analyst',
      runtimeType: 'codex',
      baseDir: sourceBaseDir,
      pullResult: {
        projection: {
          id: 'projection-source',
          agent_id: 'agent-local',
          connection_id: 'connection-source',
          runtime_type: 'codex',
          local_profile_key: 'codex:research-analyst',
          status: 'active',
        },
        sync: {
          id: 'sync-source',
          status: 'pending',
          result_profile_hash: 'source-hash',
        },
        runtime_projection: {
          agent_id: 'agent-local',
          runtime_type: 'codex',
          local_profile_key: 'codex:research-analyst',
          system_prompt: 'You are a research analyst in Codex.',
          skill_packs: [],
        },
        skipped_locks: [],
      },
    });
    writeFileSync(
      join(sourceBaseDir, 'research-analyst', 'memory', 'local-only.md'),
      'do not copy this local note\n',
      'utf8',
    );

    await runProfileCommand([
      'profile',
      'switch',
      '--profile',
      'research-analyst',
      '--from-runtime',
      'codex',
      '--to-runtime',
      'hermes',
      '--source-base-dir',
      sourceBaseDir,
      '--target-base-dir',
      targetBaseDir,
      '--handoff-note',
      'Continue in Hermes.',
    ]);

    const metadata = JSON.parse(
      readFileSync(join(targetBaseDir, 'research-analyst', '.6ducklearn', 'profile-sync.json'), 'utf8'),
    );
    assert.equal(metadata.agent_id, 'agent-local');
    assert.equal(metadata.projection_id, 'projection-target');
    assert.equal(metadata.profile_hash, 'target-hash');
    assert.equal(metadata.last_handoff.handoff_event_id, 'event-handoff');
    assert.equal(metadata.last_handoff.source_projection_id, 'projection-source');
    assert.equal(metadata.last_handoff.source_runtime_type, 'codex');
    assert.equal(metadata.last_handoff.target_runtime_type, 'hermes');
    assert.equal(metadata.last_handoff.transfer_policy, 'canonical_profile_context_only');
    assert.equal(
      existsSync(join(targetBaseDir, 'research-analyst', 'memory', 'local-only.md')),
      false,
    );
    assert.deepEqual(
      requests.map((request) => request.url),
      [
        '/functions/v1/console-register-connection',
        '/functions/v1/console-heartbeat',
        '/functions/v1/agent-control-plane/handoff',
        '/functions/v1/agent-control-plane/agents/agent-local/projections',
        '/functions/v1/agent-control-plane/projections/projection-target/sync/pull',
        '/functions/v1/agent-control-plane/projections/projection-target/sync/sync-target/ack',
      ],
    );
  } finally {
    await server.close();
    restoreEnv();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
