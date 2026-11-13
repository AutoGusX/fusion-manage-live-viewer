// Open a URL in the default browser without a shell (URLs with & or ? are passed verbatim).

import { spawn } from 'node:child_process';

export function openInBrowser(url) {
  // Headless machines, CI and tests: print the link instead of opening a browser.
  if (process.env.FMV_NO_BROWSER === '1' || process.env.FMV_NO_BROWSER === 'true') return false;
  const u = new URL(url);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) URLs can be opened.');
  let cmd;
  let args;
  if (process.platform === 'win32') {
    cmd = 'rundll32.exe';
    args = ['url.dll,FileProtocolHandler', u.toString()];
  } else if (process.platform === 'darwin') {
    cmd = 'open';
    args = [u.toString()];
  } else {
    cmd = 'xdg-open';
    args = [u.toString()];
  }
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
