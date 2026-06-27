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

async function captureConsoleLog(fn) {
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => {
    lines.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = originalLog;
  }
  return lines.join('\n');
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

test('profile branches lists redacted memory branches without mutating local metadata', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), '6ducklearn-profile-command-'));
  const requests = [];
  const restoreEnv = withConnectorEnv({
    SIXDUCK_AGENT_ID: 'agent-local',
    SIXDUCK_DEVICE_ID: 'device-1',
    SIXDUCK_OAUTH_ACCESS_TOKEN: 'oauth-access-token',
    SIXDUCK_RUNTIME_TYPE: 'codex',
    SIXDUCK_TOKEN_ID: 'token-branch-list',
  });

  const server = await startControlPlaneTestServer(async (req, res) => {
    const body = await readJsonBody(req);
    requests.push({ method: req.method, url: req.url, body });

    if (req.url === '/functions/v1/agent-control-plane/agents/agent-local/memory-branches?projection_id=projection-branch') {
      assert.equal(req.method, 'GET');
      sendJson(res, 200, {
        agent_id: 'agent-local',
        selected_memory_branch_id: 'memory-target',
        memory_branches: [
          {
            id: 'memory-target',
            agent_id: 'agent-local',
            name: 'Asia thesis',
            status: 'active',
            selected: true,
            allow_evolve: false,
            source_memory_branch_id: 'memory-source',
            source_kind: 'fork',
            updated_at: '2026-06-28T00:00:00Z',
            content: 'SECRET memory content',
            source_profile_hash: 'SECRET_HASH',
            fork_note: 'SECRET fork note',
            token_id: 'SECRET_TOKEN',
            local_path_hint: '/Users/alice/private',
          },
          {
            id: 'memory-source',
            agent_id: 'agent-local',
            name: 'Main',
            status: 'active',
            selected: false,
            allow_evolve: true,
            updated_at: '2026-06-27T00:00:00Z',
          },
        ],
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
      baseDir: tempDir,
      pullResult: {
        projection: {
          id: 'projection-branch',
          agent_id: 'agent-local',
          connection_id: 'connection-1',
          runtime_type: 'codex',
          local_profile_key: 'codex:research-analyst',
          status: 'active',
        },
        sync: {
          id: 'sync-branch',
          status: 'pending',
          result_profile_hash: 'branch-hash',
        },
        runtime_projection: {
          agent_id: 'agent-local',
          runtime_type: 'codex',
          local_profile_key: 'codex:research-analyst',
          system_prompt: 'You are a research analyst.',
          projection_metadata: {
            agent_profile_id: 'agent-local',
            role_archetype: 'researcher',
            strategy_pack_key: null,
            skill_pack_keys: [],
            memory_branch_id: 'memory-target',
            memory_profile_ids: ['memory-target'],
            runtime_type: 'codex',
          },
          memory_branch: {
            id: 'memory-target',
            name: 'Asia thesis',
            source_memory_branch_id: 'memory-source',
            source_kind: 'fork',
          },
          skill_packs: [],
        },
        skipped_locks: [],
      },
    });
    const metadataPath = join(tempDir, 'research-analyst', '.6ducklearn', 'profile-sync.json');
    const beforeMetadata = readFileSync(metadataPath, 'utf8');

    const output = await captureConsoleLog(() =>
      runProfileCommand([
        'profile',
        'branches',
        '--profile',
        'research-analyst',
        '--runtime',
        'codex',
        '--base-dir',
        tempDir,
      ])
    );
    const afterMetadata = readFileSync(metadataPath, 'utf8');

    assert.equal(beforeMetadata, afterMetadata);
    assert.match(output, /\* memory-target \| Asia thesis \| active \| evolve:off \| source:fork:memory-source/);
    assert.match(output, /  memory-source \| Main \| active \| evolve:on/);
    assert.equal(output.includes('SECRET'), false);
    assert.equal(output.includes('/Users/alice/private'), false);
    assert.deepEqual(
      requests.map((request) => `${request.method} ${request.url}`),
      ['GET /functions/v1/agent-control-plane/agents/agent-local/memory-branches?projection_id=projection-branch'],
    );
  } finally {
    await server.close();
    restoreEnv();
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('profile branch forks memory, binds the selected branch, and records local lineage', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), '6ducklearn-profile-command-'));
  const requests = [];
  const restoreEnv = withConnectorEnv({
    SIXDUCK_AGENT_ID: 'agent-local',
    SIXDUCK_DEVICE_ID: 'device-1',
    SIXDUCK_OAUTH_ACCESS_TOKEN: 'oauth-access-token',
    SIXDUCK_RUNTIME_TYPE: 'codex',
    SIXDUCK_TOKEN_ID: 'token-branch',
  });

  const server = await startControlPlaneTestServer(async (req, res) => {
    const body = await readJsonBody(req);
    requests.push({ method: req.method, url: req.url, body });

    if (req.url === '/functions/v1/console-register-connection') {
      assert.equal(body.runtime_type, 'codex');
      sendJson(res, 200, {
        connection: {
          id: 'connection-branch',
          runtime_type: 'codex',
          status: 'online',
        },
      });
      return;
    }

    if (req.url === '/functions/v1/console-heartbeat') {
      assert.equal(body.connection_id, 'connection-branch');
      sendJson(res, 200, {
        ok: true,
        connection_id: 'connection-branch',
        status: 'online',
      });
      return;
    }

    if (req.url === '/functions/v1/agent-control-plane/agents/agent-local/memory-branches/memory-source/fork') {
      assert.equal(body.name, 'Asia thesis');
      assert.equal(body.fork_note, 'Explore this direction independently.');
      sendJson(res, 201, {
        status: 'memory_branch_forked',
        memory_branch: {
          id: 'memory-target',
          agent_id: 'agent-local',
          name: 'Asia thesis',
          content_length: 42,
          allow_evolve: true,
          source_memory_branch_id: 'memory-source',
          source_kind: 'fork',
        },
        profile_event: {
          id: 'event-branch',
          event_type: 'memory_branch.forked',
        },
      });
      return;
    }

    if (req.url === '/functions/v1/agent-control-plane/agents/agent-local/projections') {
      assert.equal(body.runtime_type, 'codex');
      assert.equal(body.local_profile_key, 'codex:research-analyst');
      assert.equal(body.connection_id, 'connection-branch');
      assert.equal(body.memory_branch_id, 'memory-target');
      assert.equal(body.sync_policy.memory_branch_id, 'memory-target');
      assert.equal(body.sync_policy.source_memory_branch_id, 'memory-source');
      sendJson(res, 200, {
        projection: {
          id: 'projection-branch',
          agent_id: 'agent-local',
          connection_id: 'connection-branch',
          runtime_type: 'codex',
          local_profile_key: 'codex:research-analyst',
          status: 'active',
        },
      });
      return;
    }

    if (req.url === '/functions/v1/agent-control-plane/projections/projection-branch/sync/pull') {
      sendJson(res, 200, {
        projection: {
          id: 'projection-branch',
          agent_id: 'agent-local',
          connection_id: 'connection-branch',
          runtime_type: 'codex',
          local_profile_key: 'codex:research-analyst',
          status: 'active',
        },
        sync: {
          id: 'sync-branch',
          status: 'pending',
          result_profile_hash: 'branch-hash',
        },
        runtime_projection: {
          agent_id: 'agent-local',
          runtime_type: 'codex',
          local_profile_key: 'codex:research-analyst',
          system_prompt: 'You are a branched research analyst.',
          projection_metadata: {
            agent_profile_id: 'agent-local',
            role_archetype: 'researcher',
            strategy_pack_key: null,
            skill_pack_keys: [],
            memory_branch_id: 'memory-target',
            memory_profile_ids: ['memory-target'],
            runtime_type: 'codex',
          },
          memory_branch: {
            id: 'memory-target',
            name: 'Asia thesis',
            source_memory_branch_id: 'memory-source',
            source_kind: 'fork',
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

    if (req.url === '/functions/v1/agent-control-plane/projections/projection-branch/sync/sync-branch/ack') {
      assert.equal(body.profile_hash, 'branch-hash');
      sendJson(res, 200, {
        projection: {
          id: 'projection-branch',
          agent_id: 'agent-local',
          connection_id: 'connection-branch',
          runtime_type: 'codex',
          local_profile_key: 'codex:research-analyst',
          status: 'active',
        },
        sync: {
          id: 'sync-branch',
          status: 'succeeded',
        },
      });
      return;
    }

    sendJson(res, 404, { error: { message: `Unexpected route ${req.url}` } });
  });

  process.env.SIXDUCK_SUPABASE_URL = server.baseUrl;

  try {
    await runProfileCommand([
      'profile',
      'branch',
      '--profile',
      'research-analyst',
      '--runtime',
      'codex',
      '--base-dir',
      tempDir,
      '--source-memory-branch',
      'memory-source',
      '--branch-name',
      'Asia thesis',
      '--fork-note',
      'Explore this direction independently.',
    ]);

    const metadata = JSON.parse(
      readFileSync(join(tempDir, 'research-analyst', '.6ducklearn', 'profile-sync.json'), 'utf8'),
    );
    assert.equal(metadata.agent_id, 'agent-local');
    assert.equal(metadata.projection_id, 'projection-branch');
    assert.equal(metadata.memory_branch_id, 'memory-target');
    assert.equal(metadata.last_memory_branch_fork.fork_event_id, 'event-branch');
    assert.equal(metadata.last_memory_branch_fork.source_memory_branch_id, 'memory-source');
    assert.equal(metadata.last_memory_branch_fork.target_memory_branch_id, 'memory-target');
    assert.deepEqual(
      requests.map((request) => request.url),
      [
        '/functions/v1/console-register-connection',
        '/functions/v1/console-heartbeat',
        '/functions/v1/agent-control-plane/agents/agent-local/memory-branches/memory-source/fork',
        '/functions/v1/agent-control-plane/agents/agent-local/projections',
        '/functions/v1/agent-control-plane/projections/projection-branch/sync/pull',
        '/functions/v1/agent-control-plane/projections/projection-branch/sync/sync-branch/ack',
      ],
    );
  } finally {
    await server.close();
    restoreEnv();
    rmSync(tempDir, { recursive: true, force: true });
  }
});
