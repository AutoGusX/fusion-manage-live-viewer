// `fmv setup`: write or check the user's .env (spec 0001).
// Interactive prompts run in the user's own terminal (`! fmv setup` in Claude Code), so values
// never pass through the conversation. Flags allow a non-interactive setup for scripted installs.

import fs from 'node:fs';
import readline from 'node:readline/promises';
import { DEFAULT_PORT, configDir, envFilePath, mask, readEnvFile, resolveConfig, serializeEnv } from './config.js';
import { ensurePrivateDir, writePrivateFile } from './privateFiles.js';

export function apsChecklist(config) {
  return [
    'Before you sign in, check your APS app at https://aps.autodesk.com/myapps:',
    '  1. Application type: Desktop, Mobile, Single-Page App (a public client; no secret is used).',
    `  2. Callback URL: ${config.callbackUrl}   (must match exactly)`,
    '  3. API access: Autodesk Fusion Manage (if listed) and Model Derivative / Viewer are enabled.',
    `  4. In Fusion Manage, an admin adds the client ID under Allowed client IDs:`,
    `     ${config.fmBaseUrl || 'https://<tenant>.autodeskplm360.net'}/plm/admin/system-configuration/general-settings`,
  ].join('\n');
}

export function checkReport(env = process.env) {
  const { file, values, exists } = readEnvFile(env);
  const { config, errors } = resolveConfig(values);
  const lines = [`Config file: ${file}${exists ? '' : ' (not found)'}`];
  const bad = new Map(errors.map((e) => [e.key, e.message]));
  const show = [
    ['APS_CLIENT_ID', mask(values.APS_CLIENT_ID)],
    ['FM_TENANT', values.FM_TENANT || '(not set)'],
    ['FMV_PORT', String(config.port)],
    ['APS_CALLBACK_URL', config.callbackUrl],
    ['FM_BASE_URL', config.fmBaseUrl || '(derived from FM_TENANT)'],
  ];
  for (const [key, shown] of show) lines.push(`  ${bad.has(key) ? 'FAIL' : 'ok  '} ${key.padEnd(17)} ${shown}${bad.has(key) ? `  — ${bad.get(key)}` : ''}`);
  return { ok: errors.length === 0, text: lines.join('\n'), config, errors };
}

export async function runSetup(flags, env = process.env) {
  ensurePrivateDir(configDir(env));
  const file = envFilePath(env);
  const { values: current } = readEnvFile(env);
  const next = { ...current };

  const fromFlags = {
    APS_CLIENT_ID: flags['client-id'],
    FM_TENANT: flags.tenant,
    FMV_PORT: flags.port,
  };
  const nonInteractive = Object.values(fromFlags).some((v) => v !== undefined) || !process.stdin.isTTY;

  if (nonInteractive) {
    for (const [k, v] of Object.entries(fromFlags)) if (v !== undefined) next[k] = String(v).trim();
  } else {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      process.stdout.write(`Fusion Manage live viewer setup. Values are saved to ${file}\nPress Enter to keep the current value.\n\n`);
      const ask = async (key, label, shown) => {
        for (;;) {
          const answer = (await rl.question(`${label}${shown ? ` [${shown}]` : ''}: `)).trim();
          const value = answer || current[key] || '';
          const trial = resolveConfig({ ...next, [key]: value });
          const err = trial.errors.find((e) => e.key === key);
          if (!err) {
            next[key] = value;
            return;
          }
          process.stdout.write(`  ${err.message}\n`);
        }
      };
      await ask('APS_CLIENT_ID', 'APS client ID', current.APS_CLIENT_ID ? mask(current.APS_CLIENT_ID) : '');
      await ask('FM_TENANT', 'Fusion Manage tenant (the name before .autodeskplm360.net)', current.FM_TENANT || '');
      const port = (await rl.question(`Local port [${current.FMV_PORT || DEFAULT_PORT}]: `)).trim();
      if (port) next.FMV_PORT = port;
    } finally {
      rl.close();
    }
  }

  // A tenant typed as a full URL is a common slip; keep just the name.
  if (next.FM_TENANT) {
    const m = /^(?:https?:\/\/)?([a-z0-9-]+)\.autodeskplm360\.net/i.exec(next.FM_TENANT.trim());
    if (m) next.FM_TENANT = m[1].toLowerCase();
  }
  if (String(next.FMV_PORT || '') === String(DEFAULT_PORT)) delete next.FMV_PORT;

  const { config, errors } = resolveConfig(next);
  if (errors.length) {
    return { ok: false, text: `Not saved:\n${errors.map((e) => `  ${e.key}: ${e.message}`).join('\n')}` };
  }
  writePrivateFile(file, serializeEnv(next));
  return { ok: true, text: `Saved ${file}\n\n${apsChecklist(config)}\n\nNext: fmv start, then fmv login.`, config };
}

export function envFileExists(env = process.env) {
  return fs.existsSync(envFilePath(env));
}
