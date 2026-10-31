// tests/voices.test.mjs - `talkforge voices list`, voice/speaker checks in `speak`, GET /v1/voices.
// Uses a scratch assets folder with fake configs; needs no models or engine.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listVoices, voicesDocument, formatVoices, VOICES_SCHEMA } from '../tools/voices.mjs';
import { startServer } from '../tools/talkforge-server.mjs';
import { parseArgs } from '../tools/talkforge.mjs';

const CLI = fileURLToPath(new URL('../tools/talkforge.mjs', import.meta.url));
const TOKEN = 'test-token-0123456789abcdef';
const dir = mkdtempSync(join(tmpdir(), 'tf-voices-')).replace(/\\/g, '/');
let failed = false;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); }
  catch (e) { failed = true; console.error('  FAIL ' + name); console.error(e); }
}

// Scratch assets: catalogue lists a, b, c; configs exist for a (installed), b (config only), d (not in catalogue, installed).
const assets = `${dir}/assets`;
mkdirSync(`${assets}/models`, { recursive: true });
writeFileSync(`${assets}/models.json`, JSON.stringify({ models: [{ id: 'en_US-lessac-high', label: 'Lessac High' }, { id: 'en_GB-multi-medium', label: 'Multi' }, { id: 'ghost-voice', label: 'Ghost' }] }));
const cfg = (n, rate, lang) => JSON.stringify({ num_speakers: n, audio: { sample_rate: rate, quality: 'medium' }, language: { code: lang } });
writeFileSync(`${assets}/models/en_US-lessac-high.onnx.json`, cfg(1, 22050, 'en_US'));
writeFileSync(`${assets}/models/en_US-lessac-high.onnx`, 'stub');
writeFileSync(`${assets}/models/en_GB-multi-medium.onnx.json`, cfg(4, 22050, 'en_GB'));
writeFileSync(`${assets}/models/extra-voice.onnx.json`, cfg(1, 16000, 'xx'));
writeFileSync(`${assets}/models/extra-voice.onnx`, 'stub');
const run = (args, extra = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', ...extra });

console.log('voices tests');

await test('listVoices merges catalogue and configs, flags installed and default', async () => {
  const v = await listVoices(assets);
  assert.deepEqual(v.map((x) => x.id), ['en_GB-multi-medium', 'en_US-lessac-high', 'extra-voice', 'ghost-voice']);
  const by = Object.fromEntries(v.map((x) => [x.id, x]));
  assert.deepEqual([by['en_US-lessac-high'].installed, by['en_US-lessac-high'].default, by['en_US-lessac-high'].speakers, by['en_US-lessac-high'].sampleRate, by['en_US-lessac-high'].language], [true, true, 1, 22050, 'en_US']);
  assert.deepEqual([by['en_GB-multi-medium'].installed, by['en_GB-multi-medium'].speakers, by['en_GB-multi-medium'].label], [false, 4, 'Multi']);
  assert.deepEqual([by['extra-voice'].installed, by['extra-voice'].sampleRate, by['extra-voice'].label], [true, 16000, 'extra-voice']);
  assert.deepEqual([by['ghost-voice'].installed, by['ghost-voice'].speakers, by['ghost-voice'].sampleRate], [false, 1, null]);
});

await test('empty or missing assets folder gives an empty list, not an error', async () => {
  assert.deepEqual(await listVoices(`${dir}/nothing-here`), []);
});

await test('voicesDocument: schema, installed filter; formatVoices is a readable table', async () => {
  const all = await voicesDocument(assets);
  assert.equal(all.schema, VOICES_SCHEMA);
  assert.equal(all.default, 'en_US-lessac-high');
  assert.equal(all.voices.length, 4);
  const inst = await voicesDocument(assets, { installedOnly: true });
  assert.deepEqual(inst.voices.map((v) => v.id), ['en_US-lessac-high', 'extra-voice']);
  const text = formatVoices(all);
  assert.match(text, /^VOICE\s+STATE\s+SPEAKERS\s+RATE\s+LANG/);
  assert.match(text, /en_US-lessac-high \*\s+installed\s+1\s+22050 Hz\s+en_US/);
  assert.match(text, /ghost-voice\s+missing/);
});

await test('parseArgs: voices list, flags, and misuse', () => {
  const o = parseArgs(['voices', 'list', '--json', '--installed', '--assets', 'x']);
  assert.deepEqual([o.cmd, o.json, o.installed, o.assets], ['voices', true, true, 'x']);
  assert.throws(() => parseArgs(['voices']), /voices list/);
  assert.throws(() => parseArgs(['voices', 'add']), /voices list/);
  assert.throws(() => parseArgs(['speak', 'hi', '--json']), /voices list/);
});

await test('CLI: voices list --json is stable and machine readable', () => {
  const r = run(['voices', 'list', '--json', '--assets', assets]);
  assert.equal(r.status, 0, r.stderr);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.schema, 'talkforge.voices/1');
  assert.equal(doc.default, 'en_US-lessac-high');
  assert.equal(doc.voices.find((v) => v.id === 'en_US-lessac-high').installed, true);
  const only = JSON.parse(run(['voices', 'list', '--json', '--installed', '--assets', assets]).stdout);
  assert.equal(only.voices.length, 2);
});

