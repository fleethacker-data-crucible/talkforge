#!/usr/bin/env node
// tools/talkforge.mjs - headless TalkForge: `speak` (text to an audio file) and `serve`
// (loopback speech endpoint). Offline: local assets only. See README "Headless mode".
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { DEFAULT_ASSETS_DIR, DEFAULT_VOICE, MissingAssetsError } from './node-engine.mjs';
import { createSynthesizer } from './synth-core.mjs';
import { DEFAULT_PORT, checkToken, startServer } from './talkforge-server.mjs';
import { DEFAULT_LAZARETTE_ITEM, TokenError, resolveToken } from './token-provider.mjs';

export const USAGE = `Usage:
  talkforge speak [text...] [options]    text from the arguments, or stdin when none (or "-")
  talkforge serve [options]              loopback-only speech endpoint

speak options:
  --out <file|->       output file, or - for stdout (default: stdout when piped; required on a terminal)
  --voice <id>         voice (default: ${DEFAULT_VOICE})
  --speed <n>          1 = normal, 1.1 = 10% faster (0.25 to 4)
  --speaker <n>        speaker id for multi-speaker voices
  --format <wav|mp3>   default wav (or taken from the --out extension)
  --assets <dir>       assets folder (default <repo>/assets, or env TALKFORGE_ASSETS)

serve options:
  --port <n>           default ${DEFAULT_PORT}; 127.0.0.1 only, there is no host option
  --token-file <file>  first line is the bearer token (or set env TALKFORGE_TOKEN); 16+ characters
  --token-from <src>   env | file | lazarette (default: file if --token-file is given, else env)
  --lazarette-item <n> vault item for --token-from lazarette (default ${DEFAULT_LAZARETTE_ITEM}, or env TALKFORGE_LAZARETTE_ITEM)
  --idle-timeout <min> stop after this many minutes without a speech request (default 0 = never)
  --voice, --assets    as above

Endpoint: POST /v1/audio/speech with "Authorization: Bearer <token>" and JSON
{"input": "...", "voice"?, "speed"?, "speaker"?, "response_format"?: "wav"|"mp3"}.
Exit codes: 0 ok, 1 error, 2 assets missing (nothing is downloaded), 64 bad usage.`;

class UsageError extends Error {}

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help') return { cmd: 'help' };
  if (!['speak', 'serve'].includes(cmd)) throw new UsageError(`Unknown command: ${cmd}`);
  const o = { cmd, text: [], out: undefined, voice: undefined, speed: 1, speaker: 0, format: undefined, port: DEFAULT_PORT,
    tokenFile: undefined, tokenFrom: undefined, lazaretteItem: undefined, idleTimeout: 0, assets: process.env.TALKFORGE_ASSETS || DEFAULT_ASSETS_DIR };
  const val = (i, n) => { if (i + 1 >= rest.length) throw new UsageError(`${n} needs a value`); return rest[i + 1]; };
  const num = (v, n) => { const x = Number(v); if (!Number.isFinite(x)) throw new UsageError(`${n} must be a number, got "${v}"`); return x; };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '-') { o.text.push('-'); continue; }
    if (!a.startsWith('--')) { o.text.push(a); continue; }
    switch (a) {
      case '--out': o.out = val(i, a); i++; break;
      case '--voice': o.voice = val(i, a); i++; break;
      case '--speed': o.speed = num(val(i, a), a); i++; break;
      case '--speaker': o.speaker = num(val(i, a), a); i++; break;
      case '--format': o.format = val(i, a).toLowerCase(); i++; break;
      case '--port': o.port = num(val(i, a), a); i++; break;
      case '--token-file': o.tokenFile = val(i, a); i++; break;
      case '--token-from': o.tokenFrom = val(i, a).toLowerCase(); i++; break;
      case '--lazarette-item': o.lazaretteItem = val(i, a); i++; break;
      case '--idle-timeout': o.idleTimeout = num(val(i, a), a); i++; break;
      case '--assets': o.assets = val(i, a); i++; break;
      default: throw new UsageError(`Unknown option: ${a}`);
    }
  }
  if (o.format && !['wav', 'mp3'].includes(o.format)) throw new UsageError(`--format must be wav or mp3, got "${o.format}"`);
  if (o.tokenFrom && !['env', 'file', 'lazarette'].includes(o.tokenFrom)) throw new UsageError(`--token-from must be env, file or lazarette, got "${o.tokenFrom}"`);
  if (o.idleTimeout < 0) throw new UsageError('--idle-timeout must be 0 or more');
  if (cmd === 'serve' && o.text.length) throw new UsageError('serve takes no text');
  if (cmd === 'serve' && !(Number.isInteger(o.port) && o.port >= 0 && o.port < 65536)) throw new UsageError('--port must be 0 to 65535');
  return o;
}

