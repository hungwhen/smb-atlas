import test from 'node:test';
import assert from 'node:assert/strict';
import { fileExtension, inventoryStats, queryEntries } from '../lib/inventory.mjs';

const file = (name, size, extension, extra = {}) => ({ name, size, extension, kind: 'file',
  path: `\\\\192.0.2.1\\Docs\\${name}`, host: '192.0.2.1', share: 'Docs', ...extra });
const MiB = 1024 ** 2, GiB = 1024 ** 3;

test('extension sorting normalizes case and the leading dot, with natural filenames for ties and extensionless files', () => {
  const entries = [file('README10', 20, ''), file('z.PDF', 100, '.PDF'), file('a.pdf', 3, 'pdf'),
    file('README2', 2, ''), file('data.csv', 10, '.csv')];
  const before = entries.slice();
  assert.deepEqual(queryEntries(entries, new URLSearchParams({ sort: 'extension' })).map(row => row.name),
    ['README2', 'README10', 'data.csv', 'a.pdf', 'z.PDF']);
  assert.deepEqual(queryEntries(entries, new URLSearchParams({ sort: 'extension', direction: 'desc' })).map(row => row.name),
    ['z.PDF', 'a.pdf', 'data.csv', 'README10', 'README2']);
  assert.deepEqual(entries, before, 'query sorting must preserve scan arrival order');
});

test('numeric size ordering and normalized extension filters include the entire matching inventory', () => {
  const entries = [file('report.PDF', '100', '.PDF'), file('other.pdf', '20', 'pdf'),
    file('README', 9, ''), file('Assets', null, '', { kind: 'folder' })];
  assert.deepEqual(queryEntries(entries, new URLSearchParams({ sort: 'size' })).map(row => row.size), [null, 9, '20', '100']);
  assert.deepEqual(queryEntries(entries, new URLSearchParams({ sort: 'size', direction: 'desc' })).map(row => row.size), ['100', '20', 9, null]);
  assert.equal(queryEntries(entries, new URLSearchParams({ extension: 'PDF' })).length, 2);
  assert.deepEqual(queryEntries(entries, new URLSearchParams({ extension: '__none__' })).map(row => row.name), ['README']);
});

test('missing extension metadata falls back to the filename or Windows path, while explicit empty stays empty', () => {
  assert.equal(fileExtension(file('Report.PDF', 1, undefined)), '.pdf');
  assert.equal(fileExtension(file('', 1, null, { path: '\\\\192.0.2.1\\Docs\\Data.CSV' })), '.csv');
  assert.equal(fileExtension(file('name.with.dot', 1, '')), '');
  assert.equal(fileExtension(file('README', 1, undefined)), '');
  assert.equal(fileExtension(file('.gitignore', 1, undefined)), '');
  assert.equal(fileExtension(file('trailing.', 1, undefined)), '');
});

test('search finds normalized file type metadata and supports wildcard extensions', () => {
  const metadataOnly = file('opaque-id', 100, ' PDF ', { path: '\\\\192.0.2.1\\Docs\\opaque-id' });
  const entries = [metadataOnly, file('other', 10, '.csv'), file('image.pdf.backup', 5, '.backup'),
    file('folder', null, '.pdf', { kind: 'folder' })];
  for (const q of ['pdf', '.pdf', ' PDF ']) {
    assert.deepEqual(queryEntries(entries, new URLSearchParams({ q })).map(row => row.name),
      ['image.pdf.backup', 'opaque-id']);
  }
  assert.deepEqual(queryEntries(entries, new URLSearchParams({ q: '*.PDF' })), [metadataOnly]);
  for (const extension of ['pdf', '.PDF', '*.pdf', ' *.PDF ']) {
    assert.deepEqual(queryEntries(entries, new URLSearchParams({ extension })), [metadataOnly]);
  }
});

test('search keeps case-insensitive substring matching across paths, names, hosts, and shares', () => {
  const row = file('Quarterly Summary', 10, '.pdf', { path: '\\\\192.0.2.12\\Finance Archive\\Fiscal 2026\\report' });
  for (const q of ['summary', 'FISCAL 2026', '192.0.2.1', ' docs ', '  ']) {
    assert.deepEqual(queryEntries([row], new URLSearchParams({ q })), [row]);
  }
  assert.deepEqual(queryEntries([{ kind: 'file' }], new URLSearchParams({ q: 'undefined' })), []);
  assert.deepEqual(queryEntries([row], new URLSearchParams({ q: '[not a regex' })), []);
});

