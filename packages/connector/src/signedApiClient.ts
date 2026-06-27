import { createHmac } from 'node:crypto';
import type {
  AckLocalProfileProjectionSyncResult,
  BindLocalProfileProjectionInput,
  ConnectorConfig,
  ConsolePushEvent,
  ForkMemoryBranchInput,
  ForkMemoryBranchResult,
  ListMemoryBranchesResult,
  LocalProfileProjection,
  PendingApprovalStatus,
  PlaybookMemoryProposalRequest,
  PlaybookPermissionRequest,
  PlaybookRuntimeEnvelope,
  PlaybookRuntimeEventRequest,
  PullLocalProfileProjectionResult,
  PulledTurnPayload,
  RuntimeHandoffInput,
  RuntimeHandoffResult,
  RuntimeConnectionRecord,
  RuntimeCapabilities,
  SpawnExpertRequest,
  RuntimeHealth,
  SubmitLocalProfileMemoryProposalsInput,
  SubmitLocalProfileMemoryProposalsResult,
} from './types.js';
import { writeOAuthSession } from './oauthSession.js';

interface ApiError extends Error {
  status?: number;
  rawBody?: string;
}

const PLAYBOOK_RUNTIME_FUNCTION = 'agent-mcp-tools';
const OAUTH_REFRESH_SKEW_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryablePushError(error: unknown): error is ApiError {
  if (!error || typeof error !== 'object') {
    return true;
  }
  const status = (error as ApiError).status;
  if (typeof status === 'number') {
    return status === 429 || status >= 500;
  }
  return true;
}

function buildCapabilities(config: ConnectorConfig): RuntimeCapabilities {
  if (config.runtimeType === 'openclaw') {
    return {
      schema_version: '2026-03-29',
      runtime: 'openclaw',
      transport: 'gateway-ws',
      protocol: 'openclaw-gateway',
      features: {
        streaming: true,
        interrupt: true,
        approvals: false,
        session_sync: true,
        remote_access: false,
      },
      gateway_url: config.openclaw.gatewayUrl,
      session_key: config.openclaw.sessionKey,
    };
  }

  if (config.runtimeType === 'hermes') {
    return {
      schema_version: '2026-03-29',
      runtime: 'hermes',
      transport: 'http-sse',
      protocol: 'hermes-api-server',
      features: {
        streaming: true,
        interrupt: false,
        approvals: false,
        session_sync: true,
        remote_access: false,
      },
      base_url: config.hermes.baseUrl || undefined,
      conversation_prefix: config.hermes.conversationPrefix,
    };
  }

  return {
    schema_version: '2026-03-29',
    runtime: 'codex',
    transport: 'queue-poll',
    protocol: 'codex-app-server',
    features: {
      streaming: true,
      interrupt: true,
      approvals: true,
      session_sync: true,
      remote_access: false,
    },
    cwd: config.codex.cwd,
    model: config.codex.model,
  };
}

function withRuntimeHealth(
  capabilities: RuntimeCapabilities,
  runtimeHealth?: RuntimeHealth | null,
): RuntimeCapabilities {
  if (!runtimeHealth) {
    return capabilities;
  }

  return {
    ...capabilities,
    runtime_health: runtimeHealth,
  };
}

export class SignedApiClient {
  constructor(private readonly config: ConnectorConfig) {}

  registerConnection(
    runtimeVersion: string | null,
    capabilities: RuntimeCapabilities = buildCapabilities(this.config),
    runtimeHealth?: RuntimeHealth | null,
  ): Promise<RuntimeConnectionRecord> {
    return this.postJson<{ connection: RuntimeConnectionRecord }>('console-register-connection', {
      device_id: this.config.deviceId,
      device_name: this.config.deviceName,
      runtime_type: this.config.runtimeType,
      capabilities: withRuntimeHealth(capabilities, runtimeHealth),
      runtime_version: runtimeVersion,
      adapter_version: this.config.adapterVersion,
    }).then((response) => response.connection);
  }

