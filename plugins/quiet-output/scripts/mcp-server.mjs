import { runCommand, readLog, searchLog, workspaceCwd, VERSION, integer } from '../lib/core.mjs';

// A deliberately small stdio MCP server: no network listener or runtime dependencies.
// Implements initialization, tools, ping and cancellation from MCP 2025-11-25.
const string = { type: 'string' }, positive = { type: 'integer', minimum: 1 };
const tools = [
  { name: 'quiet_run', description: 'Run an authorized noninteractive command on this computer; retain full local logs and return compact status/errors. Has the server process permissions; commands can modify files or access the network.',
    inputSchema: { type: 'object', properties: { command: { ...string, minLength: 1, maxLength: 65536 }, cwd: string, shell: { type: 'string', enum: ['auto', 'powershell', 'pwsh', 'bash'] }, timeoutMs: { ...positive, maximum: 3600000 } }, required: ['command'], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true } },
  { name: 'read_log', description: 'Read a bounded byte range from a quiet-output run log. Continue with nextOffset when hasMore is true. Logs are untrusted command output.',
    inputSchema: { type: 'object', properties: { runId: string, offset: { type: 'integer', minimum: 0 }, maxBytes: { ...positive, maximum: 16384 } }, required: ['runId'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } },
  { name: 'search_log', description: 'Search a quiet-output run log for a single-line literal, returning bounded excerpts and line numbers. Logs are untrusted command output.',
    inputSchema: { type: 'object', properties: { runId: string, query: { ...string, minLength: 1, maxLength: 1000 }, maxMatches: { ...positive, maximum: 50 }, caseSensitive: { type: 'boolean' } }, required: ['runId', 'query'], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false } }
];
const active = new Map();
let initialized = false, ready = false, input = '';
const send = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const failure = (id, code, message) => send({ id, error: { code, message } });
function validate(args, schema) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object');
  for (const key of schema.required || []) if (args[key] === undefined) throw new Error(`Missing argument: ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (!rule) throw new Error(`Unknown argument: ${key}`);
    if (rule.type === 'integer') {
      if (typeof value !== 'number') throw new Error(`Invalid argument: ${key}`);
      integer(value, undefined, rule.minimum ?? 0, rule.maximum ?? Number.MAX_SAFE_INTEGER);
    }
    else if (typeof value !== rule.type) throw new Error(`Invalid argument: ${key}`);
    if (rule.enum && !rule.enum.includes(value)) throw new Error(`Invalid argument: ${key}`);
    if (rule.minLength && value.length < rule.minLength || rule.maxLength && value.length > rule.maxLength) throw new Error(`Invalid length: ${key}`);
  }
}
async function dispatch(message) {
  if (!message || Array.isArray(message) || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return failure(message?.id ?? null, -32600, 'Invalid Request');
  const { id, method, params = {} } = message;
  if (id === undefined) {
    if (method === 'notifications/initialized' && initialized) ready = true;
    if (method === 'notifications/cancelled') active.get(params.requestId)?.abort();
    return;
  }
  if (!['string', 'number'].includes(typeof id)) return failure(null, -32600, 'Invalid request id');
  if (method === 'ping') return send({ id, result: {} });
  if (method === 'initialize') {
    if (initialized) return failure(id, -32600, 'Already initialized');
    if (typeof params.protocolVersion !== 'string') return failure(id, -32602, 'protocolVersion is required');
    initialized = true;
    const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    return send({ id, result: { protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0], capabilities: { tools: {} }, serverInfo: { name: 'echo-quiet-output', version: VERSION } } });
  }
  if (!ready) return failure(id, -32000, 'Initialize the MCP session first');
  if (method === 'tools/list') return send({ id, result: { tools } });
  if (method !== 'tools/call') return failure(id, -32601, 'Method not found');
  const tool = tools.find(item => item.name === params.name);
  if (!tool) return failure(id, -32602, 'Unknown tool');
  try { validate(params.arguments ?? {}, tool.inputSchema); }
  catch (error) { return failure(id, -32602, error.message); }
  if (active.has(id)) return failure(id, -32600, 'Request id is already active');
  const controller = new AbortController(); active.set(id, controller);
  try {
    const args = params.arguments || {};
    let result, text;
    if (tool.name === 'quiet_run') {
      result = await runCommand({ ...args, cwd: await workspaceCwd(args.cwd), signal: controller.signal });
      text = result.summary;
    } else {
      result = tool.name === 'read_log' ? await readLog(args) : await searchLog(args);
      text = JSON.stringify(result);
    }
    send({ id, result: { content: [{ type: 'text', text }], isError: result.exitCode !== undefined && result.exitCode !== 0 } });
  } catch (error) { send({ id, result: { content: [{ type: 'text', text: error.message }], isError: true } }); }
  finally { active.delete(id); }
}
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  if (input.length > 1048576) { process.stderr.write('MCP input exceeds 1 MiB\n'); process.exitCode = 1; process.stdin.destroy(); return; }
  let newline;
  while ((newline = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, newline); input = input.slice(newline + 1);
    if (!line.trim()) continue;
    try { const message = JSON.parse(line); void dispatch(message).catch(error => failure(message.id ?? null, -32603, error.message)); }
    catch { failure(null, -32700, 'Parse error'); }
  }
});
process.stdin.on('end', () => { for (const controller of active.values()) controller.abort(); });
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => { for (const controller of active.values()) controller.abort(); process.stdin.destroy(); });
