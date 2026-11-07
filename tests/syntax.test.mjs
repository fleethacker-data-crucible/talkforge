// tests/syntax.test.mjs — catch parse errors before they hang the page
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function checkJs(label, source) {
  try {
    // --check parses without executing
    execFileSync(process.execPath, ['--check', '--input-type=module'], {
      input: source,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    console.log('  ok  ' + label);
  } catch (e) {
    console.error('  FAIL ' + label);
    console.error(e.stderr?.toString() || e.message);
    process.exitCode = 1;
  }
}

// Every inline <script> in the page (module or classic; external src scripts and data blocks are skipped)
const html = readFileSync(join(root, 'TalkForge-tts.html'), 'utf8');
let inline = 0;
for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)) {
  if (/\bsrc\s*=/i.test(m[1]) || /type\s*=\s*["'](?!module|text\/javascript)/i.test(m[1]) || !m[2].trim()) continue;
  inline++;
  checkJs(`TalkForge-tts.html inline script #${inline}`, m[2]);
}
assert.ok(inline >= 1, 'TalkForge-tts.html has an inline script');

// Our own modules: vendor helpers and engine, the Node tools, and the tests themselves
const files = ['assets/vendor/tts-utils.js', 'assets/vendor/piper-engine.js'];
for (const dir of ['tools', 'tests']) {
  for (const f of readdirSync(join(root, dir)).sort()) if (/\.mjs$/.test(f)) files.push(`${dir}/${f}`);
}
for (const rel of files) checkJs(rel, readFileSync(join(root, rel), 'utf8'));

if (!process.exitCode) console.log('Syntax checks passed.');
