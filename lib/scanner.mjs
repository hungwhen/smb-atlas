import net from 'node:net';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setMaxListeners } from 'node:events';

const workerPath = fileURLToPath(new URL('../scripts/scan-host.ps1', import.meta.url));
const terminal = new Set(['completed', 'partial', 'failed', 'unreachable', 'cancelled']);

export function probeHost(host, signal, timeout = 3000) {
  return new Promise(resolve => {
    if (signal?.aborted) return resolve(false);
    const socket = net.createConnection({ host, port: 445 });
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', abort);
      socket.destroy();
      resolve(value);
    };
    const abort = () => done(false);
    socket.setTimeout(timeout, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    signal?.addEventListener('abort', abort, { once: true });
  });
}

// Passwords travel over the child's stdin, never through command arguments.
export async function runWindowsHost({ host, credentials, options, signal, onEvent, onState }) {
  if (process.platform !== 'win32') return { status: 'error', error: 'Scanning requires Windows.' };
  onState('probing');
  if (!await probeHost(host, signal)) {
    return signal.aborted ? { status: 'cancelled' } : { status: 'unreachable', error: 'TCP 445 did not respond within 3 seconds.' };
  }
  if (signal.aborted) return { status: 'cancelled' };
  onState('scanning');
  return new Promise(resolve => {
    const windowsRoot = process.env.SystemRoot || 'C:\\Windows';
    const child = spawn(`${windowsRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', workerPath],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let result = null;
    let stopping = false;
    let timedOut = false;
    let protocolFailure = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      // This worker never launches descendants. Terminate only this owned process.
      child.kill();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutSeconds * 1000);
    signal.addEventListener('abort', stop, { once: true });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      if (!line.trim() || stopping) return;
      if (line.length > 131072) { protocolFailure = true; stop(); return; }
      try {
        const event = JSON.parse(line.replace(/^\uFEFF/, ''));
        if (event.type === 'done') result = event;
        else onEvent(event);
      } catch { protocolFailure = true; stop(); }
    });
    // Never forward raw PowerShell diagnostics: they may contain request values.
    child.stderr.on('data', () => {});
    child.stdin.on('error', () => {});
    child.once('error', () => { result = { status: 'error', error: 'Could not start the Windows scan worker.' }; });
    child.once('close', code => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
      lines.close();
      if (signal.aborted) resolve({ status: 'cancelled' });
      else if (timedOut) resolve({ status: 'partial', error: `Host reached the ${options.timeoutSeconds}s time limit. Results may be incomplete.` });
      else if (protocolFailure) resolve({ status: 'error', error: 'The scan worker returned invalid output.' });
      else resolve(result || { status: 'error', error: `The scan worker ended without a completion record (exit ${code}).` });
    });
    if (signal.aborted) stop();
    child.stdin.end(JSON.stringify({ host, ...credentials, options }));
  });
}

export class ScanManager {
  #job = null;
  #abort = null;
  #runner;
  #entries = [];
  #targets = null;
  #hostRows = new Map();
  #unstartedStatus = 'queued';
  #completion = Promise.resolve();
  constructor({ runner = runWindowsHost } = {}) { this.#runner = runner; }
  get entries() { return this.#entries; }
  get job() { return this.#job; }
  get busy() { return !!this.#job && ['running', 'cancelling'].includes(this.#job.status); }
  wait() { return this.#completion; }
  snapshot({ hostOffset = 0, hostLimit = 200 } = {}) {
    if (!this.#job) return null;
    const total = this.#job.targetsCount;
    const offset = Number.isSafeInteger(hostOffset) ? Math.max(0, Math.min(hostOffset, Math.max(0, total - 1))) : 0;
    const limit = hostLimit === Infinity ? total : Number.isSafeInteger(hostLimit) ? Math.max(1, hostLimit) : 200;
    const hosts = Array.from({ length: Math.min(limit, total - offset) }, (_, index) => {
      const position = offset + index;
      return this.#hostRows.get(position) || { host: this.#targets.at(position), status: this.#unstartedStatus, files: 0, shares: 0 };
    });
    return structuredClone({ ...this.#job, hosts, hostsOffset: offset, hostsLimit: limit, hostsTotal: total });
  }
  start(hosts, credentials, options) {
    if (this.busy) throw new Error('A scan is already running.');
    this.#entries = [];
    this.#targets = hosts;
    this.#hostRows = new Map();
    this.#unstartedStatus = 'queued';
    const job = this.#job = {
      id: randomUUID(), status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
      targetsCount: hosts.length, completedHosts: 0, filesCount: 0, foldersCount: 0,
      sharesCount: 0, totalBytes: 0, entriesCount: 0, truncated: false,
      options: { ...options }, errors: [], omittedErrors: 0,
      hostStatusCounts: { queued: hosts.length, probing: 0, scanning: 0, completed: 0, partial: 0, failed: 0, unreachable: 0, cancelled: 0 },
    };
    const abort = this.#abort = new AbortController();
    // Up to 16 owned workers legitimately subscribe to the same cancellation signal.
    setMaxListeners(0, abort.signal);
    const shares = new Set();
    let next = 0;
    let authFailed = false;
    const setState = (row, status) => {
      job.hostStatusCounts[row.status]--;
      job.hostStatusCounts[status] = (job.hostStatusCounts[status] || 0) + 1;
      row.status = status;
    };
    const addError = (host, message, share) => {
      // Defense in depth if a Windows diagnostic echoes the submitted identity.
      let clean = String(message || 'Unknown scan error').slice(0, 2000);
      for (const secret of [credentials.password, credentials.username, credentials.domain]) {
        if (secret) clean = clean.split(secret).join('[redacted]');
      }
      if (job.errors.length < 2000) job.errors.push({ host, ...(share ? { share } : {}), message: clean });
      else job.omittedErrors++;
      return clean;
    };
    const consume = async () => {
      while (!abort.signal.aborted && next < job.targetsCount) {
        const index = next++;
        const row = { host: hosts.at(index), status: 'queued', files: 0, shares: 0 };
        this.#hostRows.set(index, row);
        try {
          const outcome = await this.#runner({ host: row.host, credentials, options,
            signal: abort.signal, onState: state => { setState(row, state); },
            onEvent: event => {
              if (abort.signal.aborted) return;
              if (event.type === 'entry' && event.entry) {
                const entry = { ...event.entry, host: row.host };
                this.#entries.push(entry);
                job.entriesCount++;
                if (entry.kind === 'folder') job.foldersCount++;
                else { job.filesCount++; row.files++; job.totalBytes += Number(entry.size) || 0; }
              } else if (event.type === 'share') {
                const key = `${row.host}\0${event.share}`;
                if (!shares.has(key)) { shares.add(key); job.sharesCount++; row.shares++; }
                if (event.error) addError(row.host, event.error, event.share);
              } else if (event.type === 'warning') addError(row.host, event.message, event.share);
              if (event.authFailure) { authFailed = true; abort.abort(); }
            },
          });
          const status = ({ complete: 'completed', error: 'failed' })[outcome.status] || outcome.status;
          setState(row, terminal.has(status) ? status : 'failed');
          if (outcome.error) row.error = addError(row.host, outcome.error);
          if (outcome.authFailure) { authFailed = true; abort.abort(); }
        } catch {
          setState(row, 'failed');
          row.error = addError(row.host, 'The host worker encountered an unexpected error.');
        }
        job.completedHosts++;
      }
    };
    // Credentials live only in this task's closure and the worker process memory.
    this.#completion = Promise.all(Array.from({ length: Math.min(options.concurrency, hosts.length) }, consume))
      .finally(() => {
        for (const row of this.#hostRows.values()) {
          if (!terminal.has(row.status)) { setState(row, 'cancelled'); job.completedHosts++; }
        }
        const unstarted = job.targetsCount - next;
        job.hostStatusCounts.queued -= unstarted;
        job.hostStatusCounts.cancelled += unstarted;
        job.completedHosts += unstarted;
        this.#unstartedStatus = 'cancelled';
        if (authFailed) addError('', 'Scanning stopped after a credential or account rejection. Check the account before starting again.');
        job.status = job.truncated || authFailed ? 'partial'
          : abort.signal.aborted ? 'cancelled'
          : job.hostStatusCounts.failed + job.hostStatusCounts.unreachable === job.targetsCount ? 'failed'
          : job.hostStatusCounts.completed !== job.targetsCount || job.errors.length ? 'partial' : 'completed';
        job.finishedAt = new Date().toISOString();
        credentials.password = '';
        credentials.username = '';
        credentials.domain = '';
        this.#abort = null;
      });
    return this.snapshot();
  }
  cancel() {
    if (this.busy) { this.#job.status = 'cancelling'; this.#abort?.abort(); }
    return this.snapshot();
  }
  clear() {
    if (this.busy) throw new Error('Cancel the running scan before clearing it.');
    this.#entries = [];
    this.#job = null;
    this.#targets = null;
    this.#hostRows.clear();
  }
}
