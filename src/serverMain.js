// Entry point for the background server process started by `fmv start`.

import fs from 'node:fs';
import path from 'node:path';
import { createFmvServer } from './server.js';
import { configDir } from './config.js';
import { ensurePrivateDir } from './privateFiles.js';

const dir = configDir();
ensurePrivateDir(dir);
const logFile = path.join(dir, 'server.log');
// Keep the log small: start fresh when it passes 5 MB.
try {
  if (fs.statSync(logFile).size > 5 * 1024 * 1024) fs.truncateSync(logFile, 0);
} catch {}
const out = fs.createWriteStream(logFile, { flags: 'a', mode: 0o600 });
const logger = (line) => out.write(`${new Date().toISOString()} ${line}\n`);

try {
  const app = createFmvServer({ logger });
  const addr = await app.listen();
  logger(`listening on http://localhost:${addr.port}/ (pid ${process.pid})`);
  const stop = () => {
    app.close();
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  app.server.on('close', () => setTimeout(() => process.exit(0), 100));
} catch (e) {
  logger(`failed to start: ${e.code || ''} ${e.message}`);
  process.stderr.write(JSON.stringify({ code: e.code, message: e.message, hint: e.hint }) + '\n');
  process.exit(1);
}
