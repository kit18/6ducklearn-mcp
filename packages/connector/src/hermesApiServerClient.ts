import type {
  ConnectorConfig,
  RuntimeAdapter,
  RuntimeCapabilities,
  RuntimeEvent,
  RuntimeInputItem,
  RuntimeThreadContext,
} from './types.js';

type HermesResponseOutputItem = Record<string, unknown>;

class HermesApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'HermesApiError';
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function trimToNull(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseJsonSafely(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value) as unknown;
    return asRecord(parsed);
  } catch {
    return null;
  }
}

function stringifyValue(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (value == null) {
    return null;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractVersionCandidate(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/\d+\.\d+\.\d+(?:[-+._a-z0-9]*)?/i);
  return match ? match[0] : null;
}

function normalizeStatus(value: unknown): 'completed' | 'interrupted' | 'failed' {
  if (value === 'completed') return 'completed';
  if (value === 'cancelled' || value === 'canceled' || value === 'interrupted') {
    return 'interrupted';
  }
  return 'failed';
}

function parseToolDetail(argumentsText: string | null): string | undefined {
  if (!argumentsText) return undefined;
  const parsed = parseJsonSafely(argumentsText);
  if (!parsed) {
    return argumentsText.length > 200 ? `${argumentsText.slice(0, 197)}...` : argumentsText;
  }
  if (typeof parsed.command === 'string' && parsed.command.trim() !== '') {
    return parsed.command;
  }
  if (typeof parsed.query === 'string' && parsed.query.trim() !== '') {
    return parsed.query;
  }
  const summary = JSON.stringify(parsed);
  return summary.length > 200 ? `${summary.slice(0, 197)}...` : summary;
}

function combineThreadInstructions(context: RuntimeThreadContext) {
  const sections = [
    trimToNull(context.systemPrompt),
    trimToNull(context.baseInstructions),
    trimToNull(context.developerInstructions),
  ].filter((section): section is string => !!section);
  const deduped = sections.filter((section, index) => sections.indexOf(section) === index);
  return deduped.length > 0 ? deduped.join('\n\n') : undefined;
}

function readPrimaryText(inputItems: RuntimeInputItem[] | undefined) {
  const textItem = inputItems?.find((item) => item.type === 'text');
  return textItem?.type === 'text' ? trimToNull(textItem.text) : null;
}

function isMetadataUnsupported(error: unknown) {
  if (!(error instanceof HermesApiError)) return false;
  if (error.status !== 400 && error.status !== 422) return false;
  return /metadata|unknown field|unsupported|invalid params|invalid parameter/i.test(
    `${error.message}\n${error.body}`,
  );
}

function extractMessageText(item: HermesResponseOutputItem): string {
  const content = item.content;
  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((entry) => {
      const record = asRecord(entry);
      if (!record) return '';
      if (record.type === 'output_text' && typeof record.text === 'string') {
        return record.text;
      }
      return '';
    })
    .filter(Boolean)
    .join('');
}

function extractAssistantText(output: HermesResponseOutputItem[]): string {
  return output
    .map((item) => {
      if (item.type === 'message' && item.role === 'assistant') {
        return extractMessageText(item);
      }
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

async function* parseSseMessages(stream: ReadableStream<Uint8Array>): AsyncGenerator<{
  event: string | null;
  data: string;
}> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r/g, '');

    while (true) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary === -1) {
        break;
      }

      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);

      let event: string | null = null;
      const dataLines: string[] = [];
      for (const line of chunk.split('\n')) {
        if (!line || line.startsWith(':')) continue;
        if (line.startsWith('event:')) {
          event = line.slice(6).trim() || null;
          continue;
        }
        if (line.startsWith('data:')) {
          dataLines.push(line.slice(5).trimStart());
        }
      }

      if (dataLines.length > 0) {
        yield {
          event,
          data: dataLines.join('\n'),
        };
      }
    }
  }

  buffer += decoder.decode();
  const tail = buffer.trim();
  if (!tail) return;

  let event: string | null = null;
  const dataLines: string[] = [];
  for (const line of tail.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    if (line.startsWith('event:')) {
      event = line.slice(6).trim() || null;
      continue;
    }
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length > 0) {
    yield {
      event,
      data: dataLines.join('\n'),
    };
  }
}

