import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shellName } from './core.mjs';

const runner = fileURLToPath(new URL('../scripts/quiet-run.mjs', import.meta.url));
function tokens(command) {
  // Deliberately pass complex commands through unchanged rather than parse shell programs.
  if (typeof command !== 'string' || /[\r\n\0;&|<>$`#()]/.test(command)) return null;
  const result = [], pattern = /\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s'"\r\n]+))/gy;
  let position = 0;
  while (position < command.length) {
    pattern.lastIndex = position;
    const match = pattern.exec(command);
    if (!match) return command.slice(position).trim() ? null : result;
    result.push(match[1] ?? match[2] ?? match[3]); position = pattern.lastIndex;
  }
  return result;
}
export function isNoisyCommand(command) {
  let args = tokens(command?.trim());
  if (!args?.length || args.some(x => /^(?:--watch(?:=|$)|--interactive(?:=|$)|-w$)/i.test(x))) return false;
  if (/^wsl(?:\.exe)?$/i.test(args[0])) {
    let i = 1;
    while (['-d', '--distribution', '-u', '--user', '--cd'].includes(args[i])) { if (!args[i + 1]) return false; i += 2; }
    if (['--', '--exec', '-e'].includes(args[i])) i++;
    args = args.slice(i);
    if (!args.length) return false;
  }
  const tool = path.win32.basename(args[0]).replace(/\.(?:exe|cmd|ps1)$/i, '').toLowerCase();
  const action = args[1];
  if (['npm', 'pnpm', 'yarn'].includes(tool)) {
    if (['install', 'i', 'ci', 'test', 't', 'rebuild', 'build', 'lint', 'check'].includes(action)) return true;
    return action === 'run' && /^(?:build|test|lint|check|typecheck|validate|verify|compile|ci)(?::[\w-]+)*$/.test(args[2] || '');
  }
  if (['pip', 'pip3'].includes(tool)) return action === 'install';
  if (['python', 'python3', 'py'].includes(tool)) return args.slice(1, 4).join(' ') === '-m pip install';
  if (tool === 'uv') return ['sync', 'build'].includes(action) || args.slice(1, 3).join(' ') === 'pip install';
  if (tool === 'poetry') return ['install', 'build'].includes(action);
  if (tool === 'cargo') return ['build', 'test', 'check', 'install'].includes(action);
  if (tool === 'go') return ['build', 'test', 'install'].includes(action) || args.slice(1, 3).join(' ') === 'mod download';
  if (tool === 'cmake') return action === '--build';
  if (tool === 'docker') return action === 'build';
  if (['vite', 'next'].includes(tool)) return action === 'build';
  return ['make', 'mvn', 'gradle', 'gradlew', './gradlew', 'pytest', 'tsc'].includes(tool);
}
const quotePS = value => `'${value.replace(/'/g, "''")}'`;
const quoteBash = value => `'${value.replace(/'/g, `'"'"'`)}'`;
export function rewriteHook(event, env = process.env, platform = process.platform) {
  if (env.QUIET_OUTPUT_OFF === '1' || event.hook_event_name && event.hook_event_name !== 'PreToolUse') return null;
  const tool = event.tool_name?.split('.').at(-1);
  if (!['Bash', 'exec_command', 'shell_command'].includes(tool)) return null;
  const input = event.tool_input;
  if (!input || input.tty === true || input.stdin !== undefined) return null;
  const field = typeof input.command === 'string' ? 'command' : typeof input.cmd === 'string' ? 'cmd' : null;
  if (!field || !isNoisyCommand(input[field])) return null;
  const shell = shellName(input.shell || env.QUIET_OUTPUT_SHELL || 'auto', platform);
  // A Windows-host hook cannot infer Git Bash versus WSL path translation.
  // WSL commands launched through PowerShell are supported without translating their arguments.
  if (platform === 'win32' && shell === 'bash') return null;
  const quote = shell === 'bash' ? quoteBash : quotePS;
  const payload = Buffer.from(JSON.stringify({ command: input[field], cwd: input.workdir || input.cwd || event.cwd, shell, login: input.login ?? true })).toString('base64url');
  const wrapped = `${shell === 'bash' ? '' : '& '}${quote(process.execPath)} ${quote(runner)} run --payload ${quote(payload)}`;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { ...input, [field]: wrapped } } };
}
