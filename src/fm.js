// Fusion Manage client used by the local server (spec 0002).
// Every call goes to the configured tenant only, under /api/v3/ (or /api/v2/ for the few
// endpoints FM still serves there, such as image fields). The bearer token is injected here and
// never returned to the caller.

import { AuthError } from './auth.js';

export const ACCEPT = {
  json: 'application/json',
  attachmentsBulk: 'application/vnd.autodesk.plm.attachments.bulk+json',
  attachmentViewable: 'application/vnd.autodesk.plm.attachment.viewable+json',
};

export const CAD_EXTENSIONS = new Set([
  '3dm', '3ds', 'asm', 'catpart', 'catproduct', 'dgn', 'dwf', 'dwfx', 'dwg', 'dxf', 'f3d', 'f3z', 'fbx', 'iam', 'idw', 'ifc',
  'iges', 'igs', 'ipt', 'jt', 'model', 'nwc', 'nwd', 'obj', 'prt', 'rvt', 'sat', 'sab', 'sldasm', 'sldprt', 'smb', 'smt',
  'step', 'stp', 'stl', 'stla', 'stlb', 'x_b', 'x_t', 'zip',
]);

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const ID = /^\d{1,12}$/;

export class FmError extends Error {
  constructor(code, message, hint, extra = {}) {
    super(message);
    this.code = code;
    this.hint = hint;
    Object.assign(this, extra);
  }
}

/**
 * Resolve a caller-supplied path against the tenant. Throws FmError if it would leave the
 * tenant host or the FM API.
 */
export function resolveFmUrl(base, rawPath, query) {
  if (typeof rawPath !== 'string' || !rawPath.startsWith('/') || rawPath.startsWith('//') || rawPath.includes('\\')) {
    throw new FmError('INVALID_PATH', 'The FM path must start with /api/v3/ (for example /api/v3/workspaces).', 'Pass a path, not a full URL.');
  }
  const baseUrl = new URL(base);
  const url = new URL(rawPath, baseUrl);
  if (url.origin !== baseUrl.origin) throw new FmError('INVALID_PATH', 'The FM path must stay on your tenant.', 'Pass a path, not a full URL.');
  if (!/^\/api\/v[23]\//.test(url.pathname)) {
    throw new FmError('INVALID_PATH', 'Only Fusion Manage API paths (/api/v3/…) are allowed.', 'Start the path with /api/v3/.');
  }
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query)) {
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, String(item));
      else if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  return url;
}

export function requireId(value, name) {
  const s = String(value ?? '');
  if (!ID.test(s)) throw new FmError('INVALID_ARGUMENT', `${name} must be a numeric ID.`, `Pass the ${name} number from Fusion Manage.`);
  return s;
}

/** Attachment list comes back in three shapes; this is the only reader. */
export function normaliseAttachments(data) {
  if (!data || typeof data !== 'object') return [];
  const list = Array.isArray(data) ? data : data.attachments;
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a && typeof a === 'object')
    .map((a) => {
      const m = /attachments\/(\d+)/.exec(String(a.selfLink || a.__self__ || ''));
      const name = String(a.name || a.resourceName || '');
      const ext = String(a.type?.extension || name.split('.').pop() || '').replace(/^\./, '').toLowerCase();
      return {
        id: String(a.id ?? (m ? m[1] : '')),
        name,
        extension: ext,
        version: Number(a.version ?? 1),
        size: a.size ?? null,
        description: a.description ? String(a.description) : '',
        isCad: CAD_EXTENSIONS.has(ext),
      };
    });
}

export class FmClient {
  constructor(config, auth, log = () => {}) {
    this.config = config;
    this.auth = auth;
    this.log = log;
  }

