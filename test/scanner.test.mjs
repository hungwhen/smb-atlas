import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { ScanManager } from '../lib/scanner.mjs';

const defaults = { maxDepth: 8, concurrency: 2, timeoutSeconds: 90,
  includeHiddenShares: false, includeFolders: false, shareNames: [] };
const identity = () => ({ username: 'audit-user-sensitive', domain: 'ORG-SENSITIVE', password: 'password-sensitive-!42' });
const hosts = count => Array.from({ length: count }, (_, index) => `192.0.2.${index + 1}`);
const entry = (name, size = 10, kind = 'file') => ({ share: 'Docs', path: `\\\\192.0.2.1\\Docs\\${name}`,
  name, size, kind, modified: '2026-01-01T00:00:00Z', extension: kind === 'file' ? '.txt' : '' });

function controlledRunner() {
  const calls = [];
  let active = 0;
  let peak = 0;
  const runner = input => new Promise(resolve => {
    active++;
    peak = Math.max(peak, active);
    let finished = false;
    const call = { ...input, complete(outcome = { status: 'complete' }) {
      if (finished) return;
      finished = true;
      active--;
      input.signal.removeEventListener('abort', abort);
      resolve(outcome);
    } };
    const abort = () => call.complete({ status: 'cancelled' });
    calls.push(call);
    input.signal.addEventListener('abort', abort, { once: true });
    input.onState('scanning');
    if (input.signal.aborted) abort();
  });
  return { runner, calls, get active() { return active; }, get peak() { return peak; } };
}

test('limits simultaneous workers, continues queued hosts, and releases credential fields', async () => {
  const fake = controlledRunner();
  const manager = new ScanManager({ runner: fake.runner });
  const credentials = identity();
  const firstSnapshot = manager.start(hosts(5), credentials, { ...defaults });
  assert.equal(fake.calls.length, 2);
  assert.equal(fake.active, 2);
  firstSnapshot.hosts[0].host = 'mutated';
  assert.equal(manager.snapshot().hosts[0].host, '192.0.2.1');
  assert.throws(() => manager.start(hosts(1), identity(), defaults), /already running/);
  for (let index = 0; index < 5; index++) {
    assert.ok(fake.calls[index], `host ${index + 1} was scheduled`);
    fake.calls[index].complete();
    await nextTurn();
    assert.ok(fake.active <= 2);
  }
  await manager.wait();
  const job = manager.snapshot();
  assert.equal(job.status, 'completed');
  assert.equal(job.completedHosts, 5);
  assert.equal(fake.peak, 2);
  assert.equal(fake.active, 0);
  assert.ok(job.finishedAt);
  assert.deepEqual(credentials, { username: '', password: '', domain: '' });
  assert.equal(JSON.stringify(job).includes('sensitive'), false);
});

test('cancellation aborts active workers, skips the queue, and allows clearing the inventory', async () => {
  const fake = controlledRunner();
  const manager = new ScanManager({ runner: fake.runner });
  manager.start(hosts(6), identity(), { ...defaults });
  assert.throws(() => manager.clear(), /Cancel/);
  assert.equal(manager.cancel().status, 'cancelling');
  fake.calls[0].onEvent({ type: 'entry', entry: entry('late.txt') });
  await manager.wait();
  const job = manager.snapshot();
  assert.equal(fake.calls.length, 2);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.completedHosts, 6);
  assert.equal(job.hosts.every(row => row.status === 'cancelled'), true);
  assert.equal(manager.entries.length, 0);
  assert.equal(manager.busy, false);
  manager.clear();
  assert.equal(manager.snapshot(), null);
  assert.deepEqual(manager.entries, []);
});

test('the supported 16-worker configuration shares one cancellation signal safely', async () => {
  const fake = controlledRunner();
  const manager = new ScanManager({ runner: fake.runner });
  const warnings = [];
  const observe = warning => warnings.push(warning);
  process.on('warning', observe);
  try {
    manager.start(hosts(17), identity(), { ...defaults, concurrency: 16 });
    assert.equal(fake.calls.length, 16);
    manager.cancel();
    await manager.wait();
    await nextTurn();
    assert.equal(warnings.some(warning => warning.name === 'MaxListenersExceededWarning'), false);
    assert.equal(fake.active, 0);
    assert.equal(fake.calls.length, 16);
  } finally {
    process.removeListener('warning', observe);
  }
});

