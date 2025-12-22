/**
 * Workerd Runtime Tests
 * Tests for V8 isolate-based worker execution
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { createWorkerdRouter, type WorkerdRouterOptions } from '../src/server/routes/workerd';
import { createBackendManager } from '../src/storage/backends';
import type { WorkerdWorkerDefinition } from '../src/workers/workerd/types';

// Test setup
const backend = createBackendManager();
let app: Hono;

beforeAll(async () => {
  const options: WorkerdRouterOptions = {
    backend,
    workerdConfig: {
      binaryPath: '/nonexistent/workerd', // Force fallback to Bun mode
      workDir: '/tmp/dws-workerd-test',
      portRange: { min: 40000, max: 45000 },
    },
    enableDecentralized: false, // Test without on-chain registry
  };
  
  app = new Hono();
  app.route('/workerd', createWorkerdRouter(options));
});

describe('Workerd API', () => {
  describe('Health and Stats', () => {
    test('GET /workerd/health returns healthy status', async () => {
      const res = await app.request('/workerd/health');
      expect(res.status).toBe(200);
      
      const data = await res.json() as { status: string; service: string; runtime: string };
      expect(data.status).toBe('healthy');
      expect(data.service).toBe('dws-workerd');
      expect(data.runtime).toBe('workerd');
    });

    test('GET /workerd/stats returns pool metrics', async () => {
      const res = await app.request('/workerd/stats');
      expect(res.status).toBe(200);
      
      const data = await res.json() as { pool: { totalWorkers: number } };
      expect(data.pool).toBeDefined();
      expect(typeof data.pool.totalWorkers).toBe('number');
    });
  });

  describe('Worker Deployment', () => {
    let workerId: string;
    const testWorkerCode = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    
    if (url.pathname === '/health') {
      return new Response('ok');
    }
    
    if (url.pathname === '/echo') {
      const body = await request.text();
      return new Response(JSON.stringify({ 
        method: request.method,
        path: url.pathname,
        body 
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    return new Response(JSON.stringify({ hello: 'world' }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }
};
`;

    test('POST /workerd deploys a new worker', async () => {
      const res = await app.request('/workerd', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-jeju-address': '0x1234567890123456789012345678901234567890',
        },
        body: JSON.stringify({
          name: 'test-worker',
          code: Buffer.from(testWorkerCode).toString('base64'),
          memoryMb: 128,
          timeoutMs: 5000,
        }),
      });

      expect(res.status).toBe(201);
      
      const data = await res.json() as { workerId: string; name: string; runtime: string };
      expect(data.workerId).toBeDefined();
      expect(data.name).toBe('test-worker');
      expect(data.runtime).toBe('workerd');
      
      workerId = data.workerId;
    });

    test('GET /workerd lists deployed workers', async () => {
      const res = await app.request('/workerd');
      expect(res.status).toBe(200);
      
      const data = await res.json() as { workers: Array<{ name: string }> };
      expect(data.workers).toBeInstanceOf(Array);
      expect(data.workers.length).toBeGreaterThanOrEqual(1);
      expect(data.workers.some(w => w.name === 'test-worker')).toBe(true);
    });

    test('GET /workerd/:workerId returns worker details', async () => {
      const res = await app.request(`/workerd/${workerId}`);
      expect(res.status).toBe(200);
      
      const data = await res.json() as { id: string; name: string; status: string };
      expect(data.id).toBe(workerId);
      expect(data.name).toBe('test-worker');
      expect(data.status).toBeDefined();
    });

    test('GET /workerd/:workerId/metrics returns worker metrics', async () => {
      const res = await app.request(`/workerd/${workerId}/metrics`);
      expect(res.status).toBe(200);
      
      const data = await res.json() as { workerId: string; invocations: number };
      expect(data.workerId).toBe(workerId);
      expect(typeof data.invocations).toBe('number');
    });

    test('DELETE /workerd/:workerId undeploys worker', async () => {
      const res = await app.request(`/workerd/${workerId}`, {
        method: 'DELETE',
        headers: {
          'x-jeju-address': '0x1234567890123456789012345678901234567890',
        },
      });

      expect(res.status).toBe(200);
      
      const data = await res.json() as { success: boolean };
      expect(data.success).toBe(true);

      // Verify worker is gone
      const checkRes = await app.request(`/workerd/${workerId}`);
      expect(checkRes.status).toBe(404);
    });
  });

  describe('Worker Authorization', () => {
    test('requires x-jeju-address header for deployment', async () => {
      const res = await app.request('/workerd', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'unauthorized-worker',
          code: Buffer.from('export default {}').toString('base64'),
        }),
      });

      expect(res.status).toBe(401);
      const data = await res.json() as { error: string };
      expect(data.error).toContain('x-jeju-address');
    });

    test('requires x-jeju-address header for deletion', async () => {
      const res = await app.request('/workerd/some-worker-id', {
        method: 'DELETE',
        headers: {},
      });

      expect(res.status).toBe(401);
    });
  });

  describe('Input Validation', () => {
    test('validates worker name', async () => {
      const res = await app.request('/workerd', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-jeju-address': '0x1234567890123456789012345678901234567890',
        },
        body: JSON.stringify({
          name: '', // Invalid empty name
          code: Buffer.from('export default {}').toString('base64'),
        }),
      });

      expect(res.status).toBe(400);
    });

    test('validates memory limits', async () => {
      const res = await app.request('/workerd', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-jeju-address': '0x1234567890123456789012345678901234567890',
        },
        body: JSON.stringify({
          name: 'memory-test',
          code: Buffer.from('export default {}').toString('base64'),
          memoryMb: 9999, // Over limit
        }),
      });

      expect(res.status).toBe(400);
    });

    test('validates timeout limits', async () => {
      const res = await app.request('/workerd', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-jeju-address': '0x1234567890123456789012345678901234567890',
        },
        body: JSON.stringify({
          name: 'timeout-test',
          code: Buffer.from('export default {}').toString('base64'),
          timeoutMs: 999999999, // Over limit
        }),
      });

      expect(res.status).toBe(400);
    });
  });
});

describe('Config Generator', () => {
  const { generateWorkerConfig, wrapHandlerAsWorker } = require('../src/workers/workerd/config-generator');

  test('generates valid capnp config', () => {
    const worker: WorkerdWorkerDefinition = {
      id: 'test-123',
      name: 'test-worker',
      owner: '0x1234567890123456789012345678901234567890',
      modules: [{ name: 'worker.js', type: 'esModule', content: 'export default {}' }],
      bindings: [{ name: 'MY_VAR', type: 'text', value: 'hello' }],
      compatibilityDate: '2024-01-01',
      mainModule: 'worker.js',
      memoryMb: 128,
      cpuTimeMs: 50,
      timeoutMs: 30000,
      codeCid: 'Qm123',
      version: 1,
      status: 'active',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    const config = generateWorkerConfig(worker, 30001, {
      cpuTimeLimitMs: 50,
      isolateMemoryMb: 128,
      requestTimeoutMs: 30000,
      subrequestLimit: 50,
    });

    expect(config).toContain('using Workerd');
    expect(config).toContain('worker.js');
    expect(config).toContain('MY_VAR');
    expect(config).toContain('2024-01-01');
    expect(config).toContain('30001');
  });

  test('wraps handler as fetch worker', () => {
    const handlerCode = `
function handler(event, env) {
  return { statusCode: 200, body: 'hello' };
}
`;

    const wrapped = wrapHandlerAsWorker(handlerCode, 'handler');
    
    expect(wrapped).toContain('export default');
    expect(wrapped).toContain('async fetch(request, env');
    expect(wrapped).toContain('handler(event, env)');
  });

  test('preserves existing fetch export', () => {
    const fetchCode = `
export default {
  async fetch(request) {
    return new Response('hello');
  }
};
`;

    const wrapped = wrapHandlerAsWorker(fetchCode, 'handler');
    
    // Should not double-wrap
    expect(wrapped).toBe(fetchCode);
  });
});

describe('Types', () => {
  test('WorkerdConfig has required fields', () => {
    const { DEFAULT_WORKERD_CONFIG } = require('../src/workers/workerd/types');
    
    expect(DEFAULT_WORKERD_CONFIG.binaryPath).toBeDefined();
    expect(DEFAULT_WORKERD_CONFIG.workDir).toBeDefined();
    expect(DEFAULT_WORKERD_CONFIG.portRange).toBeDefined();
    expect(DEFAULT_WORKERD_CONFIG.portRange.min).toBeLessThan(DEFAULT_WORKERD_CONFIG.portRange.max);
    expect(DEFAULT_WORKERD_CONFIG.maxIsolatesPerProcess).toBeGreaterThan(0);
    expect(DEFAULT_WORKERD_CONFIG.isolateMemoryMb).toBeGreaterThan(0);
  });
});

