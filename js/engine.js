/* Offline list builder – BattleScribe/BSData rules engine.
 * Works on the JSON form of BSData (gameSystem + catalogues).
 * Supports: entry links, groups, costs, modifiers (+groups, repeats), conditions
 * (+groups, local condition groups), constraints/validation, categories,
 * profiles & rules.
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- data loading
  const Data = {
    manifest: null,
    raw: {},          // id -> root object (gameSystem or catalogue)
    _waiting: {},
    source: 'bundled',
  };
  global.BSD_LOADED = function (id, doc) {
    const o = doc.gameSystem || doc.catalogue;
    Data.raw[id] = o;
    const w = Data._waiting[id];
    if (w) { delete Data._waiting[id]; w.forEach(f => f.resolve(o)); }
  };

  Data.init = async function () {
    // Prefer data imported in-app (IndexedDB), else bundled manifest.
    try {
      const m = await IDB.get('manifest');
      if (m && m.catalogues) { Data.manifest = m; Data.source = 'imported'; return; }
    } catch (e) { /* ignore */ }
    Data.manifest = global.BSD_MANIFEST || null;
    Data.source = 'bundled';
  };

  Data.load = function (id) {
    if (Data.raw[id]) return Promise.resolve(Data.raw[id]);
    const m = Data.manifest;
    const info = m.gameSystem.id === id ? m.gameSystem : m.catalogues.find(c => c.id === id);
    if (!info) return Promise.reject(new Error('Missing data file for id ' + id));
    if (Data.source === 'imported') {
      return IDB.get('file:' + id).then(doc => {
        if (!doc) throw new Error('Missing imported data for ' + info.name);
        const o = doc.gameSystem || doc.catalogue; Data.raw[id] = o; return o;
      });
    }
    return new Promise((resolve, reject) => {
      (Data._waiting[id] = Data._waiting[id] || []).push({ resolve, reject });
      if (Data._waiting[id].length > 1) return;
      const s = document.createElement('script');
      s.src = 'data/' + info.file;
      s.onerror = () => { const w = Data._waiting[id] || []; delete Data._waiting[id]; w.forEach(f => f.reject(new Error('Could not load data/' + info.file))); };
      document.head.appendChild(s);
    });
  };

  // Catalogue closure: [catalogue, ...linked (recursive)]
  Data.closure = function (catId) {
    const m = Data.manifest, seen = new Set(), order = [];
    (function visit(id) {
      if (seen.has(id)) return; seen.add(id);
      const c = m.catalogues.find(x => x.id === id); if (!c) return;
      order.push(c);
      (c.links || []).forEach(l => visit(l.id));
    })(catId);
    return order;
  };

  // ---------------------------------------------------------------- IndexedDB helper
  const IDB = {
    _db: null,
    open() {
      if (this._db) return Promise.resolve(this._db);
      return new Promise((res, rej) => {
        if (!global.indexedDB) return rej(new Error('no indexedDB'));
        const r = indexedDB.open('offline-list-builder', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => { this._db = r.result; res(r.result); };
        r.onerror = () => rej(r.error);
      });
    },
    async get(k) { const db = await this.open(); return new Promise((res, rej) => { const t = db.transaction('kv').objectStore('kv').get(k); t.onsuccess = () => res(t.result); t.onerror = () => rej(t.error); }); },
    async set(k, v) { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); },
    async clear() { const db = await this.open(); return new Promise((res, rej) => { const tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').clear(); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); }); },
  };

  // ---------------------------------------------------------------- Catalog (index for one faction)
  const DEF_KEYS = ['sharedSelectionEntries', 'sharedSelectionEntryGroups', 'selectionEntries', 'selectionEntryGroups',
    'sharedProfiles', 'profiles', 'sharedRules', 'rules', 'sharedInfoGroups', 'infoGroups', 'categoryEntries',
    'forceEntries', 'costTypes', 'profileTypes', 'entryLinks', 'sharedAssociations'];

  class Catalog {
    constructor(sys, cats) {
      this.sys = sys; this.cats = cats; // cats[0] = primary catalogue
      this.byId = new Map();
      this.nodeCache = new Map();
      const files = [...cats, sys];
      files.forEach(f => this._index(f));
      this.costTypes = (sys.costTypes || []);
      this.ptsType = (this.costTypes.find(c => c.name === 'pts') || this.costTypes[0] || {}).id;
      this.profileTypes = new Map();
      files.forEach(f => (f.profileTypes || []).forEach(p => this.profileTypes.set(p.id, p)));
      this.categories = new Map();
      files.forEach(f => (f.categoryEntries || []).forEach(c => { if (!this.categories.has(c.id)) this.categories.set(c.id, c); }));
    }
    _index(o) {
      const walk = (obj) => {
        for (const k of DEF_KEYS) {
          const arr = obj[k];
          if (!Array.isArray(arr)) continue;
          for (const x of arr) {
            if (x && x.id && k !== 'entryLinks' && !this.byId.has(x.id)) this.byId.set(x.id, x);
            if (x && typeof x === 'object') walk(x);
          }
        }
      };
      walk(o);
    }
    get(id) { return this.byId.get(id); }
    catName(id) { const c = this.categories.get(id); return c ? c.name : id; }

    // Wrap a raw selectionEntry / group / entryLink into a Node
    node(raw, kindHint) {
      if (!raw) return null;
      let n = this.nodeCache.get(raw);
      if (n) return n;
      if (raw.targetId !== undefined && (raw.type === 'selectionEntry' || raw.type === 'selectionEntryGroup')) {
        const t = this.byId.get(raw.targetId);
        if (!t) return null;
        const link = raw;
        const kind = link.type === 'selectionEntryGroup' ? 'group' : 'entry';
        const cat = (a, b) => (a || []).concat(b || []);
        let catLinks = t.categoryLinks || [];
        if (link.categoryLinks && link.categoryLinks.length) {
          const hasPrimary = link.categoryLinks.some(c => c.primary);
          catLinks = (hasPrimary ? catLinks.map(c => Object.assign({}, c, { primary: false })) : catLinks).concat(link.categoryLinks);
        }
        let costs = t.costs || [];
        if (link.costs && link.costs.length) {
          const m = new Map(costs.map(c => [c.typeId, c])); link.costs.forEach(c => m.set(c.typeId, c)); costs = [...m.values()];
        }
        n = {
          kind, id: t.id, key: link.id, raw: t, link, name: t.name || link.name,
          type: t.type, hidden: !!(t.hidden || link.hidden), collective: !!(t.collective || link.collective),
          sortIndex: link.sortIndex !== undefined ? link.sortIndex : t.sortIndex,
          constraints: cat(t.constraints, link.constraints),
          modifiers: cat(t.modifiers, link.modifiers),
          modifierGroups: cat(t.modifierGroups, link.modifierGroups),
          categoryLinks: catLinks, costs,
          profiles: cat(t.profiles, link.profiles), rules: cat(t.rules, link.rules),
          infoLinks: cat(t.infoLinks, link.infoLinks), infoGroups: cat(t.infoGroups, link.infoGroups),
          defaultSelectionEntryId: t.defaultSelectionEntryId,
          _childSrc: [t, link],
        };
      } else {
        const kind = kindHint || (raw.type === undefined || raw.selectionEntries && raw.type === undefined ? 'group' : 'entry');
        n = {
          kind, id: raw.id, key: raw.id, raw, link: null, name: raw.name, type: raw.type,
          hidden: !!raw.hidden, collective: !!raw.collective, sortIndex: raw.sortIndex,
          constraints: raw.constraints || [], modifiers: raw.modifiers || [], modifierGroups: raw.modifierGroups || [],
          categoryLinks: raw.categoryLinks || [], costs: raw.costs || [],
          profiles: raw.profiles || [], rules: raw.rules || [], infoLinks: raw.infoLinks || [], infoGroups: raw.infoGroups || [],
          defaultSelectionEntryId: raw.defaultSelectionEntryId,
          _childSrc: [raw],
        };
      }
      n.cid = n.key; // unique-ish handle
      this.nodeCache.set(raw, n);
      return n;
    }

    children(node) {
      if (node._children) return node._children;
      const out = [];
      for (const src of node._childSrc) {
        if (!src) continue;
        (src.selectionEntries || []).forEach(e => { const n = this.node(e, 'entry'); if (n) out.push(n); });
        (src.selectionEntryGroups || []).forEach(g => { const n = this.node(g, 'group'); if (n) out.push(n); });
        (src.entryLinks || []).forEach(l => { const n = this.node(l); if (n) out.push(n); });
      }
      sortNodes(out);
      node._children = out;
      return out;
    }

    forceNode(fe) {
      let n = this.nodeCache.get(fe);
      if (n) return n;
      n = { kind: 'force', id: fe.id, key: fe.id, raw: fe, name: fe.name, hidden: false, constraints: fe.constraints || [],
        modifiers: fe.modifiers || [], modifierGroups: fe.modifierGroups || [], categoryLinks: fe.categoryLinks || [], costs: [] };
      this.nodeCache.set(fe, n);
      return n;
    }

    // Attachment-type associations (Leader / Support / Retinue ...) defined on a node
    assocs(node) {
      if (node._assocs) return node._assocs;
      const out = [];
      for (const src of node._childSrc || []) {
        if (!src) continue;
        (src.associations || []).forEach(a => out.push(a));
        (src.associationLinks || []).forEach(l => { const t = this.byId.get(l.targetId); if (t) out.push(t); });
      }
      node._assocs = out.filter(a => a.action === 'group' && a.childId === 'unit');
      return node._assocs;
    }

    forceEntries() { return (this.sys.forceEntries || []).concat(...this.cats.map(c => c.forceEntries || [])); }

    // Entries that can be added at the root of a force.
    rootNodes() {
      if (this._root) return this._root;
      const out = [], seen = new Set();
      const add = (file, imported) => {
        (file.entryLinks || []).forEach(l => { if (imported && l.import === false) return; const n = this.node(l); if (n && !seen.has(n.key)) { seen.add(n.key); out.push(n); } });
        (file.selectionEntries || []).forEach(e => { if (imported && e.import === false) return; const n = this.node(e, 'entry'); if (n && !seen.has(n.key)) { seen.add(n.key); out.push(n); } });
      };
      const primary = this.cats[0];
      add(primary, false);
      // linked catalogues with importRootEntries (recursive)
      const visited = new Set([primary.id]);
      const visit = (file) => {
        (file.catalogueLinks || []).forEach(l => {
          if (!l.importRootEntries || visited.has(l.targetId)) return;
          visited.add(l.targetId);
          const f = this.cats.find(c => c.id === l.targetId);
          if (f) { add(f, true); visit(f); }
        });
      };
      visit(primary);
      add(this.sys, false);
      this._root = out;
      return out;
    }
  }

  function sortNodes(arr) {
    arr.sort((a, b) => {
      const sa = a.sortIndex, sb = b.sortIndex;
      if (sa !== undefined && sb !== undefined && sa !== sb) return sa - sb;
      if (sa !== undefined && sb === undefined) return -1;
      if (sb !== undefined && sa === undefined) return 1;
      return (a.name || '').localeCompare(b.name || '');
    });
  }

  // ---------------------------------------------------------------- Roster model
  let UID = 1;
  let GEN = 1;
  function bump() { GEN++; }

  class Roster {
    constructor(catalog, opts) {
      this.isRoster = true;
      this.catalog = catalog;
      this.id = opts.id || ('r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
      this.name = opts.name || 'New Roster';
      this.costLimit = opts.costLimit !== undefined ? opts.costLimit : 2000;
      this.catalogueId = catalog.cats[0].id;
      this.forces = [];
      this.notes = opts.notes || '';
      this.dpOverride = opts.dpOverride !== undefined && opts.dpOverride !== null ? Number(opts.dpOverride) : null;
    }
    get children() { return [].concat(...this.forces.map(f => f.children)); }
  }

  class Force {
    constructor(roster, forceEntry) {
      this.isForce = true;
      this.uid = UID++;
      this.roster = roster;
      this.node = roster.catalog.forceNode(forceEntry);
      this.children = [];
      this.force = this;
      this.parent = roster;
    }
  }

  class Sel {
    constructor(parent, node, groups, number) {
      this.uid = UID++;
      this.parent = parent;
      this.force = parent.force;
      this.node = node;
      this.groups = groups || [];   // group nodes between parent and this selection
      this.number = number || 1;
      this.children = [];
      this.virtual = false;
      this.customName = '';
      this.attachedTo = null;   // root Sel this character is attached to
      this.assocId = null;      // association used
    }
    get opath() { return this.groups.map(g => g.key).concat([this.node.key]); }
  }

  function makeVirtual(parent, node, groups) {
    const key = (groups || []).map(g => g.key).join('/') + '/' + node.key;
    if (!parent._vgen || parent._vgen !== GEN) { parent._vgen = GEN; parent._virt = new Map(); }
    let v = parent._virt.get(key);
    if (!v) {
      v = { uid: 'v' + key, virtual: true, parent, force: parent.force, node, groups: groups || [], number: 0, children: [] };
      parent._virt.set(key, v);
    }
    return v;
  }

  // ---------------------------------------------------------------- helpers
  const rosterOf = (s) => s.isRoster ? s : (s.isForce ? s.roster : rosterOf(s.parent));
  const isSel = (s) => s && !s.isForce && !s.isRoster;

  function groupIdSet(s) {
    if (!s._gids) { s._gids = new Set(); (s.groups || []).forEach(g => { s._gids.add(g.id); s._gids.add(g.key); }); }
    return s._gids;
  }

  function match(s, childId) {
    if (childId === undefined || childId === null) return false;
    if (childId === 'any') return true;
    if (s.isForce) return s.node.id === childId;
    if (!isSel(s)) return false;
    const n = s.node;
    if (n.id === childId || n.key === childId) return true;
    if (childId === 'model' || childId === 'unit' || childId === 'upgrade') return n.type === childId;
    if (groupIdSet(s).has(childId)) return true;
    return ev(s).cats.has(childId);
  }

  // Walk descendants of container. cb(sel, multiplier)
  function walkDesc(container, recursive, cb) {
    const top = container.isRoster ? container.children : container.children;
    const rec = (list, mult) => {
      for (const c of list) {
        cb(c, mult);
        if (recursive && c.children.length) rec(c.children, mult * c.number);
      }
    };
    rec(top, 1);
  }

  function ancestorsSelf(s) { const out = []; let x = s; while (isSel(x)) { out.push(x); x = x.parent; } return out; }

  let ASSOC_OWNER = null;
  function resolveScope(scope, s) {
    const r = resolveScope0(scope, s);
    if (r || !ASSOC_OWNER || ASSOC_OWNER === s) return r;
    return resolveScope0(scope, ASSOC_OWNER);
  }
  function resolveScope0(scope, s) {
    switch (scope) {
      case undefined: case 'self': return s;
      case 'parent': return s.parent;
      case 'force': return s.force;
      case 'roster': case 'primary-catalogue': return rosterOf(s);
      case 'root-entry': { const a = ancestorsSelf(s); return a.length ? a[a.length - 1] : s; }
      case 'unit': case 'unit-self': return ancestorsSelf(s).find(x => x.node.type === 'unit') || null;
      case 'model': return ancestorsSelf(s).find(x => x.node.type === 'model') || null;
      case 'model-or-unit': return ancestorsSelf(s).find(x => x.node.type === 'model' || x.node.type === 'unit') || null;
      case 'upgrade': return ancestorsSelf(s).find(x => x.node.type === 'upgrade') || null;
      case 'ancestor': return s.parent;
      default: {
        const a = ancestorsSelf(s).find(x => x.node.id === scope || x.node.key === scope || groupIdSet(x).has(scope));
        if (a) return a;
        if (s.force && s.force.node.id === scope) return s.force;
        return null;
      }
    }
  }

  function costOf(s, typeId) { return ev(s).costs[typeId] || 0; }

  function rootSelOf(s) { const a = ancestorsSelf(s); return a.length ? a[a.length - 1] : null; }
  function attachedTarget(s) {
    const t = s && s.attachedTo;
    return t && t.force === s.force && s.force.children.includes(t) && s.force.children.includes(s) ? t : null;
  }
  function attachedLeaders(t) { return t && t.force ? t.force.children.filter(x => attachedTarget(x) === t) : []; }
  // the whole attached unit (bodyguard + all attached characters)
  function attachGroup(s) {
    const root = rootSelOf(s); if (!root) return [];
    const target = attachedTarget(root) || root;
    return [target].concat(attachedLeaders(target));
  }

  function canAttach(leader, assoc, target) {
    if (!leader || !target || leader === target || target.force !== leader.force) return false;
    if (target.node.type !== 'unit' && target.node.type !== 'model') return false;
    if (attachedTarget(target)) return false; // a leader can't be led
    ev(target); ev(leader); // cache normal evaluations before switching context
    const prev = ASSOC_OWNER; ASSOC_OWNER = leader;
    try { return condsPass(assoc, target); } finally { ASSOC_OWNER = prev; }
  }
  function attachOptions(leader) {
    const cat = rosterOf(leader).catalog;
    const out = [];
    for (const a of cat.assocs(leader.node)) {
      for (const t of leader.force.children) if (canAttach(leader, a, t)) out.push({ assoc: a, target: t });
    }
    return out;
  }
  function countAssociations(q, s) {
    const scopeObj = resolveScope(q.scope, s);
    if (!isSel(scopeObj)) return 0;
    const root = rootSelOf(scopeObj);
    let n = 0;
    attachedLeaders(root).forEach(l => { if (!q.childId || match(l, q.childId)) n++; });
    const t = attachedTarget(root);
    if (t && (!q.childId || match(t, q.childId))) n++;
    return n;
  }

  function countQuery(q, s, defaultMatch) {
    // q: {scope, childId, field, includeChildSelections, includeChildForces}
    const field = q.field || 'selections';
    if (field === 'associations') return countAssociations(q, s);
    if (field === 'forces') {
      const r = rosterOf(s);
      return r.forces.filter(f => q.childId === 'any' || f.node.id === q.childId).length;
    }
    if (q.scope === 'ancestor') {
      let n = 0; let x = s.parent;
      while (isSel(x)) { if (match(x, q.childId)) n++; x = x.parent; }
      return n;
    }
    const scopeObj = resolveScope(q.scope, s);
    if (!scopeObj) return 0;
    const matcher = q.childId ? (x => match(x, q.childId)) : defaultMatch;
    if (!matcher) return 0;
    const isCost = field !== 'selections';
    let total = 0;
    const containers = (q.traverseAssociationGroup && isSel(scopeObj) && rootSelOf(scopeObj) === scopeObj) ? attachGroup(scopeObj) : [scopeObj];
    for (const cont of containers) {
      if (cont !== scopeObj && matcher(cont)) total += isCost ? costOf(cont, field) * cont.number : cont.number;
      walkDesc(cont, !!q.includeChildSelections, (x, mult) => {
        if (!matcher(x)) return;
        total += isCost ? costOf(x, field) * x.number * mult : x.number * mult;
      });
    }
    return total;
  }

  function compare(type, v, target) {
    switch (type) {
      case 'atLeast': return v >= target;
      case 'atMost': return v <= target;
      case 'greaterThan': return v > target;
      case 'lessThan': return v < target;
      case 'equalTo': return v === target;
      case 'notEqualTo': return v !== target;
      default: return true;
    }
  }

  function isInstance(x, childId) {
    if (!x) return false;
    if (x.isRoster) return false;
    return match(x, childId);
  }

  function condPass(c, s) {
    const t = c.type;
    if (t === 'instanceOf' || t === 'notInstanceOf') {
      let r;
      if (c.scope === 'ancestor') { r = false; let x = s.parent; while (isSel(x)) { if (isInstance(x, c.childId)) { r = true; break; } x = x.parent; } }
      // "the army's primary catalogue is X" (e.g. Medusa's Wrath only for Iron Hands armies)
      else if (c.scope === 'primary-catalogue') { const R = rosterOf(s); r = !!R && R.catalogueId === c.childId; }
      else r = isInstance(resolveScope(c.scope, s), c.childId);
      return t === 'instanceOf' ? r : !r;
    }
    if (t === 'before') {
      const ref = s._ref;
      if (!ref) return true;
      return order(s) < order(ref);
    }
    const v = countQuery(c, s, null);
    return compare(t, v, Number(c.value));
  }

  function order(s) {
    if (s.virtual) return Infinity;
    const r = rosterOf(s);
    if (r._ordGen !== GEN) {
      r._ordGen = GEN; let i = 0;
      const rec = (list) => list.forEach(x => { x._ord = i++; rec(x.children); });
      r.forces.forEach(f => rec(f.children));
    }
    return s._ord === undefined ? Infinity : s._ord;
  }

  function localGroupPass(g, s) {
    const scopeObj = resolveScope(g.scope, s);
    if (!scopeObj) return false;
    let cnt = 0;
    walkDesc(scopeObj, !!g.includeChildSelections, (x) => {
      // evaluate the group's conditions against candidate x, with 'before' relative to s
      const ok = (g.conditions || []).every(c => c.type === 'before' ? order(x) < order(s) : condPass(c, x));
      if (ok) cnt++;
    });
    return compare(g.type, cnt, Number(g.value));
  }

  function groupPass(g, s) {
    const parts = [];
    (g.conditions || []).forEach(c => parts.push(() => condPass(c, s)));
    (g.conditionGroups || []).forEach(cg => parts.push(() => groupPass(cg, s)));
    (g.localConditionGroups || []).forEach(lg => parts.push(() => localGroupPass(lg, s)));
    if (!parts.length) return true;
    return g.type === 'or' ? parts.some(f => f()) : parts.every(f => f());
  }

  function condsPass(obj, s) {
    if (obj.conditions && !obj.conditions.every(c => condPass(c, s))) return false;
    if (obj.conditionGroups && !obj.conditionGroups.every(g => groupPass(g, s))) return false;
    if (obj.localConditionGroups && !obj.localConditionGroups.every(g => localGroupPass(g, s))) return false;
    return true;
  }

  function repeatTimes(m, s) {
    if (!m.repeats || !m.repeats.length) return 1;
    let t = 0;
    for (const r of m.repeats) {
      const v = Number(r.value) || 1;
      const c = countQuery(r, s, null);
      t += (r.roundUp ? Math.ceil(c / v) : Math.floor(c / v)) * (Number(r.repeats) || 1);
    }
    return t;
  }

  function numOp(cur, m, times) {
    const v = Number(m.value);
    switch (m.type) {
      case 'set': return v;
      case 'increment': return cur + v * times;
      case 'decrement': return cur - v * times;
      case 'multiply': return cur * Math.pow(v, times);
      case 'divide': return v ? cur / Math.pow(v, times) : cur;
      case 'floor': return Number.isNaN(v) ? Math.floor(cur) : Math.max(cur, v);   // lower bound
      case 'ceil': return Number.isNaN(v) ? Math.ceil(cur) : Math.min(cur, v);     // upper bound
      case 'add': return cur + v * times;
      default: return cur;
    }
  }

  function applyMod(m, r, s) {
    if (m.affects && m.affects !== 'self') return;   // cross-entry effects not supported
    if (!condsPass(m, s)) return;
    const times = repeatTimes(m, s);
    if (times <= 0) return;
    const f = m.field;
    if (f === 'hidden') { if (m.type === 'set') r.hidden = (m.value === true || m.value === 'true'); return; }
    if (f === 'name') {
      const val = String(m.value);
      if (m.type === 'set') r.name = val;
      else if (m.type === 'append') { if (!(m.skipIfPresent && r.name.includes(m.skipIfPresent))) r.name = r.name + (m.join !== undefined ? m.join : ' ') + val; }
      else if (m.type === 'prepend') r.name = val + (m.join !== undefined ? m.join : ' ') + r.name;
      else if (m.type === 'replace' && m.arg !== undefined) r.name = r.name.split(m.arg).join(val);
      return;
    }
    if (f === 'category') {
      const id = m.value;
      if (m.type === 'add') r.cats.add(id);
      else if (m.type === 'remove') { r.cats.delete(id); if (r.primary === id) r.primary = null; }
      else if (m.type === 'set-primary') { r.cats.add(id); r.primary = id; }
      else if (m.type === 'unset-primary') { if (r.primary === id) r.primary = null; }
      return;
    }
    if (f === 'error' || f === 'warning' || f === 'info') { (f === 'error' ? r.errors : r.warnings).push(String(m.value)); return; }
    if (f === 'annotation') { r.annotations.push(String(m.value)); return; }
    if (f in r.costs) { r.costs[f] = numOp(r.costs[f], m, times); return; }
    if (f in r.cons) { r.cons[f] = numOp(r.cons[f], m, times); return; }
    if (r.catalog && r.catalog.costTypes.some(c => c.id === f)) { r.costs[f] = numOp(0, m, times); return; }
  }

  function applyMods(mods, groups, r, s) {
    (mods || []).forEach(m => applyMod(m, r, s));
    (groups || []).forEach(g => {
      if (!condsPass(g, s)) return;
      applyMods(g.modifiers, g.modifierGroups, r, s);
    });
  }

  function baseEval(node, catalog) {
    const r = { hidden: !!node.hidden, name: node.name || '', costs: {}, cons: {}, cats: new Set(), primary: null,
      errors: [], warnings: [], annotations: [], catalog };
    (node.costs || []).forEach(c => { r.costs[c.typeId] = Number(c.value) || 0; });
    (node.constraints || []).forEach(c => { r.cons[c.id] = Number(c.value); });
    (node.categoryLinks || []).forEach(c => { r.cats.add(c.targetId); if (c.primary) r.primary = c.targetId; });
    return r;
  }

  // Effective (modified) values of a selection / virtual selection / force.
  function ev(s) {
    if (s._evGen === GEN) return s._ev;
    const cat = rosterOf(s).catalog;
    if (s._busy) return baseEval(s.node, cat);
    s._busy = true;
    let r;
    try {
      r = baseEval(s.node, cat);
      // force-entry modifiers may also target category-link constraints
      if (s.isForce) (s.node.categoryLinks || []).forEach(cl => (cl.constraints || []).forEach(c => { if (!(c.id in r.cons)) r.cons[c.id] = Number(c.value); }));
      applyMods(s.node.modifiers, s.node.modifierGroups, r, s);
    } finally { s._busy = false; }
    s._ev = r; s._evGen = GEN;
    return r;
  }

  // Effective hidden/name/characteristics for profiles, rules, info links
  function evInfo(obj, s) {
    const r = { hidden: !!obj.hidden, name: obj.name || '', chars: {}, costs: {}, cons: {}, cats: new Set(), errors: [], warnings: [], annotations: [] };
    (obj.characteristics || []).forEach(c => { r.chars[c.typeId] = c.$text !== undefined ? String(c.$text) : ''; });
    const one = (m) => {
      if (m.affects) return;
      if (m.field === 'hidden' || m.field === 'name') { applyMod(m, r, s); return; }
      if (!(m.field in r.chars)) return;
      if (!condsPass(m, s)) return;
      const t = repeatTimes(m, s);
      if (t <= 0) return;
      r.chars[m.field] = textOp(r.chars[m.field], m, t, charName(obj, m.field));
    };
    const all = (mods, groups) => {
      (mods || []).forEach(one);
      (groups || []).forEach(g => { if (condsPass(g, s)) all(g.modifiers, g.modifierGroups); });
    };
    all(obj.modifiers, obj.modifierGroups);
    return r;
  }

  // ---------------------------------------------------------------- text maths for characteristics
  function charName(profile, typeId) {
    const c = (profile.characteristics || []).find(c => c.typeId === typeId);
    return c ? c.name : '';
  }
  const EMPTY = (x) => { const t = String(x === undefined || x === null ? '' : x).trim(); return t === '' || t === '-' || t === '–'; };
  // Change one number inside a text value ("3+", '6"', "D6+2", "-1").
  // Die sizes (the 6 in D6) are never changed: adding to "D6" gives "D6+1".
  function numericEdit(cur, pos, fn, additive) {
    cur = String(cur === undefined || cur === null ? '' : cur);
    const re = /-?\d+(?:\.\d+)?/g; const toks = []; let mm;
    while ((mm = re.exec(cur))) toks.push({ i: mm.index, s: mm[0] });
    if (!toks.length) return cur;
    let idx = pos === undefined || pos === null ? 0 : Number(pos);
    if (idx < 0) idx = toks.length + idx;
    idx = Math.max(0, Math.min(toks.length - 1, idx));
    let tk = toks[idx];
    const fmtN = (n) => Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
    // a "-" directly after a letter/digit is an operator, not a sign (e.g. "D6-1")
    if (tk.s[0] === '-' && tk.i > 0 && /[0-9A-Za-z]/.test(cur[tk.i - 1])) tk = { i: tk.i + 1, s: tk.s.slice(1) };
    const prev = cur[tk.i - 1];
    if (prev === 'D' || prev === 'd') {
      if (!additive) return cur;
      const d = fn(0);
      return d === 0 ? cur : cur.slice(0, tk.i + tk.s.length) + (d > 0 ? '+' + fmtN(d) : fmtN(d)) + cur.slice(tk.i + tk.s.length);
    }
    // a bonus term after dice, e.g. the "+2" / "-1" in "D6+2" / "D6-1": keep the operator correct
    if ((prev === '+' || prev === '-') && tk.i > 1 && /[0-9A-Za-z]/.test(cur[tk.i - 2])) {
      const n = fn(prev === '-' ? -Number(tk.s) : Number(tk.s));
      const term = n >= 0 ? '+' + fmtN(n) : fmtN(n);
      return cur.slice(0, tk.i - 1) + term + cur.slice(tk.i + tk.s.length);
    }
    const n = fn(Number(tk.s));
    return cur.slice(0, tk.i) + fmtN(n) + cur.slice(tk.i + tk.s.length);
  }
  function textOp(cur, m, times, cname) {
    cur = cur === undefined || cur === null ? '' : String(cur);
    const v = m.value, vs = (v === undefined || v === null || typeof v === 'boolean') ? '' : String(v);
    const isKw = /keyword/i.test(cname || '');
    switch (m.type) {
      case 'set': return vs;
      case 'append': {
        if (m.skipIfPresent && cur.includes(m.skipIfPresent)) return cur;
        if (isKw && cur.split(/,\s*|,\u00a0/).some(k => k.trim().toLowerCase() === vs.trim().toLowerCase())) return cur;
        if (EMPTY(cur) && !/^\+/.test(vs)) return vs;
        const join = m.join !== undefined ? m.join : (isKw ? ', ' : '');
        return cur + join + vs;
      }
      case 'prepend': return EMPTY(cur) ? vs : vs + (m.join !== undefined ? m.join : '') + cur;
      case 'increment': return numericEdit(cur, m.position, n => n + Number(v) * times, true);
      case 'decrement': return numericEdit(cur, m.position, n => n - Number(v) * times, true);
      case 'multiply': return numericEdit(cur, m.position, n => n * Number(v));
      case 'divide': return Number(v) ? numericEdit(cur, m.position, n => n / Number(v)) : cur;
      case 'floor': return numericEdit(cur, m.position, n => Math.max(n, Number(v)));
      case 'ceil': return numericEdit(cur, m.position, n => Math.min(n, Number(v)));
      case 'replace':
        if (m.arg !== undefined && m.arg !== null && m.arg !== '') return cur.split(String(m.arg)).join(vs);
        return EMPTY(cur) ? vs : cur;
      default: return cur;
    }
  }
  // tidy results: leftover "+0" in dice values, dangling keyword separators
  function tidyChar(val, cname) {
    let s2 = String(val === undefined || val === null ? '' : val);
    if (/^[0-9Dd+\-\s]+$/.test(s2)) s2 = s2.replace(/\+0(?![0-9])/g, '');
    if (/keyword/i.test(cname || '')) {
      s2 = s2.replace(/(?:[,\s\u00a0]*,[\s\u00a0]*)+/g, ', ').replace(/^[,\s\u00a0]+|[,\s\u00a0]+$/g, '');
      // (an empty keyword list stays empty)
    }
    return s2;
  }

  // ---------------------------------------------------------------- cross-entry effects ("affects" modifiers)
  // Upgrades, enhancements and abilities that change OTHER selections' profiles
  // (e.g. +1 Strength to the bearer's melee weapons, Lethal Hits for the whole attached unit).
  // These only change what is displayed (stats, keywords, extra rules) - never points or limits.
  const AFF_WORDS = new Set(['self', 'entries', 'recursive', 'group', 'associations', 'forces', 'rules', 'profiles']);
  function affectBase(scope, s) {
    const r = rosterOf(s);
    if (!scope || scope === 'self') return s;
    if (scope === 'parent') return s.parent;
    if (scope === 'roster' || scope === 'primary-catalogue') return r;
    if (scope === 'force') return s.force;
    if (scope === 'root-entry' || scope === 'root-entry-self') return rootSelOf(s) || s;
    const self = /-self$/.test(scope);
    const kind = scope.replace(/-self$/, '');
    const ok = (x) => kind === 'model-or-unit' ? (x.node.type === 'model' || x.node.type === 'unit') : x.node.type === kind;
    if (['model', 'unit', 'upgrade', 'model-or-unit'].includes(kind)) {
      if (self && isSel(s) && ok(s)) return s;
      let x = s.parent;
      while (isSel(x)) { if (ok(x)) return x; x = x.parent; }
      return isSel(s) && ok(s) ? s : null;
    }
    return resolveScope(scope, s);
  }
  function descendants(x, out) { (x.children || []).forEach(c => { out.add(c); descendants(c, out); }); return out; }
  function partnersOf(x) {
    const root = rootSelOf(x); if (!root) return [];
    const t = attachedTarget(root);
    return t ? [t].concat(attachedLeaders(t).filter(l => l !== root)) : attachedLeaders(root);
  }
  function profilesOn(x, cat) {
    const out = [];
    (x.node.profiles || []).forEach(p => out.push(p));
    (x.node.infoLinks || []).forEach(l => { if (l.type === 'profile') { const t = cat.get(l.targetId); if (t) out.push(t); } });
    const ig = (g) => { if (!g) return; (g.profiles || []).forEach(p => out.push(p)); (g.infoGroups || []).forEach(ig); (g.infoLinks || []).forEach(l => { if (l.type === 'profile') { const t = cat.get(l.targetId); if (t) out.push(t); } else if (l.type === 'infoGroup') ig(cat.get(l.targetId)); }); };
    (x.node.infoGroups || []).forEach(ig);
    (x.node.infoLinks || []).forEach(l => { if (l.type === 'infoGroup') ig(cat.get(l.targetId)); });
    return out;
  }
  function computeEffects(r) {
    if (r._effGen === GEN && r._eff) return r._eff;
    const eff = { prof: new Map(), cats: new Map(), info: new Map(), selAnn: new Map(), errors: [] };
    r._eff = eff; r._effGen = GEN;
    const cat = r.catalog;
    const all = [];
    const dfs = (list) => list.forEach(x => { all.push(x); dfs(x.children); });
    r.forces.forEach(f => dfs(f.children));
    const effCats = (x) => eff.cats.get(x);
    const matchEff = (x, id) => match(x, id) || (effCats(x) ? effCats(x).has(id) : false);
    const profState = (x, p) => {
      const key = x.uid + '|' + p.id;
      let st = eff.prof.get(key);
      if (!st) {
        const base = evInfo(p, x);
        st = { chars: Object.assign({}, base.chars), ann: [], names: {} };
        (p.characteristics || []).forEach(c => { st.names[c.typeId] = c.name; });
        eff.prof.set(key, st);
      }
      return st;
    };
    const typeNameOf = (p) => p.typeName || ((cat.profileTypes.get(p.typeId) || {}).name);
    for (const s of all) {
      const mods = [];
      const gather = (ms, gs) => {
        (ms || []).forEach(m => { if (m.affects && m.affects !== 'self') mods.push(m); });
        (gs || []).forEach(g => { if (condsPass(g, s)) gather(g.modifiers, g.modifierGroups); });
      };
      gather(s.node.modifiers, s.node.modifierGroups);
      for (const m of mods) {
        try { applyEffect(m, s); } catch (e) { if (global.console) console.warn('effect skipped', m, e); }
      }
    }
    function applyEffect(m, s) {
      if (!condsPass(m, s)) return;
      const times = repeatTimes(m, s);
      if (times <= 0) return;
      const base = affectBase(m.scope, s);
      if (!base) return;
      if (r._effLog) r._effLog.push({ owner: s, m, base });
      const tokens = String(m.affects).split('.');
      const pi = tokens.indexOf('profiles');
      const typeName = pi >= 0 ? tokens.slice(pi + 1).join('.') : null;
      const selToks = pi >= 0 ? tokens.slice(0, pi) : tokens;
      const has = (w) => selToks.includes(w);
      const ids = selToks.filter(t => !AFF_WORDS.has(t) && t);
      const R = new Set();
      const baseSel = isSel(base) ? base : null;
      const containerKids = (b) => b.isRoster ? b.children : (b.children || []);
      if (!has('self') && !has('entries') && !has('group') && !has('associations') && !has('forces')) {
        if (baseSel) R.add(baseSel);
        if (ids.length || has('recursive')) { if (baseSel) descendants(baseSel, R); else containerKids(base).forEach(c => { R.add(c); descendants(c, R); }); }
      } else {
        if (has('self') && baseSel) R.add(baseSel);
        if (has('entries')) containerKids(base).forEach(c => R.add(c));
        if (has('group') && baseSel) {
          const root = rootSelOf(baseSel);
          const tgt = attachedTarget(root) || root;
          [tgt].concat(attachedLeaders(tgt)).forEach(x => R.add(x));
        }
        if (has('associations') && baseSel) {
          partnersOf(baseSel).forEach(x => { R.add(x); if (has('entries')) x.children.forEach(c => R.add(c)); });
        }
        if (has('forces')) rosterOf(base).forces.forEach(f => f.children.forEach(x => R.add(x)));
        if (has('recursive')) [...R].forEach(x => descendants(x, R));
      }
      let targets = [...R];
      for (const id of ids) targets = targets.filter(x => matchEff(x, id));
      const field = m.field;
      if (typeName) {
        for (const x of targets) {
          for (const p of profilesOn(x, cat)) {
            if (typeNameOf(p) !== typeName) continue;
            const st = profState(x, p);
            if (field === 'annotation') {
              const v = String(m.value);
              if (m.type === 'set') st.ann = [v];
              else if (!(m.skipIfPresent && st.ann.join(' ').includes(m.skipIfPresent)) && !st.ann.includes(v)) st.ann.push(v);
            } else if (field in st.chars) {
              st.chars[field] = textOp(st.chars[field], m, times, st.names[field]);
            }
          }
        }
        return;
      }
      if (field === 'category') {
        for (const x of targets) {
          if (!eff.cats.has(x)) eff.cats.set(x, new Set());
          if (m.type === 'remove') eff.cats.get(x).delete(m.value); else eff.cats.get(x).add(m.value);
        }
      } else if (field === 'add-info') {
        for (const x of targets) { if (!eff.info.has(x)) eff.info.set(x, []); if (!eff.info.get(x).includes(m.value)) eff.info.get(x).push(m.value); }
      } else if (field === 'annotation') {
        for (const x of targets) { if (!eff.selAnn.has(x)) eff.selAnn.set(x, []); const a = eff.selAnn.get(x); if (m.type === 'set') a.splice(0, a.length, String(m.value)); else if (!a.includes(String(m.value))) a.push(String(m.value)); }
      } else if (field === 'error') {
        eff.errors.push({ msg: String(m.value), sel: s });
      }
    }
    return eff;
  }

  // ---------------------------------------------------------------- queries used by UI
  function constraintValue(node, s, type, scopes) {
    const e = ev(s);
    let best;
    for (const c of node.constraints) {
      if (c.type !== type) continue;
      if (c.field && c.field !== 'selections') continue;
      if (scopes && !scopes.includes(c.scope)) continue;
      const v = e.cons[c.id];
      if (v === undefined || v < 0) continue;
      best = best === undefined ? v : (type === 'max' ? Math.min(best, v) : Math.max(best, v));
    }
    return best;
  }

  function selsOf(parent, node) { return parent.children.filter(c => c.node === node || (c.node.id === node.id && c.node.key === node.key)); }
  function selsInGroup(parent, g) { return parent.children.filter(c => c.groups.includes(g)); }

  function totalCost(s, typeId) {
    // per-instance semantics: number * (own + children)
    let own = costOf(s, typeId);
    s.children.forEach(c => { own += totalCost(c, typeId); });
    return own * s.number;
  }
  function forceCost(f, typeId) { return f.children.reduce((a, c) => a + totalCost(c, typeId), 0); }
  function rosterCost(r, typeId) { return r.forces.reduce((a, f) => a + forceCost(f, typeId), 0); }

  // ---------------------------------------------------------------- mutations
  function addSel(parent, node, groups, number) {
    const s = new Sel(parent, node, groups, number);
    parent.children.push(s);
    bump();
    addDefaults(s);
    bump();
    return s;
  }

  function removeSel(s) {
    const p = s.parent;
    const i = p.children.indexOf(s);
    if (i >= 0) p.children.splice(i, 1);
    if (p.isForce) p.children.forEach(x => { if (x.attachedTo === s) { x.attachedTo = null; x.assocId = null; } });
    s.attachedTo = null;
    bump();
  }

  function addDefaults(P) {
    const cat = rosterOf(P).catalog;
    const walk = (options, groups) => {
      for (const opt of options) {
        const v = makeVirtual(P, opt, groups);
        if (ev(v).hidden) continue;
        if (opt.kind === 'group') {
          const min = constraintValue(opt, v, 'min', ['parent']) || 0;
          const existing = selsInGroup(P, opt).reduce((a, c) => a + c.number, 0);
          const kids = cat.children(opt);
          if (min > 0 && existing < min) {
            let def = kids.find(k => k.kind === 'entry' && (k.id === opt.defaultSelectionEntryId || k.key === opt.defaultSelectionEntryId));
            if (!def) def = kids.find(k => k.kind === 'entry' && !ev(makeVirtual(P, k, groups.concat([opt]))).hidden);
            if (def) {
              const dv = makeVirtual(P, def, groups.concat([opt]));
              const dmax = constraintValue(def, dv, 'max', ['parent']);
              let n = min - existing;
              if (dmax !== undefined) n = Math.min(n, dmax);
              if (n > 0) addSel(P, def, groups.concat([opt]), n);
            }
          }
          walk(kids, groups.concat([opt]));
        } else {
          const min = constraintValue(opt, v, 'min', ['parent']) || 0;
          const existing = selsOf(P, opt).reduce((a, c) => a + c.number, 0);
          if (min > 0 && existing < min) {
            const ex = selsOf(P, opt)[0];
            if (ex) { ex.number = min; bump(); }
            else addSel(P, opt, groups, min);
          }
        }
      }
    };
    walk(isSel(P) ? cat.children(P.node) : [], []);
  }

  function forceDefaults(force) {
    const cat = force.roster.catalog;
    for (const n of cat.rootNodes()) {
      const v = makeVirtual(force, n, []);
      if (ev(v).hidden) continue;
      // min constraints with scope roster / force / parent
      let min = 0;
      const e = ev(v);
      n.constraints.forEach(c => { if (c.type === 'min' && (!c.field || c.field === 'selections') && ['roster', 'force', 'parent'].includes(c.scope)) min = Math.max(min, e.cons[c.id]); });
      if (min > 0 && selsOf(force, n).length === 0) {
        for (let i = 0; i < min; i++) addSel(force, n, [], 1);
      }
    }
  }

  // ---------------------------------------------------------------- validation
  // A catalogue category entry's constraint value after the entry's own modifiers
  // (e.g. "unit limit 2 in Incursion"), evaluated in the context of the force.
  function catLimit(ce, c, force) {
    if (!ce.modifiers && !ce.modifierGroups) return Number(c.value);
    const r = baseEval(ce, force.roster.catalog);
    applyMods(ce.modifiers, ce.modifierGroups, r, force);
    return r.cons[c.id] !== undefined ? r.cons[c.id] : Number(c.value);
  }

  // Detachment Points limit chosen by the player, used while "Override points limit?" is ticked
  function overrideActive(roster) {
    let on = false;
    const rec = (x) => { if (on) return; if (/^Override points limit/i.test(ev(x).name)) on = true; else x.children.forEach(rec); };
    roster.forces.forEach(f => f.children.forEach(rec));
    return on;
  }
  function limitOverride(roster, typeId) {
    if (roster.dpOverride === null || roster.dpOverride === undefined || isNaN(roster.dpOverride)) return null;
    const t = roster.catalog.costTypes.find(c => c.id === typeId);
    if (!t || t.name !== 'Detachment Points') return null;
    return overrideActive(roster) ? roster.dpOverride : null;
  }

  function validate(roster) {
    const errs = []; const seen = new Set();
    const push = (msg, s) => { const k = msg + '|' + (s ? s.uid : ''); if (seen.has(k)) return; seen.add(k); errs.push({ msg, sel: s }); };
    const cat = roster.catalog;
    const pts = cat.ptsType;
    const total = rosterCost(roster, pts);
    if (roster.costLimit > 0 && total > roster.costLimit) push(`Roster is ${total - roster.costLimit} pts over the ${roster.costLimit} pts limit`);

    for (const force of roster.forces) {
      const fe = ev(force);
      // category constraints from the force entry
      for (const cl of force.node.categoryLinks) {
        for (const c of (cl.constraints || [])) {
          const lim = fe.cons[c.id] !== undefined ? fe.cons[c.id] : Number(c.value);
          if (lim < 0) continue;
          const scopeObj = c.scope === 'roster' ? roster : force;
          let n = 0;
          walkDesc(scopeObj, !!c.includeChildSelections, (x, m) => { if (ev(x).cats.has(cl.targetId)) n += x.number * m; });
          if (c.type === 'min' && n < lim) push(`${force.node.name}: needs at least ${lim} ${cl.name} (has ${n})`);
          if (c.type === 'max' && n > lim) push(`${force.node.name}: max ${lim} ${cl.name} (has ${n})`);
        }
      }
      for (const c of force.node.constraints) {
        let lim = fe.cons[c.id]; if (lim === undefined || lim < 0) continue;
        if (c.field && c.field !== 'selections' && c.field !== 'forces') {
          // the points limit is already reported once as "Roster is N pts over the limit"
          if (c.field === pts && c.type === 'max' && roster.costLimit > 0) continue;
          const ov = c.type === 'max' ? limitOverride(roster, c.field) : null;
          if (ov !== null) lim = ov;
          const n = Math.round(forceCost(force, c.field) * 1000) / 1000;
          const tn = (cat.costTypes.find(t => t.id === c.field) || {}).name || c.field;
          if (c.type === 'max' && n > lim) push(`${force.node.name}: ${tn} ${Math.ceil(n)} exceeds limit of ${lim}`);
          if (c.type === 'min' && n < lim) push(`${force.node.name}: ${tn} ${n} below minimum of ${lim}`);
        }
      }
      // catalogue category entries with constraints (e.g. unique characters)
      for (const ce of cat.categories.values()) {
        if (!ce.constraints) continue;
        for (const c of ce.constraints) {
          if (c.field && c.field !== 'selections') continue;
          const lim = catLimit(ce, c, force); if (lim < 0) continue;
          const scopeObj = c.scope === 'roster' ? roster : force;
          let n = 0;
          walkDesc(scopeObj, !!c.includeChildSelections, (x, m) => { if (ev(x).cats.has(ce.id)) n += x.number * m; });
          if (c.type === 'max' && n > lim) push(`Max ${lim} × ${ce.name} (has ${n})`);
        }
      }
      // Muster Armies: one CHARACTER model must be chosen as your Warlord
      {
        const idsOf = (nm) => { const out = []; for (const c of cat.categories.values()) if (c.name === nm) out.push(c.id); return out; };
        const wids = idsOf('Warlord'), cids = idsOf('Character');
        if (wids.length && cids.length) {
          let warlords = 0, chars = 0;
          walkDesc(force, true, (x) => { const e = ev(x); if (wids.some(id => e.cats.has(id))) warlords++; });
          force.children.forEach(x => { const e = ev(x); if (cids.some(id => e.cats.has(id))) chars++; });
          if (chars && !warlords) push(`No Warlord selected – choose one of your Characters to be your Warlord`);
        }
      }
      checkOptions(force, cat.rootNodes(), [], push, cat);
      const rec = (s) => {
        const e = ev(s);
        e.errors.forEach(m => push(m, s));
        // self-scoped constraints (usually costs within the selection)
        for (const c of s.node.constraints) {
          if (c.scope !== 'self') continue;
          const lim = e.cons[c.id]; if (lim === undefined || lim < 0) continue;
          let n;
          if (c.field === 'associations') {
            n = countAssociations(c, s);
            const what = cat.catName(c.childId);
            if (c.type === 'max' && n > lim) push(`${e.name}: max ${lim} ${what} attached (has ${n})`, s);
            if (c.type === 'min' && n < lim) push(`${e.name}: needs ${lim} ${what} attached (has ${n})`, s);
            continue;
          }
          if (c.field && c.field !== 'selections') {
            n = c.includeChildSelections ? totalCost(s, c.field) / (s.number || 1) : costOf(s, c.field);
          } else continue;
          const tn = (cat.costTypes.find(t => t.id === c.field) || {}).name || c.field;
          if (c.type === 'max' && n > lim) push(`${e.name}: ${c.message || (tn + ' ' + n + ' exceeds ' + lim)}`, s);
          if (c.type === 'min' && n < lim) push(`${e.name}: ${c.message || (tn + ' ' + n + ' below ' + lim)}`, s);
        }
        checkOptions(s, cat.children(s.node), [], push, cat);
        s.children.forEach(rec);
      };
      force.children.forEach(rec);
      // attachments
      computeEffects(roster).errors.forEach(x => { if (x.sel.force === force) push(x.msg, x.sel); });
      for (const s of force.children) {
        const e = ev(s);
        const assocs = cat.assocs(s.node);
        if (!assocs.length) continue;
        const t = attachedTarget(s);
        if (t) {
          const a = assocs.find(x => x.id === s.assocId) || assocs[0];
          if (!canAttach(s, a, t)) push(`${e.name} can't be attached to ${ev(t).name}`, s);
        } else {
          const req = assocs.find(a => Number(a.min) > 0 && !ev(s).hidden);
          if (req) push(`${e.name} must be attached to a unit (${req.label || req.name})`, s);
        }
      }
    }
    return errs;
  }

  function checkOptions(P, options, groups, push, cat) {
    for (const opt of options) {
      const existing = opt.kind === 'group' ? selsInGroup(P, opt) : selsOf(P, opt);
      const ctxs = (opt.kind === 'entry' && existing.length) ? existing : [makeVirtual(P, opt, groups)];
      for (const ctx of ctxs) {
      const e = ev(ctx);
      if (e.hidden && !existing.length) { continue; }
      for (const c of opt.constraints) {
        if (ctx !== ctxs[0] && ['parent', 'force', 'roster'].includes(c.scope)) continue;
        if (c.scope === 'self') continue;
        const lim = e.cons[c.id]; if (lim === undefined || lim < 0) continue;
        const field = c.field || 'selections';
        if (field === 'associations') continue;
        let n;
        const defMatch = opt.kind === 'group' ? (x => x.groups.includes(opt) || groupIdSet(x).has(opt.id)) : (x => x.node.id === opt.id);
        if (c.scope === 'parent' && !c.childId) {
          n = 0;
          const list = opt.kind === 'group' ? existing : (c.includeChildSelections ? null : existing);
          if (list) list.forEach(x => { n += field === 'selections' ? x.number : costOf(x, field) * x.number; });
          else walkDesc(P, true, (x, m) => { if (defMatch(x)) n += field === 'selections' ? x.number * m : costOf(x, field) * x.number * m; });
        } else {
          const q = Object.assign({}, c, { field });
          n = countQuery(q, ctx, defMatch);
        }
        const where = c.scope === 'parent' ? '' : (c.scope === 'roster' ? ' per roster' : c.scope === 'force' ? ' per army' : '');
        const tn = field === 'selections' ? '' : ' ' + ((cat.costTypes.find(t => t.id === field) || {}).name || '');
        const owner = isSel(P) ? (ev(P).name + ': ') : '';
        if (c.type === 'max' && n > lim) push(c.message ? owner + ev(ctx).name + ': ' + c.message : `${owner}${e.name} – max ${lim}${tn}${where} (has ${n})`, isSel(P) ? P : (ctx.virtual ? existing[0] : ctx));
        if (c.type === 'min' && n < lim && !e.hidden) push(c.message ? owner + c.message : `${owner}${e.name} – needs at least ${lim}${tn}${where} (has ${n})`, isSel(P) ? P : null);
      }
      }
      if (opt.kind === 'group') checkOptions(P, cat.children(opt), groups.concat([opt]), push, cat);
    }
  }

  // ---------------------------------------------------------------- profiles / rules
  function collectInfo(s, recursive) {
    const cat = rosterOf(s).catalog;
    const profiles = [], rules = [], seenP = new Set(), seenR = new Set();
    const eff = isSel(s) ? computeEffects(rosterOf(s)) : null;
    const addProfile = (p, ctx, count) => {
      if (!p) return;
      const e = evInfo(p, ctx);
      if (e.hidden) return;
      let chars = e.chars, ann = [], changed = [];
      const st = eff && ctx && ctx.uid !== undefined ? eff.prof.get(ctx.uid + '|' + p.id) : null;
      if (st) {
        chars = {};
        for (const k of Object.keys(e.chars)) {
          const nm = (p.characteristics || []).find(c => c.typeId === k);
          chars[k] = tidyChar(st.chars[k], nm && nm.name);
          if (chars[k] !== e.chars[k]) changed.push(k);
        }
        ann = st.ann.slice();
      }
      const key = p.typeId + '|' + e.name + '|' + JSON.stringify(chars) + '|' + ann.join(',');
      if (seenP.has(key)) { const ex = profiles.find(x => x.key === key); if (ex) ex.count += count; return; }
      seenP.add(key);
      profiles.push({ key, typeId: p.typeId, typeName: p.typeName || (cat.profileTypes.get(p.typeId) || {}).name, name: e.name, chars, base: e.chars, count, ann, changed });
    };
    const addRule = (rl, ctx, overrideObj) => {
      if (!rl) return;
      const e = evInfo(overrideObj ? Object.assign({}, rl, { modifiers: (rl.modifiers || []).concat(overrideObj.modifiers || []), hidden: rl.hidden || overrideObj.hidden }) : rl, ctx);
      if (e.hidden) return;
      if (seenR.has(e.name)) return;
      seenR.add(e.name);
      rules.push({ name: e.name, description: rl.description || '' });
    };
    const addInfoGroup = (g, ctx) => {
      if (!g) return;
      if (evInfo(g, ctx).hidden) return;
      (g.profiles || []).forEach(p => addProfile(p, ctx, 1));
      (g.rules || []).forEach(r => addRule(r, ctx));
      (g.infoGroups || []).forEach(x => addInfoGroup(x, ctx));
      (g.infoLinks || []).forEach(l => addLink(l, ctx));
    };
    const addLink = (l, ctx, count) => {
      const t = cat.get(l.targetId);
      if (!t) return;
      if (evInfo(l, ctx).hidden) return;
      if (l.type === 'profile') addProfile(Object.assign({}, t, { modifiers: (t.modifiers || []).concat(l.modifiers || []) }), ctx, count || 1);
      else if (l.type === 'rule') addRule(t, ctx, l);
      else if (l.type === 'infoGroup') addInfoGroup(t, ctx);
    };
    const visit = (x, mult) => {
      const n = x.node;
      const cnt = mult * x.number;
      (n.profiles || []).forEach(p => addProfile(p, x, cnt));
      (n.rules || []).forEach(r => addRule(r, x));
      (n.infoGroups || []).forEach(g => addInfoGroup(g, x));
      (n.infoLinks || []).forEach(l => addLink(l, x, cnt));
      if (eff && eff.info.has(x)) eff.info.get(x).forEach(id => {
        const t = cat.get(id); if (!t) return;
        if (t.characteristics) addProfile(t, x, cnt);
        else if (t.description !== undefined) addRule(t, x);
        else addInfoGroup(t, x);
      });
      if (recursive) x.children.forEach(c => visit(c, cnt));
    };
    visit(s, 1 / (s.number || 1));
    return { profiles, rules };
  }

  // ---------------------------------------------------------------- (de)serialisation
  function serialize(roster) {
    const ser = (s) => {
      const o = { p: s.opath, n: s.number };
      if (s.customName) o.cn = s.customName;
      if (s.children.length) o.c = s.children.map(ser);
      return o;
    };
    return {
      format: 'offline-list-builder/1', id: roster.id, name: roster.name, costLimit: roster.costLimit, notes: roster.notes,
      dpOverride: roster.dpOverride,
      gameSystemId: roster.catalog.sys.id, catalogueId: roster.catalogueId, catalogueName: roster.catalog.cats[0].name,
      updated: new Date().toISOString(),
      forces: roster.forces.map(f => ({ forceEntryId: f.node.id, sels: f.children.map(s => {
        const o = ser(s); const t = attachedTarget(s);
        if (t) { o.at = f.children.indexOf(t); o.aid = s.assocId; }
        return o;
      }) })),
      totalPts: rosterCost(roster, roster.catalog.ptsType),
    };
  }

  function findOption(cat, options, path) {
    // path of keys: group keys..., entry key
    let opts = options, groups = [];
    for (let i = 0; i < path.length; i++) {
      const n = opts.find(o => o.key === path[i]) || opts.find(o => o.id === path[i]);
      if (!n) return null;
      if (i === path.length - 1) return { node: n, groups };
      groups = groups.concat([n]);
      opts = cat.children(n);
    }
    return null;
  }

  function deserialize(catalog, data) {
    const roster = new Roster(catalog, { id: data.id, name: data.name, costLimit: data.costLimit, notes: data.notes, dpOverride: data.dpOverride });
    const missing = [];
    for (const fd of data.forces || []) {
      const fe = catalog.forceEntries().find(f => f.id === fd.forceEntryId) || catalog.forceEntries()[0];
      const force = new Force(roster, fe);
      roster.forces.push(force);
      const build = (parent, list, options) => {
        for (const o of list || []) {
          const found = findOption(catalog, options, o.p);
          if (!found) { missing.push(o.p.join('/')); continue; }
          const s = new Sel(parent, found.node, found.groups, o.n);
          if (o.cn) s.customName = o.cn;
          parent.children.push(s);
          build(s, o.c, catalog.children(found.node));
        }
      };
      build(force, fd.sels, catalog.rootNodes());
      // restore attachments (indexes refer to the saved list; map through built sels)
      const builtIdx = []; let bi = 0;
      (fd.sels || []).forEach((o, i) => { if (findOption(catalog, catalog.rootNodes(), o.p)) builtIdx[i] = bi++; });
      (fd.sels || []).forEach((o, i) => {
        if (o.at === undefined || builtIdx[i] === undefined || builtIdx[o.at] === undefined) return;
        const s = force.children[builtIdx[i]];
        s.attachedTo = force.children[builtIdx[o.at]]; s.assocId = o.aid || null;
      });
    }
    bump();
    return { roster, missing };
  }

  async function openCatalog(catId) {
    const m = Data.manifest;
    const sys = await Data.load(m.gameSystem.id);
    const infos = Data.closure(catId);
    const cats = [];
    for (const i of infos) cats.push(await Data.load(i.id));
    return new Catalog(sys, cats);
  }

  global.Engine = {
    Data, IDB, Catalog, Roster, Force, Sel, openCatalog,
    ev, evInfo, validate, limitOverride, overrideActive, computeEffects, textOp, tidyChar, numericEdit, attachOptions, attachedTarget, attachedLeaders, canAttach, collectInfo, addSel, removeSel, addDefaults, forceDefaults, makeVirtual,
    constraintValue, selsOf, selsInGroup, totalCost, forceCost, rosterCost, costOf, serialize, deserialize, bump,
    get GEN() { return GEN; },
  };
})(window);
