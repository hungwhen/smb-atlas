import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createTargetPlan } from './lib/targets.mjs';
import { ScanManager } from './lib/scanner.mjs';
import { queryEntries, inventoryStats, fileExtension } from './lib/inventory.mjs';

export { queryEntries } from './lib/inventory.mjs';

const MAX_BODY = 262144;
const publicPath = fileURLToPath(new URL('./public/', import.meta.url));
const assets = new Map([['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/overview.css', ['overview.css', 'text/css; charset=utf-8']],
  ['/overview.js', ['overview.js', 'text/javascript; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']]]);
const fail = (status, message) => Object.assign(new Error(message), { status });

async function readJson(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw fail(415, 'Send application/json.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw fail(413, 'Request exceeds the 256 KiB limit.');
    chunks.push(chunk);
  }
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error();
    return result;
  } catch { throw fail(400, 'Invalid JSON object.'); }
}

export function validateScan(input) {
  const hosts = createTargetPlan(input.targets);
  // Validate the numeric progress counter without materializing the target addresses.
  void hosts.length;
  if (typeof input.username !== 'string' || !input.username.trim() || input.username.length > 256) throw fail(400, 'A username of 1–256 characters is required.');
  if (typeof input.password !== 'string' || !input.password || input.password.length > 4096) throw fail(400, 'A password of 1–4096 characters is required.');
  if (input.domain !== undefined && (typeof input.domain !== 'string' || input.domain.length > 256)) throw fail(400, 'Domain must be text, up to 256 characters.');
  let username = input.username.trim();
  let domain = (input.domain || '').trim();
  if (username.includes('\\')) {
    const parts = username.split('\\');
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw fail(400, 'Use DOMAIN\\username, user@domain, or username with a separate domain.');
    if (domain && domain.toLowerCase() !== parts[0].toLowerCase()) throw fail(400, 'The supplied domain conflicts with DOMAIN\\username.');
    [domain, username] = parts;
  }
  if (username.includes('@') && domain) throw fail(400, 'Leave Domain empty when using user@domain.');
  if (/[\0\r\n]/.test(username + domain + input.password)) throw fail(400, 'Credentials cannot contain null or line-break characters.');
  const source = input.options ?? {};
  if (!source || Array.isArray(source) || typeof source !== 'object') throw fail(400, 'Options must be an object.');
  const number = (name, fallback, min, max) => {
    const value = source[name] ?? fallback;
    if (!Number.isInteger(value) || value < min || value > max) throw fail(400, `${name} must be an integer from ${min} to ${max}.`);
    return value;
  };
  const boolean = name => {
    if (source[name] !== undefined && typeof source[name] !== 'boolean') throw fail(400, `${name} must be true or false.`);
    return source[name] ?? false;
  };
  const shareNames = source.shareNames ?? [];
  if (!Array.isArray(shareNames) || shareNames.length > 128 || shareNames.some(name =>
    typeof name !== 'string' || !name || name.length > 80 || /[\\/:*?"<>|\x00-\x1f]/.test(name) || name === '.' || name === '..' || name !== name.trim())) {
    throw fail(400, 'Share names must be simple names, without slashes or wildcard characters (up to 128 shares).');
  }
  const options = {
    maxDepth: number('maxDepth', 8, 0, 32), concurrency: number('concurrency', 4, 1, 16),
    timeoutSeconds: number('timeoutSeconds', 90, 5, 600), maxEntries: number('maxEntries', 50000, 100, 250000),
    includeHiddenShares: boolean('includeHiddenShares'), includeFolders: boolean('includeFolders'),
    shareNames: [...new Set(shareNames)],
  };
  return { hosts, credentials: { username, password: input.password, domain }, options };
}

export function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s\uFEFF]*[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function createApp({ manager = new ScanManager(), platform = process.platform } = {}) {
  const token = randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
    const host = req.headers.host || '';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)); };
    try {
      if (!allowedHosts.has(host)) throw fail(403, 'Use the local app address shown in the terminal.');
      if (req.headers.origin && req.headers.origin !== `http://${host}`) throw fail(403, 'Cross-origin requests are not allowed.');
      if (req.headers['sec-fetch-site'] === 'cross-site') throw fail(403, 'Cross-site requests are not allowed.');
      const url = new URL(req.url, `http://${host}`);
      const path = url.pathname;
      if (path.startsWith('/api/')) {
        if (req.method === 'GET' && path === '/api/session') {
          return json(200, { token, platform, version: '1.3.0', limits: { maxHosts: null }, activeJob: manager.snapshot() });
        }
        const provided = Buffer.from(String(req.headers['x-scanner-token'] || ''));
        const expected = Buffer.from(token);
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw fail(403, 'App session expired. Reload this page.');
        if (req.method === 'POST' && path === '/api/targets') {
          const body = await readJson(req);
          const hosts = createTargetPlan(body.targets);
          const hostsCount = hosts.count <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(hosts.count) : hosts.count.toString();
          return json(200, { hostsCount, preview: hosts.preview() });
        }
        if (req.method === 'POST' && path === '/api/scans') {
          if (platform !== 'win32') throw fail(400, 'Real SMB scanning requires Windows. The UI demo works on any platform.');
          if (manager.busy) throw fail(409, 'A scan is already running.');
          const input = validateScan(await readJson(req));
          // Another request may have started a scan while this body was arriving.
          if (manager.busy) throw fail(409, 'A scan is already running.');
          return json(202, { job: manager.start(input.hosts, input.credentials, input.options) });
        }
        if (req.method === 'GET' && path === '/api/scans/current') return json(200, { job: manager.snapshot() });
        const match = /^\/api\/scans\/([0-9a-f-]+)(?:\/(cancel|export))?$/.exec(path);
        if (match) {
          if (!manager.job || manager.job.id !== match[1]) throw fail(404, 'Scan not found.');
          if (req.method === 'POST' && match[2] === 'cancel') return json(200, { job: manager.cancel() });
          if (req.method === 'DELETE' && !match[2]) {
            if (manager.busy) throw fail(409, 'Cancel the running scan before clearing it.');
            manager.clear();
            return json(200, { job: null });
          }
          if (req.method === 'GET') {
            const entries = queryEntries(manager.entries, url.searchParams);
            const hostOffset = Math.max(0, Number.parseInt(url.searchParams.get('hostOffset') || '0', 10) || 0);
            const hostLimit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get('hostLimit') || '200', 10) || 200));
            const job = manager.snapshot({ hostOffset, hostLimit });
            if (match[2] === 'export') {
              const format = url.searchParams.get('format') || 'csv';
              if (!['csv', 'json'].includes(format)) throw fail(400, 'Export format must be csv or json.');
              res.setHeader('Content-Disposition', `attachment; filename="smb-atlas-${job.id}.${format}"`);
              if (format === 'json') return json(200, { job: manager.snapshot({ hostLimit: Infinity }), total: entries.length, entries, stats: inventoryStats(entries) });
              res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8' });
              const fields = ['host', 'share', 'path', 'name', 'kind', 'size', 'modified', 'extension'];
              // UTF-8 BOM makes Windows Excel preserve non-ASCII filenames.
              res.write('\uFEFF' + fields.map(csvCell).join(',') + '\r\n');
              for (const entry of entries) {
                if (!res.write(fields.map(field => csvCell(entry[field])).join(',') + '\r\n')) {
                  await new Promise(resolve => {
                    const finish = () => {
                      res.removeListener('drain', finish);
                      res.removeListener('close', finish);
                      resolve();
                    };
                    res.once('drain', finish);
                    res.once('close', finish);
                  });
                  if (res.destroyed) return;
                }
              }
              return res.end();
            }
            if (match[2]) throw fail(405, 'Method not allowed.');
            const offset = Math.max(0, Number.parseInt(url.searchParams.get('offset') || '0', 10) || 0);
            const limit = Math.min(200, Math.max(1, Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100));
            const facets = {
              hosts: [...new Set(manager.entries.map(e => e.host))].sort(),
              shares: [...new Set(manager.entries.map(e => e.share))].sort(),
              extensions: [...new Set(manager.entries.filter(e => e.kind !== 'folder').map(e => fileExtension(e) || '__none__'))].sort(),
            };
            return json(200, { job, entries: entries.slice(offset, offset + limit), total: entries.length, facets, stats: inventoryStats(entries) });
          }
        }
        throw fail(404, 'API route not found.');
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw fail(405, 'Method not allowed.');
      if (path === '/favicon.ico') { res.writeHead(204); return res.end(); }
      const asset = assets.get(path);
      if (!asset) throw fail(404, 'Page not found.');
      const content = await readFile(publicPath + asset[0]);
      res.writeHead(200, { 'Content-Type': asset[1] });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = error.status || (error.name === 'TargetValidationError' ? 400 : 500);
      json(status, { error: status === 500 ? 'The app encountered an unexpected error.' : error.message });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return { server, manager };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error('PORT must be an integer from 1 to 65535.'); process.exit(1); }
  const { server, manager } = createApp();
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Close the other app or set PORT.` : 'Could not start the local app.'); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    console.log(`SMB Atlas is running at http://127.0.0.1:${port}`);
    console.log('Keep this terminal open. Press Ctrl+C to stop.');
  });
  const shutdown = () => {
    manager.cancel();
    server.close();
    server.closeAllConnections();
    manager.wait().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
