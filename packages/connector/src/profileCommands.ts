import { loadConfig } from './config.js';
import {
  createLocalProfile,
  applyLocalProfileProjection,
  normalizeProfileName,
  recordLocalProfileHandoff,
  readLocalProfileSyncMetadata,
  recordLocalProfileProposalPush,
  resolveLocalProfilePaths,
} from './localProfile.js';
import { SignedApiClient } from './signedApiClient.js';
import type { RuntimeType } from './types.js';

interface ProfileCommandOptions {
  profile?: string;
  runtime?: RuntimeType;
  fromRuntime?: RuntimeType;
  toRuntime?: RuntimeType;
  agentId?: string;
  baseDir?: string;
  sourceBaseDir?: string;
  targetBaseDir?: string;
  memory?: string;
  reason?: string;
  sourceExcerpt?: string;
  handoffNote?: string;
}

function usage(): string {
  return [
    'Usage:',
    '  6ducklearn-connector profile create <profile_name> [--runtime codex|hermes] [--base-dir <path>]',
    '  6ducklearn-connector profile sync --profile <profile_name> [--runtime codex|hermes] [--agent-id <agent_id>] [--base-dir <path>]',
    '  6ducklearn-connector profile propose --profile <profile_name> --memory <text> [--reason <text>] [--runtime codex|hermes] [--agent-id <agent_id>] [--base-dir <path>]',
    '  6ducklearn-connector profile switch --profile <profile_name> --from-runtime codex|hermes --to-runtime codex|hermes [--handoff-note <text>] [--agent-id <agent_id>] [--source-base-dir <path>] [--target-base-dir <path>]',
    '  6ducklearn-connector sync --profile <profile_name> [--runtime codex|hermes] [--agent-id <agent_id>] [--base-dir <path>]',
  ].join('\n');
}

function parseRuntime(value: string | undefined): RuntimeType | undefined {
  if (!value) return undefined;
  if (value === 'codex' || value === 'hermes') return value;
  if (value === 'openclaw') {
    throw new Error('OpenClaw Local Profile Projection sync is not enabled in this alpha.');
  }
  throw new Error(`Unsupported runtime: ${value}`);
}

function parseOptions(args: string[]): ProfileCommandOptions & { positional: string[] } {
  const options: ProfileCommandOptions & { positional: string[] } = { positional: [] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--profile') {
      options.profile = args[++index];
    } else if (arg === '--runtime') {
      options.runtime = parseRuntime(args[++index]);
    } else if (arg === '--from-runtime' || arg === '--source-runtime') {
      options.fromRuntime = parseRuntime(args[++index]);
    } else if (arg === '--to-runtime' || arg === '--target-runtime') {
      options.toRuntime = parseRuntime(args[++index]);
    } else if (arg === '--agent-id') {
      options.agentId = args[++index];
    } else if (arg === '--base-dir' || arg === '--dir') {
      options.baseDir = args[++index];
    } else if (arg === '--source-base-dir' || arg === '--from-base-dir') {
      options.sourceBaseDir = args[++index];
    } else if (arg === '--target-base-dir' || arg === '--to-base-dir') {
      options.targetBaseDir = args[++index];
    } else if (arg === '--memory' || arg === '--suggestion') {
      options.memory = args[++index];
    } else if (arg === '--reason') {
      options.reason = args[++index];
    } else if (arg === '--source-excerpt') {
      options.sourceExcerpt = args[++index];
    } else if (arg === '--handoff-note') {
      options.handoffNote = args[++index];
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      options.positional.push(arg);
    }
  }
  return options;
}

function resolveRuntime(options: ProfileCommandOptions): RuntimeType {
  if (options.runtime) return options.runtime;
  return parseRuntime(process.env.SIXDUCK_RUNTIME_TYPE || process.env.DUCK_RUNTIME_TYPE) ?? 'codex';
}

function applyRuntimeEnv(runtimeType: RuntimeType): void {
  process.env.SIXDUCK_RUNTIME_TYPE = runtimeType;
}

function resolveProfileOption(options: ProfileCommandOptions & { positional: string[] }): string {
  const profile = options.profile ?? options.positional[0];
  if (!profile) throw new Error(`Missing profile name.\n${usage()}`);
  return normalizeProfileName(profile);
}

