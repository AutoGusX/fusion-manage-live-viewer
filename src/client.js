// HTTP client the CLI uses to talk to the local server.

import { loadConfig, configDir } from './config.js';
import { readSecret } from './security.js';

export class CliError extends Error {
  constructor(code, message, hint, extra = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
    Object.assign(this, extra);
  }
}

export function serverInfo(env = process.env) {
  const { config, errors, file, exists } = loadConfig(env);
  return { config, errors, file, exists, secret: readSecret(configDir(env)) };
}

export async function call(method, path, body, { env = process.env, timeoutMs = 300_000, raw = false } = {}) {
  const { config, secret } = serverInfo(env);
  if (!secret) throw new CliError('NOT_RUNNING', 'The viewer server has never been started.', 'Run `fmv start`.');
  let resp;
  try {
    resp = await fetch(`http://127.0.0.1:${config.port}${path}`, {
      method,
      headers: { 'X-FMV-Secret': secret, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e?.name === 'TimeoutError') throw new CliError('TIMEOUT', 'The viewer server did not answer in time.', 'Run `fmv status`.');
    throw new CliError('NOT_RUNNING', `The viewer server is not running on port ${config.port}.`, 'Run `fmv start`.');
  }
  if (raw) return resp;
  const data = await resp.json().catch(() => null);
  if (!data) throw new CliError('BAD_RESPONSE', `Unexpected response from the viewer server (HTTP ${resp.status}).`, 'Run `fmv status`.');
  if (!data.ok) {
    const e = data.error || {};
    throw new CliError(e.code || 'ERROR', e.message || 'Request failed.', e.hint, { detail: e.detail, attachments: e.attachments, fmStatus: e.fmStatus, missing: e.missing, problems: e.problems });
  }
  return data.result;
}

export async function isRunning(env = process.env) {
  try {
    await call('GET', '/api/status', undefined, { env, timeoutMs: 3000 });
    return true;
  } catch {
    return false;
  }
}
