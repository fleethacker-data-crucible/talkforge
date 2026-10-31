// tests/populate-gh.test.mjs - populate-assets fetches release assets with `gh release download`
// when gh is signed in, still verifies SHA-256, and fails closed on a mismatch. A fake gh (a small
// node script, injected with TALKFORGE_GH_BIN) stands in for the download step, so nothing here
// touches the network: the "release" and "upstream" servers are local and count their hits.
// Runs the shell script wherever bash, curl and python exist, and the PowerShell script on Windows.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = (p) => fileURLToPath(new URL(p, import.meta.url)).replace(/\\/g, '/');
const SH = root('../populate-assets.sh');
const PS1 = root('../populate-assets.ps1');
const have = (cmd, args) => { try { return spawnSync(cmd, args, { encoding: 'utf8' }).status === 0; } catch { return false; } };
const haveBash = have('bash', ['-c', 'command -v curl && (command -v python3 || command -v python)']);
const havePs = process.platform === 'win32' && have('powershell', ['-NoProfile', '-Command', 'exit 0']);
console.log('populate-gh tests');
if (!haveBash && !havePs) { console.log('  skip neither bash+curl+python nor Windows PowerShell available'); process.exit(0); }

const payload = Buffer.from('talkforge gh payload '.repeat(60));
const sha = createHash('sha256').update(payload).digest('hex');
const dir = mkdtempSync(join(tmpdir(), 'tf-gh-')).replace(/\\/g, '/');

// Fake gh. `auth status` exits FAKE_GH_AUTH; `release download` logs its arguments and writes the
// asset into --dir: payload (ok), different bytes (tamper), or exits 1 (fail).
const fake = `${dir}/fake-gh.mjs`;
writeFileSync(fake, `
import { appendFileSync, writeFileSync } from 'node:fs';
const a = process.argv.slice(2);
if (a[0] === 'auth' && a[1] === 'status') process.exit(Number(process.env.FAKE_GH_AUTH ?? 0));
if (a[0] === 'release' && a[1] === 'download') {
  appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(a) + '\\n');
  const get = (f) => a[a.indexOf(f) + 1];
  const mode = process.env.FAKE_GH_MODE || 'ok';
  if (mode === 'fail') { console.error('release not found'); process.exit(1); }
  writeFileSync(get('--dir') + '/' + get('--pattern'), mode === 'tamper' ? Buffer.from('tampered') : Buffer.from(process.env.FAKE_GH_PAYLOAD, 'base64'));
  process.exit(0);
}
process.exit(2);
`);

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
let releaseHits = 0, upstreamHits = 0;
const release = await listen((req, res) => { releaseHits++; res.writeHead(200).end(payload); });
const upstream = await listen((req, res) => { upstreamHits++; res.writeHead(200).end(payload); });
const manifest = `${dir}/manifest.json`;
writeFileSync(manifest, JSON.stringify({ assets: [{ dest: 'wasm/x.bin', url: `http://127.0.0.1:${upstream.port}/x.bin`, preferRelease: true, sha256: sha }] }));

let n = 0;
function run(kind, extra) {
  const root = `${dir}/out${++n}`;
  const log = `${dir}/gh${n}.log`;
  writeFileSync(log, '');
  const env = {
    ...process.env, MANIFEST: manifest, ASSET_ROOT: root, TALKFORGE_RELEASE_BASE: `http://127.0.0.1:${release.port}/releases/download/v1.3.0`,
    TALKFORGE_GH_BIN: `node ${fake}`, TALKFORGE_GH_REPO: 'acme/widgets', TALKFORGE_GH_TAG: 'v1.3.0',
    FAKE_GH_LOG: log, FAKE_GH_PAYLOAD: payload.toString('base64'), ...extra
  };
  delete env.TALKFORGE_ALLOW_UPSTREAM;
  const cmd = kind === 'sh' ? ['bash', [SH]] : ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1, '-AssetRoot', root, '-Manifest', manifest]];
  return new Promise((resolve) => {
    const p = spawn(cmd[0], cmd[1], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('close', (code) => resolve({ code, text: out + err, file: `${root}/wasm/x.bin`, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) }));
  });
}

