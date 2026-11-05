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
  const text = String(extension ?? '').trim().toLowerCase().replace(/^\*\./, '.');
  if (!text || text === '.') return '';
  return text.startsWith('.') ? text : `.${text}`;
}

export function fileExtension(entry) {
  // The Windows worker supplies an explicit empty string for extensionless files.
  return normalizeExtension(entry.extension ?? win32.extname(entry.name || entry.path || ''));
}

// Reusing the collator avoids creating locale/options machinery for every
// comparison when sorting a large inventory.
const textCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const compareText = (a, b) => textCollator.compare(String(a ?? ''), String(b ?? ''));
const fileSize = entry => Number.isFinite(Number(entry.size)) ? Math.max(0, Number(entry.size)) : 0;
const searchFields = ['path', 'name', 'host', 'share'];

function omittedShares(shares) {
  const other = { sharesCount: 0, filesCount: 0, totalBytes: 0 };
  for (let index = 6; index < shares.length; index++) {
    other.sharesCount++;
    other.filesCount += shares[index].filesCount;
    other.totalBytes += shares[index].totalBytes;
  }
  return other;
}

export function queryEntries(entries, params) {
  const q = (params.get('q') || '').slice(0, 512).trim().toLowerCase();
  const host = params.get('host'), share = params.get('share'), kind = params.get('kind');
  const extension = (params.get('extension') || '').trim().toLowerCase();
  const extensionFilter = ['__none__', 'no extension'].includes(extension) ? '' : normalizeExtension(extension);
  const searchNoExtension = ['__none__', 'no extension'].includes(q);
  const searchExtension = /^\*\.[^\\/\s*?]+$/.test(q) ? normalizeExtension(q) : null;
  const field = ['name', 'size', 'extension', 'modified', 'host', 'share', 'path'].includes(params.get('sort')) ? params.get('sort') : 'path';
  const sign = params.get('direction') === 'desc' ? -1 : 1;
  const filtered = [];
  for (const entry of entries) {
    if ((host && entry.host !== host) || (share && entry.share !== share) || (kind && entry.kind !== kind)) continue;
    const isFile = entry.kind !== 'folder';
    // Compute normalized metadata once per row, rather than once per sort
    // comparison. An explicit empty extension remains meaningful metadata.
    const entryExtension = extension || q || field === 'extension' ? fileExtension(entry) : '';
    if (extension && (!isFile || entryExtension !== extensionFilter)) continue;
    if (q) {
      if (searchNoExtension) {
        if (!isFile || entryExtension !== '') continue;
      } else if (searchExtension !== null) {
        if (!isFile || entryExtension !== searchExtension) continue;
      } else if (!(isFile && entryExtension.includes(q))
        && !searchFields.some(key => String(entry[key] ?? '').toLowerCase().includes(q))) continue;
    }
    filtered.push({ entry,
      key: field === 'size' ? fileSize(entry) : field === 'extension' ? entryExtension : String(entry[field] ?? ''),
      name: String(entry.name ?? ''), path: String(entry.path ?? '') });
  }
  filtered.sort((a, b) => {
    const order = field === 'size' ? a.key - b.key : compareText(a.key, b.key);
    return sign * (order || compareText(a.name, b.name) || compareText(a.path, b.path));
  });
  return filtered.map(row => row.entry);
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
    const sharesByFiles = [...shares].sort((a, b) => b.filesCount - a.filesCount || b.totalBytes - a.totalBytes || compareText(a.share, b.share));
    return { host: host.host, filesCount: host.filesCount, totalBytes: host.totalBytes,
      sharesCount: shares.length, shares: shares.slice(0, 6), otherShares: omittedShares(shares),
      sharesByFiles: sharesByFiles.slice(0, 6), otherSharesByFiles: omittedShares(sharesByFiles) };
  }).sort((a, b) => b.totalBytes - a.totalBytes || compareText(a.host, b.host));
  return { filesCount, totalBytes, typeCount: typeRows.length, types: typeRows, sizeBuckets: buckets,
    hostCount: hosts.length, shareCount, hosts };
}
