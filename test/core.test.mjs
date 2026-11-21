import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runCommand, readLog, searchLog, resolveLog, workspaceCwd, MAX_SUMMARY } from '../plugins/quiet-output/lib/core.mjs';

const win = process.platform === 'win32';
const quote = value => win ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, `'"'"'`)}'`;
const nodeCommand = file => `${win ? '& ' : ''}${quote(process.execPath)} ${quote(file)}`;
async function fixture(t, code) {
  const dir = await mkdtemp(path.join(tmpdir(), "echo quiet's "));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'fixture.cjs'); await writeFile(script, code);
  return { dir, command: nodeCommand(script), env: { ...process.env, QUIET_OUTPUT_LOG_DIR: path.join(dir, 'logs') } };
}
test('success keeps the entire noisy log and returns a compact result', async t => {
  const f = await fixture(t, `for(let i=0;i<3000;i++) console.log('output '+i);console.error('unicode café 🎵');`);
  const result = await runCommand({ command: f.command, cwd: f.dir, env: f.env });
  const raw = await readFile(result.logPath, 'utf8');
  assert.equal(result.exitCode, 0); assert.match(result.summary, /^PASS/);
  assert.match(raw, /output 2999/); assert.match(raw, /unicode café 🎵/);
  assert.ok(result.summaryBytes < result.rawBytes / 10);
  assert.equal((await readFile(path.join(f.env.QUIET_OUTPUT_LOG_DIR, result.runId + '.json'), 'utf8')).includes('avoidedBytes'), true);
});
test('failure preserves the native exit code, stderr, distinct errors and final evidence', async t => {
  const f = await fixture(t, `for(let i=0;i<300;i++) console.log('normal '+i);console.error('error E123: bad input');console.error('error E123: bad input');console.log('final evidence');process.exitCode=7;`);
  const result = await runCommand({ command: f.command, cwd: f.dir, env: f.env });
  assert.equal(result.exitCode, 7); assert.match(result.summary, /^FAIL exit=7/);
  assert.match(result.summary, /error E123/); assert.match(result.summary, /final evidence/);
  const search = await searchLog({ runId: result.runId, query: 'E123' }, f.env);
  assert.equal(search.matches.length, 2);
  const first = await readLog({ runId: result.runId, maxBytes: 32 }, f.env);
  const next = await readLog({ runId: result.runId, offset: first.nextOffset, maxBytes: 32 }, f.env);
  assert.equal(first.text + next.text, (await readFile(result.logPath)).subarray(0, 64).toString());
});
test('multi-megabyte lines stay bounded and searches cover the portion outside the preview', async t => {
  const f = await fixture(t, `console.log('x'.repeat(2000000)+'HIDDEN_NEEDLE');process.exitCode=3;`);
  const result = await runCommand({ command: f.command, cwd: f.dir, env: f.env });
  assert.ok(result.summary.length <= MAX_SUMMARY); assert.equal(result.exitCode, 3);
  assert.match(result.summary, /long line/);
  assert.equal((await searchLog({ runId: result.runId, query: 'hidden_needle' }, f.env)).matches.length, 1);
});
test('timeout and cancellation are failures, and stop the command', async t => {
  const f = await fixture(t, 'setInterval(()=>{},1000)');
  const timeout = await runCommand({ command: f.command, cwd: f.dir, env: f.env, timeoutMs: 600 });
  assert.equal(timeout.exitCode, 124); assert.equal(timeout.timedOut, true);
  const controller = new AbortController();
  const pending = runCommand({ command: f.command, cwd: f.dir, env: f.env, signal: controller.signal });
  setTimeout(() => controller.abort(), 600);
  const cancelled = await pending; assert.equal(cancelled.exitCode, 130);
});
test('timeout stops descendants that detached their output streams', async t => {
  const f = await fixture(t, '');
  const marker = path.join(f.dir, 'descendant-ran');
  const childCode = `process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected'),1800)`;
  await writeFile(path.join(f.dir, 'fixture.cjs'), `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setInterval(()=>{},1000);`);
  const result = await runCommand({ command: f.command, cwd: f.dir, env: f.env, timeoutMs: 700 });
  assert.equal(result.exitCode, 124);
  await new Promise(resolve => setTimeout(resolve, 2000));
  await assert.rejects(access(marker));
});
test('invalid configuration cannot execute the requested command', async t => {
  const f = await fixture(t, 'throw new Error("should not run")');
  await assert.rejects(runCommand({ command: f.command, cwd: f.dir, env: { ...f.env, QUIET_OUTPUT_TAIL: 'NaN' } }), /integer/);
  await assert.rejects(resolveLog('../outside', f.env), /Invalid runId/);
  await assert.rejects(workspaceCwd('..', f.dir), /outside/);
});
test('workspace confinement resolves symlinks', async t => {
  const f = await fixture(t, ''); const outside = await mkdtemp(path.join(tmpdir(), 'echo-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(f.dir, 'escape'), win ? 'junction' : 'dir');
  await assert.rejects(workspaceCwd('escape', f.dir), /outside/);
});
test('explicit PowerShell commands retain quotes, variables, Unicode and failures', { skip: !win }, async t => {
  const f = await fixture(t, '');
  const result = await runCommand({ command: `$text = 'café ''quoted'''; Write-Output $text; Write-Error 'explicit failure'`, cwd: f.dir, env: f.env });
  assert.equal(result.exitCode, 1);
  assert.match(await readFile(result.logPath, 'utf8'), /café 'quoted'/);
});
test('PowerShell 7 executes Unicode and explicit exit status', { skip: !win || process.env.QUIET_OUTPUT_TEST_PWSH !== '1' }, async t => {
  const f = await fixture(t, '');
  const result = await runCommand({ command: "Write-Output 'music 🎵'; exit 23", shell: 'pwsh', cwd: f.dir, env: f.env });
  assert.equal(result.exitCode, 23); assert.match(await readFile(result.logPath, 'utf8'), /music 🎵/);
});
test('Windows runner preserves a WSL command exit code', { skip: !win || process.env.QUIET_OUTPUT_TEST_WSL !== '1' }, async t => {
  const f = await fixture(t, '');
  const result = await runCommand({ command: `wsl.exe -d Ubuntu-24.04 --exec sh -c 'printf wsl-ok; exit 9'`, cwd: f.dir, env: f.env });
  assert.equal(result.exitCode, 9); assert.match(await readFile(result.logPath, 'utf8'), /wsl-ok/);
});
