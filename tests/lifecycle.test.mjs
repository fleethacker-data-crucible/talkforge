// tests/lifecycle.test.mjs - VERSION, the heartbeat/id probes, token-checked shutdown, idle timeout.
// Server tests use a fake synthesizer (no assets); the process-level case needs local assets and
// skips without them (TALKFORGE_REQUIRE_ASSETS=1 makes absence a failure).
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../tools/talkforge-server.mjs';
import { parseArgs, readVersion } from '../tools/talkforge.mjs';
import { DEFAULT_ASSETS_DIR, DEFAULT_VOICE, findMissingAssets } from '../tools/node-engine.mjs';

const CLI = fileURLToPath(new URL('../tools/talkforge.mjs', import.meta.url));
const TOKEN = 'test-token-0123456789abcdef';
const auth = { authorization: `Bearer ${TOKEN}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try { await fn(); console.log('  ok  ' + name); }
    catch (e) { failed = true; console.error('  FAIL ' + name); console.error(e); }
  })());
}

function request(port, { method = 'GET', path, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ agent: false, host: '127.0.0.1', port, method, path, headers: { ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const fakeSynth = () => ({
  assetsDir: join(tmpdir(), 'tf-no-such-assets'), defaultVoice: 'en_US-libritts_r-medium',
  render: async (req) => ({ bytes: Buffer.from('RIFF....WAVEfake'), mime: 'audio/wav', seconds: 1, voice: req.voice })
});
const speak = (port) => request(port, { method: 'POST', path: '/v1/audio/speech', headers: auth, body: { input: 'hi' } });

console.log('lifecycle tests');

test('VERSION is semver, equals PAGE_VERSION in the page, and is what the CLI reports', () => {
  const v = readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim();
  assert.match(v, /^\d+\.\d+\.\d+$/);
  const page = readFileSync(new URL('../TalkForge-tts.html', import.meta.url), 'utf8');
  assert.equal(/PAGE_VERSION\s*=\s*'([0-9.]+)'/.exec(page)[1], v);
  assert.equal(readVersion(), v);
});

test('/__fleethacker/id needs no token and reports tool, version, pid, path', async () => {
  const s = await startServer({ synth: fakeSynth(), token: TOKEN, port: 0, version: '9.8.7', scriptPath: '/x/talkforge.mjs' });
  try {
    const r = await request(s.port, { path: '/__fleethacker/id' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json(), { tool: 'talkforge', version: '9.8.7', pid: process.pid, path: '/x/talkforge.mjs' });
    // the loopback Host rule still applies to the probes
    assert.equal((await request(s.port, { path: '/__fleethacker/id', headers: { host: 'evil.example.com' } })).status, 403);
    // everything else still needs the token
    assert.equal((await request(s.port, { path: '/v1/audio/speech', method: 'POST', body: { input: 'x' } })).status, 401);
  } finally { await s.close(); }
});

test('heartbeat reports uptime and counts only speech requests', async () => {
  const s = await startServer({ synth: fakeSynth(), token: TOKEN, port: 0, version: '1.2.3', idleTimeoutMs: 60000 });
  try {
    let h = (await request(s.port, { path: '/__fleethacker/heartbeat' })).json();
    assert.equal(h.ok, true);
    assert.equal(h.version, '1.2.3');
    assert.equal(h.requests, 0);
    assert.equal(h.lastRequestAt, null);
    assert.equal(h.idleTimeoutSeconds, 60);
    assert.ok(h.uptimeSeconds >= 0);
    assert.equal((await speak(s.port)).status, 200);
    await request(s.port, { path: '/__fleethacker/heartbeat' });
    h = (await request(s.port, { path: '/__fleethacker/heartbeat' })).json();
    assert.equal(h.requests, 1);
    assert.ok(Number.isFinite(Date.parse(h.lastRequestAt)));
  } finally { await s.close(); }
});

test('shutdown needs the token and the X-FleetHacker-Shutdown header, then stops', async () => {
  const stops = [];
  const s = await startServer({ synth: fakeSynth(), token: TOKEN, port: 0, onStop: (r) => stops.push(r) });
  try {
    const p = '/__fleethacker/shutdown';
    assert.equal((await request(s.port, { method: 'POST', path: p, headers: { 'x-fleethacker-shutdown': '1' } })).status, 401);
    assert.equal((await request(s.port, { method: 'POST', path: p, headers: auth })).status, 400);
    assert.equal((await request(s.port, { method: 'GET', path: p, headers: { ...auth, 'x-fleethacker-shutdown': '1' } })).status, 400);
    await sleep(30);
    assert.deepEqual(stops, []);
    const r = await request(s.port, { method: 'POST', path: p, headers: { ...auth, 'x-fleethacker-shutdown': '1' } });
    assert.equal(r.status, 202);
    assert.deepEqual(r.json(), { stopping: true });
    await sleep(30);
    assert.deepEqual(stops, ['shutdown']);
  } finally { await s.close(); }
});

test('idle timeout stops the server; heartbeat polls do not keep it alive, speech requests do', async () => {
  const stops = [];
  const s = await startServer({ synth: fakeSynth(), token: TOKEN, port: 0, idleTimeoutMs: 400, onStop: (r) => stops.push(r) });
  try {
    for (let i = 0; i < 3; i++) { await sleep(100); await request(s.port, { path: '/__fleethacker/heartbeat' }); }
    await speak(s.port); // resets the timer at ~t=300 -> would stop at ~t=700
    await sleep(250); // ~t=550: past the original deadline, still running
    assert.deepEqual(stops, []);
    await sleep(500); // ~t=1050
    assert.deepEqual(stops, ['idle']);
  } finally { await s.close(); }
});

test('idle timeout 0 never stops', async () => {
  const stops = [];
  const s = await startServer({ synth: fakeSynth(), token: TOKEN, port: 0, idleTimeoutMs: 0, onStop: (r) => stops.push(r) });
  try { await sleep(150); assert.deepEqual(stops, []); } finally { await s.close(); }
});

test('parseArgs: --idle-timeout', () => {
  assert.equal(parseArgs(['serve', '--idle-timeout', '2.5']).idleTimeout, 2.5);
  assert.equal(parseArgs(['serve']).idleTimeout, 0);
  assert.throws(() => parseArgs(['serve', '--idle-timeout', '-1']), /0 or more/);
  assert.throws(() => parseArgs(['serve', '--idle-timeout', 'soon']), /number/);
});

const assetsDir = process.env.TALKFORGE_ASSETS || DEFAULT_ASSETS_DIR;
const voice = process.env.TALKFORGE_TEST_VOICE || DEFAULT_VOICE;
test('process: `talkforge serve --idle-timeout` exits 0 on its own and answers the id probe (needs local assets)', async () => {
  const missing = await findMissingAssets(assetsDir, voice);
  if (missing.length) {
    if (process.env.TALKFORGE_REQUIRE_ASSETS) assert.fail(`assets required but missing: ${missing.join(', ')}`);
    console.log(`      (skipped: ${missing.length} asset file(s) missing; run populate-assets)`);
    return;
  }
  const p = spawn(process.execPath, [CLI, 'serve', '--port', '0', '--idle-timeout', '0.1', '--voice', voice, '--assets', assetsDir],
    { env: { ...process.env, TALKFORGE_TOKEN: TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => p.on('close', (code) => resolve(code)));
  try {
    const t0 = Date.now();
    let port;
    while (!port && Date.now() - t0 < 60000) {
      const m = /127\.0\.0\.1:(\d+)\//.exec(out);
      if (m) port = Number(m[1]); else await sleep(100);
    }
    assert.ok(port, 'server announced its port');
    const id = (await request(port, { path: '/__fleethacker/id' })).json();
    assert.equal(id.tool, 'talkforge');
    assert.equal(id.version, readVersion());
    const code = await Promise.race([exited, sleep(30000).then(() => 'timeout')]);
    assert.equal(code, 0, 'exited by itself after the idle timeout');
  } finally { p.kill(); }
});

await Promise.all(pending);
if (failed) process.exitCode = 1; else console.log('All lifecycle tests passed.');
