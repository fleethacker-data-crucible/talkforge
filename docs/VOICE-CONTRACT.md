# TalkForge voice contract

How other Fleet apps get speech out of TalkForge, offline, without a browser. Two doors, same engine and the same local voices:

- `talkforge speak` for scripts and agents (a command that writes an audio file).
- `POST /v1/audio/speech` for programs (a loopback HTTP endpoint, OpenAI-shaped so Fairlead can route to it).

Nothing here uses the network except the loopback connection itself. Voices come from the local `assets/` folder (`populate-assets` fetches them).

## `talkforge speak`

```
talkforge speak [text...] [--out <file|->] [--voice <id>] [--speed <n>] [--speaker <n>] [--format wav|mp3] [--assets <dir>]
```

`talkforge.cmd` on Windows, `./talkforge` elsewhere (both run `tools/talkforge.mjs`; Node 18 or newer).

| Part | Behaviour |
|---|---|
| Text | The arguments, joined with spaces; or stdin when there are none (or the argument is `-`). |
| `--out` | A file, or `-` for stdout. With no `--out`, audio goes to stdout when it is piped; on a terminal it is refused (exit 64). |
| `--format` | `wav` (default) or `mp3`; taken from a `.mp3` extension on `--out` if not given. |
| `--voice` | An installed Piper voice id. Default `en_US-lessac-high`. |
| `--speed` | 1 = normal, 1.1 = 10 percent faster. 0.25 to 4. |
| `--speaker` | Speaker id for multi-speaker voices. Default 0. |
| Output | WAV: 16-bit mono PCM, one header. MP3: mono, 128 kbps. Sample rate follows the voice (22,050 Hz for the default). One line on stderr: duration, format, voice. |
| `--json` | With `--out <file>`: print one line `{"schema": "talkforge.speak/1", "out", "format", "voice", "seconds", "sampleRate", "bytes"}` on stdout instead of the stderr summary. Without `--out` it is a usage error. |

Also: `talkforge version [--json]` (`talkforge.version/1`) and `talkforge voices list [--json] [--installed]` (`talkforge.voices/1`).

**Exit codes.** `0` ok; `1` error (engine failure, silent output); `2` assets missing (stderr lists each missing file; nothing is downloaded); `64` bad usage (unknown option, no text, audio to a terminal).

```bash
talkforge speak "Build finished." --out done.wav
echo "Piped text." | talkforge speak --format mp3 > note.mp3
```

For many scenes with timings, use `tools/synth-cli.mjs` (see the README "Voiceover CLI").

## Getting the voice files for an offline render (signal-gun and other callers)

The Piper voices are release assets (about 110 MB for the default `en_US-lessac-high`, about 150 MB with the runtime files), not part of the repo. This is the documented step, and it needs one connection, once:

1. **On a build or internet-connected machine** with the repo cloned, fetch only what the voice needs. If the GitHub CLI is signed in (`gh auth login`) it is used automatically, which is how a private release works:
   ```
   powershell -ExecutionPolicy Bypass -File .\populate-assets.ps1 -Only 'models/en_US-lessac-high*','wasm/*','vendor/onnx/*.jsep.wasm'
   TALKFORGE_ONLY="models/en_US-lessac-high*,wasm/*,vendor/onnx/*.jsep.wasm" ./populate-assets.sh
   ```
   Every file is checked against the SHA-256 in `assets-manifest.json`; a bad file is never kept.
2. **Copy the repo folder** (with its `assets/`) to the machine that renders. Nothing is downloaded there.
3. **Preflight before rendering**: `talkforge assets status --voice en_US-lessac-high --json` (add `--no-hash` for a quick presence check). It exits **0** when every file is present and verified, **2** when not, **64** for a voice that is not in the manifest, and with `"ok": false` it prints the exact `populate-assets` command for the missing files under `fetch`. It never downloads anything.

```json
{ "schema": "talkforge.assets/1", "voice": "en_US-lessac-high", "assets": "C:\\talkforge\\assets", "ok": true,
  "files": [ { "dest": "models/en_US-lessac-high.onnx", "state": "ok", "expected": "4cabf7c3...", "actual": "4cabf7c3...", "bytes": 113895201 } ],
  "fetch": null }
```