export class HermesApiServerClient implements RuntimeAdapter {
  readonly runtimeType = 'hermes' as const;

  private apiBaseUrl: URL | null = null;
  private discoveredModelName: string | null = null;
  private readonly threadInstructions = new Map<string, string | undefined>();
  private metadataSupported: boolean | null = null;

  constructor(private readonly config: ConnectorConfig) {}

  async start() {
    await this.fetchJson('health');
  }

  async stop() {
    // Hermes is managed outside the connector in v1.
  }

  async detectRuntimeVersion() {
    const response = await this.request('models', {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });
    const payload = (await response.json().catch(() => ({}))) as { data?: Array<{ id?: unknown }> };
    if (Array.isArray(payload.data)) {
      const firstModel = payload.data.find((entry) => typeof entry?.id === 'string');
      this.discoveredModelName = typeof firstModel?.id === 'string' ? firstModel.id : this.discoveredModelName;
    }

    return (
      extractVersionCandidate(response.headers.get('x-hermes-version')) ||
      extractVersionCandidate(response.headers.get('x-runtime-version')) ||
      extractVersionCandidate(response.headers.get('server'))
    );
  }

  getCapabilities(): RuntimeCapabilities {
    return {
      schema_version: '2026-03-29',
      runtime: 'hermes',
      transport: 'http-sse',
      protocol: 'hermes-api-server',
      structured_context: {
        instructions: true,
        metadata: this.metadataSupported === true,
        input_items: false,
        fallback_mode: this.metadataSupported === true ? 'native' : 'text_envelope',
      },
      features: {
        streaming: true,
        interrupt: false,
        approvals: false,
        session_sync: true,
        remote_access: false,
      },
      base_url: this.normalizeApiBaseUrl().toString().replace(/\/$/, ''),
      conversation_prefix: this.config.hermes.conversationPrefix,
      ...(this.discoveredModelName ? { model: this.discoveredModelName } : {}),
    };
  }

  private buildResponseBody(params: {
    threadId: string;
    inputText: string;
    inputItems?: RuntimeInputItem[];
    includeMetadata: boolean;
  }) {
    return {
      model: this.discoveredModelName ?? 'hermes-agent',
      input: readPrimaryText(params.inputItems) ?? params.inputText,
      instructions: this.threadInstructions.get(params.threadId),
      conversation: params.threadId,
      store: true,
      stream: true,
      ...(params.includeMetadata && params.inputItems && params.inputItems.length > 0
        ? {
            metadata: {
              sixducklearn: {
                input_items: params.inputItems,
              },
            },
          }
        : {}),
    };
  }

  private async createResponse(params: {
    threadId: string;
    inputText: string;
    inputItems?: RuntimeInputItem[];
  }) {
    const includeMetadata = this.metadataSupported !== false && !!params.inputItems?.length;
    const requestWithMetadata = () => this.request('responses', {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this.buildResponseBody({
        ...params,
        includeMetadata,
      })),
    });

