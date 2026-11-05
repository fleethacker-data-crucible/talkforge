// tools/token-provider.mjs - where `talkforge serve` gets its API token.
//
// A provider is `async ({ options, env }) => string`. Built in:
//   env        env TALKFORGE_TOKEN                         (default when no --token-file)
//   file       first line of --token-file                  (default when --token-file is given)
//   lazarette  the vault item `talkforge-api` (override: --lazarette-item or env TALKFORGE_LAZARETTE_ITEM),
//              read in-process through Lazarette's PowerShell contract (lib\Lazarette.ps1:
//              Unlock-LazaretteVaultInteractive, Get-LazaretteSecret -Service <item>).
//              Fallback: the retired Arc contract (lib\Arc.ps1: Unlock-ArcVaultInteractive,
//              Get-ArcSecret -Service <item>). Opt in with --token-from lazarette.
//              Point LAZARETTE_PATH (or ARC_PATH) at a Lazarette-Lite checkout and the
//              token comes from Windows Credential Manager instead: secret-only, no custom
//              fields or TOTP, and Lite's unlock is a no-op, so the passphrase+TOTP gate
//              is dropped when falling back to Lite.
// The token is returned to the caller only; it is never logged, put on a command line, or written to disk.
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const DEFAULT_LAZARETTE_ITEM = 'talkforge-api';
export const ITEM_ENV = 'TALKFORGE_LAZARETTE_ITEM';
export const POWERSHELL_ENV = 'TALKFORGE_POWERSHELL_BIN'; // test hook: command (and args) to run instead of powershell.exe
const ITEM_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

export class TokenError extends Error {
  constructor(message) { super(message); this.name = 'TokenError'; }
}

// Runs in the child PowerShell. The item name arrives in the environment (TF_VAULT_ITEM), never in the
// script text or the argument list; the secret leaves on stdout only. Exit codes: 3 Lazarette not found,
// 4 could not unlock, 5 item missing or ambiguous.
export const LAZARETTE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$item = $env:TF_VAULT_ITEM
# Lazarette 5 contract first: lib\\Lazarette.ps1 (Unlock-LazaretteVaultInteractive,
# Get-LazaretteSecret). It is also the contract Lazarette-Lite ships, so pointing
# LAZARETTE_PATH at a Lite checkout reads the secret from Windows Credential Manager.
# Fallback: the retired Arc contract, lib\\Arc.ps1 (Unlock-ArcVaultInteractive,
# Get-ArcSecret). Both are secret-only: no custom fields, no TOTP.
$lazCandidates = @($env:LAZARETTE_PATH, (Join-Path $env:USERPROFILE 'Projects\\Lazarette'))
$arcCandidates = @($env:ARC_PATH, $env:ARC_ROOT, $env:ARC_HOME,
  (Join-Path $env:USERPROFILE 'Projects\\Lazarette'), (Join-Path $env:USERPROFILE 'Projects\\arc'))
