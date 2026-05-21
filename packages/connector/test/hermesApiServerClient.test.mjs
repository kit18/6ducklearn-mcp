import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { HermesApiServerClient } from '../dist/hermesApiServerClient.js';

function buildConfig(overrides = {}) {
  const base = {
    supabaseUrl: 'https://example.supabase.co',
    tokenId: 'token-id',
    hmacSecret: 'a'.repeat(64),
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
      apiKey: 'secret-key',
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

test('HermesApiServerClient uses deterministic conversation keys and discovered model ids', async () => {
  const requests = [];
  const server = await startHermesTestServer(async (req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
    });

    if (req.url === '/v1/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.url === '/v1/models') {
      res.writeHead(200, {
        'Content-Type': 'application/json',
        Server: 'hermes-agent/0.8.0',
      });
      res.end(JSON.stringify({
        data: [{ id: 'alice' }],
      }));
      return;
    }

    if (req.url === '/v1/responses') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }

      requests[requests.length - 1].body = JSON.parse(body);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
      });
      res.write('event: response.created\n');
      res.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } })}\n\n`);
      res.write('event: response.output_text.delta\n');
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Researching ' })}\n\n`);
      res.write('event: response.output_text.delta\n');
      res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Tesla' })}\n\n`);
      res.write('event: response.completed\n');
      res.write(`data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_1',
          status: 'completed',
          output: [
            {
              type: 'function_call',
              name: 'terminal',
              arguments: '{"command":"ls"}',
              call_id: 'call_1',
            },
            {
              type: 'function_call_output',
              call_id: 'call_1',
              output: 'README.md\nsrc\n',
            },
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Researching Tesla in the repo.' }],
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

  try {
    const client = new HermesApiServerClient(buildConfig({
      hermes: {
        baseUrl: server.baseUrl,
        apiKey: 'secret-key',
        conversationPrefix: '6ducklearn',
      },
    }));
    const events = [];

    await client.start();
    const version = await client.detectRuntimeVersion();
    const threadId = await client.ensureThread({
      systemPrompt: 'Stay concise',
      metadata: {
        browser_thread_id: 'thread-123',
      },
    });

    await client.runTurn({
      threadId,
      inputText: 'Summarize the project',
      onEvent: async (event) => {
        events.push(event);
      },
    });

    assert.equal(version, '0.8.0');
    assert.equal(threadId, '6ducklearn:thread-123');
    assert.equal(client.getCapabilities().model, 'alice');

    const responseRequest = requests.find((entry) => entry.url === '/v1/responses');
    assert.ok(responseRequest);
    assert.equal(responseRequest.headers.authorization, 'Bearer secret-key');
    assert.deepEqual(responseRequest.body, {
      model: 'alice',
      input: 'Summarize the project',
      instructions: 'Stay concise',
      conversation: '6ducklearn:thread-123',
      store: true,
      stream: true,
    });

    assert.deepEqual(events, [
      { type: 'turn.started', runtimeTurnId: 'resp_1' },
      { type: 'assistant.delta', text: 'Researching ' },
      { type: 'assistant.delta', text: 'Tesla' },
      {
        type: 'tool.started',
        itemType: 'function_call',
        label: 'terminal',
        detail: 'ls',
      },
      {
        type: 'tool.output',
        itemType: 'function_call',
        delta: 'README.md\nsrc\n',
      },
      {
        type: 'tool.completed',
        itemType: 'function_call',
        label: 'terminal',
        success: true,
      },
      {
        type: 'assistant.completed',
        text: 'Researching Tesla in the repo.',
      },
      {
        type: 'turn.completed',
        status: 'completed',
      },
    ]);
  } finally {
    await server.close();
  }
});

test('HermesApiServerClient carries portable input item context in the response request', async () => {
  const requests = [];
  const server = await startHermesTestServer(async (req, res) => {
    if (req.url === '/v1/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'hermes-agent' }] }));
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
      res.write('event: response.completed\n');
      res.write(`data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_2',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Done.' }],
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

  try {
    const client = new HermesApiServerClient(buildConfig({
      hermes: {
        baseUrl: server.baseUrl,
        apiKey: null,
        conversationPrefix: '6ducklearn',
      },
    }));

    await client.start();
    await client.detectRuntimeVersion();
    const threadId = await client.ensureThread({
      systemPrompt: 'System prompt',
      baseInstructions: 'Base instructions',
      developerInstructions: 'Developer instructions',
      metadata: {
        browser_thread_id: 'thread-456',
      },
    });

    await client.runTurn({
      threadId,
      inputText: 'Raw task',
      inputItems: [{ type: 'text', text: 'Hydrated Hermes task' }],
      onEvent: async () => {},
    });

    assert.deepEqual(requests[0], {
      model: 'hermes-agent',
      input: 'Hydrated Hermes task',
      instructions: [
        'System prompt',
        'Base instructions',
        'Developer instructions',
      ].join('\n\n'),
      conversation: '6ducklearn:thread-456',
      store: true,
      stream: true,
      metadata: {
        sixducklearn: {
          input_items: [{ type: 'text', text: 'Hydrated Hermes task' }],
        },
      },
    });
    assert.deepEqual(client.getCapabilities().structured_context, {
      instructions: true,
      metadata: true,
      input_items: false,
      fallback_mode: 'native',
    });
  } finally {
    await server.close();
  }
});

