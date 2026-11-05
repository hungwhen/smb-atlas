import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { queryEntries, inventoryStats } from '../lib/inventory.mjs';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const decode = value => value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

// A small DOM adapter runs the production app script and its actual event handlers.
// Browser layout and SVG drawing are checked separately; these tests cover UI state.
function documentFixture() {
  const document = { activeElement: null, listeners: new Map() };
  class Node {
    constructor(tag = '#text', text = '') { this.tagName = tag.toUpperCase(); this.childNodes = []; this.parentNode = null; this.attributes = new Map(); this.dataset = {}; this.style = {}; this.listeners = new Map(); this._text = text; this._value = null; this.hidden = false; this.disabled = false; this.checked = false; }
    get children() { return this.childNodes.filter(node => !node.tagName.startsWith('#')); }
    get firstElementChild() { return this.children[0] || null; }
    get textContent() { return this._text + this.childNodes.map(node => node.textContent).join(''); }
    set textContent(value) { this._text = String(value); this.childNodes = []; }
    get className() { return this.attributes.get('class') || ''; }
    set className(value) { this.attributes.set('class', value); }
    get classList() { return { contains: value => this.className.split(/\s+/).includes(value), toggle: (value, force) => { const classes = new Set(this.className.split(/\s+/).filter(Boolean)); const active = force ?? !classes.has(value); if (active) classes.add(value); else classes.delete(value); this.className = [...classes].join(' '); return active; }, add: value => this.classList.toggle(value, true), remove: value => this.classList.toggle(value, false) }; }
    get value() { if (this.tagName === 'SELECT') { const options = this.querySelectorAll('option'); const wanted = this._value ?? options.find(node => node.attributes.has('selected'))?.value ?? options[0]?.value ?? ''; return options.some(node => node.value === wanted) ? wanted : ''; } return this._value ?? this.attributes.get('value') ?? (this.tagName === 'OPTION' ? this.textContent : ''); }
    set value(value) { const text = String(value); this._value = this.tagName === 'SELECT' && !this.querySelectorAll('option').some(node => node.value === text) ? '' : text; }
    set innerHTML(value) { this.replaceChildren(new Node('svg', value)); }
    append(...nodes) { for (let node of nodes) { if (typeof node !== 'object') node = new Node('#text', String(node)); if (node.tagName === '#FRAGMENT') this.append(...node.childNodes); else { node.parentNode = this; this.childNodes.push(node); } } }
    replaceChildren(...nodes) { this.childNodes = []; this._text = ''; this.append(...nodes); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'hidden') this.hidden = true; if (name === 'disabled') this.disabled = true; if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    removeAttribute(name) { this.attributes.delete(name); }
    matches(selector) { if (selector.startsWith('#')) return this.getAttribute('id') === selector.slice(1); if (selector.startsWith('.')) return this.classList.contains(selector.slice(1)); if (selector.startsWith('[')) return this.attributes.has(selector.slice(1, -1)); return this.tagName === selector.toUpperCase(); }
    querySelectorAll(selector) { const parts = selector.trim().split(/\s+/); const matches = []; const visit = node => { for (const child of node.children) { if (child.matches(parts.at(-1)) && (parts.length === 1 || child.closest(parts[0]))) matches.push(child); visit(child); } }; visit(this); return matches; }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) { for (let node = this; node; node = node.parentNode) if (node.matches(selector)) return node; return null; }
    addEventListener(type, handler) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(handler); }
    async dispatch(type, extra = {}) { const event = { target: this, key: '', preventDefault() {}, ...extra }; await Promise.all((this.listeners.get(type) || []).map(handler => handler(event))); }
    focus() { document.activeElement = this; }
    click() { return this.dispatch('click'); }
    reportValidity() { return true; }
    remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(node => node !== this); }
  }
  const root = new Node('#document'); const stack = [root]; const voids = new Set(['META', 'LINK', 'INPUT', 'BR', 'HR']);
  for (const token of html.matchAll(/<\/?[a-z][^>]*>|[^<]+/gi)) {
    const text = token[0]; if (!text.startsWith('<')) { stack.at(-1).append(new Node('#text', decode(text))); continue; }
    const tag = text.match(/^<\/?([\w-]+)/)[1].toUpperCase();
    if (text.startsWith('</')) { const index = stack.findLastIndex(node => node.tagName === tag); if (index > 0) stack.length = index; continue; }
    const node = new Node(tag); for (const attribute of text.matchAll(/([\w-]+)(?:="([^"]*)")?/g)) { if (attribute.index <= 1) continue; node.setAttribute(attribute[1], decode(attribute[2] || '')); }
    stack.at(-1).append(node); if (!voids.has(tag) && !text.endsWith('/>')) stack.push(node);
  }
  document.getElementById = id => root.querySelector(`#${id}`);
  document.querySelectorAll = selector => root.querySelectorAll(selector);
  document.querySelector = selector => root.querySelector(selector);
  document.createElement = tag => new Node(tag);
  document.createTextNode = text => new Node('#text', String(text));
  document.createDocumentFragment = () => new Node('#fragment');
  document.body = root.querySelector('body'); document.activeElement = document.body;
  document.addEventListener = (type, handler) => document.listeners.set(type, handler);
  return document;
}