test('no extension search and filters include only extensionless files and respect other filters', () => {
  const entries = [file('README', 1, ''), file('name.with.dot', 2, ''), file('.gitignore', 3, undefined),
    file('Other README', 4, '', { host: '192.0.2.2' }), file('folder', null, '', { kind: 'folder' }),
    file('no extension.pdf', 5, '.pdf')];
  const expected = ['.gitignore', 'name.with.dot', 'README'];
  for (const q of ['no extension', ' No Extension ', '__none__']) {
    const rows = queryEntries(entries, new URLSearchParams({ q, host: '192.0.2.1', share: 'Docs' }));
    assert.deepEqual(rows.map(row => row.name), expected);
    assert.equal(inventoryStats(rows).totalBytes, 6);
  }
  for (const extension of ['__none__', 'no extension', '.']) {
    assert.deepEqual(queryEntries(entries, new URLSearchParams({ extension, host: '192.0.2.1' })).map(row => row.name), expected);
  }
  assert.deepEqual(queryEntries(entries, new URLSearchParams({ q: 'no extension', kind: 'folder' })), []);
  assert.deepEqual(queryEntries(entries, new URLSearchParams({ q: '*.pdf', extension: '__none__' })), []);
});

test('query statistics cover all matching rows with safe sizes before any pagination', () => {
  const entries = Array.from({ length: 1025 }, (_, index) => file(`asset${index}`, index, index % 2 ? 'PDF' : '.csv',
    { host: index % 3 ? '192.0.2.1' : '192.0.2.2' }));
  entries.push(file('negative', -20, '.pdf'), file('invalid', 'invalid', '.pdf'), file('infinite', Infinity, '.pdf'));
  const rows = queryEntries(entries, new URLSearchParams({ q: '*.pdf', host: '192.0.2.1', sort: 'size', direction: 'desc' }));
  const expected = entries.filter(row => row.host === '192.0.2.1' && row.extension !== '.csv');
  assert.equal(rows.length, expected.length);
  assert.ok(rows.length > 200, 'A query must include matching rows beyond the largest result page.');
  const stats = inventoryStats(rows);
  assert.equal(stats.filesCount, expected.length);
  assert.equal(stats.totalBytes, expected.reduce((sum, row) => sum + (typeof row.size === 'number' && Number.isFinite(row.size) ? Math.max(0, row.size) : 0), 0));
  assert.equal(stats.typeCount, 1);
  assert.equal(stats.types[0].extension, '.pdf');
  assert.equal(stats.hostCount, 1);
  assert.deepEqual(rows.slice(-3).map(row => row.name), ['negative', 'invalid', 'infinite']);
});

test('filetype statistics normalize equivalent extensions and exclude folders from every total', () => {
  const stats = inventoryStats([file('one.PDF', 100, '.PDF'), file('two.pdf', 300, 'pdf'),
    file('three.csv', 100, undefined), file('README', 0, ''),
    file('folder.pdf', 999999, '.PDF', { kind: 'folder' })]);
  assert.equal(stats.filesCount, 4);
  assert.equal(stats.totalBytes, 500);
  assert.equal(stats.typeCount, 3);
  assert.deepEqual(stats.types, [
    { extension: '.pdf', filesCount: 2, totalBytes: 400, averageBytes: 200, largestBytes: 300, percentBytes: 80 },
    { extension: '.csv', filesCount: 1, totalBytes: 100, averageBytes: 100, largestBytes: 100, percentBytes: 20 },
    { extension: '', filesCount: 1, totalBytes: 0, averageBytes: 0, largestBytes: 0, percentBytes: 0 },
  ]);
  assert.equal(stats.sizeBuckets.reduce((sum, bucket) => sum + bucket.filesCount, 0), 4);
  assert.equal(stats.sizeBuckets.reduce((sum, bucket) => sum + bucket.totalBytes, 0), 500);
});

