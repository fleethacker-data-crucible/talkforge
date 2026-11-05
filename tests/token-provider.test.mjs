// tests/token-provider.test.mjs - where `talkforge serve` gets its token: env/file (default) or the
// Lazarette vault item. No live Lazarette: a fake PowerShell (a node script, TALKFORGE_POWERSHELL_BIN)
// and, on Windows, a real powershell.exe running against fake lib\Lazarette.ps1 / lib\Arc.ps1.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LAZARETTE_ITEM, LAZARETTE_SCRIPT, POWERSHELL_ENV, TokenError, lazaretteProvider, resolveToken
} from '../tools/token-provider.mjs';
import { parseArgs } from '../tools/talkforge.mjs';
import { DEFAULT_ASSETS_DIR, DEFAULT_VOICE, findMissingAssets } from '../tools/node-engine.mjs';

const CLI = fileURLToPath(new URL('../tools/talkforge.mjs', import.meta.url));
const SECRET = 'vault-secret-0123456789abcdef';
const dir = mkdtempSync(join(tmpdir(), 'tf-tok-')).replace(/\\/g, '/');
let failed = false;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); }
  catch (e) { failed = true; console.error('  FAIL ' + name); console.error(e); }
}

// Fake PowerShell: logs argv and the item it was asked for, then behaves per FAKE_PS_MODE.
const fake = `${dir}/fake-ps.mjs`;
const log = `${dir}/ps.log`;
writeFileSync(fake, `
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_PS_LOG, JSON.stringify({ argv: process.argv.slice(2), item: process.env.TF_VAULT_ITEM }) + '\\n');
const vault = JSON.parse(process.env.FAKE_VAULT || '{}');
const mode = process.env.FAKE_PS_MODE || 'ok';
if (mode === 'notfound') process.exit(3);
if (mode === 'locked') process.exit(4);
if (!(process.env.TF_VAULT_ITEM in vault)) process.exit(5);
process.stdout.write(vault[process.env.TF_VAULT_ITEM] + '\\r\\n');
`);
const fakeEnv = (extra = {}) => ({
  ...process.env, [POWERSHELL_ENV]: `node ${fake}`, FAKE_PS_LOG: log,
  FAKE_VAULT: JSON.stringify({ 'talkforge-api': SECRET, 'my-item': 'other-secret-0123456789' }), ...extra
});
const calls = () => { try { return readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const reset = () => writeFileSync(log, '');
reset();
delete process.env.TALKFORGE_TOKEN;
delete process.env[POWERSHELL_ENV];

console.log('token-provider tests');

await test('default: env, or the file when --token-file is given (long-standing behaviour)', async () => {
  assert.deepEqual(await resolveToken({ env: { TALKFORGE_TOKEN: 'abc' } }), { token: 'abc', source: 'env' });
  writeFileSync(`${dir}/tok.txt`, 'from-file-token\nsecond line\n');
  assert.deepEqual(await resolveToken({ tokenFile: `${dir}/tok.txt`, env: { TALKFORGE_TOKEN: 'ignored' } }), { token: 'from-file-token', source: 'file' });
  await assert.rejects(resolveToken({ env: {} }), /No token: set env TALKFORGE_TOKEN/);
  await assert.rejects(resolveToken({ tokenFile: `${dir}/nope.txt`, env: {} }), /Cannot read the token file/);
  await assert.rejects(resolveToken({ from: 'file', env: {} }), /needs --token-file/);
});

await test('providers are pluggable: a fake provider replaces or adds a source', async () => {
  const seen = [];
  const providers = { vaultish: async ({ options, env }) => { seen.push(options.item); return 'plugged-in-token'; } };
  assert.deepEqual(await resolveToken({ from: 'vaultish', item: 'x', providers, env: {} }), { token: 'plugged-in-token', source: 'vaultish' });
  assert.deepEqual(seen, ['x']);
  const r = await resolveToken({ from: 'lazarette', providers: { lazarette: async () => 'replaced' }, env: {} });
  assert.equal(r.token, 'replaced');
  await assert.rejects(resolveToken({ from: 'nope', env: {} }), /Unknown token provider/);
});

await test('lazarette: default item talkforge-api, returned trimmed', async () => {
  reset();
  const r = await resolveToken({ from: 'lazarette', env: fakeEnv() });
  assert.deepEqual(r, { token: SECRET, source: 'lazarette' });
  assert.equal(calls().length, 1);
  assert.equal(calls()[0].item, DEFAULT_LAZARETTE_ITEM);
  assert.equal(DEFAULT_LAZARETTE_ITEM, 'talkforge-api');
});

await test('lazarette: item from option or env TALKFORGE_LAZARETTE_ITEM; option wins', async () => {
  reset();
  assert.equal((await resolveToken({ from: 'lazarette', item: 'my-item', env: fakeEnv() })).token, 'other-secret-0123456789');
  assert.equal((await resolveToken({ from: 'lazarette', env: fakeEnv({ TALKFORGE_LAZARETTE_ITEM: 'my-item' }) })).token, 'other-secret-0123456789');
  assert.equal((await resolveToken({ from: 'lazarette', item: 'talkforge-api', env: fakeEnv({ TALKFORGE_LAZARETTE_ITEM: 'my-item' }) })).token, SECRET);
});

await test('lazarette: the item name and the secret never appear on the command line; the script reads the vault by contract', async () => {
  reset();
  await resolveToken({ from: 'lazarette', item: 'my-item', env: fakeEnv() });
  const { argv } = calls()[0];
  const flat = argv.join(' ');
  assert.ok(argv.includes('-EncodedCommand'));
  assert.ok(!flat.includes('my-item') && !flat.includes('other-secret') && !flat.includes(SECRET));
  const script = Buffer.from(argv[argv.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le');
  assert.equal(script, LAZARETTE_SCRIPT);
  assert.match(script, /Unlock-LazaretteVaultInteractive/);
  assert.match(script, /Get-LazaretteSecret -Service \$item/);
  assert.match(script, /LAZARETTE_PATH/);
  // The retired Arc contract is the fallback when no Lazarette 5 root is found.
  assert.match(script, /Unlock-ArcVaultInteractive/);
  assert.match(script, /Get-ArcSecret -Service \$item/);
  assert.match(script, /ARC_PATH/);
  // The Lazarette 5 contract is probed before the Arc fallback.
  assert.ok(script.indexOf("lib\\Lazarette.ps1") < script.indexOf("lib\\Arc.ps1"));
  assert.ok(!script.includes('my-item'));
});

await test('lazarette: invalid item names are refused before anything runs', async () => {
  reset();
  for (const bad of ['', 'a;b', '$(calc)', 'x'.repeat(80), '-lead']) {
    if (bad === '') continue; // empty falls back to the default
    await assert.rejects(resolveToken({ from: 'lazarette', item: bad, env: fakeEnv() }), /Invalid Lazarette item name/);
  }
  assert.equal(calls().length, 0);
});

await test('lazarette failures map to clear errors that name the alternatives', async () => {
  await assert.rejects(resolveToken({ from: 'lazarette', env: fakeEnv({ FAKE_PS_MODE: 'locked' }) }), (e) => e instanceof TokenError && /could not be unlocked/.test(e.message) && /TALKFORGE_TOKEN or --token-file/.test(e.message));
  await assert.rejects(resolveToken({ from: 'lazarette', env: fakeEnv({ FAKE_PS_MODE: 'notfound' }) }), /was not found \(set LAZARETTE_PATH/);
  await assert.rejects(resolveToken({ from: 'lazarette', item: 'absent', env: fakeEnv() }), /"absent" is missing or ambiguous/);
  await assert.rejects(resolveToken({ from: 'lazarette', env: fakeEnv({ FAKE_VAULT: JSON.stringify({ 'talkforge-api': '' }) }) }), /is empty/);
  await assert.rejects(lazaretteProvider({ env: { [POWERSHELL_ENV]: 'definitely-not-a-real-binary-xyz' } }), /Could not start PowerShell/);
});

await test('parseArgs: --token-from and --lazarette-item', () => {
  const o = parseArgs(['serve', '--token-from', 'LAZARETTE', '--lazarette-item', 'my-item']);
  assert.equal(o.tokenFrom, 'lazarette');
  assert.equal(o.lazaretteItem, 'my-item');
  assert.equal(parseArgs(['serve']).tokenFrom, undefined);
  assert.throws(() => parseArgs(['serve', '--token-from', 'keychain']), /env, file or lazarette/);
});

await test('CLI: serve --token-from lazarette reports a locked vault without leaking anything, exit 1', () => {
  const r = spawnSync(process.execPath, [CLI, 'serve', '--port', '0', '--token-from', 'lazarette', '--assets', `${dir}/none`], { encoding: 'utf8', env: fakeEnv({ FAKE_PS_MODE: 'locked' }), timeout: 30000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /could not be unlocked/);
  assert.ok(!(r.stdout + r.stderr).includes(SECRET));
});

await test('CLI: a too-short token from the vault is rejected without printing it', () => {
  const short = 'tooshort';
  const r = spawnSync(process.execPath, [CLI, 'serve', '--port', '0', '--token-from', 'lazarette', '--assets', `${dir}/none`], { encoding: 'utf8', env: fakeEnv({ FAKE_VAULT: JSON.stringify({ 'talkforge-api': short }) }), timeout: 30000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /at least 16/);
  assert.ok(!(r.stdout + r.stderr).includes(short));
});

await test('real powershell.exe against fake lib\\Lazarette.ps1 / lib\\Arc.ps1 (Windows only)', async () => {
  if (process.platform !== 'win32') { console.log('      (skipped: not Windows)'); return; }
  const base = { ...process.env, USERPROFILE: dir };
  delete base[POWERSHELL_ENV];
  delete base.LAZARETTE_PATH;
  delete base.ARC_PATH; delete base.ARC_ROOT; delete base.ARC_HOME;
  // Lazarette 5 contract on its own: a fake lib\Lazarette.ps1 answers.
  const laz = `${dir}/laz`;
  mkdirSync(`${laz}/lib`, { recursive: true });
  writeFileSync(`${laz}/lib/Lazarette.ps1`, [
    'function Unlock-LazaretteVaultInteractive { $true }',
    "function Get-LazaretteSecret { param([string]$Service) if ($Service -eq 'talkforge-api') { 'secret-from-fake-lazarette-0123456789' } else { throw \"no item $Service\" } }",
  ].join('\r\n'));
  const lazEnv = { ...base, LAZARETTE_PATH: laz.replace(/\//g, '\\') };
  assert.equal(await lazaretteProvider({ env: lazEnv }), 'secret-from-fake-lazarette-0123456789');
  await assert.rejects(lazaretteProvider({ options: { item: 'other' }, env: lazEnv }), /missing or ambiguous/);
  // Both contracts in one folder: the Lazarette 5 contract wins.
  writeFileSync(`${laz}/lib/Arc.ps1`, [
    'function Unlock-ArcVaultInteractive { $true }',
    "function Get-ArcSecret { param([string]$Service) if ($Service -eq 'talkforge-api') { 'secret-from-fake-arc-0123456789' } else { throw \"no item $Service\" } }",
  ].join('\r\n'));
  const bothEnv = { ...lazEnv, ARC_PATH: laz.replace(/\//g, '\\') };
  assert.equal(await lazaretteProvider({ env: bothEnv }), 'secret-from-fake-lazarette-0123456789');
  // Retired Arc contract on its own still works.
  const arc = `${dir}/arc`;
  mkdirSync(`${arc}/lib`, { recursive: true });
  writeFileSync(`${arc}/lib/Arc.ps1`, [
    'function Unlock-ArcVaultInteractive { $true }',
    "function Get-ArcSecret { param([string]$Service) if ($Service -eq 'talkforge-api') { 'secret-from-fake-arc-0123456789' } else { throw \"no item $Service\" } }",
  ].join('\r\n'));
  const env = { ...base, ARC_PATH: arc.replace(/\//g, '\\') };
  assert.equal(await lazaretteProvider({ env }), 'secret-from-fake-arc-0123456789');
  await assert.rejects(lazaretteProvider({ options: { item: 'other' }, env }), /missing or ambiguous/);
  writeFileSync(`${arc}/lib/Arc.ps1`, 'function Unlock-ArcVaultInteractive { $false }\r\nfunction Get-ArcSecret { "x" }');
  await assert.rejects(lazaretteProvider({ env }), /could not be unlocked/);
  assert.equal(spawnSync('powershell.exe', ['-NoProfile', '-Command', 'exit 0']).status, 0);
  await assert.rejects(lazaretteProvider({ env: { ...env, LAZARETTE_PATH: `${dir}/missing`, ARC_PATH: `${dir}/missing`, ARC_ROOT: '', ARC_HOME: '', USERPROFILE: dir } }), /was not found/);
});

const assetsDir = process.env.TALKFORGE_ASSETS || DEFAULT_ASSETS_DIR;
const voice = process.env.TALKFORGE_TEST_VOICE || DEFAULT_VOICE;
await test('end to end: serve with the Lazarette token accepts exactly that token (needs local assets)', async () => {
  const missing = await findMissingAssets(assetsDir, voice);
  if (missing.length) {
    if (process.env.TALKFORGE_REQUIRE_ASSETS) assert.fail(`assets required but missing: ${missing.join(', ')}`);
    console.log(`      (skipped: ${missing.length} asset file(s) missing; run populate-assets)`);
    return;
  }
  const p = spawn(process.execPath, [CLI, 'serve', '--port', '0', '--token-from', 'lazarette', '--idle-timeout', '0.5', '--voice', voice, '--assets', assetsDir],
    { env: fakeEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((r) => p.on('close', r));
  const call = (port, token) => new Promise((res, rej) => {
    const body = JSON.stringify({ input: 'Hello.' });
    const req = http.request({ agent: false, host: '127.0.0.1', port, method: 'POST', path: '/v1/audio/speech', headers: { authorization: `Bearer ${token}`, 'content-length': Buffer.byteLength(body) } }, (r) => { r.resume(); r.on('end', () => res(r.statusCode)); });
    req.on('error', rej); req.end(body);
  });
  try {
    let port; const t0 = Date.now();
    while (!port && Date.now() - t0 < 60000) { const m = /127\.0\.0\.1:(\d+)\//.exec(out); if (m) port = Number(m[1]); else await new Promise((r) => setTimeout(r, 100)); }
    assert.ok(port, 'announced a port');
    assert.equal(await call(port, 'not-the-vault-token-0123456789'), 401);
    assert.equal(await call(port, SECRET), 200);
    assert.match(err, /API token read from lazarette/);
    assert.ok(!(out + err).includes(SECRET), 'token must not be printed');
  } finally { p.kill(); await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]); }
});

rmSync(dir, { recursive: true, force: true });
if (failed) process.exitCode = 1; else console.log('All token-provider tests passed.');
