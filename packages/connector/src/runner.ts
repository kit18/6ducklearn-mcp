import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { SignedApiClient } from './signedApiClient.js';
import { loadConfig } from './config.js';
import { CodexAppServerClient } from './codexAppServerClient.js';
import { HermesApiServerClient } from './hermesApiServerClient.js';
import { OpenClawGatewayClient } from './openclawGatewayClient.js';
import type {
  ApprovalResolution,
  ConsolePushEvent,
  ProjectedSkillModule,
  PulledTurnPayload,
  RuntimeAdapter,
  RuntimeApprovalRequest,
  RuntimeApprovalRule,
  RuntimeApprovalRules,
  RuntimeInputItem,
  RuntimeSandboxPolicy,
  SessionAttachment,
} from './types.js';

type RuntimePolicyToken = {
  approval_level?: string | null;
  data_boundaries?: Record<string, unknown> | null;
} | null | undefined;

type RuntimePolicy = {
  approvalRules: {
    external_api: RuntimeApprovalRule;
    pkm_write: RuntimeApprovalRule;
  };
  threadSandbox: RuntimeSandboxPolicy;
  turnSandboxPolicy: RuntimeSandboxPolicy;
};

type WaitForApprovalParams = {
  api: SignedApiClient;
  connectionId: string;
  turnId: string;
  runtimeThreadId: string;
  runtimeTurnId?: string;
  request: RuntimeApprovalRequest;
};

type ProcessTurnParams = {
  api: SignedApiClient;
  runtime: RuntimeAdapter;
  connectionId: string;
  runtimeVersion: string | null;
  payload: { connection: { runtime_type: string } } & PulledTurnPayload;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const transientConnectorNetworkCodes = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

function findNetworkErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object') {
    return null;
  }

  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && code !== '') {
    return code;
  }

  return findNetworkErrorCode((error as { cause?: unknown }).cause);
}

export function isTransientConnectorNetworkError(error: unknown): boolean {
  const code = findNetworkErrorCode(error);
  if (code && transientConnectorNetworkCodes.has(code)) {
    return true;
  }

  return error instanceof TypeError && /fetch failed/i.test(error.message);
}

function describeTransientConnectorNetworkError(error: unknown): string {
  const code = findNetworkErrorCode(error);
  if (code) {
    return code;
  }

  return error instanceof Error && error.message ? error.message : 'network request failed';
}

function turnStateLabel(status: string): string {
  switch (status) {
    case 'streaming':
      return 'Streaming from local runtime';
    case 'completed':
      return 'Completed on local runtime';
    case 'interrupted':
      return 'Interrupted on local runtime';
    case 'failed':
      return 'Runtime turn failed';
    default:
      return status;
  }
}

function sanitizePathSegment(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'attachment';
}

function sanitizeSkillReferenceName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'skill';
}

function quoteYamlDouble(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function normalizeSkillDescription(params: {
  description?: string | null;
  fallbackLabel: string;
  fallbackKind: 'skill attachment' | 'skill module';
}) {
  const description = typeof params.description === 'string' ? params.description.trim() : '';
  if (description !== '') {
    return description.replace(/\s+/g, ' ');
  }

  return `${params.fallbackLabel} ${params.fallbackKind}.`.replace(/\s+/g, ' ');
}

function hasSkillFrontmatter(content: string) {
  const frontmatterMatch = content.trimStart().match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!frontmatterMatch) {
    return false;
  }

  return /(^|\n)name:\s*/.test(frontmatterMatch[1]) && /(^|\n)description:\s*/.test(frontmatterMatch[1]);
}

function buildCodexSkillFileContent(params: {
  skillReferenceName: string;
  description: string;
  body: string;
}) {
  const body = params.body.trim();
  if (body === '') {
    return `---\nname: "${quoteYamlDouble(params.skillReferenceName)}"\ndescription: "${quoteYamlDouble(params.description)}"\n---\n`;
  }

  if (hasSkillFrontmatter(body)) {
    return `${body.trimEnd()}\n`;
  }

  return [
    '---',
    `name: "${quoteYamlDouble(params.skillReferenceName)}"`,
    `description: "${quoteYamlDouble(params.description)}"`,
    '---',
    '',
    body,
    '',
  ].join('\n');
}