test('size distribution places exact binary-unit boundaries in the larger bucket', () => {
  const sizes = [0, 1, MiB - 1, MiB, 10 * MiB - 1, 10 * MiB, 100 * MiB - 1,
    100 * MiB, GiB - 1, GiB, 2 * GiB];
  const stats = inventoryStats(sizes.map((size, index) => file(`file${index}`, size, '')));
  assert.deepEqual(stats.sizeBuckets.map(bucket => bucket.id),
    ['empty', 'under1mb', '1to10mb', '10to100mb', '100mbto1gb', '1gbplus']);
  assert.deepEqual(stats.sizeBuckets.map(bucket => bucket.filesCount), [1, 2, 2, 2, 2, 2]);
  assert.deepEqual(stats.sizeBuckets.map(bucket => bucket.totalBytes),
    [0, MiB, 11 * MiB - 1, 110 * MiB - 1, 100 * MiB + GiB - 1, 3 * GiB]);
  assert.equal(stats.totalBytes, sizes.reduce((sum, size) => sum + size, 0));
  assert.equal(stats.sizeBuckets[5].maxBytes, null);
  assert.ok(Math.abs(stats.sizeBuckets.reduce((sum, bucket) => sum + bucket.percentFiles, 0) - 100) < 0.000001);
});

test('empty and zero-byte inventories produce finite percentages and retain every size bucket', () => {
  const empty = inventoryStats([file('folder', null, '', { kind: 'folder' })]);
  assert.equal(empty.filesCount, 0);
  assert.equal(empty.totalBytes, 0);
  assert.equal(empty.typeCount, 0);
  assert.equal(empty.hostCount, 0);
  assert.equal(empty.shareCount, 0);
  assert.deepEqual(empty.hosts, []);
  assert.deepEqual(empty.types, []);
  assert.equal(empty.sizeBuckets.length, 6);
  assert.ok(empty.sizeBuckets.every(bucket => bucket.filesCount === 0 && bucket.totalBytes === 0 && bucket.percentFiles === 0));
  const zeros = inventoryStats([file('empty.pdf', 0, '.pdf'), file('empty.csv', 0, '.csv')]);
  assert.deepEqual(zeros.types.map(type => type.extension), ['.csv', '.pdf']);
  assert.ok(zeros.types.every(type => type.averageBytes === 0 && type.largestBytes === 0 && type.percentBytes === 0));
  assert.equal(zeros.sizeBuckets[0].percentFiles, 100);
});

test('host and share totals count host/share pairs, normalize sizes, and exclude folder-only groups', () => {
  const stats = inventoryStats([
    file('a.pdf', '100', '.pdf', { host: '192.0.2.2', share: 'Docs' }),
    file('b.pdf', 25, '.pdf', { host: '192.0.2.2', share: 'Docs' }),
    file('c.csv', 75, '.csv', { host: '192.0.2.2', share: 'Reports' }),
    file('d.pdf', 200, '.pdf', { host: '192.0.2.1', share: 'Docs' }),
    file('empty', 0, '', { host: '192.0.2.3', share: 'Zero' }),
    file('negative', -25, '', { host: '192.0.2.3', share: 'Zero' }),
    file('invalid', 'invalid', '', { host: '192.0.2.3', share: 'Invalid' }),
    file('infinite', Infinity, '', { host: '192.0.2.3', share: 'Invalid' }),
    file('folder', 999999, '', { host: '192.0.2.4', share: 'FolderOnly', kind: 'folder' }),
  ]);
  assert.equal(stats.hostCount, 3);
  assert.equal(stats.shareCount, 5);
  assert.equal(stats.filesCount, 8);
  assert.equal(stats.totalBytes, 400);
  assert.deepEqual(stats.hosts, [
    { host: '192.0.2.1', filesCount: 1, totalBytes: 200, sharesCount: 1,
      shares: [{ share: 'Docs', filesCount: 1, totalBytes: 200 }],
      otherShares: { sharesCount: 0, filesCount: 0, totalBytes: 0 },
      sharesByFiles: [{ share: 'Docs', filesCount: 1, totalBytes: 200 }],
      otherSharesByFiles: { sharesCount: 0, filesCount: 0, totalBytes: 0 } },
    { host: '192.0.2.2', filesCount: 3, totalBytes: 200, sharesCount: 2,
      shares: [{ share: 'Docs', filesCount: 2, totalBytes: 125 }, { share: 'Reports', filesCount: 1, totalBytes: 75 }],
      otherShares: { sharesCount: 0, filesCount: 0, totalBytes: 0 },
      sharesByFiles: [{ share: 'Docs', filesCount: 2, totalBytes: 125 }, { share: 'Reports', filesCount: 1, totalBytes: 75 }],
      otherSharesByFiles: { sharesCount: 0, filesCount: 0, totalBytes: 0 } },
    { host: '192.0.2.3', filesCount: 4, totalBytes: 0, sharesCount: 2,
      shares: [{ share: 'Invalid', filesCount: 2, totalBytes: 0 }, { share: 'Zero', filesCount: 2, totalBytes: 0 }],
      otherShares: { sharesCount: 0, filesCount: 0, totalBytes: 0 },
      sharesByFiles: [{ share: 'Invalid', filesCount: 2, totalBytes: 0 }, { share: 'Zero', filesCount: 2, totalBytes: 0 }],
      otherSharesByFiles: { sharesCount: 0, filesCount: 0, totalBytes: 0 } },
  ]);
});

