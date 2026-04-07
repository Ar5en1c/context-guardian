import { describe, it, expect } from 'vitest';
import { extractEntities } from '../src/index/entity-extractor.js';

describe('extractEntities', () => {
  it('extracts file paths', () => {
    const text = 'Error in /src/proxy/server.ts at line 42\nAlso check /usr/local/bin/node';
    const entities = extractEntities(text);
    const filePaths = entities.filter((e) => e.type === 'file_path');
    expect(filePaths.length).toBeGreaterThanOrEqual(1);
    expect(filePaths.some((e) => e.value.includes('server.ts'))).toBe(true);
  });

  it('extracts error messages', () => {
    const text = 'TypeError: Cannot read property "foo" of undefined\nECONNREFUSED: connection refused to localhost';
    const entities = extractEntities(text);
    const errors = entities.filter((e) => e.type === 'error_message');
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('extracts function names', () => {
    const text = 'function handleRequest(req, res) {\n  function processData() {}';
    const entities = extractEntities(text);
    const funcs = entities.filter((e) => e.type === 'function_name');
    expect(funcs.some((e) => e.value === 'handleRequest')).toBe(true);
    expect(funcs.some((e) => e.value === 'processData')).toBe(true);
  });

  it('extracts class names', () => {
    const text = 'class SessionStore {\n  interface Config {}\n  type Result = string;';
    const entities = extractEntities(text);
    const classes = entities.filter((e) => e.type === 'class_name');
    expect(classes.some((e) => e.value === 'SessionStore')).toBe(true);
  });

  it('extracts module imports', () => {
    const text = "import { Hono } from 'hono';\nconst fs = require('node:fs');";
    const entities = extractEntities(text);
    const modules = entities.filter((e) => e.type === 'module');
    expect(modules.some((e) => e.value === 'hono')).toBe(true);
  });

  it('extracts URLs', () => {
    const text = 'Fetching from https://api.example.com/v1/users and posting to https://hooks.slack.com/webhook';
    const entities = extractEntities(text);
    const urls = entities.filter((e) => e.type === 'url');
    expect(urls.length).toBeGreaterThanOrEqual(1);
  });

  it('handles empty and short strings', () => {
    expect(extractEntities('')).toEqual([]);
    expect(extractEntities('hi')).toEqual([]);
  });

  it('caps input on very large strings', () => {
    const huge = 'function bigFunc() {}\n'.repeat(5000);
    const start = Date.now();
    const entities = extractEntities(huge);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000);
    expect(entities.length).toBeGreaterThan(0);
  });

  it('deduplicates entities', () => {
    const text = 'import foo from "bar";\nimport foo from "bar";\nimport foo from "bar";';
    const entities = extractEntities(text);
    const modules = entities.filter((e) => e.type === 'module');
    expect(modules.length).toBe(1);
  });
});
