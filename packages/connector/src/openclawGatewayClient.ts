import type {
  ConnectorConfig,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeInputItem,
  RuntimeThreadContext,
} from './types.js';

type GatewayResponseFrame = {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: {
    message?: string;
  };
};

type GatewayEventFrame = {
  type: 'event';
  event: string;
  payload?: Record<string, unknown>;
};

type GatewayFrame = GatewayResponseFrame | GatewayEventFrame;

type EventHandler = (frame: GatewayEventFrame) => void | Promise<void>;

type OpenClawThreadContext = {
  instructions: Record<string, string>;
  metadata: Record<string, unknown>;
};

function trimToNull(value: unknown) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function readPrimaryText(inputItems: RuntimeInputItem[] | undefined) {
  const textItem = inputItems?.find((item) => item.type === 'text');
  return textItem?.type === 'text' ? trimToNull(textItem.text) : null;
}

function buildInstructionMap(context: RuntimeThreadContext): Record<string, string> {
  const instructions: Record<string, string> = {};
  const systemPrompt = trimToNull(context.systemPrompt);
  const baseInstructions = trimToNull(context.baseInstructions);
  const developerInstructions = trimToNull(context.developerInstructions);

  if (systemPrompt) instructions.system_prompt = systemPrompt;
  if (baseInstructions) instructions.base_instructions = baseInstructions;
  if (developerInstructions) instructions.developer_instructions = developerInstructions;
  return instructions;
}

function buildOpenClawMessage(inputText: string, threadContext: OpenClawThreadContext | undefined) {
  if (!threadContext || Object.keys(threadContext.instructions).length === 0) {
    return inputText;
  }

  const sections = ['6DuckLearn agent control plan:'];
  if (threadContext.instructions.system_prompt) {
    sections.push(`System prompt:\n${threadContext.instructions.system_prompt}`);
  }
  if (threadContext.instructions.base_instructions) {
    sections.push(`Base instructions:\n${threadContext.instructions.base_instructions}`);
  }
  if (threadContext.instructions.developer_instructions) {
    sections.push(`Developer instructions:\n${threadContext.instructions.developer_instructions}`);
  }

  return `${sections.join('\n\n')}\n\n${inputText}`;
}

