import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
const root = new URL('../extension/', import.meta.url);
for (const entry of await readdir(root, { recursive: true })) {
  if (entry.endsWith('.js')) execFileSync(process.execPath, ['--check', new URL(entry, root).pathname]);
}
const manifest = JSON.parse(await readFile(new URL('manifest.json', root)));
assert.equal(manifest.manifest_version, 3);
for (const file of [...manifest.content_scripts.flatMap(script => script.js), ...manifest.background.scripts, manifest.action.default_popup, manifest.action.default_icon, ...manifest.web_accessible_resources.flatMap(item => item.resources)]) {
  await readFile(new URL(file, root));
}
console.log('JavaScript syntax and manifest resources: OK');
