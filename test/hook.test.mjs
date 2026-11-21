import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isNoisyCommand, rewriteHook } from '../plugins/quiet-output/lib/hook.mjs';
import { runCommand } from '../plugins/quiet-output/lib/core.mjs';

test('hook selects plain noninteractive build commands and passes shell programs through', () => {
  for (const command of ['npm run build', 'npm.cmd test', 'python -m pip install foo', 'cargo check', 'wsl.exe -d Ubuntu-24.04 -- npm test']) assert.equal(isNoisyCommand(command), true, command);
  for (const command of ['npm test | tail', 'npm test && echo done', 'npm test > log', 'npm test\necho done', 'npm test $TOKEN', 'npm run dev', 'npm test --watch', 'echo npm test', 'npm test "unclosed']) assert.equal(isNoisyCommand(command), false, command);
});
test('rewrite retains tool parameters, shell and original command as data', () => {
  const input = { cmd: 'npm run build', shell: 'powershell.exe', login: false, workdir: "C:\\project's folder", sandbox_permissions: 'require_escalated', timeout_ms: 9000 };
  const result = rewriteHook({ hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_input: input }, {}, 'win32');
  assert.equal(result.hookSpecificOutput.updatedInput.sandbox_permissions, input.sandbox_permissions);
  assert.equal(result.hookSpecificOutput.updatedInput.timeout_ms, 9000);
  const payload = result.hookSpecificOutput.updatedInput.cmd.match(/--payload '([^']+)'/)[1];
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).command, input.cmd);
  assert.equal(rewriteHook({ tool_name: 'Bash', tool_input: { command: 'npm test', shell: 'bash' } }, {}, 'win32'), null);
  assert.equal(rewriteHook({ tool_name: 'Bash', tool_input: { command: 'npm test' } }, { QUIET_OUTPUT_OFF: '1' }), null);
});
test('hook script passes malformed input through without failing the original tool', () => {
  const script = fileURLToPath(new URL('../plugins/quiet-output/scripts/pre-tool-use.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], { input: '{bad', encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.match(result.stderr, /skipped/);
});
test('rewritten npm build works end to end from a directory containing spaces and apostrophes', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), "echo hook's "));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ scripts: { build: 'node fixture.cjs' } }));
  await writeFile(path.join(dir, 'fixture.cjs'), `for(let i=0;i<1000;i++) console.log('build noise '+i);console.error('error BUILD42');process.exitCode=7;`);
  const result = rewriteHook({ tool_name: 'Bash', cwd: dir, tool_input: { command: 'npm run build', login: false } });
  const wrapped = await runCommand({ command: result.hookSpecificOutput.updatedInput.command, cwd: dir, env: { ...process.env, QUIET_OUTPUT_LOG_DIR: path.join(dir, 'logs') } });
  assert.equal(wrapped.exitCode, 7); assert.match(wrapped.summary, /BUILD42/); assert.ok(wrapped.rawBytes < 4000);
});
