// tools/talkforge-server.mjs - loopback-only, token-checked speech endpoint (offline).
//
//   POST /v1/audio/speech   Authorization: Bearer <token>
//        { "input": "text", "voice"?: "en_US-libritts_r-medium", "speed"?: 1, "speaker"?: 0,
//          "response_format"?: "wav" | "mp3" }   ->  audio bytes
//
// Shape follows OpenAI /v1/audio/speech so Fairlead can route to it. Differences: default format
// is wav; an unknown or foreign voice name (for example "alloy") falls back to the default voice
// and the voice actually used is returned in the X-TalkForge-Voice header.
//
// Safety: binds 127.0.0.1 only (there is no host option); every request needs the bearer token
// (constant-time compare); requests whose Host is not loopback, or that carry an Origin header
// (browsers), are refused; bodies are capped; nothing is read from or sent to the network.
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { MissingAssetsError } from './node-engine.mjs';
import { MIME } from './synth-core.mjs';
import { listVoices } from './voices.mjs';

export const LOOPBACK = '127.0.0.1';
export const DEFAULT_PORT = 25009; // last port of TalkForge's 25000-25009 block (the page server starts at 25000)
export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_INPUT_CHARS = 10000;
export const MIN_TOKEN_LENGTH = 16;

export function checkToken(token) {
  if (typeof token !== 'string' || token.trim().length < MIN_TOKEN_LENGTH) {
    throw new Error(`A token of at least ${MIN_TOKEN_LENGTH} characters is required (env TALKFORGE_TOKEN or --token-file). The server will not start without one.`);
  }
  return token.trim();
}

const digest = (s) => createHash('sha256').update(s).digest();

export function tokenMatches(header, token) {
  const m = /^Bearer\s+(.+)$/i.exec(header || '');
  if (!m) return false;
  return timingSafeEqual(digest(m[1].trim()), digest(token));
}

function hostOk(host, port) {
  if (!host) return false;
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host.toLowerCase());
}