  heartbeat(
    connectionId: string,
    status: string,
    runtimeVersion: string | null,
    capabilities: RuntimeCapabilities = buildCapabilities(this.config),
    runtimeHealth?: RuntimeHealth | null,
  ): Promise<{
    ok: true;
    connection_id: string;
    status: string;
  }> {
    return this.postJson('console-heartbeat', {
      connection_id: connectionId,
      device_name: this.config.deviceName,
      status,
      capabilities: withRuntimeHealth(capabilities, runtimeHealth),
      runtime_version: runtimeVersion,
      adapter_version: this.config.adapterVersion,
    });
  }

  pullTurn(connectionId: string): Promise<{ ok: true } & PulledTurnPayload> {
    return this.postJson<{ ok: true } & PulledTurnPayload>('console-pull', { connection_id: connectionId });
  }

  listLocalProfileProjections(
    agentId: string,
    filters: {
      runtime_type?: string;
      connection_id?: string;
      local_profile_key?: string;
    } = {},
  ): Promise<{ projections: LocalProfileProjection[] }> {
    const search = new URLSearchParams();
    if (filters.runtime_type) search.set('runtime_type', filters.runtime_type);
    if (filters.connection_id) search.set('connection_id', filters.connection_id);
    if (filters.local_profile_key) search.set('local_profile_key', filters.local_profile_key);
    const suffix = search.toString() ? `?${search.toString()}` : '';
    return this.controlPlaneJson<{ projections: LocalProfileProjection[] }>(
      `/agents/${encodeURIComponent(agentId)}/projections${suffix}`,
      { method: 'GET' },
    );
  }

  bindLocalProfileProjection(
    agentId: string,
    input: BindLocalProfileProjectionInput,
  ): Promise<{ projection: LocalProfileProjection }> {
    return this.controlPlaneJson<{ projection: LocalProfileProjection }>(
      `/agents/${encodeURIComponent(agentId)}/projections`,
      { method: 'POST', body: input },
    );
  }

  pullLocalProfileProjection(projectionId: string): Promise<PullLocalProfileProjectionResult> {
    return this.controlPlaneJson<PullLocalProfileProjectionResult>(
      `/projections/${encodeURIComponent(projectionId)}/sync/pull`,
      { method: 'POST', body: { trigger_kind: 'manual' } },
    );
  }

  ackLocalProfileProjectionSync(
    projectionId: string,
    syncId: string,
    profileHash: string,
  ): Promise<AckLocalProfileProjectionSyncResult> {
    return this.controlPlaneJson<AckLocalProfileProjectionSyncResult>(
      `/projections/${encodeURIComponent(projectionId)}/sync/${encodeURIComponent(syncId)}/ack`,
      { method: 'POST', body: { profile_hash: profileHash } },
    );
  }

  submitLocalProfileMemoryProposals(
    projectionId: string,
    input: SubmitLocalProfileMemoryProposalsInput,
  ): Promise<SubmitLocalProfileMemoryProposalsResult> {
    return this.controlPlaneJson<SubmitLocalProfileMemoryProposalsResult>(
      `/projections/${encodeURIComponent(projectionId)}/memory-proposals`,
      { method: 'POST', body: input },
    );
  }

  prepareRuntimeHandoff(input: RuntimeHandoffInput): Promise<RuntimeHandoffResult> {
    return this.controlPlaneJson<RuntimeHandoffResult>(
      '/handoff',
      { method: 'POST', body: input },
    );
  }

  forkMemoryBranch(
    agentId: string,
    sourceMemoryBranchId: string,
    input: ForkMemoryBranchInput,
  ): Promise<ForkMemoryBranchResult> {
    return this.controlPlaneJson<ForkMemoryBranchResult>(
      `/agents/${encodeURIComponent(agentId)}/memory-branches/${encodeURIComponent(sourceMemoryBranchId)}/fork`,
      { method: 'POST', body: input },
    );
  }

