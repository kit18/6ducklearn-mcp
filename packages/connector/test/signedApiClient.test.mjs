import test from 'node:test';
import assert from 'node:assert/strict';
import { SignedApiClient } from '../dist/signedApiClient.js';

function buildConfig(overrides = {}) {
  const base = {
    supabaseUrl: 'https://example.supabase.co',
    tokenId: 'token-id',
    hmacSecret: 'a'.repeat(64),
    oauthAccessToken: null,
    oauthRefreshToken: null,
    oauthClientId: null,
    oauthTokenEndpoint: null,
    oauthExpiresAt: null,
    oauthSessionPath: null,
    oauthScope: null,
    oauthResource: null,
    oauthRuntimeType: null,
    oauthTokenId: null,
    oauthAgentId: null,
    deviceId: 'device-id',
    deviceName: 'Test Device',
    runtimeType: 'codex',
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
      allowInsecureLocalAuth: false,
      sessionKey: 'main',
      protocolVersion: 3,
    },
    hermes: {
      baseUrl: '',
      apiKey: null,
      conversationPrefix: '6ducklearn',
    },
  };

  return {
    ...base,
    ...overrides,
    codex: {
      ...base.codex,
      ...(overrides.codex ?? {}),
    },
    openclaw: {
      ...base.openclaw,
      ...(overrides.openclaw ?? {}),
    },
    hermes: {
      ...base.hermes,
      ...(overrides.hermes ?? {}),
    },
  };
}

