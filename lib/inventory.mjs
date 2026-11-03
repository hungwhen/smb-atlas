import { win32 } from 'node:path';

const MiB = 1024 ** 2;
const GiB = 1024 ** 3;
const sizeBuckets = [
  { id: 'empty', label: 'Empty (0 B)', minBytes: 0, maxBytes: 0 },
  { id: 'under1mb', label: 'Under 1 MiB', minBytes: 1, maxBytes: MiB },
  { id: '1to10mb', label: '1–10 MiB', minBytes: MiB, maxBytes: 10 * MiB },
  { id: '10to100mb', label: '10–100 MiB', minBytes: 10 * MiB, maxBytes: 100 * MiB },
  { id: '100mbto1gb', label: '100 MiB–1 GiB', minBytes: 100 * MiB, maxBytes: GiB },
  { id: '1gbplus', label: '1 GiB and above', minBytes: GiB, maxBytes: null },
];

export function normalizeExtension(extension) {
  const text = String(extension ?? '').trim().toLowerCase();
  if (!text || text === '.') return '';
  return text.startsWith('.') ? text : `.${text}`;
}

export function fileExtension(entry) {
  // The Windows worker supplies an explicit empty string for extensionless files.
  return normalizeExtension(entry.extension ?? win32.extname(entry.name || entry.path || ''));
}

const compareText = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), undefined, { numeric: true, sensitivity: 'base' });
const fileSize = entry => Number.isFinite(Number(entry.size)) ? Math.max(0, Number(entry.size)) : 0;

export function queryEntries(entries, params) {
  const q = (params.get('q') || '').slice(0, 512).toLowerCase();
  const host = params.get('host'), share = params.get('share'), extension = params.get('extension'), kind = params.get('kind');
  const extensionFilter = extension === '__none__' ? '' : normalizeExtension(extension);
  const filtered = entries.filter(e => (!q || `${e.path} ${e.name} ${e.host} ${e.share}`.toLowerCase().includes(q))
    && (!host || e.host === host) && (!share || e.share === share)
    && (!extension || (e.kind !== 'folder' && fileExtension(e) === extensionFilter))
    && (!kind || e.kind === kind));
  const field = ['name', 'size', 'extension', 'modified', 'host', 'share', 'path'].includes(params.get('sort')) ? params.get('sort') : 'path';
  const sign = params.get('direction') === 'desc' ? -1 : 1;
  filtered.sort((a, b) => {
    let order;
    if (field === 'size') order = fileSize(a) - fileSize(b);
    else if (field === 'extension') order = compareText(fileExtension(a), fileExtension(b));
    else order = compareText(a[field], b[field]);
    return sign * (order || compareText(a.name, b.name) || compareText(a.path, b.path));
  });
  return filtered;
}

// The caller passes the complete filtered inventory, before slicing a result page.
export function inventoryStats(entries) {
  const types = new Map();
  const hostGroups = new Map();
  const buckets = sizeBuckets.map(bucket => ({ ...bucket, filesCount: 0, totalBytes: 0, percentFiles: 0 }));
  let filesCount = 0, totalBytes = 0, shareCount = 0;
  for (const entry of entries) {
    if (entry.kind === 'folder') continue;
    const bytes = fileSize(entry);
    const extension = fileExtension(entry);
    let type = types.get(extension);
    if (!type) {
      type = { extension, filesCount: 0, totalBytes: 0, averageBytes: 0, largestBytes: 0, percentBytes: 0 };
      types.set(extension, type);
    }
    type.filesCount++;
    type.totalBytes += bytes;
    type.largestBytes = Math.max(type.largestBytes, bytes);
    const hostName = String(entry.host ?? '');
    const shareName = String(entry.share ?? '');
    let host = hostGroups.get(hostName);
    if (!host) {
      host = { host: hostName, filesCount: 0, totalBytes: 0, shares: new Map() };
      hostGroups.set(hostName, host);
    }
    let share = host.shares.get(shareName);
    if (!share) {
      share = { share: shareName, filesCount: 0, totalBytes: 0 };
      host.shares.set(shareName, share);
      shareCount++;
    }
    host.filesCount++;
    host.totalBytes += bytes;
    share.filesCount++;
    share.totalBytes += bytes;
    const bucket = bytes === 0 ? buckets[0] : buckets.find(bucket => bucket.id !== 'empty' && (bucket.maxBytes === null || bytes < bucket.maxBytes));
    bucket.filesCount++;
    bucket.totalBytes += bytes;
    filesCount++;
    totalBytes += bytes;
  }
  const typeRows = [...types.values()];
  for (const type of typeRows) {
    type.averageBytes = type.totalBytes / type.filesCount;
    type.percentBytes = totalBytes ? type.totalBytes / totalBytes * 100 : 0;
  }
  for (const bucket of buckets) bucket.percentFiles = filesCount ? bucket.filesCount / filesCount * 100 : 0;
  typeRows.sort((a, b) => b.totalBytes - a.totalBytes || compareText(a.extension, b.extension));
  const hosts = [...hostGroups.values()].map(host => {
    const shares = [...host.shares.values()].sort((a, b) => b.totalBytes - a.totalBytes || compareText(a.share, b.share));
    const otherShares = { sharesCount: 0, filesCount: 0, totalBytes: 0 };
    for (const share of shares.slice(6)) {
      otherShares.sharesCount++;
      otherShares.filesCount += share.filesCount;
      otherShares.totalBytes += share.totalBytes;
    }
    return { host: host.host, filesCount: host.filesCount, totalBytes: host.totalBytes,
      sharesCount: shares.length, shares: shares.slice(0, 6), otherShares };
  }).sort((a, b) => b.totalBytes - a.totalBytes || compareText(a.host, b.host));
  return { filesCount, totalBytes, typeCount: typeRows.length, types: typeRows, sizeBuckets: buckets,
    hostCount: hosts.length, shareCount, hosts };
}