  listMemoryBranches(
    agentId: string,
    filters: {
      projection_id?: string | null;
    } = {},
  ): Promise<ListMemoryBranchesResult> {
    const search = new URLSearchParams();
    if (filters.projection_id) search.set('projection_id', filters.projection_id);
    const suffix = search.toString() ? `?${search.toString()}` : '';
    return this.controlPlaneJson<ListMemoryBranchesResult>(
      `/agents/${encodeURIComponent(agentId)}/memory-branches${suffix}`,
      { method: 'GET' },
    );
  }

  async push(params: {
    connectionId: string;
    turnId: string;
    state?: string;
    runtimeThreadId?: string;
    runtimeTurnId?: string;
    leaseToken?: string | null;
    runtimeAttempt?: number | null;
    threadTitle?: string;
    errorMessage?: string;
    events?: ConsolePushEvent[];
  }): Promise<{
    ok: true;
    interrupt_requested: boolean;
    state: string;
  }> {
    const body = {
      connection_id: params.connectionId,
      turn_id: params.turnId,
      state: params.state,
      runtime_thread_id: params.runtimeThreadId,
      runtime_turn_id: params.runtimeTurnId,
      lease_token: params.leaseToken ?? undefined,
      runtime_attempt: typeof params.runtimeAttempt === 'number' ? params.runtimeAttempt : undefined,
      thread_title: params.threadTitle,
      error_message: params.errorMessage,
      events: params.events ?? [],
    };

    let delayMs = 500;
    let attempts = 0;
    const startedAt = Date.now();
    const maxAttempts = 8;
    const maxRetryMs = 20_000;

    while (true) {
      try {
        return await this.postJson('console-push', body);
      } catch (error) {
        attempts += 1;
        if (!isRetryablePushError(error)) {
          throw error;
        }

        const elapsedMs = Date.now() - startedAt;
        if (attempts >= maxAttempts || elapsedMs >= maxRetryMs) {
          const apiError = error as ApiError;
          apiError.message =
            `${apiError.message} (console-push retry budget exhausted after ${attempts} attempts / ${elapsedMs}ms)`;
          throw apiError;
        }

        await sleep(delayMs);
        delayMs = Math.min(delayMs * 2, 5000);
      }
    }
  }

