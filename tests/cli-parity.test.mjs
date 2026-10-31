// tests/cli-parity.test.mjs - machine-readable output for every talkforge command an agent may chain:
// `version --json`, `voices list --json` (tested in voices.test.mjs), `speak --json` (with assets).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, readVersion } from '../tools/talkforge.mjs';
import { DEFAULT_ASSETS_DIR, DEFAULT_VOICE, findMissingAssets } from '../tools/node-engine.mjs';
import { parseWav, pcmStats } from '../tools/synth-lib.mjs';

const CLI = fileURLToPath(new URL('../tools/talkforge.mjs', import.meta.url));
const run = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 240000, ...opts });
let failed = false;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); }
  catch (e) { failed = true; console.error('  FAIL ' + name); console.error(e); }
}

console.log('cli parity tests');

await test('version prints the VERSION file; --json has a schema', () => {
  const v = readVersion();
  assert.match(v, /^\d+\.\d+\.\d+$/);
  assert.equal(run(['version']).stdout.trim(), v);
  const j = JSON.parse(run(['version', '--json']).stdout);
  assert.deepEqual([j.schema, j.version], ['talkforge.version/1', v]);
  assert.equal(typeof j.node, 'string');
  assert.equal(run(['version', 'extra']).status, 64);
});

await test('parseArgs: --json allowed for voices, speak and version only; --installed only for voices', () => {
  assert.equal(parseArgs(['speak', 'hi', '--json', '--out', 'a.wav']).json, true);
  assert.equal(parseArgs(['version', '--json']).json, true);
  assert.throws(() => parseArgs(['serve', '--json']), /--json is for/);
  assert.throws(() => parseArgs(['speak', 'hi', '--installed']), /--installed belongs/);
});

await test('speak --json without --out is a usage error (stdout would carry the audio)', () => {
  const r = run(['speak', 'Hello.', '--json']);
  assert.equal(r.status, 64);
  assert.match(r.stderr, /--json needs --out/);
});

const assetsDir = process.env.TALKFORGE_ASSETS || DEFAULT_ASSETS_DIR;
const voice = process.env.TALKFORGE_TEST_VOICE || DEFAULT_VOICE;
await test('speak --json --out <file> prints one JSON line describing the file (needs local assets)', async () => {
  const missing = await findMissingAssets(assetsDir, voice);
  if (missing.length) {
    if (process.env.TALKFORGE_REQUIRE_ASSETS) assert.fail(`assets required but missing: ${missing.join(', ')}`);
    console.log(`      (skipped: ${missing.length} asset file(s) missing; run populate-assets)`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'tf-par-'));
  try {
    const out = join(dir, 'a.wav');
    const r = run(['speak', 'Hello from TalkForge.', '--out', out, '--json', '--voice', voice, '--assets', assetsDir]);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    const j = JSON.parse(lines[0]);
    assert.equal(j.schema, 'talkforge.speak/1');
    assert.equal(j.format, 'wav');
    assert.equal(j.voice, voice);
    const bytes = readFileSync(out);
    assert.equal(j.bytes, bytes.length);
    const { sampleRate, pcm } = parseWav(bytes);
    assert.equal(j.sampleRate, sampleRate);
    assert.ok(Math.abs(j.seconds - pcm.length / 2 / sampleRate) < 0.002);
    assert.ok(pcmStats(pcm).peak > 0.05);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

if (failed) process.exitCode = 1; else console.log('All cli parity tests passed.');
