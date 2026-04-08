/**
 * OSS Benchmark Scenarios for Context Guardian.
 *
 * Design principles:
 *  - Facts are scattered at random depths (not head/tail) to avoid primacy/recency bias
 *  - Noise is realistic (mixed log formats, code, configs, prose)
 *  - Includes negative scenarios where Context Guardian should NOT help
 *  - Ground truth is machine-checkable with regex
 */

import { countTokens } from '../../src/proxy/interceptor.js';

// ─── Types ───

export type ScenarioCategory = 'debugging' | 'planning' | 'documentation' | 'data-analysis' | 'negative';
export type ContextSize = 'small' | 'medium' | 'large' | 'huge';
export type ExpectedBehavior = 'should_help' | 'should_not_help' | 'marginal';

export interface GroundTruthItem {
  key: string;
  question: string;
  answer: string;
  extractRegex: RegExp;
}

export interface Scenario {
  id: string;
  title: string;
  category: ScenarioCategory;
  contextSize: ContextSize;
  expectedBehavior: ExpectedBehavior;
  generate: (seed: number) => { task: string; rawContext: string; groundTruth: GroundTruthItem[] };
}

// ─── Seeded RNG (simple but deterministic) ───

function seededRng(seed: number) {
  let s = seed;
  return {
    next(): number {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    },
    int(min: number, max: number): number {
      return Math.floor(this.next() * (max - min + 1)) + min;
    },
    hex(len: number): string {
      return Array.from({ length: len }, () => this.int(0, 15).toString(16)).join('');
    },
    pick<T>(arr: T[]): T {
      return arr[this.int(0, arr.length - 1)];
    },
  };
}

// ─── Realistic noise generators ───

function generateRealisticNoise(targetTokens: number, seed: number): string {
  const rng = seededRng(seed);
  const blocks: string[] = [];
  const pad = (n: number) => String(n).padStart(2, '0');

  const templates = [
    (i: number) => `2026-04-07T${pad(9 + (i % 12))}:${pad(i % 60)}:${pad(i % 60)}Z INFO  [billing] Invoice ${1000 + i} processed for customer cust_${rng.hex(8)} amount=$${(rng.next() * 500).toFixed(2)}`,
    (i: number) => `2026-04-07T${pad(8 + (i % 14))}:${pad(i % 60)}:${pad(i % 60)}Z DEBUG [scheduler] Job ${rng.hex(6)} scheduled for worker-${i % 8}, queue_depth=${rng.int(0, 50)}`,
    (i: number) => `  Normal  Scheduled  pod/api-${rng.hex(6)}  Successfully assigned default/api-${rng.hex(6)} to node-${1 + (i % 5)}`,
    (i: number) => `    - name: REDIS_URL\n      value: "redis://cache-${i % 3}:6379/0"\n    - name: DB_POOL_SIZE\n      value: "${5 + (i % 20)}"`,
    (i: number) => `export function handle${rng.pick(['Billing', 'Shipping', 'Inventory', 'Notification'])}(id: string): Promise<void> {\n  return service.process(id);\n}`,
    (i: number) => `[RESOLVED] Alert: CPU usage on worker-${i % 8} returned to normal (was ${60 + rng.int(0, 35)}%, now ${10 + rng.int(0, 25)}%)`,
    () => `## Module Overview\n\nThis module handles the core business logic for user management.\nIt integrates with the authentication service and the billing pipeline.`,
    (i: number) => `  ✓ should create a new user (${45 + (i % 200)}ms)\n  ✓ should validate email format (${3 + (i % 20)}ms)\n  ✓ should enforce password policy (${8 + (i % 30)}ms)`,
    (i: number) => `server:\n  port: ${3000 + (i % 20)}\n  host: 0.0.0.0\n  workers: ${2 + (i % 6)}\n  timeout: ${30 + (i % 60)}s`,
    (i: number) => `2026-04-07T${pad(10 + (i % 8))}:${pad(i % 60)}:00Z WARN  [gateway] Rate limit approaching for tenant tenant-${rng.hex(4)}: ${800 + rng.int(0, 199)}/1000 requests`,
  ];

  let tokens = 0;
  let i = 0;
  while (tokens < targetTokens) {
    const template = templates[i % templates.length];
    const block = template(i);
    blocks.push(block);
    tokens += estimateTokens(block);
    i++;
  }
  return blocks.join('\n');
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.8);
}

