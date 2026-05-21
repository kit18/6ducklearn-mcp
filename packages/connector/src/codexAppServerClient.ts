import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface, type Interface } from 'node:readline';
import type {
  ApprovalResolution,
  ConnectorConfig,
  RuntimeAdapter,
  RuntimeApprovalRequest,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeInputItem,
  RuntimeUsage,
  RuntimeThreadContext,
} from './types.js';

interface JsonRpcResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: {
    code?: number;
    message?: string;
  };
}

interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcServerRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

type PendingRequest = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

type NotificationHandler = (notification: JsonRpcNotification) => void | Promise<void>;
type ServerRequestHandler = (request: JsonRpcServerRequest) => boolean | Promise<boolean>;
type RuntimeSandboxPolicy = string | Record<string, unknown>;
type RuntimeApprovalRule = 'auto' | 'require_approval' | 'deny';
type RuntimeApprovalRules = Partial<Record<RuntimeApprovalRequest['actionType'], RuntimeApprovalRule>>;
const TOKEN_USAGE_GRACE_MS = 150;

export function buildCodexAppServerArgs(config: ConnectorConfig) {
  const args = ['app-server'];

  if (config.codex.quietProfile) {
    args.push(
      '-c',
      'mcp_servers={}',
      '-c',
      'plugins={}',
      '-c',
      'notify=[]',
    );
  }

  return args;
}

export function isQuietProfileCodexStderrNoise(line: string) {
  return (
    /failed to load skill .* invalid YAML/i.test(line) ||
    /failed to warm featured plugin ids cache/i.test(line) ||
    (
      /rmcp::transport::worker/i.test(line) &&
      /AuthRequired|No access token was provided/i.test(line)
    )
  );
}

