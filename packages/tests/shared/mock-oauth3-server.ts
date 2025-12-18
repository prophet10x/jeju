/**
 * Mock OAuth3 TEE Agent Server for E2E Testing
 * 
 * Simulates the OAuth3 authentication flow for testing without real providers.
 * 
 * Usage:
 *   import { startMockOAuth3Server, stopMockOAuth3Server } from '@jejunetwork/tests';
 *   
 *   beforeAll(async () => { await startMockOAuth3Server(); });
 *   afterAll(async () => { await stopMockOAuth3Server(); });
 * 
 * Supports:
 *   - Wallet authentication (simulated signature verification)
 *   - OAuth provider flows (mock GitHub, Google, Farcaster)
 *   - Session management
 *   - Credential issuance
 */

import { Hono } from 'hono';
import { serve, type Server } from '@hono/node-server';
import { keccak256, toBytes, toHex, type Address, type Hex } from 'viem';
import { verifyMessage } from 'viem';

// ============================================================================
// TYPES
// ============================================================================

interface MockSession {
  sessionId: Hex;
  identityId: Hex;
  smartAccount: Address;
  expiresAt: number;
  provider: string;
  capabilities: string[];
}

interface MockOAuthState {
  provider: string;
  appId: string;
  redirectUri: string;
  createdAt: number;
}

interface MockCredential {
  id: string;
  type: string[];
  issuer: string;
  issuanceDate: string;
  expirationDate: string;
  credentialSubject: {
    provider: string;
    providerId: string;
    providerHandle: string;
    walletAddress: Address;
  };
  proof: {
    type: string;
    proofValue: Hex;
  };
}

// ============================================================================
// STATE
// ============================================================================

const sessions = new Map<Hex, MockSession>();
const oauthStates = new Map<string, MockOAuthState>();
const credentials = new Map<string, MockCredential>();

let server: Server | null = null;
let serverPort = 4100;

// ============================================================================
// MOCK SERVER
// ============================================================================

