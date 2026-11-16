// tools/commands.mjs - TalkForge command registry.
//
// Shape matches fleet-action-baseline 1.0.0 contracts/action-manifest.schema.json and the
// result envelope in contracts/result.schema.json (v: 1, ok, result). Discovery is
// `talkforge commands --json`; `talkforge help --json` prints the same document.
// The noun-verb names are the Fleet CLI names. `talkforge speak` and `talkforge serve`
// stay as they are, so existing callers do not change.
import { DEFAULT_ASSETS_DIR } from './node-engine.mjs';

export const APP = 'talkforge';

function param(name, type, required, description) {
  const p = { name, type, required };
  if (description) p.description = description;
  return p;
}

const assetsParam = () => param('assets', 'string', false, 'Assets directory. Default: the repo assets folder, or env TALKFORGE_ASSETS.');

// Stable ids: talkforge.<noun>.<verb>. Descriptions name the command scripts already call.
export function actionManifest() {
  return {
    version: 1,
    app: APP,
    actions: [
      {
        id: 'talkforge.speech.speak',
        app: APP,
        noun: 'speech',
        verb: 'speak',
        description: 'Speak text to a WAV or MP3 file. Same engine as `talkforge speak`.',
        destructive: false,
        parameters: [
          param('text', 'string', true, 'Text to speak.'),
          param('file', 'string', true, 'Audio file to write.'),
          param('voice', 'string', false, 'Piper voice id. Default en_US-libritts-high.'),
          param('speed', 'number', false, '1 is normal, 1.1 is 10 percent faster. 0.25 to 4.'),
          param('speaker', 'number', false, 'Speaker index for a multi-speaker voice. Default 0.'),
          param('format', 'string', false, 'wav or mp3. Default wav, or mp3 when --file ends in .mp3.'),
          assetsParam()
        ]
      },
      {
        id: 'talkforge.speech.serve',
        app: APP,
        noun: 'speech',
        verb: 'serve',
        description: 'Start the loopback speech endpoint. Same server as `talkforge serve` (token from env, a file, Lazarette, or the local token).',
        destructive: false,
        parameters: [
          param('port', 'number', false, 'Loopback port. Default 25009.'),
          param('voice', 'string', false, 'Default Piper voice id.'),
          assetsParam()
        ]
      },
      {
        id: 'talkforge.voice.list',
        app: APP,
        noun: 'voice',
        verb: 'list',
        description: 'List voices the local assets know about. Same list as `talkforge voices list`.',
        destructive: false,
        parameters: [
          param('installed', 'boolean', false, 'When true, hide voices whose model file is missing.'),
          assetsParam()
        ]
      },
      {
        id: 'talkforge.asset.status',
        app: APP,
        noun: 'asset',
        verb: 'status',
        description: 'Check that the files a voice needs are present and match the manifest. Never downloads. Same check as `talkforge assets status`.',
        destructive: false,
        parameters: [
          param('voice', 'string', false, 'Piper voice id. Default en_US-libritts-high.'),
          param('hash', 'boolean', false, 'When false, check presence only. Default true.'),
          assetsParam()
        ]
      },
      {
        id: 'talkforge.version.show',
        app: APP,
        noun: 'version',
        verb: 'show',
        description: 'Print the TalkForge version from the VERSION file. Same value as `talkforge version`.',
        destructive: false,
        parameters: []
      }
    ]
  };
}

export function findAction(noun, verb) {
  return actionManifest().actions.find((a) => a.noun === noun && a.verb === verb) || null;
}

export function commandsEnvelope(result = actionManifest()) {
  return { v: 1, ok: true, result };
}

export function dryRunResult(action, args, confirmed) {
  return {
    dryRun: true,
    actionId: action.id,
    app: action.app,
    noun: action.noun,
    verb: action.verb,
    args,
    destructive: action.destructive,
    confirmationRequired: action.destructive === true && confirmed !== true
  };
}

export function formatCommandsText(manifest = actionManifest()) {
  const lines = [`${manifest.app} commands`];
  for (const a of manifest.actions) {
    const flags = a.parameters.map((p) => (p.required ? `--${p.name}` : `[--${p.name}]`)).join(' ');
    lines.push(`  ${a.app} ${a.noun} ${a.verb}${flags ? ' ' + flags : ''}`);
    lines.push(`      ${a.description}`);
  }
  lines.push('');
  lines.push('`talkforge speak` and `talkforge serve` are the same engine. `talkforge --help` prints their options.');
  lines.push(`Assets default: ${DEFAULT_ASSETS_DIR}`);
  return lines.join('\n');
}
