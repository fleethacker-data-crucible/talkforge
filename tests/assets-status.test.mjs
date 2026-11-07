// tests/assets-status.test.mjs - `talkforge assets status`: the offline preflight a render stage runs
// before it asks for audio. Uses a scratch assets folder and manifest; never downloads anything.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetsStatus, formatAssetsStatus, sha256Of, ASSETS_SCHEMA } from '../tools/assets-status.mjs';
import { DEFAULT_ASSETS_DIR, DEFAULT_VOICE } from '../tools/node-engine.mjs';

const CLI = fileURLToPath(new URL('../tools/talkforge.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'tf-as-')).replace(/\\/g, '/');
const assets = `${dir}/assets`;
const V = 'en_US-test-high';
const sha = (b) => createHash('sha256').update(b).digest('hex');
const noCr = (s) => Buffer.from(s.replace(/\r/g, ''));
const contents = {
  [`models/${V}.onnx`]: Buffer.from('fake model bytes'),
  [`models/${V}.onnx.json`]: 'line one\r\nline two\r\n', // CRLF on disk, LF in the manifest hash
  'vendor/onnx/ort-wasm-simd-threaded.jsep.wasm': Buffer.from('fake ort wasm'),
  'wasm/piper_phonemize.wasm': Buffer.from('fake phonemizer wasm'),
  'wasm/piper_phonemize.data': Buffer.from('fake phonemizer data')
};
const hashes = Object.fromEntries(Object.entries(contents).map(([d, c]) => [d, typeof c === 'string' ? sha(noCr(c)) : sha(c)]));
const manifest = `${dir}/manifest.json`;
writeFileSync(manifest, JSON.stringify({ assets: Object.keys(contents).map((dest) => ({ dest, url: 'https://example.invalid/' + dest, preferRelease: true, sha256: hashes[dest] })) }));
function populate() {
  for (const [d, c] of Object.entries(contents)) {
    mkdirSync(join(assets, d, '..'), { recursive: true });
    writeFileSync(join(assets, d), c);
  }
}
const run = (args) => spawnSync(process.execPath, [CLI, 'assets', 'status', '--assets', assets, '--manifest', manifest, ...args], { encoding: 'utf8', timeout: 60000 });
let failed = false;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); }
  catch (e) { failed = true; console.error('  FAIL ' + name); console.error(e); }
}

console.log('assets status tests');

await test('sha256Of strips CR bytes for .json only', () => {
  assert.equal(sha256Of(Buffer.from('a\r\nb'), 'x.json'), sha(Buffer.from('a\nb')));
  assert.equal(sha256Of(Buffer.from('a\r\nb'), 'x.wasm'), sha(Buffer.from('a\r\nb')));
});

await test('nothing downloaded yet: every file missing (except none), not ok, with fetch commands', async () => {
  const d = await assetsStatus({ assetsDir: assets, manifestPath: manifest, voice: V });
  assert.equal(d.schema, ASSETS_SCHEMA);
  assert.equal(d.ok, false);
  assert.equal(d.files.length, 5);
  assert.ok(d.files.every((f) => f.state === 'missing'));
  assert.match(d.fetch.powershell, /populate-assets\.ps1 -Only 'models\/en_US-test-high\.onnx'/);
  assert.match(d.fetch.shell, /TALKFORGE_ONLY="models\/en_US-test-high\.onnx,/);
  assert.match(formatAssetsStatus(d), /Not ready\./);
});

populate();

await test('all files present with the right bytes: ok, no fetch command, exit 0', async () => {
  const d = await assetsStatus({ assetsDir: assets, manifestPath: manifest, voice: V });
  assert.equal(d.ok, true);
  assert.ok(d.files.every((f) => f.state === 'ok'));
  assert.equal(d.fetch, null);
  const r = run(['--voice', V, '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
  assert.match(run(['--voice', V]).stdout, /All files present and verified\./);
});

await test('a changed file is a mismatch (exit 2, named in the fetch command); --no-hash only checks presence', async () => {
  writeFileSync(`${assets}/wasm/piper_phonemize.data`, 'tampered');
  const r = run(['--voice', V, '--json']);
  assert.equal(r.status, 2);
  const d = JSON.parse(r.stdout);
  assert.equal(d.ok, false);
  const f = d.files.find((x) => x.dest === 'wasm/piper_phonemize.data');
  assert.equal(f.state, 'mismatch');
  assert.notEqual(f.actual, f.expected);
  assert.match(d.fetch.shell, /wasm\/piper_phonemize\.data/);
  assert.match(d.fetch.note, /deleted first/);
  const quick = JSON.parse(run(['--voice', V, '--json', '--no-hash']).stdout);
  assert.equal(quick.ok, true);
  assert.ok(quick.files.every((x) => x.state === 'present'));
  writeFileSync(`${assets}/wasm/piper_phonemize.data`, contents['wasm/piper_phonemize.data']);
});

await test('a missing file is reported and exits 2 in text mode too', () => {
  rmSync(`${assets}/models/${V}.onnx`);
  const r = run(['--voice', V]);
  assert.equal(r.status, 2);
  assert.match(r.stdout, /MISSING\s+models\/en_US-test-high\.onnx/);
  assert.match(r.stdout, /populate-assets\.ps1 -Only/);
});

await test('unknown voice is a usage error (64) that lists the known voices', () => {
  const r = run(['--voice', 'nope']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /not in the asset manifest/);
  assert.match(r.stderr, /en_US-test-high/);
});

await test('bad invocations: `assets` alone, --no-hash elsewhere, --json on serve', () => {
  assert.equal(spawnSync(process.execPath, [CLI, 'assets'], { encoding: 'utf8' }).status, 64);
  assert.equal(spawnSync(process.execPath, [CLI, 'version', '--no-hash'], { encoding: 'utf8' }).status, 64);
  assert.equal(spawnSync(process.execPath, [CLI, 'serve', '--json'], { encoding: 'utf8' }).status, 64);
});

const realAssets = process.env.TALKFORGE_ASSETS || DEFAULT_ASSETS_DIR;
await test("the repo's own manifest names the default voice's five files (and verifies real assets when present)", async () => {
  const d = await assetsStatus({ assetsDir: realAssets, voice: DEFAULT_VOICE, hash: false });
  assert.deepEqual(d.files.map((f) => f.dest).sort(), [
    'models/en_US-libritts_r-medium.onnx', 'models/en_US-libritts_r-medium.onnx.json', 'vendor/onnx/ort-wasm-simd-threaded.jsep.wasm',
    'wasm/piper_phonemize.data', 'wasm/piper_phonemize.wasm'
  ]);
  assert.ok(d.files.every((f) => /^[0-9a-f]{64}$/.test(f.expected)));
  if (d.ok) {
    const full = await assetsStatus({ assetsDir: realAssets, voice: DEFAULT_VOICE });
    assert.equal(full.ok, true, JSON.stringify(full.files.filter((f) => f.state !== 'ok')));
  } else if (process.env.TALKFORGE_REQUIRE_ASSETS) assert.fail('assets required but not present');
});

rmSync(dir, { recursive: true, force: true });
if (failed) process.exitCode = 1; else console.log('All assets status tests passed.');
