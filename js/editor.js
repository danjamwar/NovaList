/* BSData visual editor – edits the wh40k-11e-main JSON files in place. */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s);
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hex4 = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0');
  const newId = () => `${hex4()}-${hex4()}-${hex4()}-${hex4()}`;
  const safeName = (s) => s.replace(/[^A-Za-z0-9_-]/g, '_');

  function toast(msg, ms) { const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), ms || 3000); }
  function modal(html) { $('#modal-body').innerHTML = html; $('#modal').classList.remove('hidden'); }
  function closeModal() { $('#modal').classList.add('hidden'); $('#modal-body').innerHTML = ''; }

  // ------------------------------------------------------------------ small IndexedDB store (folder handle)
  const KV = {
    open() { return new Promise((res, rej) => { const r = indexedDB.open('olb-editor', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    async get(k) { const db = await this.open(); return new Promise(res => { const t = db.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => res(t.result); t.onerror = () => res(undefined); }); },
    async set(k, v) { const db = await this.open(); return new Promise(res => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = () => res(); tx.onerror = () => res(); }); },
  };

  // ------------------------------------------------------------------ state
  const S = {
    rootDir: null, dataDir: null, appDataDir: null, readOnly: false, folderName: '',
    files: [], gs: null,
    idMap: new Map(), parent: new WeakMap(), usedBy: new Map(),
    file: null, sel: null, search: '', expanded: new WeakSet(), openSections: new Set(),
    undo: [], showAllCosts: false, treeFilter: '', view: 'form', ptsFilter: '', ptsHideLegends: false, ptsHideCrucible: false, orig: new WeakMap(), wiz: null, baseline: null, check: null, checkScope: 'faction', showKnown: false,
    secOpen: { det: true, basics: true, costs: true, profiles: true, rules: true, children: true, constraints: true, link: true, target: true, chars: true, desc: true },
  };

  const ENTRY_KEYS = { selectionEntries: 'entry', sharedSelectionEntries: 'entry', selectionEntryGroups: 'group', sharedSelectionEntryGroups: 'group',
    entryLinks: 'link', profiles: 'profile', sharedProfiles: 'profile', rules: 'rule', sharedRules: 'rule', infoGroups: 'infoGroup',
    sharedInfoGroups: 'infoGroup', infoLinks: 'infoLink', categoryEntries: 'category', forceEntries: 'force', categoryLinks: 'categoryLink',
    constraints: 'constraint', modifiers: 'modifier', costTypes: 'costType', profileTypes: 'profileType', catalogueLinks: 'catalogueLink',
    publications: 'publication', associations: 'association', sharedAssociations: 'association' };
  const LINK_KEYS = new Set(['entryLinks', 'infoLinks', 'categoryLinks', 'catalogueLinks', 'associationLinks']);
  const STRUCT_KEYS = ['selectionEntries', 'selectionEntryGroups', 'entryLinks'];

  // ------------------------------------------------------------------ loading
  async function readDir(dir) {
    const out = [];
    for await (const [name, h] of dir.entries()) if (h.kind === 'file' && /\.json$/i.test(name)) out.push({ name, handle: h });
    return out;
  }

  async function openHandle(root) {
    S.rootDir = root; S.readOnly = false; S.folderName = root.name;
    let dataDir = null, appDataDir = null;
    try { dataDir = await root.getDirectoryHandle('wh40k-11e-main'); } catch (e) { /* not the parent */ }
    if (dataDir) { try { appDataDir = await root.getDirectoryHandle('data', { create: true }); } catch (e) { appDataDir = null; } }
    else dataDir = root;
    const entries = await readDir(dataDir);
    if (!entries.length) { toast('No BSData .json files found in that folder. Pick the "new recruit" folder or the wh40k-11e-main folder.', 7000); return false; }
    S.dataDir = dataDir; S.appDataDir = appDataDir;
    // backups go next to wh40k-11e-main when the parent folder was chosen, otherwise inside it
    S.backupParent = dataDir === root ? dataDir : root;
    S.backupDirName = dataDir === root ? '_backups' : 'backups';
    const files = [];
    let n = 0;
    for (const e of entries) {
      n++; setLoading(`Reading ${n}/${entries.length}: ${e.name}`);
      const f = await e.handle.getFile();
      files.push({ name: e.name, handle: e.handle, text: await f.text() });
    }
    loadTexts(files);
    try { await KV.set('dir', root); } catch (e) { /* ignore */ }
    setLoading('Checking data…');
    await new Promise(r => setTimeout(r, 20));
    await loadBaseline();
    return true;
  }

  async function openFileList(list) {
    const arr = [...list].filter(f => /\.json$/i.test(f.name));
    const inMain = arr.filter(f => /wh40k-11e-main\//.test(f.webkitRelativePath || ''));
    const use = inMain.length ? inMain : arr;
    if (!use.length) { toast('No .json files found.'); return; }
    S.readOnly = true; S.folderName = (use[0].webkitRelativePath || '').split('/')[0];
    const files = [];
    for (const f of use) files.push({ name: f.name, handle: null, text: await f.text() });
    loadTexts(files);
    await loadBaseline();
    render();
  }

  function loadTexts(list) {
    S.files = [];
    for (const f of list) {
      let doc;
      try { doc = JSON.parse(f.text); } catch (e) { console.warn('Bad JSON', f.name, e); continue; }
      const kind = doc.gameSystem ? 'gameSystem' : doc.catalogue ? 'catalogue' : null;
      if (!kind) continue;
      const top = doc[kind];
      S.files.push({ name: f.name, handle: f.handle, doc, top, kind, dirty: false, nl: f.text.endsWith('\n') });
    }
    S.files.sort((a, b) => (a.kind === 'gameSystem' ? -1 : b.kind === 'gameSystem' ? 1 : a.top.name.localeCompare(b.top.name)));
    S.gs = (S.files.find(f => f.kind === 'gameSystem') || {}).top || null;
    reindex();
    S.file = S.files.find(f => f.kind === 'catalogue' && !f.top.library) || S.files[0];
    S.sel = null; S.undo = [];
  }

  function reindex() {
    S.idMap = new Map(); S.parent = new WeakMap(); S.usedBy = new Map();
    for (const file of S.files) {
      S.parent.set(file.top, { parent: null, key: null, file });
      const walk = (obj) => {
        for (const k in obj) {
          const v = obj[k];
          if (!Array.isArray(v)) continue;
          for (const x of v) {
            if (!x || typeof x !== 'object') continue;
            S.parent.set(x, { parent: obj, key: k, file });
            if ('value' in x && !S.orig.has(x)) S.orig.set(x, x.value);
            if (x.id && !LINK_KEYS.has(k)) {
              if (!S.idMap.has(x.id)) S.idMap.set(x.id, []);
              S.idMap.get(x.id).push(x);
            }
            if (LINK_KEYS.has(k) && x.targetId) {
              if (!S.usedBy.has(x.targetId)) S.usedBy.set(x.targetId, []);
              S.usedBy.get(x.targetId).push(x);
            }
            walk(x);
          }
        }
      };
      walk(file.top);
    }
  }

  const info = (o) => S.parent.get(o) || {};
  const fileOf = (o) => info(o).file;
  const kindOf = (o) => { const i = info(o); if (!i.key) return 'file'; return ENTRY_KEYS[i.key] || i.key; };
  function byId(id, preferKinds) {
    const list = S.idMap.get(id) || [];
    if (preferKinds) { const p = list.find(o => preferKinds.includes(kindOf(o))); if (p) return p; }
    return list[0] || null;
  }
  function targetOf(link) {
    if (!link || !link.targetId) return null;
    const want = { selectionEntry: ['entry'], selectionEntryGroup: ['group'], profile: ['profile'], rule: ['rule'], infoGroup: ['infoGroup'] }[link.type];
    return byId(link.targetId, want || ['category', 'entry', 'group']);
  }
  const SPECIAL = { model: 'any model', unit: 'any unit', upgrade: 'any upgrade', any: 'anything', roster: 'roster', force: 'force' };
  function idLabel(id) {
    if (id === undefined || id === null || id === '') return '—';
    if (SPECIAL[id]) return SPECIAL[id];
    const o = byId(id);
    if (o) return o.name || id;
    const ct = costType(id); if (ct) return ct.name;
    return id;
  }
  function costTypes() { return (S.gs && S.gs.costTypes) || []; }
  function costType(id) { return costTypes().find(c => c.id === id); }
  function profileType(id) { const o = byId(id, ['profileType']); return o && o.characteristicTypes ? o : null; }
  function ptsId() { const c = costTypes().find(c => c.name === 'pts'); return c ? c.id : null; }
  function ancestors(o) { const out = []; let x = info(o).parent; while (x) { out.unshift(x); x = info(x).parent; } return out; }

  // ------------------------------------------------------------------ change tracking / undo
  function checkpoint(obj) {
    S.undo.push({ obj, json: JSON.stringify(obj) });
    if (S.undo.length > 60) S.undo.shift();
  }
  function checkpointMany(objs) {
    const uniq = [...new Set(objs)];
    S.undo.push(uniq.map(obj => ({ obj, json: JSON.stringify(obj) })));
    if (S.undo.length > 60) S.undo.shift();
  }
  function markDirty(obj) { const f = fileOf(obj); if (f) f.dirty = true; }
  function undo() {
    const top = S.undo.pop(); if (!top) return;
    const list = Array.isArray(top) ? top.slice().reverse() : [top];
    for (const u of list) {
      for (const k of Object.keys(u.obj)) delete u.obj[k];
      Object.assign(u.obj, JSON.parse(u.json));
      markDirty(u.obj);
    }
    reindex();
    if (S.sel && !S.parent.has(S.sel)) { S.sel = null; S.view = S.view === 'points' ? 'points' : 'form'; }
    render();
  }

  // ------------------------------------------------------------------ binding registry (per render)
  let REG = new Map(), REGN = 0;
  const ref = (o) => { const k = ++REGN; REG.set(k, o); return k; };
  function inp(obj, prop, opt) {
    opt = opt || {};
    const t = opt.type || 'str';
    const r = ref(obj);
    const v = obj[prop];
    const base = `data-ref="${r}" data-prop="${esc(prop)}" data-type="${t}"${opt.opt ? ' data-opt="1"' : ''}`;
    if (t === 'bool') return `<input type="checkbox" ${base} ${v ? 'checked' : ''}>`;
    if (t === 'text') return `<textarea ${base} rows="${opt.rows || 4}" class="${opt.cls || ''}">${esc(v)}</textarea>`;
    if (t === 'select' || t === 'selnum' || t === 'selbool') {
      const opts = opt.options.slice();
      if (v !== undefined && !opts.some(o => String(o[0]) === String(v))) opts.push([v, idLabel(v)]);
      return `<select ${base} class="${opt.cls || ''}">${opt.blank ? '<option value=""></option>' : ''}${opts.map(o => `<option value="${esc(o[0])}" ${String(o[0]) === String(v) ? 'selected' : ''}>${esc(o[1])}</option>`).join('')}</select>`;
    }
    const num = t === 'num';
    const changed = prop === 'value' && S.orig.has(obj) && S.orig.get(obj) !== v;
    return `<input ${num ? 'type="number" step="any"' : ''} ${base} value="${esc(v)}" class="${opt.cls || ''}${changed ? ' changed' : ''}" placeholder="${esc(opt.ph || '')}" ${changed ? `title="Was ${esc(S.orig.get(obj))}"` : ''}>`;
  }

  function applyInput(el) {
    const obj = REG.get(Number(el.dataset.ref));
    if (!obj) return;
    const prop = el.dataset.prop, t = el.dataset.type;
    let v;
    if (t === 'bool') v = el.checked;
    else if (t === 'num' || t === 'selnum') { v = el.value === '' ? undefined : Number(el.value); if (Number.isNaN(v)) return; }
    else if (t === 'selbool') v = el.value === 'true' ? true : el.value === 'false' ? false : el.value;
    else v = el.value;
    if ((t === 'select') && /^-?\d+(\.\d+)?$/.test(v) && typeof obj[prop] === 'number') v = Number(v);
    checkpoint(obj);
    if ((v === undefined || v === '') && el.dataset.opt) delete obj[prop]; else obj[prop] = v;
    markDirty(obj);
    if (prop === 'targetId' || prop === 'id') reindex();
    render();
  }

  // ------------------------------------------------------------------ RENDER
  function setLoading(msg) { const m = $('#main'); if (m) m.innerHTML = `<div class="loading">${esc(msg)}</div>`; }

  function render() {
    REG = new Map(); REGN = 0;
    renderTop();
    if (!S.files.length) { renderWelcome(); return; }
    const keep = {};
    ['#ed-tree', '#ed-form'].forEach(id => { const el = $(id); if (el) keep[id] = el.scrollTop; });
    $('#main').innerHTML = `<div class="ed">
      <aside class="ed-left">
        <select id="file-select">${fileOptions()}</select>
        <input id="search" class="search" placeholder="Search all files by name…" value="${esc(S.search)}">
        <div id="ed-tree" class="ed-tree">${S.search.trim().length >= 2 ? renderSearch() : renderTree()}</div>
      </aside>
      <section id="ed-form" class="ed-form">${S.view === 'check' ? renderCheck() : S.view === 'points' ? renderPoints() : S.sel ? renderForm(S.sel) : renderFileSummary()}</section>
    </div>`;
    Object.keys(keep).forEach(id => { const el = $(id); if (el) el.scrollTop = keep[id]; });
    if (S._focusSearch) { const i = $('#search'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); S._focusSearch = false; }
  }

  function renderTop() {
    const dirty = S.files.filter(f => f.dirty);
    $('#ed-top').innerHTML = S.files.length ? `
      <span class="pill sub">📁 ${esc(S.folderName)}${S.readOnly ? ' (read-only – saves download)' : ''}</span>
      <span class="spacer"></span>
      ${dirty.length ? `<span class="muted small">Unsaved: ${esc(dirty.map(f => f.top.name).join(', '))}</span>` : '<span class="muted small">All changes saved</span>'}
      <button class="btn sm" data-act="undo" ${S.undo.length ? '' : 'disabled'} title="Undo (Ctrl+Z)">↶ Undo</button>
      <button class="btn sm primary" data-act="save" ${dirty.length ? '' : 'disabled'}>💾 Save${dirty.length ? ' (' + dirty.length + ')' : ''}</button>
      <button class="btn sm ${S.view === 'check' ? 'primary' : ''}" data-act="show-check">✔ Check data</button>
      ${S.readOnly ? '' : '<button class="btn sm" data-act="backups">🕘 Backups</button>'}
      <button class="btn sm" data-act="change-folder">Change folder</button>` : '';
  }

  // Reopen the last folder. The permission request is made straight away (Chrome needs it to come
  // directly from the click), every step is shown on screen, and any problem says what to do next.
  let prevHandle = null;
  function openStatus(html, bad) {
    const el = $('#open-status');
    if (el) el.innerHTML = html ? `<div class="${bad ? 'bad-note' : 'muted'}" style="margin-top:10px">${html}</div>` : '';
  }
  async function reopenFolder() {
    const h = prevHandle;
    if (!h) { openStatus('No folder remembered – use <b>Choose folder…</b>.', true); return; }
    try {
      openStatus('Asking Chrome for permission to edit “' + esc(h.name) + '”… (look for a pop-up near the address bar)');
      let perm = 'prompt';
      try { perm = await h.queryPermission({ mode: 'readwrite' }); } catch (e) { /* older browser */ }
      if (perm !== 'granted') {
        const ask = h.requestPermission({ mode: 'readwrite' });
        const timeout = new Promise(res => setTimeout(() => res('timeout'), 20000));
        perm = await Promise.race([ask, timeout]);
      }
      if (perm === 'timeout') { openStatus('Chrome didn\'t answer the permission request. Click <b>Choose folder…</b> and pick the <b>' + esc(h.name) + '</b> folder instead.', true); return; }
      if (perm !== 'granted') { openStatus('Permission to edit the folder wasn\'t given. Click <b>Reopen</b> again and choose <b>Allow</b> / <b>Edit files</b>, or use <b>Choose folder…</b>.', true); return; }
      setLoading('Opening ' + h.name + '…');
      if (await openHandle(h)) render();
      else { await renderWelcome(); openStatus('No army data (.json files) was found in “' + esc(h.name) + '”. Use <b>Choose folder…</b> and pick the folder that contains <b>wh40k-11e-main</b>.', true); }
    } catch (e) {
      console.error('Reopen failed', e);
      await renderWelcome();
      openStatus('Couldn\'t reopen “' + esc(h.name) + '” (' + esc(e.name + ': ' + e.message) + '). The folder may have been moved or renamed – click <b>Choose folder…</b> and pick it again.', true);
    }
  }

  async function renderWelcome() {
    const hasFS = typeof window.showDirectoryPicker === 'function';
    let prev = null; try { prev = hasFS ? await KV.get('dir') : null; } catch (e) { /* ignore */ }
    prevHandle = prev || null;
    $('#main').innerHTML = `<div class="home"><section class="card">
      <h2>BSData editor</h2>
      <p>Edit the army data (points, stats, weapons, rules, options) in your <b>wh40k-11e-main</b> folder. Changes are written straight into the .json files, and the list builder's <code>data</code> folder is rebuilt automatically when you save.</p>
      ${hasFS ? `<p class="muted">Click below and choose your <b>new recruit</b> folder (the one containing <code>wh40k-11e-main</code> and <code>index.html</code>). Your browser will ask to allow editing – click <b>Edit files / Allow</b>.</p>
        ${prev ? `<button class="btn primary" data-act="reopen">Reopen “${esc(prev.name)}”</button> ` : ''}
        <button class="btn ${prev ? '' : 'primary'}" data-act="pick-folder">Choose folder…</button>`
      : `<p class="bad-note">This browser can't write to folders. Use <b>Chrome</b> or <b>Edge</b> for saving. You can still browse/edit here and download changed files.</p>
        <button class="btn primary" data-act="pick-folder-ro">Choose wh40k-11e-main folder (read-only)…</button>`}
      <div id="open-status"></div>
      <p class="muted small">Tip: back up the wh40k-11e-main folder before big edits. Ctrl+Z undoes changes before you save.</p>
    </section></div>`;
  }

  function fileOptions() {
    const g = { 'Game system': [], Factions: [], Libraries: [] };
    S.files.forEach((f, i) => g[f.kind === 'gameSystem' ? 'Game system' : f.top.library ? 'Libraries' : 'Factions'].push(`<option value="${i}" ${f === S.file ? 'selected' : ''}>${f.dirty ? '● ' : ''}${esc(f.top.name)}</option>`));
    return Object.keys(g).map(k => `<optgroup label="${k}">${g[k].join('')}</optgroup>`).join('');
  }

  // ---- tree
  const SECTIONS = [
    ['entryLinks', 'Units / root entries (links)', 'link'], ['selectionEntries', 'Root entries', 'entry'],
    ['sharedSelectionEntries', 'Shared entries (units, wargear, enhancements…)', 'entry'], ['sharedSelectionEntryGroups', 'Shared groups', 'group'],
    ['sharedProfiles', 'Shared profiles (stats, weapons, abilities)', 'profile'], ['sharedRules', 'Shared rules', 'rule'],
    ['sharedInfoGroups', 'Shared info groups', 'infoGroup'], ['categoryEntries', 'Categories / keywords', 'category'],
    ['forceEntries', 'Force entries', 'force'], ['costTypes', 'Cost types', 'costType'], ['profileTypes', 'Profile types', 'profileType'],
    ['catalogueLinks', 'Catalogue links', 'catalogueLink'], ['publications', 'Publications', 'publication'],
  ];
  const ADDABLE = { entryLinks: 'link', selectionEntries: 'entry', sharedSelectionEntries: 'entry', sharedSelectionEntryGroups: 'group', sharedProfiles: 'profile', sharedRules: 'rule', categoryEntries: 'category' };

  function renderTree() {
    const f = S.file, top = f.top;
    const flt = S.treeFilter.toLowerCase();
    let html = `<div class="tree-file"><b>${esc(top.name)}</b>${top.library ? ' <span class="badge">library</span>' : ''}
      <div class="muted small">${esc(f.name)} · revision ${esc(top.revision)}</div>
      <input id="tree-filter" class="search sm" placeholder="Filter this file…" value="${esc(S.treeFilter)}">
      ${f.kind === 'catalogue' ? `<div class="tree-tools"><button class="btn sm ${S.view === 'points' ? 'primary' : ''}" data-act="show-points">💲 Points table</button>
        ${S.readOnly ? '' : '<button class="btn sm" data-act="new-unit">＋ New unit</button><button class="btn sm" data-act="new-det">＋ New detachment</button>'}</div>` : ''}</div>`;
    for (const [key, label] of SECTIONS) {
      const arr = top[key];
      if ((!arr || !arr.length) && !ADDABLE[key]) continue;
      if ((!arr || !arr.length) && f.kind === 'gameSystem' && key === 'entryLinks') continue;
      const sk = f.name + '|' + key;
      let list = (arr || []).slice();
      if (key.startsWith('shared') || key === 'categoryEntries' || key === 'entryLinks') list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      if (flt) list = list.filter(o => (o.name || '').toLowerCase().includes(flt));
      const open = S.openSections.has(sk) || (flt && list.length);
      html += `<div class="tsec ${open ? 'open' : ''}"><div class="tsec-head" data-act="toggle-sec" data-k="${esc(sk)}"><span class="caret">▸</span>${esc(label)} <span class="muted">(${list.length}${flt ? '/' + (arr || []).length : ''})</span>
        ${ADDABLE[key] && !S.readOnly ? `<button class="icon add" title="Add" data-act="add-top" data-key="${key}">＋</button>` : ''}</div>`;
      if (open) html += `<ul class="tlist">${list.map(o => treeNode(o, 0)).join('')}</ul>`;
      html += '</div>';
    }
    return html;
  }

  function structChildren(o) {
    const src = kindOf(o) === 'link' ? [o, targetOf(o)] : [o];
    const out = [];
    for (const s of src) if (s) for (const k of STRUCT_KEYS) (s[k] || []).forEach(x => out.push(x));
    return out;
  }

  function nodeIcon(o) {
    const k = kindOf(o);
    const t = k === 'link' ? targetOf(o) : o;
    if (k === 'link' && !t) return '<span class="ic bad" title="Broken link">⚠</span>';
    const kk = kindOf(t);
    if (kk === 'group') return '<span class="ic g" title="Group">▤</span>';
    if (kk === 'entry') return { unit: '<span class="ic u" title="Unit">U</span>', model: '<span class="ic m" title="Model">M</span>' }[t.type] || '<span class="ic up" title="Upgrade">•</span>';
    return { profile: '<span class="ic p">P</span>', rule: '<span class="ic r">R</span>', infoGroup: '<span class="ic g">i</span>', category: '<span class="ic c">#</span>' }[kk] || '<span class="ic">·</span>';
  }
  function ptsOf(o) {
    const pid = ptsId();
    const c = (o.costs || []).find(c => c.typeId === pid);
    if (c) return c.value;
    if (kindOf(o) === 'link') { const t = targetOf(o); if (t) { const tc = (t.costs || []).find(c => c.typeId === pid); if (tc) return tc.value; } }
    return null;
  }

  function treeNode(o, depth) {
    const kids = depth < 12 ? structChildren(o) : [];
    const exp = S.expanded.has(o);
    const p = ptsOf(o);
    const isLink = kindOf(o) === 'link';
    return `<li><div class="tnode ${o === S.sel ? 'sel' : ''} ${o.hidden ? 'hid' : ''}" data-act="select" data-ref="${ref(o)}">
      ${kids.length ? `<span class="tw" data-act="expand" data-ref="${ref(o)}">${exp ? '▾' : '▸'}</span>` : '<span class="tw"></span>'}
      ${nodeIcon(o)}<span class="tname">${isLink ? '<span class="lnk" title="Link">↪</span>' : ''}${esc(o.name || '(unnamed)')}</span>${p ? `<span class="cost">${esc(p)}</span>` : ''}</div>
      ${exp && kids.length ? `<ul class="tlist">${kids.map(k => treeNode(k, depth + 1)).join('')}</ul>` : ''}</li>`;
  }

  function renderSearch() {
    const q = S.search.trim().toLowerCase();
    const res = [];
    const kinds = new Set(['entry', 'group', 'link', 'profile', 'rule', 'infoGroup', 'category', 'force']);
    for (const f of S.files) {
      const walk = (obj) => {
        for (const k in obj) {
          const v = obj[k]; if (!Array.isArray(v)) continue;
          for (const x of v) {
            if (!x || typeof x !== 'object') continue;
            if (res.length < 300 && x.name && kinds.has(ENTRY_KEYS[k]) && x.name.toLowerCase().includes(q)) res.push(x);
            walk(x);
          }
        }
      };
      walk(f.top);
    }
    if (!res.length) return '<p class="muted">No matches.</p>';
    return `<div class="muted small">${res.length >= 300 ? '300+' : res.length} results</div><ul class="tlist results">${res.map(o => {
      const a = ancestors(o).filter(x => x.name && x !== fileOf(o).top).map(x => x.name).slice(-2).join(' › ');
      return `<li><div class="tnode" data-act="select" data-ref="${ref(o)}">${nodeIcon(o)}<span class="tname">${kindOf(o) === 'link' ? '<span class="lnk">↪</span>' : ''}${esc(o.name)}
        <div class="muted small">${esc(fileOf(o).top.name)}${a ? ' › ' + esc(a) : ''} · ${esc(kindLabel(o))}</div></span>${ptsOf(o) ? `<span class="cost">${ptsOf(o)}</span>` : ''}</div></li>`;
    }).join('')}</ul>`;
  }

  function kindLabel(o) {
    const k = kindOf(o);
    if (k === 'entry') return o.type || 'entry';
    if (k === 'link') { const t = targetOf(o); return 'link → ' + (t ? kindLabel(t) : 'missing'); }
    return { group: 'group', profile: 'profile' + (o.typeName ? ' (' + o.typeName + ')' : ''), rule: 'rule', infoGroup: 'info group', category: 'category', force: 'force entry', infoLink: 'info link' }[k] || k;
  }

  function renderFileSummary() {
    const f = S.file, t = f.top;
    return `<div class="form-head"><div><h2>${esc(t.name)}</h2><div class="muted">${esc(f.name)}</div></div></div>
      <div class="sec-body">
        <div class="grid2">
          <label>Name ${inp(t, 'name')}</label>
          <label>Revision ${inp(t, 'revision', { type: 'num' })}</label>
        </div>
        <p class="muted">Pick something in the tree on the left, or search all files by name. Units are usually under
          <b>Units / root entries (links)</b> in a faction file – their stats, wargear and points live in the linked library entry, which the editor shows on the same page.</p>
        <p class="muted small">Tip: bump the revision number when you make changes so you can tell your edited file apart.</p>
      </div>`;
  }

  // ---- forms
  function sec(key, title, body, extraHead) {
    const open = S.secOpen[key] !== undefined ? S.secOpen[key] : false;
    return `<details class="sec" data-sec="${key}" ${open ? 'open' : ''}><summary>${title}${extraHead || ''}</summary><div class="sec-body">${body}</div></details>`;
  }

  function renderForm(o, embedded) {
    const k = kindOf(o);
    const f = fileOf(o);
    let html = '';
    if (!embedded) {
      const anc = ancestors(o).filter(x => x !== f.top && x.name);
      html += `<div class="crumbs"><a data-act="goto-file" data-name="${esc(f.name)}">${esc(f.top.name)}</a>${anc.map(a => ` › <a data-act="select" data-ref="${ref(a)}">${esc(a.name)}</a>`).join('')}</div>`;
    }
    if (S.check) {
      const mine = S.check.issues.filter(i => i.obj === o && !isKnown(i));
      if (mine.length) html += `<div class="issue-banner">${mine.map(i => `<div>${i.sev === 'error' ? '⛔' : '⚠'} ${esc(i.msg)}</div>`).join('')}<div class="muted small">From the last data check – <a data-act="show-check">re-check</a> after fixing.</div></div>`;
    }
    html += `<div class="form-head ${embedded ? 'embedded' : ''}"><div>
        <h2>${nodeIcon(o)} ${esc(o.name || '(unnamed)')}</h2>
        <div class="muted small">${esc(kindLabel(o))} · ${esc(f.top.name)} · id <code>${esc(o.id || '')}</code></div></div>
        ${!embedded && !S.readOnly && ['entry', 'group', 'link', 'profile', 'rule', 'infoGroup', 'category'].includes(k) ? `<div class="head-actions">
          <button class="btn sm" data-act="dup" data-ref="${ref(o)}" title="Duplicate (new ids)">⧉ Duplicate</button>
          <button class="btn sm danger" data-act="delete" data-ref="${ref(o)}">🗑 Delete</button></div>` : ''}</div>`;

    if (k === 'link' || k === 'infoLink') {
      const t = targetOf(o);
      html += sec('link', 'Link', `
        <div class="grid3"><label>Name ${inp(o, 'name')}</label><label>Hidden ${inp(o, 'hidden', { type: 'bool' })}</label><label>Type <input value="${esc(o.type)}" disabled></label></div>
        <div class="link-target">Points to: ${t ? `<a data-act="select" data-ref="${ref(t)}">${esc(t.name)}</a> <span class="muted small">(${esc(kindLabel(t))} in ${esc(fileOf(t).top.name)})</span>` : `<span class="bad">missing target ${esc(o.targetId)}</span>`}
          <button class="btn sm" data-act="relink" data-ref="${ref(o)}">Change target…</button></div>
        <p class="muted small">Settings below on the link only apply where this link is used. To change the unit everywhere, edit the target (further down).</p>`);
      if (k === 'link') {
        if (o.costs && o.costs.length) html += sec('lcosts', 'Link points overrides', costsBody(o));
        html += sec('lcats', `Link categories (${(o.categoryLinks || []).length})`, categoriesBody(o));
        html += sec('lcons', `Link constraints (${(o.constraints || []).length})`, constraintsBody(o));
        html += sec('lmods', `Link modifiers (${(o.modifiers || []).length})`, modifiersBody(o));
        if (o.selectionEntries || o.selectionEntryGroups || o.entryLinks) html += sec('lchildren', 'Link extra children', childrenBody(o));
      } else html += sec('lmods', `Link modifiers (${(o.modifiers || []).length})`, modifiersBody(o));
      if (t) html += `<div class="target-wrap"><div class="target-title">Target: ${esc(t.name)} <span class="muted small">(${esc(fileOf(t).top.name)})</span></div>${renderForm(t, true)}</div>`;
      html += sec('raw', 'Advanced – raw JSON (link)', rawBody(o));
      return html;
    }

    if (k === 'entry' || k === 'group') {
      html += sec('basics', 'Basics', `<div class="grid3">
        <label>Name ${inp(o, 'name')}</label>
        ${k === 'entry' ? `<label>Type ${inp(o, 'type', { type: 'select', options: [['upgrade', 'upgrade'], ['model', 'model'], ['unit', 'unit']] })}</label>` : `<label>Default choice ${inp(o, 'defaultSelectionEntryId', { type: 'select', opt: true, options: [['none', '(none)']].concat(structChildren(o).map(c => [c.id, c.name])) })}</label>`}
        <label class="cb">Hidden ${inp(o, 'hidden', { type: 'bool' })}</label>
        ${k === 'entry' ? `<label class="cb">Collective ${inp(o, 'collective', { type: 'bool' })}</label>` : ''}
        <label>Comment ${inp(o, 'comment', { opt: true })}</label>
        <label>Sort index ${inp(o, 'sortIndex', { type: 'num', opt: true })}</label></div>`);
      if (k === 'entry' && isDetachment(o)) html += sec('det', 'Detachment – rules, enhancements & force dispositions', detBody(o));
      if (k === 'entry') html += sec('costs', 'Points & costs', costsBody(o));
      if (k === 'entry') html += sec('profiles', `Profiles – stats, weapons, abilities (${(o.profiles || []).length})`, profilesBody(o, 'profiles'));
      if (k === 'entry' || (o.rules && o.rules.length)) html += sec('rules', `Rules (${(o.rules || []).length})`, rulesBody(o, 'rules'));
      html += sec('children', `Options / contents (${structChildren(o).length})`, childrenBody(o));
      html += sec('constraints', `Limits – min/max (${(o.constraints || []).length})`, constraintsBody(o));
      html += sec('modifiers', `Modifiers (${(o.modifiers || []).length}${o.modifierGroups ? ' + ' + o.modifierGroups.length + ' groups' : ''})`, modifiersBody(o));
      if (k === 'entry' && (o.type === 'unit' || o.type === 'model')) html += sec('assoc', `Can lead / attach to (${(o.associations || []).length + (o.associationLinks || []).length})`, assocBody(o));
      if (k === 'entry') html += sec('cats', `Categories / keywords (${(o.categoryLinks || []).length})`, categoriesBody(o));
      if (k === 'entry') html += sec('infolinks', `Linked rules & profiles (${(o.infoLinks || []).length})`, infoLinksBody(o));
      if (o.infoGroups && o.infoGroups.length) html += sec('infogroups', `Info groups (${o.infoGroups.length})`, `<ul class="plain">${o.infoGroups.map(g => `<li><a data-act="select" data-ref="${ref(g)}">${esc(g.name)}</a></li>`).join('')}</ul>`);
    } else if (k === 'profile') {
      html += sec('chars', 'Profile', profileCard(o, null, null));
      html += sec('modifiers', `Modifiers (${(o.modifiers || []).length})`, modifiersBody(o));
    } else if (k === 'rule') {
      html += sec('desc', 'Rule', `<div class="grid3"><label>Name ${inp(o, 'name')}</label><label class="cb">Hidden ${inp(o, 'hidden', { type: 'bool' })}</label><label>Page ${inp(o, 'page', { opt: true })}</label></div>
        <label>Description ${inp(o, 'description', { type: 'text', rows: 8, cls: 'wide' })}</label>`);
      html += sec('modifiers', `Modifiers (${(o.modifiers || []).length})`, modifiersBody(o));
    } else if (k === 'infoGroup') {
      html += sec('basics', 'Basics', `<div class="grid3"><label>Name ${inp(o, 'name')}</label><label class="cb">Hidden ${inp(o, 'hidden', { type: 'bool' })}</label></div>`);
      html += sec('profiles', `Profiles (${(o.profiles || []).length})`, profilesBody(o, 'profiles'));
      html += sec('rules', `Rules (${(o.rules || []).length})`, rulesBody(o, 'rules'));
      html += sec('infolinks', `Linked rules & profiles (${(o.infoLinks || []).length})`, infoLinksBody(o));
      html += sec('modifiers', `Modifiers (${(o.modifiers || []).length})`, modifiersBody(o));
    } else if (k === 'category') {
      html += sec('basics', 'Basics', `<div class="grid3"><label>Name ${inp(o, 'name')}</label><label class="cb">Hidden ${inp(o, 'hidden', { type: 'bool' })}</label></div>`);
      html += sec('constraints', `Limits (${(o.constraints || []).length})`, constraintsBody(o));
      html += sec('modifiers', `Modifiers (${(o.modifiers || []).length})`, modifiersBody(o));
    } else {
      html += sec('basics', 'Basics', `<div class="grid3">${o.name !== undefined ? `<label>Name ${inp(o, 'name')}</label>` : ''}${o.hidden !== undefined ? `<label class="cb">Hidden ${inp(o, 'hidden', { type: 'bool' })}</label>` : ''}</div>
        <p class="muted small">Use the raw JSON editor below for other settings.</p>`);
    }
    if (o.id && !embedded) html += sec('usedby', `Used by (${(S.usedBy.get(o.id) || []).length})`, usedByBody(o));
    if (!embedded || k !== 'link') html += sec(embedded ? 'rawt' : 'raw', 'Advanced – raw JSON', rawBody(o));
    return html;
  }

  // costs
  function costsBody(o) {
    const pid = ptsId();
    const cts = costTypes();
    const rows = cts.filter(ct => S.showAllCosts || ct.id === pid || (o.costs || []).some(c => c.typeId === ct.id && Number(c.value) !== 0)).map(ct => {
      const c = (o.costs || []).find(c => c.typeId === ct.id);
      return `<label class="cost-row"><span>${esc(ct.name)}</span>${c ? inp(c, 'value', { type: 'num', cls: 'num' }) : `<input type="number" class="num" data-act-change="add-cost" data-ref="${ref(o)}" data-type-id="${esc(ct.id)}" data-name="${esc(ct.name)}" placeholder="–">`}</label>`;
    }).join('');
    const costMods = (o.modifiers || []).filter(m => costType(m.field));
    let quick = '';
    if (costMods.length) {
      quick = `<div class="quick"><div class="muted small">Points changes (e.g. bigger unit sizes):</div>${costMods.map(m => `<div class="quick-row">
        <span>${esc(modVerb(m, o))}</span> ${inp(m, 'value', { type: 'num', cls: 'num' })}
        ${(m.conditions || []).map(c => `<span class="muted">when ${esc(condText(c, true))}</span> ${inp(c, 'value', { type: 'num', cls: 'num' })}`).join(' ')}
        ${m.conditionGroups ? `<span class="muted small">(+ ${esc(groupsText(m.conditionGroups))})</span>` : ''}</div>`).join('')}</div>`;
    }
    return `<div class="costs">${rows}</div>${quick}
      <button class="linkbtn small" data-act="toggle-costs">${S.showAllCosts ? 'Show fewer cost types' : 'Show all cost types (Crusade, Detachment Points…)'}</button>
      ${costMods.length ? '' : `<button class="linkbtn small" data-act="add-pts-bracket" data-ref="${ref(o)}">＋ Add a points change for larger unit size</button>`}`;
  }

  // profiles
  function profilesBody(owner, key) {
    const arr = owner[key] || [];
    const types = new Map();
    S.files.forEach(f => (f.top.profileTypes || []).forEach(pt => types.set(pt.id, pt)));
    return `${arr.map((p, i) => profileCard(p, owner, key, i)).join('')}
      ${S.readOnly ? '' : `<div class="add-row"><select id="new-profile-type">${[...types.values()].map(pt => `<option value="${esc(pt.id)}">${esc(pt.name)}</option>`).join('')}</select>
      <button class="btn sm" data-act="add-profile" data-ref="${ref(owner)}" data-key="${key}">＋ Add profile</button></div>`}`;
  }
  function profileCard(p, owner, key, i) {
    const pt = profileType(p.typeId);
    const cols = pt ? pt.characteristicTypes : (p.characteristics || []).map(c => ({ id: c.typeId, name: c.name }));
    const long = cols.length <= 1 || (pt && /abilit/i.test(pt.name));
    const charIn = (col) => {
      const c = (p.characteristics || []).find(c => c.typeId === col.id);
      if (c) return long ? inp(c, '$text', { type: 'text', rows: 4, cls: 'wide' }) : inp(c, '$text', { cls: 'char' });
      return `<input class="${long ? 'wide' : 'char'}" data-act-change="add-char" data-ref="${ref(p)}" data-type-id="${esc(col.id)}" data-name="${esc(col.name)}">`;
    };
    return `<div class="pcard"><div class="pcard-head">${inp(p, 'name', { cls: 'pname' })}<span class="badge">${esc(p.typeName || (pt && pt.name) || '')}</span>
      <label class="cb small">hidden ${inp(p, 'hidden', { type: 'bool' })}</label>
      ${owner && !S.readOnly ? `<button class="icon" title="Move up" data-act="move" data-ref="${ref(owner)}" data-key="${key}" data-i="${i}" data-d="-1">↑</button>
      <button class="icon danger" title="Delete profile" data-act="del-item" data-ref="${ref(owner)}" data-key="${key}" data-i="${i}">✕</button>` : ''}</div>
      ${long ? cols.map(col => `<label class="small muted">${esc(col.name)}</label>${charIn(col)}`).join('')
      : `<div class="chars" style="grid-template-columns:repeat(${cols.length},minmax(0,1fr))">${cols.map(col => `<label><span>${esc(col.name)}</span>${charIn(col)}</label>`).join('')}</div>`}
      ${p.modifiers && p.modifiers.length ? `<div class="muted small">Has ${p.modifiers.length} modifier(s) – <a data-act="select" data-ref="${ref(p)}">open profile</a> to edit.</div>` : ''}</div>`;
  }

  // rules
  function rulesBody(owner, key) {
    const arr = owner[key] || [];
    return `${arr.map((r, i) => `<div class="pcard"><div class="pcard-head">${inp(r, 'name', { cls: 'pname' })}<label class="cb small">hidden ${inp(r, 'hidden', { type: 'bool' })}</label>
      ${S.readOnly ? '' : `<button class="icon danger" data-act="del-item" data-ref="${ref(owner)}" data-key="${key}" data-i="${i}">✕</button>`}</div>
      ${inp(r, 'description', { type: 'text', rows: 4, cls: 'wide' })}</div>`).join('')}
      ${S.readOnly ? '' : `<button class="btn sm" data-act="add-rule" data-ref="${ref(owner)}" data-key="${key}">＋ Add rule</button>`}`;
  }

  // info links
  function infoLinksBody(owner) {
    const arr = owner.infoLinks || [];
    return `<table class="etable"><tr><th>Type</th><th>Target</th><th>Hidden</th><th>Mods</th><th></th></tr>
      ${arr.map((l, i) => { const t = targetOf(l); return `<tr><td>${esc(l.type)}</td><td>${t ? `<a data-act="select" data-ref="${ref(t)}">${esc(t.name)}</a>` : `<span class="bad">missing</span>`}</td>
        <td>${inp(l, 'hidden', { type: 'bool' })}</td><td>${(l.modifiers || []).length ? `<a data-act="select" data-ref="${ref(l)}">${l.modifiers.length}</a>` : ''}</td>
        <td>${S.readOnly ? '' : `<button class="icon danger" data-act="del-item" data-ref="${ref(owner)}" data-key="infoLinks" data-i="${i}">✕</button>`}</td></tr>`; }).join('')}</table>
      ${S.readOnly ? '' : `<button class="btn sm" data-act="add-infolink" data-ref="${ref(owner)}">＋ Link a rule / profile…</button>`}`;
  }

  // categories
  function allCategories() {
    const m = new Map();
    S.files.forEach(f => (f.top.categoryEntries || []).forEach(c => { if (!m.has(c.id)) m.set(c.id, c); }));
    return [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
  function categoriesBody(owner) {
    const arr = owner.categoryLinks || [];
    return `<table class="etable"><tr><th>Category / keyword</th><th>Primary</th><th></th></tr>
      ${arr.map((c, i) => `<tr><td>${esc(idLabel(c.targetId))}</td><td><input type="radio" name="prim-${ref(owner)}" data-act="set-primary" data-ref="${ref(owner)}" data-i="${i}" ${c.primary ? 'checked' : ''}></td>
        <td>${S.readOnly ? '' : `<button class="icon danger" data-act="del-item" data-ref="${ref(owner)}" data-key="categoryLinks" data-i="${i}">✕</button>`}</td></tr>`).join('')}</table>
      ${S.readOnly ? '' : `<div class="add-row"><select data-act-change="add-cat" data-ref="${ref(owner)}"><option value="">＋ Add category / keyword…</option>${allCategories().map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div>`}`;
  }

  // constraints
  const SCOPES = ['parent', 'self', 'force', 'roster', 'root-entry', 'ancestor', 'unit', 'model', 'model-or-unit', 'upgrade', 'primary-catalogue'];
  const SCOPE_LABEL = { parent: 'per parent (this unit/model)', self: 'within itself', force: 'per army', roster: 'per roster', 'root-entry': 'in the whole unit', ancestor: 'in an ancestor', unit: 'in the unit', model: 'in the model', 'model-or-unit': 'in the model/unit', upgrade: 'in the upgrade' };
  function scopeOpts() { return SCOPES.map(s => [s, s]); }
  function fieldOptsCount() { return [['selections', 'selections (count)'], ['forces', 'forces'], ['associations', 'associations (attached)']].concat(costTypes().map(c => [c.id, c.name])); }
  function constraintsBody(owner) {
    const arr = owner.constraints || [];
    return `${arr.length ? `<table class="etable"><tr><th>Type</th><th>Value</th><th>Counting</th><th>Scope</th><th title="Include child selections">Incl. children</th><th>Child</th><th></th></tr>
      ${arr.map((c, i) => `<tr><td>${inp(c, 'type', { type: 'select', options: [['min', 'min'], ['max', 'max']] })}</td><td>${inp(c, 'value', { type: 'num', cls: 'num' })}</td>
        <td>${inp(c, 'field', { type: 'select', options: fieldOptsCount() })}</td><td>${inp(c, 'scope', { type: 'select', options: scopeOpts() })}</td>
        <td>${inp(c, 'includeChildSelections', { type: 'bool' })}</td><td>${c.childId ? esc(idLabel(c.childId)) : '<span class="muted">this</span>'}</td>
        <td>${S.readOnly ? '' : `<button class="icon danger" data-act="del-item" data-ref="${ref(owner)}" data-key="constraints" data-i="${i}">✕</button>`}</td></tr>
        <tr class="sub"><td colspan="7" class="muted small">${esc(constraintText(c))} · id ${esc(c.id)}</td></tr>`).join('')}</table>` : '<p class="muted small">No limits.</p>'}
      ${S.readOnly ? '' : `<button class="btn sm" data-act="add-constraint" data-ref="${ref(owner)}">＋ Add limit</button>`}`;
  }
  function constraintText(c) {
    const what = c.field === 'selections' || !c.field ? 'selections' : idLabel(c.field);
    return `${c.type === 'max' ? 'At most' : 'At least'} ${c.value} ${what} ${SCOPE_LABEL[c.scope] || ('in “' + idLabel(c.scope) + '”')}${c.childId ? ' of ' + idLabel(c.childId) : ''}`;
  }

  // modifiers
  const MOD_TYPES = ['set', 'increment', 'decrement', 'append', 'multiply', 'divide', 'add', 'remove', 'set-primary', 'unset-primary', 'replace', 'floor', 'ceil'];
  const COND_TYPES = ['atLeast', 'atMost', 'greaterThan', 'lessThan', 'equalTo', 'notEqualTo', 'instanceOf', 'notInstanceOf'];
  const SYM = { atLeast: '≥', atMost: '≤', greaterThan: '>', lessThan: '<', equalTo: '=', notEqualTo: '≠' };
  function ownConstraints(owner) {
    const out = (owner.constraints || []).slice();
    if (kindOf(owner) === 'link') { const t = targetOf(owner); if (t) out.push(...(t.constraints || [])); }
    return out;
  }
  function fieldLabel(field, owner) {
    if (['hidden', 'name', 'category', 'annotation', 'error', 'warning', 'info', 'page', 'description'].includes(field)) return field;
    const ct = costType(field); if (ct) return ct.name;
    const con = ownConstraints(owner).find(c => c.id === field);
    if (con) return 'limit (' + constraintText(con).toLowerCase() + ')';
    const pt = S.idMap.size && findCharType(field); if (pt) return pt;
    return idLabel(field);
  }
  function findCharType(id) {
    for (const f of S.files) for (const pt of (f.top.profileTypes || [])) for (const c of (pt.characteristicTypes || [])) if (c.id === id) return c.name;
    return null;
  }
  function fieldOptsMod(owner) {
    const base = [['hidden', 'hidden'], ['name', 'name'], ['category', 'category'], ['annotation', 'annotation'], ['error', 'error'], ['warning', 'warning']];
    const cts = costTypes().map(c => [c.id, 'cost: ' + c.name]);
    const cons = ownConstraints(owner).map(c => [c.id, 'limit: ' + constraintText(c)]);
    let chars = [];
    if (kindOf(owner) === 'profile') { const pt = profileType(owner.typeId); if (pt) chars = pt.characteristicTypes.map(c => [c.id, 'stat: ' + c.name]); }
    return base.concat(cts, cons, chars);
  }
  function modVerb(m, owner) {
    const fl = fieldLabel(m.field, owner);
    switch (m.type) {
      case 'set': return `Set ${fl} to`;
      case 'increment': return `Add to ${fl}:`;
      case 'decrement': return `Subtract from ${fl}:`;
      case 'append': return `Append to ${fl}:`;
      default: return `${m.type} ${fl}`;
    }
  }
  function condText(c, short) {
    const ch = idLabel(c.childId);
    const sc = SCOPE_LABEL[c.scope] ? c.scope : '“' + idLabel(c.scope) + '”';
    if (c.type === 'instanceOf' || c.type === 'notInstanceOf') return `${sc} ${c.type === 'instanceOf' ? 'is' : 'is not'} ${ch}`;
    if (c.type === 'before') return 'earlier in the list';
    const what = c.field === 'selections' ? 'number of ' + ch : c.field === 'forces' ? 'forces of ' + ch : (idLabel(c.field) + ' of ' + ch);
    return `${what} in ${sc} ${SYM[c.type] || c.type}${short ? '' : ' ' + c.value}`;
  }
  function groupsText(groups) {
    return (groups || []).map(g => {
      const parts = (g.conditions || []).map(c => condText(c)).concat((g.conditionGroups || []).length ? ['(' + groupsText(g.conditionGroups) + ')'] : []);
      if ((g.localConditionGroups || []).length) parts.push('(count-based rule)');
      return parts.join(g.type === 'or' ? ' OR ' : ' AND ');
    }).join(' AND ');
  }
  function modText(m, owner) {
    let v = m.value;
    if (m.field === 'category' || m.type === 'set-primary') v = idLabel(m.value);
    let s = `${modVerb(m, owner)} ${v === undefined ? '' : v}`;
    if (m.affects) s += ` [affects ${m.affects}]`;
    (m.repeats || []).forEach(r => { s += `, for every ${r.value} × ${idLabel(r.childId)} in ${SCOPE_LABEL[r.scope] ? r.scope : idLabel(r.scope)}`; });
    const conds = (m.conditions || []).map(c => condText(c));
    if (m.conditionGroups) conds.push(groupsText(m.conditionGroups));
    if (conds.length) s += ' — if ' + conds.join(' AND ');
    return s;
  }
  function modifiersBody(owner) {
    const arr = owner.modifiers || [];
    let html = arr.map((m, i) => {
      const valType = m.field === 'hidden' ? { type: 'selbool', options: [['true', 'true'], ['false', 'false']] } : (typeof m.value === 'number' ? { type: 'num', cls: 'num' } : { cls: 'mval' });
      return `<div class="mcard"><div class="msum">${esc(modText(m, owner))}</div>
        <div class="mrow">${inp(m, 'type', { type: 'select', options: MOD_TYPES.map(t => [t, t]) })}
          ${inp(m, 'field', { type: 'select', options: fieldOptsMod(owner), cls: 'mfield' })}
          ${inp(m, 'value', valType)}
          <span class="spacer"></span>
          ${S.readOnly ? '' : `<button class="btn sm" data-act="add-cond" data-ref="${ref(m)}">＋ condition</button>
          <button class="btn sm" data-act="edit-json" data-ref="${ref(m)}">JSON</button>
          <button class="icon danger" data-act="del-item" data-ref="${ref(owner)}" data-key="modifiers" data-i="${i}">✕</button>`}</div>
        ${(m.conditions || []).map((c, j) => condRow(m, c, j)).join('')}
        ${m.conditionGroups ? `<div class="muted small cg">Condition groups: ${esc(groupsText(m.conditionGroups))} <a data-act="edit-json" data-ref="${ref(m)}">edit JSON</a></div>` : ''}
        ${m.repeats ? `<div class="muted small cg">Repeats: ${m.repeats.map(r => esc(`every ${r.value} × ${idLabel(r.childId)}`)).join(', ')} <a data-act="edit-json" data-ref="${ref(m)}">edit JSON</a></div>` : ''}
      </div>`;
    }).join('');
    (owner.modifierGroups || []).forEach((g, i) => {
      html += `<div class="mcard group"><div class="msum">Modifier group${g.comment ? ' – ' + esc(g.comment) : ''} (${(g.modifiers || []).length} modifiers)${g.conditions || g.conditionGroups ? ' — if ' + esc([...(g.conditions || []).map(c => condText(c)), g.conditionGroups ? groupsText(g.conditionGroups) : ''].filter(Boolean).join(' AND ')) : ''}</div>
        <ul class="plain small">${(g.modifiers || []).map(m => `<li>${esc(modText(m, owner))}</li>`).join('')}</ul>
        ${S.readOnly ? '' : `<button class="btn sm" data-act="edit-json" data-ref="${ref(g)}">Edit group JSON</button>
        <button class="icon danger" data-act="del-item" data-ref="${ref(owner)}" data-key="modifierGroups" data-i="${i}">✕</button>`}</div>`;
    });
    if (!arr.length && !(owner.modifierGroups || []).length) html += '<p class="muted small">No modifiers.</p>';
    if (!S.readOnly) html += `<button class="btn sm" data-act="add-mod" data-ref="${ref(owner)}">＋ Add modifier</button>`;
    return html;
  }
  function condRow(m, c, j) {
    return `<div class="crow"><span class="muted small">if</span>
      <span class="cchild" title="${esc(c.childId)}">${esc(idLabel(c.childId))}</span>
      <button class="icon" title="Choose what to count / check" data-act="pick-child" data-ref="${ref(c)}">✎</button>
      ${inp(c, 'field', { type: 'select', options: fieldOptsCount() })}
      <span class="muted small">in</span>${inp(c, 'scope', { type: 'select', options: scopeOpts() })}
      ${inp(c, 'type', { type: 'select', options: COND_TYPES.map(t => [t, SYM[t] ? SYM[t] + ' ' + t : t]) })}
      ${inp(c, 'value', { type: 'num', cls: 'num' })}
      <label class="cb small" title="Include child selections">incl. children ${inp(c, 'includeChildSelections', { type: 'bool' })}</label>
      ${S.readOnly ? '' : `<button class="icon danger" data-act="del-item" data-ref="${ref(m)}" data-key="conditions" data-i="${j}">✕</button>`}</div>`;
  }

  // children
  function childrenBody(o) {
    const rows = [];
    STRUCT_KEYS.forEach(k => (o[k] || []).forEach((c, i) => rows.push({ c, k, i })));
    return `${rows.length ? `<table class="etable children"><tr><th></th><th>Name</th><th>Kind</th><th>pts</th><th>Limits</th><th></th></tr>
      ${rows.map(({ c, k, i }) => { const t = kindOf(c) === 'link' ? targetOf(c) : c; return `<tr class="${c.hidden ? 'hid' : ''}"><td>${nodeIcon(c)}</td>
        <td><a data-act="select" data-ref="${ref(c)}">${esc(c.name)}</a></td><td class="muted small">${esc(kindLabel(c))}</td><td>${ptsOf(c) ?? ''}</td>
        <td class="muted small">${esc(((c.constraints || []).concat(t && t !== c ? t.constraints || [] : [])).filter(x => x.scope === 'parent' && (x.field === 'selections' || !x.field)).map(x => x.type + ' ' + x.value).join(', '))}</td>
        <td class="nowrap">${S.readOnly ? '' : `<button class="icon" title="Move up" data-act="move" data-ref="${ref(o)}" data-key="${k}" data-i="${i}" data-d="-1">↑</button><button class="icon" title="Move down" data-act="move" data-ref="${ref(o)}" data-key="${k}" data-i="${i}" data-d="1">↓</button>
        <button class="icon danger" title="Delete" data-act="del-item" data-ref="${ref(o)}" data-key="${k}" data-i="${i}">✕</button>`}</td></tr>`; }).join('')}</table>` : '<p class="muted small">No options.</p>'}
      ${S.readOnly ? '' : `<div class="add-row"><button class="btn sm" data-act="add-child" data-ref="${ref(o)}" data-kind="entry">＋ New option / model</button>
        <button class="btn sm" data-act="add-child" data-ref="${ref(o)}" data-kind="group">＋ New group</button>
        <button class="btn sm" data-act="add-child" data-ref="${ref(o)}" data-kind="link">＋ Link existing entry…</button></div>`}`;
  }

  function usedByBody(o) {
    const list = S.usedBy.get(o.id) || [];
    if (!list.length) return '<p class="muted small">Not linked from anywhere.</p>';
    return `<ul class="plain">${list.slice(0, 200).map(l => { const p = info(l).parent; return `<li><a data-act="select" data-ref="${ref(l)}">${esc((p && p.name) || fileOf(l).top.name)}</a> <span class="muted small">(${esc(fileOf(l).top.name)})</span></li>`; }).join('')}</ul>`;
  }

  function rawBody(o) {
    const txt = JSON.stringify(o, null, 2);
    if (txt.length > 300000) return '<p class="muted small">Too large to edit as raw JSON here – edit its parts instead.</p>';
    return `<textarea class="raw" id="raw-${ref(o)}" rows="14">${esc(txt)}</textarea>
      ${S.readOnly ? '' : `<button class="btn sm" data-act="apply-raw" data-ref="${ref(o)}">Apply JSON</button>`}`;
  }

  // ------------------------------------------------------------------ points table
  function libraryFilesFor(fac) {
    const out = [fac];
    const seen = new Set([fac.top.id]);
    const visit = (f) => (f.top.catalogueLinks || []).forEach(l => {
      if (seen.has(l.targetId)) return; seen.add(l.targetId);
      const lf = S.files.find(x => x.top.id === l.targetId);
      if (lf && lf.top.library) { out.push(lf); visit(lf); }
    });
    visit(fac);
    return out;
  }
  function pointsRows(fac) {
    const pid = ptsId();
    const rows = [], seen = new Set();
    const items = (fac.top.entryLinks || []).concat(fac.top.selectionEntries || []);
    for (const it of items) {
      const isLink = kindOf(it) === 'link';
      const t = isLink ? targetOf(it) : it;
      if (!t || kindOf(t) !== 'entry' || seen.has(t)) continue;
      const hasPts = (t.costs || []).some(c => c.typeId === pid && Number(c.value) !== 0);
      if (!(t.type === 'unit' || t.type === 'model' || hasPts)) continue;
      seen.add(t);
      rows.push({ link: isLink ? it : null, t });
    }
    rows.sort((a, b) => a.t.name.localeCompare(b.t.name));
    return rows;
  }
  function ptsInput(o) {
    const pid = ptsId();
    const c = (o.costs || []).find(c => c.typeId === pid);
    return c ? inp(c, 'value', { type: 'num', cls: 'num' }) : `<input type="number" class="num" data-act-change="add-cost" data-ref="${ref(o)}" data-type-id="${esc(pid)}" data-name="pts" placeholder="–">`;
  }
  function bracketsHtml(owner) {
    const pid = ptsId();
    const mods = (owner.modifiers || []).filter(m => m.field === pid);
    return mods.map(m => `<div class="br"><span class="muted small">${esc(m.type === 'set' ? 'set to' : m.type)}</span> ${inp(m, 'value', { type: 'num', cls: 'num' })}
      ${(m.conditions || []).map(c => `<span class="muted small">${esc(condShort(c))}</span> ${inp(c, 'value', { type: 'num', cls: 'num sm' })}`).join(' ')}
      ${m.conditionGroups || m.repeats ? `<span class="muted small" title="${esc(modText(m, owner))}">(+ more conditions)</span>` : ''}</div>`).join('');
  }
  function condShort(c) {
    if (c.childId === 'model' && c.field === 'selections') return 'if models ' + (SYM[c.type] || c.type);
    return 'if ' + condText(c, true);
  }
  function renderPoints() {
    const fac = S.file;
    const flt = S.ptsFilter.toLowerCase();
    let rows = pointsRows(fac);
    if (S.ptsHideLegends) rows = rows.filter(r => !/\[Legends\]/i.test(r.t.name));
    if (S.ptsHideCrucible) rows = rows.filter(r => !/\[Crucible\]/i.test(r.t.name));
    if (flt) rows = rows.filter(r => r.t.name.toLowerCase().includes(flt));
    // other entries with points (enhancements, paid wargear)
    const pid = ptsId();
    const others = [];
    const unitSet = new Set(pointsRows(fac).map(r => r.t));
    for (const f of libraryFilesFor(fac)) {
      const walk = (obj, groupName) => {
        for (const k in obj) {
          const v = obj[k]; if (!Array.isArray(v)) continue;
          for (const x of v) {
            if (!x || typeof x !== 'object') continue;
            const kk = ENTRY_KEYS[k];
            if (kk === 'entry' && !unitSet.has(x) && x.type === 'upgrade' && (x.costs || []).some(c => c.typeId === pid && Number(c.value) !== 0)) others.push({ x, g: groupName || '' });
            if (kk === 'entry' && (x.type === 'unit' || x.type === 'model') && !unitSet.has(x)) continue; // other units' insides
            walk(x, kk === 'group' ? x.name : groupName);
          }
        }
      };
      walk(f.top, '');
    }
    const otherF = others.filter(o => !(S.ptsHideLegends && /\[Legends\]/i.test(o.x.name)) && !(S.ptsHideCrucible && /\[Crucible\]/i.test(o.x.name))).filter(o => !flt || o.x.name.toLowerCase().includes(flt) || o.g.toLowerCase().includes(flt));
    const libTag = (o) => fileOf(o) !== fac ? `<span class="badge lib" title="Stored in ${esc(fileOf(o).top.name)}">${esc(shortFile(fileOf(o)))}</span>` : '';
    return `<div class="form-head"><div><h2>💲 Points – ${esc(fac.top.name)}</h2>
        <div class="muted small">Edit points straight in the table. Changed values are highlighted; hover to see the old value. Save with Ctrl+S.</div></div>
        <div class="head-actions">${S.readOnly ? '' : '<button class="btn sm" data-act="new-unit">＋ New unit</button>'}</div></div>
      <div class="pts-tools"><input id="pts-filter" class="search sm" placeholder="Filter units…" value="${esc(S.ptsFilter)}">
        <label class="cb small"><input type="checkbox" id="pts-legends" ${S.ptsHideLegends ? 'checked' : ''}> Hide Legends</label>
        <label class="cb small"><input type="checkbox" id="pts-crucible" ${S.ptsHideCrucible ? 'checked' : ''}> Hide Crucible</label></div>
      <table class="etable pts-table"><tr><th>Unit</th><th>pts</th><th>Changes by unit size / conditions</th><th></th></tr>
      ${rows.map(r => `<tr><td><a data-act="select" data-ref="${ref(r.link || r.t)}">${esc(r.t.name)}</a> ${libTag(r.t)}</td>
        <td>${r.link && (r.link.costs || []).some(c => c.typeId === pid) ? ptsInput(r.link) + '<div class="muted small">link override</div>' : ptsInput(r.t)}</td>
        <td>${bracketsHtml(r.t)}${r.link ? bracketsHtml(r.link) : ''}</td>
        <td>${S.readOnly ? '' : `<button class="icon" title="Add a points change for a bigger unit size" data-act="add-pts-bracket" data-ref="${ref(r.t)}">＋</button>`}</td></tr>`).join('')}
      </table>
      ${!rows.length ? '<p class="muted">No units match.</p>' : ''}
      ${otherF.length ? `<h3 class="pts-h3">Enhancements & other upgrades with points</h3>
      <table class="etable pts-table"><tr><th>Name</th><th>Group</th><th>pts</th><th>Changes</th></tr>
      ${otherF.sort((a, b) => a.g.localeCompare(b.g) || a.x.name.localeCompare(b.x.name)).map(o => `<tr><td><a data-act="select" data-ref="${ref(o.x)}">${esc(o.x.name)}</a> ${libTag(o.x)}</td>
        <td class="muted small">${esc(o.g)}</td><td>${ptsInput(o.x)}</td><td>${bracketsHtml(o.x)}</td></tr>`).join('')}</table>` : ''}`;
  }
  function shortFile(f) { const p = f.top.name.split(' - '); return p[p.length - 1]; }

  // ------------------------------------------------------------------ data check
  function baselineKey() { return 'baseline:' + S.folderName + ':' + S.files.length; }
  async function loadBaseline() {
    let keys = null;
    try { keys = await KV.get(baselineKey()); } catch (e) { /* ignore */ }
    if (!keys) {
      // first time this folder is opened: whatever is wrong now is "already in the files"
      keys = DataCheck.run(S.files).map(i => i.key);
      try { await KV.set(baselineKey(), keys); } catch (e) { /* ignore */ }
    }
    S.baseline = new Set(keys);
    S.check = null;
  }
  const isKnown = (i) => S.baseline && S.baseline.has(i.key);
  function runCheck() {
    const t = Date.now();
    S.check = { issues: DataCheck.run(S.files), at: new Date(), ms: Date.now() - t };
    return S.check;
  }
  function scopeFiles() {
    if (S.checkScope === 'all' || S.file.kind !== 'catalogue') return null;
    const set = new Set(libraryFilesFor(S.file));
    S.files.filter(f => f.kind === 'gameSystem').forEach(f => set.add(f));
    return set;
  }
  function issueRow(i) {
    const f = i.file;
    const anc = i.obj ? ancestors(i.obj).filter(x => x.name && (!f || x !== f.top)).map(x => x.name).slice(-2).join(' › ') : '';
    return `<div class="issue ${i.sev}"><span class="ico">${i.sev === 'error' ? '⛔' : '⚠'}</span>
      <div class="imsg">${esc(i.msg)}<div class="muted small">${esc(f ? f.top.name : '')}${anc ? ' › ' + esc(anc) : ''}</div></div>
      ${i.obj && S.parent.has(i.obj) ? `<button class="btn sm" data-act="select" data-ref="${ref(i.obj)}">Open</button>` : ''}</div>`;
  }
  function renderCheck() {
    if (!S.check) runCheck();
    const fs = scopeFiles();
    const inScope = S.check.issues.filter(i => !fs || (i.file && fs.has(i.file)));
    const fresh = inScope.filter(i => !isKnown(i)).sort((a, b) => (a.sev === b.sev ? 0 : a.sev === 'error' ? -1 : 1));
    const known = inScope.filter(isKnown);
    const errs = fresh.filter(i => i.sev === 'error').length;
    return `<div class="form-head"><div><h2>✔ Data check</h2>
        <div class="muted small">Checked ${S.files.length} files in ${S.check.ms} ms at ${esc(S.check.at.toLocaleTimeString())} (includes unsaved changes).</div></div>
        <div class="head-actions"><button class="btn sm primary" data-act="recheck">↻ Re-check</button></div></div>
      <div class="pts-tools"><label>Show problems in
        <select id="check-scope"><option value="faction" ${S.checkScope === 'faction' ? 'selected' : ''}>${esc(S.file.kind === 'catalogue' ? S.file.top.name + ' (+ its libraries)' : 'current faction')}</option><option value="all" ${S.checkScope === 'all' ? 'selected' : ''}>all files</option></select></label></div>
      <div class="check-summary ${fresh.length ? (errs ? 'bad' : 'warn') : 'good'}">${fresh.length ? `${errs ? errs + ' error(s)' : ''}${errs && fresh.length - errs ? ' and ' : ''}${fresh.length - errs ? (fresh.length - errs) + ' warning(s)' : ''} to look at.` : '✓ No new problems found.'}</div>
      ${fresh.length ? `<div class="issues">${fresh.map(issueRow).join('')}</div>` : ''}
      <details class="sec" ${S.showKnown ? 'open' : ''} data-sec="known"><summary>Already in the original files (${known.length}) – usually safe to ignore</summary><div class="sec-body">
        <p class="muted small">These were present when you first opened this folder in the editor (they come from BSData itself). They're listed so you can fix them if you like.</p>
        ${known.length ? `<div class="issues">${known.slice(0, 400).map(issueRow).join('')}</div>${known.length > 400 ? '<p class="muted small">…and more.</p>' : ''}` : '<p class="muted small">None.</p>'}
      </div></details>
      <p class="muted small">After downloading a new BSData version you can <a data-act="mark-known">mark everything currently listed as “already in the files”</a>.</p>
      <h3 class="pts-h3">What is checked</h3>
      <ul class="plain small muted check-list">
        <li>Links, keywords and rules that point to something deleted or missing; duplicate ids</li>
        <li>Limits, modifiers and conditions that refer to things that don't exist or use non-numbers; minimum bigger than maximum</li>
        <li>Units: points value, army-list section (primary category), Faction keyword, Unit stat profile, models inside the unit, empty profiles, unnamed entries</li>
        <li>Units not added to any faction's unit list, two units with the same name in a faction, units sharing another unit's keyword</li>
        <li>Leaders without a “Can lead” list, or with an empty one; group default choices that aren't options</li>
      </ul>`;
  }

  // ------------------------------------------------------------------ "can lead" associations
  const instSelf = (c) => c.type === 'instanceOf' && c.scope === 'self';
  function assocList(a) {
    // returns {editable: group|null, direct: [conds], nested: string}
    const g = a.conditionGroups || [], c = a.conditions || [];
    if (!g.length && c.length <= 1 && c.every(instSelf)) return { mode: 'plain', direct: c, nested: '' };
    if (g.length === 1 && g[0].type === 'or' && !c.length) {
      const top = g[0];
      const direct = (top.conditions || []).filter(instSelf);
      const otherConds = (top.conditions || []).filter(x => !instSelf(x));
      const nestedParts = (top.conditionGroups || []).map(x => '(' + groupsText([x]) + ')').concat(otherConds.map(x => condText(x)));
      return { mode: 'or', group: top, direct, nested: nestedParts.join(' OR ') };
    }
    return { mode: 'complex', direct: [], nested: groupsText(g) + (c.length ? ' AND ' + c.map(x => condText(x)).join(' AND ') : '') };
  }
  function assocBody(o) {
    const list = o.associations || [];
    let html = '';
    list.forEach((a, i) => {
      if (a.action !== 'group') { html += `<div class="acard"><b>${esc(a.name)}</b> <span class="muted small">(special association – edit via JSON)</span> <button class="btn sm" data-act="edit-json" data-ref="${ref(a)}">JSON</button></div>`; return; }
      const L = assocList(a);
      html += `<div class="acard"><div class="acard-head"><label>Label ${inp(a, 'label', { ph: 'Leader' })}</label><label>Name ${inp(a, 'name')}</label>
        <label>Must attach? ${inp(a, 'min', { type: 'selnum', options: [[0, 'optional'], [1, 'required']] })}</label>
        <span class="spacer"></span>${S.readOnly ? '' : `<button class="btn sm" data-act="edit-json" data-ref="${ref(a)}">JSON</button><button class="icon danger" title="Remove" data-act="del-item" data-ref="${ref(o)}" data-key="associations" data-i="${i}">✕</button>`}</div>
        <div class="muted small">Can attach to:</div>
        <div class="chips-ed">${L.direct.map(c => `<span class="chip-ed">${esc(idLabel(c.childId))}${S.readOnly || L.mode === 'complex' ? '' : `<button class="icon" data-act="assoc-rm" data-ref="${ref(a)}" data-id="${esc(c.childId)}">✕</button>`}</span>`).join('') || (L.mode !== 'complex' ? '<span class="muted small">nothing yet</span>' : '')}
        ${!S.readOnly && L.mode !== 'complex' ? `<button class="btn sm" data-act="assoc-add" data-ref="${ref(a)}">＋ Add unit…</button>` : ''}</div>
        ${L.nested ? `<div class="muted small cg">${L.mode === 'complex' ? 'Complex rule' : 'Also'}: ${esc(L.nested)}${L.mode === 'complex' ? ' – use JSON to edit.' : ''}</div>` : ''}</div>`;
    });
    (o.associationLinks || []).forEach(l => { const t = byId(l.targetId, ['association']); html += `<div class="acard muted small">Uses shared rule “${esc(l.name)}”${t ? ` – <a data-act="edit-json" data-ref="${ref(t)}">edit it (JSON)</a>` : ''}</div>`; });
    if (!list.length && !(o.associationLinks || []).length) html += '<p class="muted small">This unit can\'t attach to other units.</p>';
    if (!S.readOnly) html += `<div class="add-row"><button class="btn sm" data-act="assoc-new" data-ref="${ref(o)}" data-kind="leader">＋ Make it a Leader</button>
      <button class="btn sm" data-act="assoc-new" data-ref="${ref(o)}" data-kind="support">＋ Make it a Support character</button></div>
      <p class="muted small">Pick the unit's own keyword (marked <span class="ic c">#</span>) – that's how BSData identifies which units can be led. Remember the character also needs the <b>Leader</b> keyword (Categories section).</p>`;
    return html;
  }

  // ------------------------------------------------------------------ new unit wizard
  function openWizard(w) {
    S.wiz = w || S.wiz || { name: '', source: null, fac: S.files.indexOf(S.file), ownKw: true };
    const wz = S.wiz;
    const facs = S.files.map((f, i) => [f, i]).filter(([f]) => f.kind === 'catalogue' && !f.top.library);
    if (!facs.some(([, i]) => i === wz.fac)) wz.fac = facs.length ? facs[0][1] : -1;
    REG = new Map(); REGN = 0;
    modal(`<h3>＋ New unit</h3>
      <p class="muted small">The new unit starts as a copy of an existing one (models, wargear, limits, points, abilities), so pick the closest match, then edit what differs.</p>
      <div class="wiz">
        <label>New unit name<input id="wiz-name" value="${esc(wz.name)}" placeholder="e.g. Canoptek Harvesters"></label>
        <label>Copy from<div class="row"><span class="cchild wide">${wz.source ? esc(wz.source.name) + ' <span class="muted small">(' + esc(fileOf(wz.source).top.name) + ')</span>' : '<span class="muted">nothing chosen</span>'}</span>
          <button class="btn sm" data-act="wiz-pick">Choose…</button></div></label>
        <label>Add to faction<select id="wiz-fac">${facs.map(([f, i]) => `<option value="${i}" ${i === wz.fac ? 'selected' : ''}>${esc(f.top.name)}</option>`).join('')}</select></label>
        <label class="cb"><input type="checkbox" id="wiz-kw" ${wz.ownKw ? 'checked' : ''}> Give it its own unit keyword (recommended – needed so Leaders can be set to attach to it)</label>
      </div>
      <div class="row-end"><button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-act="wiz-create">Create unit</button></div>`);
    setTimeout(() => { const n = $('#wiz-name'); if (n) n.focus(); }, 30);
  }
  function wizRead() { const w = S.wiz; const n = $('#wiz-name'); if (n) w.name = n.value.trim(); const f = $('#wiz-fac'); if (f) w.fac = Number(f.value); const k = $('#wiz-kw'); if (k) w.ownKw = k.checked; }
  function createUnit(w) {
    const fac = S.files[w.fac], src = w.source;
    const si = info(src);
    const shared = si.key === 'sharedSelectionEntries';
    const container = shared ? si.parent : fac.top;
    const cFile = shared ? si.file : fac;
    const srcLink = (fac.top.entryLinks || []).find(l => l.targetId === src.id);
    checkpointMany([container, fac.top, cFile.top]);
    const clone = regenIds(JSON.parse(JSON.stringify(src)));
    const old = src.name;
    clone.name = w.name;
    (clone.profiles || []).forEach(p => { if (p.name === old) p.name = w.name; });
    if (w.ownKw) {
      const cl = (clone.categoryLinks || []).find(c => idLabel(c.targetId) === old);
      const cat = { name: w.name, id: newId(), hidden: false };
      arrPush(cFile.top, 'categoryEntries', cat);
      if (cl) { cl.targetId = cat.id; cl.name = w.name; }
      else arrPush(clone, 'categoryLinks', { name: w.name, id: newId(), hidden: false, primary: false, targetId: cat.id });
    }
    const arr = container.sharedSelectionEntries || (container.sharedSelectionEntries = []);
    const at = shared ? arr.indexOf(src) + 1 : arr.length;
    arr.splice(at, 0, clone);
    const link = srcLink ? regenIds(JSON.parse(JSON.stringify(srcLink))) : linkTo(clone);
    link.targetId = clone.id; link.name = w.name;
    arrPush(fac.top, 'entryLinks', link);
    [container, fac.top, cFile.top].forEach(markDirty);
    reindex();
    S.file = fac;
    select(link);
    toast(`Created “${w.name}” and added it to ${fac.top.name}. Edit its points, stats and options, then save.`, 6000);
  }

  // ------------------------------------------------------------------ detachments
  // A detachment is an upgrade entry that costs Detachment Points. Its rules are either written on it or linked
  // (infoLinks to shared rules), and its enhancements are entries/groups that are hidden unless it is selected
  // (their modifiers mention the detachment's id).
  const FD_NAMES = ['Disruption', 'Priority Assets', 'Purge the Foe', 'Reconnaissance', 'Take and Hold'];
  function dpId() { const c = costTypes().find(c => c.name === 'Detachment Points'); return c ? c.id : null; }
  function dpOf(o) { const id = dpId(); const c = (o.costs || []).find(c => c.typeId === id); return c ? Number(c.value) || 0 : 0; }
  function isDetachment(o) { return kindOf(o) === 'entry' && o.type === 'upgrade' && dpOf(o) > 0; }
  function fdCategories() {
    const out = new Map();
    for (const f of S.files) (f.top.categoryEntries || []).forEach(c => { if (FD_NAMES.includes(c.name) && !out.has(c.name)) out.set(c.name, c); });
    return out;
  }
  function detachmentsIn(files) {
    const out = [];
    const walk = (x) => { if (Array.isArray(x)) x.forEach(walk); else if (x && typeof x === 'object') { if (x.type === 'upgrade' && x.id && dpOf(x) > 0 && S.parent.has(x)) out.push(x); Object.values(x).forEach(walk); } };
    files.forEach(f => walk(f.top));
    return out;
  }
  // everything that is only shown when this detachment is chosen (enhancements, enhancement groups, rule links)
  function detContent(det) {
    const out = [];
    const mentions = (x) => JSON.stringify([x.modifiers || [], x.modifierGroups || []]).includes(det.id);
    const walk = (x, inEnh) => {
      if (Array.isArray(x)) { x.forEach(y => walk(y, inEnh)); return; }
      if (!x || typeof x !== 'object') return;
      if (x !== det && x.id && S.parent.has(x) && mentions(x)) {
        const k = kindOf(x);
        if ((k === 'entry' || k === 'group') && (inEnh || /enhancement/i.test(x.name || ''))) { out.push({ kind: 'enh', obj: x }); return; }
        if (k === 'infoLink' && x.type === 'rule') { out.push({ kind: 'rulelink', obj: x }); return; }
        out.push({ kind: 'other', obj: x });
      }
      const enh = inEnh || /enhancement/i.test(x.name || '');
      for (const v of Object.values(x)) if (v && typeof v === 'object') walk(v, enh);
    };
    S.files.forEach(f => walk(f.top, false));
    return out;
  }
  // the enhancement entries themselves (a group like "Gladius Task Force Enhancements" holds them)
  function enhEntries(content) {
    const out = [];
    content.filter(c => c.kind === 'enh').forEach(c => { if (kindOf(c.obj) === 'entry') out.push(c.obj); else structChildren(c.obj).forEach(x => out.push(x)); });
    return out;
  }
  function detBody(det) {
    const fds = fdCategories();
    const mine = new Set((det.categoryLinks || []).map(l => l.targetId));
    const content = detContent(det);
    const rules = [...(det.rules || []), ...(det.infoLinks || []).filter(l => l.type === 'rule').map(targetOf).filter(Boolean)];
    const enh = enhEntries(content);
    const pid = ptsId();
    return `<div class="det-box">
      <div class="grid3"><label>Detachment Points <input type="number" min="0" value="${dpOf(det)}" data-act-input="det-dp" data-ref="${ref(det)}" ${S.readOnly ? 'disabled' : ''}></label></div>
      <div class="det-fd"><b>Force dispositions:</b> ${[...fds.values()].map(c => `<label class="cb"><input type="checkbox" data-act-input="det-fd" data-ref="${ref(det)}" data-cat="${esc(c.id)}" ${mine.has(c.id) ? 'checked' : ''} ${S.readOnly ? 'disabled' : ''}> ${esc(c.name)}</label>`).join(' ')}</div>
      <h4>Rules (${rules.length})</h4>
      ${rules.length ? `<ul class="plain">${rules.map(r => `<li><a data-act="select" data-ref="${ref(r)}">${esc(r.name)}</a> <span class="muted small">${esc(String(r.description || '').slice(0, 90))}${String(r.description || '').length > 90 ? '…' : ''}</span></li>`).join('')}</ul>` : '<p class="muted small">No rules yet.</p>'}
      <p class="muted small">Add more rules (or stratagems) with <b>＋ Add rule</b> in the Rules section below.</p>
      <h4>Enhancements (${enh.length})</h4>
      ${enh.length ? `<ul class="plain">${enh.map(x => { const c = (x.costs || []).find(c => c.typeId === pid); return `<li><a data-act="select" data-ref="${ref(x)}">${esc(x.name)}</a> <span class="muted small">${c ? c.value + ' pts' : ''}</span></li>`; }).join('')}</ul>` : '<p class="muted small">No enhancements found for this detachment.</p>'}
      ${S.readOnly ? '' : `<button class="btn sm" data-act="det-add-enh" data-ref="${ref(det)}">＋ Add enhancement</button>`}
      <p class="muted small">Enhancements are only shown in the list builder when this detachment is chosen.</p>
    </div>`;
  }
  // a new enhancement for a detachment: a copy of one of its enhancements (or any enhancement in the faction), renamed
  function addEnhancement(det) {
    let content = detContent(det);
    let tmpl = enhEntries(content)[0];
    let otherDet = null;
    if (!tmpl) {
      // borrow one from another detachment in the same file and point it at this one
      for (const d of detachmentsIn([fileOf(det)])) { if (d === det) continue; const e = enhEntries(detContent(d))[0]; if (e && kindOf(e) === 'entry') { tmpl = e; otherDet = d; break; } }
    }
    if (!tmpl) { toast('No enhancement to copy in this faction – add one with Duplicate from another faction, or in the raw JSON.', 7000); return; }
    const ti = info(tmpl);
    checkpoint(ti.parent);
    let json = JSON.stringify(tmpl);
    if (otherDet) json = json.split(otherDet.id).join(det.id);
    const clone = regenIds(JSON.parse(json));
    clone.name = 'New enhancement';
    (clone.profiles || []).forEach(p => { p.name = 'New enhancement'; });
    if (clone.comment !== undefined) clone.comment = det.name;
    const arr = ti.parent[ti.key]; arr.splice(arr.indexOf(tmpl) + 1, 0, clone);
    markDirty(ti.parent); reindex(); select(clone);
    toast('Added “New enhancement” – rename it, set its points and write its rules text.', 6000);
  }

  // the files a faction uses (its own file plus every catalogue it links to, libraries or not)
  function linkedFiles(fac) {
    const out = [fac], seen = new Set([fac.top.id]);
    const visit = (f) => (f.top.catalogueLinks || []).forEach(l => {
      if (seen.has(l.targetId)) return; seen.add(l.targetId);
      const lf = S.files.find(x => x.top.id === l.targetId);
      if (lf) { out.push(lf); visit(lf); }
    });
    visit(fac);
    return out;
  }
  // where a new detachment can go for this faction: the lists that already hold its detachments
  function detTargets(fac) {
    const out = [];
    for (const f of linkedFiles(fac)) {
      for (const d of detachmentsIn([f])) {
        const i = info(d);
        let t = out.find(x => x.parent === i.parent && x.key === i.key);
        if (!t) { t = { parent: i.parent, key: i.key, file: f, count: 0 }; out.push(t); }
        t.count++;
      }
    }
    // the faction's own file first, then the biggest list (e.g. Space Marine detachments before allied Knights)
    return out.sort((x, y) => (y.file === fac) - (x.file === fac) || y.count - x.count);
  }
  function openDetWizard() {
    const w = S.dwiz;
    const fac = S.file;
    if (fac.kind !== 'catalogue') { toast('Pick a faction in the file list first.', 5000); S.dwiz = null; return; }
    const targets = detTargets(fac);
    if (!targets.length) { toast('Couldn\'t find where this faction keeps its detachments.', 6000); S.dwiz = null; return; }
    if (w.target === undefined || !targets.includes(w.target)) w.target = targets[0];
    const all = S.allDets || (S.allDets = detachmentsIn(S.files.filter(f => f.kind === 'catalogue')).map(d => ({ d, fac: fileOf(d).top.name.replace(/^(Imperium|Chaos|Xenos|Library|Aeldari) - /, '') })).sort((x, y) => x.d.name.localeCompare(y.d.name)));
    if (!w.src) { const own = all.find(x => x.d && info(x.d).parent === w.target.parent); if (own) { w.src = own.d; w.dp = dpOf(own.d); w.fds = null; } }
    const fds = fdCategories();
    if (!w.fds && w.src) { const srcFd = new Set((w.src.categoryLinks || []).map(l => l.targetId)); w.fds = [...fds.values()].filter(c => srcFd.has(c.id)).map(c => c.id); }
    if (!w.fds) w.fds = [];
    const q = (w.q || '').toLowerCase();
    const list = all.filter(x => !q || x.d.name.toLowerCase().includes(q) || x.fac.toLowerCase().includes(q));
    REG = new Map(); REGN = 0;
    S.dwList = list;
    modal(`<h3>＋ New detachment</h3>
      <p class="muted small">The new detachment starts as a copy of an existing one from <b>any</b> faction – its rules (and, if you like, its enhancements) are copied too, so you only change what differs. The originals aren't touched.</p>
      <div class="wiz">
        <label>New detachment name<input id="dw-name" value="${esc(w.name || '')}" placeholder="e.g. Tomb World Guard"></label>
        <div><b>Copy from</b> <span class="muted small">– chosen: ${w.src ? `<b>${esc(w.src.name)}</b> (${esc(fileOf(w.src).top.name)}, ${dpOf(w.src)} DP)` : 'nothing yet'}</span>
          <input id="dw-q" class="search sm" placeholder="Search all detachments by name or faction…" value="${esc(w.q || '')}">
          <div class="dw-list">${list.length ? list.slice(0, 300).map((x, i) => `<div class="dw-item ${x.d === w.src ? 'on' : ''}" data-act="dw-pick" data-i="${i}"><span>${esc(x.d.name)}</span><span class="muted small">${esc(x.fac)} · ${dpOf(x.d)} DP</span></div>`).join('') : '<div class="muted small" style="padding:6px">No detachments match.</div>'}</div></div>
        <label>Add to<select id="dw-target">${targets.map((t, i) => `<option value="${i}" ${t === w.target ? 'selected' : ''}>${esc(t.file.top.name)} detachments (${t.count})${t.file !== fac ? ' – shared/allied list' : ''}</option>`).join('')}</select></label>
        <label>Detachment Points<input id="dw-dp" type="number" min="0" value="${w.dp}"></label>
        <div><b>Force dispositions</b><div class="det-fd">${[...fds.values()].map(c => `<label class="cb"><input type="checkbox" class="dw-fd" value="${esc(c.id)}" ${w.fds.includes(c.id) ? 'checked' : ''}> ${esc(c.name)}</label>`).join(' ')}</div></div>
        <label class="cb"><input type="checkbox" id="dw-enh" ${w.enh !== false ? 'checked' : ''}> Copy its enhancements too (you can rename and change them afterwards)</label>
        ${w.src && fileOf(w.src) !== w.target.file && !linkedFiles(fac).includes(fileOf(w.src)) ? '<p class="muted small">Copying from another faction: rules text and enhancements are copied across. Afterwards, run <b>✔ Check data</b> – any keyword the copied text or enhancements refer to that this faction doesn\'t have (e.g. NECRONS) will be listed so you can change it.</p>' : ''}
      </div>
      <div class="row-end"><button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-act="det-create">Create detachment</button></div>`);
    S.dwTargets = targets;
    setTimeout(() => { const el = w._focus === 'q' ? $('#dw-q') : $('#dw-name'); if (el) { el.focus(); if (w._focus === 'q') el.setSelectionRange(el.value.length, el.value.length); } }, 20);
  }
  function detWizRead() {
    const w = S.dwiz; const n = $('#dw-name'); if (!n) return;
    w.name = n.value.trim();
    w.q = $('#dw-q').value;
    const t = S.dwTargets[Number($('#dw-target').value)]; if (t) w.target = t;
    w.dp = Math.max(0, parseInt($('#dw-dp').value, 10) || 0);
    w.fds = [...document.querySelectorAll('.dw-fd')].filter(x => x.checked).map(x => x.value);
    w.enh = $('#dw-enh').checked;
  }
  function setDetFds(det, ids) {
    const fds = fdCategories();
    const fdIds = new Set([...fds.values()].map(c => c.id));
    det.categoryLinks = (det.categoryLinks || []).filter(l => !fdIds.has(l.targetId));
    ids.forEach(id => { const c = [...fds.values()].find(x => x.id === id); if (c) det.categoryLinks.push({ name: c.name, id: newId(), hidden: false, primary: false, targetId: c.id }); });
  }
  function setDp(det, v) {
    const id = dpId(); if (!id) return;
    if (!det.costs) det.costs = [];
    const c = det.costs.find(c => c.typeId === id);
    if (c) c.value = v; else det.costs.push({ name: 'Detachment Points', typeId: id, value: v });
    // keep keywords like "3DP Detachment" (used by the Incursion rule) in step with the cost
    const dpCats = new Map();
    for (const f of S.files) (f.top.categoryEntries || []).forEach(ce => { const m = /^(\d+)\s*DP Detachment$/i.exec(ce.name || ''); if (m && !dpCats.has(+m[1])) dpCats.set(+m[1], ce); });
    if (!dpCats.size) return;
    const ids = new Set([...dpCats.values()].map(ce => ce.id));
    det.categoryLinks = (det.categoryLinks || []).filter(l => !ids.has(l.targetId));
    const want = dpCats.get(v);
    if (want) det.categoryLinks.push({ name: want.name, id: newId(), hidden: false, primary: false, targetId: want.id });
  }
  function createDetachment(w) {
    const src = w.src, srcFile = fileOf(src), target = w.target;
    const tFile = target.file;
    const cross = srcFile !== tFile;
    const all = detContent(src);
    const rulelinks = cross ? [] : all.filter(c => c.kind === 'rulelink');
    const enhs = w.enh ? all.filter(c => c.kind === 'enh') : [];
    // where copied enhancements go: next to the originals, or (another file) where this faction keeps its enhancements
    let enhHome = null;
    if (enhs.length && cross) {
      for (const d of target.parent[target.key]) {
        if (!d || !d.id || !isDetachment(d)) continue;
        const e = detContent(d).find(c => c.kind === 'enh');
        if (e) { const ei = info(e.obj); enhHome = { parent: ei.parent, key: ei.key, sample: e.obj }; break; }
      }
    }
    const ruleTargets = (src.infoLinks || []).filter(l => l.type === 'rule').map(targetOf).filter(Boolean);
    const parents = [target.parent, ...ruleTargets.map(r => cross ? tFile.top : info(r).parent), ...rulelinks.map(c => info(c.obj).parent), ...enhs.map(c => info(c.obj).parent)];
    if (enhHome) parents.push(enhHome.parent);
    checkpointMany(parents);
    // shared rules the detachment links to are copied, so editing the new rule text doesn't change the original
    const ruleMap = new Map();
    ruleTargets.forEach(r => {
      const copy = regenIds(JSON.parse(JSON.stringify(r)));
      if (cross) { arrPush(tFile.top, 'sharedRules', copy); markDirty(tFile.top); }
      else { const ri = info(r); const arr = ri.parent[ri.key]; arr.splice(arr.indexOf(r) + 1, 0, copy); markDirty(ri.parent); }
      ruleMap.set(r.id, copy.id);
    });
    const det = regenIds(JSON.parse(JSON.stringify(src)));
    det.name = w.name;
    setDp(det, w.dp);
    setDetFds(det, w.fds);
    (det.infoLinks || []).forEach(l => { if (ruleMap.has(l.targetId)) l.targetId = ruleMap.get(l.targetId); });
    const tArr = target.parent[target.key];
    const at = tArr.indexOf(src);
    tArr.splice(at >= 0 ? at + 1 : tArr.length, 0, det);
    markDirty(target.parent);
    const rename = (x) => { if (x.name && x.name.includes(src.name)) x.name = x.name.split(src.name).join(w.name);
      const walk = (y) => { if (Array.isArray(y)) y.forEach(walk); else if (y && typeof y === 'object') { if (typeof y.comment === 'string' && y.comment.includes(src.name)) y.comment = y.comment.split(src.name).join(w.name); Object.values(y).forEach(walk); } };
      walk(x); };
    const copyOf = (o) => { const c = regenIds(JSON.parse(JSON.stringify(o).split(src.id).join(det.id))); rename(c); return c; };
    rulelinks.forEach(c => {
      const copy = copyOf(c.obj);
      if (ruleMap.has(copy.targetId)) copy.targetId = ruleMap.get(copy.targetId);
      const ci = info(c.obj); const a = ci.parent[ci.key]; a.splice(a.indexOf(c.obj) + 1, 0, copy); markDirty(ci.parent);
    });
    let enhNote = '';
    if (enhs.length && !cross) {
      enhs.forEach(c => { const copy = copyOf(c.obj); const ci = info(c.obj); const a = ci.parent[ci.key]; a.splice(a.indexOf(c.obj) + 1, 0, copy); markDirty(ci.parent); });
    } else if (enhs.length && enhHome) {
      const homeArr = enhHome.parent[enhHome.key];
      const homeIsGroups = kindOf(enhHome.sample) === 'group';
      // make the copies fit the faction's layout: a group of enhancements, or loose enhancement entries
      const entries = [];
      enhs.forEach(c => {
        const copy = copyOf(c.obj);
        if (kindOf(c.obj) === 'group') {
          if (homeIsGroups) { homeArr.push(copy); return; }
          // flatten: each enhancement takes the group's "only with this detachment" modifiers
          (copy.selectionEntries || []).forEach(e => { e.modifiers = [...(copy.modifiers || []), ...(e.modifiers || [])]; if (copy.modifierGroups) e.modifierGroups = [...copy.modifierGroups, ...(e.modifierGroups || [])]; entries.push(e); });
        } else entries.push(copy);
      });
      if (entries.length) {
        if (homeIsGroups) homeArr.push({ name: `${w.name} Enhancements`, id: newId(), hidden: false, selectionEntries: entries });
        else entries.forEach(e => homeArr.push(e));
      }
      markDirty(enhHome.parent);
    } else if (enhs.length) enhNote = ' Its enhancements weren\'t copied – this faction has no enhancement list to add them to.';
    S.allDets = null;
    reindex();
    S.secOpen.det = true;
    S.file = tFile;
    select(det);
    const nEnh = enhEntries(detContent(det)).length;
    toast(`Created “${w.name}” (${w.dp} DP) in ${tFile.top.name}${nEnh ? ` with ${nEnh} enhancement${nEnh === 1 ? '' : 's'}` : ''}.${enhNote}${cross ? ' Run ✔ Check data to spot keywords from the other faction.' : ''} Rename and rewrite its rules and enhancements, then save.`, 10000);
  }

  // ------------------------------------------------------------------ actions
  function arrPush(obj, key, item) { if (!obj[key]) obj[key] = []; obj[key].push(item); }
  function select(o) {
    S.sel = o; S.view = 'form';
    const f = fileOf(o); if (f) S.file = f;
    ancestors(o).forEach(a => S.expanded.add(a));
    const anc = ancestors(o);
    if (anc.length) { const topChild = anc[1] || o; const k = info(topChild).key; if (k && f) S.openSections.add(f.name + '|' + k); }
    render();
    const el = document.querySelector('.tnode.sel'); if (el) el.scrollIntoView({ block: 'nearest' });
    const fm = $('#ed-form'); if (fm) fm.scrollTop = 0;
  }

  function regenIds(clone) {
    const map = new Map();
    const collect = (x) => { if (Array.isArray(x)) x.forEach(collect); else if (x && typeof x === 'object') { if (x.id) map.set(x.id, newId()); Object.values(x).forEach(collect); } };
    collect(clone);
    const fix = (x) => {
      if (Array.isArray(x)) return x.map(fix);
      if (x && typeof x === 'object') { for (const k of Object.keys(x)) x[k] = fix(x[k]); return x; }
      if (typeof x === 'string' && map.has(x)) return map.get(x);
      return x;
    };
    return fix(clone);
  }

  function pickObject(title, kinds, cb) {
    let q = '';
    const draw = () => {
      const res = [];
      if (q.length >= 2) {
        const ql = q.toLowerCase();
        for (const f of S.files) {
          const walk = (obj) => { for (const k in obj) { const v = obj[k]; if (!Array.isArray(v)) continue; for (const x of v) { if (!x || typeof x !== 'object') continue; const kk = ENTRY_KEYS[k]; if (res.length < 150 && x.name && kinds.includes(kk) && x.name.toLowerCase().includes(ql)) res.push(x); walk(x); } } };
          walk(f.top);
        }
      }
      REG = new Map(); REGN = 0;
      const extra = kinds.includes('special') ? [['model', 'any model'], ['unit', 'any unit'], ['upgrade', 'any upgrade'], ['any', 'anything']] : [];
      $('#pick-res').innerHTML = (extra.map(e => `<li><a data-act="pick" data-id="${e[0]}">${e[1]}</a></li>`).join('')) + res.map(o => `<li><a data-act="pick" data-ref="${ref(o)}">${nodeIcon(o)} ${esc(o.name)}</a> <span class="muted small">${esc(kindLabel(o))} · ${esc(fileOf(o).top.name)}</span></li>`).join('') + (q.length < 2 ? '<li class="muted">Type at least 2 letters…</li>' : '');
    };
    modal(`<h3>${esc(title)}</h3><input id="pick-q" class="search" placeholder="Search by name…"><ul id="pick-res" class="plain pick"></ul>
      <div class="row-end"><button class="btn" data-act="close-modal">Cancel</button></div>`);
    S._pick = (o) => { closeModal(); cb(o); };
    const qi = $('#pick-q'); qi.focus();
    qi.addEventListener('input', () => { q = qi.value.trim(); draw(); });
    draw();
  }

  function doDelete(o) {
    const i = info(o); if (!i.parent) return;
    const arr = i.parent[i.key]; const idx = arr.indexOf(o);
    const used = o.id ? (S.usedBy.get(o.id) || []).length : 0;
    if (!confirm(`Delete “${o.name || 'item'}”?${used ? `\n\nWarning: ${used} link(s) point to it and will break.` : ''}`)) return;
    checkpoint(i.parent);
    arr.splice(idx, 1); if (!arr.length) delete i.parent[i.key];
    markDirty(i.parent); reindex();
    S.sel = i.parent === fileOf(i.parent).top ? null : i.parent;
    render();
  }

  async function save() {
    const dirty = S.files.filter(f => f.dirty);
    if (!dirty.length) return;
    if (S.readOnly) {
      dirty.forEach(f => { const blob = new Blob([BSFormat.stringify(f.doc)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = f.name; a.click(); f.dirty = false; });
      toast('Changed files downloaded – copy them into wh40k-11e-main.', 6000); render(); return;
    }
    let bdir = null;
    try {
      bdir = await backupFiles(dirty, '');
    } catch (e) {
      console.error(e);
      if (!confirm('Could not make a backup before saving (' + e.message + ').\n\nSave anyway without a backup?')) return;
    }
    try {
      for (const f of dirty) {
        const w = await f.handle.createWritable();
        await w.write(BSFormat.stringify(f.doc)); await w.close();
        await writeAppData(f);
        f.dirty = false;
      }
      if (S.appDataDir) await writeManifest();
      S.orig = new WeakMap(); reindex();
      const fresh = runCheck().issues.filter(i => !isKnown(i) && dirty.includes(i.file));
      if (fresh.length) setTimeout(() => toast(`Data check: ${fresh.length} new problem(s) in the saved file(s) – click ✔ Check data to see them.`, 8000), 7200);
      toast(`Saved ${dirty.length} file(s)${bdir ? ' (previous version backed up in ' + S.backupDirName + '\\' + bdir + ')' : ''}${S.appDataDir ? '. Reload the list builder tab to see changes.' : '.'}`, 7000);
    } catch (e) {
      console.error(e); toast('Save failed: ' + e.message, 8000);
    }
    render();
  }

  async function writeAppData(f) {
    if (!S.appDataDir) return;
    const h = await S.appDataDir.getFileHandle(safeName(f.top.id) + '.js', { create: true });
    const w = await h.createWritable(); await w.write('BSD_LOADED(' + JSON.stringify(f.top.id) + ',' + JSON.stringify(f.doc) + ');\n'); await w.close();
  }

  // ------------------------------------------------------------------ backups
  function stamp() {
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}_${z(d.getHours())}-${z(d.getMinutes())}-${z(d.getSeconds())}`;
  }
  async function backupRoot(create) {
    return S.backupParent.getDirectoryHandle(S.backupDirName, { create: !!create });
  }
  // Copies the current on-disk version of each file into backups/<timestamp><suffix>/
  async function backupFiles(files, suffix) {
    const root = await backupRoot(true);
    let name = stamp() + (suffix || ''), n = 1;
    // avoid clashing with a backup made in the same second
    while (true) { try { await root.getDirectoryHandle(name); name = stamp() + (suffix || '') + '-' + (++n); } catch (e) { break; } }
    const dir = await root.getDirectoryHandle(name, { create: true });
    for (const f of files) {
      const text = await (await f.handle.getFile()).text();
      const h = await dir.getFileHandle(f.name, { create: true });
      const w = await h.createWritable(); await w.write(text); await w.close();
    }
    return name;
  }
  async function listBackups() {
    let root;
    try { root = await backupRoot(false); } catch (e) { return []; }
    const out = [];
    for await (const [name, h] of root.entries()) {
      if (h.kind !== 'directory') continue;
      const files = [];
      for await (const [fn, fh] of h.entries()) if (fh.kind === 'file' && /\.json$/i.test(fn)) { const file = await fh.getFile(); files.push({ name: fn, handle: fh, size: file.size }); }
      files.sort((a, b) => a.name.localeCompare(b.name));
      out.push({ name, handle: h, files });
    }
    out.sort((a, b) => b.name.localeCompare(a.name));
    return out;
  }
  function backupLabel(name) {
    const m = /^(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)(.*)$/.exec(name);
    if (!m) return name;
    const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
    return d.toLocaleString() + (m[7].includes('before-restore') ? ' (before a restore)' : '');
  }
  async function showBackups() {
    if (S.readOnly) { toast('Backups need the folder opened with editing allowed (Chrome/Edge).'); return; }
    modal('<h3>🕘 Backups</h3><p class="muted">Loading…</p>');
    const list = await listBackups();
    S._backups = list;
    const kb = (n) => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
    const total = list.reduce((a, b) => a + b.files.reduce((x, y) => x + y.size, 0), 0);
    modal(`<h3>🕘 Backups</h3>
      <p class="muted small">Each time you save, the previous version of every changed file is copied to <code>${esc(S.backupDirName)}</code> in your folder.
        Restoring puts that version back (your current version is backed up first, so a restore can be undone too).</p>
      ${list.length ? `<p class="muted small">${list.length} backup(s), ${kb(total)} in total. Nothing is deleted automatically.</p>
      <div class="backups">${list.map((b, i) => `<div class="bk"><div class="bk-head"><b>${esc(backupLabel(b.name))}</b> <span class="muted small">${esc(b.name)}</span>
          <span class="spacer"></span><button class="icon danger" title="Delete this backup" data-act="bk-del" data-i="${i}">🗑</button></div>
        ${b.files.map((f, j) => `<div class="bk-file"><span>${esc(f.name)}</span><span class="muted small">${kb(f.size)}</span>
          ${S.files.some(x => x.name === f.name) ? `<button class="btn sm" data-act="bk-restore" data-i="${i}" data-j="${j}">Restore</button>` : '<span class="muted small">(no longer in folder)</span>'}</div>`).join('')}</div>`).join('')}</div>
      ${list.length > 1 ? `<div class="row-end"><button class="btn sm danger" data-act="bk-prune">Delete all but the newest 10…</button></div>` : ''}`
      : '<p>No backups yet – one is made automatically the first time you save a change.</p>'}
      <div class="row-end"><button class="btn primary" data-act="close-modal">Close</button></div>`);
  }
  async function restoreBackup(b, bf) {
    const f = S.files.find(x => x.name === bf.name);
    if (!f) return;
    if (f.dirty && !confirm(`You have unsaved changes in ${f.top.name}. Restoring will discard them. Continue?`)) return;
    if (!confirm(`Restore ${bf.name} from the backup of ${backupLabel(b.name)}?\n\nThe current version will be backed up first.`)) return;
    try {
      const text = await (await bf.handle.getFile()).text();
      let doc; try { doc = JSON.parse(text); } catch (e) { toast('That backup file is not valid JSON – not restored.', 7000); return; }
      await backupFiles([f], '_before-restore');
      const w = await f.handle.createWritable(); await w.write(text); await w.close();
      const kind = doc.gameSystem ? 'gameSystem' : 'catalogue';
      f.doc = doc; f.top = doc[kind]; f.kind = kind; f.dirty = false;
      if (kind === 'gameSystem') S.gs = f.top;
      await writeAppData(f);
      if (S.appDataDir) await writeManifest();
      S.undo = S.undo.filter(u => !(Array.isArray(u) ? u : [u]).some(x => fileOf(x.obj) === f));
      if (S.sel && fileOf(S.sel) === f) S.sel = null;
      S.orig = new WeakMap(); reindex();
      closeModal(); render();
      toast(`Restored ${bf.name}. Reload the list builder to see it.`, 6000);
    } catch (e) { console.error(e); toast('Restore failed: ' + e.message, 8000); }
  }

  async function writeManifest() {
    const m = { gameSystem: null, catalogues: [], built: new Date().toISOString().slice(0, 19), source: 'bundled' };
    for (const f of S.files) {
      const t = f.top;
      const inf = { id: t.id, name: t.name || '', file: safeName(t.id) + '.js', revision: t.revision };
      if (f.kind === 'gameSystem') m.gameSystem = inf;
      else { inf.library = !!t.library; inf.links = (t.catalogueLinks || []).map(l => ({ id: l.targetId, importRootEntries: !!l.importRootEntries })); m.catalogues.push(inf); }
    }
    const h = await S.appDataDir.getFileHandle('manifest.js', { create: true });
    const w = await h.createWritable(); await w.write('window.BSD_MANIFEST = ' + JSON.stringify(m, null, 1) + ';\n'); await w.close();
  }

  // ------------------------------------------------------------------ events
  document.addEventListener('change', (ev) => {
    const t = ev.target;
    if (t.id === 'file-select') { S.file = S.files[Number(t.value)]; S.sel = null; if (S.view === 'form') S.view = 'form'; S.treeFilter = ''; S.ptsFilter = ''; render(); return; }
    if (t.id === 'check-scope') { S.checkScope = t.value; render(); return; }
    if (t.id === 'pts-legends') { S.ptsHideLegends = t.checked; render(); return; }
    if (t.id === 'pts-crucible') { S.ptsHideCrucible = t.checked; render(); return; }
    if (t.id === 'dw-target') { detWizRead(); return; }
    if (t.dataset.actInput === 'det-dp' || t.dataset.actInput === 'det-fd') {
      const det = REG.get(Number(t.dataset.ref)); if (!det) return;
      checkpoint(det);
      if (t.dataset.actInput === 'det-dp') setDp(det, Math.max(0, parseInt(t.value, 10) || 0));
      else { const cur = new Set((det.categoryLinks || []).map(l => l.targetId)); if (t.checked) cur.add(t.dataset.cat); else cur.delete(t.dataset.cat); setDetFds(det, [...fdCategories().values()].map(c => c.id).filter(id => cur.has(id))); }
      markDirty(det); reindex(); render(); return;
    }
    if (t.dataset.actChange) { changeAct(t); return; }
    if (t.dataset.ref && t.dataset.prop) applyInput(t);
  });
  document.addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.id === 'dw-q') { detWizRead(); S.dwiz._focus = 'q'; clearTimeout(S._dq); S._dq = setTimeout(openDetWizard, 150); return; }
    if (t.id === 'search') { S.search = t.value; S._focusSearch = true; clearTimeout(S._st); S._st = setTimeout(render, 200); }
    if (t.id === 'pts-filter') { S.ptsFilter = t.value; clearTimeout(S._st); S._st = setTimeout(() => { render(); const i = $('#pts-filter'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 200); }
    if (t.id === 'tree-filter') { S.treeFilter = t.value; clearTimeout(S._st); S._st = setTimeout(() => { render(); const i = $('#tree-filter'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 200); }
  });
  document.addEventListener('toggle', (ev) => { const d = ev.target; if (d.dataset && d.dataset.sec) S.secOpen[d.dataset.sec] = d.open; }, true);
  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'z' && !/INPUT|TEXTAREA|SELECT/.test(ev.target.tagName)) { ev.preventDefault(); undo(); }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 's') { ev.preventDefault(); save(); }
  });
  window.addEventListener('beforeunload', (ev) => { if (S.files.some(f => f.dirty)) { ev.preventDefault(); ev.returnValue = ''; } });
  $('#modal').addEventListener('click', (ev) => { if (ev.target.id === 'modal') closeModal(); });
  $('#folder-input').addEventListener('change', (ev) => { openFileList(ev.target.files); ev.target.value = ''; });

  function changeAct(t) {
    const o = REG.get(Number(t.dataset.ref));
    switch (t.dataset.actChange) {
      case 'add-cost': {
        if (t.value === '') return;
        checkpoint(o); arrPush(o, 'costs', { name: t.dataset.name, typeId: t.dataset.typeId, value: Number(t.value) });
        markDirty(o); render(); break;
      }
      case 'add-char': {
        checkpoint(o); arrPush(o, 'characteristics', { name: t.dataset.name, typeId: t.dataset.typeId, $text: t.value });
        markDirty(o); render(); break;
      }
      case 'add-cat': {
        if (!t.value) return;
        const c = byId(t.value, ['category']);
        checkpoint(o); arrPush(o, 'categoryLinks', { name: c ? c.name : '', id: newId(), hidden: false, primary: false, targetId: t.value });
        markDirty(o); reindex(); render(); break;
      }
    }
  }

  document.addEventListener('click', async (ev) => {
    const el = ev.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const o = el.dataset.ref ? REG.get(Number(el.dataset.ref)) : null;
    switch (act) {
      case 'pick-folder': {
        try {
          const opts = { id: 'bsdata', mode: 'readwrite' };
          if (prevHandle) opts.startIn = prevHandle;
          let h;
          try { h = await window.showDirectoryPicker(opts); } catch (e) { if (e.name === 'AbortError') throw e; delete opts.startIn; h = await window.showDirectoryPicker(opts); }
          setLoading('Opening ' + h.name + '…');
          if (await openHandle(h)) render(); else { await renderWelcome(); openStatus('No army data (.json files) was found in “' + esc(h.name) + '”. Pick the folder that contains <b>wh40k-11e-main</b>.', true); }
        } catch (e) {
          if (e.name !== 'AbortError') { console.error('Open folder failed', e); await renderWelcome(); openStatus('Couldn\'t open that folder (' + esc(e.name + ': ' + e.message) + ').', true); }
        }
        break;
      }
      case 'reopen': reopenFolder(); break;
      case 'pick-folder-ro': $('#folder-input').click(); break;
      case 'change-folder': if (!S.files.some(f => f.dirty) || confirm('Discard unsaved changes?')) { S.files = []; render(); } break;
      case 'save': save(); break;
      case 'undo': undo(); break;
      case 'close-modal': closeModal(); break;
      case 'toggle-sec': { const k = el.dataset.k; if (ev.target.closest('.add')) return; S.openSections.has(k) ? S.openSections.delete(k) : S.openSections.add(k); render(); break; }
      case 'expand': ev.stopPropagation(); S.expanded.has(o) ? S.expanded.delete(o) : S.expanded.add(o); render(); break;
      case 'select': if (ev.target.closest('[data-act=expand]')) return; if (o) select(o); break;
      case 'goto-file': S.sel = null; render(); break;
      case 'toggle-costs': S.showAllCosts = !S.showAllCosts; render(); break;
      case 'pick': { const p = el.dataset.ref ? REG.get(Number(el.dataset.ref)) : el.dataset.id; if (S._pick) S._pick(p); break; }

      case 'add-top': {
        ev.stopPropagation();
        const key = el.dataset.key, top = S.file.top;
        const make = (item) => { checkpoint(top); arrPush(top, key, item); markDirty(top); reindex(); S.openSections.add(S.file.name + '|' + key); select(item); };
        const kind = ADDABLE[key];
        if (kind === 'link') pickObject('Link which unit / entry?', ['entry', 'group'], (t) => make(linkTo(t)));
        else if (kind === 'entry') make({ name: 'New entry', id: newId(), hidden: false, import: true, type: key === 'sharedSelectionEntries' ? 'unit' : 'upgrade' });
        else if (kind === 'group') make({ name: 'New group', id: newId(), hidden: false });
        else if (kind === 'rule') make({ name: 'New rule', id: newId(), hidden: false, description: '' });
        else if (kind === 'category') make({ name: 'New category', id: newId(), hidden: false });
        else if (kind === 'profile') {
          const pts = [...new Map(S.files.flatMap(f => (f.top.profileTypes || []).map(p => [p.id, p]))).values()];
          const pt = pts.find(p => p.name === 'Abilities') || pts[0];
          make(newProfile(pt));
        }
        break;
      }
      case 'add-child': {
        const target = kindOf(o) === 'link' ? o : o;
        const k = el.dataset.kind;
        const put = (key, item) => { checkpoint(target); arrPush(target, key, item); markDirty(target); reindex(); S.expanded.add(target); select(item); };
        if (k === 'entry') put('selectionEntries', { name: 'New option', id: newId(), hidden: false, import: true, type: 'upgrade', constraints: [{ id: newId(), field: 'selections', scope: 'parent', shared: true, type: 'max', value: 1 }], costs: [{ name: 'pts', typeId: ptsId(), value: 0 }] });
        else if (k === 'group') put('selectionEntryGroups', { name: 'New group', id: newId(), hidden: false });
        else pickObject('Link which entry or group?', ['entry', 'group'], (t) => put('entryLinks', linkTo(t)));
        break;
      }
      case 'del-item': {
        const key = el.dataset.key, i = Number(el.dataset.i);
        const item = o[key][i];
        if (['selectionEntries', 'selectionEntryGroups', 'entryLinks'].includes(key) && !confirm(`Delete “${item.name}”?`)) return;
        checkpoint(o); o[key].splice(i, 1); if (!o[key].length) delete o[key];
        markDirty(o); reindex(); render(); break;
      }
      case 'move': {
        const key = el.dataset.key, i = Number(el.dataset.i), d = Number(el.dataset.d), arr = o[key];
        if (i + d < 0 || i + d >= arr.length) return;
        checkpoint(o); [arr[i], arr[i + d]] = [arr[i + d], arr[i]]; markDirty(o); render(); break;
      }
      case 'delete': doDelete(o); break;
      case 'dup': {
        const i = info(o); if (!i.parent) return;
        const clone = regenIds(JSON.parse(JSON.stringify(o)));
        clone.name = (clone.name || '') + ' (copy)';
        checkpoint(i.parent);
        const arr = i.parent[i.key]; arr.splice(arr.indexOf(o) + 1, 0, clone);
        markDirty(i.parent); reindex(); select(clone); break;
      }
      case 'relink': pickObject('Point this link to…', o.type === 'selectionEntryGroup' ? ['group'] : o.type === 'selectionEntry' ? ['entry'] : ['profile', 'rule', 'infoGroup'], (t) => { checkpoint(o); o.targetId = t.id; o.name = t.name; markDirty(o); reindex(); render(); }); break;
      case 'add-profile': {
        const pt = profileType($('#new-profile-type').value);
        checkpoint(o); arrPush(o, el.dataset.key, newProfile(pt)); markDirty(o); reindex(); render(); break;
      }
      case 'add-rule': checkpoint(o); arrPush(o, el.dataset.key, { name: 'New rule', id: newId(), hidden: false, description: '' }); markDirty(o); reindex(); render(); break;
      case 'add-infolink': pickObject('Link which rule / profile / info group?', ['rule', 'profile', 'infoGroup'], (t) => {
        checkpoint(o); arrPush(o, 'infoLinks', { name: t.name, id: newId(), hidden: false, targetId: t.id, type: kindOf(t) }); markDirty(o); reindex(); render(); }); break;
      case 'set-primary': checkpoint(o); (o.categoryLinks || []).forEach((c, i) => { c.primary = i === Number(el.dataset.i); }); markDirty(o); render(); break;
      case 'add-constraint': checkpoint(o); arrPush(o, 'constraints', { id: newId(), field: 'selections', scope: 'parent', shared: true, type: 'max', value: 1 }); markDirty(o); render(); break;
      case 'add-mod': checkpoint(o); arrPush(o, 'modifiers', { type: 'set', field: 'hidden', value: true }); S.secOpen.modifiers = true; markDirty(o); render(); break;
      case 'add-cond': checkpoint(o); arrPush(o, 'conditions', { childId: 'model', field: 'selections', scope: 'parent', shared: true, type: 'atLeast', value: 1, includeChildSelections: true }); markDirty(o); render(); break;
      case 'pick-child': pickObject('What should this condition count / check?', ['entry', 'group', 'category', 'force', 'special'], (t) => {
        checkpoint(o); o.childId = typeof t === 'string' ? t : t.id; if (typeof t !== 'string' && t.name) o.childName = t.name; else delete o.childName; markDirty(o); render(); }); break;
      case 'backups': showBackups(); break;
      case 'show-check': S.view = 'check'; S.sel = null; runCheck(); render(); $('#ed-form').scrollTop = 0; break;
      case 'recheck': runCheck(); render(); toast('Checked.'); break;
      case 'mark-known': {
        if (!confirm('Treat every problem currently found as “already in the files”? Only new problems will be shown after this.')) return;
        runCheck(); S.baseline = new Set(S.check.issues.map(i => i.key));
        try { await KV.set(baselineKey(), [...S.baseline]); } catch (e) { /* ignore */ }
        render(); break;
      }
      case 'bk-restore': { const b = S._backups[Number(el.dataset.i)]; restoreBackup(b, b.files[Number(el.dataset.j)]); break; }
      case 'bk-del': {
        const b = S._backups[Number(el.dataset.i)];
        if (!confirm(`Permanently delete the backup from ${backupLabel(b.name)}?`)) return;
        try { await (await backupRoot(false)).removeEntry(b.name, { recursive: true }); } catch (e) { toast('Could not delete: ' + e.message, 6000); }
        showBackups(); break;
      }
      case 'bk-prune': {
        const old = S._backups.slice(10);
        if (!old.length) { toast('There are 10 or fewer backups.'); return; }
        if (!confirm(`Permanently delete ${old.length} older backup(s), keeping the newest 10?`)) return;
        const root = await backupRoot(false);
        for (const b of old) { try { await root.removeEntry(b.name, { recursive: true }); } catch (e) { console.warn(e); } }
        showBackups(); break;
      }
      case 'show-points': S.view = 'points'; S.sel = null; render(); $('#ed-form').scrollTop = 0; break;
      case 'new-unit': S.wiz = null; openWizard(); break;
      case 'new-det': S.allDets = null; S.dwiz = { name: '', src: null, dp: 1, fds: null, enh: true, q: '' }; openDetWizard(); break;
      case 'dw-pick': { detWizRead(); const x = S.dwList[Number(el.dataset.i)]; if (x) { S.dwiz.src = x.d; S.dwiz.dp = dpOf(x.d); S.dwiz.fds = null; S.dwiz._focus = 'name'; } openDetWizard(); break; }
      case 'det-create': {
        detWizRead(); const w = S.dwiz;
        if (!w.name) { toast('Enter a name.'); return; }
        if (!w.src) { toast('Choose a detachment to copy from.'); return; }
        if (detachmentsIn(S.files).some(d => d.name.toLowerCase() === w.name.toLowerCase())) { toast('A detachment with that name already exists.'); return; }
        closeModal(); createDetachment(w); break;
      }
      case 'det-add-enh': addEnhancement(o); break;
      case 'wiz-pick': wizRead(); pickObject('Copy which unit?', ['entry'], (t) => {
        if (!(t.type === 'unit' || t.type === 'model')) { toast('Pick a unit or model entry (marked U or M).'); openWizard(); return; }
        S.wiz.source = t;
        if (!S.wiz.name) S.wiz.name = t.name + ' (new)';
        openWizard(); }); break;
      case 'wiz-create': {
        wizRead(); const w = S.wiz;
        if (!w.name) { toast('Enter a name.'); return; }
        if (!w.source) { toast('Choose a unit to copy from.'); return; }
        if (w.fac < 0) { toast('Choose a faction.'); return; }
        closeModal(); createUnit(w); break;
      }
      case 'assoc-new': {
        const sup = el.dataset.kind === 'support';
        checkpoint(o);
        arrPush(o, 'associations', { name: sup ? 'Supporting' : 'Leading', id: newId(), action: 'group', childId: 'unit', childName: 'unit', includeChildSelections: true,
          label: sup ? 'Supported by' : 'Leader', max: 1, min: sup ? 1 : 0, scope: 'force', conditionGroups: [{ type: 'or', conditions: [] }] });
        S.secOpen.assoc = true; markDirty(o); reindex(); render(); break;
      }
      case 'assoc-add': pickObject('Which unit can it attach to? (pick the unit\'s keyword, marked #)', ['category', 'entry'], (t) => {
        checkpoint(o);
        const L = assocList(o);
        let g;
        if (L.mode === 'or') g = L.group;
        else { g = { type: 'or', conditions: (o.conditions || []).slice() }; delete o.conditions; o.conditionGroups = [g]; }
        if (!g.conditions) g.conditions = [];
        if (!g.conditions.some(c => c.childId === t.id)) g.conditions.push({ childId: t.id, childName: t.name, field: 'selections', scope: 'self', shared: true, type: 'instanceOf', value: 1 });
        markDirty(o); render(); }); break;
      case 'assoc-rm': {
        checkpoint(o);
        const L = assocList(o);
        const id = el.dataset.id;
        if (L.mode === 'or') L.group.conditions = (L.group.conditions || []).filter(c => !(instSelf(c) && c.childId === id));
        else o.conditions = (o.conditions || []).filter(c => c.childId !== id);
        markDirty(o); render(); break;
      }
      case 'add-pts-bracket': {
        const unit = o;
        checkpoint(unit);
        arrPush(unit, 'modifiers', { type: 'set', field: ptsId(), value: 0, conditions: [{ childId: 'model', field: 'selections', includeChildSelections: true, scope: unit.id, shared: true, type: 'atLeast', value: 6 }] });
        markDirty(unit); render(); toast('Added: set the new points value and the model count it applies from.'); break;
      }
      case 'edit-json': {
        modal(`<h3>Edit JSON</h3><textarea class="raw" id="json-edit" rows="20">${esc(JSON.stringify(o, null, 2))}</textarea>
          <div class="row-end"><button class="btn" data-act="close-modal">Cancel</button><button class="btn primary" data-act="apply-json-modal" data-ref="${el.dataset.ref}">Apply</button></div>`);
        break;
      }
      case 'apply-json-modal': case 'apply-raw': {
        const ta = act === 'apply-raw' ? $('#raw-' + el.dataset.ref) : $('#json-edit');
        let v; try { v = JSON.parse(ta.value); } catch (e) { toast('Invalid JSON: ' + e.message, 6000); return; }
        if (!v || typeof v !== 'object' || Array.isArray(v)) { toast('Must be a JSON object.'); return; }
        checkpoint(o); for (const k of Object.keys(o)) delete o[k]; Object.assign(o, v);
        markDirty(o); reindex(); if (act === 'apply-json-modal') closeModal(); render(); toast('Applied'); break;
      }
    }
  });

  function linkTo(t) {
    return { name: t.name, id: newId(), hidden: false, import: true, targetId: t.id, type: kindOf(t) === 'group' ? 'selectionEntryGroup' : 'selectionEntry' };
  }
  function newProfile(pt) {
    return { name: 'New profile', id: newId(), hidden: false, typeId: pt ? pt.id : '', typeName: pt ? pt.name : '',
      characteristics: pt ? pt.characteristicTypes.map(c => ({ name: c.name, typeId: c.id, $text: '' })) : [] };
  }

  // test hook (used by automated tests)
  window.__editor = { S, openHandle, loadTexts, render, save, select, byId };

  render();
})();
