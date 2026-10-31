// tests/populate.test.mjs - populate-assets.sh must not touch the upstream (CDN / Hugging Face) url
// unless TALKFORGE_ALLOW_UPSTREAM=1, and must still hash-verify when it does.
// Uses two local HTTP servers (a "release" that 404s and an "upstream" that counts hits).
// Skips when bash, curl or python are not available.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../populate-assets.sh', import.meta.url)).replace(/\\/g, '/');
const have = (cmd, args) => { try { return spawnSync(cmd, args, { encoding: 'utf8' }).status === 0; } catch { return false; } };
console.log('populate tests');
if (!have('bash', ['-c', 'command -v curl && (command -v python3 || command -v python)'])) {
  console.log('  skip bash, curl or python not available');
  process.exit(0);
}

const payload = Buffer.from('talkforge test payload '.repeat(50));
const sha = createHash('sha256').update(payload).digest('hex');

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
function run(env) {
  return new Promise((resolve) => {
    const p = spawn('bash', [SCRIPT], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

let failed = false;
const dir = mkdtempSync(join(tmpdir(), 'tf-pop-')).replace(/\\/g, '/');
let upstreamHits = 0, releaseHits = 0, serveBad = false;
const release = await listen((req, res) => { releaseHits++; res.writeHead(404).end(); });
const upstream = await listen((req, res) => { upstreamHits++; res.writeHead(200).end(serveBad ? Buffer.from('tampered') : payload); });
const manifest = join(dir, 'manifest.json');
writeFileSync(manifest, JSON.stringify({ assets: [{ dest: 'wasm/x.bin', url: `http://127.0.0.1:${upstream.port}/x.bin`, preferRelease: true, sha256: sha }] }));
const baseEnv = (root) => ({ MANIFEST: manifest, ASSET_ROOT: `${dir}/${root}`, TALKFORGE_RELEASE_BASE: `http://127.0.0.1:${release.port}/releases/download/v1.3.0` });
delete process.env.TALKFORGE_ALLOW_UPSTREAM;

async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); }
  catch (e) { failed = true; console.error('  FAIL ' + name); console.error(e); }
}

await test('default: release 404 fails, upstream is never contacted, message says how to opt in', async () => {
  upstreamHits = 0;
  const r = await run(baseEnv('a'));
  assert.equal(r.code, 1, r.out + r.err);
  assert.equal(upstreamHits, 0, 'upstream must not be contacted');
  assert.ok(releaseHits > 0);
  assert.match(r.err, /upstream download is off/);
  assert.match(r.err, /TALKFORGE_ALLOW_UPSTREAM=1/);
  assert.equal(existsSync(`${dir}/a/wasm/x.bin`), false);
});

await test('TALKFORGE_ALLOW_UPSTREAM=1: falls back to upstream and verifies the hash', async () => {
  upstreamHits = 0;
  const r = await run({ ...baseEnv('b'), TALKFORGE_ALLOW_UPSTREAM: '1' });
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(upstreamHits >= 1);
  assert.deepEqual(readFileSync(`${dir}/b/wasm/x.bin`), payload);
});

await test('TALKFORGE_ALLOW_UPSTREAM=1 with tampered upstream bytes: mismatch, nothing kept', async () => {
  serveBad = true;
  const r = await run({ ...baseEnv('c'), TALKFORGE_ALLOW_UPSTREAM: '1' });
  serveBad = false;
  assert.equal(r.code, 1);
  assert.match(r.err, /SHA-256 MISMATCH/);
  assert.equal(existsSync(`${dir}/c/wasm/x.bin`), false);
  assert.equal(existsSync(`${dir}/c/wasm/x.bin.part`), false);
});

release.server.close(); upstream.server.close();
release.server.closeAllConnections?.(); upstream.server.closeAllConnections?.();
rmSync(dir, { recursive: true, force: true });
if (failed) process.exitCode = 1; else console.log('All populate tests passed.');