function compareVersions(left: string, right: string) {
  const normalize = (value: string) =>
    value
      .replace(/^codex-cli\s+/i, '')
      .split(/[.-]/)
      .map((part) => Number.parseInt(part, 10))
      .filter((part) => Number.isFinite(part));

  const a = normalize(left);
  const b = normalize(right);
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function htmlList(items: string[]) {
  if (items.length === 0) return '';
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readTokenNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.round(value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class CodexAppServerClient implements RuntimeAdapter {
  readonly runtimeType = 'codex' as const;

  private process: ChildProcess | null = null;
  private readline: Interface | null = null;
  private stderrReadline: Interface | null = null;
  private nextRequestId = 1;
  private pendingRequests = new Map<number, PendingRequest>();
  private notificationHandlers = new Set<NotificationHandler>();
  private serverRequestHandlers = new Set<ServerRequestHandler>();
  private latestUsageByThreadId = new Map<string, RuntimeUsage>();

  constructor(private readonly config: ConnectorConfig) {}

  async start() {
    if (this.process) return;

    if (this.config.codex.quietProfile) {
      console.log('[6ducklearn-connector] using quiet Codex bridge profile; local MCP servers and plugins are disabled for this bridge');
    }

    const proc = spawn('codex', buildCodexAppServerArgs(this.config), {
      cwd: this.config.codex.cwd,
      stdio: ['pipe', 'pipe', this.config.codex.quietProfile ? 'pipe' : 'inherit'],
    });
    this.process = proc;

    proc.on('exit', (code, signal) => {
      const error = new Error(`codex app-server exited unexpectedly (${code ?? signal ?? 'unknown'})`);
      for (const pending of this.pendingRequests.values()) {
        pending.reject(error);
      }
      this.pendingRequests.clear();
      this.process = null;
      this.readline = null;
      this.stderrReadline = null;
    });

    const stderr = proc.stderr;
    if (stderr) {
      this.stderrReadline = createInterface({ input: stderr });
      this.stderrReadline.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed || isQuietProfileCodexStderrNoise(trimmed)) return;
        console.error(trimmed);
      });
    }

    const stdout = proc.stdout;
    if (!stdout) {
      throw new Error('codex app-server stdout is not readable');
    }

    this.readline = createInterface({ input: stdout });
    this.readline.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const message = JSON.parse(trimmed) as JsonRpcResponse | JsonRpcNotification | JsonRpcServerRequest;

        if ('method' in message && 'id' in message) {
          for (const handler of this.serverRequestHandlers) {
            Promise.resolve(handler(message))
              .then((handled) => {
                if (!handled) return;
              })
              .catch((error) => {
                console.warn('[6ducklearn-connector] server request handler failed:', error);
                this.replyError(message.id, error instanceof Error ? error.message : 'Server request failed');
              });
          }
          return;
        }

        if ('id' in message) {
          const pending = this.pendingRequests.get(message.id);
          if (!pending) return;
          this.pendingRequests.delete(message.id);

          if (message.error) {
            pending.reject(new Error(message.error.message ?? `JSON-RPC error ${message.error.code ?? ''}`));
            return;
          }

          pending.resolve(message.result ?? {});
          return;
        }

        if ('method' in message) {
          for (const handler of this.notificationHandlers) {
            Promise.resolve(handler(message)).catch((error) => {
              console.warn('[6ducklearn-connector] notification handler failed:', error);
            });
          }
        }
      } catch (error) {
        console.warn('[6ducklearn-connector] failed to parse app-server message:', error);
      }
    });

    await this.request('initialize', {
      clientInfo: {
        name: this.config.serviceName,
        title: '6duck Connector',
        version: this.config.adapterVersion,
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify('initialized', {});
  }

  async stop() {
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }

    if (this.stderrReadline) {
      this.stderrReadline.close();
      this.stderrReadline = null;
    }

    if (this.process) {
      this.process.kill();
      this.process = null;
    }
  }

  async detectRuntimeVersion() {
    const result = await this.request('getAuthStatus', {}).catch(() => null);
    void result;

    try {
      const versionResult = await this.request('client/version', {});
      const version = typeof versionResult.version === 'string' ? versionResult.version : null;
      return version;
    } catch {
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execFileAsync = promisify(execFile);
        const { stdout } = await execFileAsync('codex', ['--version']);
        return stdout.trim() || null;
      } catch {
        return null;
      }
    }
  }

  ensureSupportedVersion(version: string | null) {
    if (!version) {
      throw new Error('Unable to detect Codex CLI version. Install Codex CLI 0.117.0 or newer.');
    }

    if (compareVersions(version, this.config.codex.minVersion) < 0) {
      throw new Error(
        `Codex CLI ${version} is too old. 6ducklearn requires ${this.config.codex.minVersion} or newer.`,
      );
    }
  }

  getCapabilities(): RuntimeCapabilities {
    return {
      schema_version: '2026-03-29',
      runtime: 'codex',
      transport: 'queue-poll',
      protocol: 'codex-app-server',
      structured_context: {
        instructions: true,
        metadata: false,
        input_items: true,
        fallback_mode: 'native',
      },
      features: {
        streaming: true,
        interrupt: true,
        approvals: true,
        session_sync: true,
        remote_access: false,
      },
      cwd: this.config.codex.cwd,
      model: this.config.codex.model,
    };
  }

  async ensureThread(context: RuntimeThreadContext & { sandbox?: RuntimeSandboxPolicy }) {
    const baseInstructions = context.baseInstructions?.trim() || undefined;
    const developerInstructions = context.developerInstructions?.trim() || context.systemPrompt?.trim() || undefined;
    const sandbox = context.sandbox ?? 'workspace-write';

    if (context.runtimeThreadId) {
      const result = await this.request('thread/resume', {
        threadId: context.runtimeThreadId,
        cwd: this.config.codex.cwd,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox,
        baseInstructions,
        developerInstructions,
        persistExtendedHistory: true,
      });

      const thread = result.thread as { id?: string } | undefined;
      if (!thread?.id) {
        throw new Error('thread/resume did not return a thread id');
      }
      return thread.id;
    }

    const result = await this.request('thread/start', {
      model: this.config.codex.model,
      cwd: this.config.codex.cwd,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      sandbox,
      serviceName: this.config.serviceName,
      baseInstructions,
      developerInstructions,
      experimentalRawEvents: false,
      persistExtendedHistory: true,
    });

    const thread = result.thread as { id?: string } | undefined;
    if (!thread?.id) {
      throw new Error('thread/start did not return a thread id');
    }
    return thread.id;
  }

  async interruptTurn(threadId: string, turnId: string) {
    await this.request('turn/interrupt', {
      threadId,
      turnId,
    });
  }

  async runTurn(params: {
    threadId: string;
    inputText: string;
    inputItems?: RuntimeInputItem[];
    onEvent: (event: RuntimeEvent) => Promise<void> | void;
    onApprovalRequest?: (request: RuntimeApprovalRequest) => Promise<ApprovalResolution>;
    sandboxPolicy?: RuntimeSandboxPolicy;
    approvalRules?: RuntimeApprovalRules;
  }) {
    let runtimeTurnId: string | null = null;
    let latestTurnUsage: RuntimeUsage | null = null;
    let settled = false;
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    this.latestUsageByThreadId.delete(params.threadId);
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const removeNotificationHandler = this.onNotification(async (notification) => {
      const notificationThreadId = typeof notification.params?.threadId === 'string'
        ? notification.params.threadId
        : null;
      if (notificationThreadId && notificationThreadId !== params.threadId) return;

      if (notification.method === 'thread/tokenUsage/updated') {
        const usage = this.readCodexTokenUsage(notification.params);
        if (!usage) return;
        latestTurnUsage = usage;
        this.latestUsageByThreadId.set(params.threadId, usage);
        return;
      }

      if (notification.method === 'turn/started') {
        const turn = notification.params?.turn as { id?: string } | undefined;
        if (!turn?.id) return;
        runtimeTurnId = turn.id;
        await params.onEvent({ type: 'turn.started', runtimeTurnId: turn.id });
        return;
      }

      if (notification.method === 'item/agentMessage/delta') {
        const turnId = typeof notification.params?.turnId === 'string' ? notification.params.turnId : null;
        if (runtimeTurnId && turnId !== runtimeTurnId) return;
        const delta = typeof notification.params?.delta === 'string' ? notification.params.delta : '';
        if (!delta) return;
        await params.onEvent({ type: 'assistant.delta', text: delta });
        return;
      }

      if (notification.method === 'item/commandExecution/outputDelta') {
        const turnId = typeof notification.params?.turnId === 'string' ? notification.params.turnId : null;
        if (runtimeTurnId && turnId !== runtimeTurnId) return;
        const delta = typeof notification.params?.delta === 'string' ? notification.params.delta : '';
        if (!delta) return;
        await params.onEvent({
          type: 'tool.output',
          itemType: 'commandExecution',
          delta,
        });
        return;
      }

      if (notification.method === 'item/fileChange/outputDelta') {
        const turnId = typeof notification.params?.turnId === 'string' ? notification.params.turnId : null;
        if (runtimeTurnId && turnId !== runtimeTurnId) return;
        const delta = typeof notification.params?.delta === 'string' ? notification.params.delta : '';
        if (!delta) return;
        await params.onEvent({
          type: 'tool.output',
          itemType: 'fileChange',
          delta,
        });
        return;
      }

      if (notification.method === 'item/started' || notification.method === 'item/completed') {
        const turnId = typeof notification.params?.turnId === 'string' ? notification.params.turnId : null;
        if (runtimeTurnId && turnId && turnId !== runtimeTurnId) return;

        const item = notification.params?.item as Record<string, unknown> | undefined;
        if (!item || typeof item.type !== 'string') return;

        if (item.type === 'agentMessage' && notification.method === 'item/completed') {
          const text = typeof item.text === 'string' ? item.text : '';
          if (text) {
            await params.onEvent({ type: 'assistant.completed', text });
          }
          return;
        }

        if (
          item.type === 'commandExecution' ||
          item.type === 'fileChange' ||
          item.type === 'mcpToolCall' ||
          item.type === 'dynamicToolCall' ||
          item.type === 'webSearch' ||
          item.type === 'contextCompaction'
        ) {
          const label = this.describeItem(item);
          if (notification.method === 'item/started') {
            await params.onEvent({
              type: 'tool.started',
              itemType: item.type,
              label,
            });
          } else {
            await params.onEvent({
              type: 'tool.completed',
              itemType: item.type,
              label,
              success: this.isSuccessfulItem(item),
            });
          }
        }
        return;
      }

      if (notification.method === 'error') {
        const turnId = typeof notification.params?.turnId === 'string' ? notification.params.turnId : null;
        if (runtimeTurnId && turnId && turnId !== runtimeTurnId) return;

        const error = notification.params?.error as { message?: string } | undefined;
        await params.onEvent({
          type: 'runtime.error',
          message: error?.message ?? 'Codex reported an unknown runtime error.',
        });
        return;
      }

      if (notification.method === 'turn/completed') {
        const turn = notification.params?.turn as { id?: string; status?: string; error?: { message?: string } | null } | undefined;
        if (!turn?.id) return;
        if (runtimeTurnId && turn.id !== runtimeTurnId) return;

        const status =
          turn.status === 'interrupted'
            ? 'interrupted'
            : turn.status === 'failed'
              ? 'failed'
              : 'completed';

        if (!latestTurnUsage) {
          await sleep(TOKEN_USAGE_GRACE_MS);
        }

        await params.onEvent({
          type: 'turn.completed',
          status,
          message: turn.error?.message,
          usage: latestTurnUsage ?? this.latestUsageByThreadId.get(params.threadId) ?? null,
        });

        if (!settled) {
          settled = true;
          if (status === 'failed') {
            rejectCompletion(new Error(turn.error?.message ?? 'Codex turn failed'));
          } else {
            resolveCompletion();
          }
        }
      }
    });

    const removeServerRequestHandler = this.onServerRequest(async (request) => {
      const handled = await this.handleServerRequest({
        request,
        threadId: params.threadId,
        runtimeTurnId: () => runtimeTurnId,
        onEvent: params.onEvent,
        onApprovalRequest: params.onApprovalRequest,
        approvalRules: params.approvalRules,
      });
      return handled;
    });

    try {
      const input = params.inputItems && params.inputItems.length > 0
        ? params.inputItems
        : [{ type: 'text', text: params.inputText }];

      const result = await this.request('turn/start', {
        threadId: params.threadId,
        input,
        model: this.config.codex.model,
        effort: this.config.codex.reasoningEffort,
        summary: this.config.codex.summary,
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        ...(params.sandboxPolicy ? { sandboxPolicy: params.sandboxPolicy } : {}),
      });

      const turn = result.turn as { id?: string } | undefined;
      if (turn?.id && !runtimeTurnId) {
        runtimeTurnId = turn.id;
      }
      await completion;
    } finally {
      removeNotificationHandler();
      removeServerRequestHandler();
    }
  }

  private normalizeRuntimeUsage(value: unknown): RuntimeUsage | null {
    if (!isRecord(value)) {
      return null;
    }

    const totalTokens = readTokenNumber(
      value.totalTokens ??
      value.total_tokens ??
      value.total ??
      value.tokens,
    );
    if (totalTokens === null) {
      return null;
    }

    return {
      input_tokens: readTokenNumber(
        value.inputTokens ??
        value.input_tokens ??
        value.promptTokens ??
        value.prompt_tokens ??
        value.input,
      ),
      output_tokens: readTokenNumber(
        value.outputTokens ??
        value.output_tokens ??
        value.completionTokens ??
        value.completion_tokens ??
        value.output,
      ),
      total_tokens: totalTokens,
    };
  }

  private readCodexTokenUsage(value: unknown): RuntimeUsage | null {
    if (!isRecord(value)) {
      return null;
    }

    const tokenUsage = isRecord(value.tokenUsage)
      ? value.tokenUsage
      : isRecord(value.token_usage)
        ? value.token_usage
        : value;
    const latest = isRecord(tokenUsage.last)
      ? tokenUsage.last
      : isRecord(tokenUsage.latest)
        ? tokenUsage.latest
        : tokenUsage;

    return this.normalizeRuntimeUsage(latest);
  }

  private async handleServerRequest(params: {
    request: JsonRpcServerRequest;
    threadId: string;
    runtimeTurnId: () => string | null;
    onEvent: (event: RuntimeEvent) => Promise<void> | void;
    onApprovalRequest?: (request: RuntimeApprovalRequest) => Promise<ApprovalResolution>;
    approvalRules?: RuntimeApprovalRules;
  }) {
    const threadId =
      typeof params.request.params?.threadId === 'string'
        ? params.request.params.threadId
        : typeof params.request.params?.conversationId === 'string'
          ? params.request.params.conversationId
          : null;

    if (threadId && threadId !== params.threadId) {
      return false;
    }

    switch (params.request.method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
      case 'item/permissions/requestApproval':
      case 'execCommandApproval':
      case 'applyPatchApproval': {
        const approval = this.buildApprovalRequest(params.request, params.runtimeTurnId());
        if (!approval) return true;
        if (params.approvalRules?.[approval.actionType] === 'deny') {
          await this.reply(params.request.id, this.mapApprovalResponse(params.request.method, { decision: 'reject' }));
          return true;
        }

        const resolution = params.onApprovalRequest
          ? await params.onApprovalRequest(approval)
          : { decision: 'reject' as const };

        await this.reply(params.request.id, this.mapApprovalResponse(params.request.method, resolution));
        return true;
      }
      default:
        this.replyError(params.request.id, `Unsupported server request: ${params.request.method}`);
        return true;
    }
  }

  private buildApprovalRequest(request: JsonRpcServerRequest, runtimeTurnId: string | null): RuntimeApprovalRequest | null {
    const params = request.params ?? {};
    const command = typeof params.command === 'string'
      ? params.command
      : Array.isArray(params.command)
        ? params.command.map((value) => String(value)).join(' ')
        : null;
    const cwd = typeof params.cwd === 'string' ? params.cwd : null;
    const reason = typeof params.reason === 'string' ? params.reason : null;
    const itemId = typeof params.itemId === 'string' ? params.itemId : null;
    const approvalId = typeof params.approvalId === 'string' ? params.approvalId : null;
    const availableDecisions = Array.isArray(params.availableDecisions)
      ? params.availableDecisions.map((decision) => JSON.stringify(decision))
      : [];

    if (request.method === 'item/fileChange/requestApproval' || request.method === 'applyPatchApproval') {
      const grantRoot = typeof params.grantRoot === 'string' ? params.grantRoot : null;
      return {
        requestId: request.id,
        requestMethod: request.method,
        actionType: 'pkm_write',
        approvalId,
        previewHtml: `
          <h4>File changes need approval</h4>
          ${reason ? `<p>${escapeHtml(reason)}</p>` : ''}
          ${grantRoot ? `<p><strong>Grant root:</strong> ${escapeHtml(grantRoot)}</p>` : ''}
        `.trim(),
        metadata: {
          item_id: itemId,
          runtime_turn_id: runtimeTurnId,
          request_method: request.method,
        },
      };
    }

    const networkContext = params.networkApprovalContext as Record<string, unknown> | undefined;
    const isExternalNetwork = !!networkContext;
    const actionType = isExternalNetwork ? 'external_api' : 'high_cost_tools';
    const networkBits: string[] = [];
    if (networkContext && typeof networkContext.host === 'string') {
      networkBits.push(`Host: ${networkContext.host}`);
    }
    if (networkContext && typeof networkContext.protocol === 'string') {
      networkBits.push(`Protocol: ${networkContext.protocol}`);
    }

    return {
      requestId: request.id,
      requestMethod: request.method,
      actionType,
      approvalId,
      previewHtml: `
        <h4>${isExternalNetwork ? 'External network access' : 'Local command execution'} requires approval</h4>
        ${command ? `<pre>${escapeHtml(command)}</pre>` : ''}
        ${cwd ? `<p><strong>Working directory:</strong> ${escapeHtml(cwd)}</p>` : ''}
        ${reason ? `<p>${escapeHtml(reason)}</p>` : ''}
        ${htmlList(networkBits)}
        ${availableDecisions.length > 0 ? `<p><strong>Available decisions:</strong> ${escapeHtml(availableDecisions.join(', '))}</p>` : ''}
      `.trim(),
      metadata: {
        item_id: itemId,
        runtime_turn_id: runtimeTurnId,
        request_method: request.method,
        command,
        cwd,
        network_approval_context: networkContext ?? null,
      },
    };
  }

  private mapApprovalResponse(method: string, resolution: ApprovalResolution) {
    const approve =
      resolution.decision === 'approve'
        ? method === 'execCommandApproval' || method === 'applyPatchApproval'
          ? { decision: 'approved' }
          : { decision: 'accept' }
        : resolution.decision === 'cancel'
          ? method === 'execCommandApproval' || method === 'applyPatchApproval'
            ? { decision: 'abort' }
            : { decision: 'cancel' }
          : method === 'execCommandApproval' || method === 'applyPatchApproval'
            ? { decision: 'denied' }
            : { decision: 'decline' };

    return approve;
  }

  private onNotification(handler: NotificationHandler) {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  private onServerRequest(handler: ServerRequestHandler) {
    this.serverRequestHandlers.add(handler);
    return () => {
      this.serverRequestHandlers.delete(handler);
    };
  }

  private describeItem(item: Record<string, unknown>) {
    switch (item.type) {
      case 'commandExecution':
        return typeof item.command === 'string' ? item.command : 'Command execution';
      case 'fileChange':
        return 'Proposed file changes';
      case 'mcpToolCall':
        return `${String(item.server ?? 'mcp')} · ${String(item.tool ?? 'tool')}`;
      case 'dynamicToolCall':
        return String(item.tool ?? 'Dynamic tool');
      case 'webSearch':
        return typeof item.query === 'string' ? `Web search: ${item.query}` : 'Web search';
      case 'contextCompaction':
        return 'Context compaction';
      default:
        return String(item.type ?? 'Tool');
    }
  }

  private isSuccessfulItem(item: Record<string, unknown>) {
    if (item.type === 'commandExecution') {
      return item.status === 'completed';
    }

    if (item.type === 'fileChange') {
      return item.status !== 'failed' && item.status !== 'declined';
    }

    if (item.type === 'mcpToolCall') {
      return item.status === 'completed' && !item.error;
    }

    if (item.type === 'dynamicToolCall') {
      return item.success !== false && item.status !== 'failed';
    }

    return true;
  }

  private async request(method: string, params: Record<string, unknown>) {
    const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = this.nextRequestId++;
      this.pendingRequests.set(id, { resolve, reject });
      this.write({ method, id, params });
    });

    return response;
  }

  private async reply(id: number, result: Record<string, unknown>) {
    this.write({ id, result });
  }

  private replyError(id: number, message: string) {
    this.write({
      id,
      error: {
        code: -32000,
        message,
      },
    });
  }

  private notify(method: string, params: Record<string, unknown>) {
    this.write({ method, params });
  }

  private write(message: Record<string, unknown>) {
    if (!this.process?.stdin || !this.process.stdin.writable) {
      throw new Error('codex app-server stdin is not writable');
    }
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }
}