test('collects beyond 50,000 entries and continues the host queue even with a legacy entry limit', async () => {
  const fake = controlledRunner();
  const manager = new ScanManager({ runner: fake.runner });
  manager.start(hosts(4), identity(), { ...defaults, maxEntries: 3 });
  for (let index = 0; index < 50001; index++) fake.calls[0].onEvent({ type: 'entry', entry: entry(`file-${index}.txt`, 1) });
  fake.calls[1].onEvent({ type: 'entry', entry: entry('folder', 0, 'folder') });
  assert.equal(fake.active, 2);
  for (let index = 0; index < 4; index++) {
    assert.ok(fake.calls[index], `host ${index + 1} was scheduled`);
    fake.calls[index].complete();
    await nextTurn();
  }
  await manager.wait();
  const job = manager.snapshot();
  assert.equal(job.status, 'completed');
  assert.equal(job.truncated, false);
  assert.equal(job.entriesCount, 50002);
  assert.equal(job.filesCount, 50001);
  assert.equal(job.foldersCount, 1);
  assert.equal(job.totalBytes, 50001);
  assert.equal(fake.calls.length, 4);
  assert.equal(manager.entries.length, 50002);
  assert.equal(manager.entries[50000].name, 'file-50000.txt');
  assert.equal(job.errors.length, 0);
});

test('keeps partial file results, deduplicates shares, and redacts worker diagnostics', async () => {
  const secret = identity();
  const values = Object.values(secret);
  const manager = new ScanManager({ runner: async ({ host, onEvent }) => {
    if (host.endsWith('.1')) {
      onEvent({ type: 'share', share: 'Docs' });
      onEvent({ type: 'share', share: 'Docs' });
      onEvent({ type: 'entry', entry: entry('report.txt', 42) });
      onEvent({ type: 'entry', entry: entry('Reports', 0, 'folder') });
      onEvent({ type: 'warning', message: `Access refused to ${values.join(' / ')}` });
      return { status: 'partial', error: `Worker refused ${values.join(' / ')}` };
    }
    if (host.endsWith('.2')) return { status: 'unreachable', error: 'No TCP 445 response.' };
    throw new Error(values.join(' / '));
  } });
  manager.start(hosts(3), secret, { ...defaults });
  await manager.wait();
  const job = manager.snapshot();
  assert.equal(job.status, 'partial');
  assert.equal(job.sharesCount, 1);
  assert.equal(job.filesCount, 1);
  assert.equal(job.foldersCount, 1);
  assert.equal(job.totalBytes, 42);
  assert.deepEqual(job.hosts.map(row => row.status), ['partial', 'unreachable', 'failed']);
  for (const value of values) assert.equal(JSON.stringify(job).includes(value), false);
  assert.match(job.hosts[0].error, /\[redacted\]/);
  assert.match(job.hosts[2].error, /unexpected error/);
});

test('authentication rejection in an event aborts workers and leaves queued hosts untouched', async () => {
  const fake = controlledRunner();
  const manager = new ScanManager({ runner: fake.runner });
  manager.start(hosts(8), identity(), { ...defaults });
  fake.calls[0].onEvent({ type: 'warning', message: 'Account rejected.', authFailure: true });
  await manager.wait();
  const job = manager.snapshot();
  assert.equal(fake.calls.length, 2);
  assert.equal(job.status, 'partial');
  assert.equal(job.completedHosts, 8);
  assert.equal(job.hosts.slice(2).every(row => row.status === 'cancelled'), true);
  assert.ok(job.errors.some(error => /credential or account rejection/.test(error.message)));
});

test('authentication rejection in a completion record also stops queued hosts', async () => {
  const visited = [];
  const manager = new ScanManager({ runner: async ({ host }) => {
    visited.push(host);
    return { status: 'error', error: 'Credentials rejected.', authFailure: true };
  } });
  manager.start(hosts(8), identity(), { ...defaults, concurrency: 1 });
  await manager.wait();
  assert.deepEqual(visited, ['192.0.2.1']);
  assert.equal(manager.snapshot().status, 'partial');
});

test('bounds diagnostics memory and records omitted errors', async () => {
  const manager = new ScanManager({ runner: async ({ onEvent }) => {
    for (let index = 0; index < 2005; index++) onEvent({ type: 'warning', message: `Unreadable directory ${index}.` });
    return { status: 'complete' };
  } });
  manager.start(hosts(1), identity(), { ...defaults });
  await manager.wait();
  assert.equal(manager.snapshot().errors.length, 2000);
  assert.equal(manager.snapshot().omittedErrors, 5);
  assert.equal(manager.snapshot().status, 'partial');
});