await test('CLI: voices list as text marks the default and missing voices', () => {
  const r = run(['voices', 'list', '--assets', assets]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /en_US-lessac-high \*/);
  assert.match(r.stdout, /ghost-voice\s+missing/);
});

await test("CLI: the repo's own configs list the default voice (no models needed)", () => {
  const r = run(['voices', 'list', '--json', '--assets', fileURLToPath(new URL('../assets', import.meta.url))]);
  assert.equal(r.status, 0, r.stderr);
  const ids = JSON.parse(r.stdout).voices.map((v) => v.id);
  assert.ok(ids.includes('en_US-lessac-high') && ids.includes('en_US-libritts_r-medium'));
});

await test('CLI speak: unknown voice and out-of-range speaker exit 64 with the list', () => {
  const u = run(['speak', 'Hello.', '--voice', 'nope', '--out', `${dir}/a.wav`, '--assets', assets]);
  assert.equal(u.status, 64);
  assert.match(u.stderr, /Unknown voice "nope"/);
  assert.match(u.stderr, /en_US-lessac-high/);
  assert.match(u.stderr, /talkforge voices list/);
  const s = run(['speak', 'Hello.', '--voice', 'en_GB-multi-medium', '--speaker', '4', '--out', `${dir}/a.wav`, '--assets', assets]);
  assert.equal(s.status, 64);
  assert.match(s.stderr, /has 4 speaker\(s\); --speaker must be 0 to 3/);
});

await test('CLI speak: a known voice with no model file is a missing-assets error (2), not a usage error', () => {
  const r = run(['speak', 'Hello.', '--voice', 'en_GB-multi-medium', '--out', `${dir}/a.wav`, '--assets', assets]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /assets are missing/);
});

await test('CLI speak: with no catalogue at all the check is skipped and missing assets is reported (2)', () => {
  const r = run(['speak', 'Hello.', '--out', `${dir}/a.wav`, '--assets', `${dir}/nothing-here`]);
  assert.equal(r.status, 2);
});

await test('GET /v1/voices needs the token, only allows GET, and lists voices', async () => {
  const synth = { assetsDir: assets, defaultVoice: 'en_US-lessac-high', render: async () => { throw new Error('unused'); } };
  const s = await startServer({ synth, token: TOKEN, port: 0 });
  const get = (path, method = 'GET', headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ agent: false, host: '127.0.0.1', port: s.port, path, method, headers }, (res) => {
      const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString() }));
    });
    req.on('error', reject); req.end();
  });
  try {
    assert.equal((await get('/v1/voices')).status, 401);
    assert.equal((await get('/v1/voices', 'POST', { authorization: `Bearer ${TOKEN}`, 'content-length': '0' })).status, 405);
    const r = await get('/v1/voices', 'GET', { authorization: `Bearer ${TOKEN}` });
    assert.equal(r.status, 200);
    const doc = JSON.parse(r.body);
    assert.equal(doc.object, 'list');
    assert.equal(doc.default, 'en_US-lessac-high');
    assert.deepEqual(doc.data.map((v) => v.id), ['en_GB-multi-medium', 'en_US-lessac-high', 'extra-voice', 'ghost-voice']);
    assert.deepEqual(doc.data.find((v) => v.id === 'extra-voice'), { id: 'extra-voice', installed: true, default: false, speakers: 1, sample_rate: 16000, language: 'xx' });
  } finally { await s.close(); }
});

rmSync(dir, { recursive: true, force: true });
if (failed) process.exitCode = 1; else console.log('All voices tests passed.');