$root = $null
$contract = $null
foreach ($p in $lazCandidates) { if ($p -and (Test-Path -LiteralPath (Join-Path $p 'lib\\Lazarette.ps1'))) { $root = (Resolve-Path $p).Path; $contract = 'lazarette'; break } }
if (-not $root) { foreach ($p in $arcCandidates) { if ($p -and (Test-Path -LiteralPath (Join-Path $p 'lib\\Arc.ps1'))) { $root = (Resolve-Path $p).Path; $contract = 'arc'; break } } }
if (-not $root) { [Console]::Error.WriteLine('Lazarette not found (set LAZARETTE_PATH to its folder, or ARC_PATH for the retired Arc contract).'); exit 3 }
if ($contract -eq 'lazarette') {
  . (Join-Path $root 'lib\\Lazarette.ps1')
  if (-not (Unlock-LazaretteVaultInteractive)) { [Console]::Error.WriteLine('Lazarette stayed locked (unlocking needs an interactive console).'); exit 4 }
  try { $v = Get-LazaretteSecret -Service $item } catch { [Console]::Error.WriteLine('Lazarette item not usable: ' + $_.Exception.Message); exit 5 }
} else {
  . (Join-Path $root 'lib\\Arc.ps1')
  if (-not (Unlock-ArcVaultInteractive)) { [Console]::Error.WriteLine('Lazarette stayed locked (unlocking needs an interactive console).'); exit 4 }
  try { $v = Get-ArcSecret -Service $item } catch { [Console]::Error.WriteLine('Lazarette item not usable: ' + $_.Exception.Message); exit 5 }
}
[Console]::Out.Write($v)
`;

const encode = (script) => Buffer.from(script, 'utf16le').toString('base64');

function powershellCommand(env) {
  const custom = (env[POWERSHELL_ENV] || '').split(' ').filter(Boolean);
  return custom.length ? custom : ['powershell.exe'];
}

export async function lazaretteProvider({ options = {}, env = process.env, spawnFn = spawn }) {
  const item = options.item || env[ITEM_ENV] || DEFAULT_LAZARETTE_ITEM;
  if (!ITEM_RE.test(item)) throw new TokenError(`Invalid Lazarette item name "${item}" (letters, digits, space, . _ - only)`);
  const [bin, ...pre] = powershellCommand(env);
  const args = [...pre, '-NoProfile', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encode(LAZARETTE_SCRIPT)];
  const out = await new Promise((res, rej) => {
    // stdin and stderr stay on the console so the unlock prompt works; only stdout is captured.
    const p = spawnFn(bin, args, { env: { ...env, TF_VAULT_ITEM: item }, stdio: ['inherit', 'pipe', 'inherit'] });
    const chunks = [];
    p.stdout.on('data', (c) => chunks.push(c));
    p.on('error', (e) => rej(new TokenError(`Could not start PowerShell to reach Lazarette: ${e.message}`)));
    p.on('close', (code) => {
      if (code === 0) return res(Buffer.concat(chunks).toString('utf8').trim());
      const why = { 3: 'Lazarette was not found (set LAZARETTE_PATH to its folder, or ARC_PATH for the retired Arc contract)', 4: 'Lazarette could not be unlocked (run in an interactive console)', 5: `vault item "${item}" is missing or ambiguous` }[code];
      rej(new TokenError(`Lazarette: ${why || `PowerShell exited with code ${code}`}. Other ways to give the token: env TALKFORGE_TOKEN or --token-file.`));
    });
  });
  if (!out) throw new TokenError(`Lazarette item "${item}" is empty`);
  return out;
}

export const builtInProviders = {
  async env({ env = process.env }) {
    if (!env.TALKFORGE_TOKEN) throw new TokenError('No token: set env TALKFORGE_TOKEN, or use --token-file <file> or --token-from lazarette.');
    return env.TALKFORGE_TOKEN;
  },
  async file({ options = {} }) {
    if (!options.tokenFile) throw new TokenError('--token-from file needs --token-file <file>');
    let text;
    try { text = await readFile(resolve(options.tokenFile), 'utf8'); }
    catch (e) { throw new TokenError(`Cannot read the token file: ${e.code || e.message}`); }
    return text.split(/\r?\n/)[0];
  },
  lazarette: lazaretteProvider
};

// from: 'env' | 'file' | 'lazarette' | undefined. Undefined keeps the long-standing behaviour:
// --token-file if given, else env TALKFORGE_TOKEN. providers: extra or replacement providers (tests).
export async function resolveToken({ from, tokenFile, item, env = process.env, providers = {} } = {}) {
  const table = { ...builtInProviders, ...providers };
  const name = from || (tokenFile ? 'file' : 'env');
  if (!table[name]) throw new TokenError(`Unknown token provider "${name}" (use ${Object.keys(table).join(', ')})`);
  const token = await table[name]({ options: { tokenFile, item }, env });
  return { token, source: name };
}