  /**
   * One authenticated call. Returns { status, headers, body, contentType } for any FM response;
   * throws FmError/AuthError only for problems on our side (auth, path guard, network).
   */
  async request({ method = 'GET', path, query, body, accept, contentType, contentLocation, raw = false, timeoutMs = 60_000 }) {
    method = String(method).toUpperCase();
    if (!METHODS.has(method)) throw new FmError('INVALID_ARGUMENT', `Unsupported method ${method}.`, 'Use GET, POST, PUT, PATCH or DELETE.');
    const url = resolveFmUrl(this.config.fmBaseUrl, path, query);
    const started = Date.now();

    const send = async (token) => {
      const headers = { Authorization: `Bearer ${token}`, Accept: accept || ACCEPT.json };
      // Workflow transitions name the transition in this header. It must stay on the tenant API.
      if (contentLocation) headers['content-location'] = resolveFmUrl(this.config.fmBaseUrl, contentLocation).pathname;
      let payload;
      if (body !== undefined && body !== null && method !== 'GET') {
        if (typeof body === 'string') {
          payload = body;
          headers['Content-Type'] = contentType || 'application/json';
        } else {
          payload = JSON.stringify(body);
          headers['Content-Type'] = contentType || 'application/json';
        }
      }
      try {
        return await fetch(url, { method, headers, body: payload, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      } catch (e) {
        const timedOut = e?.name === 'TimeoutError';
        throw new FmError(timedOut ? 'TIMEOUT' : 'FM_NETWORK', timedOut ? 'Fusion Manage did not answer in time.' : 'Could not reach Fusion Manage.', 'Check the tenant name and your network, then retry.');
      }
    };

    let resp = await send((await this.auth.getAccessToken()).token);
    if (resp.status === 401) {
      // Either the token expired or FM doesn't accept this client ID. Refresh once to find out.
      const text = await resp.text().catch(() => '');
      if (/no user mapped/i.test(text)) {
        this.logCall(method, url, 401, started);
        throw clientNotAllowed(this.config);
      }
      resp = await send((await this.auth.getAccessToken({ forceRefresh: true })).token);
      if (resp.status === 401) {
        this.logCall(method, url, 401, started);
        throw clientNotAllowed(this.config);
      }
    }
    this.logCall(method, url, resp.status, started);
    if (raw) return resp;

    const ctype = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const headers = {};
    for (const h of ['location', 'content-location', 'etag', 'content-type']) {
      const v = resp.headers.get(h);
      if (v) headers[h] = v;
    }
    let out;
    if (resp.status === 204) out = null;
    else if (ctype.includes('json')) {
      const text = await resp.text();
      try {
        out = text ? JSON.parse(text) : null;
      } catch {
        out = text;
      }
    } else if (ctype.startsWith('text/') || ctype === '' || ctype.includes('xml') || ctype.includes('html')) {
      out = await resp.text();
    } else {
      const size = (await resp.arrayBuffer()).byteLength;
      out = { binary: true, contentType: ctype, size, hint: 'Binary content. Use `fmv fm download` for files.' };
    }
    return { status: resp.status, headers, contentType: ctype, body: out };
  }

  logCall(method, url, status, started) {
    this.log({ kind: 'fm', method, path: url.pathname + (url.search ? '?…' : ''), status, ms: Date.now() - started });
  }

  async listAttachments(ws, item) {
    requireId(ws, 'workspace');
    requireId(item, 'item');
    const r = await this.request({ path: `/api/v3/workspaces/${ws}/items/${item}/attachments`, query: { asc: 'name' }, accept: ACCEPT.attachmentsBulk });
    if (r.status >= 400) throw fmHttpError(r, 'list the attachments');
    return normaliseAttachments(r.body);
  }

  /** FM's own derivative for an attachment. The GET itself starts a missing translation. */
  async getViewable(ws, item, att) {
    requireId(ws, 'workspace');
    requireId(item, 'item');
    requireId(att, 'attachment');
    const r = await this.request({ path: `/api/v3/workspaces/${ws}/items/${item}/attachments/${att}`, accept: ACCEPT.attachmentViewable });
    if (r.status >= 400) throw fmHttpError(r, 'get the viewable for this attachment');
    const b = r.body && typeof r.body === 'object' ? r.body : {};
    return {
      urn: String(b.fileUrn || ''),
      status: String(b.status || ''),
      viewerName: String(b.viewerName || ''),
      fileName: String(b.fileName || ''),
    };
  }

  /** A fresh pre-signed download URL (default Accept returns only fileUrl + thumbnails). */
  async getDownloadUrl(ws, item, att) {
    requireId(ws, 'workspace');
    requireId(item, 'item');
    requireId(att, 'attachment');
    const r = await this.request({ path: `/api/v3/workspaces/${ws}/items/${item}/attachments/${att}` });
    if (r.status >= 400) throw fmHttpError(r, 'get the download link for this attachment');
    const url = r.body?.fileUrl || r.body?.url;
    if (!url) throw new FmError('NOT_FOUND', 'Fusion Manage returned no download link for this attachment.', 'Check the attachment ID with `fmv fm attachments <ws> <item>`.');
    return String(url);
  }
}

export function clientNotAllowed(config) {
  return new FmError(
    'FM_CLIENT_NOT_ALLOWED',
    'Fusion Manage refused the sign-in token (401).',
    `Either the session expired (run \`fmv login\`) or your APS client ID is not on the tenant's allowed list. An FM admin adds it under Allowed client IDs at ${config.fmBaseUrl}/plm/admin/system-configuration/general-settings`,
  );
}

export function fmHttpError(r, action) {
  const detail = typeof r.body === 'string' ? r.body.slice(0, 300) : r.body ? JSON.stringify(r.body).slice(0, 300) : '';
  const code = r.status === 403 ? 'FM_FORBIDDEN' : r.status === 404 ? 'NOT_FOUND' : 'FM_ERROR';
  const hint =
    r.status === 403
      ? 'Your FM account lacks permission for this workspace or item.'
      : r.status === 404
        ? 'Check the workspace, item and attachment IDs.'
        : 'See the details from Fusion Manage.';
  return new FmError(code, `Could not ${action} (HTTP ${r.status}).`, hint, { status: r.status, detail });
}

export { AuthError };