function sendJson(res, status, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store', ...extra });
  res.end(body);
}
const fail = (res, status, message, extra) => sendJson(res, status, { error: { message } }, extra);

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    let rejected = false;
    req.on('data', (c) => {
      n += c.length;
      if (rejected) return; // drain and discard the rest so the 413 reply can be delivered
      if (n > limit) { rejected = true; chunks.length = 0; reject(Object.assign(new Error('Request body too large'), { status: 413 })); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// synth: createSynthesizer() result. options: { token, port (0 = any free), assetsDir, log }
// Resolves { server, port, close() } once listening.
//   lifecycle: version/scriptPath are reported by /__fleethacker/id; idleTimeoutMs (0 = off) stops the
//   server after that long without a speech request; onStop(reason) is called for 'shutdown' or 'idle'.
export function startServer({ synth, token, port = DEFAULT_PORT, log = () => {}, version = '0.0.0', scriptPath = '', idleTimeoutMs = 0, onStop = () => {} }) {
  token = checkToken(token);
  let boundPort = port;
  const startedAt = Date.now();
  let lastRequestAt = null;
  let requests = 0;
  let idleTimer = null;
  const stop = (reason) => { clearTimeout(idleTimer); log(`stopping: ${reason}`); setImmediate(() => onStop(reason)); };
  const armIdle = () => {
    clearTimeout(idleTimer);
    if (idleTimeoutMs > 0) { idleTimer = setTimeout(() => stop('idle'), idleTimeoutMs); idleTimer.unref?.(); }
  };

  async function voiceFor(requested) {
    if (typeof requested === 'string' && /^[A-Za-z0-9_.-]+$/.test(requested)) {
      try { await access(join(synth.assetsDir, 'models', `${requested}.onnx`)); return requested; } catch { /* fall back */ }
    }
    return synth.defaultVoice;
  }

  const server = createServer(async (req, res) => {
    try {
      if (!hostOk(req.headers.host, boundPort) || req.headers.origin !== undefined) {
        return fail(res, 403, 'Forbidden: loopback callers only');
      }
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      // Lifecycle probes need no token (loopback only, nothing sensitive): who is running, and is it alive.
      if (req.method === 'GET' && path === '/__fleethacker/id') {
        return sendJson(res, 200, { tool: 'talkforge', version, pid: process.pid, path: scriptPath });
      }
      if (req.method === 'GET' && path === '/__fleethacker/heartbeat') {
        return sendJson(res, 200, {
          ok: true, tool: 'talkforge', version, pid: process.pid, port: boundPort,
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          lastRequestAt: lastRequestAt && new Date(lastRequestAt).toISOString(), requests,
          idleTimeoutSeconds: Math.round(idleTimeoutMs / 1000)
        });
      }
      if (!tokenMatches(req.headers.authorization, token)) {
        return fail(res, 401, 'Missing or wrong bearer token', { 'www-authenticate': 'Bearer' });
      }
      if (path === '/__fleethacker/shutdown') {
        if (req.method !== 'POST' || req.headers['x-fleethacker-shutdown'] !== '1') return fail(res, 400, 'Shutdown needs POST with header X-FleetHacker-Shutdown: 1');
        sendJson(res, 202, { stopping: true });
        return stop('shutdown');
      }
      if (path === '/v1/voices') {
        if (req.method !== 'GET') return fail(res, 405, 'Use GET', { allow: 'GET' });
        const voices = await listVoices(synth.assetsDir, synth.defaultVoice);
        return sendJson(res, 200, { object: 'list', default: synth.defaultVoice, data: voices.map((v) => ({ id: v.id, installed: v.installed, default: v.default, speakers: v.speakers, sample_rate: v.sampleRate, language: v.language })) });
      }
      if (path !== '/v1/audio/speech') return fail(res, 404, 'Not found');
      if (req.method !== 'POST') return fail(res, 405, 'Use POST', { allow: 'POST' });

      let body;
      try { body = JSON.parse((await readBody(req, MAX_BODY_BYTES)).toString('utf8')); }
      catch (e) { return fail(res, e.status || 400, e.status ? e.message : 'Body must be JSON', e.status ? { connection: 'close' } : {}); }
      if (!body || typeof body !== 'object') return fail(res, 400, 'Body must be a JSON object');
      const { input, speed = 1, speaker = 0, response_format: format = 'wav' } = body;
      if (typeof input !== 'string' || !input.trim()) return fail(res, 400, '"input" must be non-empty text');
      if (input.length > MAX_INPUT_CHARS) return fail(res, 400, `"input" is longer than ${MAX_INPUT_CHARS} characters`);
      if (!MIME[format]) return fail(res, 400, '"response_format" must be wav or mp3');
      if (typeof speed !== 'number' || !(speed >= 0.25 && speed <= 4)) return fail(res, 400, '"speed" must be a number from 0.25 to 4');
      if (!Number.isInteger(speaker) || speaker < 0) return fail(res, 400, '"speaker" must be a non-negative integer');

      const voice = await voiceFor(body.voice);
      const t0 = Date.now();
      lastRequestAt = t0; requests++; armIdle(); // a real speech request is the only activity that resets the idle timer
      let r;
      try { r = await synth.render({ text: input, voice, speed, speaker, format }); }
      catch (e) {
        if (e instanceof MissingAssetsError) return fail(res, 503, e.message);
        return fail(res, 500, e.message);
      }
      log(`speech ${r.seconds.toFixed(2)} s voice=${voice} format=${format} in ${Date.now() - t0} ms`);
      res.writeHead(200, {
        'content-type': r.mime, 'content-length': r.bytes.length, 'cache-control': 'no-store',
        'x-talkforge-voice': voice, 'x-talkforge-seconds': r.seconds.toFixed(3)
      });
      res.end(r.bytes);
    } catch (e) {
      if (!res.headersSent) fail(res, 500, 'Internal error');
      else res.destroy();
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK, () => {
      boundPort = server.address().port;
      armIdle();
      resolve({ server, port: boundPort, close: () => new Promise((r) => { clearTimeout(idleTimer); server.close(() => r()); server.closeAllConnections?.(); }) });
    });
  });
}
