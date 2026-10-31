// tests/synth-cli.test.mjs - voiceover CLI: pure helpers, argument parsing, missing-assets error,
// and (only when the local assets are present) a real end-to-end run.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScript, speedToLengthScale, wavFromPcm, parseWav, joinPcm, pcmStats, buildTiming } from '../tools/synth-lib.mjs';
import { parseArgs } from '../tools/synth-cli.mjs';
import { DEFAULT_ASSETS_DIR, DEFAULT_VOICE, findMissingAssets } from '../tools/node-engine.mjs';

const CLI = fileURLToPath(new URL('../tools/synth-cli.mjs', import.meta.url));
let failed = false;
const pending = [];
function test(name, fn) {
  pending.push((async () => {
    try { await fn(); console.log('  ok  ' + name); }
    catch (e) { failed = true; console.error('  FAIL ' + name); console.error(e); }
  })());
}

console.log('synth-cli tests');

test('speed maps to lengthScale (1/speed) and rejects bad values', () => {
  assert.equal(speedToLengthScale(1), 1);
  assert.equal(speedToLengthScale(2), 0.5);
  assert.throws(() => speedToLengthScale(0), /Invalid speed/);
  assert.throws(() => speedToLengthScale(10), /out of range/);
});

test('plain text: one scene per blank-line paragraph, numbered ids', () => {
  const scenes = parseScript('First scene.\nstill first.\r\n\r\nSecond scene.\n\n\n  \nThird.\n');
  assert.deepEqual(scenes.map((s) => s.id), ['scene-01', 'scene-02', 'scene-03']);
  assert.equal(scenes[0].text, 'First scene.\nstill first.');
  assert.equal(scenes[0].speed, 1);
  assert.equal(scenes[0].speaker, 0);
});

test('JSON object: defaults, per-scene overrides, tts alias, pronunciations', () => {
  const src = JSON.stringify({
    voice: 'en_GB-alan-medium', speed: 1.1, sceneGap: 0.4, pronunciations: { PacketRat: 'packet rat' },
    scenes: [
      { id: 'intro', text: 'PacketRat is here.' },
      { id: 'two', tts: 'Fast one.', speed: 2, voice: 'en_US-amy-medium', pauseAfter: 1 },
      'Bare string scene.'
    ]
  });
  const s = parseScript(src, { isJson: true, defaults: { voice: 'ignored' } });
  assert.equal(s[0].text, 'packet rat is here.');
  assert.equal(s[0].voice, 'en_GB-alan-medium');
  assert.equal(s[0].speed, 1.1);
  assert.equal(s[0].pauseAfter, 0.4);
  assert.equal(s[1].text, 'Fast one.');
  assert.equal(s[1].voice, 'en_US-amy-medium');
  assert.equal(s[1].speed, 2);
  assert.equal(s[1].pauseAfter, 1);
  assert.equal(s[2].id, 'scene-03');
});

test('JSON array of scenes works and defaults apply', () => {
  const s = parseScript('[{"id":"a","text":"Hi."}]', { isJson: true, defaults: { voice: 'v1', speed: 1.2 } });
  assert.equal(s[0].voice, 'v1');
  assert.equal(s[0].speed, 1.2);
});

test('script validation errors are clear', () => {
  assert.throws(() => parseScript('', {}), /no scenes/);
  assert.throws(() => parseScript('{oops', { isJson: true }), /not valid JSON/);
  assert.throws(() => parseScript('{"a":1}', { isJson: true }), /"scenes" array/);
  assert.throws(() => parseScript('[{"id":"a"}]', { isJson: true }), /has no text/);
  assert.throws(() => parseScript('[{"id":"a b","text":"x"}]', { isJson: true }), /file name/);
  assert.throws(() => parseScript('[{"id":"../x","text":"x"}]', { isJson: true }), /file name/);
  assert.throws(() => parseScript('[{"id":"a","text":"x"},{"id":"A","text":"y"}]', { isJson: true }), /Duplicate/);
  assert.throws(() => parseScript('[{"text":"x","speed":0}]', { isJson: true }), /Invalid speed/);
  assert.throws(() => parseScript('[{"text":"x","speaker":-1}]', { isJson: true }), /speaker/);
});

test('wavFromPcm writes one valid header; parseWav round-trips', () => {
  const pcm = Buffer.alloc(200, 1);
  const wav = wavFromPcm(pcm, 22050);
  assert.equal(wav.length, 244);
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF');
  assert.equal(wav.readUInt32LE(4), 236);
  assert.equal(wav.readUInt32LE(40), 200);
  const back = parseWav(wav);
  assert.equal(back.sampleRate, 22050);
  assert.equal(back.pcm.length, 200);
  assert.throws(() => parseWav(Buffer.alloc(10)), /RIFF/);
});

test('joinPcm adds silence only between parts; pcmStats sees silence', () => {
  const a = Buffer.alloc(4, 1), b = Buffer.alloc(6, 1);
  assert.equal(joinPcm([a, b], 1000, 0.01).length, 4 + 20 + 6);
  assert.equal(joinPcm([a], 1000, 0.5).length, 4);
  assert.equal(pcmStats(Buffer.alloc(100)).peak, 0);
  const loud = Buffer.alloc(4); loud.writeInt16LE(16384, 0); loud.writeInt16LE(-16384, 2);
  const st = pcmStats(loud);
  assert.equal(st.peak, 0.5);
  assert.equal(st.rms, 0.5);
});

