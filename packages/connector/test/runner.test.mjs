import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRuntimeInputItems,
  isTransientConnectorNetworkError,
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

test('resolveCodexRuntimePolicy honors trust-all and opens both write and network access', () => {
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
        pkm_write: 'auto',
      },
      threadSandbox: 'workspace-write',
      turnSandboxPolicy: 'workspace-write',
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
