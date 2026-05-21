import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CodexAppServerClient,
  buildCodexAppServerArgs,
  isQuietProfileCodexStderrNoise,
} from '../dist/codexAppServerClient.js';

function buildConfig(overrides = {}) {
  const { codex: codexOverrides, openclaw: openclawOverrides, ...rootOverrides } = overrides;

  return {
    supabaseUrl: 'https://example.supabase.co',
    tokenId: 'token-id',
    hmacSecret: 'a'.repeat(64),
    deviceId: 'device-id',
    deviceName: 'Test Device',
    runtimeType: 'codex',
    pollIntervalMs: 2000,
    heartbeatIntervalMs: 20_000,
    serviceName: '6ducklearn_connector',
    adapterVersion: '0.2.0',
    ...rootOverrides,
    codex: {
      model: 'gpt-5.4',
      reasoningEffort: 'medium',
      summary: 'concise',
      cwd: '/tmp/workspace',
      minVersion: '0.117.0',
      quietProfile: true,
      ...(codexOverrides ?? {}),
    },
    openclaw: {
      gatewayUrl: 'ws://127.0.0.1:18789',
      gatewayToken: null,
      gatewayPassword: null,
      allowInsecureLocalAuth: false,
      sessionKey: 'main',
      protocolVersion: 3,
      ...(openclawOverrides ?? {}),
    },
  };
}

test('CodexAppServerClient accepts supported Codex CLI versions', () => {
  const client = new CodexAppServerClient(buildConfig());

  assert.doesNotThrow(() => client.ensureSupportedVersion('codex-cli 0.117.0'));
  assert.doesNotThrow(() => client.ensureSupportedVersion('0.117.1'));
  assert.doesNotThrow(() => client.ensureSupportedVersion('0.118.0'));
});

test('CodexAppServerClient rejects missing or too-old Codex CLI versions', () => {
  const client = new CodexAppServerClient(buildConfig());

  assert.throws(
    () => client.ensureSupportedVersion(null),
    /Unable to detect Codex CLI version/i,
  );
  assert.throws(
    () => client.ensureSupportedVersion('0.116.9'),
    /too old/i,
  );
});

test('CodexAppServerClient reports the expected Codex capabilities', () => {
  const config = buildConfig();
  const client = new CodexAppServerClient(config);

  assert.deepEqual(client.getCapabilities(), {
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
    cwd: config.codex.cwd,
    model: config.codex.model,
  });
});

test('CodexAppServerClient starts app-server in quiet profile by default', () => {
  const config = buildConfig();

  assert.deepEqual(buildCodexAppServerArgs(config), [
    'app-server',
    '-c',
    'mcp_servers={}',
    '-c',
    'plugins={}',
    '-c',
    'notify=[]',
  ]);
});

test('CodexAppServerClient can opt into inherited local Codex config', () => {
  const config = buildConfig({ codex: { quietProfile: false } });

  assert.deepEqual(buildCodexAppServerArgs(config), ['app-server']);
});

test('CodexAppServerClient suppresses known quiet-profile stderr noise', () => {
  assert.equal(
    isQuietProfileCodexStderrNoise(
      'ERROR codex_core::session: failed to load skill /Users/example/.agents/skills/demo/SKILL.md: invalid YAML',
    ),
    true,
  );
  assert.equal(
    isQuietProfileCodexStderrNoise(
      '{"level":"WARN","fields":{"message":"failed to warm featured plugin ids cache","error":"remote plugin sync request failed"}}',
    ),
    true,
  );
  assert.equal(
    isQuietProfileCodexStderrNoise(
      'ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed, when AuthRequired',
    ),
    true,
  );
  assert.equal(isQuietProfileCodexStderrNoise('ERROR codex_core::session: real runtime failure'), false);
});

