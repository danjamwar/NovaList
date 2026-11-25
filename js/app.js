/* Offline List Builder – UI */
(function () {
  'use strict';
  const E = window.Engine;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const STORE_KEY = 'olb.rosters.v1';
  const PREF_KEY = 'olb.prefs.v1';
  const Prefs = (() => { try { return JSON.parse(localStorage.getItem(PREF_KEY)) || {}; } catch (e) { return {}; } })();
  function savePrefs() { try { localStorage.setItem(PREF_KEY, JSON.stringify(Prefs)); } catch (e) { /* ignore */ } }
  // Toggles that drive the data's own "Show/Hide Options" configuration entry
  const DATA_TOGGLES = [
    { label: 'Legends', name: 'Show Legends' },
    { label: 'Crucible', name: 'Show Crucible Characters' },
  ];
  const SHOWHIDE = 'Show/Hide Options';
  function showHideSel(force) { return force.children.find(x => x.node.name === SHOWHIDE); }
  function ensureShowHide(force) {
    if (showHideSel(force)) return;
    const n = force.roster.catalog.rootNodes().find(x => x.name === SHOWHIDE);
    if (n) E.addSel(force, n, [], 1);
  }

  const S = {
    view: 'home', roster: null, catalog: null,
    selPath: null,          // index path to selected selection, or null
    mode: 'add',            // 'add' | 'unit'
    addFilter: '', addCat: '',
    undo: [], redo: [],
    showErrors: false,
    infoOpen: new Set(),   // option ids whose rule text is expanded
  };

  // ------------------------------------------------------------------ storage
  const Store = {
    mem: {},
    all() {
      try { const t = localStorage.getItem(STORE_KEY); return t ? JSON.parse(t) : {}; } catch (e) { return this.mem; }
    },
    put(data) {
      const a = this.all(); a[data.id] = data;
      try { localStorage.setItem(STORE_KEY, JSON.stringify(a)); } catch (e) { this.mem = a; toast('Could not save to browser storage – use "Save file" to keep your roster.'); }
    },
    del(id) { const a = this.all(); delete a[id]; try { localStorage.setItem(STORE_KEY, JSON.stringify(a)); } catch (e) { this.mem = a; } },
  };

  // ------------------------------------------------------------------ text formatting
  function fmt(t) {
    let s = esc(t || '');
    s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\^\^(.+?)\^\^/g, '<span class="kw">$1</span>');
    s = s.replace(/\n/g, '<br>');
    return s;
  }
  function plain(t) { return String(t || '').replace(/\*\*|\^\^/g, ''); }

  function toast(msg, ms) {
    const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), ms || 3000);
  }

  function modal(html, onMount) {
    $('#modal-body').innerHTML = html; $('#modal').classList.remove('hidden');
    if (onMount) onMount($('#modal-body'));
  }
  function closeModal() { $('#modal').classList.add('hidden'); $('#modal-body').innerHTML = ''; }

  // ------------------------------------------------------------------ helpers
  const pts = () => S.catalog.ptsType;
  const isCfg = (s) => { const e = E.ev(s); return S.catalog.catName(e.primary) === 'Configuration'; };

  function rosterLimit(r) {
    let lim = null;
    const visit = (s) => {
      const n = E.ev(s).name;
      if (/^Points limit$/i.test(n)) lim = s.number;
      else if (lim === null) { const m = /\((\d+)\s*Point/i.exec(n); if (m) lim = Number(m[1]); }
      s.children.forEach(visit);
    };
    r.forces.forEach(f => f.children.forEach(visit));
    // explicit override wins
    let override = null;
    const v2 = (s) => { if (/^Points limit$/i.test(E.ev(s).name)) override = s.number; s.children.forEach(v2); };
    r.forces.forEach(f => f.children.forEach(v2));
    return override !== null ? override : (lim !== null ? lim : r.costLimit);
  }

  function costTypeLimit(r, typeId, ignoreOverride) {
    if (!ignoreOverride) { const ov = E.limitOverride(r, typeId); if (ov !== null) return ov; }
    let lim = null;
    r.forces.forEach(f => {
      const e = E.ev(f);
      f.node.constraints.forEach(c => { if (c.field === typeId && c.type === 'max' && e.cons[c.id] >= 0) lim = (lim || 0) + e.cons[c.id]; });
    });
    return lim;
  }

  function selFromPath(path) {
    if (!path || !S.roster) return null;
    let cur = S.roster.forces[path[0]];
    for (let i = 1; i < path.length && cur; i++) cur = cur.children[path[i]];
    return cur && cur !== S.roster.forces[path[0]] ? cur : null;
  }
  function pathOf(sel) {
    const p = []; let x = sel;
    while (x && !x.isForce) { p.unshift(x.parent.children.indexOf(x)); x = x.parent; }
    p.unshift(S.roster.forces.indexOf(x));
    return p;
  }
  function rootOf(s) { while (s && s.parent && !s.parent.isForce) s = s.parent; return s; }

  function snapshot() { return JSON.stringify(E.serialize(S.roster)); }
  function beginChange() { S.undo.push(snapshot()); if (S.undo.length > 100) S.undo.shift(); S.redo = []; }
  function commit() {
    E.bump();
    S.roster.costLimit = rosterLimit(S.roster);
    Store.put(E.serialize(S.roster));
    renderRoster();
  }
  function restore(json) {
    const { roster } = E.deserialize(S.catalog, JSON.parse(json));
    S.roster = roster;
    if (S.selPath && !selFromPath(S.selPath)) { S.selPath = null; S.mode = 'add'; }
    commitNoUndo();
  }
  function commitNoUndo() { E.bump(); S.roster.costLimit = rosterLimit(S.roster); Store.put(E.serialize(S.roster)); renderRoster(); }
  function undo() { if (!S.undo.length) return; S.redo.push(snapshot()); restore(S.undo.pop()); }
  function redo() { if (!S.redo.length) return; S.undo.push(snapshot()); restore(S.redo.pop()); }

  // ------------------------------------------------------------------ boot
  async function boot() {
    await E.Data.init();
    bindGlobal();
    renderHome();
  }

  function factionGroups() {
    const m = E.Data.manifest;
    const list = m.catalogues.filter(c => !c.library).sort((a, b) => a.name.localeCompare(b.name));
    const groups = {};
    list.forEach(c => { const g = c.name.includes(' - ') ? c.name.split(' - ')[0] : 'Other'; (groups[g] = groups[g] || []).push(c); });
    return groups;
  }
  function shortName(n) { const p = n.split(' - '); return p[p.length - 1]; }

  // ------------------------------------------------------------------ HOME
  function renderHome() {
    S.view = 'home'; S.roster = null;
    $('#topbar-roster').innerHTML = '';
    const m = E.Data.manifest;
    if (!m) {
      $('#main').innerHTML = `<div class="home"><div class="card"><h2>No game data found</h2>
        <p>Click below and choose your <b>wh40k-11e-main</b> folder (the BSData files).</p>
        <button class="btn primary" data-act="load-folder">Load data folder…</button></div></div>`;
      return;
    }
    const rosters = Object.values(Store.all()).sort((a, b) => (b.updated || '').localeCompare(a.updated || ''));
    const groups = factionGroups();
    const opts = Object.keys(groups).map(g => `<optgroup label="${esc(g)}">${groups[g].map(c => `<option value="${esc(c.id)}">${esc(shortName(c.name))}</option>`).join('')}</optgroup>`).join('');
    $('#main').innerHTML = `
    <div class="home">
      <section class="card">
        <h2>New roster</h2>
        <div class="form">
          <label>Faction<select id="nr-faction">${opts}</select></label>
          <label>Roster name<input id="nr-name" placeholder="My army"></label>
          <label>Battle size<select id="nr-size"><option value="1000">Incursion – 1000 pts</option><option value="2000" selected>Strike Force – 2000 pts</option><option value="3000">Onslaught – 3000 pts</option></select></label>
          <label>Force type<select id="nr-force"><option value="Army Roster">Army Roster (matched play)</option><option value="Crusade Force">Crusade Force</option><option value="Boarding Actions">Boarding Actions</option></select></label>
        </div>
        <button class="btn primary" data-act="create">Create roster</button>
      </section>
      <section class="card">
        <div class="row-between"><h2>Saved rosters</h2>
          <div class="row-gap"><button class="btn primary" data-act="import-list">Import list…</button></div></div>
        ${rosters.length ? `<ul class="roster-list">${rosters.map(r => `
          <li><div class="rl-main" data-act="open" data-id="${esc(r.id)}">
              <div class="rl-name">${esc(r.name)}</div>
              <div class="rl-sub">${esc(shortName(r.catalogueName || ''))} · ${r.totalPts || 0}/${r.costLimit || 0} pts · ${r.updated ? new Date(r.updated).toLocaleString() : ''}</div></div>
            <button class="icon" title="Duplicate" data-act="dup-roster" data-id="${esc(r.id)}">⧉</button>
            <button class="icon" title="Save file" data-act="dl-roster" data-id="${esc(r.id)}">⭳</button>
            <button class="icon danger" title="Delete" data-act="del-roster" data-id="${esc(r.id)}">✕</button></li>`).join('')}</ul>`
          : '<p class="muted">No rosters yet. Rosters are saved automatically in this browser as you build them.</p>'}
      </section>
      <section class="card">
        <h2>Game data</h2>
        <p class="muted">${esc(m.gameSystem ? m.gameSystem.name : '')} · ${m.catalogues.length} catalogues · source: ${E.Data.source === 'imported' ? 'imported folder' : 'bundled data folder'}${m.built ? ' · built ' + esc(new Date(m.built).toLocaleString()) : ''}</p>
        <p class="muted small">To update after downloading newer BSData files, click “Load data folder…” and pick the wh40k-11e-main folder (or run <code>build_data.py</code>).</p>
        <a class="btn" href="editor.html" style="text-decoration:none">✎ Edit data…</a>
        <button class="btn" data-act="load-folder">Load data folder…</button>
        ${E.Data.source === 'imported' ? '<button class="btn" data-act="reset-data">Use bundled data</button>' : ''}
        <div id="offline-status" class="offline-status"></div>
      </section>
      <section class="card">
        <h2>Help</h2>
        <p class="muted">New to the program? The illustrated user guide explains building lists, play mode, importing and exporting, and the data editor.</p>
        <a class="btn primary" href="help.html" target="_blank">📖 Open the user guide</a>
      </section>
    </div>`;
    offlineStatus();
  }

  // Offline: when opened from a web address the service worker (sw.js) saves everything on the device.
  async function offlineStatus() {
    const el = $('#offline-status'); if (!el) return;
    if (!/^https?:$/.test(location.protocol)) { el.innerHTML = '✓ Works offline – you\'re running it from a folder on this computer.'; return; }
    if (!('serviceWorker' in navigator) || !('caches' in window)) { el.innerHTML = 'This browser can\'t save the program for offline use.'; return; }
    try {
      const m = E.Data.manifest;
      const want = [m.gameSystem, ...m.catalogues].map(f => 'data/' + f.file);
      const c = await caches.open('novalist-v1');
      const have = new Set((await c.keys()).map(r => decodeURIComponent(new URL(r.url).pathname)));
      const base = decodeURIComponent(new URL('.', location.href).pathname);
      const n = want.filter(f => have.has(base + f)).length;
      if (!$('#offline-status')) return;
      if (n >= want.length) el.innerHTML = '✓ <b>Ready to use offline</b> on this device – the program and all army data are saved. Open this page (or the home-screen icon) with no internet and it still works.';
      else { el.innerHTML = `⏳ Saving for offline use… ${n} of ${want.length} army files. Keep this page open until it says Ready.`; setTimeout(offlineStatus, 2000); }
    } catch (e) { el.textContent = 'Offline status unavailable (' + e.message + ').'; }
  }

  async function createRoster() {
    const catId = $('#nr-faction').value;
    const name = $('#nr-name').value.trim() || shortName(E.Data.manifest.catalogues.find(c => c.id === catId).name);
    const size = $('#nr-size').value;
    const forceName = $('#nr-force').value;
    await withLoading(async () => {
      const cat = await E.openCatalog(catId);
      const r = new E.Roster(cat, { name, costLimit: Number(size) });
      const fe = cat.forceEntries().find(f => f.name === forceName) || cat.forceEntries()[0];
      const f = new E.Force(r, fe); r.forces.push(f);
      E.forceDefaults(f);
      // pick the battle size
      const bs = f.children.find(s => E.ev(s).name === 'Battle Size');
      if (bs) {
        const target = findOptionByName(bs, new RegExp('\\(' + size + '\\s*Point', 'i'));
        if (target) { bs.children.filter(c => c.groups.includes(target.groups[target.groups.length - 1])).forEach(c => E.removeSel(c)); E.addSel(bs, target.node, target.groups, 1); }
      }
      openRoster(cat, r);
    });
  }

  function findOptionByName(P, re) {
    const cat = P.force.roster.catalog;
    const walk = (opts, groups) => {
      for (const o of opts) {
        if (o.kind === 'group') { const r = walk(cat.children(o), groups.concat([o])); if (r) return r; }
        else if (re.test(o.name)) return { node: o, groups };
      }
      return null;
    };
    return walk(cat.children(P.node), []);
  }

  async function openSaved(id) {
    const data = Store.all()[id];
    if (!data) return;
    await withLoading(async () => {
      if (!E.Data.manifest.catalogues.find(c => c.id === data.catalogueId)) throw new Error('This roster uses a faction that is not in the current data (' + (data.catalogueName || data.catalogueId) + ').');
      const cat = await E.openCatalog(data.catalogueId);
      const { roster, missing } = E.deserialize(cat, data);
      openRoster(cat, roster);
      if (missing.length) toast(missing.length + ' selection(s) no longer exist in the data and were dropped.', 6000);
    });
  }

  async function withLoading(fn) {
    const prev = $('#main').innerHTML;
    $('#main').insertAdjacentHTML('beforeend', '<div class="overlay"><div class="spinner"></div><div>Loading data…</div></div>');
    try { await new Promise(r => setTimeout(r, 30)); await fn(); }
    catch (e) { console.error(e); const o = $('.overlay'); if (o) o.remove(); toast('Error: ' + e.message, 8000); }
  }

  function openRoster(cat, roster) {
    // lists saved before an option became "on by default" (e.g. Show Khorne Daemons) get it now
    try { roster.forces.forEach(f => E.forceDefaults(f)); E.bump(); } catch (e) { console.warn(e); }
    S.catalog = cat; S.roster = roster; S.view = 'roster';
    S.selPath = null; S.mode = 'add'; S.undo = []; S.redo = []; S.addFilter = ''; S.addCat = '';
    S.ptab = roster.forces.some(f => f.children.some(x => !isCfg(x))) ? 'army' : 'add'; S.tbMore = false;
    roster.forces.forEach(ensureShowHide);
    E.bump();
    roster.costLimit = rosterLimit(roster);
    Store.put(E.serialize(roster));
    renderRoster(true);
  }

  // ------------------------------------------------------------------ ROSTER VIEW
  function renderRoster(full) {
    const r = S.roster, cat = S.catalog;
    const total = E.rosterCost(r, pts());
    const limit = r.costLimit;
    const errs = E.validate(r);
    S._errs = errs;
    const otherCosts = cat.costTypes.filter(t => t.id !== pts() && /Detachment Points|Enhancements/.test(t.name))
      .map(t => ({ t, v: Math.ceil(Math.round(E.rosterCost(r, t.id) * 1000) / 1000), lim: costTypeLimit(r, t.id) })).filter(x => x.v || x.lim);
    $('#topbar-roster').innerHTML = `
      <input id="roster-name" value="${esc(r.name)}" title="Roster name">
      <span class="pill ${limit && total > limit ? 'bad' : ''}">${total}${limit ? ' / ' + limit : ''} pts</span>
      ${otherCosts.map(x => `<span class="pill sub tb-hide-phone ${x.lim !== null && x.v > x.lim ? 'bad' : ''}"><span class="tb-long">${esc(x.t.name)}</span><span class="tb-short" title="${esc(x.t.name)}">${/Detachment/.test(x.t.name) ? 'DP' : 'Enh.'}</span>: ${x.v}${x.lim !== null ? ' / ' + x.lim : ''}</span>`).join('')}
      <button class="pill ${errs.length ? 'bad' : 'good'}" data-act="toggle-errors">${errs.length ? '⚠ ' + errs.length + ' issue' + (errs.length > 1 ? 's' : '') : '✓ Valid'}</button>
      <span class="spacer"></span>
      <button class="btn sm tb-hide-phone" data-act="undo" ${S.undo.length ? '' : 'disabled'} title="Undo (Ctrl+Z)">↶</button>
      <button class="btn sm tb-hide-phone" data-act="redo" ${S.redo.length ? '' : 'disabled'} title="Redo (Ctrl+Y)">↷</button>
      <button class="btn sm play-btn" data-act="play" title="Read-only view for playing a game">▶ Play</button>
      <button class="btn sm tb-hide-phone" data-act="export-text">Export<span class="tb-long"> list</span></button>
      <button class="btn sm tb-hide-phone" data-act="print">Print<span class="tb-long"> / PDF</span></button>
      <button class="btn sm tb-hide-phone" data-act="dl-current">Save file</button>
      <button class="btn sm tb-more" data-act="tb-more" title="More">⋯</button>
      ${S.tbMore ? `<div class="tb-menu">
        ${otherCosts.map(x => `<div class="tb-menu-info ${x.lim !== null && x.v > x.lim ? 'bad' : ''}">${esc(x.t.name)}: ${x.v}${x.lim !== null ? ' / ' + x.lim : ''}</div>`).join('')}
        <div class="tb-menu-info"><b>${esc(r.name)}</b></div>
        <button class="btn" data-act="rename-list">✎ Rename list</button>
        <div class="tb-menu-row"><button class="btn" data-act="undo" ${S.undo.length ? '' : 'disabled'}>↶ Undo</button><button class="btn" data-act="redo" ${S.redo.length ? '' : 'disabled'}>↷ Redo</button></div>
        <button class="btn" data-act="export-text">Export list</button>
        <button class="btn" data-act="print">Print / PDF</button>
        <button class="btn" data-act="dl-current">Save file</button>
        <button class="btn" data-act="home">⌂ Home</button></div>` : ''}`;

    const keep = {};
    ['#col-left', '#col-mid', '#col-right'].forEach(id => { const el = $(id + ' .scroll'); if (el) keep[id] = el.scrollTop; });

    const sel = selFromPath(S.selPath);
    if (!sel && S.mode === 'unit') S.mode = 'add';

    const ptab = S.ptab || 'army';
    const unitSel = S.mode === 'unit' && sel;
    const cfgSel = unitSel && isCfg(rootOf(sel));
    $('#main').innerHTML = `
      <div class="roster" data-ptab="${ptab === 'unit' && !unitSel ? 'add' : ptab}">
        <aside id="col-left"><div class="scroll">${renderLeft(sel, errs)}</div></aside>
        <section id="col-mid"><div class="scroll">${S.mode === 'unit' && sel ? renderUnit(sel) : renderAdd()}</div></section>
        <section id="col-right"><div class="scroll">${S.mode === 'unit' && sel && !isCfg(rootOf(sel)) ? renderDatasheet(rootOf(sel)) : renderRosterSummary()}</div></section>
      </div>
      <nav class="ptabs">
        ${[['army', '☰', 'Army'], ['add', '＋', 'Add'], ['unit', '✎', unitSel ? (cfgSel ? 'Settings' : 'Unit') : 'Unit'], ['sheet', '▤', unitSel && !cfgSel ? 'Datasheet' : 'Summary']]
          .map(([k, ic, lab]) => `<button class="ptab ${(ptab === k || (k === 'add' && ptab === 'unit' && !unitSel)) ? 'on' : ''}" data-act="ptab" data-t="${k}" ${k === 'unit' && !unitSel ? 'disabled' : ''}><span>${ic}</span>${lab}</button>`).join('')}
      </nav>`;
    Object.keys(keep).forEach(id => { const el = $(id + ' .scroll'); if (el && !full) el.scrollTop = keep[id]; });
    if (S.mode === 'add') { const i = $('#add-search'); if (i && S._focusSearch) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); S._focusSearch = false; } }
  }

  // Force Disposition icons (icons/PurgeTheFoe.png etc.): a detachment carries its dispositions as categories;
  // a Force Disposition option is named after one.
  const FD_NAMES = ['Disruption', 'Priority Assets', 'Purge the Foe', 'Reconnaissance', 'Take and Hold'];
  const fdFile = (n) => 'icons/' + n.split(/\s+/).map(w => w[0].toUpperCase() + w.slice(1)).join('') + '.png';
  function fdIcons(e) {
    const names = new Set();
    if (FD_NAMES.includes(e.name)) names.add(e.name);
    e.cats.forEach(id => { const n = S.catalog.catName(id); if (FD_NAMES.includes(n)) names.add(n); });
    return names.size ? `<span class="fd-icons">${FD_NAMES.filter(n => names.has(n)).map(n => `<img class="fd-icon" src="${fdFile(n)}" alt="${esc(n)}" title="Force Disposition: ${esc(n)}">`).join('')}</span>` : '';
  }

  // Detachment Points cost of a selection / option ('' when it has none)
  function dpLabel(e) {
    const t = S.catalog.costTypes.find(c => c.name === 'Detachment Points');
    const v = t ? (e.costs[t.id] || 0) : 0;
    return v ? `${v} DP` : '';
  }

  function renderLeft(sel, errs) {
    const r = S.roster, cat = S.catalog;
    const rootSel = sel ? rootOf(sel) : null;
    const errSels = new Set(errs.map(e => e.sel && rootOf(e.sel)).filter(Boolean));
    let html = '';
    if (S.showErrors) {
      html += `<div class="errors"><div class="row-between"><b>Issues</b><button class="icon" data-act="toggle-errors">✕</button></div>
        ${errs.length ? '<ul>' + errs.map((e, i) => `<li ${e.sel ? `data-act="goto-err" data-i="${i}"` : ''}>${esc(e.msg)}</li>`).join('') + '</ul>' : '<p class="muted">No issues 🎉</p>'}</div>`;
    }
    for (const f of r.forces) {
      const fi = r.forces.indexOf(f);
      const groups = new Map();
      const order = f.node.categoryLinks.map(c => c.targetId);
      f.children.forEach((s, i) => {
        if (E.attachedTarget(s)) return; // shown under the unit it is attached to
        const e = E.ev(s);
        let c = e.primary || 'other';
        if (!groups.has(c)) groups.set(c, []);
        groups.get(c).push({ s, i });
      });
      const keys = [...groups.keys()].sort((a, b) => {
        const ia = order.indexOf(a), ib = order.indexOf(b);
        return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
      });
      html += `<div class="force-head">${esc(f.node.name)} <span class="muted">· ${esc(shortName(cat.cats[0].name))}</span></div>`;
      for (const k of keys) {
        const cname = k === 'other' ? 'Other' : cat.catName(k);
        html += `<div class="cat-head">${esc(cname)}</div><ul class="unit-list">`;
        const unitLi = (s, i, attached) => {
          const e = E.ev(s);
          const cost = E.totalCost(s, pts());
          const cfg = cname === 'Configuration';
          const sub = cfg ? s.children.map(c => { const ce = E.ev(c); const dp = dpLabel(ce); return esc(ce.name) + (dp ? ` (${dp})` : '') + fdIcons(ce); }).join(', ') : '';
          return `<li class="${s === rootSel ? 'active' : ''} ${errSels.has(s) ? 'has-err' : ''} ${attached ? 'attached' : ''}" data-act="select" data-path="${fi},${i}">
            <div class="ul-name">${attached ? '<span class="att-mark" title="Attached">↳</span>' : ''}${esc(s.customName || e.name)}${s.customName ? ` <span class="muted small">(${esc(e.name)})</span>` : ''}${sub ? `<div class="muted small">${sub}</div>` : ''}</div>
            ${cfg ? '' : `<span class="cost">${cost}</span>
            <button class="icon" title="Duplicate" data-act="dup" data-path="${fi},${i}">⧉</button>
            <button class="icon danger" title="Remove" data-act="remove" data-path="${fi},${i}">✕</button>`}
          </li>`;
        };
        for (const { s, i } of groups.get(k)) {
          const leaders = E.attachedLeaders(s);
          if (leaders.length) {
            const tot = [s].concat(leaders).reduce((a, x) => a + E.totalCost(x, pts()), 0);
            html += `<li class="att-group"><ul class="unit-list">${unitLi(s, i, false)}${leaders.map(l => unitLi(l, f.children.indexOf(l), true)).join('')}</ul><div class="att-total muted small">Attached unit · ${tot} pts</div></li>`;
          } else html += unitLi(s, i, false);
        }
        html += '</ul>';
      }
    }
    html += `<button class="btn primary block ${S.mode === 'add' ? 'active' : ''}" data-act="show-add">＋ Add unit</button>`;
    html += `<div class="notes"><label class="muted small">Notes</label><textarea id="roster-notes" rows="3" placeholder="Notes for this roster…">${esc(r.notes || '')}</textarea></div>`;
    return html;
  }

  function renderAdd() {
    const f = S.roster.forces[0], cat = S.catalog;
    const filter = S.addFilter.toLowerCase();
    const items = [];
    for (const n of cat.rootNodes()) {
      const v = E.makeVirtual(f, n, []);
      const e = E.ev(v);
      if (e.hidden) continue;
      const catName = e.primary ? cat.catName(e.primary) : 'Other';
      if (catName === 'Configuration') continue;
      items.push({ n, e, catName, cost: e.costs[pts()] || 0 });
    }
    const allyCount = items.filter(i => /^Allies/i.test(i.catName)).length;
    if (Prefs.hideAllies) { const keep = items.filter(i => !/^Allies/i.test(i.catName)); items.length = 0; items.push(...keep); }
    const sh = showHideSel(f);
    const toggles = sh ? DATA_TOGGLES.map(t => ({ t, node: cat.children(sh.node).find(o => o.name === t.name) })).filter(x => x.node) : [];
    const order = f.node.categoryLinks.map(c => c.name);
    const cats = [...new Set(items.map(i => i.catName))].sort((a, b) => { const ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b); });
    if (S.addCat && !cats.includes(S.addCat)) S.addCat = '';
    const shown = items.filter(i => (!S.addCat || i.catName === S.addCat) && (!filter || i.e.name.toLowerCase().includes(filter)));
    let html = `<div class="panel-head"><h2>Add unit</h2></div>
      <input id="add-search" class="search" placeholder="Search units…" value="${esc(S.addFilter)}">
      <div class="hide-row"><span class="muted small">Show:</span>
        ${toggles.map(x => `<label class="hide-opt"><input type="checkbox" data-act="toggle-show" data-name="${esc(x.t.name)}" ${E.selsOf(sh, x.node).length ? 'checked' : ''}> ${esc(x.t.label)}</label>`).join('')}
        <label class="hide-opt"><input type="checkbox" data-act="toggle-allies" ${Prefs.hideAllies ? '' : 'checked'}> Allies${Prefs.hideAllies && allyCount ? ` <span class="muted small">(${allyCount} hidden)</span>` : ''}</label>
        ${sh ? '<button class="linkbtn small" data-act="open-showhide">More…</button>' : ''}</div>
      <div class="chips"><button class="chip ${!S.addCat ? 'on' : ''}" data-act="add-cat" data-cat="">All</button>${cats.map(c => `<button class="chip ${S.addCat === c ? 'on' : ''}" data-act="add-cat" data-cat="${esc(c)}">${esc(c)}</button>`).join('')}</div>`;
    for (const c of cats) {
      const list = shown.filter(i => i.catName === c);
      if (!list.length) continue;
      html += `<div class="cat-head">${esc(c)}</div><ul class="add-list">`;
      list.forEach(i => {
        const count = E.selsOf(f, i.n).length;
        html += `<li data-act="add" data-key="${esc(i.n.key)}"><span class="al-name">${esc(i.e.name)}${count ? ` <span class="badge">×${count}</span>` : ''}</span><span class="cost">${i.cost} pts</span><span class="plus">＋</span></li>`;
      });
      html += '</ul>';
    }
    if (!shown.length) html += '<p class="muted">No matching units.</p>';
    return html;
  }

  // ---- unit editor
  function renderUnit(sel) {
    const root = rootOf(sel);
    const e = E.ev(root);
    const cost = E.totalCost(root, pts());
    const cfg = isCfg(root);
    let html = `<div class="panel-head"><div><h2>${esc(root.customName || e.name)}</h2>
      ${!cfg ? `<div class="muted">${cost} pts</div>` : ''}</div>
      <div>${!cfg ? `<button class="btn sm" data-act="rename">Rename</button>` : ''}
      <button class="btn sm" data-act="show-add">Done</button></div></div>`;
    const errs = (S._errs || []).filter(x => x.sel && rootOf(x.sel) === root);
    if (errs.length) html += `<div class="unit-errs">${errs.map(x => `<div>⚠ ${esc(x.msg)}</div>`).join('')}</div>`;
    if (e.annotations.length) html += `<div class="muted small">${esc(e.annotations.join(', '))}</div>`;
    html += renderAttach(root);
    html += `<div class="opts">${renderOptions(root, S.catalog.children(root.node), [], 0)}</div>`;
    if (cfg && /^Battle Size$/i.test(root.node.name || e.name) && E.overrideActive(S.roster)) html += renderDpOverride();
    return html;
  }

  // Detachment Points limit to use alongside "Override points limit?"
  function renderDpOverride() {
    const r = S.roster;
    const dpType = S.catalog.costTypes.find(t => t.name === 'Detachment Points');
    if (!dpType) return '';
    const base = costTypeLimit(r, dpType.id, true);
    const set = r.dpOverride !== null && r.dpOverride !== undefined;
    const cur = set ? r.dpOverride : (base !== null ? base : 0);
    return `<div class="dp-override">
      <div class="opt-row"><span class="opt-name">Detachment Points limit</span>
        <span class="spin"><button data-act="dp-ov-dec" ${cur <= 0 ? 'disabled' : ''}>−</button><input class="num" id="dp-ov-num" value="${cur}"><button data-act="dp-ov-inc">+</button></span></div>
      <div class="muted small">${set ? `Overriding the battle size's ${base !== null ? base + ' DP' : 'limit'}. <a href="#" data-act="dp-ov-reset">Use battle size limit</a>` : `Using the battle size's limit. Change it to set your own Detachment Points limit for this game.`}</div>
    </div>`;
  }
  function setDpOverride(n) {
    beginChange();
    S.roster.dpOverride = n === null ? null : Math.max(0, n);
    commit();
  }

  function renderAttach(root) {
    const cat = S.catalog;
    let html = '';
    const assocs = cat.assocs(root.node);
    if (assocs.length) {
      const cur = E.attachedTarget(root);
      const opts = E.attachOptions(root);
      const label = assocs[0].label || assocs[0].name || 'Attached to';
      const list = S.roster.forces[0].children;
      const nameOf = (t) => {
        const n = E.ev(t).name; const same = list.filter(x => E.ev(x).name === n);
        const extra = t.customName ? ' – ' + t.customName : (same.length > 1 ? ' #' + (same.indexOf(t) + 1) : '');
        const already = E.attachedLeaders(t).filter(l => l !== root).map(l => E.ev(l).name);
        return n + extra + (already.length ? ' (with ' + already.join(', ') + ')' : '');
      };
      html += `<div class="attach"><label><span class="att-label">${esc(label)}</span>
        <select id="attach-select" data-path="${esc(pathOf(root).join(','))}">
          <option value="">— not attached —</option>
          ${opts.map(o => `<option value="${esc(o.assoc.id + '|' + o.target.uid)}" ${cur === o.target && (!root.assocId || root.assocId === o.assoc.id) ? 'selected' : ''}>${esc((assocs.length > 1 ? (o.assoc.label || o.assoc.name) + ': ' : '') + nameOf(o.target))}</option>`).join('')}
        </select></label>
        ${!opts.length ? '<div class="muted small">No eligible units in this army yet – add a unit this character can join.</div>' : ''}</div>`;
    }
    const leaders = E.attachedLeaders(root);
    if (leaders.length) html += `<div class="attach muted">Attached: ${leaders.map(l => esc(E.ev(l).name)).join(', ')}</div>`;
    return html;
  }

  function renderOptions(P, options, groups, depth) {
    const cat = S.catalog;
    let html = '';
    for (const opt of options) {
      if (opt.kind === 'group') {
        const gsels = E.selsInGroup(P, opt);
        const v = E.makeVirtual(P, opt, groups);
        const e = E.ev(v);
        if (e.hidden && !gsels.length) continue;
        const kids = cat.children(opt);
        const min = E.constraintValue(opt, v, 'min', ['parent']);
        const max = E.constraintValue(opt, v, 'max', ['parent']);
        const inner = renderOptions(P, kids, groups.concat([opt]), depth + 1);
        if (!inner.trim()) continue;
        const n = gsels.reduce((a, c) => a + c.number, 0);
        const range = (min || max !== undefined) ? `<span class="range ${(min && n < min) || (max !== undefined && n > max) ? 'bad' : ''}">${n}${max !== undefined ? '/' + max : ''}${min ? ' (min ' + min + ')' : ''}</span>` : '';
        const collapsed = isCollapsed(P, opt, gsels.length);
        html += `<div class="group ${collapsed ? 'collapsed' : ''}"><div class="group-head" data-act="toggle-group" data-g="${esc(gkey(P, opt))}"><span class="caret">▸</span>${esc(e.name)} ${range}</div><div class="group-body">${inner}</div></div>`;
      } else {
        html += renderEntryOption(P, opt, groups, depth);
      }
    }
    return html;
  }

  const collapsedState = {};
  function gkey(P, g) { return (P.uid || 'f') + ':' + g.key; }
  function isCollapsed(P, g, nsel) {
    const k = gkey(P, g);
    if (k in collapsedState) return collapsedState[k];
    return /crusade|weapon modifications|battle honours|battle scars/i.test(g.name) && !nsel;
  }

  function renderEntryOption(P, opt, groups, depth) {
    const cat = S.catalog;
    const sels = E.selsOf(P, opt);
    const s = sels[0];
    const ctx = s || E.makeVirtual(P, opt, groups);
    const e = E.ev(ctx);
    if (e.hidden && !s) return '';
    // the most this unit can take: its own limit, but never more than an army-wide limit allows
    // (e.g. "max 1 per army" relics), and enhancements are always one per unit
    let max = E.constraintValue(opt, ctx, 'max', ['parent']);
    const wider = E.constraintValue(opt, ctx, 'max', ['parent', 'force', 'roster', 'root-entry', 'unit', 'model', 'model-or-unit', 'upgrade', 'primary-catalogue']);
    if (wider !== undefined && (max === undefined || wider < max)) max = wider;
    if (groups.some(g => /enhancement/i.test(g.name || ''))) max = Math.min(max === undefined ? 1 : max, 1);
    const min = E.constraintValue(opt, ctx, 'min', ['parent']) || 0;
    const grp = groups[groups.length - 1];
    let radio = false;
    if (grp) {
      const gv = E.makeVirtual(P, grp, groups.slice(0, -1));
      const gmax = E.constraintValue(grp, gv, 'max', ['parent']);
      radio = gmax === 1;
    }
    const n = sels.reduce((a, c) => a + c.number, 0);
    const unitCost = e.costs[pts()] || 0;
    const id = `${P.uid}|${groups.map(g => g.key).join('/')}|${opt.key}`;
    let control;
    if (radio) control = `<input type="radio" ${n ? 'checked' : ''} data-act="opt-radio" data-id="${esc(id)}">`;
    else if (max === 1) control = `<input type="checkbox" ${n ? 'checked' : ''} ${n && min >= 1 ? 'disabled title="Required"' : ''} data-act="opt-check" data-id="${esc(id)}">`;
    else {
      const step = Number(opt.raw.step) || 1;
      control = `<span class="spin"><button data-act="opt-dec" data-id="${esc(id)}" data-step="${step}" ${n <= 0 ? 'disabled' : ''}>−</button><input class="num" value="${n}" data-act="opt-num" data-id="${esc(id)}"><button data-act="opt-inc" data-id="${esc(id)}" data-step="${step}" ${max !== undefined && n >= max ? 'disabled' : ''}>+</button></span>`;
    }
    const mult = multiplier(P);
    const disp = n && mult * n > 1 && (max === 1 || radio) && mult > 1 ? ` <span class="muted small">×${mult * n}</span>` : '';
    const unavailable = max === 0 && !n;
    if (unavailable) control = control.replace(/<(input|button)/g, '<$1 disabled');
    const infoHtml = optInfoHtml(ctx);
    const rulesGroup = isRulesContext(P, groups);
    const autoMode = rulesGroup && n > 0;
    const showInfo = !!infoHtml && (autoMode ? !S.infoOpen.has('x' + id) : S.infoOpen.has(id));
    const infoBtn = infoHtml ? `<button class="info-btn ${showInfo ? 'on' : ''}" title="${showInfo ? 'Hide' : 'Show'} rules text" data-act="opt-info" data-id="${esc(id)}" data-auto="${rulesGroup && n > 0 ? 1 : 0}">ⓘ</button>` : '';
    let html = `<div class="opt ${n ? 'on' : ''} ${e.hidden || unavailable ? 'hid' : ''}" style="--d:${depth}">
      <${radio || max === 1 ? 'label' : 'div'} class="opt-row">${control}<span class="opt-name">${esc(e.name)}${disp}${fdIcons(e)}</span>${infoBtn}${unitCost ? `<span class="cost">${unitCost > 0 ? '+' : ''}${unitCost}</span>` : (dpLabel(e) ? `<span class="cost dp-cost" title="Detachment Points">${dpLabel(e)}</span>` : '')}${(max !== undefined || min) && !radio && max !== 1 ? `<span class="range muted">${min ? min + '–' : '≤'}${max !== undefined ? max : '∞'}</span>` : ''}</${radio || max === 1 ? 'label' : 'div'}>`;
    if (showInfo) html += `<div class="opt-info">${infoHtml}</div>`;
    if (s) {
      const kids = cat.children(s.node);
      if (kids.length) {
        const inner = renderOptions(s, kids, [], depth + 1);
        if (inner.trim()) html += `<div class="sub">${inner}</div>`;
      }
    }
    html += '</div>';
    return html;
  }

  // Rule / ability text attached to an option (detachments, enhancements, wargear abilities)
  const STAT_TYPES = ['Unit', 'Ranged Weapons', 'Melee Weapons', 'Transport'];
  function infoItems(ctx, recursive) {
    const { profiles, rules } = E.collectInfo(ctx, !!recursive);
    const items = [];
    profiles.filter(p => !STAT_TYPES.includes(p.typeName)).forEach(p => items.push({ name: p.name, text: Object.values(p.chars).join('\n'), tag: p.typeName && p.typeName !== 'Abilities' ? p.typeName : '' }));
    rules.forEach(r => items.push({ name: r.name, text: r.description }));
    return items;
  }
  function itemsHtml(items) {
    return items.map(i => `<div class="rule-block">${i.name ? `<b>${esc(i.name)}</b>` : ''}${i.tag ? ` <span class="muted small">(${esc(i.tag)})</span>` : ''}<div>${fmt(i.text)}</div></div>`).join('');
  }
  function optInfoHtml(ctx) {
    // skip weapons: their keyword rules are on the datasheet already
    const n = ctx.node;
    const isWeapon = (n.profiles || []).some(p => /Weapons/.test(p.typeName || ''));
    if (isWeapon) return '';
    const items = infoItems(ctx, false);
    return items.length ? itemsHtml(items) : '';
  }
  function isRulesContext(P, groups) {
    const re = /detachment|enhancement/i;
    return groups.some(g => re.test(g.name)) || (P && P.node && re.test(P.node.name || ''));
  }

  // Detachment / configuration rules and enhancements taken, for the summary panel and printout
  function armyRulesHtml(r) {
    let html = '';
    const blocks = [];
    for (const f of r.forces) {
      for (const s of f.children.filter(isCfg)) {
        if (s.node.name === SHOWHIDE) continue;
        for (const c of s.children) {
          const items = infoItems(c, true);
          if (items.length) { const dp = dpLabel(E.ev(c)); blocks.push({ title: `${E.ev(s).name}: ${E.ev(c).name}${dp ? ` (${dp})` : ''}`, icons: fdIcons(E.ev(c)), items }); }
        }
      }
    }
    if (blocks.length) html += `<div class="army-rules"><h3>Army &amp; detachment rules</h3>${blocks.map(b => `<div class="ar-block"><h4>${esc(b.title)}${b.icons || ''}</h4>${itemsHtml(b.items)}</div>`).join('')}</div>`;
    const enh = [];
    const re = /enhancement/i;
    const walk = (x, root) => { x.children.forEach(c => { if (c.groups.some(g => re.test(g.name))) enh.push({ sel: c, root }); walk(c, root); }); };
    r.forces.forEach(f => f.children.filter(s => !isCfg(s)).forEach(s => walk(s, s)));
    if (enh.length) html += `<div class="army-rules"><h3>Enhancements</h3>${enh.map(({ sel, root }) => `<div class="ar-block"><h4>${esc(E.ev(sel).name)} <span class="muted small">– on ${esc(root.customName || E.ev(root).name)}${E.costOf(sel, pts()) ? ' · ' + E.costOf(sel, pts()) + ' pts' : ''}</span></h4>${itemsHtml(infoItems(sel, false).map(i => i.name === E.ev(sel).name ? Object.assign({}, i, { name: '' }) : i))}</div>`).join('')}</div>`;
    return html;
  }

  // Detachment / army rules as plain items (for play mode reminders)
  function armyRuleItems(r) {
    const out = [];
    for (const f of r.forces) for (const s of f.children.filter(isCfg)) {
      if (s.node.name === SHOWHIDE) continue;
      for (const c of s.children) infoItems(c, true).forEach(i => out.push(Object.assign({ source: E.ev(c).name }, i)));
    }
    return out;
  }

  function multiplier(P) { let m = 1, x = P; while (x && !x.isForce) { m *= x.number; x = x.parent; } return m; }

  function findOptById(id) {
    const [puid, gpath, key] = id.split('|');
    const P = findByUid(puid);
    if (!P) return null;
    const cat = S.catalog;
    const opts = P.isForce ? cat.rootNodes() : cat.children(P.node);
    const keys = (gpath ? gpath.split('/') : []).concat([key]);
    let list = opts, groups = [];
    for (let i = 0; i < keys.length; i++) {
      const n = list.find(o => o.key === keys[i]);
      if (!n) return null;
      if (i === keys.length - 1) return { P, node: n, groups };
      groups = groups.concat([n]); list = cat.children(n);
    }
    return null;
  }
  function findByUid(uid) {
    let found = null;
    const rec = (x) => { if (found) return; if (String(x.uid) === uid) { found = x; return; } x.children.forEach(rec); };
    S.roster.forces.forEach(rec);
    return found;
  }

  function setOptionCount(o, n) {
    const { P, node, groups } = o;
    const sels = E.selsOf(P, node);
    beginChange();
    if (n <= 0) sels.forEach(s => E.removeSel(s));
    else if (sels.length) { sels[0].number = n; sels.slice(1).forEach(s => E.removeSel(s)); E.bump(); }
    else E.addSel(P, node, groups, n);
    commit();
  }

  function chooseRadio(o) {
    const { P, node, groups } = o;
    const grp = groups[groups.length - 1];
    const existing = E.selsInGroup(P, grp);
    if (existing.length === 1 && existing[0].node === node) return;
    beginChange();
    const gv = E.makeVirtual(P, grp, groups.slice(0, -1));
    const gmin = E.constraintValue(grp, gv, 'min', ['parent']) || 1;
    existing.forEach(s => E.removeSel(s));
    E.addSel(P, node, groups, Math.max(1, gmin));
    commit();
  }

  // ---- datasheet
  function renderDatasheet(s, opts) {
    opts = opts || {};
    const cat = S.catalog;
    const { profiles, rules } = E.collectInfo(s, true);
    const e = E.ev(s);
    const byType = new Map();
    profiles.forEach(p => { const k = p.typeName || 'Other'; if (!byType.has(k)) byType.set(k, []); byType.get(k).push(p); });
    const typeOrder = ['Unit', 'Ranged Weapons', 'Melee Weapons'];
    const keys = [...byType.keys()].sort((a, b) => { const ia = typeOrder.indexOf(a), ib = typeOrder.indexOf(b); return (ia < 0 ? (a === 'Abilities' ? 90 : 50) : ia) - (ib < 0 ? (b === 'Abilities' ? 90 : 50) : ib); });
    let html = `<div class="sheet"><div class="sheet-title">${esc(s.customName || e.name)}<span class="cost">${E.totalCost(s, pts())} pts</span></div>`;
    const D = opts.damaged || null;   // play mode: the unit is damaged ("bracketed")
    if (D) {
      const parts = [D.hit ? `−${D.hit} to Hit rolls` : '', D.oc ? `OC −${D.oc}` : '', D.halveA ? 'Attacks halved' : ''].filter(Boolean);
      html += `<div class="dmg-banner">⚠ <b>${esc(D.label)}</b> – ${D.model ? esc(D.model) + ' has ' : ''}${D.wounds} wound${D.wounds === 1 ? '' : 's'} left${parts.length ? ': ' + parts.join(' · ') : ''}${D.more ? `<div class="small">${fmt(D.text)}</div>` : ''}</div>`;
    }
    for (const k of keys) {
      const list = byType.get(k);
      const pt = cat.profileTypes.get(list[0].typeId);
      const cols = pt ? (pt.characteristicTypes || []) : [];
      if (cols.length === 1 || k === 'Abilities') {
        html += `<div class="sheet-sec"><h4>${esc(k)}</h4>${list.map(p => `<div class="ability"><b>${esc(p.name)}:</b>${(p.ann || []).map(a => ` <span class="ann">${esc(a)}</span>`).join('')} ${fmt(Object.values(p.chars).join(' '))}</div>`).join('')}</div>`;
      } else {
        html += `<div class="sheet-sec"><h4>${esc(k)}</h4><div class="tbl-wrap"><table><thead><tr><th></th>${cols.map(c => `<th>${esc(c.name)}</th>`).join('')}</tr></thead><tbody>
          ${list.map(p => `<tr><td class="pname">${esc(p.name)}${p.count > 1 && k !== 'Unit' ? ` <span class="muted">×${Math.round(p.count)}</span>` : ''}${(p.ann || []).map(a => ` <span class="ann" title="Changed by ${esc(a)}">${esc(a)}</span>`).join('')}</td>${cols.map(c => D ? dmgCellHtml(p, c, k, D) : cellHtml(p, c)).join('')}</tr>`).join('')}</tbody></table></div></div>`;
      }
    }
    if (profiles.some(p => (p.changed || []).length)) html += `<div class="sheet-sec muted small">Values in <span class="modded-key">gold</span> are changed by abilities, wargear, enhancements, attached characters or your detachment.</div>`;
    if (rules.length) {
      if (opts.ruleNamesOnly) html += `<div class="sheet-sec kw-line"><b>Rules:</b> ${esc(rules.map(r => r.name).join(', '))}</div>`;
      else html += `<div class="sheet-sec"><h4>Rules</h4>${rules.map(r => `<details class="rule"><summary>${esc(r.name)}</summary><div>${fmt(r.description)}</div></details>`).join('')}</div>`;
    }
    const att = E.attachedTarget(s), led = E.attachedLeaders(s);
    if (att) html += `<div class="sheet-sec kw-line"><b>Attached to:</b> ${esc(E.ev(att).name)}</div>`;
    if (led.length) html += `<div class="sheet-sec kw-line"><b>Attached characters:</b> ${esc(led.map(l => E.ev(l).name).join(', '))}</div>`;
    const effCats = E.computeEffects(S.roster).cats.get(s);
    const allCats = new Set([...e.cats, ...(effCats ? [...effCats] : [])]);
    const kws = [...allCats].filter(id => { const c = cat.categories.get(id); return !(c && c.hidden); }).map(id => cat.catName(id)).filter(n => n && !/^Configuration$/.test(n));
    const fac = kws.filter(k => /^Faction:/.test(k)).map(k => k.replace(/^Faction:\s*/, ''));
    const other = kws.filter(k => !/^Faction:/.test(k));
    if (other.length) html += `<div class="sheet-sec kw-line"><b>Keywords:</b> ${esc(other.join(', '))}</div>`;
    if (fac.length) html += `<div class="sheet-sec kw-line"><b>Faction keywords:</b> ${esc(fac.join(', '))}</div>`;
    html += '</div>';
    return html;
  }

  // Play mode: a datasheet cell with the unit's "Damaged" effects applied (shown in red)
  function dmgCellHtml(p, c, k, D) {
    const val = String(p.chars[c.id] || '');
    const name = (c.name || '').toUpperCase();
    const red = (txt, tip) => `<td class="dmg" title="${esc(tip)}">${txt}</td>`;
    if (k === 'Unit' && name === 'OC' && D.oc) {
      const n = parseInt(val, 10);
      if (!isNaN(n)) return red(`${Math.max(0, n - D.oc)}`, `${D.label}: OC −${D.oc} (normally ${val})`);
    }
    if (/Weapons/.test(k) && D.only && !D.only.has(p.name)) return cellHtml(p, c);   // another model's weapon
    if (/Weapons/.test(k) && (name === 'BS' || name === 'WS') && D.hit && /\d\+/.test(val)) {
      // −1 to the Hit roll shown as the number now needed (3+ becomes 4+); an unmodified 6 always hits, so never worse than 6+
      const m = /^(\d)\+$/.exec(val.trim());
      if (m) return red(`${Math.min(6, +m[1] + D.hit)}+`, `${D.label}: subtract ${D.hit} from the Hit roll (normally ${val})`);
      return red(`${fmt(val)} <span class="dmg-mod">−${D.hit}</span>`, `${D.label}: subtract ${D.hit} from the Hit roll`);
    }
    if (/Weapons/.test(k) && name === 'A' && D.halveA && val && val !== '-') {
      const n = Number(val);
      return red(isNaN(n) ? `${fmt(val)} ÷2` : String(Math.ceil(n / 2)), `${D.label}: Attacks halved (normally ${val}; round up)`);
    }
    return cellHtml(p, c);
  }

  // A datasheet cell; changed values are gold. For keyword lists only the added keywords are gold.
  function cellHtml(p, c) {
    const val = p.chars[c.id] || '';
    if (!(p.changed || []).includes(c.id)) return `<td>${fmt(val)}</td>`;
    const tip = `title="Changed${(p.ann || []).length ? ' by ' + esc(p.ann.join(', ')) : ' by an ability, wargear, enhancement or detachment'}${p.base && p.base[c.id] !== undefined ? ' (was ' + esc(p.base[c.id] || '–') + ')' : ''}"`;
    if (/keyword/i.test(c.name || '') && p.base) {
      const split = (x) => String(x || '').split(/,\s*|,\u00a0/).map(k => k.trim()).filter(k => k && k !== '-');
      const was = new Set(split(p.base[c.id]).map(k => k.toLowerCase()));
      const parts = split(val).map(k => was.has(k.toLowerCase()) ? fmt(k) : `<span class="kw-new">${fmt(k)}</span>`);
      return `<td ${tip}>${parts.join(', ') || '-'}</td>`;
    }
    return `<td class="modded" ${tip}>${fmt(val)}</td>`;
  }

  function renderRosterSummary() {
    const r = S.roster;
    const rules = armyRulesHtml(r);
    return `<div class="panel-head"><h2>Roster</h2></div>
      <pre class="summary">${esc(exportText(r))}</pre>
      ${rules || '<p class="muted small">Pick a detachment (under Configuration on the left) to see its rules here.</p>'}`;
  }

  // ------------------------------------------------------------------ exports
  function exportText(r) {
    const cat = r.catalog;
    const total = E.rosterCost(r, cat.ptsType);
    const lines = [];
    lines.push(`${r.name} (${total}${r.costLimit ? '/' + r.costLimit : ''} pts)`);
    lines.push(`${cat.cats[0].name}`);
    for (const f of r.forces) {
      const cfgs = f.children.filter(isCfg);
      cfgs.filter(s => s.node.name !== SHOWHIDE).forEach(s => { const kids = s.children.map(c => E.ev(c).name).join(', '); lines.push(`${E.ev(s).name}: ${kids}`); });
      const groups = new Map();
      f.children.filter(s => !isCfg(s)).forEach(s => { const c = cat.catName(E.ev(s).primary) || 'Other'; if (!groups.has(c)) groups.set(c, []); groups.get(c).push(s); });
      const order = f.node.categoryLinks.map(c => c.name);
      const keys = [...groups.keys()].sort((a, b) => { const ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib); });
      for (const k of keys) {
        lines.push('');
        lines.push(k.toUpperCase());
        for (const s of groups.get(k)) {
          const att = E.attachedTarget(s), led = E.attachedLeaders(s);
          const tag = att ? ` [attached to ${E.ev(att).name}]` : (led.length ? ` [with ${led.map(l => E.ev(l).name).join(', ')}]` : '');
          lines.push(`${s.customName ? s.customName + ' – ' : ''}${E.ev(s).name} (${E.totalCost(s, cat.ptsType)} pts)${tag}`);
          const rec = (x, depth, mult) => {
            x.children.forEach(c => {
              const n = c.number * mult;
              lines.push(`${'  '.repeat(depth)}• ${n > 1 ? n + 'x ' : ''}${E.ev(c).name}`);
              rec(c, depth + 1, n);
            });
          };
          rec(s, 1, 1);
        }
      }
    }
    if (r.notes) { lines.push(''); lines.push('Notes: ' + r.notes); }
    return lines.join('\n');
  }

  function download(name, text, type) {
    const blob = new Blob([text], { type: type || 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const fileSafe = (s) => s.replace(/[\\/:*?"<>|]+/g, '_');

  function printRoster() {
    const r = S.roster;
    let html = `<h1>${esc(r.name)}</h1><pre class="summary">${esc(exportText(r))}</pre>`;
    const ar = armyRulesHtml(r);
    if (ar) html += `<div class="print-army">${ar}</div>`;
    const allRules = new Map();
    r.forces.forEach(f => f.children.filter(s => !isCfg(s)).forEach(s => {
      html += renderDatasheet(s, { ruleNamesOnly: true });
      E.collectInfo(s, true).rules.forEach(rl => { if (!allRules.has(rl.name)) allRules.set(rl.name, rl); });
    }));
    if (allRules.size) {
      const list = [...allRules.values()].sort((a, b) => a.name.localeCompare(b.name));
      html += `<div class="rules-ref"><h2>Rules reference</h2>${list.map(rl => `<div class="ref-rule"><b>${esc(rl.name)}</b><div>${fmt(rl.description)}</div></div>`).join('')}</div>`;
    }
    $('#print-area').innerHTML = html;
    window.print();
  }

  // ------------------------------------------------------------------ data folder import
  async function importFolder(files) {
    const list = [...files].filter(f => /\.json$/i.test(f.name));
    if (!list.length) { toast('No .json files found in that folder.'); return; }
    modal(`<h3>Importing data…</h3><p id="imp-status">0 / ${list.length}</p>`);
    const manifest = { gameSystem: null, catalogues: [], built: new Date().toISOString(), source: 'imported' };
    const docs = [];
    let i = 0;
    for (const f of list) {
      i++;
      $('#imp-status') && ($('#imp-status').textContent = `${i} / ${list.length} – ${f.name}`);
      try {
        const doc = JSON.parse(await f.text());
        const o = doc.gameSystem || doc.catalogue;
        if (!o) continue;
        docs.push({ id: o.id, doc });
        const info = { id: o.id, name: o.name, file: o.id + '.js', revision: o.revision };
        if (doc.gameSystem) manifest.gameSystem = info;
        else { info.library = !!o.library; info.links = (o.catalogueLinks || []).map(l => ({ id: l.targetId, importRootEntries: !!l.importRootEntries })); manifest.catalogues.push(info); }
      } catch (e) { console.warn('skip', f.name, e); }
    }
    if (!manifest.gameSystem) { closeModal(); toast('No game system file (Warhammer 40,000.json) found in that folder.', 6000); return; }
    try {
      await E.IDB.clear();
      for (const d of docs) await E.IDB.set('file:' + d.id, d.doc);
      await E.IDB.set('manifest', manifest);
    } catch (e) { closeModal(); toast('Could not store data in the browser: ' + e.message, 8000); return; }
    closeModal();
    toast('Data imported – reloading…');
    setTimeout(() => location.reload(), 600);
  }

  // ------------------------------------------------------------------ events
  function bindGlobal() {
    document.addEventListener('click', onClick);
    document.addEventListener('input', onInput);
    document.addEventListener('change', onChange);
    document.addEventListener('keydown', (ev) => {
      if (S.view !== 'roster') return;
      if (ev.target && /INPUT|TEXTAREA/.test(ev.target.tagName) && ev.target.type !== 'checkbox' && ev.target.type !== 'radio') return;
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z') { ev.preventDefault(); ev.shiftKey ? redo() : undo(); }
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'y') { ev.preventDefault(); redo(); }
    });
    $('#file-import').addEventListener('change', async (ev) => {
      const f = ev.target.files[0]; ev.target.value = '';
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        if (!data.forces || !data.catalogueId) throw new Error('Not a roster file from this app');
        if (Store.all()[data.id]) data.id = data.id + '-' + Date.now().toString(36);
        Store.put(data); closeModal(); toast('Roster imported'); renderHome();
      } catch (e) { toast('Import failed: ' + e.message, 6000); }
    });
    $('#ros-import').addEventListener('change', async (ev) => {
      const f = ev.target.files[0]; ev.target.value = '';
      if (f) importRosNow(f);
    });
    $('#folder-import').addEventListener('change', (ev) => { const fs = ev.target.files; importFolder(fs); ev.target.value = ''; });
    $('#modal').addEventListener('click', (ev) => { if (ev.target.id === 'modal') closeModal(); });
  }

  function onInput(ev) {
    const t = ev.target;
    if (t.id === 'add-search') { S.addFilter = t.value; S._focusSearch = true; renderRoster(); }
  }

  function onChange(ev) {
    const t = ev.target;
    if (t.id === 'roster-name') { S.roster.name = t.value.trim() || 'Roster'; commitNoUndo(); }
    else if (t.id === 'attach-select') {
      const s = selFromPath(t.dataset.path.split(',').map(Number));
      if (!s) return;
      beginChange();
      if (!t.value) { s.attachedTo = null; s.assocId = null; }
      else {
        const [aid, uid] = t.value.split('|');
        const target = s.force.children.find(x => String(x.uid) === uid);
        s.attachedTo = target || null; s.assocId = target ? aid : null;
      }
      S.selPath = pathOf(s);
      commit();
    }
    else if (t.id === 'roster-notes') { S.roster.notes = t.value; Store.put(E.serialize(S.roster)); }
    else if (t.id === 'dp-ov-num') { const n = parseInt(t.value, 10); setDpOverride(isNaN(n) ? null : n); }
    else if (t.dataset.act === 'opt-num') {
      const o = findOptById(t.dataset.id); if (!o) return;
      const n = Math.max(0, parseInt(t.value, 10) || 0);
      setOptionCount(o, n);
    }
  }

  // ------------------------------------------------------------------ tap for details
  // Things that explain themselves on mouse hover (red Damaged values, gold changed values, force disposition
  // icons, tags) also explain themselves when tapped, for touch screens.
  const TIP_SEL = 'td.dmg, td.modded, td[title^="Changed"], .fd-icon, .ann, .mk[title], .dp-cost, .tb-short[title], .att-mark, .tip[title]';
  function hideTip() { const t = document.getElementById('tap-tip'); if (t) t.remove(); }
  function showTip(el) {
    hideTip();
    const text = el.getAttribute('title') || el.getAttribute('alt'); if (!text) return;
    const t = document.createElement('div'); t.id = 'tap-tip'; t.textContent = text; document.body.appendChild(t);
    const r = el.getBoundingClientRect(), w = t.offsetWidth, h = t.offsetHeight;
    let x = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8);
    let y = r.bottom + 8; if (y + h > innerHeight - 8) y = Math.max(8, r.top - h - 8);
    t.style.left = x + 'px'; t.style.top = y + 'px';
  }
  document.addEventListener('click', (ev) => {
    const el = ev.target.closest && ev.target.closest(TIP_SEL);
    if (!el) { hideTip(); return; }
    // an icon inside an option row shouldn't also tick the option
    if (el.closest('label')) { ev.preventDefault(); ev.stopPropagation(); }
    showTip(el);
  }, true);
  document.addEventListener('scroll', hideTip, true);

  // phones: after switching tab, start at the top of the page
  function phoneTop() { if (window.matchMedia && matchMedia('(max-width: 600px)').matches) { const m = $('#main'); if (m) m.scrollTop = 0; } }

  async function onClick(ev) {
    const el = ev.target.closest('[data-act]');
    // any click outside the ⋯ button closes the ⋯ menu
    if (S.tbMore && (!el || el.dataset.act !== 'tb-more')) { S.tbMore = false; const m = document.querySelector('#topbar-roster .tb-menu'); if (m) m.remove(); }
    if (!el) return;
    const act = el.dataset.act;
    if (el.tagName === 'INPUT' && el.dataset.act === 'opt-num') return;
    switch (act) {
      case 'home': if (window.Play && Play.isOpen()) Play.closeQuiet(); if (S.view !== 'home') renderHome(); break;
      case 'play': {
        if (!window.Play) { toast('Play mode didn’t load – press Ctrl+F5 to reload the page.', 6000); break; }
        S.view = 'play';
        try { Play.open(); } catch (e) { console.error(e); S.view = 'roster'; renderRoster(true); toast('Play mode error: ' + e.message, 8000); }
        break;
      }
      case 'create': createRoster(); break;
      case 'open': openSaved(el.dataset.id); break;
      case 'del-roster': {
        const r = Store.all()[el.dataset.id];
        if (r && confirmBox(`Delete roster “${r.name}”?`)) { Store.del(el.dataset.id); renderHome(); }
        break;
      }
      case 'dup-roster': {
        const r = JSON.parse(JSON.stringify(Store.all()[el.dataset.id]));
        r.id = 'r' + Date.now().toString(36); r.name += ' (copy)'; r.updated = new Date().toISOString();
        Store.put(r); renderHome(); break;
      }
      case 'dl-roster': { const r = Store.all()[el.dataset.id]; download(fileSafe(r.name) + '.roster.json', JSON.stringify(r, null, 1)); break; }
      case 'import-roster': $('#file-import').click(); break;
      case 'load-folder': $('#folder-import').click(); break;
      case 'reset-data': await E.IDB.clear(); location.reload(); break;

      case 'show-add': S.mode = 'add'; S.selPath = null; S.ptab = el.closest('#col-mid') ? 'army' : 'add'; renderRoster(); phoneTop(); break;
      case 'ptab': {
        const t = el.dataset.t;
        if (t === 'add') { S.mode = 'add'; S.selPath = null; }
        S.ptab = t; renderRoster(); phoneTop(); break;
      }
      case 'tb-more': S.tbMore = !S.tbMore; renderRoster(); return;
      case 'add-cat': S.addCat = el.dataset.cat; renderRoster(); break;
      case 'toggle-allies': Prefs.hideAllies = !el.checked; savePrefs(); renderRoster(); break;
      case 'toggle-show': {
        const f = S.roster.forces[0];
        beginChange();
        ensureShowHide(f);
        const sh = showHideSel(f);
        const node = sh && S.catalog.children(sh.node).find(o => o.name === el.dataset.name);
        if (node) { const ex = E.selsOf(sh, node); if (ex.length) ex.forEach(x => E.removeSel(x)); else E.addSel(sh, node, [], 1); }
        commit(); break;
      }
      case 'open-showhide': { const sh = showHideSel(S.roster.forces[0]); if (sh) { S.selPath = pathOf(sh); S.mode = 'unit'; S.ptab = 'unit'; renderRoster(); phoneTop(); } break; }
      case 'add': {
        const f = S.roster.forces[0];
        const n = S.catalog.rootNodes().find(x => x.key === el.dataset.key);
        if (!n) return;
        beginChange();
        const s = E.addSel(f, n, [], 1);
        S.selPath = pathOf(s); S.mode = 'unit'; S.ptab = 'unit';
        commit(); phoneTop();
        break;
      }
      case 'select': {
        if (ev.target.closest('button')) return;
        S.selPath = el.dataset.path.split(',').map(Number); S.mode = 'unit'; S.ptab = 'unit'; renderRoster(); phoneTop(); break;
      }
      case 'remove': {
        const s = selFromPath(el.dataset.path.split(',').map(Number));
        if (!s) return;
        beginChange(); E.removeSel(s);
        if (S.selPath && S.selPath.join(',') === el.dataset.path) { S.selPath = null; S.mode = 'add'; }
        else if (S.selPath) { const cur = selFromPath(S.selPath); if (!cur) { S.selPath = null; S.mode = 'add'; } }
        commit(); break;
      }
      case 'dup': {
        const s = selFromPath(el.dataset.path.split(',').map(Number));
        if (!s) return;
        beginChange();
        const copy = cloneSel(s, s.parent);
        s.parent.children.splice(s.parent.children.indexOf(s) + 1, 0, copy);
        S.selPath = pathOf(copy); S.mode = 'unit'; S.ptab = 'unit';
        commit(); phoneTop(); break;
      }
      case 'rename': {
        const s = rootOf(selFromPath(S.selPath));
        const name = prompt('Custom name for this unit (leave empty to clear):', s.customName || '');
        if (name === null) return;
        beginChange(); s.customName = name.trim(); commit(); break;
      }
      case 'toggle-errors': S.showErrors = !S.showErrors; if (S.showErrors) S.ptab = 'army'; renderRoster(); phoneTop(); break;
      case 'rename-list': { const n = prompt('List name:', S.roster.name); if (n !== null) { S.roster.name = n.trim() || 'Roster'; commitNoUndo(); } break; }
      case 'goto-err': {
        const e = S._errs[Number(el.dataset.i)];
        if (e && e.sel) { S.selPath = pathOf(rootOf(e.sel)); S.mode = 'unit'; S.ptab = 'unit'; renderRoster(); phoneTop(); }
        break;
      }
      case 'toggle-group': {
        const k = el.dataset.g; const g = el.parentElement;
        collapsedState[k] = !g.classList.contains('collapsed');
        g.classList.toggle('collapsed'); break;
      }
      case 'opt-check': { ev.preventDefault(); const o = findOptById(el.dataset.id); if (!o) return; const n = E.selsOf(o.P, o.node).length ? 0 : 1; setOptionCount(o, n); break; }
      case 'opt-info': {
        ev.preventDefault(); ev.stopPropagation();
        const id = el.dataset.id;
        if (el.dataset.auto === '1') { S.infoOpen.has('x' + id) ? S.infoOpen.delete('x' + id) : S.infoOpen.add('x' + id); }
        else { S.infoOpen.has(id) ? S.infoOpen.delete(id) : S.infoOpen.add(id); }
        renderRoster(); break;
      }
      case 'opt-radio': { ev.preventDefault(); const o = findOptById(el.dataset.id); if (o) chooseRadio(o); break; }
      case 'opt-inc': case 'opt-dec': {
        ev.preventDefault();
        const o = findOptById(el.dataset.id); if (!o) return;
        const cur = E.selsOf(o.P, o.node).reduce((a, c) => a + c.number, 0);
        const step = Number(el.dataset.step) || 1;
        setOptionCount(o, Math.max(0, cur + (act === 'opt-inc' ? step : -step)));
        break;
      }
      case 'dp-ov-inc': case 'dp-ov-dec': {
        const dpType = S.catalog.costTypes.find(t => t.name === 'Detachment Points');
        const base = dpType ? costTypeLimit(S.roster, dpType.id, true) : 0;
        const cur = S.roster.dpOverride !== null && S.roster.dpOverride !== undefined ? S.roster.dpOverride : (base || 0);
        setDpOverride(cur + (act === 'dp-ov-inc' ? 1 : -1));
        break;
      }
      case 'dp-ov-reset': ev.preventDefault(); setDpOverride(null); break;
      case 'undo': undo(); break;
      case 'redo': redo(); break;
      case 'export-text': case 'export-fmt': {
        if (act === 'export-fmt') S.exportFmt = el.dataset.fmt;
        const fmtName = S.exportFmt || 'gw';
        const txt = exportByFmt(fmtName);
        const tabs = [['gw', 'GW app'], ['wtc', 'WTC / tournament'], ['simple', 'Simple']];
        modal(`<h3>Export list</h3>
          <div class="chips">${tabs.map(([k, l]) => `<button class="chip ${k === fmtName ? 'on' : ''}" data-act="export-fmt" data-fmt="${k}">${l}</button>`).join('')}</div>
          <p class="muted small">${{ gw: 'The standard text used by the Warhammer 40,000 app, New Recruit and most events.', wtc: 'New Recruit’s compact “+++” format that many tournament organisers ask for.', simple: 'This app’s own readable summary.' }[fmtName]}</p>
          <textarea class="export" readonly>${esc(txt)}</textarea>
          <div class="row-end"><button class="btn" data-act="copy-export">Copy</button><button class="btn" data-act="dl-text">Download .txt</button><button class="btn primary" data-act="close-modal">Close</button></div>`);
        break;
      }
      case 'copy-export': {
        const ta = $('.export'); ta.select();
        try { await navigator.clipboard.writeText(ta.value); } catch (e) { document.execCommand('copy'); }
        toast('Copied to clipboard'); break;
      }
      case 'dl-text': download(fileSafe(S.roster.name) + (S.exportFmt && S.exportFmt !== 'simple' ? '-' + S.exportFmt : '') + '.txt', exportByFmt(S.exportFmt || 'gw'), 'text/plain'); break;
      case 'import-list': openImport('text'); break;
      case 'import-tab': openImport(el.dataset.tab); break;
      case 'pick-ros': $('#ros-import').click(); break;
      case 'pick-json': $('#file-import').click(); break;
      case 'do-import-text': importTextNow(); break;
      case 'close-modal': closeModal(); break;
      case 'print': printRoster(); break;
      case 'dl-current': download(fileSafe(S.roster.name) + '.roster.json', JSON.stringify(E.serialize(S.roster), null, 1)); break;
    }
  }

  function confirmBox(msg) { return window.confirm(msg); }

  // ------------------------------------------------------------------ list import / export formats
  function exportByFmt(f) {
    if (f === 'wtc') return ListIO.exportWTC(S.roster);
    if (f === 'simple') return exportText(S.roster);
    return ListIO.exportGW(S.roster);
  }
  function openImport(tab) {
    const facs = factionGroups();
    const opts = Object.keys(facs).map(g => `<optgroup label="${esc(g)}">${facs[g].map(c => `<option value="${esc(c.id)}">${esc(shortName(c.name))}</option>`).join('')}</optgroup>`).join('');
    const tabs = [['text', 'Paste list text'], ['ros', 'BattleScribe / New Recruit file'], ['json', 'This app’s roster file']];
    let body = '';
    if (tab === 'text') body = `<p class="muted small">Paste a list exported from the Warhammer 40,000 app, New Recruit (normal or WTC format) or this app. Units and wargear are matched by name; anything that can't be matched is listed afterwards.</p>
      <label class="imp-row">Faction <select id="imp-fac"><option value="">Detect automatically</option>${opts}</select></label>
      <textarea id="imp-text" class="export" placeholder="Paste the list here…"></textarea>
      <div class="row-end"><button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-act="do-import-text">Import</button></div>`;
    else if (tab === 'ros') body = `<p class="muted small">Choose a <b>.rosz</b> or <b>.ros</b> roster file exported from New Recruit or BattleScribe. These files use the same data ids as your BSData files, so units and options are matched exactly.</p>
      <div class="row-end"><button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-act="pick-ros">Choose file…</button></div>`;
    else body = `<p class="muted small">A <b>.roster.json</b> file saved with this app's “Save file” button.</p>
      <div class="row-end"><button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-act="pick-json">Choose file…</button></div>`;
    modal(`<h3>Import list</h3><div class="chips">${tabs.map(([k, l]) => `<button class="chip ${k === tab ? 'on' : ''}" data-act="import-tab" data-tab="${k}">${l}</button>`).join('')}</div>${body}`);
    if (tab === 'text') setTimeout(() => { const t = $('#imp-text'); if (t) t.focus(); }, 30);
  }
  async function importTextNow() {
    const text = $('#imp-text').value;
    if (!text.trim()) { toast('Paste a list first.'); return; }
    const facId = $('#imp-fac').value || ListIO.detectFaction(text, E.Data.manifest);
    if (!facId) { toast('Couldn’t tell which faction this is – pick it from the Faction list.', 6000); $('#imp-fac').focus(); return; }
    closeModal();
    await withLoading(async () => {
      const cat = await E.openCatalog(facId);
      const parsed = ListIO.parseText(text);
      const { roster, report } = ListIO.buildFromText(cat, parsed, {});
      openRoster(cat, roster);
      showImportReport(report, parsed.units.length, 'text');
    });
  }
  async function importRosNow(file) {
    await withLoading(async () => {
      const xml = await ListIO.readRosFile(file);
      const ros = ListIO.parseRos(xml);
      if (!ros.forces.length) throw new Error('The file has no forces.');
      const m = E.Data.manifest;
      const f0 = ros.forces[0];
      let info = m.catalogues.find(c => c.id === f0.catalogueId) || m.catalogues.find(c => c.name === f0.catalogueName);
      if (!info) throw new Error(`This roster is for “${f0.catalogueName || f0.catalogueId}”, which isn't in your data.`);
      const cat = await E.openCatalog(info.id);
      const { roster, report } = ListIO.buildFromRos(cat, ros);
      if (ros.gameSystemId && m.gameSystem && ros.gameSystemId !== m.gameSystem.id) report.notes.unshift('This file was made for a different game system / edition – some entries may not match.');
      openRoster(cat, roster);
      showImportReport(report, roster.forces[0].children.length, 'ros');
    });
  }
  function showImportReport(rep, n, kind) {
    const total = E.rosterCost(S.roster, pts());
    const ok = !rep.unmatched.length && !rep.ptsDiff.length;
    modal(`<h3>${ok ? '✓ List imported' : 'List imported – please check'}</h3>
      <p>${esc(S.roster.name)} · ${E.rosterCost(S.roster, pts())} pts${S.roster.costLimit ? ' / ' + S.roster.costLimit : ''}.</p>
      ${rep.unmatched.length ? `<div class="imp-sec"><b>Couldn't match (${rep.unmatched.length})</b> – add these by hand:<ul>${rep.unmatched.map(u => `<li>${esc(u)}</li>`).join('')}</ul></div>` : ''}
      ${rep.ptsDiff.length ? `<div class="imp-sec"><b>Points differ from the imported list</b> – usually a points update or a different option:<ul>${rep.ptsDiff.map(u => `<li>${esc(u)}</li>`).join('')}</ul></div>` : ''}
      ${rep.notes.length ? `<div class="imp-sec muted small"><ul>${[...new Set(rep.notes)].slice(0, 12).map(u => `<li>${esc(u)}</li>`).join('')}</ul></div>` : ''}
      ${ok ? '<p class="muted small">Everything matched and the points agree.</p>' : ''}
      ${kind === 'text' ? '<p class="muted small">Text lists don’t say which unit a Leader is attached to – set attachments on each character.</p>' : ''}
      <div class="row-end"><button class="btn primary" data-act="close-modal">OK</button></div>`);
  }

  function cloneSel(s, parent) {
    const c = new E.Sel(parent, s.node, s.groups, s.number);
    c.customName = s.customName;
    c.children = s.children.map(k => cloneSel(k, c));
    return c;
  }

  // API for play mode (play.js reads this when Play is pressed – no load-order timing involved)
  window.AppAPI = {
    S: () => S, esc, fmt, toast, isCfg, renderDatasheet, armyRulesHtml, armyRuleItems,
    back: () => { S.view = 'roster'; renderRoster(true); },
  };

  boot().catch(e => { console.error(e); $('#main').innerHTML = `<div class="home"><div class="card"><h2>Something went wrong</h2><pre>${esc(e.stack || e.message)}</pre></div></div>`; });
})();
