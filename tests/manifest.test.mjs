// tests/manifest.test.mjs - assets-manifest.json integrity rules and offline missing-file message
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { requiredAssetPaths, formatMissingAssets } from '../assets/vendor/tts-utils.js';

let failed = false;
function test(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failed = true; console.error('  FAIL ' + name); console.error(e); }
}

console.log('manifest tests');
const manifest = JSON.parse(readFileSync(new URL('../assets-manifest.json', import.meta.url), 'utf8'));

test('every manifest entry has dest, url and a 64-hex sha256', () => {
  assert.ok(manifest.assets.length > 0);
  for (const a of manifest.assets) {
    assert.ok(a.dest && a.url, 'dest and url: ' + JSON.stringify(a));
    assert.match(a.sha256 || '', /^[0-9a-f]{64}$/, 'sha256 for ' + a.dest);
  }
});

test('manifest dests are unique', () => {
  const dests = manifest.assets.map(a => a.dest);
  assert.equal(new Set(dests).size, dests.length);
});

test('every file the page needs is in the manifest', () => {
  const dests = new Set(manifest.assets.map(a => a.dest));
  const models = JSON.parse(readFileSync(new URL('../assets/models.json', import.meta.url), 'utf8')).models;
  for (const m of models) {
    for (const rel of requiredAssetPaths(m.id)) assert.ok(dests.has(rel), `${rel} missing from manifest (model ${m.id})`);
  }
});

test('formatMissingAssets names each file and the fix', () => {
  assert.equal(formatMissingAssets([]), '');
  const msg = formatMissingAssets(['models/x.onnx', 'wasm/piper_phonemize.data']);
  assert.match(msg, /assets\/models\/x\.onnx/);
  assert.match(msg, /assets\/wasm\/piper_phonemize\.data/);
  assert.match(msg, /populate-assets/);
});

if (failed) process.exitCode = 1; else console.log('All manifest tests passed.');