const entries = [
  { name: 'report', path: '\\\\192.0.2.1\\Finance\\report', host: '192.0.2.1', share: 'Finance', kind: 'file', extension: '.PDF', size: 100, modified: '2026-11-01' },
  { name: 'notes.txt', path: '\\\\192.0.2.2\\Docs\\notes.txt', host: '192.0.2.2', share: 'Docs', kind: 'file', extension: 'txt', size: 20, modified: '2026-11-01' },
  { name: 'README', path: '\\\\192.0.2.2\\Docs\\README', host: '192.0.2.2', share: 'Docs', kind: 'file', extension: '', size: 0, modified: '2026-11-01' },
];
const job = { id: 'fixture', status: 'completed', startedAt: '2026-11-01', finishedAt: '2026-11-01', targetsCount: 2, completedHosts: 2, filesCount: 3, foldersCount: 0, sharesCount: 2, totalBytes: 120, entriesCount: 3, errors: [], hosts: [{ host: '192.0.2.1', status: 'completed', files: 1, shares: 1 }, { host: '192.0.2.2', status: 'completed', files: 2, shares: 1 }] };
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

async function fixture() {
  const document = documentFixture(); const requests = []; const timers = new Map(); const charts = []; let timerId = 0; let override;
  const response = value => ({ ok: true, status: 200, json: async () => value });
  const inventory = path => { const params = new URL(path, 'http://fixture').searchParams; if (['hosts', 'errors'].includes(params.get('view'))) return { job: structuredClone(job), entries: [], total: 0, stats: null, facets: null }; const filtered = queryEntries(entries, params); const offset = Number(params.get('offset') || 0); return { job: structuredClone(job), entries: filtered.slice(offset, offset + Number(params.get('limit') || 50)), total: filtered.length, stats: inventoryStats(filtered), facets: { hosts: ['192.0.2.1', '192.0.2.2'], shares: ['Finance', 'Docs'], extensions: ['.pdf', '.txt', '__none__'] } }; };
  const fetch = async (path, options = {}) => { requests.push({ path, options }); if (path === '/api/session') return response({ token: 'fixture-token', limits: { maxHosts: null }, activeJob: structuredClone(job) }); if (override) { const custom = override(path, options); if (custom) return custom; } return response(inventory(path)); };
  const window = { SMBAtlasOverview: { render: (_node, options) => charts.push(options) }, addEventListener() {} };
  const context = vm.createContext({ document, window, fetch, URLSearchParams, URL, AbortController, Intl, Date, Blob, navigator: { clipboard: { writeText: async () => {} } }, setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; }, clearTimeout: id => timers.delete(id), console });
  vm.runInContext(script, context, { filename: 'public/app.js' }); await flush();
  return { document, requests, charts, response, inventory, setOverride: value => { override = value; }, node: id => document.getElementById(id), async input(value) { const search = document.getElementById('search'); search.value = value; await search.dispatch('input'); }, async debounce() { for (const [id, timer] of [...timers]) if (timer.delay === 200) { timers.delete(id); timer.callback(); } await flush(); } };
}

test('All files resets an empty search and every chart filter while preserving inventory', async () => {
  const ui = await fixture(); ui.charts.at(-1).onFilter({ host: '192.0.2.1', share: 'Finance', extension: '.pdf', kind: 'file' }); await flush();
  assert.equal(ui.node('filter-host').value, '192.0.2.1'); assert.equal(ui.node('filter-share').value, 'Finance'); assert.equal(ui.node('filter-extension').value, '.pdf');
  await ui.input('does-not-exist'); await ui.debounce(); assert.equal(ui.node('no-results').hidden, false);
  await ui.node('all-files').click(); await flush();
  assert.equal(ui.node('search').value, ''); for (const key of ['host', 'share', 'extension', 'kind']) assert.equal(ui.node(`filter-${key}`).value, '');
  assert.equal(ui.node('inventory-scope').textContent, 'All files and folders'); assert.equal(ui.node('file-rows').children.length, 3); assert.equal(ui.node('no-results').hidden, true);
  assert.equal(ui.requests.some(request => request.options.method === 'DELETE'), false);
});