function isStructuredContextUnsupported(error: unknown) {
  return /unknown field|unsupported|invalid params|invalid parameter/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

export class OpenClawGatewayClient implements RuntimeAdapter {
  readonly runtimeType = 'openclaw' as const;

  private socket: any | null = null;
  private nextRequestId = 1;
  private pending = new Map<string, {
    resolve: (payload: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  }>();
  private eventHandlers = new Set<EventHandler>();
  private connectPromise: Promise<void> | null = null;
  private threadContexts = new Map<string, OpenClawThreadContext>();
  private structuredContextSupported: boolean | null = null;

  constructor(private readonly config: ConnectorConfig) {}

  private parseGatewayUrl() {
    try {
      return new URL(this.config.openclaw.gatewayUrl.trim());
    } catch {
      return null;
    }
  }

  private normalizeGatewayHostname(hostname: string) {
    return hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  }

  private hasGatewayCredentials() {
    return !!(this.config.openclaw.gatewayToken || this.config.openclaw.gatewayPassword);
  }

  private isLoopbackGateway() {
    const parsed = this.parseGatewayUrl();
    if (!parsed) return false;
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return false;

    const hostname = this.normalizeGatewayHostname(parsed.hostname);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  }

  private isRemoteGateway() {
    const parsed = this.parseGatewayUrl();
    if (!parsed) return false;
    return !this.isLoopbackGateway();
  }

  private validateGatewayAccess() {
    const parsed = this.parseGatewayUrl();
    if (!parsed) {
      throw new Error('OpenClaw connector requires SIXDUCK_OPENCLAW_GATEWAY_URL to be a valid ws:// or wss:// URL.');
    }

    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw new Error('OpenClaw connector requires SIXDUCK_OPENCLAW_GATEWAY_URL to use the ws:// or wss:// scheme.');
    }

    if (this.config.openclaw.allowInsecureLocalAuth && !this.isLoopbackGateway()) {
      throw new Error(
        'SIXDUCK_OPENCLAW_ALLOW_INSECURE_LOCAL_AUTH=true is only supported with a loopback OpenClaw gateway URL such as ws://127.0.0.1:18789.',
      );
    }

    if (!this.config.openclaw.allowInsecureLocalAuth && !this.hasGatewayCredentials()) {
      throw new Error(
        'OpenClaw connector requires either SIXDUCK_OPENCLAW_ALLOW_INSECURE_LOCAL_AUTH=true for loopback beta access, or SIXDUCK_OPENCLAW_GATEWAY_TOKEN / SIXDUCK_OPENCLAW_GATEWAY_PASSWORD for authenticated remote access.',
      );
    }

    if (!this.isLoopbackGateway() && parsed.protocol !== 'wss:') {
      throw new Error(
        'Hosted OpenClaw requires SIXDUCK_OPENCLAW_GATEWAY_URL to use wss://. Use the local beta path only with a loopback gateway plus SIXDUCK_OPENCLAW_ALLOW_INSECURE_LOCAL_AUTH=true.',
      );
    }
  }

  getCapabilities(): RuntimeCapabilities {
    return {
      schema_version: '2026-03-29',
      runtime: 'openclaw',
      transport: 'gateway-ws',
      protocol: 'openclaw-gateway',
      structured_context: {
        instructions: this.structuredContextSupported === true,
        metadata: this.structuredContextSupported === true,
        input_items: this.structuredContextSupported === true,
        fallback_mode: this.structuredContextSupported === true ? 'native' : 'text_envelope',
      },
      features: {
        streaming: true,
        interrupt: true,
        approvals: false,
        session_sync: true,
        remote_access: this.isRemoteGateway(),
      },
      gateway_url: this.config.openclaw.gatewayUrl,
      session_key: this.config.openclaw.sessionKey,
      auth_mode: this.config.openclaw.gatewayToken ? 'token' : this.config.openclaw.gatewayPassword ? 'password' : 'none',
      insecure_local_auth: this.config.openclaw.allowInsecureLocalAuth,
    };
  }

  async start() {
    if (this.socket) return;
    if (this.connectPromise) return this.connectPromise;

    this.validateGatewayAccess();

    const WebSocketCtor = (globalThis as unknown as { WebSocket?: new (url: string) => any }).WebSocket;
    if (!WebSocketCtor) {
      throw new Error('This Node runtime does not expose WebSocket. Upgrade Node before using the OpenClaw connector.');
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const socket = new WebSocketCtor(this.config.openclaw.gatewayUrl);
      let challengeReceived = false;
      let connected = false;

      socket.addEventListener('message', async (event: { data: string }) => {
        try {
          const frame = JSON.parse(String(event.data)) as GatewayFrame;
          if (frame.type === 'event') {
            if (frame.event === 'connect.challenge' && !challengeReceived) {
              challengeReceived = true;
              const connectId = this.nextFrameId();
              this.pending.set(connectId, {
                resolve: () => {
                  connected = true;
                  resolve();
                },
                reject,
              });
              this.send({
                type: 'req',
                id: connectId,
                method: 'connect',
                params: {
                  minProtocol: this.config.openclaw.protocolVersion,
                  maxProtocol: this.config.openclaw.protocolVersion,
                  client: {
                    id: '6ducklearn-connector',
                    version: this.config.adapterVersion,
                    platform: process.platform,
                    mode: 'operator',
                  },
                  role: 'operator',
                  scopes: ['operator.read', 'operator.write', 'operator.approvals'],
                  caps: [],
                  commands: [],
                  permissions: {},
                  auth: {
                    ...(this.config.openclaw.gatewayToken ? { token: this.config.openclaw.gatewayToken } : {}),
                    ...(this.config.openclaw.gatewayPassword ? { password: this.config.openclaw.gatewayPassword } : {}),
                  },
                  locale: 'en-US',
                  userAgent: `6ducklearn-connector/${this.config.adapterVersion}`,
                },
              });
              return;
            }

            for (const handler of this.eventHandlers) {
              Promise.resolve(handler(frame)).catch((error) => {
                console.warn('[6ducklearn-connector] OpenClaw event handler failed:', error);
              });
            }
            return;
          }

          if (!frame.ok) {
            const message = frame.error?.message ?? 'OpenClaw gateway request failed';
            const pending = this.pending.get(frame.id);
            if (pending) {
              this.pending.delete(frame.id);
              pending.reject(new Error(message));
              return;
            }
            reject(new Error(message));
            return;
          }

          const pending = this.pending.get(frame.id);
          if (pending) {
            this.pending.delete(frame.id);
            pending.resolve(frame.payload ?? {});
          }
        } catch (error) {
          console.warn('[6ducklearn-connector] failed to parse OpenClaw frame:', error);
        }
      });

      socket.addEventListener('open', () => {
        // Wait for connect.challenge before sending connect.
      });

      socket.addEventListener('close', () => {
        const error = new Error('OpenClaw gateway socket closed');
        for (const pending of this.pending.values()) {
          pending.reject(error);
        }
        this.pending.clear();
        this.socket = null;
        this.connectPromise = null;
      });

      socket.addEventListener('error', () => {
        if (!connected) {
          reject(new Error('Failed to connect to OpenClaw gateway.'));
        }
      });

      this.socket = socket;
    });

    return this.connectPromise;
  }

  async stop() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.connectPromise = null;
  }

  async detectRuntimeVersion() {
    await this.start();
    try {
      const payload = await this.request('status', {});
      if (typeof payload.version === 'string') return payload.version;
      const gateway = payload.gateway as Record<string, unknown> | undefined;
      if (gateway && typeof gateway.version === 'string') return gateway.version;
      return null;
    } catch {
      return null;
    }
  }

  async ensureThread(context: RuntimeThreadContext) {
    let threadId: string;
    if (context.runtimeThreadId && context.runtimeThreadId.trim() !== '') {
      threadId = context.runtimeThreadId;
    } else {
      const metadata = (context.metadata ?? {}) as Record<string, unknown>;
      if (typeof metadata.openclaw_session_key === 'string' && metadata.openclaw_session_key.trim() !== '') {
        threadId = metadata.openclaw_session_key;
      } else {
        threadId = `agent-console:${Date.now()}`;
      }
    }

    this.threadContexts.set(threadId, {
      instructions: buildInstructionMap(context),
      metadata: (context.metadata ?? {}) as Record<string, unknown>,
    });
    return threadId;
  }

  async interruptTurn(runtimeThreadId: string) {
    await this.start();
    await this.request('chat.abort', {
      sessionKey: runtimeThreadId,
    });
  }

  async runTurn(params: {
    threadId: string;
    inputText: string;
    inputItems?: RuntimeInputItem[];
    onEvent: (event: RuntimeEvent) => Promise<void> | void;
  }) {
    await this.start();

    let settled = false;
    let resolveCompletion!: () => void;
    let rejectCompletion!: (error: Error) => void;
    const completion = new Promise<void>((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });

    const idempotencyKey = `${params.threadId}:${Date.now()}`;
    let runId: string | null = null;
    let accumulatedAssistantText = '';
    const threadContext = this.threadContexts.get(params.threadId);
    const primaryText = readPrimaryText(params.inputItems) ?? params.inputText;
    const message = buildOpenClawMessage(primaryText, threadContext);

    const removeHandler = this.onEvent(async (frame) => {
      if (frame.event !== 'chat') return;
      const payload = frame.payload ?? {};
      if (typeof payload.sessionKey === 'string' && payload.sessionKey !== params.threadId) return;
      if (runId && typeof payload.runId === 'string' && payload.runId !== runId) return;

      const delta =
        typeof payload.delta === 'string'
          ? payload.delta
          : typeof payload.textDelta === 'string'
            ? payload.textDelta
            : typeof payload.replyDelta === 'string'
              ? payload.replyDelta
              : null;

      if (delta) {
        accumulatedAssistantText += delta;
        await params.onEvent({ type: 'assistant.delta', text: delta });
      }

      const status = typeof payload.status === 'string' ? payload.status : null;
      const finalText =
        typeof payload.reply === 'string'
          ? payload.reply
          : typeof payload.text === 'string'
            ? payload.text
            : null;

      if (status === 'failed' || status === 'error') {
        const message =
          typeof payload.error === 'string'
            ? payload.error
            : typeof payload.message === 'string'
              ? payload.message
              : 'OpenClaw run failed';
        await params.onEvent({ type: 'runtime.error', message });
        await params.onEvent({ type: 'turn.completed', status: 'failed', message });
        settled = true;
        rejectCompletion(new Error(message));
        return;
      }

      if (status === 'aborted' || status === 'interrupted') {
        await params.onEvent({ type: 'turn.completed', status: 'interrupted' });
        settled = true;
        resolveCompletion();
        return;
      }

      if (status === 'ok' || status === 'completed') {
        if (finalText && finalText !== accumulatedAssistantText) {
          await params.onEvent({ type: 'assistant.completed', text: finalText });
        }
        await params.onEvent({ type: 'turn.completed', status: 'completed' });
        settled = true;
        resolveCompletion();
      }
    });

    try {
      const payload = await this.sendChat({
        threadId: params.threadId,
        message,
        idempotencyKey,
        threadContext,
        inputItems: params.inputItems,
      });

      runId = typeof payload.runId === 'string' ? payload.runId : null;
      await params.onEvent({
        type: 'turn.started',
        runtimeTurnId: runId ?? idempotencyKey,
      });

      if (typeof payload.status === 'string' && (payload.status === 'ok' || payload.status === 'completed')) {
        const reply = typeof payload.reply === 'string' ? payload.reply : '';
        if (reply) {
          await params.onEvent({ type: 'assistant.completed', text: reply });
        }
        await params.onEvent({ type: 'turn.completed', status: 'completed' });
        settled = true;
        return;
      }

      await completion;
    } finally {
      removeHandler();
      if (!settled && runId) {
        try {
          await this.request('chat.abort', { sessionKey: params.threadId, runId });
        } catch {
          // Best effort only.
        }
      }
    }
  }

  private onEvent(handler: EventHandler) {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  private async sendChat(params: {
    threadId: string;
    message: string;
    idempotencyKey: string;
    threadContext?: OpenClawThreadContext;
    inputItems?: RuntimeInputItem[];
  }) {
    const basePayload = {
      sessionKey: params.threadId,
      message: params.message,
      idempotencyKey: params.idempotencyKey,
    };

    if (this.structuredContextSupported === false) {
      return await this.request('chat.send', basePayload);
    }

    const structuredPayload = {
      ...basePayload,
      ...(params.threadContext && Object.keys(params.threadContext.instructions).length > 0
        ? { instructions: params.threadContext.instructions }
        : {}),
      ...(params.threadContext && Object.keys(params.threadContext.metadata).length > 0
        ? { metadata: params.threadContext.metadata }
        : {}),
      ...(params.inputItems && params.inputItems.length > 0
        ? { inputItems: params.inputItems }
        : {}),
    };

    try {
      const payload = await this.request('chat.send', structuredPayload);
      if (Object.keys(structuredPayload).length > Object.keys(basePayload).length) {
        this.structuredContextSupported = true;
      }
      return payload;
    } catch (error) {
      if (!isStructuredContextUnsupported(error)) {
        throw error;
      }
      this.structuredContextSupported = false;
      return await this.request('chat.send', basePayload);
    }
  }

  private async request(method: string, params: Record<string, unknown>) {
    await this.start();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = this.nextFrameId();
      this.pending.set(id, { resolve, reject });
      this.send({
        type: 'req',
        id,
        method,
        params,
      });
    });
  }

  private nextFrameId() {
    return `6ducklearn-${this.nextRequestId++}`;
  }

  private send(frame: Record<string, unknown>) {
    if (!this.socket || this.socket.readyState !== 1) {
      throw new Error('OpenClaw gateway socket is not open');
    }
    this.socket.send(JSON.stringify(frame));
  }
}