test('CodexAppServerClient emits assistant.completed after streamed deltas', async () => {
  const client = new CodexAppServerClient(buildConfig());
  const events = [];
  let notificationHandler = null;

  client.onNotification = (handler) => {
    notificationHandler = handler;
    return () => {};
  };
  client.onServerRequest = () => () => {};
  client.request = async (method) => {
    if (method !== 'turn/start') {
      throw new Error(`Unexpected method: ${method}`);
    }

    setImmediate(() => {
      void (async () => {
        await notificationHandler({
          method: 'turn/started',
          params: {
            threadId: 'thread-1',
            turn: { id: 'runtime-turn-1' },
          },
        });
        await notificationHandler({
          method: 'item/agentMessage/delta',
          params: {
            threadId: 'thread-1',
            turnId: 'runtime-turn-1',
            delta: 'Tesla is a ',
          },
        });
        await notificationHandler({
          method: 'item/completed',
          params: {
            threadId: 'thread-1',
            turnId: 'runtime-turn-1',
            item: {
              type: 'agentMessage',
              text: 'Tesla is a strong company with a stretched valuation.',
            },
          },
        });
        await notificationHandler({
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: 'thread-1',
            tokenUsage: {
              last: {
                inputTokens: 4100,
                outputTokens: 1800,
                totalTokens: 5900,
              },
            },
          },
        });
        await notificationHandler({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: { id: 'runtime-turn-1', status: 'completed' },
          },
        });
      })();
    });

    return { turn: { id: 'runtime-turn-1' } };
  };

  await client.runTurn({
    threadId: 'thread-1',
    inputText: 'Give me the report',
    onEvent: async (event) => {
      events.push(event);
    },
  });

  assert.deepEqual(events, [
    { type: 'turn.started', runtimeTurnId: 'runtime-turn-1' },
    { type: 'assistant.delta', text: 'Tesla is a ' },
    { type: 'assistant.completed', text: 'Tesla is a strong company with a stretched valuation.' },
    {
      type: 'turn.completed',
      status: 'completed',
      message: undefined,
      usage: {
        input_tokens: 4100,
        output_tokens: 1800,
        total_tokens: 5900,
      },
    },
  ]);
});

test('CodexAppServerClient captures token usage that arrives just after turn completion', async () => {
  const client = new CodexAppServerClient(buildConfig());
  const events = [];
  let notificationHandler = null;

  client.onNotification = (handler) => {
    notificationHandler = handler;
    return () => {};
  };
  client.onServerRequest = () => () => {};
  client.request = async (method) => {
    if (method !== 'turn/start') {
      throw new Error(`Unexpected method: ${method}`);
    }

    setImmediate(() => {
      void (async () => {
        await notificationHandler({
          method: 'turn/started',
          params: {
            threadId: 'thread-1',
            turn: { id: 'runtime-turn-1' },
          },
        });
        const completed = notificationHandler({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: { id: 'runtime-turn-1', status: 'completed' },
          },
        });
        await notificationHandler({
          method: 'thread/tokenUsage/updated',
          params: {
            threadId: 'thread-1',
            tokenUsage: {
              last: {
                inputTokens: 1200,
                outputTokens: 700,
                totalTokens: 1900,
              },
            },
          },
        });
        await completed;
      })();
    });

    return { turn: { id: 'runtime-turn-1' } };
  };

  await client.runTurn({
    threadId: 'thread-1',
    inputText: 'Finish the short check',
    onEvent: async (event) => {
      events.push(event);
    },
  });

  assert.deepEqual(events.at(-1), {
    type: 'turn.completed',
    status: 'completed',
    message: undefined,
    usage: {
      input_tokens: 1200,
      output_tokens: 700,
      total_tokens: 1900,
    },
  });
});

test('CodexAppServerClient forwards sandbox overrides and reviewer settings when ensuring threads', async () => {
  const client = new CodexAppServerClient(buildConfig());
  const calls = [];

  client.request = async (method, params) => {
    calls.push({ method, params });
    return { thread: { id: params.threadId ?? 'thread-started' } };
  };

  await client.ensureThread({
    baseInstructions: 'Protect the 6DuckLearn soul contract.',
    developerInstructions: 'Load memory and session context as developer instructions.',
    sandbox: { 'read-only': null },
  });
  await client.ensureThread({
    runtimeThreadId: 'thread-123',
    systemPrompt: 'Fallback prompt for older callers',
    sandbox: 'workspace-write',
  });

  assert.deepEqual(calls, [
    {
      method: 'thread/start',
      params: {
        model: 'gpt-5.4',
        cwd: '/tmp/workspace',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: { 'read-only': null },
        serviceName: '6ducklearn_connector',
        baseInstructions: 'Protect the 6DuckLearn soul contract.',
        developerInstructions: 'Load memory and session context as developer instructions.',
        experimentalRawEvents: false,
        persistExtendedHistory: true,
      },
    },
    {
      method: 'thread/resume',
      params: {
        threadId: 'thread-123',
        cwd: '/tmp/workspace',
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        sandbox: 'workspace-write',
        baseInstructions: undefined,
        developerInstructions: 'Fallback prompt for older callers',
        persistExtendedHistory: true,
      },
    },
  ]);
});