function formatAttachmentLine(attachment: SessionAttachment) {
  const description =
    typeof attachment.description === 'string' && attachment.description.trim() !== ''
      ? attachment.description.trim()
      : null;

  return description ? `- ${attachment.label}: ${description}` : `- ${attachment.label}`;
}

function buildAttachmentSummary(attachments: SessionAttachment[] | undefined) {
  const enabledAttachments = (attachments ?? []).filter((attachment) => attachment.enabled !== false);
  if (enabledAttachments.length === 0) {
    return '';
  }

  const skills = enabledAttachments.filter((attachment) => attachment.kind === 'skill');
  const servers = enabledAttachments.filter((attachment) => attachment.kind === 'mcp_server');
  const tools = enabledAttachments.filter((attachment) => attachment.kind === 'mcp_tool');
  const sections: string[] = [];

  if (skills.length > 0) {
    sections.push(['Skills:', ...skills.map(formatAttachmentLine)].join('\n'));
  }

  if (servers.length > 0) {
    sections.push(['MCP Servers:', ...servers.map(formatAttachmentLine)].join('\n'));
  }

  if (tools.length > 0) {
    sections.push(['MCP Tools:', ...tools.map(formatAttachmentLine)].join('\n'));
  }

  return sections.join('\n\n');
}

function buildCodexTurnText(params: {
  inputText: string;
  attachments?: SessionAttachment[];
  skillInvocationNames: string[];
}) {
  const sections: string[] = [];

  if (params.skillInvocationNames.length > 0) {
    sections.push([
      'Attached skills available for this turn:',
      ...params.skillInvocationNames.map((skillName) => `$${skillName}`),
    ].join('\n'));
  }

  const attachmentSummary = buildAttachmentSummary(params.attachments);
  if (attachmentSummary) {
    sections.push(`Enabled 6DuckLearn session attachments:\n${attachmentSummary}`);
  }

  sections.push(params.inputText);
  return sections.join('\n\n');
}

function formatProjectedSkillLine(skillModule: ProjectedSkillModule) {
  const details = [
    `- $${skillModule.name} (${skillModule.label})`,
    skillModule.description,
  ]
    .filter((value) => typeof value === 'string' && value.trim() !== '')
    .join(': ');
  const content = skillModule.content.trim();

  return content ? `${details}\n${content}` : details;
}

function buildProjectedSkillSummary(skillModules: ProjectedSkillModule[] | undefined) {
  const enabledModules = (skillModules ?? []).filter((skillModule) => skillModule.name.trim() !== '');
  if (enabledModules.length === 0) {
    return '';
  }

  return [
    'Projected 6DuckLearn skill modules:',
    ...enabledModules.map(formatProjectedSkillLine),
  ].join('\n\n');
}

function buildPortableTurnText(params: {
  inputText: string;
  attachments?: SessionAttachment[];
  projectedSkillModules?: ProjectedSkillModule[];
}) {
  const sections: string[] = [];
  const attachmentSummary = buildAttachmentSummary(params.attachments);
  if (attachmentSummary) {
    sections.push(`Enabled 6DuckLearn session attachments:\n${attachmentSummary}`);
  }

  const skillSummary = buildProjectedSkillSummary(params.projectedSkillModules);
  if (skillSummary) {
    sections.push(skillSummary);
  }

  sections.push(params.inputText);
  return sections.join('\n\n');
}

type CodexSkillMaterializationInput = {
  id: string;
  label: string;
  description?: string | null;
  skillName?: string | null;
  content: string;
  fallbackKind: 'skill attachment' | 'skill module';
};

function allocateSkillReferenceName(baseName: string, usedNames: Set<string>) {
  if (!usedNames.has(baseName)) {
    usedNames.add(baseName);
    return baseName;
  }

  let suffix = 2;
  while (usedNames.has(`${baseName}-${suffix}`)) {
    suffix += 1;
  }

  const allocated = `${baseName}-${suffix}`;
  usedNames.add(allocated);
  return allocated;
}

