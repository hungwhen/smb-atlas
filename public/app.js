(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const ACTIVE = new Set(['running', 'cancelling']);
  const state = { token: '', job: null, savedJob: null, demo: false, demoEntries: [], entries: [], total: 0, offset: 0, limit: 50, hostOffset: 0, hostLimit: 200, q: '', host: '', share: '', extension: '', kind: '', sort: 'name', direction: 'asc', tab: 'overview', chartMetric: 'bytes', stats: null, typeSort: 'totalBytes', typeDirection: 'desc', facets: { hosts: [], shares: [], extensions: [] }, loading: false, poll: null, generation: 0, requestId: 0, lastUpdated: null, sessionReady: false };
  let toastTimer;
  let searchTimer;
  let refreshController;
  const number = (value) => new Intl.NumberFormat().format(typeof value === 'bigint' || (typeof value === 'string' && /^\d+$/.test(value)) ? BigInt(value) : Number(value) || 0);
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const isActive = () => state.job && ACTIVE.has(state.job.status);
  function bytes(value) { const raw = Number(value); const n = Number.isFinite(raw) ? Math.max(0, raw) : 0; if (!n) return { value: '0', unit: 'B' }; if (n < 1) return { value: '<1', unit: 'B' }; const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']; const i = Math.max(0, Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1)); return { value: (n / 1024 ** i).toLocaleString(undefined, { maximumFractionDigits: i ? 1 : 0 }), unit: units[i] }; }
  function sizeText(value) { const result = bytes(value); return `${result.value} ${result.unit}`; }
  function dateText(value) { if (!value) return '—'; const date = new Date(value); if (!Number.isFinite(date.getTime())) return '—'; return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); }
  function errorMessage(error) { return error instanceof Error ? error.message : String(error || 'An unexpected error occurred.'); }
  function notice(message) { $('global-notice').textContent = message || ''; $('global-notice').hidden = !message; }
  function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3600); }
  async function api(path, options = {}) {
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(state.token ? { 'X-Scanner-Token': state.token } : {}), ...options.headers };
    const response = await fetch(path, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
    if (!response.ok) { let data; try { data = await response.json(); } catch { /* A plain error page is not a safe application message. */ } const raw = data?.error; const message = typeof raw === 'string' ? raw : raw?.message || data?.message || `Request failed (${response.status}).`; throw new Error(message); }
    if (options.blob) return response.blob();
    if (response.status === 204) return null;
    return response.json();
  }
  function query(includePage = true) { const p = new URLSearchParams(); if (includePage) { p.set('offset', state.offset); p.set('limit', state.limit); p.set('hostOffset', state.hostOffset); p.set('hostLimit', state.hostLimit); p.set('view', state.tab); } for (const key of ['q', 'host', 'share', 'extension', 'kind', 'sort', 'direction']) if (state[key]) p.set(key, state[key]); return p; }
  function stopPolling() { clearTimeout(state.poll); state.poll = null; }
  function schedulePoll() { stopPolling(); if (isActive() && !state.demo) state.poll = setTimeout(() => refresh(), 1000); }
  function invalidateResults() { stopPolling(); refreshController?.abort(); refreshController = null; state.requestId++; state.loading = false; state.queryError = false; }
  function resetQuery() { clearTimeout(searchTimer); invalidateResults(); state.scopeResetVersion = (state.scopeResetVersion || 0) + 1; state.offset = 0; state.q = ''; state.host = ''; state.share = ''; state.extension = ''; state.kind = ''; $('search').value = ''; for (const key of ['host', 'share', 'extension', 'kind']) $(`filter-${key}`).value = ''; updateFilterCount(); renderQueryState(); }
  function updateFilterCount() { const count = ['host', 'share', 'extension', 'kind'].filter((key) => state[key]).length; $('filter-count').hidden = !count; $('filter-count').textContent = count; }
  function activeScope() { return [state.q && `Search: ${state.q}`, state.host && `Host: ${state.host}`, state.share && `Share: ${state.share}`, state.extension && `File type: ${state.extension === '__none__' ? 'No extension' : state.extension}`, state.kind && `Type: ${state.kind === 'folder' ? 'Folders' : 'Files'}`].filter(Boolean); }
  function renderQueryState() {
    const scopes = activeScope(); $('inventory-scope').textContent = scopes.length ? scopes.join(' · ') : 'All files and folders';
    $('inventory-status').textContent = state.loading ? 'Updating inventory…' : state.queryError ? 'Could not update this view' : !state.job ? 'No inventory loaded' : state.tab === 'hosts' ? `${number(state.job.targetsCount)} target hosts` : state.tab === 'errors' ? 'Activity for the whole scan' : `${number(state.total)} matching entries`;
    $('inventory-results').setAttribute('aria-busy', String(state.loading)); $('clear-search').hidden = !state.q && !$('search').value; $('search-shortcut').hidden = !($('clear-search').hidden);
    $('all-files').title = 'Clear the search and every filter without changing the scan results';
  }
  function updateOptions(select, values, emptyLabel, selected = '', label = value => value) {
    const normalized = [...new Set(values.map(value => typeof value === 'object' ? String(value.value ?? value.name ?? '') : String(value)).filter(Boolean))];
    if (selected && !normalized.includes(selected)) normalized.push(selected);
    const signature = JSON.stringify(normalized);
    if (select.dataset.optionsKey !== signature) {
      const fragment = document.createDocumentFragment(); const empty = el('option', '', emptyLabel); empty.value = ''; fragment.append(empty);
      for (const value of normalized) { const option = el('option', '', label(value)); option.value = value; fragment.append(option); }
      select.replaceChildren(fragment); select.dataset.optionsKey = signature;
    }
    select.value = selected;
  }
  function renderFacets() {
    updateOptions($('filter-host'), state.facets.hosts || [], 'All hosts', state.host); updateOptions($('filter-share'), state.facets.shares || [], 'All shares', state.share);
    updateOptions($('filter-extension'), state.facets.extensions || [], 'All file types', state.extension, value => value === '__none__' ? 'No extension' : value.startsWith('.') ? value : `.${value}`);
    $('filter-kind').value = state.kind; updateFilterCount();
  }
  function renderStats() {
    const j = state.job;
    $('stat-hosts').replaceChildren(document.createTextNode(number(j?.completedHosts)), el('span', '', ` / ${number(j?.targetsCount)}`));
    $('stat-shares').textContent = number(j?.sharesCount); $('stat-files').textContent = number(j?.filesCount); const size = bytes(j?.totalBytes); $('stat-bytes').replaceChildren(document.createTextNode(`${size.value} `), el('span', '', size.unit));
    $('stat-files-caption').textContent = j?.foldersCount ? `+ ${number(j.foldersCount)} folders indexed` : 'indexed files';
    $('types-tab-count').textContent = number(state.stats?.typeCount);
    $('files-tab-count').textContent = number(j?.entriesCount); $('hosts-tab-count').textContent = number(j?.targetsCount); $('errors-tab-count').textContent = number(j?.errors?.length); $('tab-errors').classList.toggle('error-tab', Boolean(j?.errors?.length));
    $('export-csv').disabled = !j || !j.entriesCount; $('export-json').disabled = !j || !j.entriesCount; $('clear-button').disabled = !j || Boolean(isActive()); $('demo-button').disabled = Boolean(isActive());
    $('scan-button').disabled = Boolean(isActive()) || !state.sessionReady; $('scan-button').querySelector('span').textContent = isActive() ? 'Scan in progress' : 'Start scan';
    $('demo-notice').hidden = !state.demo; $('demo-button').textContent = state.demo ? 'Sample loaded' : 'Explore sample';
    $('results-subtitle').textContent = j ? `${number(j.entriesCount)} entries${state.demo ? ' · sample data' : ''}` : 'Files, shares, and host activity.';
  }
  function renderProgress() {
    const j = state.job; $('progress-card').hidden = !j;
    if (!j) return;
    const labels = { running: 'Scan in progress', cancelling: 'Stopping scan', completed: 'Scan complete', partial: 'Scan complete with issues', cancelled: 'Scan stopped', failed: 'Scan failed' };
    $('scan-status').textContent = state.demo ? 'Sample inventory' : labels[j.status] || j.status;
    $('scan-status-dot').className = `status-dot ${state.demo ? 'completed' : j.status}`;
    const started = new Date(j.startedAt).getTime(); const finished = new Date(j.finishedAt || Date.now()).getTime(); const seconds = Math.max(0, Math.round((finished - started) / 1000));
    $('scan-timing').textContent = Number.isFinite(seconds) ? `${seconds >= 60 ? `${Math.floor(seconds / 60)}m ` : ''}${seconds % 60}s elapsed` : '';
    const percentage = j.targetsCount ? Math.min(100, Math.round(j.completedHosts / j.targetsCount * 100)) : 0;
    $('progress-bar').style.width = `${percentage}%`; $('progress-percent').textContent = `${percentage}%`;
    $('progress-description').textContent = `${number(j.completedHosts)} of ${number(j.targetsCount)} hosts processed${j.status === 'cancelling' ? ' · waiting for active requests to finish' : ''}`;
    $('cancel-button').hidden = !isActive() || state.demo; $('cancel-button').disabled = j.status === 'cancelling'; $('cancel-button').textContent = j.status === 'cancelling' ? 'Stopping…' : 'Stop scan';
  }
  function entryKind(entry) { const kind = String(entry.kind || entry.type || '').toLowerCase(); return ['directory', 'folder', 'dir'].includes(kind) || entry.isDirectory ? 'folder' : 'file'; }
  function entryName(entry) { return entry.name || String(entry.path || '').split(/[\\/]/).pop() || 'Unnamed entry'; }
  function entryPath(entry) { return entry.path || entry.uncPath || `\\\\${entry.host}\\${entry.share}\\${entryName(entry)}`; }
  function entryExtension(entry) { if (entryKind(entry) === 'folder') return ''; const name = entryName(entry); const dot = name.lastIndexOf('.'); const ext = entry.extension ?? (dot > 0 ? name.slice(dot + 1) : ''); return ext ? String(ext).trim().replace(/^\.+/, '').toLowerCase() : ''; }
  function extensionKey(entry) { const ext = entryExtension(entry); return ext ? `.${ext}` : ''; }
  function typeLabel(extension) { return extension ? String(extension) : 'No extension'; }
  function percent(value) { return `${(Number(value) || 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`; }
  const bucketDefinitions = [
    { id: 'empty', label: 'Empty files (0 B)', minBytes: 0, maxBytes: 0 },
    { id: 'under1mb', label: 'Under 1 MB', minBytes: 1, maxBytes: 1024 ** 2 },
    { id: '1to10mb', label: '1–10 MB', minBytes: 1024 ** 2, maxBytes: 10 * 1024 ** 2 },
    { id: '10to100mb', label: '10–100 MB', minBytes: 10 * 1024 ** 2, maxBytes: 100 * 1024 ** 2 },
    { id: '100mbto1gb', label: '100 MB–1 GB', minBytes: 100 * 1024 ** 2, maxBytes: 1024 ** 3 },
    { id: '1gbplus', label: '1 GB and larger', minBytes: 1024 ** 3, maxBytes: null }
  ];
  function summarizeHosts(entries) {
    const hosts = new Map();
    for (const entry of entries) {
      if (entryKind(entry) !== 'file') continue;
      const host = String(entry.host || '');
      const share = String(entry.share || '');
      const raw = Number(entry.size ?? entry.sizeBytes);
      const totalBytes = Number.isFinite(raw) ? Math.max(0, raw) : 0;
      if (!hosts.has(host)) hosts.set(host, { host, filesCount: 0, totalBytes: 0, shares: new Map() });
      const group = hosts.get(host);
      group.filesCount++;
      group.totalBytes += totalBytes;
      if (!group.shares.has(share)) group.shares.set(share, { share, filesCount: 0, totalBytes: 0 });
      group.shares.get(share).filesCount++;
      group.shares.get(share).totalBytes += totalBytes;
    }
    const compare = (a, b, key) => b.totalBytes - a.totalBytes || a[key].localeCompare(b[key], undefined, { numeric: true });
    let shareCount = 0;
    const rows = [...hosts.values()].map(group => {
      const shares = [...group.shares.values()].sort((a, b) => compare(a, b, 'share'));
      const sharesByFiles = [...shares].sort((a, b) => b.filesCount - a.filesCount || compare(a, b, 'share'));
      shareCount += shares.length;
      const otherShares = shares.slice(6).reduce((total, share) => ({ sharesCount: total.sharesCount + 1, filesCount: total.filesCount + share.filesCount, totalBytes: total.totalBytes + share.totalBytes }), { sharesCount: 0, filesCount: 0, totalBytes: 0 });
      const otherSharesByFiles = sharesByFiles.slice(6).reduce((total, share) => ({ sharesCount: total.sharesCount + 1, filesCount: total.filesCount + share.filesCount, totalBytes: total.totalBytes + share.totalBytes }), { sharesCount: 0, filesCount: 0, totalBytes: 0 });
      return { host: group.host, filesCount: group.filesCount, totalBytes: group.totalBytes, sharesCount: shares.length, shares: shares.slice(0, 6), otherShares, sharesByFiles: sharesByFiles.slice(0, 6), otherSharesByFiles };
    }).sort((a, b) => compare(a, b, 'host'));
    return { hostCount: rows.length, shareCount, hosts: rows };
  }
  function summarizeEntries(entries) {
    const types = new Map(); const buckets = bucketDefinitions.map((bucket) => ({ ...bucket, filesCount: 0, totalBytes: 0, percentFiles: 0 })); let filesCount = 0; let totalBytes = 0;
    for (const entry of entries) { if (entryKind(entry) !== 'file') continue; const extension = extensionKey(entry); const size = Math.max(0, Number(entry.size ?? entry.sizeBytes) || 0); filesCount++; totalBytes += size;
      const type = types.get(extension) || { extension, filesCount: 0, totalBytes: 0, averageBytes: 0, largestBytes: 0, percentBytes: 0 }; type.filesCount++; type.totalBytes += size; type.largestBytes = Math.max(type.largestBytes, size); types.set(extension, type);
      const bucket = size === 0 ? buckets[0] : buckets.find((item) => item.id !== 'empty' && size >= item.minBytes && (item.maxBytes === null || size < item.maxBytes)); if (bucket) { bucket.filesCount++; bucket.totalBytes += size; }
    }
    for (const type of types.values()) { type.averageBytes = type.totalBytes / type.filesCount; type.percentBytes = totalBytes ? type.totalBytes / totalBytes * 100 : 0; }
    for (const bucket of buckets) bucket.percentFiles = filesCount ? bucket.filesCount / filesCount * 100 : 0;
    return { filesCount, totalBytes, typeCount: types.size, types: [...types.values()], sizeBuckets: buckets, ...summarizeHosts(entries) };
  }
  function renderSortControls() {
    $('sort-by').closest('.sort-controls').hidden = state.tab === 'overview';
    const types = state.tab === 'types'; const options = types ? [['extension', 'File type'], ['filesCount', 'File count'], ['totalBytes', 'Total size'], ['averageBytes', 'Average size'], ['largestBytes', 'Largest file'], ['percentBytes', '% storage']] : [['name', 'Name'], ['extension', 'File type'], ['size', 'Size'], ['modified', 'Modified'], ['host', 'Host'], ['path', 'Path'], ['share', 'Share']];
    $('sort-by').replaceChildren(...options.map(([value, label]) => { const option = el('option', '', label); option.value = value; return option; })); $('sort-by').value = types ? state.typeSort : state.sort;
    const direction = types ? state.typeDirection : state.direction; const label = direction === 'asc' ? 'Ascending' : 'Descending'; $('sort-direction-label').textContent = label; $('sort-direction-icon').textContent = direction === 'asc' ? '↑' : '↓'; const action = `Sort ${label.toLowerCase()}; switch to ${direction === 'asc' ? 'descending' : 'ascending'}`; $('sort-direction').setAttribute('aria-label', action); $('sort-direction').title = action;
  }
  function renderFileTypes() {
    const stats = state.stats || { filesCount: 0, typeCount: 0, totalBytes: 0, types: [], sizeBuckets: [] }; $('types-files-count').textContent = number(stats.filesCount); $('types-count').textContent = number(stats.typeCount); $('types-total-size').textContent = sizeText(stats.totalBytes); $('types-average-size').textContent = sizeText(stats.filesCount ? stats.totalBytes / stats.filesCount : 0);
    const scopes = [state.q && `Search: ${state.q}`, state.host && `Host: ${state.host}`, state.share && `Share: ${state.share}`, state.extension && `File type: ${state.extension === '__none__' ? 'No extension' : state.extension}`, state.kind && `Type: ${state.kind === 'folder' ? 'Folders' : 'Files'}`].filter(Boolean); $('types-active-scope').hidden = !scopes.length; $('types-active-scope').textContent = scopes.join(' · '); $('reset-type-scope').hidden = !scopes.length;
    const types = [...(stats.types || [])].sort((a, b) => { const left = a[state.typeSort]; const right = b[state.typeSort]; const result = state.typeSort === 'extension' ? typeLabel(left).localeCompare(typeLabel(right), undefined, { numeric: true, sensitivity: 'base' }) : (Number(left) || 0) - (Number(right) || 0); return (state.typeDirection === 'asc' ? result : -result) || typeLabel(a.extension).localeCompare(typeLabel(b.extension)); });
    $('types-empty').hidden = types.length > 0; $('type-table-wrap').hidden = !types.length;
    const typeRows = document.createDocumentFragment();
    for (const type of types) { const row = el('tr'); const filetype = el('td'); filetype.append(el('span', 'extension-label', typeLabel(type.extension))); row.append(filetype, el('td', 'numeric-cell', number(type.filesCount)), el('td', 'numeric-cell', sizeText(type.totalBytes)), el('td', 'numeric-cell', sizeText(type.averageBytes)), el('td', 'numeric-cell', sizeText(type.largestBytes)), el('td', 'numeric-cell', percent(type.percentBytes))); const action = el('td'); const view = el('button', 'text-action', 'View files'); view.type = 'button'; view.setAttribute('aria-label', `View ${typeLabel(type.extension)} files`); view.addEventListener('click', () => applyChartFilter({ extension: type.extension || '__none__', kind: 'file' })); action.append(view); row.append(action); typeRows.append(row); }
    $('type-rows').replaceChildren(typeRows);
    document.querySelectorAll('.type-table th').forEach((th) => th.removeAttribute('aria-sort')); document.querySelectorAll('[data-type-sort]').forEach((button) => { const active = button.dataset.typeSort === state.typeSort; button.classList.toggle('sorted', active); button.dataset.direction = active ? state.typeDirection : ''; if (active) button.closest('th').setAttribute('aria-sort', state.typeDirection === 'asc' ? 'ascending' : 'descending'); });
    const buckets = bucketDefinitions.map((definition) => ({ ...definition, ...(stats.sizeBuckets || []).find((bucket) => bucket.id === definition.id), label: definition.label }));
    $('size-buckets').replaceChildren(...buckets.map((bucket) => { const item = el('li'); const label = el('div', 'bucket-label'); label.append(el('span', '', bucket.label), el('strong', '', `${number(bucket.filesCount)} files`)); const track = el('div', 'bucket-track'); const fill = el('div', 'bucket-fill'); fill.style.width = `${Math.max(0, Math.min(100, Number(bucket.percentFiles) || 0))}%`; track.setAttribute('aria-hidden', 'true'); track.append(fill); const detail = el('div', 'bucket-detail'); detail.append(el('span', '', sizeText(bucket.totalBytes)), el('span', '', percent(bucket.percentFiles))); item.append(label, track, detail); return item; }));
  }
  function copyIcon() { const span = el('span'); span.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V4H4v12h4"/></svg>'; return span.firstElementChild; }
  function renderTable() {
    const hasJob = Boolean(state.job); const hasEntries = state.entries.length > 0;
    $('empty-state').hidden = hasJob; $('no-results').hidden = !hasJob || hasEntries; $('file-table-wrap').hidden = !hasEntries; $('pagination').hidden = !hasJob || !state.total;
    const rows = state.entries.map((entry) => {
      const row = el('tr'); const first = el('td'); const file = el('div', 'file-cell'); const kind = entryKind(entry); const ext = entryExtension(entry); const palette = ['xlsx','xls','csv','ods'].includes(ext) ? 'sheet' : ['docx','doc','txt','md'].includes(ext) ? 'document' : ext === 'pdf' ? 'pdf' : '';
      const icon = el('div', `file-type-icon ${kind === 'folder' ? 'directory' : palette}`, kind === 'folder' ? 'DIR' : ext.slice(0, 4) || 'FILE'); icon.setAttribute('aria-hidden', 'true');
      const detail = el('div'); const name = el('div', 'file-name', entryName(entry)); name.title = entryName(entry); const path = el('div', 'file-path', entryPath(entry)); path.title = entryPath(entry); detail.append(name, path); file.append(icon, detail); first.append(file);
      const host = el('td', 'host-mono', entry.host || '—'); const share = el('td'); share.append(el('span', 'share-chip', entry.share || '—')); const size = el('td', 'size-cell', kind === 'folder' ? '—' : sizeText(entry.size ?? entry.sizeBytes)); const modified = el('td', 'modified-cell', dateText(entry.modified ?? entry.modifiedAt ?? entry.lastModified));
      const type = el('td', 'extension-cell', kind === 'folder' ? 'Folder' : typeLabel(extensionKey(entry)));
      const copyCell = el('td'); const copy = el('button', 'icon-button copy-path'); copy.type = 'button'; copy.setAttribute('aria-label', `Copy path for ${entryName(entry)}`); copy.title = 'Copy UNC path'; copy.append(copyIcon()); copy.addEventListener('click', () => copyText(entryPath(entry))); copyCell.append(copy); row.append(first, host, share, type, size, modified, copyCell); return row;
    });
    $('file-rows').replaceChildren(...rows);
    document.querySelectorAll('.inventory-table th').forEach((th) => th.removeAttribute('aria-sort'));
    document.querySelectorAll('[data-sort]').forEach((button) => { const active = button.dataset.sort === state.sort; button.classList.toggle('sorted', active); button.dataset.direction = active ? state.direction : ''; if (active) button.closest('th').setAttribute('aria-sort', state.direction === 'asc' ? 'ascending' : 'descending'); });
    const start = state.total ? state.offset + 1 : 0; const end = Math.min(state.offset + state.entries.length, state.total); $('page-summary').textContent = `${number(start)}–${number(end)} of ${number(state.total)} entries`; $('page-number').textContent = `${Math.floor(state.offset / state.limit) + 1} / ${Math.max(1, Math.ceil(state.total / state.limit))}`; $('previous-page').disabled = state.offset === 0; $('next-page').disabled = state.offset + state.limit >= state.total;
  }
  function renderHosts() {
    const allHosts = state.job?.hosts || [];
    const total = state.job?.hostsTotal ?? state.job?.targetsCount ?? allHosts.length;
    const offset = state.demo ? state.hostOffset : (state.job?.hostsOffset ?? state.hostOffset);
    const limit = state.demo ? state.hostLimit : (state.job?.hostsLimit || state.hostLimit);
    const hosts = state.demo ? allHosts.slice(offset, offset + limit) : allHosts;
    $('hosts-empty').hidden = total > 0; $('host-table').hidden = !hosts.length;
    $('host-rows').replaceChildren(...hosts.map((host) => { const row = el('tr'); const status = el('td'); status.append(el('span', `status-badge ${['queued','probing','scanning','completed','partial','failed','unreachable','cancelled'].includes(host.status) ? host.status : ''}`, host.status)); row.append(el('td', 'host-mono', host.host), status, el('td', '', number(host.shares)), el('td', '', number(host.files)), el('td', 'host-detail', host.error || '—')); return row; }));
    $('host-pagination').hidden = !total;
    $('host-page-summary').textContent = `${number(hosts.length ? offset + 1 : 0)}–${number(Math.min(offset + hosts.length, total))} of ${number(total)} hosts`;
    $('host-page-number').textContent = `${Math.floor(offset / limit) + 1} / ${Math.max(1, Math.ceil(total / limit))}`;
    $('previous-host-page').disabled = offset === 0;
    $('next-host-page').disabled = offset + limit >= total;
  }
  function renderErrors() {
    const errors = state.job?.errors || []; $('errors-empty').hidden = errors.length > 0; $('errors-empty').textContent = state.job && isActive() ? 'No errors so far. Activity is updating live.' : 'No errors to display.';
    $('error-list').replaceChildren(...errors.map((error) => { const item = el('li'); const symbol = el('span'); symbol.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3v.1"/></svg>'; const body = el('div'); body.append(el('strong', '', `${error.host || 'Scan'}${error.share ? ` / ${error.share}` : ''}`), el('p', '', error.message || error.error || 'Unknown issue')); item.append(symbol.firstElementChild, body); return item; }));
  }
  function applyChartFilter(filters) {
    for (const key of ['host', 'share', 'extension', 'kind']) {
      if (!Object.hasOwn(filters, key)) continue;
      state[key] = key === 'extension' && !filters[key] ? '__none__' : String(filters[key] || '');
      $(`filter-${key}`).value = state[key];
    }
    state.offset = 0;
    updateFilterCount();
    setTab('files', true, false);
    refresh();
  }
  function renderOverview() {
    const scopes = [state.q && `Search: ${state.q}`, state.host && `Host: ${state.host}`, state.share && `Share: ${state.share}`, state.extension && `File type: ${state.extension === '__none__' ? 'No extension' : state.extension}`, state.kind && `Type: ${state.kind}`].filter(Boolean);
    $('overview-filter-scope').hidden = !scopes.length;
    $('overview-active-scope').textContent = scopes.join(' · ');
    window.SMBAtlasOverview.render($('overview-charts'), {
      stats: state.stats, job: state.job, metric: state.chartMetric, scopeKey: JSON.stringify([state.job?.id, state.q, state.host, state.share, state.extension, state.kind, state.scopeResetVersion || 0]),
      onMetricChange: metric => { state.chartMetric = metric; renderOverview(); },
      onFilter: applyChartFilter, onTab: tab => setTab(tab, true),
    });
  }
  function render() { renderStats(); renderProgress(); renderQueryState(); renderSortControls(); if (['overview', 'files', 'types'].includes(state.tab)) renderFacets(); if (state.tab === 'files') renderTable(); if (state.tab === 'types') renderFileTypes(); if (state.tab === 'overview') renderOverview(); if (state.tab === 'hosts') renderHosts(); if (state.tab === 'errors') renderErrors(); $('updated-label').textContent = state.demo ? 'Illustrative sample data' : state.lastUpdated ? `Updated ${state.lastUpdated.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : 'No scan started'; }
  async function refresh() {
    clearTimeout(searchTimer); invalidateResults();
    if (state.demo) { renderDemo(); return; }
    if (!state.job) { render(); return; }
    const id = ++state.requestId; const generation = state.generation; const jobId = state.job.id; const view = state.tab; const controller = new AbortController(); refreshController = controller; state.loading = true; renderQueryState();
    try {
      const data = await api(`/api/scans/${encodeURIComponent(jobId)}?${query()}`, { signal: controller.signal });
      if (generation !== state.generation || id !== state.requestId) return;
      state.job = data.job; if (Number.isSafeInteger(data.job?.hostsOffset)) state.hostOffset = data.job.hostsOffset;
      if (['overview', 'files', 'types'].includes(view)) { state.entries = data.entries || []; state.total = data.total || 0; state.facets = data.facets || state.facets; state.stats = data.stats || null; }
      state.lastUpdated = new Date(); notice('');
      if (['overview', 'files', 'types'].includes(view) && state.offset && state.offset >= state.total) { state.offset = Math.max(0, Math.floor(Math.max(0, state.total - 1) / state.limit) * state.limit); await refresh(); return; }
      render();
    } catch (error) { if (generation === state.generation && id === state.requestId && error.name !== 'AbortError') { state.queryError = true; notice(errorMessage(error)); } }
    finally { if (generation === state.generation && id === state.requestId) { refreshController = null; state.loading = false; renderQueryState(); schedulePoll(); } }
  }
  async function copyText(text) { try { await navigator.clipboard.writeText(text); toast('UNC path copied'); } catch { toast('Clipboard unavailable in this browser. The full path is shown on hover.'); } }
  function setTab(tab, focus = false, refreshData = true) { const changed = state.tab !== tab; state.tab = tab; document.querySelectorAll('[data-tab]').forEach((button) => { const active = button.dataset.tab === tab; button.classList.toggle('active', active); button.setAttribute('aria-selected', String(active)); button.tabIndex = active ? 0 : -1; if (active && focus) button.focus(); }); $('inventory-controls').hidden = !['overview', 'files', 'types'].includes(tab);
    for (const name of ['overview', 'files', 'types', 'hosts', 'errors']) $(`panel-${name}`).hidden = name !== tab; render(); if (changed && refreshData && state.job) refresh(); }
  function demoData() {
    const entries = []; const hosts = ['10.24.1.12', '10.24.1.18', '10.24.1.25', '10.24.1.31']; const templates = [ ['Finance', 'FY26/Q4', 'Quarterly summary.xlsx', 238942, '2026-10-28'], ['Finance', 'Invoices', 'Invoice-1048.pdf', 192403, '2026-10-26'], ['Projects', 'Atlas', 'Project roadmap.docx', 1048023, '2026-10-30'], ['Shared', 'Brand', 'Brand guidelines.pdf', 4321800, '2026-09-14'], ['Shared', 'Operations', 'Team directory.csv', 14280, '2026-10-31'], ['Projects', 'Design', 'Workspace mockup.png', 2509234, '2026-10-23'], ['Archive', '2025', 'Annual report.pdf', 8142931, '2026-01-16'], ['Engineering', 'Docs', 'Getting started.md', 8192, '2026-10-29'], ['Shared', 'Templates', 'Meeting notes.docx', 41280, '2026-10-21'], ['Finance', 'Planning', 'Budget forecast.xlsx', 684302, '2026-10-27'], ['Projects', 'Research', 'Customer insights.pptx', 6291491, '2026-10-24'], ['Engineering', 'Exports', 'Asset inventory.json', 92381, '2026-10-31'], ['Engineering', 'Docs', 'README', 0, '2026-10-29'], ['Archive', 'Backups', 'Project backup.zip', 350 * 1024 ** 2, '2026-10-20'], ['Shared', 'Media', 'Team recording.mp4', 258264018, '2026-10-22'], ['Engineering', 'Logs', 'Empty log.log', 0, '2026-10-31'], ['Archive', 'Systems', 'Test machine.vhdx', 4 * 1024 ** 3, '2026-10-21'], ['Projects', 'Design', 'Campaign artwork.psd', 48 * 1024 ** 2, '2026-10-25'] ];
    for (let i = 0; i < 72; i++) { const [share, folder, baseName, size, date] = templates[i % templates.length]; const host = hosts[Math.floor(i / 18)]; const name = i < 12 ? baseName : baseName.replace(/(\.[^.]+)$/, ` ${Math.floor(i / 12) + 1}$1`); entries.push({ name, path: `\\\\${host}\\${share}\\${folder}\\${name}`, host, share, kind: 'file', size: size === 0 ? 0 : size + i * 401, modified: `${date}T13:20:00Z`, extension: name.includes('.') ? name.split('.').pop() : '' }); }
    return entries;
  }
  function matchesDemoSearch(entry, q) {
    if (!q) return true;
    const file = entryKind(entry) === 'file'; const extension = entryExtension(entry);
    if (q === 'no extension') return file && !extension;
    if (q.startsWith('*.') && q.length > 2) return file && extension === q.slice(2);
    return `${entryName(entry)} ${entryPath(entry)} ${entry.host || ''} ${entry.share || ''} ${file && extension ? `.${extension}` : ''}`.toLowerCase().includes(q);
  }
  function filteredDemo() { const q = state.q.trim().toLowerCase(); const extension = state.extension.trim().toLowerCase().replace(/^\*?\./, ''); const list = state.demoEntries.filter((e) => matchesDemoSearch(e, q) && (!state.host || String(e.host || '').toLowerCase() === state.host.toLowerCase()) && (!state.share || String(e.share || '').toLowerCase() === state.share.toLowerCase()) && (!extension || (extension === '__none__' ? entryKind(e) === 'file' && !entryExtension(e) : entryKind(e) === 'file' && entryExtension(e) === extension)) && (!state.kind || entryKind(e) === state.kind)); list.sort((a, b) => { let left; let right; if (state.sort === 'extension') { left = extensionKey(a); right = extensionKey(b); } else if (state.sort === 'size') { left = a.size; right = b.size; } else if (state.sort === 'modified') { left = new Date(a.modified).getTime(); right = new Date(b.modified).getTime(); } else { left = String(a[state.sort] || ''); right = String(b[state.sort] || ''); } const result = typeof left === 'number' ? left - right : left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' }); return state.direction === 'desc' ? -result : result; }); return list; }
  function renderDemo() { const entries = filteredDemo(); state.stats = summarizeEntries(entries); state.total = entries.length; if (state.offset >= state.total && state.offset) state.offset = 0; state.entries = entries.slice(state.offset, state.offset + state.limit); render(); }
  function enterDemo() {
    if (isActive()) return; if (!state.demo) state.savedJob = state.job; stopPolling(); state.generation++; state.demo = true; state.demoEntries = demoData(); state.hostOffset = 0; resetQuery(); const hosts = [...new Set(state.demoEntries.map((e) => e.host))];
    state.job = { id: 'sample', status: 'completed', startedAt: '2026-11-03T15:00:00Z', finishedAt: '2026-11-03T15:00:24Z', targetsCount: hosts.length, completedHosts: hosts.length, filesCount: state.demoEntries.length, foldersCount: 0, sharesCount: new Set(state.demoEntries.map((entry) => `${entry.host}\0${entry.share}`)).size, entriesCount: state.demoEntries.length, totalBytes: state.demoEntries.reduce((sum, e) => sum + e.size, 0), truncated: false, hosts: hosts.map((host) => { const entries = state.demoEntries.filter((entry) => entry.host === host); return { host, status: 'completed', files: entries.length, shares: new Set(entries.map((entry) => entry.share)).size }; }), errors: [] };
    state.facets = { hosts, shares: [...new Set(state.demoEntries.map((e) => e.share))].sort(), extensions: [...new Set(state.demoEntries.map((entry) => extensionKey(entry) || '__none__'))].sort() }; notice(''); setTab('overview'); renderDemo();
  }
  function emptyWorkspace() { stopPolling(); state.generation++; state.demo = false; state.demoEntries = []; state.job = null; state.savedJob = null; state.entries = []; state.stats = null; state.total = 0; state.hostOffset = 0; state.lastUpdated = null; state.facets = { hosts: [], shares: [], extensions: [] }; resetQuery(); notice(''); render(); }
  async function exportData(format) {
    if (!state.job) return; const button = $(`export-${format}`); button.disabled = true;
    try {
      let blob;
      if (state.demo) { const entries = filteredDemo(); if (format === 'json') blob = new Blob([JSON.stringify({ sample: true, entries, stats: summarizeEntries(entries) }, null, 2)], { type: 'application/json' }); else { const keys = ['name','path','host','share','kind','size','modified']; const cell = (value) => { let text = String(value ?? ''); if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`; return `"${text.replace(/"/g, '""')}"`; }; blob = new Blob(['\uFEFF', keys.join(','), '\r\n', entries.map((entry) => keys.map((key) => cell(entry[key])).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }); } }
      else { const params = query(false); params.set('format', format); blob = await api(`/api/scans/${encodeURIComponent(state.job.id)}/export?${params}`, { blob: true }); }
      const url = URL.createObjectURL(blob); const link = el('a'); link.href = url; link.download = `smb-atlas-${state.demo ? 'sample-' : ''}${new Date().toISOString().slice(0, 10)}.${format}`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast(`${format.toUpperCase()} exported`);
    } catch (error) { notice(errorMessage(error)); } finally { renderStats(); }
  }
  async function validateTargets() { const button = $('validate-targets'); const output = $('target-validation'); if (!state.sessionReady) { output.textContent = 'The local service is unavailable.'; output.classList.add('invalid'); return; } button.disabled = true; output.textContent = 'Validating…'; output.classList.remove('invalid'); try { const result = await api('/api/targets', { method: 'POST', body: JSON.stringify({ targets: $('targets').value }) }); output.textContent = `${number(result.hostsCount)} unique hosts in scope`; output.title = (result.preview || []).join(', '); } catch (error) { output.textContent = errorMessage(error); output.classList.add('invalid'); } finally { button.disabled = false; } }
  function parseCSV(text) { const rows = []; let row = []; let cell = ''; let quoted = false; for (let i = 0; i < text.length; i++) { const c = text[i]; if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; } else if (!quoted && (c === ',' || c === '\n' || c === '\r')) { row.push(cell.trim()); cell = ''; if (c !== ',') { if (c === '\r' && text[i + 1] === '\n') i++; if (row.some(Boolean)) rows.push(row); row = []; } } else cell += c; } row.push(cell.trim()); if (row.some(Boolean)) rows.push(row); if (quoted) throw new Error('The CSV contains an unclosed quoted field.'); return rows; }
  async function importTargets(event) { const file = event.target.files?.[0]; if (!file) return; try { if (file.size > 2 * 1024 * 1024) throw new Error('Choose a target list smaller than 2 MB.'); let text = (await file.text()).replace(/^\uFEFF/, ''); if (/\.csv$/i.test(file.name)) { const rows = parseCSV(text); const headings = (rows[0] || []).map((value) => value.toLowerCase()); const column = headings.findIndex((value) => ['target','targets','ip','ip address','ipaddress','subnet','cidr','address'].includes(value)); text = column >= 0 ? rows.slice(1).map((row) => row[column] || '').filter(Boolean).join('\n') : rows.flat().filter(Boolean).join('\n'); } $('targets').value = [$('targets').value.trim(), text.trim()].filter(Boolean).join('\n'); $('target-validation').textContent = ''; toast('Target list imported. Validate to check the scope.'); } catch (error) { notice(errorMessage(error)); } finally { event.target.value = ''; } }
  $('toggle-setup').addEventListener('click', () => {
    const toggle = $('toggle-setup');
    const collapse = toggle.getAttribute('aria-expanded') === 'true';
    $('scan-configuration').hidden = collapse;
    document.querySelector('.workspace-grid').classList.toggle('setup-hidden', collapse);
    toggle.setAttribute('aria-expanded', String(!collapse));
    toggle.setAttribute('aria-label', `${collapse ? 'Show' : 'Hide'} scan settings`);
  });
  $('import-targets').addEventListener('click', () => $('target-file').click());
  $('scan-form').addEventListener('submit', async (event) => {
    event.preventDefault(); if (isActive() || !state.sessionReady) return; if (!$('scan-form').reportValidity()) return;
    const payload = { targets: $('targets').value, username: $('username').value.trim(), password: $('password').value, domain: $('domain').value.trim(), options: { maxDepth: Number($('max-depth').value), concurrency: Number($('concurrency').value), timeoutSeconds: Number($('timeout').value), includeHiddenShares: $('include-hidden').checked, includeFolders: $('include-folders').checked, shareNames: $('share-names').value.split(',').map((value) => value.trim()).filter(Boolean) } };
    $('scan-button').disabled = true; $('scan-button').querySelector('span').textContent = 'Starting…'; notice('');
    try { const result = await api('/api/scans', { method: 'POST', body: JSON.stringify(payload) }); $('password').value = ''; $('password').type = 'password'; $('toggle-password').textContent = 'Show'; $('toggle-password').setAttribute('aria-pressed', 'false'); $('toggle-password').setAttribute('aria-label', 'Show password'); stopPolling(); state.generation++; state.demo = false; state.demoEntries = []; state.job = result.job; state.entries = []; state.stats = null; state.total = 0; state.hostOffset = 0; state.facets = { hosts: [], shares: [], extensions: [] }; resetQuery(); setTab('overview', false, false); render(); await refresh(); }
    catch (error) { notice(errorMessage(error)); renderStats(); } finally { payload.password = ''; }
  });
  $('toggle-password').addEventListener('click', () => { const visible = $('password').type === 'password'; $('password').type = visible ? 'text' : 'password'; $('toggle-password').textContent = visible ? 'Hide' : 'Show'; $('toggle-password').setAttribute('aria-label', visible ? 'Hide password' : 'Show password'); $('toggle-password').setAttribute('aria-pressed', String(visible)); });
  $('targets').addEventListener('input', () => { $('target-validation').textContent = ''; });
  $('validate-targets').addEventListener('click', validateTargets); $('target-file').addEventListener('change', importTargets);
  $('demo-button').addEventListener('click', enterDemo); $('exit-demo').addEventListener('click', () => { const previousJob = state.savedJob; emptyWorkspace(); if (previousJob) { state.job = previousJob; refresh(); } });
  $('cancel-button').addEventListener('click', async () => { if (!isActive() || state.demo) return; $('cancel-button').disabled = true; try { const result = await api(`/api/scans/${encodeURIComponent(state.job.id)}/cancel`, { method: 'POST' }); if (result?.job) { state.job = result.job; if (Number.isSafeInteger(result.job.hostsOffset)) state.hostOffset = result.job.hostsOffset; } else state.job.status = 'cancelling'; render(); await refresh(); } catch (error) { notice(errorMessage(error)); $('cancel-button').disabled = false; } });
  $('clear-button').addEventListener('click', async () => { if (!state.job || isActive()) return; if (state.demo) { emptyWorkspace(); return; } $('clear-button').disabled = true; try { await api(`/api/scans/${encodeURIComponent(state.job.id)}`, { method: 'DELETE' }); emptyWorkspace(); toast('Inventory cleared'); } catch (error) { notice(errorMessage(error)); renderStats(); } });
  $('export-csv').addEventListener('click', () => exportData('csv')); $('export-json').addEventListener('click', () => exportData('json'));
  function searchChanged() { clearTimeout(searchTimer); invalidateResults(); state.q = $('search').value.trim(); state.offset = 0; state.loading = Boolean(state.job); renderQueryState(); searchTimer = setTimeout(() => refresh(), 200); }
  function clearSearch() { clearTimeout(searchTimer); $('search').value = ''; state.q = ''; state.offset = 0; refresh(); $('search').focus(); }
  $('search').addEventListener('input', searchChanged);
  $('search').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); clearTimeout(searchTimer); refresh(); } else if (event.key === 'Escape') { event.preventDefault(); clearSearch(); } });
  $('clear-search').addEventListener('click', clearSearch);
  $('all-files').addEventListener('click', () => { resetQuery(); state.hostOffset = 0; if (!['overview', 'files', 'types'].includes(state.tab)) setTab('overview', false, false); refresh(); });
  $('filter-toggle').addEventListener('click', () => { const open = $('filters').hidden; $('filters').hidden = !open; $('filter-toggle').setAttribute('aria-expanded', String(open)); });
  for (const key of ['host', 'share', 'extension', 'kind']) $(`filter-${key}`).addEventListener('change', (event) => { state[key] = event.target.value; state.offset = 0; updateFilterCount(); refresh(); });
  $('reset-filters').addEventListener('click', () => { for (const key of ['host','share','extension','kind']) { state[key] = ''; $(`filter-${key}`).value = ''; } state.offset = 0; updateFilterCount(); refresh(); });
  $('reset-search').addEventListener('click', () => { resetQuery(); refresh(); });
  $('reset-type-scope').addEventListener('click', () => { resetQuery(); refresh(); });
  $('reset-overview-scope').addEventListener('click', () => { resetQuery(); refresh(); });
  document.querySelectorAll('[data-sort]').forEach((button) => button.addEventListener('click', () => { state.direction = state.sort === button.dataset.sort && state.direction === 'asc' ? 'desc' : 'asc'; state.sort = button.dataset.sort; state.offset = 0; refresh(); }));
  document.querySelectorAll('[data-type-sort]').forEach((button) => button.addEventListener('click', () => { state.typeDirection = state.typeSort === button.dataset.typeSort && state.typeDirection === 'asc' ? 'desc' : 'asc'; state.typeSort = button.dataset.typeSort; renderSortControls(); renderFileTypes(); }));
  $('sort-by').addEventListener('change', (event) => { if (state.tab === 'types') { state.typeSort = event.target.value; renderFileTypes(); } else { state.sort = event.target.value; state.offset = 0; refresh(); } });
  $('sort-direction').addEventListener('click', () => { if (state.tab === 'types') { state.typeDirection = state.typeDirection === 'asc' ? 'desc' : 'asc'; renderSortControls(); renderFileTypes(); } else { state.direction = state.direction === 'asc' ? 'desc' : 'asc'; state.offset = 0; refresh(); } });
  $('page-size').addEventListener('change', () => { state.limit = Number($('page-size').value); state.offset = 0; refresh(); }); $('previous-page').addEventListener('click', () => { state.offset = Math.max(0, state.offset - state.limit); refresh(); }); $('next-page').addEventListener('click', () => { if (state.offset + state.limit < state.total) state.offset += state.limit; refresh(); });
  $('previous-host-page').addEventListener('click', () => { state.hostOffset = Math.max(0, state.hostOffset - state.hostLimit); refresh(); });
  $('next-host-page').addEventListener('click', () => { const total = state.job?.hostsTotal ?? state.job?.targetsCount ?? 0; if (state.hostOffset + state.hostLimit < total) { state.hostOffset += state.hostLimit; refresh(); } });
  document.querySelectorAll('[data-tab]').forEach((button) => { button.addEventListener('click', () => setTab(button.dataset.tab)); button.addEventListener('keydown', (event) => { const tabs = ['overview','files','types','hosts','errors']; const index = tabs.indexOf(state.tab); if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') { event.preventDefault(); setTab(tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length], true); } if (event.key === 'Home' || event.key === 'End') { event.preventDefault(); setTab(event.key === 'Home' ? 'overview' : 'errors', true); } }); });
  document.addEventListener('keydown', (event) => { if (event.key === '/' && !['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)) { event.preventDefault(); if (!['overview', 'files', 'types'].includes(state.tab)) setTab('overview'); $('search').focus(); } });
  window.addEventListener('pagehide', () => { $('password').value = ''; clearTimeout(searchTimer); invalidateResults(); });
  async function init() { setTab('overview'); render(); try { const session = await api('/api/session'); state.token = session.token; state.sessionReady = true; $('version').textContent = `v${String(session.version || '1.0').replace(/^v/, '')}`; $('targets').title = session.limits?.maxHosts == null ? 'No fixed host-count limit' : `Maximum ${number(session.limits.maxHosts)} hosts per scan`; if (state.demo && !ACTIVE.has(session.activeJob?.status)) state.savedJob = session.activeJob || null; else { state.demo = false; state.job = session.activeJob || null; } render(); if (state.job) await refresh(); } catch (error) { notice(`Could not connect to the local scanner. ${errorMessage(error)} Start the app and refresh this page.`); render(); } }
  init();
})();
