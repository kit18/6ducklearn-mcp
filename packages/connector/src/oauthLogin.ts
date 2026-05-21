import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeOAuthSession } from './oauthSession.js';

const DEFAULT_PUBLIC_BASE_URL = 'https://6ducklearn.com';
const DEFAULT_RESOURCE = 'https://6ducklearn.com/mcp';
const DEFAULT_SCOPE = [
  'runtime:connect',
  'control:read',
  'control:write',
  'policy:read',
  'approval:request',
  'approval:decide',
  'mcp:read',
  'mcp:write',
].join(' ');

function base64Url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function randomToken(bytes = 32): string {
  return base64Url(randomBytes(bytes));
}

function pkceChallenge(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

function openBrowser(url: string): void {
  const command =
    process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    // Printing the URL below is the reliable fallback.
  }
}

async function registerClient(input: {
  publicBaseUrl: string;
  redirectUri: string;
  scope: string;
}): Promise<{ client_id: string; token_endpoint?: string }> {
  const response = await fetch(`${input.publicBaseUrl}/oauth/mcp/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: '6DuckLearn Local Connector',
      redirect_uris: [input.redirectUri],
      scope: input.scope,
    }),
  });

  if (!response.ok) {
    throw new Error(`OAuth client registration failed (${response.status}): ${await response.text()}`);
  }

  const body = await response.json() as { client_id?: string; token_endpoint?: string };
  if (!body.client_id) {
    throw new Error('OAuth client registration did not return client_id.');
  }

  return {
    client_id: body.client_id,
    token_endpoint: body.token_endpoint,
  };
}

async function exchangeCode(input: {
  publicBaseUrl: string;
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
  resource: string;
}): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}> {
  const response = await fetch(`${input.publicBaseUrl}/oauth/mcp/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: input.clientId,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
      resource: input.resource,
    }).toString(),
  });

  if (!response.ok) {
    throw new Error(`OAuth token exchange failed (${response.status}): ${await response.text()}`);
  }

  const body = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!body.access_token) {
    throw new Error('OAuth token exchange did not return access_token.');
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_in: body.expires_in,
    scope: body.scope,
  };
}

export async function runOAuthLogin(): Promise<void> {
  const publicBaseUrl = process.env.SIXDUCK_PUBLIC_BASE_URL || process.env.DUCK_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE_URL;
  const resource = process.env.SIXDUCK_OAUTH_RESOURCE || process.env.DUCK_OAUTH_RESOURCE || DEFAULT_RESOURCE;
  const scope = process.env.SIXDUCK_OAUTH_SCOPE || process.env.DUCK_OAUTH_SCOPE || DEFAULT_SCOPE;
  const sessionPath = process.env.SIXDUCK_OAUTH_SESSION_PATH || process.env.DUCK_OAUTH_SESSION_PATH;
  const runtimeType = process.env.SIXDUCK_RUNTIME_TYPE || process.env.DUCK_RUNTIME_TYPE || 'codex';
  const tokenId = process.env.SIXDUCK_OAUTH_TOKEN_ID || process.env.DUCK_OAUTH_TOKEN_ID || process.env.SIXDUCK_TOKEN_ID || process.env.DUCK_TOKEN_ID;
  const agentId = process.env.SIXDUCK_AGENT_ID || process.env.DUCK_AGENT_ID;
  const codeVerifier = randomToken(64);
  const codeChallenge = pkceChallenge(codeVerifier);
  const state = randomToken(24);

  await new Promise<void>((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (url.pathname !== '/callback') {
          res.writeHead(404).end('Not found');
          return;
        }

        if (url.searchParams.get('state') !== state) {
          res.writeHead(400).end('OAuth state mismatch. Close this tab and retry.');
          reject(new Error('OAuth state mismatch.'));
          server.close();
          return;
        }

        const code = url.searchParams.get('code');
        if (!code) {
          const error = url.searchParams.get('error') || 'missing_code';
          res.writeHead(400).end(`OAuth failed: ${error}`);
          reject(new Error(`OAuth failed: ${error}`));
          server.close();
          return;
        }

        const tokenResult = await exchangeCode({
          publicBaseUrl,
          clientId,
          code,
          redirectUri,
          codeVerifier,
          resource,
        });
        const expiresAt = tokenResult.expires_in
          ? new Date(Date.now() + tokenResult.expires_in * 1000).toISOString()
          : undefined;

        writeOAuthSession({
          client_id: clientId,
          access_token: tokenResult.access_token,
          refresh_token: tokenResult.refresh_token,
          expires_at: expiresAt,
          scope: tokenResult.scope || scope,
          token_endpoint: `${publicBaseUrl}/oauth/mcp/token`,
          resource,
          runtime_type: runtimeType === 'openclaw' || runtimeType === 'hermes' ? runtimeType : 'codex',
          token_id: tokenId,
          agent_id: agentId,
        }, sessionPath);

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
          '<h1>6DuckLearn connector authorized</h1><p>You can close this tab and return to your terminal.</p>',
        );
        server.close();
        resolve();
      } catch (error) {
        server.close();
        reject(error);
      }
    });

    let clientId = '';
    let redirectUri = '';

    server.listen(0, '127.0.0.1', async () => {
      try {
        const address = server.address();
        if (!address || typeof address === 'string') {
          throw new Error('Unable to allocate local OAuth callback port.');
        }

        redirectUri = `http://127.0.0.1:${address.port}/callback`;
        const client = await registerClient({ publicBaseUrl, redirectUri, scope });
        clientId = client.client_id;

        const authorizeUrl = new URL(`${publicBaseUrl}/oauth/mcp/authorize`);
        authorizeUrl.searchParams.set('client_id', clientId);
        authorizeUrl.searchParams.set('redirect_uri', redirectUri);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('scope', scope);
        authorizeUrl.searchParams.set('state', state);
        authorizeUrl.searchParams.set('code_challenge', codeChallenge);
        authorizeUrl.searchParams.set('code_challenge_method', 'S256');
        authorizeUrl.searchParams.set('resource', resource);
        authorizeUrl.searchParams.set('runtime_type', runtimeType);
        if (tokenId) authorizeUrl.searchParams.set('token_id', tokenId);
        if (agentId) authorizeUrl.searchParams.set('agent_id', agentId);

        console.log('[6ducklearn-connector] Opening 6DuckLearn OAuth authorization...');
        console.log(`[6ducklearn-connector] If the browser does not open, visit:\n${authorizeUrl.toString()}`);
        openBrowser(authorizeUrl.toString());
      } catch (error) {
        server.close();
        reject(error);
      }
    });
  });

  console.log('[6ducklearn-connector] OAuth session saved. Starting the connector can now use the saved session.');
}
