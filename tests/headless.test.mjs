// tests/headless.test.mjs - `talkforge speak` and the loopback speech endpoint.
// Server tests use a fake synthesizer (no assets needed); the end-to-end cases need local assets
// and skip without them (TALKFORGE_REQUIRE_ASSETS=1 makes absence a failure, as in CI).
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, checkToken, tokenMatches, MAX_BODY_BYTES, MAX_INPUT_CHARS } from '../tools/talkforge-server.mjs';
import { parseArgs } from '../tools/talkforge.mjs';
import { DEFAULT_ASSETS_DIR, DEFAULT_VOICE, MissingAssetsError, findMissingAssets } from '../tools/node-engine.mjs';
import { createSynthesizer } from '../tools/synth-core.mjs';
import { parseWav, pcmStats } from '../tools/synth-lib.mjs';

const CLI = fileURLToPath(new URL('../tools/talkforge.mjs', import.meta.url));
const TOKEN = 'test-token-0123456789abcdef';
let failed = false;
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try { await fn(); console.log('  ok  ' + name); }
    catch (e) { failed = true; console.error('  FAIL ' + name); console.error(e); }
  })());
}

function request(port, { method = 'POST', path = '/v1/audio/speech', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : (Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request({ agent: false, host: '127.0.0.1', port, method, path, headers: { ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const auth = { authorization: `Bearer ${TOKEN}` };

function fakeSynth(over = {}) {
  const calls = [];
  return {
    calls, assetsDir: join(tmpdir(), 'tf-no-such-assets'), defaultVoice: 'en_US-libritts-high',
    render: over.render || (async (req) => { calls.push(req); return { bytes: Buffer.from('RIFF....WAVEfake'), mime: 'audio/wav', seconds: 1.5, voice: req.voice }; })
  };
}

console.log('headless tests');

test('token rules: required, minimum length, bearer match', () => {
  assert.throws(() => checkToken(undefined), /token/);
  assert.throws(() => checkToken('short'), /at least 16/);
  assert.equal(checkToken(`  ${TOKEN}\n`), TOKEN);
  assert.equal(tokenMatches(`Bearer ${TOKEN}`, TOKEN), true);
  assert.equal(tokenMatches(`bearer ${TOKEN}`, TOKEN), true);
  assert.equal(tokenMatches(TOKEN, TOKEN), false);
  assert.equal(tokenMatches('Bearer wrong', TOKEN), false);
  assert.equal(tokenMatches(undefined, TOKEN), false);
});

test('server refuses to start without a valid token', () => {
  assert.throws(() => startServer({ synth: fakeSynth(), token: '', port: 0 }), /token/);
});

test('server binds 127.0.0.1 only', async () => {
  const s = await startServer({ synth: fakeSynth(), token: TOKEN, port: 0 });
  try { assert.equal(s.server.address().address, '127.0.0.1'); } finally { await s.close(); }
});

test('auth: 401 without or with a wrong token, and the synthesizer is never called', async () => {
  const synth = fakeSynth();
  const s = await startServer({ synth, token: TOKEN, port: 0 });
  try {
    const body = { input: 'hi' };
    assert.equal((await request(s.port, { body })).status, 401);
    const wrong = await request(s.port, { body, headers: { authorization: 'Bearer nope-nope-nope-nope' } });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.headers['www-authenticate'], 'Bearer');
    assert.equal((await request(s.port, { method: 'GET', path: '/anything' })).status, 401);
    assert.equal(synth.calls.length, 0);
  } finally { await s.close(); }
});

test('refuses a non-loopback Host header and any Origin header', async () => {
  const s = await startServer({ synth: fakeSynth(), token: TOKEN, port: 0 });
  try {
    const body = { input: 'hi' };
    assert.equal((await request(s.port, { body, headers: { ...auth, host: 'evil.example.com' } })).status, 403);
    assert.equal((await request(s.port, { body, headers: { ...auth, host: `evil.example.com:${s.port}` } })).status, 403);
    assert.equal((await request(s.port, { body, headers: { ...auth, origin: 'http://evil.example.com' } })).status, 403);
    assert.equal((await request(s.port, { body, headers: { ...auth, host: `localhost:${s.port}` } })).status, 200);
  } finally { await s.close(); }
});

test('routing and validation errors', async () => {
  const s = await startServer({ synth: fakeSynth(), token: TOKEN, port: 0 });
  try {
    assert.equal((await request(s.port, { path: '/nope', headers: auth, body: {} })).status, 404);
    assert.equal((await request(s.port, { method: 'GET', headers: auth })).status, 405);
    const bad = async (body, re) => {
      const r = await request(s.port, { headers: auth, body });
      assert.equal(r.status, 400, JSON.stringify(body));
      assert.match(JSON.parse(r.body).error.message, re);
    };
    await bad('not json', /JSON/);
    await bad({}, /input/);
    await bad({ input: '   ' }, /input/);
    await bad({ input: 'x'.repeat(MAX_INPUT_CHARS + 1) }, /longer than/);
    await bad({ input: 'hi', response_format: 'ogg' }, /wav or mp3/);
    await bad({ input: 'hi', speed: 9 }, /speed/);
    await bad({ input: 'hi', speed: '2' }, /speed/);
    await bad({ input: 'hi', speaker: -1 }, /speaker/);
    // Oversized body: the server answers 413, but on some OSes it resets the connection while the
    // client is still sending; either way the request must not succeed and nothing is synthesized.
    const big = await request(s.port, { headers: auth, body: Buffer.alloc(MAX_BODY_BYTES + 10, 97) }).catch((e) => ({ status: e.code }));
    assert.ok(big.status === 413 || big.status === 'ECONNRESET' || big.status === 'EPIPE', String(big.status));
  } catch (e) { throw e; } finally { await s.close(); }
});

test('200: passes parameters to the synthesizer and returns audio headers', async () => {
  const synth = fakeSynth();
  const s = await startServer({ synth, token: TOKEN, port: 0 });
  try {
    const r = await request(s.port, { headers: auth, body: { input: 'Hello there.', speed: 1.25, speaker: 3, response_format: 'mp3' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers['content-type'], 'audio/wav'); // from the fake; the real synthesizer returns audio/mpeg for mp3
    assert.equal(r.headers['x-talkforge-voice'], 'en_US-libritts-high');
    assert.equal(r.headers['x-talkforge-seconds'], '1.500');
    assert.deepEqual(synth.calls[0], { text: 'Hello there.', voice: 'en_US-libritts-high', speed: 1.25, speaker: 3, format: 'mp3' });
    // foreign voice names (OpenAI clients send "alloy") fall back to the default voice
    await request(s.port, { headers: auth, body: { input: 'x', voice: 'alloy' } });
    assert.equal(synth.calls[1].voice, 'en_US-libritts-high');
    // path traversal in voice never reaches the file system check as anything but a fallback
    await request(s.port, { headers: auth, body: { input: 'x', voice: '../../etc/passwd' } });
    assert.equal(synth.calls[2].voice, 'en_US-libritts-high');
  } finally { await s.close(); }
});

test('missing assets -> 503 with the file list; other failures -> 500', async () => {
  const s503 = await startServer({ synth: fakeSynth({ render: async () => { throw new MissingAssetsError('/a', ['models/x.onnx']); } }), token: TOKEN, port: 0 });
  try {
    const r = await request(s503.port, { headers: auth, body: { input: 'hi' } });
    assert.equal(r.status, 503);
    assert.match(JSON.parse(r.body).error.message, /models[\\/]x\.onnx/);
  } finally { await s503.close(); }
  const s500 = await startServer({ synth: fakeSynth({ render: async () => { throw new Error('boom'); } }), token: TOKEN, port: 0 });
  try { assert.equal((await request(s500.port, { headers: auth, body: { input: 'hi' } })).status, 500); } finally { await s500.close(); }
});

test('parseArgs: speak and serve options, usage errors', () => {
  const a = parseArgs(['speak', 'Hello', 'world', '--out', 'x.mp3', '--voice', 'v', '--speed', '1.1', '--speaker', '2']);
  assert.deepEqual([a.cmd, a.text.join(' '), a.out, a.voice, a.speed, a.speaker], ['speak', 'Hello world', 'x.mp3', 'v', 1.1, 2]);
  assert.equal(parseArgs(['serve', '--port', '0']).port, 0);
  assert.equal(parseArgs(['serve']).port, 25009);
  assert.equal(parseArgs([]).cmd, 'help');
  assert.throws(() => parseArgs(['nope']), /Unknown command/);
  assert.throws(() => parseArgs(['serve', 'text']), /no text/);
  assert.throws(() => parseArgs(['serve', '--port', '70000']), /--port/);
  assert.throws(() => parseArgs(['speak', '--format', 'ogg']), /wav or mp3/);
  assert.throws(() => parseArgs(['speak', '--host', '0.0.0.0']), /Unknown option/); // no host option exists
});

test('CLI: serve with no token at all (local token off) exits 1; with only the local token it gets past the token check; speak without text exits 64; speak with missing assets exits 2', () => {
  const env = { ...process.env, TALKFORGE_LOCAL_TOKEN: 'off' }; delete env.TALKFORGE_TOKEN;
  const noToken = spawnSync(process.execPath, [CLI, 'serve', '--port', '0', '--assets', join(tmpdir(), 'tf-none')], { encoding: 'utf8', env });
  assert.equal(noToken.status, 1);
  assert.match(noToken.stderr, /token/);
  // With the local token (in a temp file here) serve needs nothing configured: it stops later, at the missing assets.
  const tokDir = mkdtempSync(join(tmpdir(), 'tf-lt-'));
  try {
    const localOnly = spawnSync(process.execPath, [CLI, 'serve', '--port', '0', '--assets', join(tokDir, 'none')], { encoding: 'utf8', env: { ...env, TALKFORGE_LOCAL_TOKEN: '', TALKFORGE_LOCAL_TOKEN_FILE: join(tokDir, 'local-token') } });
    assert.equal(localOnly.status, 2, localOnly.stderr);
    assert.match(localOnly.stderr, /Local token/);
  } finally { rmSync(tokDir, { recursive: true, force: true }); }
  const noText = spawnSync(process.execPath, [CLI, 'speak', '--out', '-'], { encoding: 'utf8', input: '  ' });
  assert.equal(noText.status, 64);
  const dir = mkdtempSync(join(tmpdir(), 'tf-hl-'));
  try {
    const r = spawnSync(process.execPath, [CLI, 'speak', 'Hello.', '--out', join(dir, 'a.wav'), '--assets', join(dir, 'none')], { encoding: 'utf8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /assets are missing/);
    assert.equal(existsSync(join(dir, 'a.wav')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// End to end with real assets.
const assetsDir = process.env.TALKFORGE_ASSETS || DEFAULT_ASSETS_DIR;
const voice = process.env.TALKFORGE_TEST_VOICE || DEFAULT_VOICE;
async function haveAssets() {
  const missing = await findMissingAssets(assetsDir, voice);
  if (!missing.length) return true;
  if (process.env.TALKFORGE_REQUIRE_ASSETS) assert.fail(`assets required but missing: ${missing.join(', ')}`);
  console.log(`      (skipped: ${missing.length} asset file(s) missing; run populate-assets)`);
  return false;
}

test('end to end: endpoint returns a valid, non-silent WAV and an MP3 (needs local assets)', async () => {
  if (!(await haveAssets())) return;
  const synth = createSynthesizer({ assets: assetsDir, defaultVoice: voice });
  const s = await startServer({ synth, token: TOKEN, port: 0 });
  try {
    const r = await request(s.port, { headers: auth, body: { input: 'Hello from TalkForge.', voice } });
    assert.equal(r.status, 200, r.body.toString());
    assert.equal(r.headers['content-type'], 'audio/wav');
    const { sampleRate, pcm } = parseWav(r.body);
    assert.equal(r.body.readUInt32LE(4), r.body.length - 8);
    assert.ok(pcm.length / 2 / sampleRate > 0.5);
    assert.ok(pcmStats(pcm).peak > 0.05);
    const m = await request(s.port, { headers: auth, body: { input: 'Hello from TalkForge.', voice, response_format: 'mp3' } });
    assert.equal(m.status, 200);
    assert.equal(m.headers['content-type'], 'audio/mpeg');
    assert.ok(m.body.length > 1000);
  } finally { await s.close(); }
});

test('end to end: `talkforge speak` writes a WAV from args and from stdin (needs local assets)', async () => {
  if (!(await haveAssets())) return;
  const dir = mkdtempSync(join(tmpdir(), 'tf-hl-'));
  try {
    const a = spawnSync(process.execPath, [CLI, 'speak', 'Hello', 'from', 'TalkForge.', '--out', join(dir, 'a.wav'), '--voice', voice, '--assets', assetsDir], { encoding: 'utf8', timeout: 240000 });
    assert.equal(a.status, 0, a.stderr);
    const wa = parseWav(readFileSync(join(dir, 'a.wav')));
    assert.ok(pcmStats(wa.pcm).peak > 0.05);
    const b = spawnSync(process.execPath, [CLI, 'speak', '--voice', voice, '--assets', assetsDir], { input: 'Piped text works too.', timeout: 240000 });
    assert.equal(b.status, 0);
    assert.equal(b.stdout.toString('latin1', 0, 4), 'RIFF');
    assert.ok(pcmStats(parseWav(b.stdout).pcm).peak > 0.05);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await Promise.all(pending);
if (failed) process.exitCode = 1; else console.log('All headless tests passed.');