function resolveAgentId(options: ProfileCommandOptions, configAgentId: string | null): string {
  const agentId = options.agentId ?? configAgentId ?? process.env.SIXDUCK_AGENT_ID ?? process.env.DUCK_AGENT_ID;
  if (!agentId) {
    throw new Error('Profile sync requires an Agent ID. Set SIXDUCK_AGENT_ID or pass --agent-id.');
  }
  return agentId;
}

function assertLocalProfileAgentBoundary(metadataAgentId: string | null, agentId: string, action: string): void {
  if (!metadataAgentId || metadataAgentId === agentId) return;
  throw new Error(
    `Local profile metadata belongs to Agent ID ${metadataAgentId}, but the active connector is using ${agentId}. Run profile sync with the matching agent before ${action}.`,
  );
}

function resolveTokenId(configTokenId: string | null, configOAuthTokenId: string | null): string {
  const tokenId = configOAuthTokenId ?? configTokenId ?? process.env.SIXDUCK_TOKEN_ID ?? process.env.DUCK_TOKEN_ID;
  if (!tokenId) {
    throw new Error('Profile sync requires a token id. Login with an agent-scoped connector token or set SIXDUCK_TOKEN_ID.');
  }
  return tokenId;
}

function resolveMemoryProposal(options: ProfileCommandOptions): {
  suggestion_content: string;
  reason: string;
  source_excerpt?: string;
} {
  const suggestion = options.memory?.trim();
  if (!suggestion) {
    throw new Error(`Missing memory proposal text. Pass --memory <text>.\n${usage()}`);
  }
  return {
    suggestion_content: suggestion,
    reason: options.reason?.trim() || 'Runtime-local learning proposed from a 6DuckLearn Local Profile Projection.',
    ...(options.sourceExcerpt?.trim() ? { source_excerpt: options.sourceExcerpt.trim() } : {}),
  };
}

async function runCreate(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const runtimeType = resolveRuntime(options);
  const profileName = resolveProfileOption(options);
  const paths = createLocalProfile({
    profileName,
    runtimeType,
    baseDir: options.baseDir,
  });
  console.log(`[6ducklearn-connector] Created Local Profile Projection: ${paths.localProfileKey}`);
  console.log(`[6ducklearn-connector] Profile directory: ${paths.profileDir}`);
}

async function runSync(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const runtimeType = resolveRuntime(options);
  applyRuntimeEnv(runtimeType);
  const profileName = resolveProfileOption(options);
  const paths = resolveLocalProfilePaths({
    profileName,
    runtimeType,
    baseDir: options.baseDir,
  });
  const config = loadConfig();
  const agentId = resolveAgentId(options, config.oauthAgentId);
  const tokenId = resolveTokenId(config.tokenId, config.oauthTokenId);
  const client = new SignedApiClient(config);

  createLocalProfile({ profileName, runtimeType, baseDir: options.baseDir });
  const connection = await client.registerConnection('profile-sync');
  await client.heartbeat(connection.id, 'online', 'profile-sync');
  const { projection } = await client.bindLocalProfileProjection(agentId, {
    runtime_type: runtimeType,
    local_profile_key: paths.localProfileKey,
    token_id: tokenId,
    connection_id: connection.id,
    local_path_hint: paths.profileDir,
    sync_policy: {
      mode: 'manual',
      command: '6ducklearn-connector profile sync',
    },
  });
  const pull = await client.pullLocalProfileProjection(projection.id);
  const applied = applyLocalProfileProjection({
    profileName,
    runtimeType,
    baseDir: options.baseDir,
    pullResult: pull,
  });
  const ack = await client.ackLocalProfileProjectionSync(
    applied.projectionId,
    applied.syncId,
    applied.profileHash,
  );

  console.log(`[6ducklearn-connector] Synced Local Profile Projection: ${applied.localProfileKey}`);
  console.log(`[6ducklearn-connector] Agent ID: ${applied.agentId}`);
  console.log(`[6ducklearn-connector] Projection ID: ${applied.projectionId}`);
  console.log(`[6ducklearn-connector] Sync status: ${ack.sync.status}`);
  console.log(`[6ducklearn-connector] Skills written: ${applied.skillCount}`);
  if (applied.skippedLocks.length > 0) {
    console.log(`[6ducklearn-connector] Skipped locked skills: ${applied.skippedLocks.map((lock) => lock.skill_key).join(', ')}`);
  }
  console.log(`[6ducklearn-connector] Profile directory: ${applied.profileDir}`);
}