test('SignedApiClient can authenticate connector calls with an OAuth access token', async () => {
  const client = new SignedApiClient(buildConfig({
    tokenId: null,
    hmacSecret: null,
    oauthAccessToken: 'oauth-access-token',
  }));
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        connection: {
          id: 'conn-1',
          status: 'online',
          runtime_type: 'codex',
          device_id: 'device-id',
          device_name: 'Test Device',
        },
      }),
    };
  };

  try {
    await client.registerConnection('0.117.0');

    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.headers.Authorization, 'Bearer oauth-access-token');
    assert.equal(requests[0].options.headers['x-token-id'], undefined);
    assert.equal(requests[0].options.headers['x-agent-signature'], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SignedApiClient calls Local Profile Projection control-plane routes with OAuth', async () => {
  const client = new SignedApiClient(buildConfig({
    tokenId: null,
    hmacSecret: null,
    oauthAccessToken: 'oauth-access-token',
  }));
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    const parsedUrl = new URL(String(url));
    const rawBody = typeof options.body === 'string' ? options.body : '{}';
    const body = JSON.parse(rawBody);

    if (parsedUrl.pathname.endsWith('/agent-control-plane/agents/agent-1/projections')) {
      assert.equal(options.method, 'POST');
      assert.equal(body.local_profile_key, 'hermes:research');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          projection: {
            id: 'projection-1',
            agent_id: 'agent-1',
            connection_id: body.connection_id,
            runtime_type: 'hermes',
            local_profile_key: body.local_profile_key,
            status: 'active',
          },
        }),
      };
    }

    if (parsedUrl.pathname.endsWith('/agent-control-plane/projections/projection-1/sync/pull')) {
      assert.equal(options.method, 'POST');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          projection: { id: 'projection-1' },
          sync: { id: 'sync-1', result_profile_hash: 'hash-1' },
          runtime_projection: {
            agent_id: 'agent-1',
            runtime_type: 'hermes',
            local_profile_key: 'hermes:research',
            skill_packs: [],
          },
          skipped_locks: [],
        }),
      };
    }

    if (parsedUrl.pathname.endsWith('/agent-control-plane/projections/projection-1/sync/sync-1/ack')) {
      assert.equal(options.method, 'POST');
      assert.equal(body.profile_hash, 'hash-1');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          projection: { id: 'projection-1', last_profile_hash: 'hash-1' },
          sync: { id: 'sync-1', status: 'succeeded' },
        }),
      };
    }

    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const bind = await client.bindLocalProfileProjection('agent-1', {
      runtime_type: 'hermes',
      local_profile_key: 'hermes:research',
      token_id: 'token-1',
      connection_id: 'connection-1',
      sync_policy: { mode: 'manual' },
    });
    const pull = await client.pullLocalProfileProjection(bind.projection.id);
    const ack = await client.ackLocalProfileProjectionSync(
      bind.projection.id,
      pull.sync.id,
      pull.sync.result_profile_hash,
    );

    assert.equal(requests.length, 3);
    assert.ok(requests.every((request) => request.options.headers.Authorization === 'Bearer oauth-access-token'));
    assert.equal(ack.sync.status, 'succeeded');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SignedApiClient refreshes an expiring OAuth token before connector calls', async () => {
  const client = new SignedApiClient(buildConfig({
    tokenId: null,
    hmacSecret: null,
    oauthAccessToken: 'old-access-token',
    oauthRefreshToken: 'refresh-token',
    oauthClientId: 'client-1',
    oauthTokenEndpoint: 'https://example.supabase.co/functions/v1/oauth/mcp/token',
    oauthExpiresAt: new Date(Date.now() - 1000).toISOString(),
    oauthScope: 'runtime:connect',
  }));
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/oauth/mcp/token')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          access_token: 'fresh-access-token',
          refresh_token: 'fresh-refresh-token',
          expires_in: 3600,
          scope: 'runtime:connect control:read',
        }),
      };
    }

    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        connection: {
          id: 'conn-1',
          status: 'online',
          runtime_type: 'codex',
          device_id: 'device-id',
          device_name: 'Test Device',
        },
      }),
    };
  };

  try {
    await client.registerConnection('0.117.0');

    assert.equal(requests.length, 2);
    assert.equal(requests[0].url, 'https://example.supabase.co/functions/v1/oauth/mcp/token');
    assert.equal(String(requests[0].options.body).includes('grant_type=refresh_token'), true);
    assert.equal(String(requests[0].options.body).includes('refresh_token=refresh-token'), true);
    assert.equal(requests[1].options.headers.Authorization, 'Bearer fresh-access-token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SignedApiClient retries transient console-push failures with non-JSON bodies', async () => {
  const client = new SignedApiClient(buildConfig());
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const calls = [];
  const responses = [
    { ok: false, status: 503, body: '<html>Service Unavailable</html>' },
    { ok: true, status: 200, body: JSON.stringify({ interrupt_requested: false }) },
  ];

  globalThis.setTimeout = ((fn, _delay, ...args) => {
    fn(...args);
    return 0;
  });
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    const next = responses.shift();
    if (!next) {
      throw new Error('No mocked response left');
    }
    return {
      ok: next.ok,
      status: next.status,
      text: async () => next.body,
    };
  };

  try {
    const result = await client.push({
      connectionId: '11111111-1111-1111-1111-111111111111',
      turnId: '22222222-2222-2222-2222-222222222222',
      state: 'claimed',
      runtimeThreadId: 'thread-1',
      runtimeTurnId: undefined,
      threadTitle: 'Example thread',
      errorMessage: undefined,
      events: [],
    });

    assert.equal(calls.length, 2);
    assert.equal(result.interrupt_requested, false);
    assert.ok(calls.every((call) => call.url.endsWith('/functions/v1/console-push')));
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('SignedApiClient does not retry non-retryable console-push failures', async () => {
  const client = new SignedApiClient(buildConfig());
  const originalFetch = globalThis.fetch;
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: 'Bad request' } }),
    };
  };

  try {
    await assert.rejects(
      () =>
        client.push({
          connectionId: '11111111-1111-1111-1111-111111111111',
          turnId: '22222222-2222-2222-2222-222222222222',
          state: 'claimed',
          runtimeThreadId: 'thread-1',
          runtimeTurnId: undefined,
          threadTitle: 'Example thread',
          errorMessage: undefined,
          events: [],
        }),
      /Bad request/,
    );

    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SignedApiClient stops retrying transient console-push failures after the retry budget', async () => {
  const client = new SignedApiClient(buildConfig());
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let calls = 0;

  globalThis.setTimeout = ((fn, _delay, ...args) => {
    fn(...args);
    return 0;
  });
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: false,
      status: 503,
      text: async () => JSON.stringify({ error: { message: 'Boot error' } }),
    };
  };

  try {
    await assert.rejects(
      () =>
        client.push({
          connectionId: '11111111-1111-1111-1111-111111111111',
          turnId: '22222222-2222-2222-2222-222222222222',
          state: 'claimed',
          runtimeThreadId: 'thread-1',
          runtimeTurnId: undefined,
          threadTitle: 'Example thread',
          errorMessage: undefined,
          events: [],
        }),
      /retry budget exhausted/,
    );

    assert.equal(calls, 8);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('SignedApiClient registers Hermes connections with Hermes capability metadata', async () => {
  const client = new SignedApiClient(buildConfig({
    runtimeType: 'hermes',
    hermes: {
      baseUrl: 'http://127.0.0.1:2468',
      apiKey: null,
      conversationPrefix: '6ducklearn',
    },
  }));
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        connection: {
          id: 'conn-1',
          status: 'online',
          runtime_type: 'hermes',
          device_id: 'device-id',
          device_name: 'Test Device',
        },
      }),
    };
  };

  try {
    await client.registerConnection('0.8.0');

    assert.equal(requests.length, 1);
    const body = JSON.parse(String(requests[0].options.body));
    assert.equal(body.runtime_type, 'hermes');
    assert.equal(body.capabilities.runtime, 'hermes');
    assert.equal(body.capabilities.transport, 'http-sse');
    assert.equal(body.capabilities.protocol, 'hermes-api-server');
    assert.equal(body.capabilities.features.interrupt, false);
    assert.equal(body.capabilities.features.approvals, false);
    assert.equal(body.capabilities.base_url, 'http://127.0.0.1:2468');
    assert.equal(body.capabilities.conversation_prefix, '6ducklearn');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SignedApiClient sends portable expert playbook permission requests through agent-mcp-tools', async () => {
  const client = new SignedApiClient(buildConfig({ runtimeType: 'hermes' }));
  const originalFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: {
          decision: {
            decision: 'requires_approval',
            actionCategory: 'publish_publicly',
          },
        },
      }),
    };
  };

  try {
    await client.requestPlaybookPermission({
      expertProfileId: 'expert-1',
      playbookId: 'playbook-1',
      playbookVersionId: 'version-1',
      runtimeSessionId: 'runtime-session-1',
      actionCategory: 'publish_publicly',
      boundary: 'require_approval',
      resourceId: 'company-linkedin',
      environment: 'production',
      title: 'Approve company post',
      description: 'The expert wants to publish externally.',
      previewHtml: '<p>Draft</p>',
    });

    assert.equal(requests.length, 1);
    assert.ok(requests[0].url.endsWith('/functions/v1/agent-mcp-tools'));
    const body = JSON.parse(String(requests[0].options.body));
    assert.equal(body.action, 'request_permission');
    assert.equal(body.runtime_type, 'hermes');
    assert.equal(body.expert_profile_id, 'expert-1');
    assert.equal(body.action_category, 'publish_publicly');
    assert.equal(body.resource_id, 'company-linkedin');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SignedApiClient spawns experts with run linkage for task and snapshot auditing', async () => {
  const client = new SignedApiClient(buildConfig({ runtimeType: 'openclaw' }));
  const originalFetch = globalThis.fetch;
  let requestBody = null;

  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(String(options.body));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: {
          runtime_session: {
            id: 'runtime-session-1',
          },
        },
      }),
    };
  };

  try {
    await client.spawnExpert({
      expertProfileId: 'expert-1',
      playbookId: 'playbook-1',
      playbookVersionId: 'version-1',
      runtimeSessionKey: 'openclaw:session-1',
      runSpecId: 'run-spec-1',
      taskId: 'task-1',
      payload: {
        model_snapshot: {
          model: 'openclaw-local',
        },
      },
    });

    assert.equal(requestBody.action, 'spawn_expert');
    assert.equal(requestBody.runtime_type, 'openclaw');
    assert.equal(requestBody.run_spec_id, 'run-spec-1');
    assert.equal(requestBody.task_id, 'task-1');
    assert.deepEqual(requestBody.payload.model_snapshot, { model: 'openclaw-local' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('SignedApiClient can submit playbook memory proposals without mutating expert memory directly', async () => {
  const client = new SignedApiClient(buildConfig());
  const originalFetch = globalThis.fetch;
  let requestBody = null;

  globalThis.fetch = async (_url, options) => {
    requestBody = JSON.parse(String(options.body));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        data: {
          proposal: {
            id: 'proposal-1',
            status: 'pending',
          },
        },
      }),
    };
  };

  try {
    await client.proposePlaybookMemory({
      expertProfileId: 'expert-1',
      runtimeSessionId: 'runtime-session-1',
      memoryBranchId: 'branch-1',
      targetType: 'rule',
      proposedContent: 'Always separate facts from interpretation.',
      sourceExcerpt: 'The user corrected the draft structure.',
    });

    assert.equal(requestBody.action, 'propose_memory');
    assert.equal(requestBody.target_type, 'rule');
    assert.equal(requestBody.proposed_content, 'Always separate facts from interpretation.');
    assert.equal(requestBody.memory_branch_id, 'branch-1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
