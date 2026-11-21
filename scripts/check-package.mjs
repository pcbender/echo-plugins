import { readFile, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const root = process.cwd(), plugin = path.join(root, 'plugins/quiet-output');
const pkg = await readJson(path.join(root, 'package.json'));
const manifest = await readJson(path.join(plugin, 'plugin.json'));
const fallback = await readJson(path.join(plugin, '.codex-plugin/plugin.json'));
const marketplace = await readJson(path.join(root, '.agents/plugins/marketplace.json'));
assert.equal(manifest.name, 'quiet-output'); assert.equal(manifest.version, pkg.version); assert.equal(fallback.version, pkg.version);
assert.equal(marketplace.plugins[0].source.path, './plugins/quiet-output');
for (const name of ['mcp.json', '.mcp.json', 'hooks/hooks.json']) await readJson(path.join(plugin, name));
for (const name of ['scripts/mcp-server.mjs', 'scripts/pre-tool-use.mjs', 'scripts/quiet-run.mjs', 'skills/quiet-output/SKILL.md']) assert.ok((await stat(path.join(plugin, name))).isFile());
async function check(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules'].includes(item.name)) continue;
    const file = path.join(directory, item.name);
    if (item.isDirectory()) await check(file);
    else if (file.endsWith('.mjs')) {
      const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true });
      assert.equal(result.status, 0, result.stderr);
    }
  }
}
await check(root);
console.log('Package manifests, entry points, versions and JavaScript syntax passed.');
