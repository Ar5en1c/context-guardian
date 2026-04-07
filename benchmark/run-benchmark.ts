/**
 * Benchmark: A/B comparison of agent performance WITH vs WITHOUT Context Guardian MCP tools.
 *
 * This generates a realistic scenario, then:
 * 1. Measures raw token count of the full context
 * 2. Runs Context Guardian indexing + tool queries to demonstrate targeted retrieval
 * 3. Compares: raw dump approach vs tool-augmented approach
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Scenario data generators
function generateAuthTimeoutScenario(): { task: string; rawContext: string; sections: Record<string, string> } {
  const logs = `2026-04-07T09:00:00.123Z INFO  [auth] Server started on port 3001
2026-04-07T09:00:01.456Z INFO  [auth] Connected to Redis cache at redis://cache:6379
2026-04-07T09:00:02.789Z INFO  [auth] Identity provider configured: https://idp.corp.internal/oauth
2026-04-07T09:15:32.001Z WARN  [auth] JWT validation slow: 2340ms for user alice@corp.com
2026-04-07T09:15:34.567Z ERROR [auth] JWT validation timeout: 5000ms exceeded for user bob@corp.com. Error: AbortError
2026-04-07T09:15:35.890Z ERROR [auth] Failed to refresh JWKS keys from https://idp.corp.internal/oauth/.well-known/jwks.json - ETIMEDOUT
2026-04-07T09:15:36.123Z WARN  [auth] Falling back to cached JWKS keys (age: 3602 seconds)
2026-04-07T09:15:37.456Z ERROR [auth] Cached JWKS key kid=key-2024-03 not found for token kid=key-2024-04
2026-04-07T09:15:38.789Z ERROR [auth] Authentication failed for bob@corp.com: JsonWebTokenError: no matching key found
2026-04-07T09:16:00.012Z ERROR [auth] Health check: identity-provider UNREACHABLE (3 consecutive failures)
2026-04-07T09:16:01.345Z WARN  [auth] Circuit breaker OPEN for identity-provider after 5 failures in 60s window
2026-04-07T09:17:00.678Z INFO  [auth] Circuit breaker HALF-OPEN, attempting probe
2026-04-07T09:17:02.901Z INFO  [auth] Identity provider responded: 200 OK (latency: 890ms)
2026-04-07T09:17:03.234Z INFO  [auth] JWKS keys refreshed. New key count: 3
2026-04-07T09:17:03.567Z INFO  [auth] Circuit breaker CLOSED
2026-04-07T09:22:15.890Z ERROR [auth] JWT validation timeout: 5000ms exceeded for user charlie@corp.com
2026-04-07T09:22:16.123Z ERROR [auth] DNS resolution failed for idp.corp.internal: SERVFAIL
2026-04-07T09:22:17.456Z ERROR [auth] JWKS refresh failed: getaddrinfo ENOTFOUND idp.corp.internal`;

  const code = `import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

const client = jwksClient({
  jwksUri: process.env.IDP_JWKS_URL || 'https://idp.corp.internal/oauth/.well-known/jwks.json',
  cache: true,
  cacheMaxAge: 3600000,
  timeout: 5000,
  rateLimit: true,
  jwksRequestsPerMinute: 10,
});

interface TokenPayload { sub: string; email: string; roles: string[]; exp: number; }
interface AuthError extends Error { code: string; }

export async function validateToken(token: string): Promise<TokenPayload> {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.header.kid) {
    throw Object.assign(new Error('Invalid token format'), { code: 'INVALID_TOKEN' });
  }

  const key = await client.getSigningKey(decoded.header.kid);
  const publicKey = key.getPublicKey();

  return jwt.verify(token, publicKey, {
    algorithms: ['RS256'],
    issuer: process.env.IDP_ISSUER,
    audience: process.env.IDP_AUDIENCE,
  }) as TokenPayload;
}

export async function refreshKeys(): Promise<void> {
  const newClient = jwksClient({
    jwksUri: process.env.IDP_JWKS_URL || 'https://idp.corp.internal/oauth/.well-known/jwks.json',
    cache: false,
    timeout: 5000,
  });
  await newClient.getSigningKey('probe');
}`;

  const config = `auth:
  jwt:
    validation_timeout_ms: 5000
    jwks_cache_ttl_ms: 3600000
    max_retries: 0
    fallback_to_cache: true
  circuit_breaker:
    failure_threshold: 5
    reset_timeout_ms: 60000
  identity_provider:
    url: https://idp.corp.internal/oauth
    health_check_interval_ms: 30000`;

  const task = 'Users report intermittent login failures. The auth service times out validating JWT tokens. Find the root cause and propose a fix with code.';

  const rawContext = `${task}\n\n--- SERVER LOGS ---\n${logs}\n\n--- SOURCE CODE (auth/jwt-validator.ts) ---\n${code}\n\n--- CONFIG (auth/config.yaml) ---\n${config}`;

  return { task, rawContext, sections: { logs, code, config } };
}

function generateMemoryLeakScenario(): { task: string; rawContext: string; sections: Record<string, string> } {
  const metrics = Array.from({ length: 30 }, (_, i) => {
    const hour = 9 + Math.floor(i / 6);
    const minute = (i % 6) * 10;
    const heapMB = 256 + i * 12 + Math.floor(Math.random() * 8);
    const rss = heapMB + 80 + Math.floor(Math.random() * 20);
    const gcPause = i > 20 ? 150 + i * 30 : 50 + i * 5;
    return `2026-04-07T${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}:00Z heap_used_mb=${heapMB} rss_mb=${rss} gc_pause_ms=${gcPause} active_requests=${200 + i * 3} event_loop_lag_ms=${i > 20 ? 50 + i * 10 : 5}`;
  }).join('\n');

  const heapdump = `=== HEAP SNAPSHOT DIFF (before GC vs after GC) ===
Top retained objects:
  1. EventEmitter listeners: 14,302 (+8,401 since start)
     - 'data' handlers on Socket objects: 6,200
     - 'error' handlers on Socket objects: 6,200
     - 'close' handlers on Socket objects: 1,902
  2. Buffer allocations: 892 MB total
     - Unfreed response bodies: 340 MB (2,100 instances)
     - Cached DNS results: 12 MB
  3. Closure references: 4,201
     - requestHandler closures holding req/res: 2,100
     - setTimeout callbacks pending: 2,101

=== SUSPECT: connection-pool.ts ===
Lines 45-67: Pool.acquire() creates event listeners that are never removed on connection return.`;

  const code = `import { Pool, PoolClient } from 'pg';
import { EventEmitter } from 'events';

const pool = new Pool({
  host: process.env.DB_HOST,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const connectionEvents = new EventEmitter();

export async function query<T>(sql: string, params?: unknown[]): Promise<T[]> {
  const client = await pool.connect();

  // Track connection lifecycle
  client.on('error', (err) => {
    connectionEvents.emit('connection-error', { sql, error: err.message });
  });
  client.on('end', () => {
    connectionEvents.emit('connection-end', { sql });
  });

  try {
    const result = await client.query(sql, params);
    return result.rows as T[];
  } catch (err) {
    connectionEvents.emit('query-error', { sql, error: (err as Error).message });
    throw err;
  } finally {
    client.release();
    // BUG: event listeners on client are NOT removed after release
    // When the pool reuses this client, listeners accumulate
  }
}

export function getPoolStats() {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}`;

  const task = 'Node.js API server heap grows from 256MB to 600MB+ over 5 hours, GC pauses spike to 1000ms+. Identify the memory leak and fix it.';

  const rawContext = `${task}\n\n--- METRICS (5 hours) ---\n${metrics}\n\n--- HEAP SNAPSHOT ---\n${heapdump}\n\n--- SOURCE CODE (connection-pool.ts) ---\n${code}`;

  return { task, rawContext, sections: { metrics, heapdump, code } };
}

function generateAPIMigrationScenario(): { task: string; rawContext: string; sections: Record<string, string> } {
  const oldAPI = `// OLD API: /api/v1/users
// Express router - needs migration to v2

router.get('/api/v1/users', async (req, res) => {
  const { page = 1, limit = 50, sort = 'created_at' } = req.query;
  const users = await db.query(
    'SELECT id, name, email, role, created_at FROM users ORDER BY $1 LIMIT $2 OFFSET $3',
    [sort, limit, (page - 1) * limit]
  );
  res.json({ users, total: users.length });
});

router.get('/api/v1/users/:id', async (req, res) => {
  const user = await db.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
  if (!user[0]) return res.status(404).json({ error: 'User not found' });
  res.json(user[0]);
});

router.post('/api/v1/users', async (req, res) => {
  const { name, email, role } = req.body;
  // No input validation!
  const result = await db.query(
    'INSERT INTO users (name, email, role) VALUES ($1, $2, $3) RETURNING *',
    [name, email, role]
  );
  res.status(201).json(result[0]);
});

router.put('/api/v1/users/:id', async (req, res) => {
  const { name, email, role } = req.body;
  const result = await db.query(
    'UPDATE users SET name = $1, email = $2, role = $3, updated_at = NOW() WHERE id = $4 RETURNING *',
    [name, email, role, req.params.id]
  );
  if (!result[0]) return res.status(404).json({ error: 'User not found' });
  res.json(result[0]);
});

router.delete('/api/v1/users/:id', async (req, res) => {
  await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
  res.status(204).end();
});`;

  const spec = `## API v2 Migration Requirements

1. **Pagination**: Replace offset-based with cursor-based pagination
2. **Validation**: Add Zod input validation on all mutation endpoints
3. **Response format**: Wrap all responses in { data: T, meta: { requestId, timestamp } }
4. **Error format**: Standardize errors to { error: { code, message, details } }
5. **Soft delete**: DELETE should set deleted_at instead of hard delete
6. **Rate limiting**: Add per-user rate limits (100 req/min)
7. **Audit log**: Log all mutations to audit_log table
8. **TypeScript**: Full type safety with Zod inference
9. **Tests**: Each endpoint needs unit test with supertest`;

  const dbSchema = `CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'user',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  entity_type VARCHAR(50) NOT NULL,
  entity_id UUID NOT NULL,
  action VARCHAR(20) NOT NULL,
  actor_id UUID,
  changes JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email) WHERE deleted_at IS NULL;
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);`;

  const task = 'Migrate the /api/v1/users endpoints to v2 following the spec. Write the complete v2 implementation with Zod validation, cursor pagination, soft delete, and audit logging.';

  const rawContext = `${task}\n\n--- OLD API (routes/users-v1.ts) ---\n${oldAPI}\n\n--- MIGRATION SPEC ---\n${spec}\n\n--- DATABASE SCHEMA ---\n${dbSchema}`;

  return { task, rawContext, sections: { oldAPI, spec, dbSchema } };
}

// Export for use in benchmark runner
export const scenarios = {
  'auth-timeout': generateAuthTimeoutScenario,
  'memory-leak': generateMemoryLeakScenario,
  'api-migration': generateAPIMigrationScenario,
};

export type ScenarioName = keyof typeof scenarios;
