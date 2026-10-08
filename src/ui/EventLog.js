/**
 * EventLog.js — rolling, sub-second log of routing decisions (newest first),
 * filterable by engine.
 */
const TAGS = {
  flexipath: { text: 'FP', color: '#0e7490' },
  legacy: { text: 'LG', color: '#e11d48' },
  env: { text: 'ENV', color: '#b45309' },
  sys: { text: 'SYS', color: '#64748b' },
};

const FILTERS = [
  ['all', 'All'],
  ['flexipath', 'FlexiPath'],
  ['legacy', 'Legacy'],
  ['env', 'Env'],
];

export class EventLog {
  constructor(root, { max = 180 } = {}) {
    this.root = root;
    this.max = max;
    this.filter = 'all';
    root.innerHTML = `
      <div class="flex items-center justify-between gap-2 px-3 pt-3 pb-2">
        <h2 class="hud-title">Event Log</h2>
        <div class="seg p-[2px]!" role="group" aria-label="Filter events">
          ${FILTERS.map(([v, l]) => `<button type="button" class="h-[20px]! px-2! text-[9.5px]!" data-filter="${v}" aria-pressed="${v === 'all'}">${l}</button>`).join('')}
        </div>
      </div>
      <div class="hud-scroll min-h-0 flex-1 overflow-y-auto pb-2" data-ref="list" role="log" aria-live="off"></div>`;
    this.list = root.querySelector('[data-ref="list"]');
    this.buttons = [...root.querySelectorAll('[data-filter]')];
    for (const b of this.buttons) b.addEventListener('click', () => this.setFilter(b.dataset.filter));
    this.events = [];
  }

  setFilter(f) {
    this.filter = f;
    for (const b of this.buttons) b.setAttribute('aria-pressed', String(b.dataset.filter === f));
    this.rebuild(this.events);
  }

  _matches(e) {
    if (this.filter === 'all') return true;
    if (this.filter === 'env') return e.engine === 'env' || e.engine === 'sys';
    return e.engine === this.filter;
  }

  _row(e, fresh) {
    const row = document.createElement('div');
    row.className = `log-row lvl-${e.level ?? 'info'}${fresh ? ' is-new' : ''}`;
    const tag = TAGS[e.engine] ?? TAGS.sys;
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = `T+${e.t.toFixed(1)}`;
    const g = document.createElement('span');
    g.className = 'tag';
    g.style.color = tag.color;
    g.textContent = tag.text;
    const m = document.createElement('span');
    m.textContent = e.message;
    row.append(t, g, m);
    return row;
  }

  push(e) {
    this.events.push(e);
    if (this.events.length > this.max * 4) this.events.splice(0, this.events.length - this.max * 4);
    if (!this._matches(e)) return;
    this.list.prepend(this._row(e, true));
    while (this.list.childElementCount > this.max) this.list.lastElementChild.remove();
  }

  rebuild(events) {
    this.events = [...events];
    const frag = document.createDocumentFragment();
    const shown = this.events.filter((e) => this._matches(e)).slice(-this.max).reverse();
    for (const e of shown) frag.append(this._row(e, false));
    this.list.replaceChildren(frag);
  }
}
