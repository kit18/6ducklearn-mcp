const MCP_URL = 'https://6ducklearn.com/mcp';
const AUTH_METADATA_URL = 'https://6ducklearn.com/.well-known/oauth-authorization-server';
const RESOURCE_METADATA_URL = 'https://6ducklearn.com/.well-known/oauth-protected-resource/mcp';
const HOSTED_HEADERS = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
};

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from ${response.url}, got: ${text.slice(0, 120)}`);
  }
}

async function assertMetadata() {
  const authResponse = await fetch(AUTH_METADATA_URL, {
    headers: HOSTED_HEADERS,
  });
  if (authResponse.status !== 200) {
    throw new Error(`OAuth metadata returned ${authResponse.status}`);
  }
  const auth = await readJson(authResponse);
  if (auth.issuer !== 'https://6ducklearn.com') {
    throw new Error(`Unexpected issuer: ${auth.issuer}`);
  }
  if (auth.token_endpoint !== 'https://6ducklearn.com/oauth/mcp/token') {
    throw new Error(`Unexpected token endpoint: ${auth.token_endpoint}`);
  }

  const resourceResponse = await fetch(RESOURCE_METADATA_URL, {
    headers: HOSTED_HEADERS,
  });
  if (resourceResponse.status !== 200) {
    throw new Error(`Protected resource metadata returned ${resourceResponse.status}`);
  }
  const resource = await readJson(resourceResponse);
  if (resource.resource !== MCP_URL) {
    throw new Error(`Unexpected MCP resource: ${resource.resource}`);
  }
}

async function assertUnauthorizedChallenge() {
  const response = await fetch(MCP_URL, {
    method: 'POST',
    headers: { ...HOSTED_HEADERS, 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {},
    }),
  });

  if (response.status !== 401) {
    throw new Error(`Unauthenticated MCP POST returned ${response.status}, expected 401`);
  }
  const challenge = response.headers.get('www-authenticate') || '';
  if (!challenge.includes(RESOURCE_METADATA_URL)) {
    throw new Error(`Missing OAuth protected-resource challenge: ${challenge}`);
  }
}

await assertMetadata();
await assertUnauthorizedChallenge();
console.log('Hosted 6DuckLearn MCP smoke passed.');