`state` is `ok`, `present` (`--no-hash`), `missing` or `mismatch`. After this passes, `talkforge speak`, `talkforge serve` and `tools/synth-cli.mjs` work with no network.

## `POST /v1/audio/speech`

Started with `talkforge serve [--port <n>] [--token-file <file>] [--voice <id>] [--assets <dir>]`.

### Connecting and authenticating

- **Loopback only.** The server binds `127.0.0.1`; there is no option to change that. Default port **25009** (the last port of TalkForge's 25000-25009 block); `--port` overrides it.
- **Bearer token on every request:** `Authorization: Bearer <token>`. The server will not start without a token of 16 or more characters, given by env `TALKFORGE_TOKEN` or the first line of `--token-file`. It is compared in constant time and never logged or printed. A missing or wrong token gives `401` with `WWW-Authenticate: Bearer`.
- **Host and Origin rules.** The `Host` header must be `127.0.0.1:<port>`, `localhost:<port>` or `[::1]:<port>`; anything else gives `403` (blocks DNS rebinding). A request with any `Origin` header (a browser page) gives `403`. Call it from a program, not from a web page.
- Per the Fleet credentials contract, the token lives in Lazarette and callers read it by name at start; it is not kept in config files. (TalkForge itself takes it from env or a file; it does not call Lazarette.)

### Request

`Content-Type: application/json`, body up to 64 KB (`413` beyond that).

| Field | Type | Notes |
|---|---|---|
| `input` | string, required | Text to speak, 1 to 10,000 characters. |
| `voice` | string | An installed Piper voice id. Anything else (for example the OpenAI name `alloy`) falls back to the server's default voice. |
| `speed` | number | 0.25 to 4, default 1. A number, not a string. |
| `speaker` | integer | Default 0. |
| `response_format` | `"wav"` or `"mp3"` | Default `wav` (note: OpenAI's default is mp3). |

Unknown fields (such as `model`) are ignored.

### Response

- `200` with the audio bytes. `Content-Type` is `audio/wav` or `audio/mpeg`. Headers: `X-TalkForge-Voice` (the voice actually used) and `X-TalkForge-Seconds` (audio length).
- Errors are JSON, OpenAI style: `{"error": {"message": "..."}}`.

| Status | Meaning |
|---|---|
| 400 | Bad body: not JSON, empty or too long `input`, bad `speed`, `speaker` or `response_format`. |
| 401 | Missing or wrong token. |
| 403 | Non-loopback `Host` or an `Origin` header present. |
| 404 / 405 | Wrong path / not `POST`. |
| 413 | Body over 64 KB. |
| 500 | Synthesis failed. |
| 503 | Assets missing; the message lists each missing file. |

Requests are synthesized one at a time, in arrival order. The first request for a voice also loads it (a few seconds). Measured on a laptop CPU with the default voice, synthesis took roughly 1 to 1.5 seconds per second of audio, so set client timeouts generously (a minute or more for a few paragraphs).

### Examples

```bash
curl -s http://127.0.0.1:25009/v1/audio/speech \
  -H "Authorization: Bearer $TALKFORGE_TOKEN" -H "Content-Type: application/json" \
  -d '{"input":"Hello from TalkForge.","speed":1.05,"response_format":"mp3"}' -o hello.mp3
```

```js
const res = await fetch('http://127.0.0.1:25009/v1/audio/speech', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ input: 'Hello from TalkForge.' })
});
if (!res.ok) throw new Error((await res.json()).error.message);
const wav = Buffer.from(await res.arrayBuffer());
```

### Through Fairlead

Fairlead routes `/v1/audio/speech` to this endpoint. Configure it like any other backend: the base URL `http://127.0.0.1:25009` and the TalkForge token as that backend's key. Callers keep using their own Fairlead client key.

### Lifecycle probes

(Added by the lifecycle change; absent until it is merged.) `GET /__fleethacker/id` (`tool`, `version`, `pid`, `path`) and `GET /__fleethacker/heartbeat` (`ok`, `uptimeSeconds`, `lastRequestAt`, `requests`) need no token; `POST /__fleethacker/shutdown` needs the token and the header `X-FleetHacker-Shutdown: 1`. `talkforge serve --idle-timeout <minutes>` stops the server after that long without a speech request. The `Host` rule above applies to all of them.
