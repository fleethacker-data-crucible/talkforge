// tests/commands.test.mjs - command registry (`commands` / `help`) and noun-verb dry-run.
// Speech itself is covered by headless.test.mjs; this file does not load the engine.
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../tools/talkforge.mjs';
import { actionManifest, commandsEnvelope } from '../tools/commands.mjs';
import { startServer } from '../tools/talkforge-server.mjs';

const CLI = fileURLToPath(new URL('../tools/talkforge.mjs', import.meta.url));
const TOKEN = 'test-token-0123456789abcdef';
const run = (args, opts = {}) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 30000, ...opts });
let failed = false;
async function test(name, fn) {
  try { await fn(); console.log('  ok  ' + name); }
  catch (e) { failed = true; console.error('  FAIL ' + name); console.error(e); }
}

function request(port, { method = 'GET', path = '/api/v1/actions', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ agent: false, host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

console.log('command registry tests');

const IDS = ['talkforge.speech.speak', 'talkforge.speech.serve', 'talkforge.voice.list', 'talkforge.asset.status', 'talkforge.version.show'];

await test('manifest matches the FleetAction action-manifest shape', () => {
  const m = actionManifest();
  assert.equal(m.version, 1);
  assert.equal(m.app, 'talkforge');
  assert.deepEqual(m.actions.map((a) => a.id), IDS);
  for (const a of m.actions) {
    assert.equal(a.app, 'talkforge');
    assert.equal(`${a.app}.${a.noun}.${a.verb}`, a.id);
    assert.equal(a.destructive, false);
    assert.ok(Array.isArray(a.parameters));
    for (const p of a.parameters) {
      assert.match(p.name, /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
      assert.ok(['string', 'number', 'boolean'].includes(p.type));
      assert.equal(typeof p.required, 'boolean');
    }
  }
  const speak = m.actions[0];
  assert.deepEqual(speak.parameters.filter((p) => p.required).map((p) => p.name), ['text', 'file']);
});

await test('commands and help print the same list; --json is one result envelope', () => {
  const text = run(['commands']);
  const help = run(['help']);
  assert.equal(text.status, 0);
  assert.equal(help.stdout, text.stdout);
  assert.match(text.stdout, /talkforge speech speak --text --file/);
  assert.equal(text.stderr, '');
  const j = run(['commands', '--json']);
  const h = run(['help', '--json']);
  assert.equal(j.status, 0);
  assert.equal(h.stdout, j.stdout);
  const doc = JSON.parse(j.stdout);
  assert.deepEqual(doc, commandsEnvelope());
  assert.equal(j.stdout.trim().split('\n').length, 1);
  assert.equal(run(['commands', 'extra']).status, 64);
  assert.equal(run(['speech']).status, 64);
  assert.match(run(['speech', 'nope']).stderr, /Unknown command: speech nope/);
});

await test('commands --out writes UTF-8 JSON with no byte-order mark, same bytes as stdout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-cmd-'));
  try {
    const file = join(dir, 'commands.json');
    const r = run(['commands', '--json', '--out', file]);
    assert.equal(r.status, 0, r.stderr);
    const bytes = readFileSync(file);
    assert.ok(bytes[0] !== 0xEF && bytes[1] !== 0xBB);
    assert.equal(bytes.toString('utf8'), r.stdout);
    assert.equal(JSON.parse(bytes.toString('utf8')).ok, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await test('speech speak --dry-run checks args and does not write the audio file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-dry-'));
  try {
    const file = join(dir, 'out.wav');
    const r = run(['speech', 'speak', '--text', 'Hello.', '--file', file, '--speed', '1.1', '--dry-run', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(file), false);
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.v, 1);
    assert.equal(doc.ok, true);
    assert.equal(doc.result.dryRun, true);
    assert.equal(doc.result.actionId, 'talkforge.speech.speak');
    assert.equal(doc.result.destructive, false);
    assert.equal(doc.result.confirmationRequired, false);
    assert.deepEqual(doc.result.args, { text: 'Hello.', file, speed: 1.1 });
    assert.equal(run(['speech', 'speak', '--text', 'Hello.', '--dry-run']).status, 64);
    assert.equal(run(['speech', 'speak', '--text', 'Hello.', '--file', file, '--file', 'b.wav']).status, 64);
    assert.equal(run(['speech', 'speak', '--text', 'Hello.', '--file', file, '--speed', '9']).status, 64);
    assert.equal(run(['version', 'show', '--json']).status, 0);
    const ver = JSON.parse(run(['version', 'show', '--json']).stdout);
    assert.equal(ver.result.version, run(['version']).stdout.trim());
    assert.equal(parseArgs(['version', '--json']).cmd, 'version');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await test('GET /api/v1/actions returns the registry and keeps the speech auth rules', async () => {
  const s = await startServer({
    synth: { assetsDir: join(tmpdir(), 'tf-no-assets'), defaultVoice: 'en_US-libritts-high', render: async () => { throw new Error('no'); } },
    token: TOKEN,
    port: 0
  });
  try {
    const ok = await request(s.port, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(ok.status, 200);
    assert.match(ok.headers['content-type'], /application\/json/);
    assert.deepEqual(JSON.parse(ok.body), commandsEnvelope());
    assert.equal((await request(s.port, {})).status, 401);
    assert.equal((await request(s.port, { headers: { authorization: `Bearer ${TOKEN}`, origin: 'http://127.0.0.1' } })).status, 403);
    assert.equal((await request(s.port, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })).status, 405);
    assert.equal((await request(s.port, { path: '/api/v1/actions?x=1', headers: { authorization: `Bearer ${TOKEN}` } })).status, 400);
    const speech = await request(s.port, { method: 'POST', path: '/v1/audio/speech', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' } });
    assert.equal(speech.status, 400);
  } finally { await s.close(); }
});

if (failed) process.exitCode = 1; else console.log('All command registry tests passed.');
