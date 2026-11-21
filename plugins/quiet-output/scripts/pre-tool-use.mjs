import { rewriteHook } from '../lib/hook.mjs';

let input = '';
try {
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 262144) throw new Error('Hook input too large');
  }
  const result = rewriteHook(JSON.parse(input));
  if (result) process.stdout.write(JSON.stringify(result));
} catch (error) {
  // A broken adapter must never prevent the original command from running.
  process.stderr.write(`quiet-output hook skipped: ${error.message}\n`);
}