test('CodexAppServerClient forwards sandboxPolicy when starting turns', async () => {
  const client = new CodexAppServerClient(buildConfig());
  let notificationHandler = null;
  let requestPayload = null;

  client.onNotification = (handler) => {
    notificationHandler = handler;
    return () => {};
  };
  client.onServerRequest = () => () => {};
  client.request = async (method, params) => {
    if (method !== 'turn/start') {
      throw new Error(`Unexpected method: ${method}`);
    }

    requestPayload = params;
    setImmediate(() => {
      void (async () => {
        await notificationHandler({
          method: 'turn/started',
          params: {
            threadId: 'thread-1',
            turn: { id: 'runtime-turn-1' },
          },
        });
        await notificationHandler({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: { id: 'runtime-turn-1', status: 'completed' },
          },
        });
      })();
    });

    return { turn: { id: 'runtime-turn-1' } };
  };

  await client.runTurn({
    threadId: 'thread-1',
    inputText: 'Write the file',
    sandboxPolicy: { type: 'readOnly', access: { type: 'fullAccess' }, networkAccess: false },
    onEvent: () => {},
  });

  assert.deepEqual(requestPayload, {
    threadId: 'thread-1',
    input: [{ type: 'text', text: 'Write the file' }],
    model: 'gpt-5.4',
    effort: 'medium',
    summary: 'concise',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
    sandboxPolicy: { type: 'readOnly', access: { type: 'fullAccess' }, networkAccess: false },
  });
});

test('CodexAppServerClient forwards structured input items when provided', async () => {
  const client = new CodexAppServerClient(buildConfig());
  let notificationHandler = null;
  let requestPayload = null;

  client.onNotification = (handler) => {
    notificationHandler = handler;
    return () => {};
  };
  client.onServerRequest = () => () => {};
  client.request = async (method, params) => {
    if (method !== 'turn/start') {
      throw new Error(`Unexpected method: ${method}`);
    }

    requestPayload = params;
    setImmediate(() => {
      void (async () => {
        await notificationHandler({
          method: 'turn/started',
          params: {
            threadId: 'thread-1',
            turn: { id: 'runtime-turn-1' },
          },
        });
        await notificationHandler({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: { id: 'runtime-turn-1', status: 'completed' },
          },
        });
      })();
    });

    return { turn: { id: 'runtime-turn-1' } };
  };

  await client.runTurn({
    threadId: 'thread-1',
    inputText: 'Ignored fallback input',
    inputItems: [
      { type: 'text', text: 'Use the attached skill' },
      { type: 'skill', name: 'research-pack', path: '/tmp/research-pack/SKILL.md' },
    ],
    onEvent: () => {},
  });

  assert.deepEqual(requestPayload, {
    threadId: 'thread-1',
    input: [
      { type: 'text', text: 'Use the attached skill' },
      { type: 'skill', name: 'research-pack', path: '/tmp/research-pack/SKILL.md' },
    ],
    model: 'gpt-5.4',
    effort: 'medium',
    summary: 'concise',
    approvalPolicy: 'on-request',
    approvalsReviewer: 'user',
  });
});

test('CodexAppServerClient auto-rejects approvals for denied action types', async () => {
  const client = new CodexAppServerClient(buildConfig());
  let notificationHandler = null;
  let serverRequestHandler = null;
  let approvalRequested = false;
  let replyPayload = null;

  client.onNotification = (handler) => {
    notificationHandler = handler;
    return () => {};
  };
  client.onServerRequest = (handler) => {
    serverRequestHandler = handler;
    return () => {};
  };
  client.reply = async (id, result) => {
    replyPayload = { id, result };
  };
  client.request = async (method) => {
    if (method !== 'turn/start') {
      throw new Error(`Unexpected method: ${method}`);
    }

    setImmediate(() => {
      void (async () => {
        await notificationHandler({
          method: 'turn/started',
          params: {
            threadId: 'thread-1',
            turn: { id: 'runtime-turn-1' },
          },
        });
        await serverRequestHandler({
          id: 42,
          method: 'item/fileChange/requestApproval',
          params: {
            threadId: 'thread-1',
            turnId: 'runtime-turn-1',
            grantRoot: '/tmp/workspace',
          },
        });
        await notificationHandler({
          method: 'turn/completed',
          params: {
            threadId: 'thread-1',
            turn: { id: 'runtime-turn-1', status: 'completed' },
          },
        });
      })();
    });

    return { turn: { id: 'runtime-turn-1' } };
  };

  await client.runTurn({
    threadId: 'thread-1',
    inputText: 'Try a blocked write',
    approvalRules: { pkm_write: 'deny' },
    onApprovalRequest: async () => {
      approvalRequested = true;
      return { decision: 'approve' };
    },
    onEvent: () => {},
  });

  assert.equal(approvalRequested, false);
  assert.deepEqual(replyPayload, {
    id: 42,
    result: { decision: 'decline' },
  });
});
