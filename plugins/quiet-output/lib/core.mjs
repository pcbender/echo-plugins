import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, realpath, stat, writeFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { constants as osConstants, tmpdir } from 'node:os';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

export const VERSION = '0.1.0';
export const MAX_SUMMARY = 12000;
export function logDirectory(env = process.env) {
  return path.resolve(env.QUIET_OUTPUT_LOG_DIR || path.join(tmpdir(), 'echo-quiet-output'));
}
export function integer(value, fallback, min, max) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Expected integer in ${min}..${max}`);
  return n;
}
export function shellName(value = 'auto', platform = process.platform) {
  const name = path.win32.basename(value).replace(/\.exe$/i, '').toLowerCase();
  if (name === 'auto') return platform === 'win32' ? 'powershell' : 'bash';
  if (!['powershell', 'pwsh', 'bash'].includes(name)) throw new Error(`Unsupported shell: ${value}`);
  return name;
}
export function shellInvocation(command, shell, login = false) {
  if (shell === 'bash') return { file: 'bash', args: [login ? '-lc' : '-c', command] };
  // Native process failures do not automatically become PowerShell process exit codes.
  const script = `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)\n$OutputEncoding = [Console]::OutputEncoding\n$global:LASTEXITCODE = 0\ntry {\n${command}\n$quietOk = $?\n$quietExit = $LASTEXITCODE\nif (!$quietOk -and $quietExit -eq 0) { exit 1 }\nexit $quietExit\n} catch { [Console]::Error.WriteLine(($_ | Out-String)); exit 1 }`;
  return { file: shell === 'pwsh' ? 'pwsh' : 'powershell.exe', args: [...(login ? [] : ['-NoProfile']), '-NonInteractive', '-OutputFormat', 'Text', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')] };
}

// Retain a bounded preview of each line while still scanning all bytes for log searches.
export async function* logLines(file, { needle, caseSensitive = false } = {}) {
  let number = 1, preview = '', length = 0, carry = '', excerpt = null;
  const wanted = caseSensitive ? needle : needle?.toLowerCase();
  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark: 16384 });
  for await (const chunk of stream) {
    const pieces = chunk.split('\n');
    for (let i = 0; i < pieces.length; i++) {
      const piece = pieces[i];
      length += piece.length;
      if (preview.length < 2000) preview += piece.slice(0, 2000 - preview.length);
      if (wanted && excerpt === null) {
        const window = carry + piece;
        const index = (caseSensitive ? window : window.toLowerCase()).indexOf(wanted);
        if (index >= 0) excerpt = window.slice(Math.max(0, index - 80), index + wanted.length + 160);
        carry = window.slice(-(wanted.length + 80));
      }
      if (i < pieces.length - 1) {
        yield { number, text: stripVTControlCharacters(preview).replace(/\r/g, '').trimEnd(), truncated: length > 2000, excerpt };
        number++; preview = ''; length = 0; carry = ''; excerpt = null;
      }
    }
  }
  if (length) yield { number, text: stripVTControlCharacters(preview).replace(/\r/g, '').trimEnd(), truncated: length > 2000, excerpt };
}

const ERROR = /\b(error|err!|fatal|failed|failure|traceback|exception|panic|cannot find|not found|undefined reference|segmentation fault)\b/i;
const NO_ERROR = /\b(?:0 (?:errors?|failures?|failed)|no errors|without errors|errors?: 0)\b/i;
const clip = (value, size = 300) => String(value).length > size ? String(value).slice(0, size) + '…' : String(value);
export async function summarize(file, result, env = process.env) {
  const maxErrors = integer(env.QUIET_OUTPUT_MAX_ERRORS, 20, 0, 100);
  const tailCount = integer(env.QUIET_OUTPUT_TAIL, 15, 0, 100);
  const errors = new Set(), tail = [];
  let lines = 0;
  for await (const line of logLines(file)) {
    lines++;
    const text = clip(line.text) + (line.truncated ? ' [long line; read full log]' : '');
    if (ERROR.test(line.text) && !NO_ERROR.test(line.text) && errors.size < maxErrors) errors.add(text);
    if (tailCount) { tail.push(text); if (tail.length > tailCount) tail.shift(); }
  }
  const rawBytes = (await stat(file)).size;
  const status = result.timedOut ? 'TIMEOUT' : result.cancelled ? 'CANCELLED' : result.exitCode === 0 ? 'PASS' : 'FAIL';
  const output = [`${status} exit=${result.exitCode} ${result.durationMs}ms ${lines} lines ${rawBytes} bytes`,
    `cmd: ${clip(result.command, 500)}`, `shell: ${result.shell}`, `run: ${result.runId}`];
  if (result.spawnError) output.push(`launch error: ${clip(result.spawnError, 500)}`);
  // Successful noisy installs need only a status; failures retain diagnostic evidence.
  if (result.exitCode !== 0) {
    if (errors.size) output.push(`--- errors (up to ${maxErrors} distinct) ---`, ...errors);
    if (tail.length) output.push(`--- last ${tail.length} lines ---`, ...tail);
  }
  const footer = `\nfull log: ${file}\nUse read_log or search_log for additional evidence.`;
  let body = output.join('\n');
  if (body.length + footer.length > MAX_SUMMARY) body = body.slice(0, MAX_SUMMARY - footer.length - 40) + '\n[summary truncated]';
  const summary = body + footer;
  return { summary, lines, rawBytes, summaryBytes: Buffer.byteLength(summary), avoidedBytes: Math.max(0, rawBytes - Buffer.byteLength(summary)) };
}

function killTree(child, force = false) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else {
    try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch { /* Process already exited. */ }
  }
}
export async function runCommand({ command, cwd = process.cwd(), shell = 'auto', login = false, timeoutMs = 600000, env = process.env, signal } = {}) {
  if (typeof command !== 'string' || !command.trim() || command.length > 65536 || command.includes('\0')) throw new Error('command must be a nonempty string of at most 65536 characters without NUL');
  timeoutMs = integer(timeoutMs, 600000, 1, 3600000);
  // Validate summary settings before allowing command side effects.
  integer(env.QUIET_OUTPUT_MAX_ERRORS, 20, 0, 100); integer(env.QUIET_OUTPUT_TAIL, 15, 0, 100);
  shell = shellName(shell);
  cwd = await realpath(cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error('cwd must be a directory');
  const dir = logDirectory(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const runId = `${Date.now()}-${randomUUID()}`;
  const logPath = path.join(dir, `${runId}.log`);
  const handle = await open(logPath, 'wx', 0o600);
  const log = createWriteStream(logPath, { fd: handle.fd, autoClose: false });
  const result = { runId, command, cwd, shell, logPath, exitCode: 1, timedOut: false, cancelled: false, durationMs: 0 };
  const started = Date.now();
  const invocation = shellInvocation(command, shell, login);
  const child = spawn(invocation.file, invocation.args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let logError;
  // Kill the group immediately: its leader can exit before a grandchild ignores SIGTERM.
  const stop = () => killTree(child, true);
  log.on('error', error => { logError = error; stop(); });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  const abort = () => { result.cancelled = true; stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => { result.timedOut = true; stop(); }, timeoutMs);
  await new Promise(resolve => {
    child.on('error', error => { result.spawnError = error.message; result.exitCode = error.code === 'ENOENT' ? 127 : 126; });
    child.on('close', (code, termination) => {
      if (!result.spawnError) result.exitCode = result.timedOut ? 124 : result.cancelled ? 130 : code ?? (128 + (osConstants.signals[termination] || 1));
      resolve();
    });
  });
  clearTimeout(timer); signal?.removeEventListener('abort', abort);
  log.end();
  try { await finished(log); } finally { await handle.close(); }
  if (logError) throw logError;
  result.durationMs = Date.now() - started;
  Object.assign(result, await summarize(logPath, result, env));
  await writeFile(path.join(dir, `${runId}.json`), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 });
  return result;
}

export async function resolveLog(runId, env = process.env) {
  if (typeof runId !== 'string' || !/^\d{13}-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(runId)) throw new Error('Invalid runId');
  const root = await realpath(logDirectory(env));
  const file = await realpath(path.join(root, `${runId}.log`));
  if (path.dirname(file) !== root) throw new Error('Log path escapes log directory');
  return file;
}
export async function readLog({ runId, offset = 0, maxBytes = 8192 }, env = process.env) {
  offset = integer(offset, 0, 0, Number.MAX_SAFE_INTEGER); maxBytes = integer(maxBytes, 8192, 1, 16384);
  const file = await resolveLog(runId, env);
  const handle = await open(file, 'r');
  try {
    const data = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(data, 0, maxBytes, offset);
    const size = (await handle.stat()).size;
    return { runId, offset, nextOffset: offset + bytesRead, totalBytes: size, hasMore: offset + bytesRead < size, text: data.subarray(0, bytesRead).toString('utf8') };
  } finally { await handle.close(); }
}
export async function searchLog({ runId, query, maxMatches = 20, caseSensitive = false }, env = process.env) {
  if (typeof query !== 'string' || !query.length || query.length > 1000 || /[\r\n]/.test(query)) throw new Error('query must be a single-line literal of 1..1000 characters');
  maxMatches = integer(maxMatches, 20, 1, 50);
  const matches = [];
  let limited = false;
  for await (const line of logLines(await resolveLog(runId, env), { needle: query, caseSensitive })) {
    if (line.excerpt === null) continue;
    if (matches.length === maxMatches) { limited = true; break; }
    matches.push({ line: line.number, text: stripVTControlCharacters(line.excerpt).replace(/\r/g, '') });
  }
  return { runId, query, matches, limited };
}

export async function workspaceCwd(requested, root = process.env.QUIET_OUTPUT_ROOT || process.cwd()) {
  const base = await realpath(root), target = await realpath(path.resolve(base, requested || '.'));
  const relative = path.relative(base, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('cwd is outside QUIET_OUTPUT_ROOT');
  return target;
}