test('host share summaries retain the six largest groups and aggregate every omitted share exactly', () => {
  const entries = Array.from({ length: 10 }, (_, index) => file(`file${index}`, index, '', { share: `Share${index}` }));
  entries.push(file('another', 1, '', { share: 'Share0' }));
  entries.push(file('empty', 0, '', { share: 'Share0' }));
  const stats = inventoryStats(entries);
  const [host] = stats.hosts;
  assert.equal(stats.hostCount, 1);
  assert.equal(stats.shareCount, 10);
  assert.equal(stats.filesCount, 12);
  assert.equal(stats.totalBytes, 46);
  assert.equal(host.shares.length, 6);
  assert.deepEqual(host.shares.map(share => share.share), ['Share9', 'Share8', 'Share7', 'Share6', 'Share5', 'Share4']);
  assert.deepEqual(host.otherShares, { sharesCount: 4, filesCount: 6, totalBytes: 7 });
  assert.equal(host.sharesCount, host.shares.length + host.otherShares.sharesCount);
  assert.equal(host.filesCount, host.shares.reduce((sum, share) => sum + share.filesCount, host.otherShares.filesCount));
  assert.equal(host.totalBytes, host.shares.reduce((sum, share) => sum + share.totalBytes, host.otherShares.totalBytes));
  assert.deepEqual(host.sharesByFiles.map(share => share.share), ['Share0', 'Share9', 'Share8', 'Share7', 'Share6', 'Share5']);
  assert.deepEqual(host.otherSharesByFiles, { sharesCount: 4, filesCount: 4, totalBytes: 10 });
  assert.equal(host.filesCount, host.sharesByFiles.reduce((sum, share) => sum + share.filesCount, host.otherSharesByFiles.filesCount));
  assert.equal(host.totalBytes, host.sharesByFiles.reduce((sum, share) => sum + share.totalBytes, host.otherSharesByFiles.totalBytes));
});

test('share file-count ranking includes small-file shares omitted from the storage ranking', () => {
  const entries = Array.from({ length: 6 }, (_, index) => file(`large${index}`, (index + 1) * GiB, '.vhdx', { share: `Large${index}` }));
  entries.push(...Array.from({ length: 100 }, (_, index) => file(`tiny${index}`, 1, '.txt', { share: 'ManySmallFiles' })));
  const [host] = inventoryStats(entries).hosts;
  assert.deepEqual(host.shares.map(share => share.share), ['Large5', 'Large4', 'Large3', 'Large2', 'Large1', 'Large0']);
  assert.deepEqual(host.otherShares, { sharesCount: 1, filesCount: 100, totalBytes: 100 });
  assert.deepEqual(host.sharesByFiles.map(share => share.share), ['ManySmallFiles', 'Large5', 'Large4', 'Large3', 'Large2', 'Large1']);
  assert.deepEqual(host.otherSharesByFiles, { sharesCount: 1, filesCount: 1, totalBytes: GiB });
});

test('host share summaries use natural name ordering for equal-byte groups and cap zero-byte lists', () => {
  const entries = [10, 2, 7, 3, 6, 5, 4].map(index => file(`file${index}`, 0, '', { share: `Share${index}` }));
  const [host] = inventoryStats(entries).hosts;
  assert.deepEqual(host.shares.map(share => share.share), ['Share2', 'Share3', 'Share4', 'Share5', 'Share6', 'Share7']);
  assert.deepEqual(host.otherShares, { sharesCount: 1, filesCount: 1, totalBytes: 0 });
  assert.equal(host.sharesCount, 7);
  assert.equal(host.filesCount, 7);
  assert.deepEqual(host.sharesByFiles, host.shares);
  assert.deepEqual(host.otherSharesByFiles, host.otherShares);
});
