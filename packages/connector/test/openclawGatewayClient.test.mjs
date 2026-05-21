import test from 'node:test';
import assert from 'node:assert/strict';
import { OpenClawGatewayClient } from '../dist/openclawGatewayClient.js';

function buildConfig(overrides = {}) {
  return {
    supabaseUrl: 'https://example.supabase.co',
    tokenId: 'token-id',
    hmacSecret: 'a'.repeat(64),
    deviceId: 'device-id',
    deviceName: 'Test Device',
    runtimeType: 'openclaw',
    pollIntervalMs: 2000,
    heartbeatIntervalMs: 20_000,
    serviceName: '6ducklearn_connector',
    adapterVersion: '0.2.0',
    codex: {
      model: 'gpt-5.4',
      reasoningEffort: 'medium',
      summary: 'concise',
      cwd: '/tmp/workspace',
      minVersion: '0.117.0',
    },
    openclaw: {
      gatewayUrl: 'ws://127.0.0.1:18789',
      gatewayToken: null,
      gatewayPassword: null,
      allowInsecureLocalAuth: true,
      sessionKey: 'main',
      protocolVersion: 3,
    },
    ...overrides,
  };
}

test('OpenClawGatewayClient reports local beta capabilities', () => {
  const config = buildConfig();
  const client = new OpenClawGatewayClient(config);

  assert.deepEqual(client.getCapabilities(), {
    schema_version: '2026-03-29',
    runtime: 'openclaw',
    transport: 'gateway-ws',
    protocol: 'openclaw-gateway',
    structured_context: {
      instructions: false,
      metadata: false,
      input_items: false,
      fallback_mode: 'text_envelope',
    },
    features: {
      streaming: true,
      interrupt: true,
      approvals: false,
      session_sync: true,
      remote_access: false,
    },
    gateway_url: config.openclaw.gatewayUrl,
    session_key: config.openclaw.sessionKey,
    auth_mode: 'none',
    insecure_local_auth: true,
  });
});

test('OpenClawGatewayClient reports remote access when a hosted gateway is configured', () => {
  const config = buildConfig({
    openclaw: {
      gatewayUrl: 'wss://openclaw.example.com/gateway',
      gatewayToken: 'remote-token',
      gatewayPassword: null,
      allowInsecureLocalAuth: false,
      sessionKey: 'main',
      protocolVersion: 3,
    },
  });
  const client = new OpenClawGatewayClient(config);

  assert.equal(client.getCapabilities().features.remote_access, true);
  assert.equal(client.getCapabilities().auth_mode, 'token');
});

test('OpenClawGatewayClient treats IPv6 loopback gateways as local access', () => {
  const config = buildConfig({
    openclaw: {
      gatewayUrl: 'ws://[::1]:18789',
      gatewayToken: null,
      gatewayPassword: null,
      allowInsecureLocalAuth: true,
      sessionKey: 'main',
      protocolVersion: 3,
    },
  });
  const client = new OpenClawGatewayClient(config);

  assert.equal(client.getCapabilities().features.remote_access, false);
});

test('OpenClawGatewayClient rejects configs that omit both local opt-in and gateway credentials', async () => {
  const client = new OpenClawGatewayClient(buildConfig({
    openclaw: {
      gatewayUrl: 'wss://openclaw.example.com/gateway',
      gatewayToken: null,
      gatewayPassword: null,
      allowInsecureLocalAuth: false,
      sessionKey: 'main',
      protocolVersion: 3,
    },
  }));

  await assert.rejects(
    () => client.start(),
    /requires either SIXDUCK_OPENCLAW_ALLOW_INSECURE_LOCAL_AUTH=true .* SIXDUCK_OPENCLAW_GATEWAY_TOKEN .* SIXDUCK_OPENCLAW_GATEWAY_PASSWORD/i,
  );
});

test('OpenClawGatewayClient rejects hosted gateways that do not use wss', async () => {
  const client = new OpenClawGatewayClient(buildConfig({
    openclaw: {
      gatewayUrl: 'ws://openclaw.example.com/gateway',
      gatewayToken: 'remote-token',
      gatewayPassword: null,
      allowInsecureLocalAuth: false,
      sessionKey: 'main',
      protocolVersion: 3,
    },
  }));

  await assert.rejects(
    () => client.start(),
    /requires SIXDUCK_OPENCLAW_GATEWAY_URL to use wss:\/\//i,
  );
});

