// tests/syntax.test.mjs — catch parse errors before they hang the page
import { readFileSync } from 'node:fs';
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

// Inline module script in the page
const html = readFileSync(join(root, 'TalkForge-tts.html'), 'utf8');
const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
assert.ok(m, 'TalkForge-tts.html has a module script');
checkJs('TalkForge-tts.html inline script', m[1]);

// Vendor modules
for (const rel of [
  'assets/vendor/tts-utils.js',
  'assets/vendor/piper-engine.js'
]) {
  checkJs(rel, readFileSync(join(root, rel), 'utf8'));
}

if (!process.exitCode) console.log('Syntax checks passed.');
