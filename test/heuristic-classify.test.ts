import { describe, it, expect } from 'vitest';
import { OllamaAdapter } from '../src/local-llm/ollama.js';

const adapter = new OllamaAdapter('http://localhost:11434', 'test', 'test');

describe('heuristic chunk classification (via classifyChunks)', () => {
  it('classifies error text', async () => {
    const result = await adapter.classifyChunks([
      'ERROR: connection refused to database server at 10.0.0.1:5432',
    ]);
    expect(result[0].label).toBe('error');
  });

  it('classifies stack traces', async () => {
    const result = await adapter.classifyChunks([
      'Traceback (most recent call last):\n  File "app.py", line 42\n    raise ValueError("bad")',
    ]);
    expect(result[0].label).toBe('stacktrace');
  });

  it('classifies log lines', async () => {
    const result = await adapter.classifyChunks([
      '2026-04-07T10:30:00Z [INFO] Server started on port 3000\n2026-04-07T10:30:01Z [WARN] Slow query detected',
    ]);
    expect(result[0].label).toBe('log');
  });

  it('classifies code', async () => {
    const result = await adapter.classifyChunks([
      'import { Router } from "express";\n\nconst router = Router();\nrouter.get("/api/users", async (req, res) => {\n  const users = await db.query("SELECT * FROM users");\n  res.json(users);\n});',
    ]);
    expect(result[0].label).toBe('code');
  });

  it('classifies JSON config', async () => {
    const result = await adapter.classifyChunks([
      '{\n  "port": 3000,\n  "database": {\n    "host": "localhost",\n    "name": "myapp"\n  }\n}',
    ]);
    expect(result[0].label).toBe('config');
  });

  it('classifies markdown documentation', async () => {
    const result = await adapter.classifyChunks([
      '# API Reference\n\n## Authentication\n\n> All endpoints require a valid JWT token.\n\n**POST** `/api/login`',
    ]);
    expect(result[0].label).toBe('documentation');
  });

  it('classifies terminal output', async () => {
    const result = await adapter.classifyChunks([
      '$ npm install\n$ npm run build\n+++ added 42 packages\n--- removed 3 packages',
    ]);
    expect(result[0].label).toBe('output');
  });
});