test('All files also resets chart-local state when the inventory scope is already unfiltered', async () => {
  const ui = await fixture(); const previous = ui.charts.at(-1).scopeKey;
  await ui.node('all-files').click(); await flush();
  assert.notEqual(ui.charts.at(-1).scopeKey, previous);
  assert.equal(ui.charts.at(-1).stats.filesCount, 3);
  assert.equal(ui.node('inventory-scope').textContent, 'All files and folders');
  assert.equal(ui.requests.some(request => request.options.method === 'DELETE'), false);
});

test('search text, exact file types and extensionless search update the visible File types view', async () => {
  const ui = await fixture(); await ui.node('tab-types').click(); await flush();
  for (const q of ['pdf', '.PDF', '*.pdf', 'no extension']) { await ui.input(q); await ui.debounce(); assert.equal(ui.node('types-files-count').textContent, '1', q); assert.equal(ui.node('type-rows').children.length, 1, q); }
  await ui.node('clear-search').click(); await flush(); assert.equal(ui.node('types-files-count').textContent, '3');
});

test('typing invalidates in-flight results immediately, before the search debounce', async () => {
  const ui = await fixture(); let resolveOld; const oldResponse = new Promise(resolve => { resolveOld = resolve; });
  ui.setOverride(path => path.includes('q=old') ? oldResponse : null);
  await ui.input('old'); await ui.debounce(); const oldRequest = ui.requests.at(-1);
  await ui.input('*.pdf'); assert.equal(oldRequest.options.signal.aborted, true);
  const stale = ui.inventory('/api/scans/fixture'); stale.total = 99; stale.stats.filesCount = 99;
  resolveOld(ui.response(stale)); await flush();
  assert.match(ui.node('inventory-scope').textContent, /\*\.pdf/); assert.equal(ui.node('inventory-results').getAttribute('aria-busy'), 'true');
  assert.equal(ui.charts.at(-1).stats.filesCount, 3);
  await ui.debounce(); assert.equal(ui.node('inventory-status').textContent, '1 matching entries');
});

test('each tab fetches its view and only the visible table is rebuilt', async () => {
  const ui = await fixture(); await ui.node('tab-hosts').click(); await flush(); assert.match(ui.requests.at(-1).path, /view=hosts/);
  assert.equal(ui.node('host-rows').children.length, 2); assert.equal(ui.node('file-rows').children.length, 0);
  await ui.node('tab-files').click(); await flush(); assert.match(ui.requests.at(-1).path, /view=files/); assert.equal(ui.node('file-rows').children.length, 3);
});

test('a failed query leaves an honest error state and All files recovers without reloading', async () => {
  const ui = await fixture();
  ui.setOverride(path => path.includes('q=failure') ? Promise.resolve({ ok: false, status: 500, json: async () => ({ error: 'Fixture query failed.' }) }) : null);
  await ui.input('failure'); await ui.debounce();
  assert.equal(ui.node('inventory-status').textContent, 'Could not update this view'); assert.equal(ui.node('inventory-results').getAttribute('aria-busy'), 'false'); assert.equal(ui.node('global-notice').hidden, false);
  await ui.node('all-files').click(); await flush();
  assert.equal(ui.node('inventory-status').textContent, '3 matching entries'); assert.equal(ui.node('global-notice').hidden, true);
});

test('sample mode supports the same file-type search aliases and reset', async () => {
  const ui = await fixture(); await ui.node('demo-button').click(); await ui.node('tab-types').click(); await flush();
  const calls = ui.requests.length;
  for (const q of ['pdf', '.pdf', '*.PDF']) { await ui.input(q); await ui.debounce(); assert.equal(ui.node('types-files-count').textContent, '12', q); }
  await ui.input('no extension'); await ui.debounce(); assert.equal(ui.node('types-files-count').textContent, '4');
  await ui.node('all-files').click(); await flush(); assert.equal(ui.node('types-files-count').textContent, '72'); assert.equal(ui.requests.length, calls);
});
