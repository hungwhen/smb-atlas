import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createApp, validateScan, csvCell } from '../server.mjs';
import { ScanManager } from '../lib/scanner.mjs';

const payload = (patch = {}) => ({ targets: '192.0.2.1', username: 'audit-user-sensitive',
  password: 'password-sensitive-!42', domain: 'ORG-SENSITIVE', options: {}, ...patch });
const complete = async () => ({ status: 'complete' });

function openRequest(server, path, { method = 'GET', headers = {} } = {}) {
  const req = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path, headers });
  const response = new Promise((resolve, reject) => {
    req.once('error', reject);
    req.once('response', res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, text,
          json: res.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null });
      });
    });
  });
  return { req, response };
}

async function request(server, path, { body, rawBody, headers = {}, ...options } = {}) {
  const data = rawBody ?? (body === undefined ? undefined : JSON.stringify(body));
  const call = openRequest(server, path, { ...options,
    headers: { ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } });
  call.req.end(data);
  return call.response;
}

async function fixture(t, { runner = complete, platform = 'win32' } = {}) {
  const manager = new ScanManager({ runner });
  const app = createApp({ manager, platform });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => {
    manager.cancel();
    await manager.wait();
    await new Promise(resolve => app.server.close(resolve));
  });
  const session = await request(app.server, '/api/session');
  assert.equal(session.status, 200);
  return { ...app, token: session.json.token,
    auth: { 'X-Scanner-Token': session.json.token } };
}

test('rejects DNS rebinding, cross-origin access and API calls without the session token', async t => {
  const { server, token, auth } = await fixture(t);
  const port = server.address().port;
  for (const headers of [
    { Host: `attacker.example:${port}` },
    { Origin: 'https://attacker.example' },
    { Origin: `http://localhost:${port}` },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const response = await request(server, '/api/session', { headers });
    assert.equal(response.status, 403);
    assert.equal(response.text.includes(token), false);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await request(server, '/api/session', { headers: { Origin: `http://127.0.0.1:${port}` } })).status, 200);
  assert.equal((await request(server, '/api/scans/current')).status, 403);
  assert.equal((await request(server, `/api/scans/current?token=${token}`)).status, 403);
  assert.equal((await request(server, '/api/scans/current', { headers: { 'X-Scanner-Token': 'wrong' } })).status, 403);
  assert.equal((await request(server, '/api/scans/current', { headers: auth })).status, 200);
});

test('target preview accepts uncapped subnets and rejects invalid syntax or encoding', async t => {
  const { server, auth } = await fixture(t);
  const preview = await request(server, '/api/targets', { method: 'POST', headers: auth,
    body: { targets: '192.0.2.0/30 2001:db8::1' } });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.json, { hostsCount: 3, preview: ['192.0.2.1', '192.0.2.2', '2001:db8::1'] });
  for (const targets of ['192.0.2.1 & whoami', '\\\\192.0.2.1\\Docs', 'host.example']) {
    const response = await request(server, '/api/targets', { method: 'POST', headers: auth, body: { targets } });
    assert.equal(response.status, 400, targets);
  }
  for (const [targets, count] of [['10.0.0.0/13', 524286], ['0.0.0.0/0', 4294967294], ['::/64', '18446744073709551616']]) {
    const response = await request(server, '/api/targets', { method: 'POST', headers: auth, body: { targets } });
    assert.equal(response.status, 200);
    assert.equal(response.json.hostsCount, count);
    assert.equal(response.json.preview.length, 12);
  }
  assert.equal((await request(server, '/api/targets', { method: 'POST', headers: auth, rawBody: '{bad' })).status, 400);
  assert.equal((await request(server, '/api/targets', { method: 'POST', headers: auth, body: [] })).status, 400);
  assert.equal((await request(server, '/api/targets', { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: {} })).status, 415);
});

