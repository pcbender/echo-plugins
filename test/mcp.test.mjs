import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('MCP initialization, compact command execution, retrieval, validation and cancellation', { timeout: 20000 }, async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'echo-mcp-'));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../plugins/quiet-output/scripts/mcp-server.mjs', import.meta.url))], {
    cwd: dir, env: { ...process.env, QUIET_OUTPUT_ROOT: dir, QUIET_OUTPUT_LOG_DIR: path.join(dir, 'logs') }, windowsHide: true
  });
  let counter = 0, stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); });
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  const request = (method, params = {}, id = ++counter) => new Promise(resolve => { pending.set(id, resolve); send({ id, method, params }); });
  t.after(async () => { child.stdin.end(); await new Promise(resolve => child.once('exit', resolve)); lines.close(); await rm(dir, { recursive: true, force: true }); });
  const init = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'echo-test', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-11-25');
  send({ method: 'notifications/initialized' });
  const listed = await request('tools/list'); assert.deepEqual(listed.result.tools.map(tool => tool.name), ['quiet_run', 'read_log', 'search_log']);
  const command = process.platform === 'win32' ? "Write-Output 'error MCP42'; exit 7" : "printf 'error MCP42\\n'; exit 7";
  const run = await request('tools/call', { name: 'quiet_run', arguments: { command } });
  assert.equal(run.result.isError, true); assert.match(run.result.content[0].text, /FAIL exit=7/);
  const runId = run.result.content[0].text.match(/run: (\S+)/)[1];
  const search = await request('tools/call', { name: 'search_log', arguments: { runId, query: 'MCP42' } });
  assert.equal(JSON.parse(search.result.content[0].text).matches.length, 1);
  const read = await request('tools/call', { name: 'read_log', arguments: { runId, maxBytes: 10 } });
  assert.equal(JSON.parse(read.result.content[0].text).hasMore, true);
  const invalid = await request('tools/call', { name: 'quiet_run', arguments: { command: 'echo bad', typo: true } });
  assert.equal(invalid.error.code, -32602);
  const wrongType = await request('tools/call', { name: 'read_log', arguments: { runId, maxBytes: '100' } });
  assert.equal(wrongType.error.code, -32602);
  const outside = await request('tools/call', { name: 'quiet_run', arguments: { command: 'echo bad', cwd: '..' } });
  assert.equal(outside.result.isError, true); assert.match(outside.result.content[0].text, /outside/);
  const forever = process.platform === 'win32' ? 'Start-Sleep -Seconds 20' : 'sleep 20';
  const id = ++counter;
  const waiting = request('tools/call', { name: 'quiet_run', arguments: { command: forever } }, id);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.ok((await request('ping')).result);
  send({ method: 'notifications/cancelled', params: { requestId: id, reason: 'test completed' } });
  assert.match((await waiting).result.content[0].text, /CANCELLED exit=130/);
  assert.equal(stderr, '');
});
