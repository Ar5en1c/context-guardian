// Heuristic entity extraction - extracts searchable entities from raw text
// No LLM call needed; pure regex patterns for speed

export interface ExtractedEntity {
  type: string;
  value: string;
}

export function extractEntities(text: string): ExtractedEntity[] {
  const entities: ExtractedEntity[] = [];
  const seen = new Set<string>();

  // Cap input to avoid regex backtracking on huge payloads
  const input = text.length > 30000 ? text.slice(0, 15000) + text.slice(-15000) : text;

  const add = (type: string, value: string) => {
    const key = `${type}:${value}`;
    if (!seen.has(key) && value.length > 2 && value.length < 200) {
      seen.add(key);
      entities.push({ type, value });
    }
  };

  // File paths (unix and windows)
  const filePaths = input.match(/(?:\/[\w.-]+){2,}(?:\.\w+)?|[\w.-]+(?:[/\\][\w.-]+){2,}(?:\.\w+)?/g);
  if (filePaths) {
    for (const fp of filePaths.slice(0, 10)) add('file_path', fp);
  }

  // Error messages: common patterns like "Error: ..." or "ENOENT" etc
  const errorPatterns = input.match(/(?:Error|TypeError|ReferenceError|SyntaxError|ENOENT|EACCES|ETIMEDOUT|ECONNREFUSED|EPERM|ERR_\w+)[:]\s*[^\n]{5,80}/gi);
  if (errorPatterns) {
    for (const ep of errorPatterns.slice(0, 5)) add('error_message', ep.trim());
  }

  // Function/method names in common languages
  const funcNames = input.match(/(?:function|def|fn|func|async)\s+(\w{3,50})/g);
  if (funcNames) {
    for (const fn of funcNames.slice(0, 10)) {
      const name = fn.replace(/^(?:function|def|fn|func|async)\s+/, '');
      add('function_name', name);
    }
  }

  // Class names
  const classNames = input.match(/(?:class|interface|struct|enum|type)\s+(\w{3,50})/g);
  if (classNames) {
    for (const cn of classNames.slice(0, 10)) {
      const name = cn.replace(/^(?:class|interface|struct|enum|type)\s+/, '');
      add('class_name', name);
    }
  }

  // HTTP status codes in context
  const httpCodes = input.match(/(?:status|HTTP\/\d\.\d|response)\s*(?:code)?\s*[:=]?\s*(4\d{2}|5\d{2})/gi);
  if (httpCodes) {
    for (const hc of httpCodes.slice(0, 3)) add('http_status', hc.trim());
  }

  // Package/module names from imports
  const imports = input.match(/(?:import|require|from)\s+['"]([^'"]{2,60})['"]/g);
  if (imports) {
    for (const imp of imports.slice(0, 10)) {
      const name = imp.replace(/^(?:import|require|from)\s+['"]/, '').replace(/['"]$/, '');
      add('module', name);
    }
  }

  // Environment variables
  const envVars = input.match(/(?:process\.env\.|ENV\[|getenv\(['"]|os\.environ\[['"])(\w{3,40})/g);
  if (envVars) {
    for (const ev of envVars.slice(0, 5)) {
      const name = ev.replace(/^.*?(?:process\.env\.|ENV\[|getenv\(['"]|os\.environ\[['"])/, '');
      add('env_var', name);
    }
  }

  // URLs and endpoints
  const urls = input.match(/https?:\/\/[^\s'"<>]{10,100}/g);
  if (urls) {
    for (const u of urls.slice(0, 5)) add('url', u);
  }

  // Config-ish keys from logs/config dumps (e.g. retry_backoff_ms: 200,400,800)
  const configKeys = [...input.matchAll(/^\s*([a-zA-Z_][\w.-]{2,50})\s*[:=]\s*[^\n]{1,120}$/gm)];
  if (configKeys) {
    for (const match of configKeys.slice(0, 12)) {
      const key = (match[1] || '').trim();
      if (/_|-/.test(key) || /^[a-z]+(?:[A-Z][a-z]+)+$/.test(key)) add('config_key', key);
    }
  }

  // Port numbers in context
  const ports = input.match(/(?:port|PORT|listen(?:ing)?)\s*[:=]?\s*(\d{2,5})/gi);
  if (ports) {
    for (const p of ports.slice(0, 3)) add('port', p.trim());
  }

  return entities;
}
