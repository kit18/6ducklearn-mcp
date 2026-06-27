export type RuntimeType = 'codex' | 'openclaw' | 'hermes';

export interface RuntimeCapabilities {
  schema_version: string;
  runtime: RuntimeType;
  transport: string;
  protocol: string;
  structured_context?: {
    instructions: boolean;
    metadata: boolean;
    input_items: boolean;
    fallback_mode: 'native' | 'text_envelope';
  };
  features: {
    streaming: boolean;
    interrupt: boolean;
    approvals: boolean;
    session_sync: boolean;
    remote_access: boolean;
  };
  [key: string]: unknown;
}

export interface ConnectorConfig {
  supabaseUrl: string;
  tokenId: string | null;
  hmacSecret: string | null;
  oauthAccessToken: string | null;
  oauthRefreshToken: string | null;
  oauthClientId: string | null;
  oauthTokenEndpoint: string | null;
  oauthExpiresAt: string | null;
  oauthSessionPath: string | null;
  oauthScope: string | null;
  oauthResource: string | null;
  oauthRuntimeType: RuntimeType | null;
  oauthTokenId: string | null;
  oauthAgentId: string | null;
  deviceId: string;
  deviceName: string;
  runtimeType: RuntimeType;
  pollIntervalMs: number;
  heartbeatIntervalMs: number;
  serviceName: string;
  adapterVersion: string;
  codex: {
    model: string;
    reasoningEffort: 'low' | 'medium' | 'high';
    summary: 'auto' | 'concise' | 'detailed';
    cwd: string;
    minVersion: string;
    quietProfile: boolean;
  };
  openclaw: {
    gatewayUrl: string;
    gatewayToken: string | null;
    gatewayPassword: string | null;
    allowInsecureLocalAuth: boolean;
    sessionKey: string;
    protocolVersion: number;
  };
  hermes: {
    baseUrl: string;
    apiKey: string | null;
    conversationPrefix: string;
  };
}

export interface RuntimeConnectionRecord {
  id: string;
  status: string;
  runtime_type: RuntimeType;
  device_id: string;
  device_name: string;
  capabilities?: Record<string, unknown>;
  capabilities_version?: string | null;
  runtime_version?: string | null;
  adapter_version?: string | null;
}