test('OpenClawGatewayClient sends hydrated instructions and input items to chat.send', async () => {
  const originalWebSocket = globalThis.WebSocket;
  const sentRequests = [];

  class FakeWebSocket {
    readyState = 1;
    listeners = new Map();

    constructor() {
      setTimeout(() => {
        this.emit('open', {});
        this.emit('message', {
          data: JSON.stringify({
            type: 'event',
            event: 'connect.challenge',
            payload: { challenge: 'ok' },
          }),
        });
      }, 0);
    }

    addEventListener(name, handler) {
      const handlers = this.listeners.get(name) ?? [];
      handlers.push(handler);
      this.listeners.set(name, handlers);
    }

    close() {
      this.readyState = 3;
      this.emit('close', {});
    }

    send(raw) {
      const frame = JSON.parse(raw);
      sentRequests.push(frame);

      if (frame.method === 'connect') {
        this.emit('message', {
          data: JSON.stringify({
            type: 'res',
            id: frame.id,
            ok: true,
            payload: { protocol: 3 },
          }),
        });
        return;
      }

      if (frame.method === 'chat.send') {
        this.emit('message', {
          data: JSON.stringify({
            type: 'res',
            id: frame.id,
            ok: true,
            payload: {
              runId: 'run-1',
              status: 'completed',
              reply: 'Done',
            },
          }),
        });
      }
    }

    emit(name, event) {
      for (const handler of this.listeners.get(name) ?? []) {
        handler(event);
      }
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  let client;

  try {
    client = new OpenClawGatewayClient(buildConfig());
    const threadId = await client.ensureThread({
      systemPrompt: 'System prompt',
      baseInstructions: 'Base instructions',
      developerInstructions: 'Developer instructions',
      metadata: {
        browser_thread_id: 'thread-1',
        projection_context: { agent_profile_id: 'agent-1' },
      },
    });

    const events = [];
    await client.runTurn({
      threadId,
      inputText: 'Raw task',
      inputItems: [{ type: 'text', text: 'Hydrated task with memory context' }],
      onEvent: async (event) => {
        events.push(event);
      },
    });

    const chatSend = sentRequests.find((entry) => entry.method === 'chat.send');
    assert.ok(chatSend);
    assert.equal(chatSend.params.sessionKey, threadId);
    assert.match(chatSend.params.message, /System prompt/);
    assert.match(chatSend.params.message, /Developer instructions/);
    assert.match(chatSend.params.message, /Hydrated task with memory context/);
    assert.deepEqual(chatSend.params.instructions, {
      system_prompt: 'System prompt',
      base_instructions: 'Base instructions',
      developer_instructions: 'Developer instructions',
    });
    assert.deepEqual(chatSend.params.metadata.projection_context, { agent_profile_id: 'agent-1' });
    assert.deepEqual(chatSend.params.inputItems, [{ type: 'text', text: 'Hydrated task with memory context' }]);
    assert.deepEqual(client.getCapabilities().structured_context, {
      instructions: true,
      metadata: true,
      input_items: true,
      fallback_mode: 'native',
    });
    assert.deepEqual(events, [
      { type: 'turn.started', runtimeTurnId: 'run-1' },
      { type: 'assistant.completed', text: 'Done' },
      { type: 'turn.completed', status: 'completed' },
    ]);
  } finally {
    await client?.stop();
    globalThis.WebSocket = originalWebSocket;
  }
});

test('OpenClawGatewayClient falls back to text envelope when structured context is rejected', async () => {
  const originalWebSocket = globalThis.WebSocket;
  const sentRequests = [];

  class FakeWebSocket {
    readyState = 1;
    listeners = new Map();

    constructor() {
      setTimeout(() => {
        this.emit('open', {});
        this.emit('message', {
          data: JSON.stringify({
            type: 'event',
            event: 'connect.challenge',
            payload: { challenge: 'ok' },
          }),
        });
      }, 0);
    }

    addEventListener(name, handler) {
      const handlers = this.listeners.get(name) ?? [];
      handlers.push(handler);
      this.listeners.set(name, handlers);
    }

    close() {
      this.readyState = 3;
      this.emit('close', {});
    }

    send(raw) {
      const frame = JSON.parse(raw);
      sentRequests.push(frame);

      if (frame.method === 'connect') {
        this.emit('message', {
          data: JSON.stringify({
            type: 'res',
            id: frame.id,
            ok: true,
            payload: { protocol: 3 },
          }),
        });
        return;
      }

      if (frame.method === 'chat.send' && frame.params.inputItems) {
        this.emit('message', {
          data: JSON.stringify({
            type: 'res',
            id: frame.id,
            ok: false,
            error: { message: 'unknown field: inputItems' },
          }),
        });
        return;
      }

      if (frame.method === 'chat.send') {
        this.emit('message', {
          data: JSON.stringify({
            type: 'res',
            id: frame.id,
            ok: true,
            payload: {
              runId: 'run-fallback',
              status: 'completed',
              reply: 'Fallback done',
            },
          }),
        });
      }
    }

    emit(name, event) {
      for (const handler of this.listeners.get(name) ?? []) {
        handler(event);
      }
    }
  }

  globalThis.WebSocket = FakeWebSocket;
  let client;

  try {
    client = new OpenClawGatewayClient(buildConfig());
    const threadId = await client.ensureThread({
      systemPrompt: 'System prompt',
      developerInstructions: 'Developer instructions',
      metadata: {
        projection_context: { agent_profile_id: 'agent-1' },
      },
    });

    const events = [];
    await client.runTurn({
      threadId,
      inputText: 'Raw task',
      inputItems: [{ type: 'text', text: 'Hydrated fallback task' }],
      onEvent: async (event) => {
        events.push(event);
      },
    });

    const chatSends = sentRequests.filter((entry) => entry.method === 'chat.send');
    assert.equal(chatSends.length, 2);
    assert.ok(chatSends[0].params.inputItems);
    assert.equal(chatSends[1].params.inputItems, undefined);
    assert.equal(chatSends[1].params.instructions, undefined);
    assert.equal(chatSends[1].params.metadata, undefined);
    assert.match(chatSends[1].params.message, /System prompt/);
    assert.match(chatSends[1].params.message, /Hydrated fallback task/);
    assert.deepEqual(client.getCapabilities().structured_context, {
      instructions: false,
      metadata: false,
      input_items: false,
      fallback_mode: 'text_envelope',
    });
    assert.deepEqual(events, [
      { type: 'turn.started', runtimeTurnId: 'run-fallback' },
      { type: 'assistant.completed', text: 'Fallback done' },
      { type: 'turn.completed', status: 'completed' },
    ]);
  } finally {
    await client?.stop();
    globalThis.WebSocket = originalWebSocket;
  }
});
