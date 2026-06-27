import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HermesApiServerClient } from '../dist/hermesApiServerClient.js';
import {
  buildRuntimeInputItems,
  isTransientConnectorNetworkError,
  processConnectorTurn,
  resolveCodexRuntimePolicy,
} from '../dist/runner.js';

test('resolveCodexRuntimePolicy defaults risky capabilities to approval-gated read-only execution', () => {
  assert.deepEqual(resolveCodexRuntimePolicy(null), {
    approvalRules: {
      external_api: 'require_approval',
      pkm_write: 'require_approval',
    },
    threadSandbox: { 'read-only': null },
    turnSandboxPolicy: { type: 'readOnly', access: { type: 'fullAccess' }, networkAccess: false },
  });
});

test('resolveCodexRuntimePolicy honors trust-all without bypassing private-write approval', () => {
  assert.deepEqual(
    resolveCodexRuntimePolicy({
      approval_level: 'trust-all',
      data_boundaries: {
        external_api: { user_setting: 'require_approval' },
        pkm_write: { user_setting: 'require_approval' },
      },
    }),
    {
      approvalRules: {
        external_api: 'auto',
        pkm_write: 'require_approval',
      },
      threadSandbox: { 'read-only': null },
      turnSandboxPolicy: { type: 'readOnly', access: { type: 'fullAccess' }, networkAccess: false },
    },
  );
});

test('resolveCodexRuntimePolicy preserves mixed boundary settings from token data', () => {
  assert.deepEqual(
    resolveCodexRuntimePolicy({
      approval_level: 'approve-risky',
      data_boundaries: {
        external_api: { user_setting: 'auto' },
        pkm_write: { user_setting: 'deny' },
      },
    }),
    {
      approvalRules: {
        external_api: 'auto',
        pkm_write: 'deny',
      },
      threadSandbox: { 'read-only': null },
      turnSandboxPolicy: { type: 'readOnly', access: { type: 'fullAccess' }, networkAccess: false },
    },
  );
});

