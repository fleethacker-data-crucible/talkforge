// Bearer credential parsing. Locks the speech server's Authorization check:
// valid and invalid tokens, scheme and separator edges, and long headers that used
// to make the old parser backtrack. Calls the production functions and the live server.
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bearerCredential, startServer, tokenMatches } from '../tools/talkforge-server.mjs';

const TOKEN = 'test-token-0123456789abcdef';
let failed = false;

function test(name, fn) {
  try {
    fn();
    console.log('  ok  ' + name);
  } catch (e) {
    failed = true;
    console.error('  FAIL ' + name);
    console.error(e);
  }
}

function examined(header) {
  const stats = {};
  const credential = bearerCredential(header, stats);
  const raw = header || '';
  const value = typeof raw === 'string' ? raw : String(raw);
  assert.equal(typeof stats.steps, 'number');
  assert.ok(stats.steps <= value.length, `${stats.steps} steps for length ${value.length}`);
  return { credential, steps: stats.steps, length: value.length };
}

console.log('bearer token tests');

test('accepts the token with scheme case, separator, and surrounding whitespace folded the same way', () => {
  const accepted = [
    `Bearer ${TOKEN}`,
    `bearer ${TOKEN}`,
    `BEARER ${TOKEN}`,
    `BeArEr ${TOKEN}`,
    `Bearer  ${TOKEN}`,
    `Bearer   ${TOKEN}`,
    `Bearer\t${TOKEN}`,
    `Bearer\v${TOKEN}`,
    `Bearer\f${TOKEN}`,
    `Bearer\n${TOKEN}`,
    `Bearer\r${TOKEN}`,
    `Bearer\u00a0${TOKEN}`,
    `Bearer\u1680${TOKEN}`,
    `Bearer\u2003${TOKEN}`,
    `Bearer\u2028${TOKEN}`,
    `Bearer\u2029${TOKEN}`,
    `Bearer\u3000${TOKEN}`,
    `Bearer\ufeff${TOKEN}`,
    `Bearer \n\t ${TOKEN}`,
    `Bearer ${TOKEN} `,
    `Bearer ${TOKEN}   `,
    `Bearer ${TOKEN}\t`,
    `Bearer ${TOKEN}\v`,
    `Bearer ${TOKEN}\f`,
    `Bearer ${TOKEN}\u00a0`,
    `Bearer ${TOKEN}\u2003`,
    `Bearer  ${TOKEN}  `
  ];
  for (const header of accepted) {
    assert.equal(bearerCredential(header), TOKEN, JSON.stringify(header));
    assert.equal(tokenMatches(header, TOKEN), true, JSON.stringify(header));
  }
});

test('rejects missing, malformed, and non-matching credentials', () => {
  const rejected = [
    undefined,
    null,
    '',
    TOKEN,
    `Bearer${TOKEN}`,
    ` Bearer ${TOKEN}`,
    `Basic ${TOKEN}`,
    `Bearer: ${TOKEN}`,
    `Bearer\u200b${TOKEN}`,
    `Bearer\u0085${TOKEN}`,
    'Bearer',
    'Bearer ',
    'Bearer\n',
    'Bearer\r\n',
    `Bearer ${TOKEN} extra`,
    `Bearer ${TOKEN}\n`,
    `Bearer ${TOKEN}\r`,
    `Bearer ${TOKEN}\u2028`,
    `Bearer ${TOKEN}\u2029`,
    `Bearer ${TOKEN}\r\n`,
    `Bearer ${TOKEN}\nmore`,
    `Bearer ${TOKEN}\n ${TOKEN}`,
    `Bearer ${TOKEN}x`,
    `bearer wrong-token-0123456789`
  ];
  for (const header of rejected) {
    assert.equal(tokenMatches(header, TOKEN), false, JSON.stringify(header));
    assert.notEqual(bearerCredential(header), TOKEN, JSON.stringify(header));
  }
  assert.equal(tokenMatches('Bearer nope-nope-nope-nope', TOKEN), false);
  assert.equal(tokenMatches(`Bearer ${'x'.repeat(TOKEN.length)}`, TOKEN), false);
  assert.equal(bearerCredential(`Bearer ${TOKEN} extra`), `${TOKEN} extra`);
});