    try {
      const response = await requestWithMetadata();
      if (includeMetadata) {
        this.metadataSupported = true;
      }
      return response;
    } catch (error) {
      if (!includeMetadata || !isMetadataUnsupported(error)) {
        throw error;
      }
      this.metadataSupported = false;
      return await this.request('responses', {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(this.buildResponseBody({
          ...params,
          includeMetadata: false,
        })),
      });
    }
  }

  async ensureThread(context: RuntimeThreadContext) {
    const conversationKey =
      trimToNull(context.runtimeThreadId) ??
      trimToNull(context.metadata?.hermes_conversation_key) ??
      this.buildConversationKey(context.metadata);

    this.threadInstructions.set(conversationKey, combineThreadInstructions(context));
    return conversationKey;
  }

  async interruptTurn(_runtimeThreadId: string, _runtimeTurnId: string) {
    // Hermes does not expose a verified cancellation endpoint in v1.
  }

  async runTurn(params: {
    threadId: string;
    inputText: string;
    inputItems?: RuntimeInputItem[];
    onEvent: (event: RuntimeEvent) => Promise<void> | void;
  }) {
    let runtimeTurnId: string | null = null;
    let accumulatedAssistantText = '';
    let finalized = false;

    const emitFailure = async (message: string, status: 'failed' | 'interrupted' = 'failed') => {
      if (finalized) return;
      finalized = true;
      await params.onEvent({
        type: 'runtime.error',
        message,
      });
      await params.onEvent({
        type: 'turn.completed',
        status,
        message,
      });
    };

    const emitTurnStarted = async (responseId: string | null) => {
      if (!responseId || runtimeTurnId) return;
      runtimeTurnId = responseId;
      await params.onEvent({
        type: 'turn.started',
        runtimeTurnId: responseId,
      });
    };

    const finalizeSuccessfulResponse = async (responseRecord: Record<string, unknown>) => {
      const responseId = trimToNull(responseRecord.id);
      await emitTurnStarted(responseId);

      const status = normalizeStatus(responseRecord.status);
      const output = Array.isArray(responseRecord.output)
        ? responseRecord.output.map((entry) => asRecord(entry)).filter(Boolean) as HermesResponseOutputItem[]
        : [];

      if (output.length > 0) {
        const pendingCalls = new Map<string, string>();
        for (const item of output) {
          if (item.type === 'function_call') {
            const callId = trimToNull(item.call_id);
            const label = trimToNull(item.name) ?? 'tool';
            if (callId) {
              pendingCalls.set(callId, label);
            }
            await params.onEvent({
              type: 'tool.started',
              itemType: 'function_call',
              label,
              detail: parseToolDetail(trimToNull(item.arguments)),
            });
            continue;
          }

          if (item.type === 'function_call_output') {
            const callId = trimToNull(item.call_id);
            const label = callId ? pendingCalls.get(callId) ?? 'tool' : 'tool';
            const outputText = stringifyValue(item.output);
            if (outputText) {
              await params.onEvent({
                type: 'tool.output',
                itemType: 'function_call',
                delta: outputText,
              });
            }
            await params.onEvent({
              type: 'tool.completed',
              itemType: 'function_call',
              label,
              success: true,
            });
            if (callId) {
              pendingCalls.delete(callId);
            }
          }
        }

        for (const label of pendingCalls.values()) {
          await params.onEvent({
            type: 'tool.completed',
            itemType: 'function_call',
            label,
            success: true,
          });
        }
      }

      const assistantText = extractAssistantText(output) || accumulatedAssistantText;
      if (assistantText) {
        await params.onEvent({
          type: 'assistant.completed',
          text: assistantText,
        });
      }

      if (status !== 'completed') {
        const message =
          trimToNull(responseRecord.error_message) ??
          trimToNull(responseRecord.incomplete_details) ??
          'Hermes did not complete the response.';
        await emitFailure(message, status);
        return;
      }

      if (!finalized) {
        finalized = true;
        await params.onEvent({
          type: 'turn.completed',
          status: 'completed',
        });
      }
    };

    try {
      const response = await this.createResponse({
        threadId: params.threadId,
        inputText: params.inputText,
        inputItems: params.inputItems,
      });

      if (!response.body) {
        const payload = (await response.json()) as Record<string, unknown>;
        await finalizeSuccessfulResponse(asRecord(payload.response) ?? payload);
        return;
      }

      let finalResponse: Record<string, unknown> | null = null;
      for await (const message of parseSseMessages(response.body)) {
        if (message.data === '[DONE]') {
          break;
        }

        const payload = parseJsonSafely(message.data);
        if (!payload) continue;

        const eventType = trimToNull(message.event) ?? trimToNull(payload.type);
        if (!eventType) continue;

        if (eventType === 'response.created') {
          const responseRecord = asRecord(payload.response) ?? payload;
          await emitTurnStarted(trimToNull(responseRecord.id));
          continue;
        }

        if (eventType === 'response.output_text.delta') {
          const delta = stringOrNull(payload.delta);
          if (!delta) continue;
          accumulatedAssistantText += delta;
          await params.onEvent({
            type: 'assistant.delta',
            text: delta,
          });
          continue;
        }

        if (eventType === 'response.completed') {
          finalResponse = asRecord(payload.response) ?? payload;
          await finalizeSuccessfulResponse(finalResponse);
          break;
        }

        if (eventType === 'response.failed' || eventType === 'response.incomplete') {
          finalResponse = asRecord(payload.response) ?? payload;
          const status = normalizeStatus(finalResponse?.status);
          const messageText =
            trimToNull(payload.message) ??
            trimToNull(finalResponse?.error_message) ??
            trimToNull(finalResponse?.incomplete_details) ??
            'Hermes reported an incomplete response.';
          await emitTurnStarted(trimToNull(finalResponse?.id));
          await emitFailure(messageText, status === 'interrupted' ? 'interrupted' : 'failed');
          throw new Error(messageText);
        }

        if (eventType === 'error') {
          const errorMessage =
            trimToNull(asRecord(payload.error)?.message) ??
            trimToNull(payload.message) ??
            'Hermes API server returned an error.';
          await emitFailure(errorMessage);
          throw new Error(errorMessage);
        }
      }

      if (!finalized) {
        if (finalResponse) {
          await finalizeSuccessfulResponse(finalResponse);
          return;
        }

        if (accumulatedAssistantText) {
          await params.onEvent({
            type: 'assistant.completed',
            text: accumulatedAssistantText,
          });
        }

        finalized = true;
        await params.onEvent({
          type: 'turn.completed',
          status: 'completed',
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Hermes turn failed';
      await emitFailure(message);
      throw error;
    }
  }

  private buildConversationKey(metadata?: Record<string, unknown> | null) {
    const browserThreadId =
      trimToNull(metadata?.browser_thread_id) ??
      trimToNull(metadata?.thread_id) ??
      trimToNull(metadata?.id);

    if (browserThreadId) {
      return `${this.config.hermes.conversationPrefix}:${browserThreadId}`;
    }

    return `${this.config.hermes.conversationPrefix}:${Date.now()}`;
  }

  private normalizeApiBaseUrl() {
    if (this.apiBaseUrl) {
      return this.apiBaseUrl;
    }

    const rawBaseUrl = trimToNull(this.config.hermes.baseUrl);
    if (!rawBaseUrl) {
      throw new Error('Hermes connector requires SIXDUCK_HERMES_BASE_URL to point at the local Hermes API server.');
    }

    let parsed: URL;
    try {
      parsed = new URL(rawBaseUrl);
    } catch {
      throw new Error('Hermes connector requires SIXDUCK_HERMES_BASE_URL to be a valid http:// or https:// URL.');
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Hermes connector requires SIXDUCK_HERMES_BASE_URL to use http:// or https://.');
    }

    const normalizedPath = parsed.pathname === '/' ? '/v1' : parsed.pathname.replace(/\/$/, '');
    parsed.pathname = normalizedPath.endsWith('/v1') ? normalizedPath : `${normalizedPath}/v1`;
    if (!parsed.pathname.endsWith('/')) {
      parsed.pathname = `${parsed.pathname}/`;
    }
    parsed.search = '';
    parsed.hash = '';

    this.apiBaseUrl = parsed;
    return parsed;
  }

  private async fetchJson(path: string) {
    const response = await this.request(path, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });
    return response.json().catch(() => ({}));
  }

  private async request(path: string, init: RequestInit) {
    const url = new URL(path.replace(/^\//, ''), this.normalizeApiBaseUrl());
    const headers = new Headers(init.headers ?? {});

    if (this.config.hermes.apiKey) {
      headers.set('Authorization', `Bearer ${this.config.hermes.apiKey}`);
    }

    const response = await fetch(url, {
      ...init,
      headers,
    });

    if (!response.ok) {
      const rawBody = await response.text().catch(() => '');
      const payload = parseJsonSafely(rawBody);
      const errorMessage =
        trimToNull(asRecord(payload?.error)?.message) ??
        trimToNull(payload?.message) ??
        `Hermes API request failed (${response.status})`;
      throw new HermesApiError(errorMessage, response.status, rawBody);
    }

    return response;
  }
}