test('buildRuntimeInputItems emits Codex skill markers, attachment summary, and valid skill files', () => {
  const previousHome = process.env.HOME;
  const tempHome = mkdtempSync(join(tmpdir(), '6ducklearn-connector-home-'));
  process.env.HOME = tempHome;

  try {
    const inputItems = buildRuntimeInputItems({
      runtimeType: 'codex',
      connectionId: 'conn-123',
      inputText: 'Review the runtime merge.',
      attachments: [
        {
          kind: 'mcp_server',
          id: '6ducklearn',
          label: '6DuckLearn',
          source: '6ducklearn-remote',
          enabled: true,
          description: 'Remote 6DuckLearn MCP server',
        },
        {
          kind: 'mcp_tool',
          id: 'tool:search_skill_library',
          label: 'Search Skill Library',
          source: '6ducklearn-remote',
          enabled: true,
          description: 'Search the shared skill catalog.',
        },
        {
          kind: 'skill',
          id: 'skill:builder_workbench',
          label: 'Builder Workbench',
          source: '6ducklearn-remote',
          enabled: true,
          description: 'Reusable build playbook.',
          skill_name: 'Builder Workbench',
          content: 'Use the Builder Workbench playbook.',
        },
      ],
      projectedSkillModules: [
        {
          id: 'skill-pack:deep_research',
          name: 'duck-skill-pack-deep-research',
          label: 'Deep Research',
          description: '6DuckLearn skill pack: Deep Research',
          content: 'Use the Deep Research pack.',
        },
      ],
    });

    assert.ok(inputItems);
    assert.equal(inputItems.length, 3);

    const textItem = inputItems[0];
    assert.equal(textItem.type, 'text');
    assert.match(textItem.text, /\$builder-workbench/);
    assert.match(textItem.text, /\$duck-skill-pack-deep-research/);
    assert.match(textItem.text, /Enabled 6DuckLearn session attachments:/);
    assert.match(textItem.text, /Skills:/);
    assert.match(textItem.text, /MCP Servers:/);
    assert.match(textItem.text, /MCP Tools:/);
    assert.match(textItem.text, /Review the runtime merge\./);

    const skillItem = inputItems[1];
    assert.equal(skillItem.type, 'skill');
    assert.equal(skillItem.name, 'builder-workbench');
    assert.match(skillItem.path, /SKILL\.md$/);

    const skillFile = readFileSync(skillItem.path, 'utf8');
    assert.match(
      skillFile,
      /^---\nname: "builder-workbench"\ndescription: "Reusable build playbook\."\n---\n\nUse the Builder Workbench playbook\.\n$/,
    );

    const projectedSkillItem = inputItems[2];
    assert.equal(projectedSkillItem.type, 'skill');
    assert.equal(projectedSkillItem.name, 'duck-skill-pack-deep-research');
    assert.match(projectedSkillItem.path, /SKILL\.md$/);

    const projectedSkillFile = readFileSync(projectedSkillItem.path, 'utf8');
    assert.match(
      projectedSkillFile,
      /^---\nname: "duck-skill-pack-deep-research"\ndescription: "6DuckLearn skill pack: Deep Research"\n---\n\nUse the Deep Research pack\.\n$/,
    );
  } finally {
    process.env.HOME = previousHome;
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('buildRuntimeInputItems hydrates non-Codex runtimes with portable projection context', () => {
  const inputItems = buildRuntimeInputItems({
    runtimeType: 'openclaw',
    connectionId: 'conn-openclaw',
    inputText: 'Review the runtime merge.',
    attachments: [
      {
        kind: 'mcp_server',
        id: '6ducklearn',
        label: '6DuckLearn',
        source: '6ducklearn-remote',
        enabled: true,
        description: 'Remote 6DuckLearn MCP server',
      },
      {
        kind: 'mcp_tool',
        id: 'tool:search_skill_library',
        label: 'Search Skill Library',
        source: '6ducklearn-remote',
        enabled: true,
        description: 'Search the shared skill catalog.',
      },
      {
        kind: 'skill',
        id: 'skill:builder_workbench',
        label: 'Builder Workbench',
        source: '6ducklearn-remote',
        enabled: true,
        description: 'Reusable build playbook.',
        skill_name: 'Builder Workbench',
        content: 'Use the Builder Workbench playbook.',
      },
    ],
    projectedSkillModules: [
      {
        id: 'skill-pack:deep_research',
        name: 'duck-skill-pack-deep-research',
        label: 'Deep Research',
        description: '6DuckLearn skill pack: Deep Research',
        content: 'Use the Deep Research pack.',
      },
    ],
  });

  assert.ok(inputItems);
  assert.equal(inputItems.length, 1);
  assert.equal(inputItems[0].type, 'text');
  assert.match(inputItems[0].text, /Enabled 6DuckLearn session attachments:/);
  assert.match(inputItems[0].text, /Skills:/);
  assert.match(inputItems[0].text, /MCP Servers:/);
  assert.match(inputItems[0].text, /MCP Tools:/);
  assert.match(inputItems[0].text, /Projected 6DuckLearn skill modules:/);
  assert.match(inputItems[0].text, /duck-skill-pack-deep-research/);
  assert.match(inputItems[0].text, /Review the runtime merge\./);
});

test('processConnectorTurn runs a Hermes turn through portable projection and pushes runtime events', async () => {
  const calls = [];
  const runtime = {
    runtimeType: 'hermes',
    ensuredThreadContext: null,
    runTurnParams: null,
    async start() {},
    async stop() {},
    async detectRuntimeVersion() {
      return '1.2.3';
    },
    async checkHealth() {
      return {
        ok: true,
        status: 'healthy',
        checked_at: '2026-06-13T00:00:00.000Z',
      };
    },
    getCapabilities() {
      return {
        schema_version: '2026-03-29',
        runtime: 'hermes',
        transport: 'http-sse',
        protocol: 'hermes-api-server',
        structured_context: {
          instructions: true,
          metadata: false,
          input_items: false,
          fallback_mode: 'text_envelope',
        },
        features: {
          streaming: true,
          interrupt: false,
          approvals: false,
          session_sync: true,
          remote_access: false,
        },
      };
    },
    async ensureThread(context) {
      this.ensuredThreadContext = context;
      return 'hermes-conversation-1';
    },
    async interruptTurn() {
      calls.push({ kind: 'interrupt' });
    },
    async runTurn(params) {
      this.runTurnParams = params;
      await params.onEvent({ type: 'turn.started', runtimeTurnId: 'hermes-response-1' });
      await params.onEvent({ type: 'assistant.completed', text: 'Hermes completed the portable turn.' });
      await params.onEvent({ type: 'turn.completed', status: 'completed' });
    },
  };
  const api = {
    async heartbeat(...args) {
      calls.push({ kind: 'heartbeat', args });
      return { ok: true, connection_id: args[0], status: args[1] };
    },
    async push(params) {
      calls.push({ kind: 'push', params });
      return { ok: true, interrupt_requested: false, state: params.state ?? 'claimed' };
    },
  };

  await processConnectorTurn({
    api,
    runtime,
    connectionId: 'connection-hermes',
    runtimeVersion: '1.2.3',
    payload: buildPulledTurnPayload({
      runtimeType: 'hermes',
      inputText: 'Use the projected skill to summarize the remote session.',
    }),
  });

  assert.equal(runtime.ensuredThreadContext.metadata.runtime_type, 'hermes');
  assert.equal(runtime.ensuredThreadContext.systemPrompt, 'Stay grounded in projected 6DuckLearn context.');
  assert.equal(runtime.runTurnParams.threadId, 'hermes-conversation-1');
  assert.equal(runtime.runTurnParams.inputItems.length, 1);
  assert.equal(runtime.runTurnParams.inputItems[0].type, 'text');
  assert.match(runtime.runTurnParams.inputItems[0].text, /Projected 6DuckLearn skill modules:/);
  assert.match(runtime.runTurnParams.inputItems[0].text, /remote-session-review/);
  assert.match(runtime.runTurnParams.inputItems[0].text, /Use the projected skill to summarize the remote session\./);
  assert.equal(runtime.runTurnParams.sandboxPolicy.type, 'readOnly');
  assert.equal(calls.some((call) => call.kind === 'interrupt'), false);

  const pushes = calls.filter((call) => call.kind === 'push').map((call) => call.params);
  assert.equal(pushes.length, 3);
  assert.equal(pushes[0].runtimeThreadId, 'hermes-conversation-1');
  assert.equal(pushes[0].leaseToken, 'lease-1');
  assert.equal(pushes[0].runtimeAttempt, 1);
  assert.equal(pushes[1].state, 'streaming');
  assert.equal(pushes[1].runtimeTurnId, 'hermes-response-1');
  assert.deepEqual(pushes[1].events.map((event) => event.event_type), ['turn.status']);
  assert.equal(pushes[2].state, 'completed');
  assert.equal(pushes[2].runtimeTurnId, 'hermes-response-1');
  assert.deepEqual(pushes[2].events.map((event) => event.event_type), [
    'assistant.completed',
    'turn.status',
  ]);
});

test('processConnectorTurn drives the real Hermes adapter against a local Hermes API server', async () => {
  const requests = [];
  const server = await startHermesTestServer(async (req, res) => {
    if (req.url === '/v1/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.url === '/v1/responses') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      requests.push(JSON.parse(body));

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
      });
      res.write('event: response.created\n');
      res.write(`data: ${JSON.stringify({
        type: 'response.created',
        response: { id: 'hermes-response-actual-1' },
      })}\n\n`);
      res.write('event: response.completed\n');
      res.write(`data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'hermes-response-actual-1',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Hermes real adapter completed.' }],
            },
          ],
        },
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  });
  const runtime = new HermesApiServerClient(buildHermesConfig({
    hermes: {
      baseUrl: server.baseUrl,
      apiKey: null,
      conversationPrefix: '6ducklearn',
    },
  }));
  const calls = [];
  const api = {
    async heartbeat(...args) {
      calls.push({ kind: 'heartbeat', args });
      return { ok: true, connection_id: args[0], status: args[1] };
    },
    async push(params) {
      calls.push({ kind: 'push', params });
      return { ok: true, interrupt_requested: false, state: params.state ?? 'claimed' };
    },
  };

  try {
    await processConnectorTurn({
      api,
      runtime,
      connectionId: 'connection-hermes',
      runtimeVersion: '1.2.3',
      payload: buildPulledTurnPayload({
        runtimeType: 'hermes',
        inputText: 'Summarize active remote control state.',
      }),
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].conversation, '6ducklearn:thread-1');
    assert.equal(
      requests[0].instructions,
      [
        'Stay grounded in projected 6DuckLearn context.',
        'Use remote control-plane evidence only.',
        'Return concise status.',
      ].join('\n\n'),
    );
    assert.match(requests[0].input, /Projected 6DuckLearn skill modules:/);
    assert.match(requests[0].input, /remote-session-review/);
    assert.match(requests[0].input, /Summarize active remote control state\./);
    assert.deepEqual(requests[0].metadata.sixducklearn.input_items, [
      {
        type: 'text',
        text: requests[0].input,
      },
    ]);

    const heartbeat = calls.find((call) => call.kind === 'heartbeat');
    assert.equal(heartbeat.args[1], 'healthy');
    assert.equal(heartbeat.args[3].runtime_health.runtime_version, '1.2.3');

    const pushes = calls.filter((call) => call.kind === 'push').map((call) => call.params);
    assert.equal(pushes.length, 3);
    assert.equal(pushes[0].runtimeThreadId, '6ducklearn:thread-1');
    assert.equal(pushes[1].state, 'streaming');
    assert.equal(pushes[1].runtimeTurnId, 'hermes-response-actual-1');
    assert.equal(pushes[2].state, 'completed');
    assert.equal(pushes[2].runtimeTurnId, 'hermes-response-actual-1');
    assert.deepEqual(pushes[2].events.map((event) => event.event_type), [
      'assistant.completed',
      'turn.status',
    ]);
    assert.equal(pushes[2].events[0].payload.text, 'Hermes real adapter completed.');
  } finally {
    await server.close();
  }
});

test('processConnectorTurn runs a Codex turn with native projected skills and approval round-trip events', async () => {
  const previousHome = process.env.HOME;
  const tempHome = mkdtempSync(join(tmpdir(), '6ducklearn-connector-codex-home-'));
  process.env.HOME = tempHome;
  const calls = [];
  const runtime = {
    runtimeType: 'codex',
    ensuredThreadContext: null,
    runTurnParams: null,
    approvalResolution: null,
    async start() {},
    async stop() {},
    async detectRuntimeVersion() {
      return '0.117.0';
    },
    async checkHealth() {
      return {
        ok: true,
        status: 'healthy',
        checked_at: '2026-06-13T00:00:00.000Z',
      };
    },
    getCapabilities() {
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
      };
    },
    async ensureThread(context) {
      this.ensuredThreadContext = context;
      return 'codex-thread-1';
    },
    async interruptTurn() {
      calls.push({ kind: 'interrupt' });
    },
    async runTurn(params) {
      this.runTurnParams = params;
      await params.onEvent({ type: 'turn.started', runtimeTurnId: 'codex-turn-1' });
      this.approvalResolution = await params.onApprovalRequest({
        requestId: 'approval-request-1',
        requestMethod: 'mcp:write',
        actionType: 'pkm_write',
        previewHtml: '<p>Create a private todo</p>',
        metadata: {
          run_spec_id: 'run-1',
          node_id: 'node-tool',
          tool_name: 'create_todo',
        },
      });
      await params.onEvent({ type: 'assistant.completed', text: 'Codex completed after approval.' });
      await params.onEvent({
        type: 'turn.completed',
        status: 'completed',
        usage: {
          input_tokens: 12,
          output_tokens: 8,
          total_tokens: 20,
        },
      });
    },
  };
  const api = {
    async heartbeat(...args) {
      calls.push({ kind: 'heartbeat', args });
      return { ok: true, connection_id: args[0], status: args[1] };
    },
    async push(params) {
      calls.push({ kind: 'push', params });
      return { ok: true, interrupt_requested: false, state: params.state ?? 'claimed' };
    },
    async createApproval(params) {
      calls.push({ kind: 'createApproval', params });
      return { ok: true, approval_id: 'approval-1' };
    },
    async getApprovalStatus(approvalId) {
      calls.push({ kind: 'getApprovalStatus', approvalId });
      return {
        ok: true,
        approval_id: approvalId,
        status: 'approved',
        modified_instruction: 'Proceed with the private todo write.',
        metadata: null,
      };
    },
  };

  try {
    await processConnectorTurn({
      api,
      runtime,
      connectionId: 'connection-codex',
      runtimeVersion: '0.117.0',
      payload: buildPulledTurnPayload({
        runtimeType: 'codex',
        inputText: 'Create the approved private todo after checking projected skills.',
      }),
    });

    assert.equal(runtime.ensuredThreadContext.metadata.runtime_type, 'codex');
    assert.equal(runtime.ensuredThreadContext.sandbox['read-only'], null);
    assert.equal(runtime.runTurnParams.threadId, 'codex-thread-1');
    assert.equal(runtime.runTurnParams.inputItems.length, 2);
    assert.equal(runtime.runTurnParams.inputItems[0].type, 'text');
    assert.match(runtime.runTurnParams.inputItems[0].text, /\$remote-session-review/);
    assert.equal(runtime.runTurnParams.inputItems[1].type, 'skill');
    assert.equal(runtime.runTurnParams.inputItems[1].name, 'remote-session-review');
    assert.match(
      readFileSync(runtime.runTurnParams.inputItems[1].path, 'utf8'),
      /Summarize active runtime state and approval needs\./,
    );
    assert.equal(runtime.runTurnParams.approvalRules.pkm_write, 'require_approval');
    assert.equal(runtime.approvalResolution.decision, 'approve');
    assert.equal(runtime.approvalResolution.modifiedInstruction, 'Proceed with the private todo write.');

    const approval = calls.find((call) => call.kind === 'createApproval');
    assert.equal(approval.params.actionType, 'pkm_write');
    assert.equal(approval.params.metadata.tool_name, 'create_todo');

    const pushes = calls.filter((call) => call.kind === 'push').map((call) => call.params);
    assert.equal(pushes.length, 5);
    assert.equal(pushes[0].runtimeThreadId, 'codex-thread-1');
    assert.equal(pushes[1].state, 'streaming');
    assert.deepEqual(pushes[2].events.map((event) => event.event_type), ['approval.requested']);
    assert.equal(pushes[2].events[0].payload.approval_id, 'approval-1');
    assert.equal(pushes[2].events[0].payload.tool_name, 'create_todo');
    assert.deepEqual(pushes[3].events.map((event) => event.event_type), ['approval.resolved']);
    assert.equal(pushes[3].events[0].payload.status, 'approved');
    assert.equal(pushes[4].state, 'completed');
    assert.deepEqual(pushes[4].events.map((event) => event.event_type), [
      'assistant.completed',
      'turn.status',
    ]);
    assert.deepEqual(pushes[4].events[1].payload.usage, {
      input_tokens: 12,
      output_tokens: 8,
      total_tokens: 20,
    });
  } finally {
    process.env.HOME = previousHome;
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('isTransientConnectorNetworkError detects fetch ECONNRESET failures', () => {
  const error = new TypeError('fetch failed', {
    cause: Object.assign(new Error('read ECONNRESET'), {
      code: 'ECONNRESET',
    }),
  });

  assert.equal(isTransientConnectorNetworkError(error), true);
});

test('isTransientConnectorNetworkError leaves regular runtime failures visible', () => {
  assert.equal(isTransientConnectorNetworkError(new Error('Codex turn failed')), false);
});

function buildPulledTurnPayload({ runtimeType, inputText }) {
  return {
    connection: {
      id: `connection-${runtimeType}`,
      status: 'healthy',
      runtime_type: runtimeType,
      device_id: 'device-1',
      device_name: 'Runtime Device',
    },
    token: {
      id: 'token-1',
      name: 'Kernel Token',
      system_prompt: 'Token fallback prompt.',
      approval_level: 'approve-risky',
      approval_return_mode: 'inline',
      data_boundaries: {
        external_api: { user_setting: 'require_approval' },
        pkm_write: { user_setting: 'require_approval' },
      },
    },
    projection: {
      metadata: {
        agent_profile_id: 'agent-1',
        role_archetype: 'operator',
        strategy_pack_key: 'kernel_v1',
        skill_pack_keys: ['remote-session-review'],
        memory_branch_id: 'branch-1',
        memory_profile_ids: ['branch-1'],
        runtime_type: runtimeType,
      },
      registry: {
        skill_catalogs: [],
        mcp_servers: [],
        tool_catalogs: [],
        default_session_attachments: [
          {
            kind: 'mcp_server',
            id: '6ducklearn',
            label: '6DuckLearn',
            source: '6ducklearn-remote',
            enabled: true,
            description: 'Remote MCP server',
          },
        ],
      },
      instructions: {
        system_prompt: 'Stay grounded in projected 6DuckLearn context.',
        base_instructions: 'Use remote control-plane evidence only.',
        developer_instructions: 'Return concise status.',
        skill_modules: [
          {
            id: 'skill-pack:remote-session-review',
            name: 'remote-session-review',
            label: 'Remote Session Review',
            description: 'Review remote session state.',
            content: 'Summarize active runtime state and approval needs.',
          },
        ],
      },
    },
    thread: {
      id: 'thread-1',
      title: 'Kernel E2E',
      runtime_thread_id: null,
      metadata: {
        thread_id: 'thread-1',
      },
    },
    turn: {
      id: 'turn-1',
      thread_id: 'thread-1',
      input_text: inputText,
      state: 'claimed',
      created_at: '2026-06-13T00:00:00.000Z',
      lease_token: 'lease-1',
      runtime_attempt: 1,
    },
    run: {
      source: 'agent_console',
      thread_id: 'thread-1',
      run_spec_id: 'run-1',
      task_id: 'task-1',
      agent_id: 'agent-1',
      runtime_type: runtimeType,
      workspace_id: 'workspace-1',
      memory_branch_id: 'branch-1',
      memory_profile_ids: ['branch-1'],
      projection_context: null,
      created_at: '2026-06-13T00:00:00.000Z',
      updated_at: '2026-06-13T00:00:00.000Z',
    },
  };
}

function buildHermesConfig(overrides = {}) {
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
    runtimeType: 'hermes',
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
      quietProfile: true,
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
      baseUrl: 'http://127.0.0.1:8642',
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

async function startHermesTestServer(handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Unable to determine test server address');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}