async function runPropose(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const runtimeType = resolveRuntime(options);
  applyRuntimeEnv(runtimeType);
  const profileName = resolveProfileOption(options);
  const local = readLocalProfileSyncMetadata({
    profileName,
    runtimeType,
    baseDir: options.baseDir,
  });
  const config = loadConfig();
  const metadataAgentId = typeof local.metadata.agent_id === 'string' ? local.metadata.agent_id : null;
  const metadataProjectionId = typeof local.metadata.projection_id === 'string' ? local.metadata.projection_id : null;
  const metadataProfileHash = typeof local.metadata.profile_hash === 'string' ? local.metadata.profile_hash : null;
  if (!metadataProjectionId) {
    throw new Error('Local profile metadata is missing projection_id. Run profile sync again before proposing memory.');
  }
  const agentId = resolveAgentId(options, config.oauthAgentId ?? metadataAgentId);
  assertLocalProfileAgentBoundary(metadataAgentId, agentId, 'proposing memory');
  const tokenId = resolveTokenId(config.tokenId, config.oauthTokenId);
  const proposal = resolveMemoryProposal(options);
  const client = new SignedApiClient(config);

  const connection = await client.registerConnection('profile-propose');
  await client.heartbeat(connection.id, 'online', 'profile-propose');
  const { projection } = await client.bindLocalProfileProjection(agentId, {
    runtime_type: runtimeType,
    local_profile_key: local.localProfileKey,
    token_id: tokenId,
    connection_id: connection.id,
    local_path_hint: local.profileDir,
    sync_policy: {
      mode: 'manual',
      command: '6ducklearn-connector profile propose',
    },
  });
  const result = await client.submitLocalProfileMemoryProposals(projection.id ?? metadataProjectionId, {
    profile_hash: metadataProfileHash,
    proposals: [proposal],
    source: {
      command: '6ducklearn-connector profile propose',
      local_profile_key: local.localProfileKey,
      profile_name: local.profileName,
      runtime_type: runtimeType,
    },
  });
  recordLocalProfileProposalPush({
    profileName,
    runtimeType,
    baseDir: options.baseDir,
    createdCount: result.created_count,
    proposalCount: result.proposals.length,
  });

  console.log(`[6ducklearn-connector] Submitted memory proposal for: ${local.localProfileKey}`);
  console.log(`[6ducklearn-connector] Created new review items: ${result.created_count}`);
  console.log(`[6ducklearn-connector] Review queue items returned: ${result.proposals.length}`);
  console.log('[6ducklearn-connector] Canonical memory was not changed. Keep the proposal in 6DuckLearn to promote it.');
}

