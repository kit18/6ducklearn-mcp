import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { PullLocalProfileProjectionResult, RuntimeType, SkippedSkillLock } from './types.js';

export interface LocalProfilePaths {
  profileName: string;
  runtimeType: RuntimeType;
  localProfileKey: string;
  profileDir: string;
  configPath: string;
  skillsDir: string;
  memoryDir: string;
  metadataDir: string;
  metadataPath: string;
}

export interface ApplyLocalProfileResult extends LocalProfilePaths {
  agentId: string;
  projectionId: string;
  syncId: string;
  profileHash: string;
  skillCount: number;
  skippedLocks: SkippedSkillLock[];
}

export interface LocalProfileSyncMetadata {
  schema_version?: string;
  profile_name?: string;
  runtime_type?: RuntimeType;
  local_profile_key?: string;
  agent_id?: string;
  projection_id?: string;
  sync_id?: string;
  profile_hash?: string;
  local_file_hash?: string;
  updated_at?: string;
  last_push_proposal_at?: string;
  [key: string]: unknown;
}

export interface ReadLocalProfileSyncMetadataResult extends LocalProfilePaths {
  metadata: LocalProfileSyncMetadata;
}

function runtimeProfileBaseDir(runtimeType: RuntimeType): string {
  if (runtimeType === 'hermes') return join(homedir(), '.hermes', 'profiles');
  if (runtimeType === 'codex') return join(homedir(), '.codex', 'profiles');
  return join(homedir(), '.6ducklearn', 'profiles', runtimeType);
}

function shellSafeName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[._-]+|[._-]+$/g, '');
}