test('whitespace-only credentials still match only the empty string', () => {
  assert.equal(bearerCredential('Bearer  '), '');
  assert.equal(bearerCredential('Bearer   '), '');
  assert.equal(bearerCredential('Bearer \n '), '');
  assert.equal(bearerCredential('Bearer\n '), '');
  assert.equal(bearerCredential('Bearer \n\n '), '');
  assert.equal(tokenMatches('Bearer  ', ''), true);
  assert.equal(tokenMatches('Bearer  ', ' '), false);
  assert.equal(tokenMatches('Bearer  ', TOKEN), false);
  assert.equal(bearerCredential('Bearer '), null);
  assert.equal(bearerCredential('Bearer\n'), null);
  assert.equal(bearerCredential('Bearer \n'), null);
  assert.equal(bearerCredential('Bearer \n\n'), null);
  assert.equal(tokenMatches('Bearer ', ''), false);
  assert.equal(tokenMatches('Bearer \n\n', ''), false);
});

test('parsed credential is what the constant-time compare uses', () => {
  const headers = [
    `Bearer ${TOKEN}`,
    `bearer\t${TOKEN}  `,
    `Bearer ${TOKEN} extra`,
    'Bearer   ',
    'Basic nope',
    undefined,
    `Bearer ${TOKEN}\n`
  ];
  for (const header of headers) {
    assert.equal(tokenMatches(header, TOKEN), bearerCredential(header) === TOKEN, JSON.stringify(header));
    const credential = bearerCredential(header);
    if (credential !== null) assert.equal(tokenMatches(header, credential), true);
  }
});

test('a non-bearer prefix does not scan the rest of a long header', () => {
  const stats = {};
  const header = 'Basic ' + 'a'.repeat(100000);
  assert.equal(bearerCredential(header, stats), null);
  assert.ok(stats.steps <= 6, String(stats.steps));
  assert.equal(tokenMatches(header, TOKEN), false);
});

test('adversarial headers are rejected in a single left-to-right scan', () => {
  const evil = (n) => 'Bearer ' + ' '.repeat(n) + '\n' + 'a'.repeat(n) + '\n' + 'b';
  for (const n of [1, 8, 64, 1000, 4000, 50000]) {
    const header = evil(n);
    const seen = examined(header);
    assert.equal(seen.credential, null);
    // Walk the space run and the text after it, and never revisit a character.
    assert.ok(seen.steps > n * 2, `n=${n} steps=${seen.steps}`);
    assert.ok(seen.steps <= seen.length, `n=${n} steps=${seen.steps} length=${seen.length}`);
    assert.equal(tokenMatches(header, TOKEN), false);
  }
  // Same pump at 4x the size stays linear (a quadratic scan would be about 16x).
  const small = examined(evil(1000));
  const scaled = examined(evil(4000));
  assert.ok(scaled.steps <= small.steps * 4 + 32, `${small.steps} -> ${scaled.steps}`);
  assert.ok(scaled.steps >= small.steps * 4 - 32, `${small.steps} -> ${scaled.steps}`);

  const lineSeparators = examined('Bearer ' + ' '.repeat(20000) + '\u2028' + 'a'.repeat(20000) + '\u2028b');
  assert.equal(lineSeparators.credential, null);
  assert.ok(lineSeparators.steps > 40000);
  assert.ok(lineSeparators.steps <= lineSeparators.length);

  const accepted = examined(`Bearer ${TOKEN}` + ' '.repeat(100000));
  assert.equal(accepted.credential, TOKEN);
  assert.equal(accepted.steps, accepted.length);
  assert.equal(tokenMatches(`Bearer ${TOKEN}` + ' '.repeat(100000), TOKEN), true);
});