async function runSwitch(args: string[]): Promise<void> {
  const options = parseOptions(args);
  const fromRuntime = options.fromRuntime;
  const targetRuntime = options.toRuntime ?? options.runtime;
  if (!fromRuntime || !targetRuntime) {
    throw new Error(`Profile switch requires --from-runtime and --to-runtime.\n${usage()}`);
  }
  if (fromRuntime === targetRuntime) {
    throw new Error('Profile switch requires two different runtimes.');
  }
  if (options.baseDir && !options.sourceBaseDir && !options.targetBaseDir) {
    throw new Error(
      'Profile switch cannot use one shared --base-dir because source and target runtime profiles must stay independent. Use --source-base-dir and --target-base-dir, or omit custom base directories.',
    );
  }
  applyRuntimeEnv(targetRuntime);
  const profileName = resolveProfileOption(options);
  const sourceBaseDir = options.sourceBaseDir ?? options.baseDir;
  const targetBaseDir = options.targetBaseDir ?? options.baseDir;
  const sourceLocal = readLocalProfileSyncMetadata({
    profileName,
    runtimeType: fromRuntime,
    baseDir: sourceBaseDir,
  });
  const targetPaths = resolveLocalProfilePaths({
    profileName,
    runtimeType: targetRuntime,
    baseDir: targetBaseDir,
  });
  if (sourceLocal.profileDir === targetPaths.profileDir) {
    throw new Error(
      `Profile switch requires separate source and target folders, but both resolve to ${sourceLocal.profileDir}. Use distinct --source-base-dir and --target-base-dir values.`,
    );
  }
  const config = loadConfig();
  const metadataAgentId = typeof sourceLocal.metadata.agent_id === 'string' ? sourceLocal.metadata.agent_id : null;
  const sourceProjectionId = typeof sourceLocal.metadata.projection_id === 'string' ? sourceLocal.metadata.projection_id : null;
  const sourceProfileHash = typeof sourceLocal.metadata.profile_hash === 'string' ? sourceLocal.metadata.profile_hash : null;
  if (!sourceProjectionId) {
    throw new Error('Source local profile metadata is missing projection_id. Run profile sync before switching runtimes.');
  }
  const agentId = resolveAgentId(options, config.oauthAgentId ?? metadataAgentId);
  assertLocalProfileAgentBoundary(metadataAgentId, agentId, 'switching runtime');
  const tokenId = resolveTokenId(config.tokenId, config.oauthTokenId);
  const handoffNote = options.handoffNote?.trim() || null;
  const client = new SignedApiClient(config);

  const connection = await client.registerConnection('profile-switch');
  await client.heartbeat(connection.id, 'online', 'profile-switch');
  const handoff = await client.prepareRuntimeHandoff({
    agent_id: agentId,
    handoff_note: handoffNote,
    source_profile_hash: sourceProfileHash,
    source_projection_id: sourceProjectionId,
    source_runtime_type: fromRuntime,
    target_connection_id: connection.id,
    target_local_profile_key: targetPaths.localProfileKey,
    target_runtime_type: targetRuntime,
  });
  const { projection } = await client.bindLocalProfileProjection(agentId, {
    runtime_type: targetRuntime,
    local_profile_key: targetPaths.localProfileKey,
    token_id: tokenId,
    connection_id: connection.id,
    local_path_hint: targetPaths.profileDir,
    sync_policy: {
      mode: 'manual',
      command: '6ducklearn-connector profile switch',
      source_runtime_type: fromRuntime,
    },
  });
  const pull = await client.pullLocalProfileProjection(projection.id);
  const applied = applyLocalProfileProjection({
    profileName,
    runtimeType: targetRuntime,
    baseDir: targetBaseDir,
    pullResult: pull,
  });
  const ack = await client.ackLocalProfileProjectionSync(
    applied.projectionId,
    applied.syncId,
    applied.profileHash,
  );
  recordLocalProfileHandoff({
    profileName,
    runtimeType: targetRuntime,
    baseDir: targetBaseDir,
    sourceRuntimeType: fromRuntime,
    sourceLocalProfileKey: sourceLocal.localProfileKey,
    sourceProjectionId,
    sourceProfileHash,
    handoffEventId: handoff.handoff_contract.handoff_event_id ?? null,
    handoffNote,
  });

  console.log(`[6ducklearn-connector] Switched Local Profile Projection: ${sourceLocal.localProfileKey} -> ${applied.localProfileKey}`);
  console.log(`[6ducklearn-connector] Agent ID: ${applied.agentId}`);
  console.log(`[6ducklearn-connector] Handoff event: ${handoff.handoff_contract.handoff_event_id ?? 'recorded'}`);
  console.log(`[6ducklearn-connector] Target projection ID: ${applied.projectionId}`);
  console.log(`[6ducklearn-connector] Sync status: ${ack.sync.status}`);
  console.log('[6ducklearn-connector] Device-local state was not transferred; only canonical profile context was projected.');
}

export async function runProfileCommand(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  if (command === 'profile') {
    const subcommand = argv[1];
    if (subcommand === 'create') {
      await runCreate(argv.slice(2));
      return;
    }
    if (subcommand === 'sync') {
      await runSync(argv.slice(2));
      return;
    }
    if (subcommand === 'propose') {
      await runPropose(argv.slice(2));
      return;
    }
    if (subcommand === 'switch') {
      await runSwitch(argv.slice(2));
      return;
    }
  }
  if (command === 'sync') {
    await runSync(argv.slice(1));
    return;
  }
  throw new Error(usage());
}
