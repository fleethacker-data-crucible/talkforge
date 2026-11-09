// tools/local-token.mjs - the local token: nothing to configure for apps on this account.
//
// The first `talkforge serve` makes a random token and keeps it in a file only this Windows account can
// read: %LOCALAPPDATA%\TalkForge\local-token (elsewhere $XDG_CONFIG_HOME/talkforge/local-token, mode 0600).
// The server accepts it alongside any token it was started with, so an app running as the same user
// (Lazarette, Semaphore) reads this file and speaks, with no token item to pick and nothing to share.
// Apps of other accounts cannot read the file. A program running as this user could read it, but such a
// program could equally read the user's vault-derived secrets, so a shared token adds no protection there.
// TALKFORGE_LOCAL_TOKEN_FILE moves the file (tests). TALKFORGE_LOCAL_TOKEN=off turns the local token off.
// The token is never logged and never put on a command line.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const LOCAL_TOKEN_FILE_ENV = 'TALKFORGE_LOCAL_TOKEN_FILE';
export const LOCAL_TOKEN_SWITCH_ENV = 'TALKFORGE_LOCAL_TOKEN';
const MIN = 16;

export function localTokenEnabled(env = process.env) {
  return !/^(off|0|false|no)$/i.test(String(env[LOCAL_TOKEN_SWITCH_ENV] || '').trim());
}

export function localTokenPath(env = process.env) {
  if (env[LOCAL_TOKEN_FILE_ENV]) return env[LOCAL_TOKEN_FILE_ENV];
  if (process.platform === 'win32') return join(env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'TalkForge', 'local-token');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'talkforge', 'local-token');
}

// The token, or null when there is none (or it is too short to be one of ours).
export function readLocalToken(env = process.env) {
  try {
    const t = readFileSync(localTokenPath(env), 'utf8').split(/\r?\n/)[0].trim();
    return t.length >= MIN ? t : null;
  } catch { return null; }
}

// Windows: only this account (and SYSTEM) may read the file, whatever the folder allows. Best effort:
// %LOCALAPPDATA% is already private to the account, so a refused icacls leaves it as private as its folder.
export function lockToUser(path) {
  if (process.platform !== 'win32') return true;
  try {
    // Windows' own tools by full path: a Git or MSYS whoami on PATH answers differently.
    const sys32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    const csv = execFileSync(join(sys32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true });
    const sid = (csv.match(/"(S-1-[0-9-]+)"/) || [])[1];
    if (!sid) return false;
    execFileSync(join(sys32, 'icacls.exe'), [path, '/inheritance:r', '/grant:r', `*${sid}:F`, '*S-1-5-18:F'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch { return false; }
}

// The local token, made on first use. Two servers starting at once agree on one token: the file is
// written under a temporary name and the first one in place wins.
export function ensureLocalToken({ env = process.env, lock = lockToUser } = {}) {
  const existing = readLocalToken(env);
  if (existing) return existing;
  const path = localTokenPath(env);
  mkdirSync(dirname(path), { recursive: true });
  const token = randomBytes(32).toString('base64url');
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, token + '\n', { mode: 0o600, flag: 'wx' });
  lock(tmp);
  const raced = readLocalToken(env);
  if (raced) { try { unlinkSync(tmp); } catch { /* gone already */ } return raced; }
  renameSync(tmp, path);
  return readLocalToken(env) ?? token;
}