test('HermesApiServerClient retries without metadata when Hermes rejects nested context', async () => {
  const requests = [];
  const server = await startHermesTestServer(async (req, res) => {
    if (req.url === '/v1/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'hermes-agent' }] }));
      return;
    }

    if (req.url === '/v1/responses') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      const parsedBody = JSON.parse(body);
      requests.push(parsedBody);

      if (parsedBody.metadata?.sixducklearn) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: { message: 'unknown field: metadata.sixducklearn' },
        }));
        return;
      }

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
      });
      res.write('event: response.completed\n');
      res.write(`data: ${JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_fallback',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'Fallback done.' }],
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

  try {
    const client = new HermesApiServerClient(buildConfig({
      hermes: {
        baseUrl: server.baseUrl,
        apiKey: null,
        conversationPrefix: '6ducklearn',
      },
    }));
    const events = [];

    await client.start();
    await client.detectRuntimeVersion();
    const threadId = await client.ensureThread({
      systemPrompt: 'System prompt',
      developerInstructions: 'Developer instructions',
      metadata: {
        browser_thread_id: 'thread-fallback',
      },
    });

    await client.runTurn({
      threadId,
      inputText: 'Raw task',
      inputItems: [{ type: 'text', text: 'Hydrated fallback task' }],
      onEvent: async (event) => {
        events.push(event);
      },
    });

    assert.equal(requests.length, 2);
    assert.ok(requests[0].metadata?.sixducklearn);
    assert.equal(requests[1].metadata, undefined);
    assert.equal(requests[1].input, 'Hydrated fallback task');
    assert.equal(requests[1].instructions, 'System prompt\n\nDeveloper instructions');
    assert.deepEqual(client.getCapabilities().structured_context, {
      instructions: true,
      metadata: false,
      input_items: false,
      fallback_mode: 'text_envelope',
    });
    assert.deepEqual(events, [
      { type: 'turn.started', runtimeTurnId: 'resp_fallback' },
      { type: 'assistant.completed', text: 'Fallback done.' },
      { type: 'turn.completed', status: 'completed' },
    ]);
  } finally {
    await server.close();
  }
});

test('HermesApiServerClient reuses existing runtime thread ids and reports failures', async () => {
  const server = await startHermesTestServer(async (req, res) => {
    if (req.url === '/v1/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'hermes-agent' }] }));
      return;
    }

    if (req.url === '/v1/responses') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'keep-alive',
        'Cache-Control': 'no-cache',
      });
      res.write('event: response.created\n');
      res.write(`data: ${JSON.stringify({ type: 'response.created', response: { id: 'resp_fail' } })}\n\n`);
      res.write('event: response.failed\n');
      res.write(`data: ${JSON.stringify({
        type: 'response.failed',
        message: 'Command execution failed',
        response: {
          id: 'resp_fail',
          status: 'failed',
          error_message: 'Command execution failed',
        },
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(404);
    res.end();
  });

  try {
    const client = new HermesApiServerClient(buildConfig({
      hermes: {
        baseUrl: `${server.baseUrl}/v1`,
        apiKey: null,
        conversationPrefix: '6ducklearn',
      },
    }));
    const events = [];

    await client.start();
    await client.detectRuntimeVersion();
    const threadId = await client.ensureThread({
      runtimeThreadId: 'existing-conversation',
      metadata: {
        browser_thread_id: 'ignored-thread-id',
      },
    });

    assert.equal(threadId, 'existing-conversation');

    await assert.rejects(
      () =>
        client.runTurn({
          threadId,
          inputText: 'Do the thing',
          onEvent: async (event) => {
            events.push(event);
          },
        }),
      /Command execution failed/,
    );

    assert.deepEqual(events, [
      { type: 'turn.started', runtimeTurnId: 'resp_fail' },
      { type: 'runtime.error', message: 'Command execution failed' },
      { type: 'turn.completed', status: 'failed', message: 'Command execution failed' },
    ]);
  } finally {
    await server.close();
  }
});