function materializeCodexSkills(connectionId: string, skills: CodexSkillMaterializationInput[]): {
  inputItems: RuntimeInputItem[];
  skillInvocationNames: string[];
} {
  if (skills.length === 0) {
    return { inputItems: [], skillInvocationNames: [] };
  }

  const baseDir = join(homedir(), '.6ducklearn', 'connector', 'runtime-skills', sanitizePathSegment(connectionId));
  mkdirSync(baseDir, { recursive: true });

  const inputItems: RuntimeInputItem[] = [];
  const skillInvocationNames: string[] = [];
  const usedNames = new Set<string>();

  for (const skill of skills) {
    const rawSkillName =
      typeof skill.skillName === 'string' && skill.skillName.trim() !== ''
        ? skill.skillName.trim()
        : skill.label.trim();
    const baseSkillReferenceName = sanitizeSkillReferenceName(rawSkillName);
    const skillReferenceName = allocateSkillReferenceName(baseSkillReferenceName, usedNames);
    const skillDir = join(baseDir, sanitizePathSegment(`${skill.id}-${skillReferenceName}`));
    const skillPath = join(skillDir, 'SKILL.md');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillPath, buildCodexSkillFileContent({
      skillReferenceName,
      description: normalizeSkillDescription({
        description: skill.description,
        fallbackLabel: skill.label,
        fallbackKind: skill.fallbackKind,
      }),
      body: skill.content,
    }), 'utf8');

    inputItems.push({
      type: 'skill',
      name: skillReferenceName,
      path: skillPath,
    });
    skillInvocationNames.push(skillReferenceName);
  }

  return { inputItems, skillInvocationNames };
}

export function buildRuntimeInputItems(params: {
  runtimeType: string;
  connectionId: string;
  inputText: string;
  attachments?: SessionAttachment[];
  projectedSkillModules?: ProjectedSkillModule[];
}): RuntimeInputItem[] | undefined {
  if (params.runtimeType !== 'codex') {
    return [{
      type: 'text',
      text: buildPortableTurnText({
        inputText: params.inputText,
        attachments: params.attachments,
        projectedSkillModules: params.projectedSkillModules,
      }),
    }];
  }

  const attachmentSkills = (params.attachments ?? []).flatMap((attachment) => {
    if (
      attachment.kind !== 'skill' ||
      attachment.enabled === false ||
      typeof attachment.content !== 'string' ||
      attachment.content.trim() === '' ||
      (
        (typeof attachment.skill_name !== 'string' || attachment.skill_name.trim() === '') &&
        attachment.label.trim() === ''
      )
    ) {
      return [];
    }

    return [{
      id: attachment.id,
      label: attachment.label,
      description: attachment.description,
      skillName: attachment.skill_name,
      content: attachment.content,
      fallbackKind: 'skill attachment' as const,
    }];
  });

  const projectedSkills = (params.projectedSkillModules ?? []).flatMap((skillModule) => {
    if (skillModule.content.trim() === '' || skillModule.name.trim() === '') {
      return [];
    }

    return [{
      id: skillModule.id,
      label: skillModule.label,
      description: skillModule.description,
      skillName: skillModule.name,
      content: skillModule.content,
      fallbackKind: 'skill module' as const,
    }];
  });

  const materializedSkills = materializeCodexSkills(
    params.connectionId,
    [...attachmentSkills, ...projectedSkills],
  );
  const inputItems: RuntimeInputItem[] = [{
    type: 'text',
    text: buildCodexTurnText({
      inputText: params.inputText,
      attachments: params.attachments,
      skillInvocationNames: materializedSkills.skillInvocationNames,
    }),
  }];
  inputItems.push(...materializedSkills.inputItems);
  return inputItems;
}

const DEFAULT_APPROVAL_RULES: RuntimePolicy['approvalRules'] = {
  external_api: 'require_approval',
  pkm_write: 'require_approval',
};

function isApprovalRule(value: unknown): value is RuntimeApprovalRule {
  return value === 'auto' || value === 'require_approval' || value === 'deny';
}

function resolveApprovalRule(entry: unknown, fallback: RuntimeApprovalRule): RuntimeApprovalRule {
  if (isApprovalRule(entry)) {
    return entry;
  }

  if (entry && typeof entry === 'object') {
    const maybeEntry = entry as { user_setting?: unknown; default?: unknown };
    if (isApprovalRule(maybeEntry.user_setting)) {
      return maybeEntry.user_setting;
    }
    if (isApprovalRule(maybeEntry.default)) {
      return maybeEntry.default;
    }
  }

  return fallback;
}

