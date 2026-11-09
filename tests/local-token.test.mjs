// The local token (tools/local-token.mjs): made once, private to this account, accepted by the server
// alongside the token it was started with, and switchable off. Uses a temporary file, never the real one.
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureLocalToken, localTokenEnabled, localTokenPath, readLocalToken } from '../tools/local-token.mjs';
import { startServer } from '../tools/talkforge-server.mjs';

let failed = false;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); }
  catch (e) { failed = true; console.log('  FAIL ' + name + '\n       ' + (e && e.stack || e)); }
}

const dir = mkdtempSync(join(tmpdir(), 'tf-local-'));
const env = { ...process.env, TALKFORGE_LOCAL_TOKEN_FILE: join(dir, 'sub', 'local-token') };

function post(port, token) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ input: 'hi' });
    const req = http.request({ host: '127.0.0.1', port, path: '/v1/audio/speech', method: 'POST',
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...(token ? { authorization: `Bearer ${token}` } : {}) } },
    (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(body);
  });
}

// A synthesizer that never runs: an accepted request fails later (500/400), a refused one is 401.
const synth = { load: async () => {}, synthesize: async () => { throw new Error('not in this test'); }, voices: () => [] };

await test('makes a token once and returns the same one after', () => {
  assert.equal(readLocalToken(env), null);
  const a = ensureLocalToken({ env });
  assert.ok(a.length >= 40, 'random 32 bytes, base64url');
  assert.equal(ensureLocalToken({ env }), a);
  assert.equal(readFileSync(localTokenPath(env), 'utf8').trim(), a);
});

await test('on Windows only this account and SYSTEM may read it', () => {
  if (process.platform !== 'win32') return;
  const acl = execFileSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), [localTokenPath(env)], { encoding: 'utf8', windowsHide: true });
  assert.doesNotMatch(acl, /\(I\)/, 'no inherited entries');
  assert.doesNotMatch(acl, /Everyone|Users:|Authenticated Users/i);
  assert.match(acl, /SYSTEM/);
});

await test('the server accepts the local token and the started token, and refuses others', async () => {
  const local = ensureLocalToken({ env });
  const started = 'started-token-0123456789abcdef';
  const s = await startServer({ synth, token: started, tokens: [local], port: 0 });
  try {
    assert.notEqual(await post(s.port, local), 401);
    assert.notEqual(await post(s.port, started), 401);
    assert.equal(await post(s.port, 'wrong-token-0123456789abcdef'), 401);
    assert.equal(await post(s.port, ''), 401);
  } finally { await s.close(); }
});

await test('the local token alone is enough to start a server', async () => {
  const s = await startServer({ synth, tokens: [ensureLocalToken({ env })], port: 0 });
  try { assert.notEqual(await post(s.port, readLocalToken(env)), 401); } finally { await s.close(); }
});

await test('no token at all still refuses to start', () => {
  assert.throws(() => startServer({ synth, port: 0 }), /token of at least/);
});

await test('TALKFORGE_LOCAL_TOKEN=off turns it off', () => {
  assert.equal(localTokenEnabled({ TALKFORGE_LOCAL_TOKEN: 'off' }), false);
  assert.equal(localTokenEnabled({}), true);
});

rmSync(dir, { recursive: true, force: true });
if (failed) process.exit(1);
