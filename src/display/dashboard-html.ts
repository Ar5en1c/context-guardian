export function renderDashboardHTML(data: {
  mode: 'mcp' | 'proxy';
  version: string;
  uptime: number;
  intercepted: number;
  passedThrough: number;
  tokensSaved: number;
  storeSize: number;
  toolCalls: number;
  sessions: Array<{ id: string; goal: string | null; requestCount: number; chunkCount: number; lastActive: string }>;
}): string {
  const uptimeMin = Math.floor(data.uptime / 60);
  const uptimeH = Math.floor(uptimeMin / 60);
  const uptimeStr = uptimeH > 0 ? `${uptimeH}h ${uptimeMin % 60}m` : `${uptimeMin}m`;
  const estCostSaved = (data.tokensSaved * 15 / 1_000_000).toFixed(4);
  const totalReqs = data.intercepted + data.passedThrough;
  const interceptRate = totalReqs > 0 ? ((data.intercepted / totalReqs) * 100).toFixed(1) : '0.0';
  const isMCP = data.mode === 'mcp';
  const interceptedLabel = isMCP ? 'Retrieval Calls' : 'Intercepted';
  const passedLabel = isMCP ? 'Index Calls' : 'Passed Through';
  const rateLabel = isMCP ? 'Retrieval Rate' : 'Intercept Rate';
  const tokensSavedLabel = isMCP ? 'Est. Tokens Saved' : 'Tokens Saved';

  const sessionRows = data.sessions.slice(0, 15).map((s) => `
    <tr>
      <td>${esc(s.id)}</td>
      <td>${esc(s.goal || '—')}</td>
      <td>${s.requestCount}</td>
      <td>${s.chunkCount}</td>
      <td>${esc(s.lastActive)}</td>
    </tr>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Context Guardian</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, sans-serif; background: #0d1117; color: #c9d1d9; padding: 24px; max-width: 960px; margin: 0 auto; }
  h1 { color: #58a6ff; font-size: 1.6rem; margin-bottom: 4px; }
  .subtitle { color: #8b949e; font-size: 0.9rem; margin-bottom: 24px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 16px; }
  .card .label { color: #8b949e; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; }
  .card .value { font-size: 1.8rem; font-weight: 600; color: #f0f6fc; margin-top: 4px; }
  .card .value.green { color: #3fb950; }
  .card .value.blue { color: #58a6ff; }
  .card .value.orange { color: #d29922; }
  table { width: 100%; border-collapse: collapse; background: #161b22; border: 1px solid #30363d; border-radius: 8px; overflow: hidden; }
  th { background: #21262d; color: #8b949e; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.5px; padding: 10px 12px; text-align: left; }
  td { padding: 8px 12px; border-top: 1px solid #30363d; font-size: 0.85rem; }
  .section-title { color: #8b949e; font-size: 0.85rem; margin: 20px 0 8px; text-transform: uppercase; letter-spacing: 0.5px; }
  .refresh { color: #8b949e; font-size: 0.75rem; margin-top: 16px; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
</style>
</head>
<body>

<h1>Context Guardian</h1>
<p class="subtitle">v${esc(data.version)} &middot; ${esc(data.mode.toUpperCase())} mode &middot; uptime ${uptimeStr}</p>

<div class="grid">
  <div class="card">
    <div class="label">Requests</div>
    <div class="value">${totalReqs}</div>
  </div>
  <div class="card">
    <div class="label">${interceptedLabel}</div>
    <div class="value blue">${data.intercepted}</div>
  </div>
  <div class="card">
    <div class="label">${passedLabel}</div>
    <div class="value">${data.passedThrough}</div>
  </div>
  <div class="card">
    <div class="label">${rateLabel}</div>
    <div class="value">${interceptRate}%</div>
  </div>
  <div class="card">
    <div class="label">${tokensSavedLabel}</div>
    <div class="value green">${data.tokensSaved.toLocaleString()}</div>
  </div>
  <div class="card">
    <div class="label">Est. Cost Saved</div>
    <div class="value green">$${estCostSaved}</div>
  </div>
  <div class="card">
    <div class="label">Indexed Chunks</div>
    <div class="value blue">${data.storeSize}</div>
  </div>
  <div class="card">
    <div class="label">Tool Calls</div>
    <div class="value orange">${data.toolCalls}</div>
  </div>
</div>

${data.sessions.length > 0 ? `
<div class="section-title">Recent Sessions</div>
<table>
  <thead><tr><th>Session ID</th><th>Goal</th><th>Requests</th><th>Chunks</th><th>Last Active</th></tr></thead>
  <tbody>${sessionRows}</tbody>
</table>
` : ''}

<p class="refresh">Refresh the page to update. <a href="/health">JSON health</a> &middot; <a href="/stats">JSON stats</a></p>

</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