function scatterFacts(noise: string, facts: Array<{ text: string; positionPct: number }>): string {
  const lines = noise.split('\n');
  const sorted = [...facts].sort((a, b) => b.positionPct - a.positionPct);
  for (const fact of sorted) {
    const insertIdx = Math.max(1, Math.floor(lines.length * fact.positionPct));
    lines.splice(insertIdx, 0, '', fact.text, '');
  }
  return lines.join('\n');
}

// ─── Scenario Definitions ───

const scenarios: Scenario[] = [

  // ── Negative scenarios (should NOT help) ──

  {
    id: 'small-clean-fix',
    title: 'Small clean bug fix request',
    category: 'negative',
    contextSize: 'small',
    expectedBehavior: 'should_not_help',
    generate: () => {
      const context = `function calculateTotal(items: Item[]): number {
  let total = 0;
  for (let i = 1; i < items.length; i++) {
    total += items[i].price * items[i].quantity;
  }
  return total;
}`;
      return {
        task: 'Fix the off-by-one error in calculateTotal where the loop starts at 1 instead of 0.',
        rawContext: context,
        groundTruth: [
          { key: 'loop_start', question: 'What should the loop start index be?', answer: '0', extractRegex: /\b0\b/ },
          { key: 'function_name', question: 'Which function has the bug?', answer: 'calculateTotal', extractRegex: /calculateTotal/i },
        ],
      };
    },
  },

  {
    id: 'small-focused-config',
    title: 'Small focused config question',
    category: 'negative',
    contextSize: 'small',
    expectedBehavior: 'should_not_help',
    generate: () => {
      const context = `upstream backend {
  server 10.0.1.5:8080 weight=3;
  server 10.0.1.6:8080 weight=2;
  keepalive 32;
}
server {
  listen 443 ssl;
  proxy_read_timeout 75s;
  proxy_connect_timeout 10s;
  location /api/ {
    proxy_pass http://backend;
  }
}`;
      return {
        task: 'Given this nginx config, what is the proxy_read_timeout value?',
        rawContext: context,
        groundTruth: [
          { key: 'timeout', question: 'What is the proxy_read_timeout?', answer: '75s', extractRegex: /75s/ },
        ],
      };
    },
  },

  {
    id: 'medium-single-artifact',
    title: 'Single focused TypeScript file review',
    category: 'negative',
    contextSize: 'medium',
    expectedBehavior: 'should_not_help',
    generate: () => {
      const context = `import { EventEmitter } from 'events';

interface Connection { id: string; socket: WebSocket; lastPing: number; }

class ConnectionPool extends EventEmitter {
  private connections = new Map<string, Connection>();
  private pingInterval: NodeJS.Timeout | null = null;

  start() {
    this.pingInterval = setInterval(() => this.pingAll(), 30000);
  }

  add(id: string, socket: WebSocket) {
    this.connections.set(id, { id, socket, lastPing: Date.now() });
    socket.on('close', () => this.remove(id));
  }

  remove(id: string) {
    const conn = this.connections.get(id);
    if (conn) {
      this.connections.delete(id);
      this.emit('disconnected', id);
    }
  }

  async broadcast(message: string) {
    const promises: Promise<void>[] = [];
    for (const [id, conn] of this.connections) {
      promises.push(new Promise((resolve, reject) => {
        conn.socket.send(message, (err) => {
          if (err) {
            this.remove(id);
            reject(err);
          } else {
            resolve();
          }
        });
      }));
    }
    // BUG: Promise.all rejects on first error, losing remaining sends
    await Promise.all(promises);
  }

  private pingAll() {
    const now = Date.now();
    for (const [id, conn] of this.connections) {
      if (now - conn.lastPing > 60000) {
        // BUG: modifying map during iteration
        this.remove(id);
      } else {
        conn.socket.ping();
        conn.lastPing = now;
      }
    }
  }

  stop() {
    if (this.pingInterval) clearInterval(this.pingInterval);
    // BUG: connections not closed on stop
  }
}`;
      return {
        task: 'Review this TypeScript file and identify the race condition or bugs.',
        rawContext: context,
        groundTruth: [
          { key: 'broadcast_bug', question: 'What is wrong with broadcast()?', answer: 'Promise.all rejects on first error', extractRegex: /Promise\.all|reject|first error|allSettled/i },
          { key: 'iteration_bug', question: 'What is wrong with pingAll()?', answer: 'modifying map during iteration', extractRegex: /modif|delet|mutat.*iter|map.*during.*iter|concurrent.*modif/i },
          { key: 'stop_bug', question: 'What is missing in stop()?', answer: 'connections not closed', extractRegex: /connection.*not.*close|close.*connection|cleanup|socket.*close/i },
        ],
      };
    },
  },

  {
    id: 'medium-adversarial-keywords',
    title: 'Adversarial: many error keywords but focused content',
    category: 'negative',
    contextSize: 'medium',
    expectedBehavior: 'should_not_help',
    generate: () => {
      const context = `// Code review findings for error-handling module
// Review of src/error-handler.ts

// Finding 1: The ERROR boundary component catches too broadly
// The catch block on line 42 swallows TypeError and RangeError equally.
// RECOMMENDATION: Separate error types into distinct handlers.

// Finding 2: TIMEOUT logic in retry wrapper is incorrect
// The FAILURE counter resets on partial success, which means
// intermittent ERRORS won't trigger the circuit breaker.
// The WARNING threshold should be 3, not 5.

// Finding 3: The error logger drops stack traces for FATAL errors
// When severity === 'FATAL', the logger calls process.exit(1)
// before flushing the ERROR details to the log sink.

export function reviewSummary(): string {
  return "3 findings: error boundary too broad, timeout logic wrong (threshold should be 3), fatal error loses stack trace";
}`;
      return {
        task: 'What are the three code review findings?',
        rawContext: context,
        groundTruth: [
          { key: 'finding1', question: 'What is finding 1?', answer: 'error boundary catches too broadly', extractRegex: /catch.*broad|error.*boundary|swallow|TypeError.*RangeError/i },
          { key: 'finding2', question: 'What is finding 2 about?', answer: 'timeout/retry logic incorrect, threshold should be 3', extractRegex: /timeout|retry|threshold.*3|circuit.*breaker/i },
          { key: 'finding3', question: 'What is finding 3 about?', answer: 'fatal error loses stack trace', extractRegex: /fatal.*stack|stack.*trace|process\.exit|flush/i },
        ],
      };
    },
  },

  // ── Marginal scenarios (medium context, debatable value) ──

  {
    id: 'medium-auth-incident',
    title: 'Medium auth timeout incident',
    category: 'debugging',
    contextSize: 'medium',
    expectedBehavior: 'marginal',
    generate: (seed) => {
      const rng = seededRng(seed);
      const noise = generateRealisticNoise(3000, seed);
      const facts = [
        { text: '# Auth Service Config\nmax_retries: 5\njwks_cache_ttl_ms: 3600000\nfailure_threshold: 12', positionPct: 0.25 },
        { text: '2026-04-07T10:15:32Z ERROR [auth] JWKS refresh failed: DNS resolution timed out for idp.example.com after 5000ms', positionPct: 0.5 },
        { text: '# Incident metadata\nretry_backoff_ms: 250\nincident_ticket: INC-7742', positionPct: 0.75 },
      ];
      const context = scatterFacts(noise, facts);
      return {
        task: 'Investigate this auth timeout incident. What are the max_retries, jwks_cache_ttl_ms, failure_threshold, root cause, retry_backoff_ms, and incident ticket?',
        rawContext: context,
        groundTruth: [
          { key: 'max_retries', question: 'What is max_retries?', answer: '5', extractRegex: /\b5\b/ },
          { key: 'jwks_cache_ttl', question: 'What is jwks_cache_ttl_ms?', answer: '3600000', extractRegex: /3600000/ },
          { key: 'failure_threshold', question: 'What is failure_threshold?', answer: '12', extractRegex: /\b12\b/ },
          { key: 'root_cause', question: 'What caused the auth failure?', answer: 'DNS resolution timed out', extractRegex: /DNS.*time|timeout.*DNS|resolution.*fail/i },
          { key: 'retry_backoff', question: 'What is retry_backoff_ms?', answer: '250', extractRegex: /\b250\b/ },
          { key: 'incident_ticket', question: 'What is the incident ticket?', answer: 'INC-7742', extractRegex: /INC-7742/i },
        ],
      };
    },
  },

  {
    id: 'medium-memory-leak',
    title: 'Medium memory leak triage',
    category: 'debugging',
    contextSize: 'medium',
    expectedBehavior: 'marginal',
    generate: (seed) => {
      const noise = generateRealisticNoise(3000, seed);
      const facts = [
        { text: '# Heap Analysis\nactive_listeners: 847\nunfreed_mb: 312\ncleanup_handler: MISSING', positionPct: 0.3 },
        { text: '2026-04-07T14:22:00Z WARN [memory] Pending timeouts: 1,203 (expected < 100)\npatch_sha: a3f9c21\nhistory_cap: 500', positionPct: 0.6 },
      ];
      const context = scatterFacts(noise, facts);
      return {
        task: 'Investigate this memory leak. What are the active listeners count, unfreed MB, cleanup status, pending timeouts, patch SHA, and history cap?',
        rawContext: context,
        groundTruth: [
          { key: 'listeners', question: 'Active listener count?', answer: '847', extractRegex: /847/ },
          { key: 'unfreed', question: 'Unfreed MB?', answer: '312', extractRegex: /312/ },
          { key: 'cleanup', question: 'Cleanup handler status?', answer: 'MISSING', extractRegex: /MISSING|missing|absent/i },
          { key: 'timeouts', question: 'Pending timeouts?', answer: '1203', extractRegex: /1[,.]?203/ },
          { key: 'patch_sha', question: 'Patch SHA?', answer: 'a3f9c21', extractRegex: /a3f9c21/i },
          { key: 'history_cap', question: 'History cap?', answer: '500', extractRegex: /\b500\b/ },
        ],
      };
    },
  },

  // ── Large scenarios (should help) ──

  {
    id: 'large-noisy-auth',
    title: 'Large: auth incident in 30K noise',
    category: 'debugging',
    contextSize: 'large',
    expectedBehavior: 'should_help',
    generate: (seed) => {
      const noise = generateRealisticNoise(28000, seed);
      const facts = [
        { text: '# Auth Config (from /etc/auth/config.yaml)\nmax_retries: 5\njwks_cache_ttl_ms: 3600000', positionPct: 0.22 },
        { text: 'failure_threshold: 12\nauth_provider: okta-prod-us-east-1', positionPct: 0.38 },
        { text: '2026-04-07T10:15:32Z ERROR [auth-refresh] JWKS endpoint unreachable: DNS resolution timed out for idp.example.com after 5000ms (attempt 5/5)', positionPct: 0.55 },
        { text: '# Retry configuration\nretry_backoff_ms: 250\ncircuit_breaker_timeout: 30000', positionPct: 0.72 },
        { text: '# Incident tracking\nincident_ticket: INC-7742\nassigned_to: oncall-auth-team', positionPct: 0.85 },
      ];
      const context = scatterFacts(noise, facts);
      return {
        task: 'Investigate this auth timeout incident from the service logs and configs. What are the max_retries, jwks_cache_ttl_ms, failure_threshold, root DNS error, retry_backoff_ms, and incident ticket?',
        rawContext: context,
        groundTruth: [
          { key: 'max_retries', question: 'What is max_retries?', answer: '5', extractRegex: /\b5\b/ },
          { key: 'jwks_cache_ttl', question: 'What is jwks_cache_ttl_ms?', answer: '3600000', extractRegex: /3600000/ },
          { key: 'failure_threshold', question: 'What is failure_threshold?', answer: '12', extractRegex: /\b12\b/ },
          { key: 'root_cause', question: 'Root DNS error?', answer: 'DNS resolution timed out', extractRegex: /DNS.*time|timeout.*DNS/i },
          { key: 'retry_backoff', question: 'retry_backoff_ms?', answer: '250', extractRegex: /\b250\b/ },
          { key: 'incident_ticket', question: 'Incident ticket?', answer: 'INC-7742', extractRegex: /INC-7742/i },
        ],
      };
    },
  },

  {
    id: 'large-api-migration',
    title: 'Large: API migration spec in mixed artifacts',
    category: 'planning',
    contextSize: 'large',
    expectedBehavior: 'should_help',
    generate: (seed) => {
      const noise = generateRealisticNoise(22000, seed);
      const facts = [
        { text: '# API v3 Migration Spec\ndefault_limit: 50\nrate_limit_per_minute: 1200', positionPct: 0.2 },
        { text: '## Data Model Changes\nsoft_delete_field: "archived_at"\nerror_response_keys: ["code", "message", "request_id"]', positionPct: 0.4 },
        { text: '## Timeline\nmigration_deadline: 2026-06-30\nrollout_strategy: canary-10-percent-then-full', positionPct: 0.65 },
      ];
      const context = scatterFacts(noise, facts);
      return {
        task: 'Extract the API v3 migration plan details: default_limit, rate_limit, soft_delete_field, error response keys, migration deadline, and rollout strategy.',
        rawContext: context,
        groundTruth: [
          { key: 'default_limit', question: 'default_limit?', answer: '50', extractRegex: /\b50\b/ },
          { key: 'rate_limit', question: 'rate_limit_per_minute?', answer: '1200', extractRegex: /1200/ },
          { key: 'soft_delete', question: 'soft_delete_field?', answer: 'archived_at', extractRegex: /archived_at/i },
          { key: 'error_keys', question: 'error response keys?', answer: 'code, message, request_id', extractRegex: /request_id/i },
          { key: 'deadline', question: 'migration deadline?', answer: '2026-06-30', extractRegex: /2026-06-30/ },
          { key: 'rollout', question: 'rollout strategy?', answer: 'canary-10-percent-then-full', extractRegex: /canary/i },
        ],
      };
    },
  },

  {
    id: 'large-mixed-data',
    title: 'Large: data analysis across mixed artifacts',
    category: 'data-analysis',
    contextSize: 'large',
    expectedBehavior: 'should_help',
    generate: (seed) => {
      const noise = generateRealisticNoise(18000, seed);
      const facts = [
        { text: '# Performance Report (last 24h)\np95_latency_ms: 342\ntotal_requests: 1847293\nerror_rate: 0.023', positionPct: 0.25 },
        { text: '## Endpoint Breakdown\n/api/v2/search: p95=891ms, count=234102 (SLOWEST)\n/api/v2/users: p95=45ms, count=892341\n/api/v2/orders: p95=123ms, count=720850', positionPct: 0.55 },
        { text: '## Cache Stats\nhit_rate: 0.847\nmiss_penalty_ms: 67\neviction_count: 12847', positionPct: 0.78 },
      ];
      const context = scatterFacts(noise, facts);
      return {
        task: 'From the performance data, what is the p95 latency, which endpoint is slowest, and what is the cache hit rate?',
        rawContext: context,
        groundTruth: [
          { key: 'p95', question: 'What is p95 latency?', answer: '342ms', extractRegex: /342/ },
          { key: 'slowest', question: 'Which endpoint is slowest?', answer: '/api/v2/search', extractRegex: /\/api\/v2\/search|search/i },
          { key: 'cache_hit', question: 'Cache hit rate?', answer: '0.847', extractRegex: /0?\.?847|84\.7/ },
        ],
      };
    },
  },

  // ── Huge scenarios (should definitely help) ──

  {
    id: 'huge-repo-dump',
    title: 'Huge: full repo dump architecture question',
    category: 'documentation',
    contextSize: 'huge',
    expectedBehavior: 'should_help',
    generate: (seed) => {
      const noise = generateRealisticNoise(75000, seed);
      const facts = [
        { text: '// src/auth/middleware.ts — ENTRY POINT 1\nexport function authMiddleware(req: Request, res: Response, next: NextFunction) {\n  const token = req.headers.authorization?.replace("Bearer ", "");\n  if (!token) return res.status(401).json({ error: "missing_token" });\n  const decoded = verifyJWT(token, config.jwt_secret);\n  req.user = decoded;\n  next();\n}', positionPct: 0.15 },
        { text: '// src/auth/oauth.ts — ENTRY POINT 2\nexport async function handleOAuthCallback(req: Request, res: Response) {\n  const { code, state } = req.query;\n  const tokens = await exchangeCode(code as string, config.oauth_client_id);\n  const session = await createSession(tokens);\n  res.cookie("session_id", session.id, { httpOnly: true, secure: true });\n  res.redirect("/dashboard");\n}', positionPct: 0.35 },
        { text: '// src/auth/api-keys.ts — ENTRY POINT 3\nexport function validateApiKey(req: Request, res: Response, next: NextFunction) {\n  const key = req.headers["x-api-key"];\n  if (!key) return next(); // fall through to JWT auth\n  const record = apiKeyStore.lookup(key as string);\n  if (!record || record.revoked) return res.status(403).json({ error: "invalid_api_key" });\n  req.user = { id: record.owner_id, role: record.role };\n  next();\n}', positionPct: 0.55 },
        { text: '# Architecture: Authentication Layer\nThe auth system uses three entry points:\n1. JWT middleware (authMiddleware) for browser sessions\n2. OAuth callback handler for SSO\n3. API key validation for programmatic access\n\nAll three converge on the User model via req.user.\nConfig lives in /config/auth.yaml with jwt_secret, oauth_client_id, and api_key_salt.', positionPct: 0.75 },
      ];
      const context = scatterFacts(noise, facts);
      return {
        task: 'Explain the authentication architecture and identify the three main entry points.',
        rawContext: context,
        groundTruth: [
          { key: 'entry1', question: 'What is entry point 1?', answer: 'JWT/auth middleware', extractRegex: /JWT|authMiddleware|middleware/i },
          { key: 'entry2', question: 'What is entry point 2?', answer: 'OAuth callback', extractRegex: /OAuth|callback|SSO/i },
          { key: 'entry3', question: 'What is entry point 3?', answer: 'API key validation', extractRegex: /API\s*key|validateApiKey|programmatic/i },
          { key: 'convergence', question: 'How do they converge?', answer: 'req.user / User model', extractRegex: /req\.user|User\s*model|converge/i },
          { key: 'config_location', question: 'Where is auth config?', answer: '/config/auth.yaml', extractRegex: /config\/auth\.yaml|auth\.yaml/i },
        ],
      };
    },
  },

  {
    id: 'huge-ci-failure',
    title: 'Huge: CI pipeline failure with full build log',
    category: 'debugging',
    contextSize: 'huge',
    expectedBehavior: 'should_help',
    generate: (seed) => {
      const noise = generateRealisticNoise(55000, seed);
      const facts = [
        { text: 'FAIL src/auth/__tests__/token.test.ts\n  ● Token validation › should reject expired tokens\n    expect(received).toThrow(expected)\n    Expected: TokenExpiredError\n    Received: function did not throw\n      at Object.<anonymous> (src/auth/__tests__/token.test.ts:42:31)', positionPct: 0.28 },
        { text: 'FAIL src/api/__tests__/orders.test.ts\n  ● Orders API › POST /orders › should validate required fields\n    expected 400 to equal 422\n    at Object.<anonymous> (src/api/__tests__/orders.test.ts:87:42)', positionPct: 0.52 },
        { text: 'FAIL src/workers/__tests__/queue.test.ts\n  ● Queue processor › should retry failed jobs\n    Timeout - Async callback was not invoked within 5000ms\n      at node_modules/jest-jasmine2/build/queue_runner.js:68:21', positionPct: 0.76 },
      ];
      const context = scatterFacts(noise, facts);
      return {
        task: 'Find the 3 failing tests in this CI build output and identify each root cause.',
        rawContext: context,
        groundTruth: [
          { key: 'fail1_name', question: 'Name of failing test 1?', answer: 'token.test.ts - should reject expired tokens', extractRegex: /token\.test|expired.*token|reject.*expired/i },
          { key: 'fail1_cause', question: 'Root cause of test 1?', answer: 'function did not throw TokenExpiredError', extractRegex: /did\s*not\s*throw|TokenExpiredError/i },
          { key: 'fail2_name', question: 'Name of failing test 2?', answer: 'orders.test.ts - should validate required fields', extractRegex: /orders\.test|validate.*required|required.*field/i },
          { key: 'fail2_cause', question: 'Root cause of test 2?', answer: 'expected 400 got 422 (wrong status code)', extractRegex: /400.*422|422.*400|status.*code|wrong.*status/i },
          { key: 'fail3_name', question: 'Name of failing test 3?', answer: 'queue.test.ts - should retry failed jobs', extractRegex: /queue\.test|retry.*failed|failed.*jobs/i },
          { key: 'fail3_cause', question: 'Root cause of test 3?', answer: 'async timeout (callback not invoked within 5000ms)', extractRegex: /timeout|5000|async.*callback|not.*invoked/i },
        ],
      };
    },
  },

  {
    id: 'large-noisy-memory',
    title: 'Large: memory leak in deployment noise',
    category: 'debugging',
    contextSize: 'large',
    expectedBehavior: 'should_help',
    generate: (seed) => {
      const noise = generateRealisticNoise(27000, seed);
      const facts = [
        { text: '# Heap Snapshot Analysis (pid 42891)\nactive_event_listeners: 847\nretained_objects: 23491\ndominator_tree_root: ConnectionPool', positionPct: 0.2 },
        { text: '# Memory Metrics\nunfreed_buffers_mb: 312\ncleanup_handler_status: NOT_REGISTERED\ngc_pause_p99_ms: 890', positionPct: 0.45 },
        { text: '2026-04-07T14:22:00Z CRITICAL [oom-watchdog] pending_timers: 1203 (threshold: 100)\npatch_sha: a3f9c21\nmax_old_space_mb: 4096\nrecommendation: cap event history at 500 entries', positionPct: 0.7 },
      ];
      const context = scatterFacts(noise, facts);
      return {
        task: 'Investigate this memory leak from the heap analysis and monitoring data. What are the active listeners, unfreed MB, cleanup status, pending timers, patch SHA, and recommended history cap?',
        rawContext: context,
        groundTruth: [
          { key: 'listeners', question: 'Active event listeners?', answer: '847', extractRegex: /847/ },
          { key: 'unfreed', question: 'Unfreed buffers MB?', answer: '312', extractRegex: /312/ },
          { key: 'cleanup', question: 'Cleanup handler status?', answer: 'NOT_REGISTERED', extractRegex: /NOT_REGISTERED|not.*register|missing/i },
          { key: 'timers', question: 'Pending timers?', answer: '1203', extractRegex: /1[,.]?203/ },
          { key: 'patch', question: 'Patch SHA?', answer: 'a3f9c21', extractRegex: /a3f9c21/i },
          { key: 'history_cap', question: 'Recommended history cap?', answer: '500', extractRegex: /\b500\b/ },
        ],
      };
    },
  },
];

export function getScenarios(): Scenario[] {
  return scenarios;
}

export function getScenarioById(id: string): Scenario | undefined {
  return scenarios.find((s) => s.id === id);
}

export function getScenariosByBehavior(behavior: ExpectedBehavior): Scenario[] {
  return scenarios.filter((s) => s.expectedBehavior === behavior);
}