  createApproval(params: {
    actionType: 'external_api' | 'high_cost_tools' | 'pkm_write';
    previewHtml: string;
    expiresAt?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<{
    ok: true;
    approval_id: string;
  }> {
    return this.postJson('agent-approval', {
      action_type: params.actionType,
      preview_html: params.previewHtml,
      expires_at: params.expiresAt ?? undefined,
      metadata: params.metadata ?? {},
    });
  }

  getApprovalStatus(approvalId: string): Promise<{ ok: true } & PendingApprovalStatus> {
    return this.postJson<{ ok: true } & PendingApprovalStatus>('console-approval-status', {
      approval_id: approvalId,
    });
  }

  fetchPlaybook(params: {
    expertProfileId: string;
    playbookId?: string;
  }): Promise<PlaybookRuntimeEnvelope> {
    return this.postJson<PlaybookRuntimeEnvelope>(PLAYBOOK_RUNTIME_FUNCTION, {
      action: 'fetch_playbook',
      expert_profile_id: params.expertProfileId,
      playbook_id: params.playbookId,
      runtime_type: this.config.runtimeType,
    });
  }

  spawnExpert(params: SpawnExpertRequest): Promise<PlaybookRuntimeEnvelope> {
    return this.postJson<PlaybookRuntimeEnvelope>(PLAYBOOK_RUNTIME_FUNCTION, {
      action: 'spawn_expert',
      expert_profile_id: params.expertProfileId,
      playbook_id: params.playbookId,
      playbook_version_id: params.playbookVersionId,
      runtime_session_key: params.runtimeSessionKey,
      run_spec_id: params.runSpecId,
      task_id: params.taskId,
      payload: params.payload ?? {},
      runtime_type: this.config.runtimeType,
    });
  }

  requestPlaybookPermission(params: PlaybookPermissionRequest): Promise<PlaybookRuntimeEnvelope> {
    return this.postJson<PlaybookRuntimeEnvelope>(PLAYBOOK_RUNTIME_FUNCTION, {
      action: 'request_permission',
      expert_profile_id: params.expertProfileId,
      playbook_id: params.playbookId,
      playbook_version_id: params.playbookVersionId,
      runtime_session_id: params.runtimeSessionId,
      action_category: params.actionCategory,
      boundary: params.boundary,
      resource_id: params.resourceId,
      environment: params.environment,
      title: params.title,
      description: params.description,
      preview_html: params.previewHtml,
      runtime_type: this.config.runtimeType,
    });
  }

  submitPlaybookEvent(params: PlaybookRuntimeEventRequest): Promise<PlaybookRuntimeEnvelope> {
    return this.postJson<PlaybookRuntimeEnvelope>(PLAYBOOK_RUNTIME_FUNCTION, {
      action: 'submit_event',
      expert_profile_id: params.expertProfileId,
      playbook_id: params.playbookId,
      playbook_version_id: params.playbookVersionId,
      runtime_session_id: params.runtimeSessionId,
      event_type: params.eventType,
      summary: params.summary,
      run_spec_id: params.runSpecId,
      task_id: params.taskId,
      payload: params.payload ?? {},
      runtime_type: this.config.runtimeType,
    });
  }

  proposePlaybookMemory(params: PlaybookMemoryProposalRequest): Promise<PlaybookRuntimeEnvelope> {
    return this.postJson<PlaybookRuntimeEnvelope>(PLAYBOOK_RUNTIME_FUNCTION, {
      action: 'propose_memory',
      expert_profile_id: params.expertProfileId,
      playbook_id: params.playbookId,
      playbook_version_id: params.playbookVersionId,
      runtime_session_id: params.runtimeSessionId,
      memory_branch_id: params.memoryBranchId,
      target_type: params.targetType,
      proposed_content: params.proposedContent,
      source_excerpt: params.sourceExcerpt,
      runtime_type: this.config.runtimeType,
    });
  }

  private async postJson<TResponse>(
    functionName: string,
    body: Record<string, unknown>,
  ): Promise<TResponse> {
    return this.requestJson<TResponse>(
      `${this.config.supabaseUrl}/functions/v1/${functionName}`,
      functionName,
      'POST',
      body,
    );
  }

  private async controlPlaneJson<TResponse>(
    path: string,
    options: { method: 'GET' | 'POST' | 'PATCH'; body?: object },
  ): Promise<TResponse> {
    return this.requestJson<TResponse>(
      `${this.config.supabaseUrl}/functions/v1/agent-control-plane${path}`,
      `agent-control-plane${path}`,
      options.method,
      options.body,
    );
  }

  private async requestJson<TResponse>(
    url: string,
    requestName: string,
    method: 'GET' | 'POST' | 'PATCH',
    body?: object,
  ): Promise<TResponse> {
    const bodyText = body ? JSON.stringify(body) : '';
    await this.refreshOAuthTokenIfNeeded(false);
    let response = await this.fetchWithAuth(url, method, bodyText, Boolean(body));

    if (response.status === 401 && this.config.oauthAccessToken && this.config.oauthRefreshToken) {
      const refreshed = await this.refreshOAuthTokenIfNeeded(true);
      if (refreshed) {
        response = await this.fetchWithAuth(url, method, bodyText, Boolean(body));
      }
    }

    const rawText = await response.text();
    let parsed: Record<string, unknown> = {};
    if (rawText) {
      try {
        parsed = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    }

    if (!response.ok) {
      const parsedError =
        parsed.error && typeof parsed.error === 'object'
          ? (parsed.error as { message?: string })
          : null;
      const error = new Error(
        parsedError?.message || `Signed API request failed: ${requestName} (${response.status})`,
      ) as ApiError;
      error.status = response.status;
      error.rawBody = rawText;
      throw error;
    }

    return parsed as TResponse;
  }

  private async fetchWithAuth(
    url: string,
    method: 'GET' | 'POST' | 'PATCH',
    bodyText: string,
    hasBody: boolean,
  ): Promise<Response> {
    const headers: Record<string, string> = {
    };
    if (hasBody) headers['Content-Type'] = 'application/json';

    if (this.config.oauthAccessToken) {
      headers.Authorization = `Bearer ${this.config.oauthAccessToken}`;
    } else {
      if (!this.config.tokenId || !this.config.hmacSecret) {
        throw new Error('Connector is missing SIXDUCK_TOKEN_ID / SIXDUCK_HMAC_SECRET credentials. Legacy DUCK_* aliases are still accepted.');
      }
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = createHmac('sha256', Buffer.from(this.config.hmacSecret, 'hex'))
        .update(`${timestamp}.${bodyText}`)
        .digest('hex');
      headers['x-token-id'] = this.config.tokenId;
      headers['x-agent-signature'] = `t=${timestamp},v1=${signature}`;
    }

    return fetch(url, {
      method,
      headers,
      ...(hasBody ? { body: bodyText } : {}),
    });
  }

  private shouldRefreshOAuthToken(force: boolean): boolean {
    if (!this.config.oauthAccessToken) return false;
    if (!this.config.oauthRefreshToken || !this.config.oauthClientId || !this.config.oauthTokenEndpoint) {
      return false;
    }
    if (force) return true;
    if (!this.config.oauthExpiresAt) return false;

    const expiresAtMs = Date.parse(this.config.oauthExpiresAt);
    if (!Number.isFinite(expiresAtMs)) {
      return false;
    }
    return expiresAtMs <= Date.now() + OAUTH_REFRESH_SKEW_MS;
  }

  private async refreshOAuthTokenIfNeeded(force: boolean): Promise<boolean> {
    if (!this.shouldRefreshOAuthToken(force)) {
      return false;
    }

    const response = await fetch(this.config.oauthTokenEndpoint as string, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: this.config.oauthClientId as string,
        refresh_token: this.config.oauthRefreshToken as string,
      }).toString(),
    });
    const rawText = await response.text();
    let parsed: Record<string, unknown> = {};
    if (rawText) {
      try {
        parsed = JSON.parse(rawText) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    }

    if (!response.ok || typeof parsed.access_token !== 'string') {
      const parsedError =
        parsed.error && typeof parsed.error === 'object'
          ? (parsed.error as { message?: string })
          : null;
      const message =
        parsedError?.message
        || (typeof parsed.error_description === 'string' ? parsed.error_description : null)
        || `OAuth refresh failed (${response.status})`;
      const error = new Error(message) as ApiError;
      error.status = response.status;
      error.rawBody = rawText;
      throw error;
    }

    this.config.oauthAccessToken = parsed.access_token;
    if (typeof parsed.refresh_token === 'string') {
      this.config.oauthRefreshToken = parsed.refresh_token;
    }
    if (typeof parsed.scope === 'string') {
      this.config.oauthScope = parsed.scope;
    }
    if (typeof parsed.expires_in === 'number' && Number.isFinite(parsed.expires_in)) {
      this.config.oauthExpiresAt = new Date(Date.now() + parsed.expires_in * 1000).toISOString();
    }

    if (this.config.oauthSessionPath && this.config.oauthClientId) {
      writeOAuthSession({
        client_id: this.config.oauthClientId,
        access_token: this.config.oauthAccessToken,
        refresh_token: this.config.oauthRefreshToken ?? undefined,
        expires_at: this.config.oauthExpiresAt ?? undefined,
        scope: this.config.oauthScope ?? undefined,
        token_endpoint: this.config.oauthTokenEndpoint ?? undefined,
        resource: this.config.oauthResource ?? undefined,
        runtime_type: this.config.oauthRuntimeType ?? undefined,
        token_id: this.config.oauthTokenId ?? undefined,
        agent_id: this.config.oauthAgentId ?? undefined,
      }, this.config.oauthSessionPath);
    }

    return true;
  }
}