test('large scans keep polling responses paginated and cancel queued targets without expanding them', async t => {
  let calls = 0;
  const { server, manager, auth } = await fixture(t, { runner: ({ signal, onState }) => new Promise(resolve => {
    calls++;
    onState('scanning');
    signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true });
  }) });
  const session = await request(server, '/api/session');
  assert.equal(session.json.limits.maxHosts, null);
  const started = await request(server, '/api/scans', { method: 'POST', headers: auth, body: payload({ targets: '10.0.0.0/13' }) });
  assert.equal(started.status, 202);
  assert.equal(started.json.job.targetsCount, 524286);
  assert.equal(started.json.job.hosts.length, 200);
  assert.equal(started.json.job.hostStatusCounts.scanning, 4);
  assert.equal(started.json.job.hostStatusCounts.queued, 524282);
  assert.ok(started.text.length < 50000);
  const id = started.json.job.id;
  const page = await request(server, `/api/scans/${id}?hostOffset=500000&hostLimit=100`, { headers: auth });
  assert.equal(page.json.job.hostsOffset, 500000);
  assert.equal(page.json.job.hostsTotal, 524286);
  assert.equal(page.json.job.hosts.length, 100);
  assert.equal(page.json.job.hosts[0].host, '10.7.161.33');
  await request(server, `/api/scans/${id}/cancel`, { method: 'POST', headers: auth });
  await manager.wait();
  assert.equal(calls, 4);
  const cancelled = await request(server, `/api/scans/${id}?hostOffset=524200`, { headers: auth });
  assert.equal(cancelled.json.job.hosts.length, 86);
  assert.equal(cancelled.json.job.hostStatusCounts.cancelled, 524286);
  assert.equal(cancelled.json.job.completedHosts, 524286);
  assert.equal(cancelled.json.job.hosts.every(host => host.status === 'cancelled'), true);
});

test('JSON exports retain all host outcomes beyond the displayed page', async t => {
  const { server, manager, auth } = await fixture(t);
  const started = await request(server, '/api/scans', { method: 'POST', headers: auth, body: payload({ targets: '10.0.0.0/23' }) });
  await manager.wait();
  const exported = await request(server, `/api/scans/${started.json.job.id}/export?format=json`, { headers: auth });
  assert.equal(exported.status, 200);
  assert.equal(exported.json.job.hosts.length, 510);
  assert.equal(exported.json.job.hostStatusCounts.completed, 510);
});

test('scan validation handles domain credentials and rejects invalid options before launching', () => {
  const normalized = validateScan(payload({ username: 'LAB\\reader', domain: 'lab' }));
  assert.deepEqual(normalized.credentials, { username: 'reader', password: 'password-sensitive-!42', domain: 'LAB' });
  assert.deepEqual(validateScan(payload({ username: 'reader@example.com', domain: '' })).credentials,
    { username: 'reader@example.com', password: 'password-sensitive-!42', domain: '' });
  for (const patch of [
    { username: '' }, { password: '' }, { username: 'LAB\\reader', domain: 'OTHER' },
    { username: 'reader@example.com', domain: 'LAB' }, { password: 'bad\npassword' },
    { options: [] }, { options: { concurrency: 17 } }, { options: { maxDepth: -1 } },
    { options: { timeoutSeconds: 601 } },
    { options: { includeHiddenShares: 'true' } }, { options: { shareNames: ['../Docs'] } },
    { options: { shareNames: ['Docs\\Subfolder'] } },
  ]) assert.throws(() => validateScan(payload(patch)), Error, JSON.stringify(patch));
  assert.equal(Object.hasOwn(validateScan(payload({ options: { maxEntries: 50000 } })).options, 'maxEntries'), false);
});

test('scan API collects and exposes entries beyond 50,000 even when an old browser sends the removed limit', async t => {
  let called = 0;
  const { server, manager, auth } = await fixture(t, { runner: async ({ host, options, onEvent }) => {
    called++;
    assert.equal(Object.hasOwn(options, 'maxEntries'), false);
    for (let index = 0; index < 25001; index++) onEvent({ type: 'entry', entry: {
      name: `file-${index}.txt`, path: `\\\\${host}\\Docs\\file-${index}.txt`, share: 'Docs', kind: 'file',
      size: 1, extension: '.txt', modified: null,
    } });
    return { status: 'complete' };
  } });
  const session = await request(server, '/api/session');
  assert.equal(session.json.limits.maxEntries, null);
  const started = await request(server, '/api/scans', { method: 'POST', headers: auth,
    body: payload({ targets: '192.0.2.0/30', options: { maxEntries: 50000 } }) });
  assert.equal(started.status, 202);
  await manager.wait();
  assert.equal(called, 2);
  const page = await request(server, `/api/scans/${started.json.job.id}?offset=50000&limit=50`, { headers: auth });
  assert.equal(page.json.job.status, 'completed');
  assert.equal(page.json.job.truncated, false);
  assert.equal(page.json.total, 50002);
  assert.equal(page.json.entries.length, 2);
  assert.equal(page.json.stats.filesCount, 50002);
});

test('oversized request bodies receive a bounded JSON error rather than a socket reset', async t => {
  const { server, auth } = await fixture(t);
  const response = await request(server, '/api/targets', { method: 'POST', headers: auth,
    body: { targets: '192.0.2.1', padding: 'x'.repeat(262144) } });
  assert.equal(response.status, 413);
  assert.match(response.json.error, /256 KiB/);
  assert.equal(response.text.includes('xxxxx'), false);
});