function createMockOAuth3App(): Hono {
  const app = new Hono();

  // Health check
  app.get('/health', (c) => c.json({ status: 'ok', mock: true }));

  // Get attestation (mock TEE attestation)
  app.get('/attestation', (c) => c.json({
    quote: '0x' + '00'.repeat(32) as Hex,
    measurement: keccak256(toBytes('mock-tee-measurement')),
    reportData: keccak256(toBytes('mock-report-data')),
    timestamp: Date.now(),
    provider: 'mock',
    verified: true,
  }));

  // Wallet authentication
  app.post('/auth/wallet', async (c) => {
    const body = await c.req.json() as {
      address: Address;
      signature: Hex;
      message: string;
      appId: string;
    };

    const { address, signature, message, appId } = body;

    // Verify the signature (in tests, this may be mocked)
    let valid = false;
    try {
      valid = await verifyMessage({ address, message, signature });
    } catch {
      // In test mode, accept any signature for the test wallet
      if (address.toLowerCase() === '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266') {
        valid = true;
      }
    }

    if (!valid) {
      return c.json({ error: 'Invalid signature' }, 401);
    }

    // Create session
    const sessionId = keccak256(toBytes(`session:${address}:${Date.now()}`)) as Hex;
    const identityId = keccak256(toBytes(`identity:${address}`)) as Hex;

    const session: MockSession = {
      sessionId,
      identityId,
      smartAccount: address,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000, // 24 hours
      provider: 'wallet',
      capabilities: ['sign_message', 'sign_transaction'],
    };

    sessions.set(sessionId, session);

    return c.json({
      sessionId,
      identityId,
      smartAccount: address,
      expiresAt: session.expiresAt,
      capabilities: session.capabilities,
    });
  });

  // Initialize OAuth flow (for providers like GitHub, Google)
  app.post('/auth/init', async (c) => {
    const body = await c.req.json() as {
      provider: string;
      appId: string;
      redirectUri: string;
    };

    const state = keccak256(toBytes(`state:${body.provider}:${Date.now()}`)).slice(0, 42);
    const sessionId = keccak256(toBytes(`session:${state}`)) as Hex;

    oauthStates.set(state, {
      provider: body.provider,
      appId: body.appId,
      redirectUri: body.redirectUri,
      createdAt: Date.now(),
    });

    // Return mock auth URL that simulates the provider
    const mockAuthUrl = `http://localhost:${serverPort}/mock-provider/${body.provider}?state=${state}`;

    return c.json({
      authUrl: mockAuthUrl,
      state,
      sessionId,
    });
  });

  // Mock OAuth provider page (simulates GitHub/Google login)
  app.get('/mock-provider/:provider', (c) => {
    const provider = c.req.param('provider');
    const state = c.req.query('state');

    // Return an HTML page that auto-submits to callback
    return c.html(`
      <!DOCTYPE html>
      <html>
        <head><title>Mock ${provider} Login</title></head>
        <body>
          <h1>Mock ${provider} Login</h1>
          <p>This is a simulated OAuth provider for testing.</p>
          <form action="/mock-provider/${provider}/authorize" method="POST">
            <input type="hidden" name="state" value="${state}" />
            <input type="hidden" name="email" value="testuser@example.com" />
            <button type="submit" id="authorize">Authorize</button>
          </form>
          <script>
            // Auto-submit for E2E tests
            if (window.location.search.includes('auto=true')) {
              document.getElementById('authorize').click();
            }
          </script>
        </body>
      </html>
    `);
  });

  // Mock provider authorization (returns code)
  app.post('/mock-provider/:provider/authorize', async (c) => {
    const formData = await c.req.formData();
    const state = formData.get('state') as string;
    const email = formData.get('email') as string;

    const storedState = oauthStates.get(state);
    if (!storedState) {
      return c.json({ error: 'Invalid state' }, 400);
    }

    // Generate mock authorization code
    const code = keccak256(toBytes(`code:${state}:${Date.now()}`)).slice(0, 42);

    // Redirect to callback with code
    const redirectUrl = new URL(storedState.redirectUri);
    redirectUrl.searchParams.set('code', code);
    redirectUrl.searchParams.set('state', state);

    return c.redirect(redirectUrl.toString());
  });

  // OAuth callback handler
  app.post('/auth/callback', async (c) => {
    const body = await c.req.json() as { state: string; code: string };
    const { state, code } = body;

    const storedState = oauthStates.get(state);
    if (!storedState) {
      return c.json({ error: 'Invalid state' }, 400);
    }

    // Create session
    const sessionId = keccak256(toBytes(`session:${code}:${Date.now()}`)) as Hex;
    const identityId = keccak256(toBytes(`identity:${storedState.provider}:${code}`)) as Hex;
    const smartAccount = `0x${keccak256(toBytes(`account:${identityId}`)).slice(26)}` as Address;

    const session: MockSession = {
      sessionId,
      identityId,
      smartAccount,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      provider: storedState.provider,
      capabilities: ['sign_message'],
    };

    sessions.set(sessionId, session);
    oauthStates.delete(state);

    return c.json({
      sessionId,
      identityId,
      smartAccount,
      expiresAt: session.expiresAt,
      capabilities: session.capabilities,
    });
  });

  // Farcaster authentication
  app.post('/auth/farcaster', async (c) => {
    const body = await c.req.json() as {
      fid: number;
      custodyAddress: Address;
      signature: Hex;
      message: string;
      appId: string;
    };

    // Create session for Farcaster user
    const sessionId = keccak256(toBytes(`session:farcaster:${body.fid}:${Date.now()}`)) as Hex;
    const identityId = keccak256(toBytes(`identity:farcaster:${body.fid}`)) as Hex;

    const session: MockSession = {
      sessionId,
      identityId,
      smartAccount: body.custodyAddress,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      provider: 'farcaster',
      capabilities: ['sign_message'],
    };

    sessions.set(sessionId, session);

    return c.json({
      sessionId,
      identityId,
      smartAccount: body.custodyAddress,
      expiresAt: session.expiresAt,
      capabilities: session.capabilities,
    });
  });

  // Get session
  app.get('/session/:sessionId', (c) => {
    const sessionId = c.req.param('sessionId') as Hex;
    const session = sessions.get(sessionId);

    if (!session || session.expiresAt < Date.now()) {
      return c.json({ error: 'Session not found or expired' }, 404);
    }

    return c.json(session);
  });

  // Refresh session
  app.post('/session/:sessionId/refresh', (c) => {
    const sessionId = c.req.param('sessionId') as Hex;
    const session = sessions.get(sessionId);

    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    // Extend session
    session.expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    sessions.set(sessionId, session);

    return c.json(session);
  });

  // Delete session (logout)
  app.delete('/session/:sessionId', (c) => {
    const sessionId = c.req.param('sessionId') as Hex;
    sessions.delete(sessionId);
    return c.json({ success: true });
  });

  // Sign message
  app.post('/sign', async (c) => {
    const body = await c.req.json() as { sessionId: Hex; message: Hex };
    const session = sessions.get(body.sessionId);

    if (!session || session.expiresAt < Date.now()) {
      return c.json({ error: 'Invalid session' }, 401);
    }

    // Generate mock signature
    const signature = keccak256(toBytes(`sig:${body.message}:${session.sessionId}`)) as Hex;

    return c.json({ signature });
  });

  // Issue credential
  app.post('/credential/issue', async (c) => {
    const body = await c.req.json() as {
      sessionId: Hex;
      provider: string;
      providerId: string;
      providerHandle: string;
      walletAddress: Address;
    };

    const session = sessions.get(body.sessionId);
    if (!session || session.expiresAt < Date.now()) {
      return c.json({ error: 'Invalid session' }, 401);
    }

    const credentialId = keccak256(toBytes(`credential:${body.provider}:${body.providerId}:${Date.now()}`));

    const credential: MockCredential = {
      id: credentialId,
      type: ['VerifiableCredential', 'OAuth3IdentityCredential'],
      issuer: 'did:ethr:1337:0xMockOAuth3Issuer',
      issuanceDate: new Date().toISOString(),
      expirationDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      credentialSubject: {
        provider: body.provider,
        providerId: body.providerId,
        providerHandle: body.providerHandle,
        walletAddress: body.walletAddress,
      },
      proof: {
        type: 'EcdsaSecp256k1Signature2019',
        proofValue: keccak256(toBytes(`proof:${credentialId}`)) as Hex,
      },
    };

    credentials.set(credentialId, credential);

    return c.json(credential);
  });

  // Verify credential
  app.post('/credential/verify', async (c) => {
    const body = await c.req.json() as { credential: MockCredential };
    const stored = credentials.get(body.credential.id);

    const valid = stored && 
      stored.proof.proofValue === body.credential.proof.proofValue &&
      new Date(stored.expirationDate) > new Date();

    return c.json({ valid });
  });

  return app;
}

// ============================================================================
// SERVER LIFECYCLE
// ============================================================================

export async function startMockOAuth3Server(port = 4100): Promise<number> {
  if (server) {
    console.log(`Mock OAuth3 server already running on port ${serverPort}`);
    return serverPort;
  }

  serverPort = port;
  const app = createMockOAuth3App();

  return new Promise((resolve) => {
    server = serve({
      fetch: app.fetch,
      port: serverPort,
    });

    console.log(`Mock OAuth3 TEE agent running on http://localhost:${serverPort}`);
    resolve(serverPort);
  });
}

export async function stopMockOAuth3Server(): Promise<void> {
  if (server) {
    server.close();
    server = null;
    sessions.clear();
    oauthStates.clear();
    credentials.clear();
    console.log('Mock OAuth3 server stopped');
  }
}

export function getMockOAuth3Url(): string {
  return `http://localhost:${serverPort}`;
}

export function clearMockOAuth3State(): void {
  sessions.clear();
  oauthStates.clear();
  credentials.clear();
}

// ============================================================================
// EXPORTS
// ============================================================================

export { sessions, oauthStates, credentials };