export function resolveCodexRuntimePolicy(token: RuntimePolicyToken): RuntimePolicy {
  const approvalRules = { ...DEFAULT_APPROVAL_RULES };
  const storedBoundaries =
    token?.data_boundaries && typeof token.data_boundaries === 'object' ? token.data_boundaries : {};

  approvalRules.external_api = resolveApprovalRule(storedBoundaries.external_api, DEFAULT_APPROVAL_RULES.external_api);
  approvalRules.pkm_write = resolveApprovalRule(storedBoundaries.pkm_write, DEFAULT_APPROVAL_RULES.pkm_write);

  if ((token?.approval_level ?? 'approve-risky') === 'trust-all') {
    approvalRules.external_api = 'auto';
    approvalRules.pkm_write = 'auto';
  } else if ((token?.approval_level ?? 'approve-risky') === 'approve-all') {
    approvalRules.external_api = 'require_approval';
    approvalRules.pkm_write = 'require_approval';
  }

  return {
    approvalRules,
    threadSandbox: approvalRules.pkm_write === 'auto' ? 'workspace-write' : { 'read-only': null },
    turnSandboxPolicy:
      approvalRules.pkm_write === 'auto'
        ? 'workspace-write'
        : { type: 'readOnly', access: { type: 'fullAccess' }, networkAccess: false },
  };
}

function createRuntimeAdapter(config = loadConfig()): RuntimeAdapter {
  if (config.runtimeType === 'openclaw') {
    return new OpenClawGatewayClient(config);
  }
  if (config.runtimeType === 'hermes') {
    return new HermesApiServerClient(config);
  }
  return new CodexAppServerClient(config);
}

async function waitForApproval(params: WaitForApprovalParams): Promise<ApprovalResolution> {
  const { api, connectionId, turnId, runtimeThreadId, runtimeTurnId, request } = params;
  const created = await api.createApproval({
    actionType: request.actionType,
    previewHtml: request.previewHtml,
    expiresAt: request.expiresAt ?? null,
    metadata: request.metadata,
  });

  await api.push({
    connectionId,
    turnId,
    runtimeThreadId,
    runtimeTurnId,
    events: [
      {
        event_type: 'approval.requested',
        payload: {
          approval_id: created.approval_id,
          action_type: request.actionType,
          request_method: request.requestMethod,
          label: request.requestMethod,
        },
      },
    ],
  });

  while (true) {
    const status = await api.getApprovalStatus(created.approval_id);
    if (status.status === 'approved') {
      await api.push({
        connectionId,
        turnId,
        runtimeThreadId,
        runtimeTurnId,
        events: [
          {
            event_type: 'approval.resolved',
            payload: {
              approval_id: created.approval_id,
              status: 'approved',
            },
          },
        ],
      });
      return {
        decision: 'approve',
        modifiedInstruction: status.modified_instruction,
      };
    }

    if (status.status === 'rejected') {
      await api.push({
        connectionId,
        turnId,
        runtimeThreadId,
        runtimeTurnId,
        events: [
          {
            event_type: 'approval.resolved',
            payload: {
              approval_id: created.approval_id,
              status: 'rejected',
            },
          },
        ],
      });
      return { decision: 'reject', modifiedInstruction: status.modified_instruction };
    }

    if (status.status === 'expired') {
      await api.push({
        connectionId,
        turnId,
        runtimeThreadId,
        runtimeTurnId,
        events: [
          {
            event_type: 'approval.resolved',
            payload: {
              approval_id: created.approval_id,
              status: 'expired',
            },
          },
        ],
      });
      return { decision: 'expired' };
    }

    const heartbeat = await api.push({
      connectionId,
      turnId,
      runtimeThreadId,
      runtimeTurnId,
      state: 'claimed',
      events: [],
    });

    if (heartbeat.interrupt_requested) {
      await api.push({
        connectionId,
        turnId,
        runtimeThreadId,
        runtimeTurnId,
        events: [
          {
            event_type: 'approval.resolved',
            payload: {
              approval_id: created.approval_id,
              status: 'cancelled',
            },
          },
        ],
      });
      return { decision: 'cancel' };
    }

    await sleep(1500);
  }
}