test('API snapshots and both export formats omit credentials and redact worker errors', async t => {
  const secretValues = Object.values(payload()).filter(value => typeof value === 'string' && value.includes('sensitive'));
  const { server, manager, auth } = await fixture(t, { runner: async ({ onEvent }) => {
    onEvent({ type: 'entry', entry: { name: '=HYPERLINK("bad")', path: '\\\\192.0.2.1\\Docs\\formula.txt',
      share: 'Docs', kind: 'file', size: 12, extension: '.txt', modified: '2026-01-01T00:00:00Z' } });
    onEvent({ type: 'warning', message: `Denied ${secretValues.join(' / ')}` });
    return { status: 'partial', error: `Worker rejected ${secretValues.join(' / ')}` };
  } });
  const started = await request(server, '/api/scans', { method: 'POST', headers: auth, body: payload() });
  assert.equal(started.status, 202);
  await manager.wait();
  const id = started.json.job.id;
  for (const path of ['/api/session', '/api/scans/current', `/api/scans/${id}`, `/api/scans/${id}/export?format=json`, `/api/scans/${id}/export?format=csv`]) {
    const response = await request(server, path, { headers: auth });
    assert.equal(response.status, 200, path);
    for (const value of secretValues) assert.equal(response.text.includes(value), false, `${path} leaked ${value}`);
    assert.equal(response.headers['cache-control'], 'no-store');
  }
  const csv = await request(server, `/api/scans/${id}/export`, { headers: auth });
  assert.ok(csv.text.startsWith('\uFEFF'));
  assert.ok(csv.text.includes('"\'=HYPERLINK(""bad"")"'));
  assert.match(csv.headers['content-disposition'], /attachment; filename=/);
});

test('filters and paginates the same inventory used for filtered exports', async t => {
  const { server, manager, auth } = await fixture(t, { runner: async ({ onEvent }) => {
    for (let index = 0; index < 225; index++) onEvent({ type: 'entry', entry: {
      name: `report${index}.txt`, path: `\\\\192.0.2.1\\Docs\\report${index}.txt`, share: 'Docs',
      kind: 'file', size: index, extension: '.txt', modified: '2026-01-01T00:00:00Z' } });
    onEvent({ type: 'entry', entry: { name: 'budget.csv', path: '\\\\192.0.2.1\\Finance\\budget.csv',
      share: 'Finance', kind: 'file', size: 500, extension: '.csv', modified: null } });
    return { status: 'complete' };
  } });
  const started = await request(server, '/api/scans', { method: 'POST', headers: auth, body: payload() });
  await manager.wait();
  const base = `/api/scans/${started.json.job.id}`;
  const page = await request(server, `${base}?share=Docs&extension=.txt&kind=file&host=192.0.2.1&sort=size&direction=desc&offset=1&limit=2`, { headers: auth });
  assert.equal(page.json.total, 225);
  assert.deepEqual(page.json.entries.map(row => row.size), [223, 222]);
  assert.equal(page.json.stats.filesCount, 225, 'statistics must include matches beyond the current page');
  assert.equal(page.json.stats.totalBytes, 225 * 224 / 2);
  assert.equal(page.json.stats.types[0].extension, '.txt');
  assert.equal(page.json.stats.types[0].averageBytes, 112);
  assert.equal(page.json.stats.types[0].largestBytes, 224);
  assert.deepEqual(page.json.facets.shares, ['Docs', 'Finance']);
  assert.equal((await request(server, `${base}?limit=999`, { headers: auth })).json.entries.length, 200);
  const filtered = await request(server, `${base}/export?format=json&q=BUDGET&share=Finance`, { headers: auth });
  assert.equal(filtered.json.total, 1);
  assert.equal(filtered.json.entries[0].name, 'budget.csv');
  assert.equal(filtered.json.stats.filesCount, 1);
  assert.equal(filtered.json.stats.totalBytes, 500);
  const noMatches = await request(server, `${base}?share=Missing`, { headers: auth });
  assert.equal(noMatches.json.total, 0);
  assert.equal(noMatches.json.stats.filesCount, 0);
  assert.equal(noMatches.json.stats.sizeBuckets.length, 6);
  const exported = await request(server, `${base}/export?format=json&share=Docs&extension=.txt&kind=file&host=192.0.2.1`, { headers: auth });
  assert.deepEqual(exported.json.stats, page.json.stats);
  assert.equal((await request(server, `${base}/export?format=exe`, { headers: auth })).status, 400);
  assert.equal((await request(server, `/api/scans/00000000-0000-0000-0000-000000000000`, { headers: auth })).status, 404);
});

