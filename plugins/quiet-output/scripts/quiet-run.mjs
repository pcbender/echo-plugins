import { runCommand, readLog, searchLog } from '../lib/core.mjs';

function parse(args) {
  const options = {};
  const names = { '--command': 'command', '--cwd': 'cwd', '--shell': 'shell', '--timeout-ms': 'timeoutMs', '--run-id': 'runId', '--offset': 'offset', '--max-bytes': 'maxBytes', '--query': 'query', '--max-matches': 'maxMatches' };
  while (args.length) {
    const flag = args.shift();
    if (!names[flag] || !args.length) throw new Error(`Unknown or incomplete option: ${flag}`);
    options[names[flag]] = args.shift();
  }
  return options;
}
try {
  const [action = 'help', ...args] = process.argv.slice(2);
  if (['--help', '-h', 'help'].includes(action)) {
    console.log('quiet-run run --command <command> [--cwd <directory>] [--shell auto|powershell|pwsh|bash] [--timeout-ms 600000]\nquiet-run read --run-id <id> [--offset 0] [--max-bytes 8192]\nquiet-run search --run-id <id> --query <literal> [--max-matches 20]');
  } else if (action === 'run') {
    let options;
    if (args[0] === '--payload' && args.length === 2) options = JSON.parse(Buffer.from(args[1], 'base64url').toString('utf8'));
    else options = parse(args);
    const controller = new AbortController();
    for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => controller.abort());
    const result = await runCommand({ ...options, signal: controller.signal });
    console.log(result.summary);
    process.exitCode = result.exitCode;
  } else if (action === 'read') console.log(JSON.stringify(await readLog(parse(args))));
  else if (action === 'search') console.log(JSON.stringify(await searchLog(parse(args))));
  else throw new Error(`Unknown action: ${action}`);
} catch (error) {
  console.error(`quiet-output: ${error.message}`);
  process.exitCode = 1;
}
