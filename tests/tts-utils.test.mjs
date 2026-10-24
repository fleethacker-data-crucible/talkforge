// tests/tts-utils.test.mjs — pure-function tests (Node, no browser)
import { splitSentences, pcmToWavArrayBuffer, filterSpeakers, parseModelsJson } from '../assets/vendor/tts-utils.js';
import assert from 'node:assert/strict';

function test(name, fn) {
  try {
    fn();
    console.log('  ok  ' + name);
  } catch (e) {
    console.error('  FAIL ' + name);
    console.error(e);
    process.exitCode = 1;
  }
}

console.log('tts-utils tests');

test('splitSentences empty', () => {
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences('   '), []);
});

test('splitSentences single sentence', () => {
  const out = splitSentences('Hello world.');
  assert.equal(out.length, 1);
  assert.equal(out[0], 'Hello world.');
});

test('splitSentences multiple punctuation is one section each', () => {
  const out = splitSentences('One. Two! Three?');
  assert.equal(out.length, 3);
  assert.equal(out[0], 'One.');
  assert.equal(out[2], 'Three?');
});

test('splitSentences collapses blank lines', () => {
  const out = splitSentences('Hello.\n\n\nWorld.');
  assert.equal(out.length, 2);
  assert.equal(out[0], 'Hello.');
  assert.equal(out[1], 'World.');
});

test('splitSentences respects word cap', () => {
  const long = Array.from({ length: 100 }, (_, i) => 'word' + i).join(' ');
  const out = splitSentences(long, 40);
  assert.ok(out.length > 1);
  for (const c of out) assert.ok(c.split(/\s+/).length <= 40);
});

test('pcmToWavArrayBuffer header', () => {
  const pcm = new Float32Array([0, 0.5, -0.5, 1, -1]);
  const buf = pcmToWavArrayBuffer(pcm, 22050);
  const view = new DataView(buf);
  assert.equal(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)), 'RIFF');
  assert.equal(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11)), 'WAVE');
  assert.equal(view.getUint32(24, true), 22050);
  assert.equal(buf.byteLength, 44 + 5 * 2);
});

test('filterSpeakers', () => {
  const speakers = [
    { id: 0, name: 'Speaker 0' },
    { id: 12, name: 'Clear Narrator' },
    { id: 47, name: 'Warm Female' }
  ];
  assert.equal(filterSpeakers(speakers, '').length, 3);
  assert.equal(filterSpeakers(speakers, 'narrator').length, 1);
  assert.equal(filterSpeakers(speakers, '12').length, 1);
  assert.equal(filterSpeakers(speakers, 'xyz').length, 0);
});

test('parseModelsJson', () => {
  const data = {
    models: [
      { id: 'a', label: 'A', default: true },
      { id: 'b' },
      { id: 1 },
      null
    ]
  };
  const out = parseModelsJson(data);
  assert.equal(out.length, 2);
  assert.equal(out[0].default, true);
  assert.equal(out[1].label, 'b');
});

test('parseModelsJson empty', () => {
  assert.deepEqual(parseModelsJson({}), []);
  assert.deepEqual(parseModelsJson(null), []);
});

if (!process.exitCode) console.log('All tests passed.');