export async function runConnector(): Promise<void> {
  const config = loadConfig();
  const api = new SignedApiClient(config);
  const runtime = createRuntimeAdapter(config);

  console.log(`[6ducklearn-connector] starting ${config.runtimeType} connector for ${config.deviceName}`);
  await runtime.start();

  const runtimeVersion = await runtime.detectRuntimeVersion();
  if (runtime instanceof CodexAppServerClient) {
    runtime.ensureSupportedVersion(runtimeVersion);
  }

  const connection = await api.registerConnection(runtimeVersion);
  console.log(`[6ducklearn-connector] connection registered: ${connection.id}`);

  let shuttingDown = false;
  const heartbeatTimer = setInterval(() => {
    void api
      .heartbeat(connection.id, 'online', runtimeVersion)
      .catch((error) => console.warn('[6ducklearn-connector] heartbeat failed:', error));
  }, config.heartbeatIntervalMs);

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    clearInterval(heartbeatTimer);
    try {
      await api.heartbeat(connection.id, 'offline', runtimeVersion);
    } catch {
      // Best effort only.
    }
    await runtime.stop();
  };

  process.once('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });

  while (!shuttingDown) {
    try {
      const payload = await api.pullTurn(connection.id);
      if (!payload.turn || !payload.thread) {
        await sleep(config.pollIntervalMs);
        continue;
      }

      console.log(`[6ducklearn-connector] processing turn ${payload.turn.id}`);
      await processTurn({
        api,
        runtime,
        connectionId: connection.id,
        runtimeVersion,
        payload,
      });
    } catch (error) {
      if (isTransientConnectorNetworkError(error)) {
        const retryDelayMs = Math.max(config.pollIntervalMs, 5000);
        console.warn(
          `[6ducklearn-connector] temporary network issue (${describeTransientConnectorNetworkError(error)}); retrying in ${Math.round(retryDelayMs / 1000)}s`,
        );
        await sleep(retryDelayMs);
        continue;
      }

      console.error('[6ducklearn-connector] loop error:', error);
      await api.heartbeat(connection.id, 'error', runtimeVersion).catch(() => undefined);
      await sleep(Math.max(config.pollIntervalMs, 5000));
    }
  }
}