export interface LocalProfileProjection {
  id: string;
  user_id?: string;
  agent_id: string;
  profile_alias_id?: string | null;
  connection_id: string;
  runtime_type: RuntimeType;
  local_profile_key: string;
  projection_key?: string;
  projection_version?: number;
  sync_policy?: Record<string, unknown> | null;
  status: string;
  last_profile_hash?: string | null;
  last_heartbeat_at?: string | null;
  last_pull_at?: string | null;
  last_push_proposal_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface BindLocalProfileProjectionInput {
  runtime_type: RuntimeType;
  local_profile_key: string;
  token_id: string;
  connection_id: string;
  local_path_hint?: string;
  profile_alias?: string;
  profile_alias_id?: string;
  sync_policy?: Record<string, unknown>;
}

export interface SkippedSkillLock {
  skill_key: string;
  lock_id: string;
  reason: string | null;
  runtime_type: string | null;
}

export interface ProjectionMetadata {
  agent_profile_id: string | null;
  role_archetype: string | null;
  strategy_pack_key: string | null;
  skill_pack_keys: string[];
  memory_branch_id: string | null;
  memory_profile_ids: string[];
  runtime_type: string;
}

export interface SkillCatalogEntry {
  id: string;
  label: string;
  description: string;
  source: string;
  mode: 'remote-library' | 'local-directory';
  install_path?: string;
  browse_path?: string;
  read_only: boolean;
}

export interface McpServerEntry {
  name: string;
  label?: string;
  transport: 'stdio' | 'http';
  source: string;
  read_only: boolean;
  bridge_url?: string;
  tools_url?: string;
  manifest_url?: string;
}

export interface ToolCatalogEntry {
  id: string;
  label: string;
  server_name: string;
  source: string;
  manifest_url?: string;
  read_only: boolean;
  tool_names: string[];
}

export interface SessionAttachment {
  kind: 'skill' | 'mcp_server' | 'mcp_tool';
  id: string;
  label: string;
  source: string;
  enabled: boolean;
  via?: 'default' | 'user';
  description?: string;
  server_name?: string;
  tool_name?: string;
  skill_name?: string;
  content?: string;
}

export interface ProjectedSkillModule {
  id: string;
  name: string;
  label: string;
  description: string;
  content: string;
}

export interface ProjectionInstructionsPayload {
  system_prompt: string;
  base_instructions: string | null;
  developer_instructions: string | null;
  skill_modules: ProjectedSkillModule[];
}

export interface RuntimeProjectionPayload {
  metadata: ProjectionMetadata | null;
  registry: {
    skill_catalogs: SkillCatalogEntry[];
    mcp_servers: McpServerEntry[];
    tool_catalogs: ToolCatalogEntry[];
    default_session_attachments: SessionAttachment[];
  };
  instructions?: ProjectionInstructionsPayload | null;
}

export interface PullLocalProfileProjectionResult {
  projection: LocalProfileProjection;
  sync: {
    id: string;
    direction?: string;
    trigger_kind?: string;
    status?: string;
    base_profile_hash?: string | null;
    result_profile_hash?: string | null;
    skipped_locks?: SkippedSkillLock[];
    [key: string]: unknown;
  };
  runtime_projection: {
    agent_id: string;
    runtime_type: RuntimeType;
    local_profile_key: string;
    projection_metadata?: ProjectionMetadata | null;
    logical_agent?: Record<string, unknown> | null;
    system_prompt?: string;
    approval_level?: string;
    data_boundaries?: Record<string, unknown> | null;
    skill_packs: Array<Record<string, unknown>>;
    [key: string]: unknown;
  };
  skipped_locks: SkippedSkillLock[];
  invariants?: Record<string, unknown>;
}

export interface AckLocalProfileProjectionSyncResult {
  projection: LocalProfileProjection;
  sync: {
    id: string;
    status: string;
    result_profile_hash?: string | null;
    [key: string]: unknown;
  };
}

export interface LocalProfileMemoryProposalInput {
  suggestion_content: string;
  reason?: string;
  source_excerpt?: string;
}

export interface SubmitLocalProfileMemoryProposalsInput {
  profile_hash?: string | null;
  proposals: LocalProfileMemoryProposalInput[];
  source?: Record<string, unknown>;
}

export interface LocalProfileMemoryProposal {
  id: string;
  agent_id?: string;
  target_profile_id?: string;
  suggestion_content?: string;
  reason?: string;
  status: string;
  created_at?: string;
  [key: string]: unknown;
}

export interface SubmitLocalProfileMemoryProposalsResult {
  projection: LocalProfileProjection;
  proposals: LocalProfileMemoryProposal[];
  created_count: number;
  target_profile_id: string;
  invariants?: Record<string, unknown>;
}

export interface ThreadRunProvenance {
  source: 'agent_console';
  thread_id: string;
  run_spec_id: string;
  task_id: string | null;
  agent_id: string | null;
  runtime_type: string;
  workspace_id: string | null;
  memory_branch_id: string | null;
  memory_profile_ids: string[];
  projection_context?: ProjectionMetadata | null;
  created_at: string;
  updated_at: string;
}

export interface PulledTurnPayload {
  connection: RuntimeConnectionRecord;
  token: {
    id: string;
    name: string;
    system_prompt: string;
    approval_level: string;
    approval_return_mode: string;
    data_boundaries: Record<string, unknown> | null;
  } | null;
  projection?: RuntimeProjectionPayload | null;
  thread: {
    id: string;
    title: string;
    runtime_thread_id: string | null;
    metadata?: Record<string, unknown> | null;
  } | null;
  turn: {
    id: string;
    thread_id: string;
    input_text: string;
    state: string;
    created_at: string;
    recovery_count?: number | null;
  } | null;
  run?: ThreadRunProvenance | null;
}

export interface ConsolePushEvent {
  event_type: string;
  payload: Record<string, unknown>;
}

export interface PendingApprovalStatus {
  approval_id: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  modified_instruction: string | null;
  metadata: Record<string, unknown> | null;
}

export type PlaybookActionCategory =
  | 'read_private'
  | 'write_private'
  | 'external_api'
  | 'publish_publicly'
  | 'high_cost'
  | 'destructive'
  | 'financial_trade'
  | 'memory_update';

export type PlaybookBoundary = 'auto' | 'require_approval' | 'deny';
export type PlaybookMemoryTargetType = 'rule' | 'example' | 'fact' | 'style' | 'correction';

export interface PlaybookRuntimeRequestBase {
  expertProfileId?: string;
  playbookId?: string;
  playbookVersionId?: string;
  runtimeSessionId?: string;
}

export interface SpawnExpertRequest extends PlaybookRuntimeRequestBase {
  expertProfileId: string;
  runtimeSessionKey?: string;
  runSpecId?: string;
  taskId?: string;
  payload?: Record<string, unknown>;
}

export interface PlaybookPermissionRequest extends PlaybookRuntimeRequestBase {
  actionCategory: PlaybookActionCategory;
  boundary?: PlaybookBoundary;
  resourceId?: string;
  environment?: string;
  title?: string;
  description?: string;
  previewHtml?: string;
}

export interface PlaybookRuntimeEventRequest extends PlaybookRuntimeRequestBase {
  eventType: string;
  summary?: string;
  runSpecId?: string;
  taskId?: string;
  payload?: Record<string, unknown>;
}

export interface PlaybookMemoryProposalRequest extends PlaybookRuntimeRequestBase {
  expertProfileId: string;
  targetType: PlaybookMemoryTargetType;
  proposedContent: string;
  sourceExcerpt?: string;
  memoryBranchId?: string;
}

export interface PlaybookRuntimeEnvelope<TData = Record<string, unknown>> {
  data: TData;
}

export interface RuntimeApprovalRequest {
  requestId: number | string;
  requestMethod: string;
  actionType: 'external_api' | 'high_cost_tools' | 'pkm_write';
  previewHtml: string;
  expiresAt?: string | null;
  metadata: Record<string, unknown>;
  approvalId?: string | null;
}

export type RuntimeApprovalRule = 'auto' | 'require_approval' | 'deny';
export type RuntimeApprovalRules = Partial<Record<RuntimeApprovalRequest['actionType'], RuntimeApprovalRule>>;
export type RuntimeSandboxPolicy = string | Record<string, unknown>;

export interface RuntimeUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number;
}