test('the server module still compares digests in constant time and has no backtracking expression', () => {
  const src = readFileSync(fileURLToPath(new URL('../tools/talkforge-server.mjs', import.meta.url)), 'utf8');
  const start = src.indexOf('export function tokenMatches');
  const end = src.indexOf('function hostOk');
  assert.ok(start > 0 && end > start);
  const fn = src.slice(start, end);
  assert.equal(fn.includes('bearerCredential(header)'), true);
  assert.equal(fn.includes('timingSafeEqual(digest(credential), digest(token))'), true);
  assert.equal(fn.includes('.exec('), false);
  assert.equal(fn.includes('console.'), false);
  assert.equal(fn.includes('log('), false);
  assert.equal(src.includes('.exec('), false);
  assert.equal(src.includes('\\s+'), false);
});

function request(port, { method = 'GET', path = '/v1/audio/speech', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      agent: false, host: '127.0.0.1', port, method, path,
      headers: { ...(data ? { 'content-length': Buffer.byteLength(data) } : {}), ...headers }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const serverCases = (async () => {
  const logs = [];
  const calls = [];
  const synth = {
    calls, assetsDir: join(tmpdir(), 'tf-no-such-assets'), defaultVoice: 'en_US-lessac-high',
    render: async (req) => { calls.push(req); return { bytes: Buffer.from('RIFF'), mime: 'audio/wav', seconds: 1, voice: req.voice }; }
  };
  const s = await startServer({ synth, token: TOKEN, port: 0, log: (line) => logs.push(line) });
  try {
    const expectAuth = async (header, accepted) => {
      const headers = header === undefined ? {} : { authorization: header };
      const res = await request(s.port, { headers });
      assert.equal(res.status, accepted ? 405 : 401, JSON.stringify(header));
      if (!accepted) {
        assert.equal(res.headers['www-authenticate'], 'Bearer');
        assert.equal(JSON.parse(res.body).error.message, 'Missing or wrong bearer token');
        assert.equal(res.body.includes(TOKEN), false);
      }
      assert.equal(calls.length, 0);
    };
    await expectAuth(`Bearer ${TOKEN}`, true);
    await expectAuth(`bearer ${TOKEN}`, true);
    await expectAuth(`BeArEr ${TOKEN}`, true);
    await expectAuth(`Bearer  ${TOKEN}`, true);
    await expectAuth(`Bearer\t${TOKEN}`, true);
    await expectAuth(`Bearer\u00a0${TOKEN}`, true);
    await expectAuth(`Bearer ${TOKEN}   `, true);
    await expectAuth(undefined, false);
    await expectAuth('', false);
    await expectAuth(TOKEN, false);
    await expectAuth(`Bearer${TOKEN}`, false);
    await expectAuth(`Basic ${TOKEN}`, false);
    await expectAuth('Bearer nope-nope-nope-nope', false);
    await expectAuth(`Bearer ${TOKEN} extra`, false);
    await expectAuth('Bearer ' + ' '.repeat(8000) + 'not-the-token', false);
    await expectAuth(`Bearer ${TOKEN}` + ' '.repeat(8000), true);

    const ok = await request(s.port, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: { input: 'hi' } });
    assert.equal(ok.status, 200, ok.body.toString());
    assert.equal(calls.length, 1);
    assert.equal(logs.some((line) => line.includes(TOKEN)), false);
    console.log('  ok  live server uses the same bearer decision');
  } finally {
    await s.close();
  }
})();

try {
  await serverCases;
} catch (e) {
  failed = true;
  console.error('  FAIL live server uses the same bearer decision');
  console.error(e);
}

if (failed) process.exitCode = 1;
else console.log('All bearer token tests passed.');
