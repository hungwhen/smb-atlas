import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// A small DOM adapter runs the real chart renderer and its event handlers.
// Keep browser layout checks separate; these regressions cover data/lifecycle behavior.
function fixture() {
  const document = { activeElement: null };
  class Element {
    constructor(tag, namespaceURI = '') {
      Object.assign(this, { tagName: tag.toUpperCase(), namespaceURI, children: [], dataset: {}, attributes: {}, listeners: {}, style: {}, className: '', value: '', open: false, scrollLeft: 0, _text: '' });
      this.classList = { add: (...names) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), ...names])].join(' '); } };
    }
    set textContent(value) { this._text = String(value); this.children = []; }
    get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
    get firstChild() { return this.children[0]; }
    append(...nodes) { this.children.push(...nodes); }
    prepend(...nodes) { this.children.unshift(...nodes); }
    replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
    setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'class') this.className = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
    emit(name, values = {}) { for (const handler of this.listeners[name] || []) handler({ target: this, preventDefault() {}, ...values }); }
    contains(node) { return this === node || this.children.some(child => child.contains(node)); }
    querySelectorAll(selector) {
      const matches = node => selector[0] === '.' ? node.className.split(' ').includes(selector.slice(1))
        : selector === '[data-overview-focus]' ? Object.hasOwn(node.dataset, 'overviewFocus')
        : node.tagName === selector.toUpperCase();
      const results = [];
      const visit = node => { for (const child of node.children) { if (matches(child)) results.push(child); visit(child); } };
      visit(this); return results;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    focus() { document.activeElement = this; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  }
  document.createElement = tag => new Element(tag);
  document.createElementNS = (namespace, tag) => new Element(tag, namespace);
  const window = {};
  vm.runInNewContext(readFileSync(new URL('../public/overview.js', import.meta.url), 'utf8'), { window, document, Intl });
  const container = new Element('div');
  return { container, render: options => window.SMBAtlasOverview.render(container, options), focus: key => container.querySelectorAll('[data-overview-focus]').find(node => node.dataset.overviewFocus === key) };
}

const share = (name, filesCount = 2, totalBytes = 100) => ({ share: name, filesCount, totalBytes });
const host = (name, totalBytes = 100, filesCount = 2) => ({ host: name, totalBytes, filesCount, shares: [share('Docs', filesCount, totalBytes)], otherShares: { sharesCount: 0 } });
const stats = (hosts = [host('10.0.0.1')]) => ({ filesCount: 2, totalBytes: 100, types: [{ extension: '.txt', filesCount: 2, totalBytes: 100 }], sizeBuckets: [], hosts });
const job = { id: 'scan-one', status: 'completed', filesCount: 100, targetsCount: 1, hosts: [{ host: '10.0.0.1', status: 'completed' }] };

test('share map keeps its selection during updates and resets it when inventory scope changes', () => {
  const ui = fixture(); const options = { stats: stats([host('10.0.0.1', 200), host('10.0.0.2', 100)]), job, scopeKey: 'all' };
  ui.render(options);
  const select = ui.focus('map-host'); select.value = '10.0.0.2'; select.emit('change');
  ui.container.querySelector('.overview-data-details').open = true;
  ui.render(options);
  assert.equal(ui.focus('map-host').value, '10.0.0.2');
  assert.equal(ui.container.querySelector('.overview-data-details').open, true);
  ui.render({ ...options, scopeKey: 'reset' });
  assert.equal(ui.focus('map-host').value, '10.0.0.1');
  assert.equal(ui.container.querySelector('.overview-data-details').open, false);
  ui.render({ ...options, job: { ...job, id: 'scan-two' }, scopeKey: undefined });
  assert.equal(ui.focus('map-host').value, '10.0.0.1');
});

test('empty filtered charts can render and recover without stale map state', () => {
  const ui = fixture();
  ui.render({ stats: stats(), job, scopeKey: 'all' });
  ui.render({ stats: { filesCount: 0, types: [], hosts: [] }, job, scopeKey: 'no-matches' });
  assert.match(ui.container.textContent, /No files match the current search and filters/);
  assert.equal(ui.focus('map-host'), undefined);
  ui.render({ stats: stats(), job, scopeKey: 'all' });
  assert.equal(ui.focus('map-host').value, '10.0.0.1');
  assert.doesNotMatch(ui.container.textContent, /No files match/);
});

test('chart drilldowns distinguish extensionless files, shares, and aggregate actions', () => {
  const ui = fixture(); const filters = []; const tabs = [];
  const data = stats(); data.types = ['', '.txt', '.pdf', '.png', '.zip', '.csv'].map(extension => ({ extension, filesCount: extension ? 1 : 2, totalBytes: extension ? 1 : 2 }));
  data.hosts[0].otherShares = { sharesCount: 2, filesCount: 1, totalBytes: 1 };
  ui.render({ stats: data, job, onFilter: filter => filters.push({ ...filter }), onTab: tab => tabs.push(tab) });
  ui.focus('type-key-__none__').emit('click');
  ui.focus('type-key-other').emit('click');
  ui.focus('map-share-10.0.0.1/Docs').emit('click');
  ui.focus('map-share-10.0.0.1/__other__').emit('click');
  assert.deepEqual(filters, [{ extension: '__none__', kind: 'file' }, { host: '10.0.0.1', share: 'Docs', kind: 'file' }, { host: '10.0.0.1', kind: 'file' }]);
  assert.deepEqual(tabs, ['types']);
  assert.match(ui.focus('type-key-other').getAttribute('aria-label'), /See all file types/);
});

test('Files mode uses host and share file rankings rather than storage rankings', () => {
  const ui = fixture(); const data = stats([host('large', 1000, 1), host('many', 100, 50)]);
  data.hosts[1].shares = [share('Large', 1, 100)];
  data.hosts[1].sharesByFiles = [share('Many', 49, 0)];
  data.hosts[1].otherSharesByFiles = { sharesCount: 1, filesCount: 1, totalBytes: 100 };
  ui.render({ stats: data, job, metric: 'files' });
  assert.equal(ui.focus('map-host').value, 'many');
  assert.ok(ui.focus('map-share-many/Many'));
  assert.equal(ui.focus('map-share-many/Large'), undefined);
  assert.match(ui.container.textContent, /shares with the most files/);
});

test('large host inventories keep selector options bounded and allow searching every host', () => {
  const ui = fixture(); const data = stats(Array.from({ length: 20000 }, (_, index) => host(`10.${Math.floor(index / 65536)}.${Math.floor(index / 256) % 256}.${index % 256}`, 20000 - index)));
  const options = { stats: data, job, scopeKey: 'large' }; ui.render(options);
  assert.equal(ui.focus('map-host').children.length, 100);
  ui.focus('map-host-next').emit('click');
  assert.equal(ui.focus('map-host').children.length, 101); // includes the non-selected placeholder
  const search = ui.focus('map-host-search'); search.value = '10.0.78.31'; search.setSelectionRange(12, 12); search.focus(); search.emit('input');
  assert.ok(ui.focus('map-host').children.some(option => option.value === '10.0.78.31'));
  assert.equal(ui.focus('map-host-search').value, '10.0.78.31');
  assert.equal(ui.focus('map-host-search').selectionStart, 12);
  ui.render({ ...options, scopeKey: 'reset' });
  assert.equal(ui.focus('map-host-search').value, '');
  assert.equal(ui.focus('map-host').children.length, 100);
});
