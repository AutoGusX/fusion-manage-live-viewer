// Local-server security controls (spec 0003).

import crypto from 'node:crypto';
import path from 'node:path';
import { readIfExists, writePrivateFile } from './privateFiles.js';

/** Per-install API secret, created on first use. The CLI reads the same file. */
export function loadOrCreateSecret(dir) {
  const file = path.join(dir, 'secret');
  const existing = (readIfExists(file) || '').trim();
  if (/^[a-f0-9]{64}$/.test(existing)) return existing;
  const secret = crypto.randomBytes(32).toString('hex');
  writePrivateFile(file, secret + '\n');
  return secret;
}

export function readSecret(dir) {
  const s = (readIfExists(path.join(dir, 'secret')) || '').trim();
  return /^[a-f0-9]{64}$/.test(s) ? s : null;
}

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** Refuse anything but our own loopback host names (DNS rebinding). */
export function hostAllowed(hostHeader, port) {
  return hostHeader === `localhost:${port}` || hostHeader === `127.0.0.1:${port}`;
}

/** Browser requests that change state must come from our own page. */
export function sameOrigin(req, port) {
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  if (!origin) return site === 'same-origin';
  return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export const PAGE_COOKIE = 'fmv_page';

export function contentSecurityPolicy({ unsafeEval = false } = {}) {
  return [
    "default-src 'self'",
    `script-src 'self' https://developer.api.autodesk.com${unsafeEval ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline' https://developer.api.autodesk.com",
    "font-src 'self' data: https://developer.api.autodesk.com https://fonts.autodesk.com",
    "img-src 'self' data: blob: https://*.autodeskplm360.net https://*.amazonaws.com https://developer.api.autodesk.com https://cdn.derivative.autodesk.com",
    "connect-src 'self' https://*.autodeskplm360.net https://developer.api.autodesk.com https://cdn.derivative.autodesk.com https://*.amazonaws.com",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; ');
}

const SECRET_PATTERNS = [
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]'],
  [/("?(?:access_token|refresh_token|code|code_verifier|token)"?\s*[:=]\s*"?)[^"&\s,}]+/gi, '$1[redacted]'],
  [/([?&](?:code|state|token|X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token)=)[^&\s"']+/gi, '$1[redacted]'],
];

export function redact(text) {
  let s = String(text);
  for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
  return s;
}
