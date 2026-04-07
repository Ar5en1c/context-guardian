# Scenario: Authentication Service Timeout

## Task
Users are reporting intermittent login failures. The auth service is timing out when validating JWT tokens against the identity provider. Find the root cause and propose a fix.

## Raw Data (what an agent would see in its context window)

### Server Logs (auth-service)
```
2026-04-07T09:00:00.123Z INFO  [auth] Server started on port 3001
2026-04-07T09:00:01.456Z INFO  [auth] Connected to Redis cache at redis://cache:6379
2026-04-07T09:00:02.789Z INFO  [auth] Identity provider configured: https://idp.corp.internal/oauth
2026-04-07T09:15:32.001Z WARN  [auth] JWT validation slow: 2340ms for user alice@corp.com
2026-04-07T09:15:34.567Z ERROR [auth] JWT validation timeout: 5000ms exceeded for user bob@corp.com. Error: AbortError: The operation was aborted
2026-04-07T09:15:35.890Z ERROR [auth] Failed to refresh JWKS keys from https://idp.corp.internal/oauth/.well-known/jwks.json - ETIMEDOUT
2026-04-07T09:15:36.123Z WARN  [auth] Falling back to cached JWKS keys (age: 3602 seconds)
2026-04-07T09:15:37.456Z ERROR [auth] Cached JWKS key kid=key-2024-03 not found for token kid=key-2024-04
2026-04-07T09:15:38.789Z ERROR [auth] Authentication failed for bob@corp.com: JsonWebTokenError: no matching key found
2026-04-07T09:16:00.012Z ERROR [auth] Health check: identity-provider UNREACHABLE (3 consecutive failures)
2026-04-07T09:16:01.345Z WARN  [auth] Circuit breaker OPEN for identity-provider after 5 failures in 60s window
2026-04-07T09:17:00.678Z INFO  [auth] Circuit breaker HALF-OPEN for identity-provider, attempting probe
2026-04-07T09:17:02.901Z INFO  [auth] Identity provider responded: 200 OK (latency: 890ms)
2026-04-07T09:17:03.234Z INFO  [auth] JWKS keys refreshed successfully. New key count: 3
2026-04-07T09:17:03.567Z INFO  [auth] Circuit breaker CLOSED for identity-provider
2026-04-07T09:22:15.890Z ERROR [auth] JWT validation timeout: 5000ms exceeded for user charlie@corp.com
2026-04-07T09:22:16.123Z ERROR [auth] DNS resolution failed for idp.corp.internal: SERVFAIL
2026-04-07T09:22:17.456Z ERROR [auth] JWKS refresh failed: getaddrinfo ENOTFOUND idp.corp.internal
```

### Source Code (auth/jwt-validator.ts)
```typescript
import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';

const client = jwksClient({
  jwksUri: process.env.IDP_JWKS_URL || 'https://idp.corp.internal/oauth/.well-known/jwks.json',
  cache: true,
  cacheMaxAge: 3600000, // 1 hour
  timeout: 5000,
  rateLimit: true,
  jwksRequestsPerMinute: 10,
});

export async function validateToken(token: string): Promise<TokenPayload> {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.header.kid) {
    throw new AuthError('Invalid token format', 'INVALID_TOKEN');
  }

  const key = await client.getSigningKey(decoded.header.kid);
  const publicKey = key.getPublicKey();

  const payload = jwt.verify(token, publicKey, {
    algorithms: ['RS256'],
    issuer: process.env.IDP_ISSUER,
    audience: process.env.IDP_AUDIENCE,
  }) as TokenPayload;

  return payload;
}

export async function refreshKeys(): Promise<void> {
  // Force refresh by clearing cache
  // BUG: jwks-rsa doesn't expose cache clearing in v2.x
  const newClient = jwksClient({
    jwksUri: process.env.IDP_JWKS_URL || 'https://idp.corp.internal/oauth/.well-known/jwks.json',
    cache: false,
    timeout: 5000,
  });
  await newClient.getSigningKey('test'); // This will fail but forces a fetch
}
```

### Configuration (auth/config.yaml)
```yaml
auth:
  jwt:
    validation_timeout_ms: 5000
    jwks_cache_ttl_ms: 3600000
    max_retries: 0
    fallback_to_cache: true
  circuit_breaker:
    failure_threshold: 5
    reset_timeout_ms: 60000
    half_open_max_calls: 1
  identity_provider:
    url: https://idp.corp.internal/oauth
    health_check_interval_ms: 30000
```

## Expected Analysis
1. Root cause: JWKS key rotation + DNS failures cause cache to serve stale keys
2. The cached key (kid=key-2024-03) doesn't match new tokens (kid=key-2024-04)
3. No retry logic on JWKS fetch (max_retries: 0)
4. Cache TTL is 1 hour but keys rotate more frequently
5. DNS resolution failures (SERVFAIL) suggest infrastructure issues

## Expected Fix
1. Add retry logic with exponential backoff on JWKS fetch
2. Reduce cache TTL or implement proactive refresh before expiry
3. Add DNS failover/secondary resolver
4. Implement graceful degradation: accept tokens with recently-rotated keys