let failed = false;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); }
  catch (e) { failed = true; console.error('  FAIL ' + name); console.error(e); }
}
const reset = () => { releaseHits = 0; upstreamHits = 0; };

for (const kind of [haveBash && 'sh', havePs && 'ps1'].filter(Boolean)) {
  await test(`[${kind}] gh signed in: asset comes from gh release download, hash verified, no HTTP used`, async () => {
    reset();
    const r = await run(kind, {});
    assert.equal(r.code, 0, r.text);
    assert.deepEqual(readFileSync(r.file), payload);
    assert.equal(r.calls.length, 1);
    assert.deepEqual(r.calls[0].slice(0, 2), ['release', 'download']);
    assert.ok(r.calls[0].includes('v1.3.0') && r.calls[0].includes('acme/widgets'));
    assert.equal(r.calls[0][r.calls[0].indexOf('--pattern') + 1], 'x.bin');
    assert.equal(releaseHits + upstreamHits, 0);
    assert.match(r.text, /gh release v1\.3\.0|gh release/);
  });

  await test(`[${kind}] gh returns different bytes: fail closed, nothing kept, no other source tried`, async () => {
    reset();
    const r = await run(kind, { FAKE_GH_MODE: 'tamper' });
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /SHA-256 MISMATCH from gh release/);
    assert.equal(existsSync(r.file), false);
    assert.equal(existsSync(r.file + '.part'), false);
    assert.equal(releaseHits + upstreamHits, 0, 'must not fall through to other sources');
  });

  await test(`[${kind}] gh not signed in (auto): falls back to the anonymous release URL, gh never downloads`, async () => {
    reset();
    const r = await run(kind, { FAKE_GH_AUTH: '1' });
    assert.equal(r.code, 0, r.text);
    assert.equal(r.calls.length, 0);
    assert.equal(releaseHits, 1);
    assert.deepEqual(readFileSync(r.file), payload);
  });

  await test(`[${kind}] gh download fails (auto): falls back to the anonymous release URL`, async () => {
    reset();
    const r = await run(kind, { FAKE_GH_MODE: 'fail' });
    assert.equal(r.code, 0, r.text);
    assert.equal(r.calls.length, 1);
    assert.equal(releaseHits, 1);
  });

  await test(`[${kind}] TALKFORGE_GH=off: gh is not used`, async () => {
    reset();
    const r = await run(kind, { TALKFORGE_GH: 'off' });
    assert.equal(r.code, 0, r.text);
    assert.equal(r.calls.length, 0);
    assert.equal(releaseHits, 1);
  });

  await test(`[${kind}] TALKFORGE_GH=on but not signed in: fails, downloads nothing`, async () => {
    reset();
    const r = await run(kind, { TALKFORGE_GH: 'on', FAKE_GH_AUTH: '1' });
    assert.equal(r.code, 1, r.text);
    assert.match(r.text, /gh is required/);
    assert.match(r.text, /gh auth login/);
    assert.equal(existsSync(r.file), false);
    assert.equal(releaseHits + upstreamHits, 0);
  });

  await test(`[${kind}] TALKFORGE_GH=on and gh download fails: no fallback`, async () => {
    reset();
    const r = await run(kind, { TALKFORGE_GH: 'on', FAKE_GH_MODE: 'fail' });
    assert.equal(r.code, 1, r.text);
    assert.equal(releaseHits + upstreamHits, 0);
    assert.equal(existsSync(r.file), false);
  });
}

release.server.close(); upstream.server.close();
release.server.closeAllConnections?.(); upstream.server.closeAllConnections?.();
rmSync(dir, { recursive: true, force: true });
if (failed) process.exitCode = 1; else console.log('All populate-gh tests passed.');
