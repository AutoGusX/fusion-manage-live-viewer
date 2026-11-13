// Config loading and validation (spec 0001).
// The .env lives in the user's config directory, never in the repo. Process environment
// variables override file values, which is what tests and CI use.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_PORT = 4710;
export const DEFAULT_SCOPES = 'data:read data:write data:create data:search';
export const KNOWN_KEYS = [
  'APS_CLIENT_ID',
  'FM_TENANT',
  'FM_BASE_URL',
  'FMV_PORT',
  'APS_CALLBACK_URL',
  'APS_SCOPES',
  'FMV_PERSIST_SESSION',
  'FMV_ALLOW_TOKEN_EXPORT',
  // Test-only: point APS auth at a loopback stub. Ignored unless it is a loopback URL.
  'FMV_APS_BASE',
];

export function configDir(env = process.env) {
  return env.FMV_CONFIG_DIR || path.join(os.homedir(), '.fusion-manage-live-viewer');
}

export function envFileName(profile) {
  if (!profile) return '.env';
  if (!/^[a-z0-9_-]+$/i.test(profile)) throw new Error(`Invalid profile name "${profile}". Use letters, numbers, - and _.`);
  return `.env.${profile}`;
}

export function envFilePath(env = process.env) {
  return path.join(configDir(env), envFileName(env.FMV_PROFILE));
}

/** Minimal .env parser: KEY=VALUE, optional quotes, full-line and trailing " #" comments. */
export function parseEnv(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

export function serializeEnv(values) {
  const lines = ['# Fusion Manage live viewer config. Written by `fmv setup`. Do not commit.'];
  for (const key of KNOWN_KEYS) {
    if (values[key] !== undefined && values[key] !== '') lines.push(`${key}=${values[key]}`);
  }
  return lines.join('\n') + '\n';
}

export function readEnvFile(env = process.env) {
  const file = envFilePath(env);
  if (!fs.existsSync(file)) return { file, values: {}, exists: false };
  return { file, values: parseEnv(fs.readFileSync(file, 'utf8')), exists: true };
}

function isLoopbackUrl(u) {
  try {
    const url = new URL(u);
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  } catch {
    return false;
  }
}

/**
 * Validate raw values and derive defaults. Returns { config, errors } where errors is a list of
 * { key, message } that never includes the value itself.
 */
export function resolveConfig(raw) {
  const errors = [];
  const clientId = (raw.APS_CLIENT_ID || '').trim();
  const tenant = (raw.FM_TENANT || '').trim().toLowerCase();

  if (!clientId) errors.push({ key: 'APS_CLIENT_ID', message: 'Missing. Add the client ID of your APS app.' });
  else if (!/^[A-Za-z0-9_-]{16,128}$/.test(clientId)) errors.push({ key: 'APS_CLIENT_ID', message: 'Does not look like an APS client ID.' });

  if (!tenant) errors.push({ key: 'FM_TENANT', message: 'Missing. Add your tenant name, e.g. mycompany for mycompany.autodeskplm360.net.' });
  else if (!/^[a-z0-9-]+$/.test(tenant)) errors.push({ key: 'FM_TENANT', message: 'Use only the tenant name (letters, numbers, -), not a full URL.' });

  let port = DEFAULT_PORT;
  if (raw.FMV_PORT) {
    port = Number(raw.FMV_PORT);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      errors.push({ key: 'FMV_PORT', message: 'Must be a whole number between 1024 and 65535.' });
      port = DEFAULT_PORT;
    }
  }

  let fmBaseUrl = raw.FM_BASE_URL ? raw.FM_BASE_URL.trim().replace(/\/+$/, '') : tenant ? `https://${tenant}.autodeskplm360.net` : '';
  if (raw.FM_BASE_URL) {
    try {
      const u = new URL(fmBaseUrl);
      if (u.protocol !== 'https:' && !isLoopbackUrl(fmBaseUrl)) errors.push({ key: 'FM_BASE_URL', message: 'Must start with https://.' });
      fmBaseUrl = u.origin;
    } catch {
      errors.push({ key: 'FM_BASE_URL', message: 'Not a valid URL.' });
    }
  }

  const callbackUrl = (raw.APS_CALLBACK_URL || `http://localhost:${port}/callback`).trim();
  try {
    const cb = new URL(callbackUrl);
    if (!isLoopbackUrl(callbackUrl)) errors.push({ key: 'APS_CALLBACK_URL', message: 'Must be a localhost URL served by this viewer.' });
    else if (Number(cb.port || 80) !== port) errors.push({ key: 'APS_CALLBACK_URL', message: `Port must match FMV_PORT (${port}).` });
    else if (cb.pathname !== '/callback') errors.push({ key: 'APS_CALLBACK_URL', message: 'Path must be /callback.' });
  } catch {
    errors.push({ key: 'APS_CALLBACK_URL', message: 'Not a valid URL.' });
  }

  const apsBase = raw.FMV_APS_BASE && isLoopbackUrl(raw.FMV_APS_BASE) ? raw.FMV_APS_BASE.replace(/\/+$/, '') : 'https://developer.api.autodesk.com';

  const config = {
    clientId,
    tenant,
    fmBaseUrl,
    port,
    callbackUrl,
    origin: `http://localhost:${port}`,
    scopes: (raw.APS_SCOPES || DEFAULT_SCOPES).trim(),
    persistSession: (raw.FMV_PERSIST_SESSION || 'true').toLowerCase() !== 'false',
    allowTokenExport: (raw.FMV_ALLOW_TOKEN_EXPORT || 'false').toLowerCase() === 'true',
    apsBase,
  };
  return { config, errors };
}

/** Load file + environment overrides. */
export function loadConfig(env = process.env) {
  const { file, values, exists } = readEnvFile(env);
  const merged = { ...values };
  for (const key of KNOWN_KEYS) if (env[key] !== undefined) merged[key] = env[key];
  const { config, errors } = resolveConfig(merged);
  return { file, exists, raw: merged, config, errors };
}

/** Show enough of a client ID to recognise it, never the whole value. */
export function mask(value) {
  if (!value) return '(not set)';
  if (value.length <= 8) return '****';
  return `${value.slice(0, 4)}…${value.slice(-2)}`;
}