test('buildTiming lays scenes end to end, honouring pauseAfter', () => {
  const t = buildTiming([
    { id: 'a', file: 'a.wav', seconds: 2.5, pauseAfter: 0.5, voice: 'v', speed: 1, speaker: 0, text: 'x' },
    { id: 'b', file: 'b.wav', seconds: 1.25, pauseAfter: 0, voice: 'v', speed: 1, speaker: 0, text: 'y' }
  ], { format: 'wav' });
  assert.deepEqual(t.scenes.map((s) => [s.id, s.start, s.duration]), [['a', 0, 2.5], ['b', 3, 1.25]]);
  assert.equal(t.totalSeconds, 4.25);
  assert.equal(t.format, 'wav');
});

test('parseArgs: defaults, options, and usage errors', () => {
  const o = parseArgs(['s.json', '--out', 'o', '--voice', 'v', '--speed', '1.1', '--format', 'MP3', '--scene-gap', '0.5']);
  assert.equal(o.script, 's.json');
  assert.equal(o.out, 'o');
  assert.equal(o.voice, 'v');
  assert.equal(o.speed, 1.1);
  assert.equal(o.format, 'mp3');
  assert.equal(o.sceneGap, 0.5);
  assert.equal(parseArgs(['s.txt']).format, 'wav');
  assert.equal(parseArgs(['--help']).help, true);
  assert.throws(() => parseArgs([]), /Missing <script>/);
  assert.throws(() => parseArgs(['a', 'b']), /Only one script/);
  assert.throws(() => parseArgs(['a', '--nope']), /Unknown option/);
  assert.throws(() => parseArgs(['a', '--speed']), /needs a value/);
  assert.throws(() => parseArgs(['a', '--speed', 'fast']), /must be a number/);
  assert.throws(() => parseArgs(['a', '--format', 'ogg']), /wav or mp3/);
});

test('CLI: missing assets exits 2 and names the missing files (nothing downloaded)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tf-synth-'));
  try {
    const script = join(dir, 's.txt');
    writeFileSync(script, 'Hello there.\n');
    const r = spawnSync(process.execPath, [CLI, script, '--out', join(dir, 'out'), '--assets', join(dir, 'no-assets')], { encoding: 'utf8' });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /assets are missing/);
    assert.match(r.stderr, new RegExp(DEFAULT_VOICE + '\\.onnx'));
    assert.match(r.stderr, /piper_phonemize\.data/);
    assert.match(r.stderr, /populate-assets/);
    assert.equal(existsSync(join(dir, 'out', 'timing.json')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI: bad usage exits 64, bad script exits 1', () => {
  assert.equal(spawnSync(process.execPath, [CLI], { encoding: 'utf8' }).status, 64);
  const dir = mkdtempSync(join(tmpdir(), 'tf-synth-'));
  try {
    const script = join(dir, 'bad.json');
    writeFileSync(script, '{"scenes":[{"id":"a"}]}');
    const r = spawnSync(process.execPath, [CLI, script, '--out', join(dir, 'out')], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /has no text/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Real synthesis. Runs only if the local assets exist (or TALKFORGE_ASSETS points at them),
// so a fresh clone still gets a green run; set TALKFORGE_REQUIRE_ASSETS=1 to make absence a failure.
const assetsDir = process.env.TALKFORGE_ASSETS || DEFAULT_ASSETS_DIR;
const voice = process.env.TALKFORGE_TEST_VOICE || DEFAULT_VOICE;
test('CLI end to end: scenes -> valid, non-silent WAVs + timing.json (needs local assets)', async () => {
  const missing = await findMissingAssets(assetsDir, voice);
  if (missing.length) {
    if (process.env.TALKFORGE_REQUIRE_ASSETS) assert.fail(`assets required but missing: ${missing.join(', ')}`);
    console.log(`      (skipped: ${missing.length} asset file(s) missing; run populate-assets)`);
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), 'tf-synth-'));
  try {
    const script = join(dir, 's.json');
    writeFileSync(script, JSON.stringify({ voice, scenes: [
      { id: 'one', text: 'Hello from TalkForge.' },
      { id: 'two', text: 'This is a second scene.', speed: 1.25 }
    ] }));
    const r = spawnSync(process.execPath, [CLI, script, '--out', join(dir, 'out'), '--assets', assetsDir], { encoding: 'utf8', timeout: 240000 });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const timing = JSON.parse(readFileSync(join(dir, 'out', 'timing.json'), 'utf8'));
    assert.equal(timing.scenes.length, 2);
    assert.equal(timing.scenes[0].start, 0);
    assert.ok(Math.abs(timing.scenes[1].start - timing.scenes[0].duration) < 0.002);
    for (const sc of timing.scenes) {
      const wav = readFileSync(join(dir, 'out', sc.file));
      const { sampleRate, pcm } = parseWav(wav);
      assert.equal(wav.readUInt32LE(4), wav.length - 8);
      assert.ok(Math.abs(pcm.length / 2 / sampleRate - sc.duration) < 0.002, 'duration matches file');
      assert.ok(sc.duration > 0.5 && sc.duration < 10, 'plausible duration ' + sc.duration);
      assert.ok(pcmStats(pcm).peak > 0.05, 'audio is not silent');
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

await Promise.all(pending);
if (failed) process.exitCode = 1; else console.log('All synth-cli tests passed.');