async function processTurn(params: ProcessTurnParams): Promise<void> {
  const { api, runtime, connectionId, payload } = params;
  if (!payload.turn || !payload.thread) {
    return;
  }

  const turn = payload.turn;
  const thread = payload.thread;
  const runtimePolicy = resolveCodexRuntimePolicy(payload.token);
  const projectionMetadata = payload.projection?.metadata ?? payload.run?.projection_context ?? null;
  const sessionAttachments = payload.projection?.registry.default_session_attachments ?? [];
  const projectionInstructions = payload.projection?.instructions ?? null;
  const combinedSystemPrompt = projectionInstructions?.system_prompt ?? payload.token?.system_prompt ?? null;
  const runtimeThreadId = await runtime.ensureThread({
    runtimeThreadId: thread.runtime_thread_id,
    systemPrompt: combinedSystemPrompt,
    baseInstructions: projectionInstructions?.base_instructions ?? null,
    developerInstructions: projectionInstructions
      ? projectionInstructions.developer_instructions
      : payload.token?.system_prompt ?? null,
    sandbox: runtimePolicy.threadSandbox,
    metadata: {
      ...(thread.metadata ?? {}),
      browser_thread_id: thread.id,
      runtime_type: payload.connection.runtime_type,
      projection_context: projectionMetadata,
      session_attachments: sessionAttachments,
    },
  });

  let runtimeTurnId: string | undefined;
  let interruptIssued = false;
  const queuedEvents: ConsolePushEvent[] = [];
  let pendingState: string | undefined;
  let pendingErrorMessage: string | undefined;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushChain: Promise<void | undefined> = Promise.resolve();

  const flush = (force = false): Promise<void | undefined> => {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    const next = flushChain.then(async () => {
      if (!force && queuedEvents.length === 0 && !pendingState) {
        return;
      }

      const events = queuedEvents.slice();
      const state = pendingState;
      const errorMessage = pendingErrorMessage;
      if (events.length === 0 && !state) {
        return;
      }

      const response = await api.push({
        connectionId,
        turnId: turn.id,
        state,
        runtimeThreadId,
        runtimeTurnId,
        threadTitle: thread.title,
        errorMessage,
        events,
      });

      if (events.length > 0) {
        queuedEvents.splice(0, events.length);
      }
      if (pendingState === state) {
        pendingState = undefined;
      }
      if (pendingErrorMessage === errorMessage) {
        pendingErrorMessage = undefined;
      }
      if (response.interrupt_requested && runtimeTurnId && !interruptIssued) {
        interruptIssued = true;
        await runtime.interruptTurn(runtimeThreadId, runtimeTurnId);
      }
    });

    flushChain = next.catch(() => undefined);
    return next;
  };

  const scheduleFlush = (): void => {
    if (flushTimer) {
      return;
    }
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush().catch((error) => {
        console.error('[6ducklearn-connector] flush error:', error);
      });
    }, 250);
  };

  await api.heartbeat(connectionId, 'online', params.runtimeVersion);
  await api.push({
    connectionId,
    turnId: turn.id,
    runtimeThreadId,
    threadTitle: thread.title,
  });

  await runtime.runTurn({
    threadId: runtimeThreadId,
    inputText: turn.input_text,
    inputItems: buildRuntimeInputItems({
      runtimeType: payload.connection.runtime_type,
      connectionId,
      inputText: turn.input_text,
      attachments: sessionAttachments,
      projectedSkillModules: projectionInstructions?.skill_modules ?? [],
    }),
    sandboxPolicy: runtimePolicy.turnSandboxPolicy,
    approvalRules: runtimePolicy.approvalRules as RuntimeApprovalRules,
    onApprovalRequest: async (request) =>
      waitForApproval({
        api,
        connectionId,
        turnId: turn.id,
        runtimeThreadId,
        runtimeTurnId,
        request,
      }),
    onEvent: async (event) => {
      switch (event.type) {
        case 'turn.started':
          runtimeTurnId = event.runtimeTurnId;
          pendingState = 'streaming';
          queuedEvents.push({
            event_type: 'turn.status',
            payload: {
              state: 'streaming',
              label: turnStateLabel('streaming'),
            },
          });
          await flush(true);
          return;
        case 'assistant.delta':
          queuedEvents.push({
            event_type: 'assistant.delta',
            payload: { text: event.text },
          });
          scheduleFlush();
          return;
        case 'assistant.completed':
          queuedEvents.push({
            event_type: 'assistant.completed',
            payload: { text: event.text },
          });
          scheduleFlush();
          return;
        case 'tool.started':
          queuedEvents.push({
            event_type: 'tool.started',
            payload: {
              tool_type: event.itemType,
              label: event.label,
              detail: event.detail ?? null,
            },
          });
          scheduleFlush();
          return;
        case 'tool.output':
          queuedEvents.push({
            event_type: 'tool.output',
            payload: {
              tool_type: event.itemType,
              text: event.delta,
            },
          });
          scheduleFlush();
          return;
        case 'tool.completed':
          queuedEvents.push({
            event_type: 'tool.completed',
            payload: {
              tool_type: event.itemType,
              label: event.label,
              success: event.success,
            },
          });
          scheduleFlush();
          return;
        case 'approval.requested':
          queuedEvents.push({
            event_type: 'approval.requested',
            payload: {
              approval_id: event.request.approvalId ?? null,
              request_id: event.request.requestId,
              request_method: event.request.requestMethod,
              action_type: event.request.actionType,
              preview_html: event.request.previewHtml,
              ...(event.request.metadata ?? {}),
            },
          });
          await flush(true);
          return;
        case 'approval.resolved':
          queuedEvents.push({
            event_type: 'approval.resolved',
            payload: {
              approval_id: event.approvalId,
              status: event.status,
            },
          });
          await flush(true);
          return;
        case 'runtime.error':
          queuedEvents.push({
            event_type: 'runtime.error',
            payload: { message: event.message },
          });
          await flush(true);
          return;
        case 'turn.completed':
          pendingState = event.status;
          pendingErrorMessage = event.message;
          queuedEvents.push({
            event_type: 'turn.status',
            payload: {
              state: event.status,
              label: turnStateLabel(event.status),
              ...(event.usage ? { usage: event.usage } : {}),
            },
          });
          if (event.message && event.status === 'failed') {
            queuedEvents.push({
              event_type: 'runtime.error',
              payload: { message: event.message },
            });
          }
          await flush(true);
          return;
      }
    },
  });
}