// VERSION file at the repo root (kept equal to PAGE_VERSION in the page; tests/version.test.mjs checks).
export function readVersion() {
  try { return readFileSync(new URL('../VERSION', import.meta.url), 'utf8').trim() || '0.0.0'; }
  catch { return '0.0.0'; }
}

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function speak(o) {
  let text = o.text.join(' ');
  if (!text || text === '-') text = await readStdin();
  if (!text.trim()) throw new UsageError('No text: pass it as arguments or pipe it on stdin');
  let out = o.out;
  if (out === undefined) {
    if (process.stdout.isTTY) throw new UsageError('Give --out <file> (refusing to write audio to the terminal)');
    out = '-';
  }
  const format = o.format || (/\.mp3$/i.test(out) ? 'mp3' : 'wav');
  const synth = createSynthesizer({ assets: o.assets, defaultVoice: o.voice ?? DEFAULT_VOICE });
  const r = await synth.render({ text, voice: o.voice ?? DEFAULT_VOICE, speed: o.speed, speaker: o.speaker, format });
  if (out === '-') process.stdout.write(r.bytes);
  else await writeFile(resolve(out), r.bytes);
  console.error(`${r.seconds.toFixed(2)} s ${format} (${r.voice})${out === '-' ? '' : ' -> ' + resolve(out)}`);
}

async function serve(o) {
  const { token: raw, source } = await resolveToken({ from: o.tokenFrom, tokenFile: o.tokenFile, item: o.lazaretteItem });
  const token = checkToken(raw);
  console.error(`API token read from ${source}`); // the source only, never the value
  const synth = createSynthesizer({ assets: o.assets, defaultVoice: o.voice ?? DEFAULT_VOICE, log: (m) => console.error(m) });
  await synth.load(o.voice ?? DEFAULT_VOICE); // fail fast, with the missing-file list, before listening
  let stopNow;
  const stopped = new Promise((r) => { stopNow = r; });
  const s = await startServer({
    synth, token, port: o.port, log: (m) => console.error(m), version: readVersion(),
    scriptPath: fileURLToPath(import.meta.url), idleTimeoutMs: Math.round(o.idleTimeout * 60000), onStop: stopNow
  });
  console.log(`TalkForge speech endpoint: http://127.0.0.1:${s.port}/v1/audio/speech (loopback only, bearer token required)`);
  process.once('SIGINT', () => stopNow('signal'));
  process.once('SIGTERM', () => stopNow('signal'));
  await stopped;
  await s.close();
}

export async function main(argv) {
  let o;
  try { o = parseArgs(argv); }
  catch (e) { console.error(`Error: ${e.message}\n\n${USAGE}`); return 64; }
  if (o.cmd === 'help') { console.log(USAGE); return 0; }
  try {
    await (o.cmd === 'speak' ? speak(o) : serve(o));
    return 0;
  } catch (e) {
    if (e instanceof UsageError) { console.error(`Error: ${e.message}\n\n${USAGE}`); return 64; }
    if (e instanceof TokenError) { console.error(`Error: ${e.message}`); return 1; }
    if (e instanceof MissingAssetsError) { console.error(`Error: ${e.message}`); return 2; }
    console.error(`Error: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