function yamlString(value: string | null | undefined): string {
  return JSON.stringify(value ?? '');
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(record[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function localFileHash(files: Array<{ path: string; content: string }>): string {
  const hash = createHash('sha256');
  for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(file.content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function writeTextFile(path: string, content: string, written: Array<{ path: string; content: string }>): void {
  writeFileSync(path, content, 'utf8');
  written.push({ path, content });
}

function readExistingJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function metadataText(metadata: Record<string, unknown>, key: string): string | null {
  const value = metadata[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function normalizeProfileName(input: string): string {
  const normalized = shellSafeName(input);
  if (!normalized) {
    throw new Error('Profile name must contain at least one letter or number.');
  }
  if (normalized.length > 96) {
    throw new Error('Profile name must be 96 characters or fewer after normalization.');
  }
  return normalized;
}

export function resolveLocalProfilePaths(input: {
  profileName: string;
  runtimeType: RuntimeType;
  baseDir?: string;
}): LocalProfilePaths {
  const profileName = normalizeProfileName(input.profileName);
  const profileDir = resolve(input.baseDir ?? runtimeProfileBaseDir(input.runtimeType), profileName);
  const metadataDir = join(profileDir, '.6ducklearn');
  return {
    profileName,
    runtimeType: input.runtimeType,
    localProfileKey: `${input.runtimeType}:${profileName}`,
    profileDir,
    configPath: join(profileDir, 'config.yaml'),
    skillsDir: join(profileDir, 'skills'),
    memoryDir: join(profileDir, 'memory'),
    metadataDir,
    metadataPath: join(metadataDir, 'profile-sync.json'),
  };
}

export function createLocalProfile(input: {
  profileName: string;
  runtimeType: RuntimeType;
  baseDir?: string;
}): LocalProfilePaths {
  const paths = resolveLocalProfilePaths(input);
  mkdirSync(paths.skillsDir, { recursive: true });
  mkdirSync(paths.memoryDir, { recursive: true });
  mkdirSync(paths.metadataDir, { recursive: true });

  if (!existsSync(paths.configPath)) {
    writeFileSync(paths.configPath, [
      '# 6DuckLearn Local Profile Projection',
      `profile_name: ${yamlString(paths.profileName)}`,
      `runtime_type: ${yamlString(paths.runtimeType)}`,
      `local_profile_key: ${yamlString(paths.localProfileKey)}`,
      'sync:',
      '  mode: "manual"',
      '  status: "local-only"',
      '',
    ].join('\n'), 'utf8');
  }

  const memoryReadmePath = join(paths.memoryDir, 'README.md');
  if (!existsSync(memoryReadmePath)) {
    writeFileSync(memoryReadmePath, [
      '# Memory',
      '',
      '6DuckLearn Profile Sync does not pull canonical memory into this local folder.',
      'Local learning should be pushed back as reviewable memory proposals before it can evolve the Agent Profile.',
      '',
    ].join('\n'), 'utf8');
  }

  if (!existsSync(paths.metadataPath)) {
    writeFileSync(paths.metadataPath, `${JSON.stringify({
      schema_version: '2026-06-28',
      profile_name: paths.profileName,
      runtime_type: paths.runtimeType,
      local_profile_key: paths.localProfileKey,
      created_at: new Date().toISOString(),
      sync_status: 'local-only',
    }, null, 2)}\n`, 'utf8');
  }

  return paths;
}

export function readLocalProfileSyncMetadata(input: {
  profileName: string;
  runtimeType: RuntimeType;
  baseDir?: string;
}): ReadLocalProfileSyncMetadataResult {
  const paths = resolveLocalProfilePaths(input);
  const metadata = readExistingJson(paths.metadataPath);
  if (!metadata) {
    throw new Error(`Local profile metadata not found. Run profile sync first: ${paths.metadataPath}`);
  }
  const projectionId = metadataText(metadata, 'projection_id');
  if (!projectionId) {
    throw new Error('Local profile metadata does not include projection_id. Run profile sync again before proposing memory.');
  }
  return {
    ...paths,
    metadata: metadata as LocalProfileSyncMetadata,
  };
}

export function recordLocalProfileProposalPush(input: {
  profileName: string;
  runtimeType: RuntimeType;
  baseDir?: string;
  createdCount: number;
  proposalCount: number;
  pushedAt?: string;
}): ReadLocalProfileSyncMetadataResult {
  const current = readLocalProfileSyncMetadata(input);
  const pushedAt = input.pushedAt ?? new Date().toISOString();
  const metadata: LocalProfileSyncMetadata = {
    ...current.metadata,
    last_push_proposal_at: pushedAt,
    last_push_proposal_count: input.proposalCount,
    last_push_proposal_created_count: input.createdCount,
    updated_at: pushedAt,
  };
  writeFileSync(current.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return {
    ...current,
    metadata,
  };
}

export function recordLocalProfileHandoff(input: {
  profileName: string;
  runtimeType: RuntimeType;
  baseDir?: string;
  sourceRuntimeType: RuntimeType;
  sourceLocalProfileKey?: string | null;
  sourceProjectionId?: string | null;
  sourceProfileHash?: string | null;
  handoffEventId?: string | null;
  handoffNote?: string | null;
  switchedAt?: string;
}): ReadLocalProfileSyncMetadataResult {
  const current = readLocalProfileSyncMetadata(input);
  const switchedAt = input.switchedAt ?? new Date().toISOString();
  const metadata: LocalProfileSyncMetadata = {
    ...current.metadata,
    last_handoff: {
      handoff_event_id: input.handoffEventId ?? null,
      handoff_note: input.handoffNote ?? null,
      source_local_profile_key: input.sourceLocalProfileKey ?? null,
      source_profile_hash: input.sourceProfileHash ?? null,
      source_projection_id: input.sourceProjectionId ?? null,
      source_runtime_type: input.sourceRuntimeType,
      target_local_profile_key: current.localProfileKey,
      target_runtime_type: input.runtimeType,
      transfer_policy: 'canonical_profile_context_only',
      switched_at: switchedAt,
    },
    updated_at: switchedAt,
  };
  writeFileSync(current.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
  return {
    ...current,
    metadata,
  };
}

export function applyLocalProfileProjection(input: {
  profileName: string;
  runtimeType: RuntimeType;
  pullResult: PullLocalProfileProjectionResult;
  baseDir?: string;
}): ApplyLocalProfileResult {
  const paths = createLocalProfile(input);
  const projection = input.pullResult.runtime_projection;
  const syncId = input.pullResult.sync.id;
  const profileHash = input.pullResult.sync.result_profile_hash;
  if (!syncId) throw new Error('Profile Sync pull response did not include sync.id.');
  if (!profileHash) throw new Error('Profile Sync pull response did not include result_profile_hash.');

  const skillRoot = join(paths.skillsDir, '6ducklearn');
  rmSync(skillRoot, { recursive: true, force: true });
  mkdirSync(skillRoot, { recursive: true });
  mkdirSync(paths.metadataDir, { recursive: true });

  const written: Array<{ path: string; content: string }> = [];
  const systemPrompt = projection.system_prompt ?? '';
  writeTextFile(join(paths.profileDir, 'SYSTEM_PROMPT.md'), `${systemPrompt.trim()}\n`, written);

  const skillPacks = Array.isArray(projection.skill_packs) ? projection.skill_packs : [];
  for (const skillPack of skillPacks) {
    const key = typeof skillPack.key === 'string' ? shellSafeName(skillPack.key) : '';
    if (!key) continue;
    const label = typeof skillPack.label === 'string' ? skillPack.label : key;
    const description = typeof skillPack.description === 'string'
      ? skillPack.description
      : `6DuckLearn projected skill pack: ${label}`;
    const content = typeof skillPack.prompt_block === 'string'
      ? skillPack.prompt_block
      : '';
    const skillDir = join(skillRoot, key);
    mkdirSync(skillDir, { recursive: true });
    writeTextFile(join(skillDir, 'SKILL.md'), [
      '---',
      `name: ${JSON.stringify(key)}`,
      `description: ${JSON.stringify(description)}`,
      '---',
      '',
      content.trim(),
      '',
    ].join('\n'), written);
  }

  const skippedLocks = input.pullResult.skipped_locks ?? [];
  const metadata = {
    ...(readExistingJson(paths.metadataPath) ?? {}),
    schema_version: '2026-06-28',
    profile_name: paths.profileName,
    runtime_type: paths.runtimeType,
    local_profile_key: paths.localProfileKey,
    agent_id: projection.agent_id,
    projection_id: input.pullResult.projection.id,
    sync_id: syncId,
    profile_hash: profileHash,
    local_file_hash: localFileHash(written),
    projection_metadata: projection.projection_metadata ?? null,
    skipped_locks: skippedLocks,
    memory_policy: input.pullResult.invariants?.memory_policy ?? 'review_proposals_only',
    updated_at: new Date().toISOString(),
    sync_status: 'applied',
  };
  const metadataContent = `${JSON.stringify(metadata, null, 2)}\n`;
  writeTextFile(paths.metadataPath, metadataContent, written);

  const configContent = [
    '# 6DuckLearn Local Profile Projection',
    `profile_name: ${yamlString(paths.profileName)}`,
    `runtime_type: ${yamlString(paths.runtimeType)}`,
    `local_profile_key: ${yamlString(paths.localProfileKey)}`,
    `agent_id: ${yamlString(projection.agent_id)}`,
    `projection_id: ${yamlString(input.pullResult.projection.id)}`,
    `sync_id: ${yamlString(syncId)}`,
    `last_profile_hash: ${yamlString(profileHash)}`,
    `local_file_hash: ${yamlString(metadata.local_file_hash)}`,
    'sync:',
    '  mode: "manual"',
    '  status: "applied"',
    `  skipped_lock_count: ${skippedLocks.length}`,
    'memory:',
    '  pull_policy: "disabled"',
    '  push_policy: "review_proposal"',
    `projection_metadata_json: ${yamlString(stableStringify(projection.projection_metadata ?? null))}`,
    '',
  ].join('\n');
  writeTextFile(paths.configPath, configContent, written);

  writeTextFile(join(paths.memoryDir, 'README.md'), [
    '# Memory',
    '',
    '6DuckLearn Profile Sync does not pull canonical memory into this local folder.',
    'Local learning should be pushed back as reviewable memory proposals before it can evolve the Agent Profile.',
    '',
    `Last synced Agent Profile: ${projection.agent_id}`,
    `Last sync run: ${syncId}`,
    '',
  ].join('\n'), written);

  return {
    ...paths,
    agentId: projection.agent_id,
    projectionId: input.pullResult.projection.id,
    syncId,
    profileHash,
    skillCount: skillPacks.length,
    skippedLocks,
  };
}
