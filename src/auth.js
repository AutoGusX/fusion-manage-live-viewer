// APS 3-legged sign-in with PKCE, plus token storage and refresh (spec 0001).
// The access token lives in memory only. The refresh token is also cached in session.json
// (user-only) unless FMV_PERSIST_SESSION=false, so a server restart doesn't force a new sign-in.

import crypto from 'node:crypto';
import path from 'node:path';
import { readIfExists, removeIfExists, writePrivateFile } from './privateFiles.js';

const EXPIRY_BUFFER_MS = 5 * 60_000;
const PENDING_TTL_MS = 10 * 60_000;

export function base64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function createPkcePair() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

export class AuthError extends Error {
  constructor(code, message, hint) {
    super(message);
    this.code = code;
    this.hint = hint;
  }
}

export class Auth {
  /**
   * @param {object} config resolved config
   * @param {string} dir config directory (for session.json)
   * @param {(entry: object) => void} [log]
   */
  constructor(config, dir, log = () => {}) {
    this.config = config;
    this.sessionFile = path.join(dir, 'session.json');
    this.log = log;
    this.pending = new Map(); // state -> { verifier, created }
    this.access = null; // { token, expiresAt }
    this.refreshToken = null;
    this.refreshing = null;
    this.user = null;
    this.loadSession();
  }

  loadSession() {
    if (!this.config.persistSession) return;
    const text = readIfExists(this.sessionFile);
    if (!text) return;
    try {
      const s = JSON.parse(text);
      // A cached session belongs to one client ID and APS host; ignore it if either changed.
      if (s.clientId === this.config.clientId && s.apsBase === this.config.apsBase && s.refreshToken) {
        this.refreshToken = s.refreshToken;
      }
    } catch {
      removeIfExists(this.sessionFile);
    }
  }

  saveSession() {
    if (!this.config.persistSession || !this.refreshToken) return;
    writePrivateFile(
      this.sessionFile,
      JSON.stringify({ clientId: this.config.clientId, apsBase: this.config.apsBase, refreshToken: this.refreshToken, savedAt: new Date().toISOString() }),
    );
  }

  get signedIn() {
    return Boolean(this.refreshToken || (this.access && this.access.expiresAt > Date.now()));
  }

  /** Build the authorize URL for a new sign-in. */
  beginLogin() {
    const now = Date.now();
    for (const [state, p] of this.pending) if (now - p.created > PENDING_TTL_MS) this.pending.delete(state);
    const { verifier, challenge } = createPkcePair();
    const state = base64url(crypto.randomBytes(16));
    this.pending.set(state, { verifier, created: now });
    const url = new URL(`${this.config.apsBase}/authentication/v2/authorize`);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.callbackUrl);
    url.searchParams.set('scope', this.config.scopes);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    return url.toString();
  }

  /** Handle /callback. Throws AuthError on any problem. */
  async completeLogin({ code, state, error, errorDescription }) {
    if (error) throw new AuthError('AUTH_DENIED', `Sign-in was not completed: ${error}`, errorDescription || 'Run `fmv login` to try again.');
    const pending = state && this.pending.get(state);
    if (!pending) throw new AuthError('AUTH_STATE_MISMATCH', 'This sign-in link is unknown or expired.', 'Run `fmv login` to start a new sign-in.');
    this.pending.delete(state);
    if (!code) throw new AuthError('AUTH_DENIED', 'No authorization code was returned.', 'Run `fmv login` to try again.');
    await this.tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.config.callbackUrl,
      code_verifier: pending.verifier,
    });
    this.log({ kind: 'auth', message: 'Signed in' });
  }

  async tokenRequest(params) {
    const body = new URLSearchParams({ client_id: this.config.clientId, ...params });
    let resp;
    try {
      resp = await fetch(`${this.config.apsBase}/authentication/v2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new AuthError('AUTH_NETWORK', 'Could not reach Autodesk sign-in.', 'Check your network connection, then retry.');
    }
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.access_token) {
      const code = data.error || `HTTP ${resp.status}`;
      let hint = 'Run `fmv login` to sign in again.';
      if (code === 'invalid_client' || code === 'invalid_credentials' || resp.status === 401) {
        hint = 'Check that APS_CLIENT_ID belongs to an APS app of type "Desktop, Mobile, Single-Page App" and that its callback URL matches exactly.';
      }
      throw new AuthError('AUTH_REQUIRED', `Autodesk sign-in failed (${code}).`, hint);
    }
    this.access = { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000 };
    if (data.refresh_token) this.refreshToken = data.refresh_token; // refresh tokens rotate
    this.saveSession();
  }

  /** A valid access token, refreshing if it expires within 5 minutes. */
  async getAccessToken({ forceRefresh = false } = {}) {
    if (!forceRefresh && this.access && this.access.expiresAt - EXPIRY_BUFFER_MS > Date.now()) return this.access;
    if (!this.refreshToken) {
      this.access = null;
      throw new AuthError('AUTH_REQUIRED', 'Not signed in.', 'Run `fmv login` and sign in with your Autodesk account.');
    }
    if (!this.refreshing) {
      const refreshToken = this.refreshToken;
      this.refreshing = this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken, scope: this.config.scopes })
        .catch((e) => {
          // Only drop the session if the refresh token itself was refused, not on a network blip.
          if (e.code === 'AUTH_REQUIRED') this.clear();
          throw e;
        })
        .finally(() => {
          this.refreshing = null;
        });
    }
    await this.refreshing;
    return this.access;
  }

  clear() {
    this.access = null;
    this.refreshToken = null;
    this.user = null;
    removeIfExists(this.sessionFile);
  }

  async logout() {
    const token = this.refreshToken;
    this.clear();
    if (!token) return;
    try {
      await fetch(`${this.config.apsBase}/authentication/v2/revoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token, token_type_hint: 'refresh_token', client_id: this.config.clientId }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Revocation is best effort; the local session is already gone.
    }
    this.log({ kind: 'auth', message: 'Signed out' });
  }
}
