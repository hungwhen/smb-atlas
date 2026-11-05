(() => {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const palette = ['#315d49', '#648579', '#6d849a', '#b49359', '#a4b3aa', '#c9cec9'];
  const localState = new WeakMap();
  const numeric = (value) => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
  const count = (value) => numeric(value).toLocaleString();
  const size = (value) => {
    const n = numeric(value); if (!n) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const i = Math.max(0, Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024))));
    return `${(n / 1024 ** i).toLocaleString(undefined, { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`;
  };
  const compact = (value) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(numeric(value));
  const percent = (value, total) => `${(total ? numeric(value) / total * 100 : 0).toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
  const typeLabel = (value) => !value || value === '__none__' ? 'No extension' : String(value);
  const shorten = (value, length) => { const text = String(value || ''); return text.length > length ? `${text.slice(0, length - 1)}…` : text; };
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const svg = (tag, attributes = {}, text) => { const node = document.createElementNS(NS, tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value); if (text !== undefined) node.textContent = text; return node; };
  const title = (node, text) => node.append(svg('title', {}, text));
  const metricValue = (item, metric) => numeric(item[metric === 'files' ? 'filesCount' : 'totalBytes']);
  const metricText = (value, metric) => metric === 'files' ? count(value) : size(value);
  function action(node, label, key, handler) {
    node.dataset.overviewFocus = key;
    node.setAttribute('aria-label', label);
    if (node.namespaceURI === NS) {
      node.setAttribute('role', 'button'); node.setAttribute('tabindex', '0'); node.classList.add('overview-svg-action');
      node.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); handler(); } });
    } else node.type = 'button';
    node.addEventListener('click', handler);
    return node;
  }
  function chart(width, height, label) {
    return svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'overview-chart', role: 'img', 'aria-label': label });
  }
  function card(label, subtitle, className = '') {
    const node = el('section', `overview-card ${className}`); const head = el('div', 'overview-card-heading');
    const text = el('div'); text.append(el('h3', '', label), el('p', '', subtitle)); head.append(text); node.append(head);
    return { node, head };
  }
  function link(label, key, handler) { return action(el('button', 'overview-text-link', label), label, key, handler); }
  function empty(node, message) { const area = el('div', 'overview-chart-empty'); area.append(el('span', 'overview-empty-symbol', '—'), el('p', '', message)); node.append(area); }
  function noFiles(options, initial) {
    if (options.job && numeric(options.job.filesCount)) return 'No files match the current search and filters. Use All files to reset the scope.';
    if (options.job && !['running', 'cancelling'].includes(options.job.status)) return 'This scan has no indexed files to display.';
    return initial;
  }
  function summaryDetails(rows, label, headings) {
    const details = el('details', 'overview-data-details'); const summary = el('summary', '', label); summary.dataset.overviewFocus = 'size-range-data'; details.append(summary);
    const wrap = el('div', 'overview-data-wrap'); const table = el('table', 'overview-data-table'); const head = el('thead'); const tr = el('tr');
    headings.forEach((heading) => { const th = el('th', '', heading); th.scope = 'col'; tr.append(th); }); head.append(tr); const body = el('tbody');
    rows.forEach((values) => { const row = el('tr'); values.forEach((value) => row.append(el('td', '', value))); body.append(row); }); table.append(head, body); wrap.append(table); details.append(wrap); return details;
  }
  function drawTypes(stats, metric, options) {
    const { node, head } = card('File type mix', `${metric === 'files' ? 'Files' : 'Storage'} across all matching file types`);
    head.append(link('All types ↗', 'types-all', () => options.onTab?.('types')));
    const sorted = [...(stats.types || [])].sort((a, b) => metricValue(b, metric) - metricValue(a, metric) || typeLabel(a.extension).localeCompare(typeLabel(b.extension)));
    if (!sorted.length) { empty(node, noFiles(options, 'File types appear as files are indexed.')); return node; }
    const groups = sorted.slice(0, 5).map((item) => ({ ...item, label: typeLabel(item.extension) }));
    if (sorted.length > 5) groups.push(sorted.slice(5).reduce((acc, item) => ({ ...acc, filesCount: acc.filesCount + numeric(item.filesCount), totalBytes: acc.totalBytes + numeric(item.totalBytes) }), { label: 'Other types', other: true, filesCount: 0, totalBytes: 0 }));
    const total = groups.reduce((sum, item) => sum + metricValue(item, metric), 0); const wrap = el('div', 'overview-type-layout');
    const figure = el('figure', 'overview-donut-figure');
    const drawing = chart(240, 240, `File type mix by ${metric === 'files' ? 'file count' : 'storage'}. ${groups.map((item) => `${item.label}: ${metricText(metricValue(item, metric), metric)}`).join('; ')}.`);
    drawing.setAttribute('role', 'group');
    drawing.append(svg('circle', { cx: 120, cy: 120, r: 86, fill: 'none', stroke: '#eef1ee', 'stroke-width': 24 }));
    let offset = 0; const circumference = Math.PI * 172;
    groups.forEach((item, index) => {
      const value = metricValue(item, metric); if (!value || !total) return;
      const length = value / total * circumference; const segment = svg('circle', { cx: 120, cy: 120, r: 86, fill: 'none', stroke: palette[index], 'stroke-width': 24, 'stroke-linecap': 'butt', 'stroke-dasharray': `${length} ${circumference - length}`, 'stroke-dashoffset': -offset, transform: 'rotate(-90 120 120)' });
      const label = `${item.label}: ${count(item.filesCount)} files, ${size(item.totalBytes)}, ${percent(value, total)} of ${metric === 'files' ? 'files' : 'storage'}`;
      title(segment, label);
      action(segment, label + (item.other ? '. See all file types.' : '. View files.'), `type-slice-${item.other ? 'other' : item.extension || '__none__'}`, () => item.other ? options.onTab?.('types') : options.onFilter?.({ extension: item.extension || '__none__', kind: 'file' })); drawing.append(segment); offset += length;
    });
    drawing.append(svg('text', { x: 120, y: 116, 'text-anchor': 'middle', class: 'overview-donut-total' }, metricText(total, metric)), svg('text', { x: 120, y: 140, 'text-anchor': 'middle', class: 'overview-donut-label' }, metric === 'files' ? 'matching files' : 'matching storage'));
    figure.append(drawing); if (!total && metric === 'bytes') figure.append(el('figcaption', 'overview-muted', 'All matching files are empty. Switch to Files to compare types.'));
    const legend = el('ul', 'overview-type-legend');
    groups.forEach((item, index) => {
      const li = el('li'); const button = action(el('button', 'overview-type-key'), `${item.other ? 'See all file types; other types contain' : `View ${item.label}:`} ${count(item.filesCount)} files, ${size(item.totalBytes)}`, `type-key-${item.other ? 'other' : item.extension || '__none__'}`, () => item.other ? options.onTab?.('types') : options.onFilter?.({ extension: item.extension || '__none__', kind: 'file' }));
      const dot = el('span', 'overview-color-dot'); dot.style.background = palette[index]; dot.setAttribute('aria-hidden', 'true');
      const text = el('span', 'overview-key-name'); text.append(el('strong', '', item.label), el('span', '', `${count(item.filesCount)} files · ${size(item.totalBytes)}`));
      button.append(dot, text, el('span', 'overview-key-percent', percent(metricValue(item, metric), total))); li.append(button); legend.append(li);
    });
    wrap.append(figure, legend); node.append(wrap); return node;
  }
  const buckets = [
    ['empty', 'Empty files', '0 B'], ['under1mb', 'Under 1 MB', '<1 MB'], ['1to10mb', '1–10 MB', '1–10 MB'],
    ['10to100mb', '10–100 MB', '10–100 MB'], ['100mbto1gb', '100 MB–1 GB', '100 MB–1 GB'], ['1gbplus', '1 GB and larger', '≥1 GB']
  ];
  function niceMaximum(value) { if (!value) return 1; const power = 10 ** Math.floor(Math.log10(value)); const scaled = value / power; return (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 4 ? 4 : scaled <= 5 ? 5 : 10) * power; }
  function drawSizes(stats, metric, options) {
    const { node, head } = card('File size distribution', `${metric === 'files' ? 'Number of files' : 'Total storage'} in each size range`);
    head.append(el('span', 'overview-unit-label', metric === 'files' ? 'Files' : 'Storage'));
    const items = buckets.map(([id, label, short]) => ({ ...(stats.sizeBuckets || []).find((item) => item.id === id), id, label, short }));
    if (!numeric(stats.filesCount)) { empty(node, noFiles(options, 'Size ranges appear as files are indexed.')); return node; }
    const drawing = chart(560, 270, `File size distribution by ${metric === 'files' ? 'file count' : 'storage'}. ${items.map((item) => `${item.label}: ${metricText(metricValue(item, metric), metric)}`).join('; ')}.`);
    const left = 65, right = 548, top = 24, bottom = 218; let max = niceMaximum(Math.max(...items.map((item) => metricValue(item, metric))));
    if (metric === 'files' || max < 1024) max = Math.max(4, Math.ceil(max / 4) * 4);
    for (let tick = 0; tick <= 4; tick++) {
      const y = bottom - (bottom - top) * tick / 4; drawing.append(svg('line', { x1: left, x2: right, y1: y, y2: y, class: 'overview-grid-line' }));
      drawing.append(svg('text', { x: left - 10, y: y + 4, 'text-anchor': 'end', class: 'overview-axis-label' }, metric === 'files' ? compact(max * tick / 4) : size(max * tick / 4)));
    }
    const step = (right - left) / items.length;
    items.forEach((item, index) => {
      const value = metricValue(item, metric); const height = value / max * (bottom - top); const x = left + step * index + step * .2; const y = bottom - height;
      const rect = svg('rect', { x, y, width: step * .6, height, rx: Math.min(4, height / 2), fill: index % 2 ? '#648579' : '#315d49', class: 'overview-size-bar' });
      title(rect, `${item.label}: ${count(item.filesCount)} files, ${size(item.totalBytes)}`); drawing.append(rect);
      drawing.append(svg('text', { x: x + step * .3, y: Math.max(top - 7, y - 8), 'text-anchor': 'middle', class: 'overview-bar-value' }, metric === 'files' ? compact(value) : size(value)));
      const label = svg('text', { x: x + step * .3, y: bottom + 24, 'text-anchor': 'middle', class: 'overview-axis-label overview-axis-category' });
      if (item.id === '100mbto1gb') { label.append(svg('tspan', { x: x + step * .3, dy: 0 }, '100 MB–'), svg('tspan', { x: x + step * .3, dy: 14 }, '1 GB')); } else label.textContent = item.short;
      drawing.append(label);
    });
    const scroller = el('div', 'overview-histogram-scroll'); scroller.append(drawing);
    node.append(scroller, summaryDetails(items.map((item) => [item.label, count(item.filesCount), size(item.totalBytes)]), 'View size-range data', ['File size range', 'Files', 'Storage'])); return node;
  }
  function drawHosts(stats, metric, options) {
    const { node, head } = card('Storage by host', `${metric === 'files' ? 'File count' : 'Storage'} · top 8 hosts and remaining hosts`);
    head.firstChild.firstChild.textContent = metric === 'files' ? 'Files by host' : 'Storage by host';
    head.append(link('All hosts ↗', 'hosts-all', () => options.onTab?.('hosts')));
    const all = [...(stats.hosts || [])].sort((a, b) => metricValue(b, metric) - metricValue(a, metric) || String(a.host).localeCompare(String(b.host)));
    if (!all.length) { empty(node, noFiles(options, 'Host comparisons appear when files are indexed.')); return node; }
    const items = all.slice(0, 8).map((item) => ({ ...item, label: item.host }));
    if (all.length > 8) items.push(all.slice(8).reduce((acc, item) => ({ ...acc, filesCount: acc.filesCount + numeric(item.filesCount), totalBytes: acc.totalBytes + numeric(item.totalBytes) }), { label: `Other hosts (${count(all.length - 8)})`, other: true, filesCount: 0, totalBytes: 0 }));
    const max = Math.max(...items.map((item) => metricValue(item, metric)), 1); const total = all.reduce((sum, item) => sum + metricValue(item, metric), 0);
    const list = el('ol', 'overview-host-bars');
    items.forEach((item, index) => {
      const li = el('li'); const button = action(el('button', 'overview-host-bar'), `${item.other ? 'See all host activity;' : 'View'} ${item.label}: ${count(item.filesCount)} files, ${size(item.totalBytes)}, ${percent(metricValue(item, metric), total)} of matching ${metric === 'files' ? 'files' : 'storage'}`, `host-bar-${item.other ? 'other' : item.host}`, () => item.other ? options.onTab?.('hosts') : options.onFilter?.({ host: item.host, kind: 'file' }));
      const row = el('span', 'overview-bar-heading'); row.append(el('span', 'overview-host-name', item.label), el('strong', '', metricText(metricValue(item, metric), metric)));
      const track = el('span', 'overview-host-track'); const fill = el('span', 'overview-host-fill'); fill.style.width = `${metricValue(item, metric) / max * 100}%`; if (item.other) fill.classList.add('overview-fill-other'); track.append(fill); track.setAttribute('aria-hidden', 'true');
      button.append(row, track); li.append(button); list.append(li);
    });
    node.append(list, el('p', 'overview-card-note', 'Select a host to explore its files. Bars share a zero baseline.')); return node;
  }
  function drawHealth(job, options) {
    const { node, head } = card('Scan health', 'All targets in this scan · independent of file filters');
    head.append(link('Host activity ↗', 'health-all', () => options.onTab?.('hosts')));
    const hosts = job?.hosts || [];
    if (!job) { empty(node, 'Start a scan to see target outcomes and live activity.'); return node; }
    const groups = [
      { id: 'completed', label: 'Completed', color: '#315d49', statuses: ['completed'] },
      { id: 'partial', label: 'With issues', color: '#b49359', statuses: ['partial'] },
      { id: 'failed', label: 'Failed / unreachable', color: '#a7625d', statuses: ['failed', 'unreachable'] },
      { id: 'active', label: 'Active', color: '#6d849a', statuses: ['probing', 'scanning'] },
      { id: 'queued', label: 'Queued', color: '#c9cec9', statuses: ['queued'] },
      { id: 'cancelled', label: 'Stopped', color: '#8a8f8b', statuses: ['cancelled'] }
    ].map((group) => ({ ...group, count: job.hostStatusCounts
      ? group.statuses.reduce((sum, status) => sum + numeric(job.hostStatusCounts[status]), 0)
      : hosts.filter((host) => group.statuses.includes(host.status)).length }));
    const identified = groups.reduce((sum, group) => sum + group.count, 0); const expected = Math.max(hosts.length, numeric(job.targetsCount));
    if (expected > identified) groups.push({ id: 'pending', label: 'Pending / other', color: '#e5e8e5', count: expected - identified });
    const total = groups.reduce((sum, group) => sum + group.count, 0);
    if (!total) { empty(node, 'No scan targets to summarize.'); return node; }
    const finished = groups.filter((group) => ['completed', 'partial', 'failed', 'cancelled'].includes(group.id)).reduce((sum, group) => sum + group.count, 0);
    const score = el('div', 'overview-health-score'); const primary = el('div'); primary.append(el('strong', '', percent(finished, total)), el('span', '', 'targets processed'));
    const secondary = el('div', 'overview-health-total'); secondary.append(el('strong', '', `${count(finished)} / ${count(total)}`), el('span', '', 'hosts')); score.append(primary, secondary); node.append(score);
    const stacked = el('div', 'overview-health-bar'); stacked.setAttribute('role', 'img'); stacked.setAttribute('aria-label', groups.map((group) => `${group.label}: ${count(group.count)} targets`).join('; '));
    groups.forEach((group) => { if (!group.count) return; const segment = el('span'); segment.style.width = `${group.count / total * 100}%`; segment.style.background = group.color; segment.title = `${group.label}: ${count(group.count)} (${percent(group.count, total)})`; stacked.append(segment); }); node.append(stacked);
    const legend = el('ul', 'overview-health-legend'); groups.filter((group) => group.count || group.id !== 'pending').forEach((group) => { const item = el('li'); const dot = el('span', 'overview-color-dot'); dot.style.background = group.color; dot.setAttribute('aria-hidden', 'true'); item.append(dot, el('span', '', group.label), el('strong', '', count(group.count))); legend.append(item); }); node.append(legend);
    node.append(el('p', 'overview-card-note', 'Processed includes completed, completed with issues, failed, unreachable, and stopped targets.')); return node;
  }
  function drawMap(stats, metric, current, options, container) {
    const { node, head } = card('Share map', 'Select a host to trace its matching files across shares', 'overview-card-wide');
    const hosts = [...(stats.hosts || [])].sort((a, b) => metricValue(b, metric) - metricValue(a, metric) || String(a.host).localeCompare(String(b.host)));
    if (!hosts.length) { empty(node, noFiles(options, 'A map of hosts and shares appears as files are indexed.')); return node; }
    if (!hosts.some((host) => host.host === current.host)) current.host = hosts[0].host;
    const picker = el('div', 'overview-host-picker'); const label = el('label', '', 'Host'); const select = el('select'); select.dataset.overviewFocus = 'map-host'; select.setAttribute('aria-label', 'Host shown in share map');
    // Bound the option list, rather than recreating thousands of DOM nodes on every poll.
    const pageSize = 100; const query = (current.hostQuery || '').toLowerCase();
    const choices = query ? hosts.filter((host) => String(host.host).toLowerCase().includes(query)) : hosts;
    current.hostPage = Math.max(0, Math.min(current.hostPage || 0, Math.ceil(choices.length / pageSize) - 1));
    const offset = current.hostPage * pageSize; const page = choices.slice(offset, offset + pageSize);
    if (!page.some((host) => host.host === current.host)) {
      const placeholder = el('option', '', choices.length ? 'Choose a host…' : 'No matching hosts'); placeholder.value = ''; placeholder.disabled = true; select.append(placeholder);
    }
    page.forEach((host) => { const option = el('option', '', host.host); option.value = host.host; select.append(option); }); select.value = page.some((host) => host.host === current.host) ? current.host : ''; select.disabled = !page.length;
    select.addEventListener('change', () => { current.host = select.value; render(container, options); }); label.append(select); picker.append(label); head.append(picker);
    if (hosts.length > pageSize) {
      const searchLabel = el('label', 'overview-host-search-label', 'Find host'); const search = el('input'); search.type = 'search'; search.value = current.hostQuery || ''; search.placeholder = 'Search IP address'; search.dataset.overviewFocus = 'map-host-search'; search.setAttribute('aria-label', 'Search hosts in the share map');
      search.addEventListener('input', () => { current.hostQuery = search.value; current.hostPage = 0; render(container, options); }); searchLabel.append(search); picker.prepend(searchLabel);
      const paging = el('div', 'overview-map-paging'); const previous = action(el('button', 'overview-text-link', 'Previous'), 'Previous share-map hosts', 'map-host-previous', () => { current.hostPage--; render(container, options); }); previous.disabled = current.hostPage === 0;
      const next = action(el('button', 'overview-text-link', 'Next'), 'Next share-map hosts', 'map-host-next', () => { current.hostPage++; render(container, options); }); next.disabled = offset + pageSize >= choices.length;
      paging.append(previous, el('span', '', choices.length ? `${count(offset + 1)}–${count(Math.min(offset + pageSize, choices.length))} of ${count(choices.length)}` : 'No matches'), next); picker.append(paging);
    }
    const host = hosts.find((item) => item.host === current.host);
    const rankedByFiles = metric === 'files' && Array.isArray(host.sharesByFiles);
    const shareRows = rankedByFiles ? host.sharesByFiles : host.shares;
    const otherShares = rankedByFiles ? host.otherSharesByFiles : host.otherShares;
    const shares = [...(shareRows || [])].map((item) => ({ ...item, label: item.share }));
    if (numeric(otherShares?.sharesCount)) shares.push({ ...otherShares, label: `${count(otherShares.sharesCount)} other shares`, other: true });
    if (!shares.length) { empty(node, 'This host has no matching shares to map.'); return node; }
    const height = Math.max(192, shares.length * 76 + 32); const center = height / 2; const firstY = (height - (shares.length - 1) * 76) / 2;
    const scroller = el('div', 'overview-map-scroll'); scroller.setAttribute('tabindex', '0'); scroller.setAttribute('aria-label', 'Scrollable share map'); scroller.dataset.overviewFocus = 'map-scroll';
    const drawing = chart(790, height, `Share map for ${host.host}: ${shares.map((item) => `${item.label}: ${count(item.filesCount)} files, ${size(item.totalBytes)}`).join('; ')}.`); drawing.setAttribute('role', 'group'); drawing.classList.add('overview-share-map');
    drawing.append(svg('path', { d: `M 241 ${center} H 317 M 317 ${firstY} V ${firstY + (shares.length - 1) * 76}`, class: 'overview-map-connector' }));
    const hostNode = svg('g'); hostNode.append(svg('rect', { x: 18, y: center - 40, width: 223, height: 80, rx: 9, class: 'overview-map-host-box' }), svg('circle', { cx: 39, cy: center - 14, r: 3, fill: '#648579' }), svg('text', { x: 51, y: center - 10, class: 'overview-map-host-label' }, shorten(host.host, 25)), svg('text', { x: 39, y: center + 15, class: 'overview-map-host-detail' }, `${count(host.filesCount)} files · ${size(host.totalBytes)}`));
    title(hostNode, `${host.host}: ${count(host.filesCount)} files, ${size(host.totalBytes)}. View host files.`);
    action(hostNode, `View all matching files on ${host.host}`, 'map-host-node', () => options.onFilter?.({ host: host.host, kind: 'file' })); drawing.append(hostNode);
    shares.forEach((share, index) => {
      const y = firstY + index * 76; drawing.append(svg('path', { d: `M 317 ${y} H 370`, class: 'overview-map-connector' }), svg('circle', { cx: 317, cy: y, r: 3, fill: '#b6c5ba', stroke: 'none' }));
      const group = svg('g'); group.append(svg('rect', { x: 370, y: y - 29, width: 390, height: 58, rx: 7, class: 'overview-map-share-box' }), svg('rect', { x: 386, y: y - 9, width: 18, height: 15, rx: 2, class: 'overview-map-folder' }), svg('path', { d: `M 386 ${y - 9} V ${y - 12} H 394 L 397 ${y - 9}`, class: 'overview-map-folder-tab' }), svg('text', { x: 418, y: y - 3, class: 'overview-map-share-label' }, shorten(share.label || 'Unnamed share', 39)), svg('text', { x: 418, y: y + 15, class: 'overview-map-share-detail' }, `${count(share.filesCount)} files · ${size(share.totalBytes)}`));
      title(group, `${host.host} / ${share.label}: ${count(share.filesCount)} files, ${size(share.totalBytes)}${share.other ? '. Remaining shares grouped together. View all host files to explore these shares.' : '. View share files.'}`);
      action(group, share.other ? `View all host files to explore ${share.label} on ${host.host}` : `View files in ${host.host} / ${share.label}`, `map-share-${host.host}/${share.other ? '__other__' : share.share}`, () => options.onFilter?.({ host: host.host, ...(share.other ? {} : { share: share.share }), kind: 'file' })); drawing.append(group);
    });
    scroller.append(drawing); node.append(scroller, el('p', 'overview-card-note', `Host → share → indexed files. Select a node to explore. The 6 shares with the most ${rankedByFiles ? 'files' : 'storage'} are shown separately; remaining shares are grouped. Select the grouped shares to open all files on this host.`));
    return node;
  }
  function render(container, options = {}) {
    if (!container) return;
    const oldFocus = container.contains(document.activeElement) ? document.activeElement.dataset.overviewFocus : null;
    const oldSelection = oldFocus && typeof document.activeElement.selectionStart === 'number' ? [document.activeElement.selectionStart, document.activeElement.selectionEnd] : null;
    const oldMap = container.querySelector('.overview-map-scroll'); const scrollLeft = oldMap?.scrollLeft || 0;
    const oldHistogram = container.querySelector('.overview-histogram-scroll'); const histogramScroll = oldHistogram?.scrollLeft || 0;
    const stats = options.stats || {}; const metric = options.metric === 'files' ? 'files' : 'bytes';
    const scopeKey = options.scopeKey ?? options.job?.id ?? null;
    let current = localState.get(container);
    const scopeChanged = !current || current.scopeKey !== scopeKey;
    if (scopeChanged) { current = { host: '', hostQuery: '', hostPage: 0, detailsOpen: false, scopeKey }; localState.set(container, current); }
    const oldDetails = container.querySelector('.overview-data-details'); if (oldDetails && !scopeChanged) current.detailsOpen = oldDetails.open;
    const heading = el('div', 'overview-heading'); const copy = el('div'); copy.append(el('h2', '', 'Visual overview'), el('p', '', 'All matching files, across every results page. Select a chart to explore.'));
    const switcher = el('div', 'overview-metric-switch'); switcher.setAttribute('role', 'group'); switcher.setAttribute('aria-label', 'Measure shown in charts');
    [['bytes', 'Storage'], ['files', 'Files']].forEach(([key, label]) => { const button = action(el('button', key === metric ? 'overview-metric-active' : '', label), `Compare by ${label.toLowerCase()}`, `metric-${key}`, () => options.onMetricChange?.(key)); button.setAttribute('aria-pressed', String(key === metric)); switcher.append(button); }); heading.append(copy, switcher);
    const grid = el('div', 'overview-grid');
    grid.append(drawTypes(stats, metric, options), drawSizes(stats, metric, options), drawHosts(stats, metric, options), drawHealth(options.job, options), drawMap(stats, metric, current, options, container));
    container.replaceChildren(heading, grid);
    const newMap = container.querySelector('.overview-map-scroll'); if (newMap) newMap.scrollLeft = scopeChanged ? 0 : scrollLeft;
    const newHistogram = container.querySelector('.overview-histogram-scroll'); if (newHistogram) newHistogram.scrollLeft = histogramScroll;
    const newDetails = container.querySelector('.overview-data-details'); if (newDetails) newDetails.open = current.detailsOpen;
    if (oldFocus) { const nextFocus = [...container.querySelectorAll('[data-overview-focus]')].find((node) => node.dataset.overviewFocus === oldFocus); nextFocus?.focus({ preventScroll: true }); if (oldSelection && nextFocus?.setSelectionRange) nextFocus.setSelectionRange(...oldSelection); }
  }
  window.SMBAtlasOverview = Object.freeze({ render });
})();
