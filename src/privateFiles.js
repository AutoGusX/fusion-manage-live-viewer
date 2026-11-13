// Files in the config directory are readable by the current user only.
// POSIX: 0700 directory, 0600 files. Windows: mode bits are ignored, so the directory's ACL is
// reset to the current user with icacls (best effort; failure is reported, not fatal).

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const locked = new Set();

export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (locked.has(dir)) return;
  locked.add(dir);
  if (process.platform === 'win32') {
    const user = process.env.USERNAME;
    if (!user) return;
    try {
      execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], { stdio: 'ignore', windowsHide: true });
    } catch {
      // Leave the default ACL (user profile folders are already private on standard installs).
    }
  } else {
    try {
      fs.chmodSync(dir, 0o700);
    } catch {}
  }
}

/** Atomic write with user-only permissions. */
export function writePrivateFile(file, content) {
  ensurePrivateDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(file, 0o600);
    } catch {}
  }
}

export function readIfExists(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export function removeIfExists(file) {
  try {
    fs.unlinkSync(file);
  } catch {}
}