test('filetype facets and filters normalize extensions and expose extensionless files without folders', async t => {
  const { server, manager, auth } = await fixture(t, { runner: async ({ onEvent }) => {
    for (const entry of [
      { name: 'report.PDF', extension: '.PDF', size: 40 },
      { name: 'other.pdf', extension: 'pdf', size: 60 },
      { name: 'notes.TXT', size: 10 },
      { name: 'README', extension: '', size: 0 },
      { name: 'Folder', extension: '', size: null, kind: 'folder' },
    ]) onEvent({ type: 'entry', entry: { path: `\\\\192.0.2.1\\Docs\\${entry.name}`, share: 'Docs', kind: 'file', ...entry } });
    return { status: 'complete' };
  } });
  const started = await request(server, '/api/scans', { method: 'POST', headers: auth, body: payload() });
  await manager.wait();
  const base = `/api/scans/${started.json.job.id}`;
  const all = await request(server, `${base}?sort=extension&limit=1`, { headers: auth });
  assert.deepEqual(all.json.facets.extensions, ['.pdf', '.txt', '__none__']);
  assert.equal(all.json.stats.filesCount, 4);
  assert.equal(all.json.stats.totalBytes, 110);
  assert.equal(all.json.stats.typeCount, 3);
  const pdfs = await request(server, `${base}?extension=.pDf&sort=size&direction=desc`, { headers: auth });
  assert.deepEqual(pdfs.json.entries.map(row => row.name), ['other.pdf', 'report.PDF']);
  assert.equal(pdfs.json.stats.filesCount, 2);
  assert.equal(pdfs.json.stats.totalBytes, 100);
  const extensionless = await request(server, `${base}?extension=__none__`, { headers: auth });
  assert.deepEqual(extensionless.json.entries.map(row => row.name), ['README']);
  assert.equal(extensionless.json.stats.types[0].extension, '');
});

test('concurrent scan requests return a conflict even when both headers arrived before either body', async t => {
  const { server, manager, auth } = await fixture(t, { runner: ({ signal }) => new Promise(resolve => {
    signal.addEventListener('abort', () => resolve({ status: 'cancelled' }), { once: true });
  }) });
  const options = { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' } };
  const firstSeen = once(server, 'request');
  const first = openRequest(server, '/api/scans', options);
  first.req.flushHeaders();
  await firstSeen;
  const secondSeen = once(server, 'request');
  const second = openRequest(server, '/api/scans', options);
  second.req.flushHeaders();
  await secondSeen;
  first.req.end(JSON.stringify(payload()));
  assert.equal((await first.response).status, 202);
  second.req.end(JSON.stringify(payload()));
  assert.equal((await second.response).status, 409);
  const id = manager.snapshot().id;
  assert.equal((await request(server, `/api/scans/${id}`, { method: 'DELETE', headers: auth })).status, 409);
  assert.equal((await request(server, `/api/scans/${id}/cancel`, { method: 'POST', headers: auth })).status, 200);
  await manager.wait();
  assert.equal((await request(server, `/api/scans/${id}`, { method: 'DELETE', headers: auth })).status, 200);
  assert.equal(manager.snapshot(), null);
});

test('large CSV exports stream all rows without retaining a close listener for every drain', async t => {
  const { server, manager, auth } = await fixture(t, { runner: async ({ onEvent }) => {
    for (let index = 0; index < 256; index++) onEvent({ type: 'entry', entry: {
      name: `report${index}.txt`, path: `\\\\192.0.2.1\\Docs\\${'x'.repeat(8192)}${index}.txt`, share: 'Docs',
      kind: 'file', size: index, extension: '.txt', modified: null } });
    return { status: 'complete' };
  } });
  const started = await request(server, '/api/scans', { method: 'POST', headers: auth, body: payload() });
  await manager.wait();
  const path = `/api/scans/${started.json.job.id}/export`;
  let retainedCloseListeners;
  server.on('request', (req, res) => {
    if (req.url === path) res.once('finish', () => { retainedCloseListeners = res.listenerCount('close'); });
  });
  const response = await request(server, path, { headers: auth });
  assert.equal(response.status, 200);
  assert.equal(response.text.split('\r\n').length, 258);
  assert.ok(response.text.includes('report255.txt'));
  assert.ok(retainedCloseListeners <= 1, `Retained ${retainedCloseListeners} close listeners`);
});

test('CSV cells escape quotes, line breaks and spreadsheet formulas', () => {
  assert.equal(csvCell('plain "quoted" name'), '"plain ""quoted"" name"');
  for (const value of ['=1+1', '+SUM(A1)', '-1+2', '@SUM(A1)', '  =cmd()', '\t=cmd()', '\r=cmd()', '\n=cmd()', '\uFEFF=cmd()']) {
    assert.ok(csvCell(value).startsWith('"\''), value);
  }
  assert.equal(csvCell(null), '""');
  assert.equal(csvCell(42), '"42"');
});