export type RuntimeInputItem =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'skill';
      name: string;
      path: string;
    }
  | {
      type: 'image';
      url: string;
    }
  | {
      type: 'localImage';
      path: string;
    };

export type ApprovalResolution =
  | {
      decision: 'approve';
      modifiedInstruction?: string | null;
    }
  | {
      decision: 'reject';
      modifiedInstruction?: string | null;
    }
  | {
      decision: 'expired';
    }
  | {
      decision: 'cancel';
    };

export type RuntimeEvent =
  | {
      type: 'turn.started';
      runtimeTurnId: string;
    }
  | {
      type: 'assistant.delta';
      text: string;
    }
  | {
      type: 'assistant.completed';
      text: string;
    }
  | {
      type: 'tool.started';
      itemType: string;
      label: string;
      detail?: string;
    }
  | {
      type: 'tool.output';
      itemType: string;
      delta: string;
    }
  | {
      type: 'tool.completed';
      itemType: string;
      label: string;
      success: boolean;
    }
  | {
      type: 'approval.requested';
      request: RuntimeApprovalRequest;
    }
  | {
      type: 'approval.resolved';
      approvalId: string;
      status: 'approved' | 'rejected' | 'expired' | 'cancelled';
    }
  | {
      type: 'runtime.error';
      message: string;
    }
  | {
      type: 'turn.completed';
      status: 'completed' | 'interrupted' | 'failed';
      message?: string;
      usage?: RuntimeUsage | null;
    };

export interface RuntimeThreadContext {
  runtimeThreadId?: string | null;
  systemPrompt?: string | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  metadata?: Record<string, unknown> | null;
  sandbox?: RuntimeSandboxPolicy;
}

export interface RuntimeTurnContext {
  runtimeThreadId: string;
  inputText: string;
}

export interface RuntimeAdapter {
  readonly runtimeType: RuntimeType;
  start(): Promise<void>;
  stop(): Promise<void>;
  detectRuntimeVersion(): Promise<string | null>;
  getCapabilities(): RuntimeCapabilities;
  ensureThread(context: RuntimeThreadContext): Promise<string>;
  interruptTurn(runtimeThreadId: string, runtimeTurnId: string): Promise<void>;
  runTurn(params: {
    threadId: string;
    inputText: string;
    inputItems?: RuntimeInputItem[];
    onEvent: (event: RuntimeEvent) => Promise<void> | void;
    onApprovalRequest?: (request: RuntimeApprovalRequest) => Promise<ApprovalResolution>;
    sandboxPolicy?: RuntimeSandboxPolicy;
    approvalRules?: RuntimeApprovalRules;
  }): Promise<void>;
}
