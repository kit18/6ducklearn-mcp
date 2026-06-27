import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyLocalProfileProjection,
  createLocalProfile,
  normalizeProfileName,
  recordLocalProfileHandoff,
  recordLocalProfileMemoryBranchFork,
  readLocalProfileSyncMetadata,
  recordLocalProfileProposalPush,
  resolveLocalProfilePaths,
} from '../dist/localProfile.js';

test('createLocalProfile initializes an independent runtime profile folder', () => {
  const tempDir = mkdtempSync(join(tmpdir(), '6ducklearn-profile-'));
  try {
    const paths = createLocalProfile({
      profileName: 'Research Analyst',
      runtimeType: 'hermes',
      baseDir: tempDir,
    });

    assert.equal(paths.profileName, 'research-analyst');
    assert.equal(paths.localProfileKey, 'hermes:research-analyst');
    assert.equal(existsSync(paths.configPath), true);
    assert.equal(existsSync(paths.skillsDir), true);
    assert.equal(existsSync(paths.memoryDir), true);
    assert.equal(existsSync(paths.metadataPath), true);
    assert.match(readFileSync(paths.configPath, 'utf8'), /sync:\n  mode: "manual"/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('applyLocalProfileProjection writes approved config and skills without memory pull', () => {
  const tempDir = mkdtempSync(join(tmpdir(), '6ducklearn-profile-'));
  try {
    const result = applyLocalProfileProjection({
      profileName: 'Research Analyst',
      runtimeType: 'hermes',
      baseDir: tempDir,
      pullResult: {
        projection: {
          id: 'projection-1',
          agent_id: 'agent-1',
          connection_id: 'connection-1',
          runtime_type: 'hermes',
          local_profile_key: 'hermes:research-analyst',
          status: 'active',
        },
        sync: {
          id: 'sync-1',
          status: 'pending',
          result_profile_hash: 'hash-1',
        },
        runtime_projection: {
          agent_id: 'agent-1',
          runtime_type: 'hermes',
          local_profile_key: 'hermes:research-analyst',
          projection_metadata: {
            agent_profile_id: 'agent-1',
            role_archetype: 'researcher',
            strategy_pack_key: null,
            skill_pack_keys: ['deep_research'],
            memory_branch_id: 'memory-branch-1',
            memory_profile_ids: ['memory-branch-1'],
            runtime_type: 'hermes',
          },
          system_prompt: 'You are a research analyst.',
          skill_packs: [{
            key: 'deep_research',
            label: 'Deep Research',
            description: 'Research deeply.',
            prompt_block: 'Use careful source-grounded research.',
          }],
        },
        skipped_locks: [{
          skill_key: 'portfolio_review',
          lock_id: 'lock-1',
          reason: 'Pinned locally',
          runtime_type: 'hermes',
        }],
      },
    });

    const paths = resolveLocalProfilePaths({
      profileName: 'Research Analyst',
      runtimeType: 'hermes',
      baseDir: tempDir,
    });
    const config = readFileSync(paths.configPath, 'utf8');
    const metadata = JSON.parse(readFileSync(paths.metadataPath, 'utf8'));
    const memoryReadme = readFileSync(join(paths.memoryDir, 'README.md'), 'utf8');

    assert.equal(result.profileHash, 'hash-1');
    assert.equal(result.skillCount, 1);
    assert.equal(existsSync(join(paths.skillsDir, '6ducklearn', 'deep_research', 'SKILL.md')), true);
    assert.match(readFileSync(join(paths.profileDir, 'SYSTEM_PROMPT.md'), 'utf8'), /research analyst/);
    assert.match(config, /last_profile_hash: "hash-1"/);
    assert.match(config, /branch_id: "memory-branch-1"/);
    assert.equal(metadata.agent_id, 'agent-1');
    assert.equal(metadata.memory_branch_id, 'memory-branch-1');
    assert.deepEqual(metadata.memory_profile_ids, ['memory-branch-1']);
    assert.equal(metadata.sync_status, 'applied');
    assert.match(memoryReadme, /does not pull canonical memory/);
    assert.match(memoryReadme, /Selected Memory Branch: memory-branch-1/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('normalizeProfileName rejects blank names', () => {
  assert.throws(() => normalizeProfileName('@@@'), /Profile name/);
});

test('recordLocalProfileProposalPush updates local sync metadata without touching memory content', () => {
  const tempDir = mkdtempSync(join(tmpdir(), '6ducklearn-profile-'));
  try {
    applyLocalProfileProjection({
      profileName: 'Research Analyst',
      runtimeType: 'codex',
      baseDir: tempDir,
      pullResult: {
        projection: {
          id: 'projection-1',
          agent_id: 'agent-1',
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
          agent_id: 'agent-1',
          runtime_type: 'codex',
          local_profile_key: 'codex:research-analyst',
          system_prompt: 'You are a research analyst.',
          skill_packs: [],
        },
        skipped_locks: [],
      },
    });

    const updated = recordLocalProfileProposalPush({
      profileName: 'Research Analyst',
      runtimeType: 'codex',
      baseDir: tempDir,
      createdCount: 1,
      proposalCount: 1,
      pushedAt: '2026-06-28T00:00:00.000Z',
    });
    const reread = readLocalProfileSyncMetadata({
      profileName: 'Research Analyst',
      runtimeType: 'codex',
      baseDir: tempDir,
    });

    assert.equal(updated.metadata.projection_id, 'projection-1');
    assert.equal(reread.metadata.last_push_proposal_at, '2026-06-28T00:00:00.000Z');
    assert.equal(reread.metadata.last_push_proposal_created_count, 1);
    assert.match(readFileSync(join(reread.memoryDir, 'README.md'), 'utf8'), /does not pull canonical memory/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('recordLocalProfileHandoff records source runtime without copying memory content', () => {
  const tempDir = mkdtempSync(join(tmpdir(), '6ducklearn-profile-'));
  try {
    applyLocalProfileProjection({
      profileName: 'Research Analyst',
      runtimeType: 'hermes',
      baseDir: tempDir,
      pullResult: {
        projection: {
          id: 'projection-target',
          agent_id: 'agent-1',
          connection_id: 'connection-2',
          runtime_type: 'hermes',
          local_profile_key: 'hermes:research-analyst',
          status: 'active',
        },
        sync: {
          id: 'sync-target',
          status: 'pending',
          result_profile_hash: 'hash-target',
        },
        runtime_projection: {
          agent_id: 'agent-1',
          runtime_type: 'hermes',
          local_profile_key: 'hermes:research-analyst',
          system_prompt: 'You are a research analyst.',
          skill_packs: [],
        },
        skipped_locks: [],
      },
    });

    const updated = recordLocalProfileHandoff({
      profileName: 'Research Analyst',
      runtimeType: 'hermes',
      baseDir: tempDir,
      sourceRuntimeType: 'codex',
      sourceLocalProfileKey: 'codex:research-analyst',
      sourceProjectionId: 'projection-source',
      sourceProfileHash: 'hash-source',
      handoffEventId: 'event-1',
      handoffNote: 'Move to Hermes.',
      switchedAt: '2026-06-28T01:00:00.000Z',
    });

    assert.equal(updated.metadata.last_handoff.handoff_event_id, 'event-1');
    assert.equal(updated.metadata.last_handoff.source_runtime_type, 'codex');
    assert.equal(updated.metadata.last_handoff.target_runtime_type, 'hermes');
    assert.equal(updated.metadata.last_handoff.transfer_policy, 'canonical_profile_context_only');
    assert.match(readFileSync(join(updated.memoryDir, 'README.md'), 'utf8'), /does not pull canonical memory/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test('recordLocalProfileMemoryBranchFork records branch lineage locally without memory content', () => {
  const tempDir = mkdtempSync(join(tmpdir(), '6ducklearn-profile-'));
  try {
    applyLocalProfileProjection({
      profileName: 'Research Analyst',
      runtimeType: 'codex',
      baseDir: tempDir,
      pullResult: {
        projection: {
          id: 'projection-1',
          agent_id: 'agent-1',
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
          agent_id: 'agent-1',
          runtime_type: 'codex',
          local_profile_key: 'codex:research-analyst',
          system_prompt: 'You are a research analyst.',
          projection_metadata: {
            agent_profile_id: 'agent-1',
            role_archetype: 'researcher',
            strategy_pack_key: null,
            skill_pack_keys: [],
            memory_branch_id: 'memory-branch-target',
            memory_profile_ids: ['memory-branch-target'],
            runtime_type: 'codex',
          },
          skill_packs: [],
        },
        skipped_locks: [],
      },
    });

    const updated = recordLocalProfileMemoryBranchFork({
      profileName: 'Research Analyst',
      runtimeType: 'codex',
      baseDir: tempDir,
      sourceMemoryBranchId: 'memory-branch-source',
      targetMemoryBranchId: 'memory-branch-target',
      branchName: 'Asia thesis',
      forkEventId: 'event-branch',
      forkNote: 'Explore one market separately.',
      forkedAt: '2026-06-28T02:00:00.000Z',
    });

    assert.equal(updated.metadata.memory_branch_id, 'memory-branch-target');
    assert.equal(updated.metadata.last_memory_branch_fork.fork_event_id, 'event-branch');
    assert.equal(updated.metadata.last_memory_branch_fork.source_memory_branch_id, 'memory-branch-source');
    assert.equal(updated.metadata.last_memory_branch_fork.target_memory_branch_id, 'memory-branch-target');
    assert.match(readFileSync(join(updated.memoryDir, 'README.md'), 'utf8'), /does not pull canonical memory/);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
});
