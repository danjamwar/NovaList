/* List import / export formats for the Offline List Builder.
 *  Export: GW app text, WTC (New Recruit "+++" compact)
 *  Import: BattleScribe / New Recruit roster files (.ros / .rosz), pasted list text (GW app, WTC, this app)
 */
(function (global) {
  'use strict';
  const E = global.Engine;

  // ------------------------------------------------------------------ shared helpers
  const lastSeg = (n) => { const p = String(n || '').split(' - '); return p[p.length - 1]; };
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[’'`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  function catNames(s, cat) { return [...E.ev(s).cats].map(id => cat.catName(id)); }
  function primaryName(s, cat) { const p = E.ev(s).primary; return p ? cat.catName(p) : ''; }
  function isConfig(s, cat) { return primaryName(s, cat) === 'Configuration'; }
  function pts(s, cat) { return E.totalCost(s, cat.ptsType); }
  function isEnh(sel) { return (sel.groups || []).some(g => /enhancement/i.test(g.name || '')); }
  function name(s) { return E.ev(s).name; }
  function rootUnits(r) { const cat = r.catalog; const out = []; r.forces.forEach(f => f.children.forEach(s => { if (!isConfig(s, cat)) out.push(s); })); return out; }
  function configSels(r) { const cat = r.catalog; const out = []; r.forces.forEach(f => f.children.forEach(s => { if (isConfig(s, cat)) out.push(s); })); return out; }
  function detachments(r) { const d = configSels(r).find(s => /^Detachment$/i.test(name(s))); return d ? d.children.map(name) : []; }
  function battleSize(r) {
    const b = configSels(r).find(s => /Battle Size|Mission Ruleset/i.test(name(s)));
    if (!b || !b.children.length) return null;
    const n = name(b.children[0]);
    const m = /^(?:\d+\.\s*)?(.+?)\s*\((\d+)\s*Point/i.exec(n);
    return m ? { label: m[1].trim(), pts: Number(m[2]) } : { label: n.replace(/^\d+\.\s*/, ''), pts: r.costLimit };
  }

  // wargear of a selection, flattened to leaf items: [{name, count, kind}]
  function wargear(sel, mult) {
    const out = [];
    for (const c of sel.children) {
      if (c.node.type === 'model') continue;
      const n = c.number * mult;
      if (/^Warlord$/i.test(name(c))) { out.push({ kind: 'warlord', name: 'Warlord', count: 1 }); continue; }
      if (isEnh(c)) { out.push({ kind: 'enh', name: name(c), count: 1, pts: E.costOf(c, sel.force.roster.catalog.ptsType) }); continue; }
      if (c.children.length) { out.push(...wargear(c, n)); continue; }
      out.push({ kind: 'item', name: name(c), count: n });
    }
    // merge duplicates
    const m = new Map();
    out.forEach(i => { const k = i.kind + '|' + i.name; if (m.has(k)) m.get(k).count += i.count; else m.set(k, Object.assign({}, i)); });
    return [...m.values()];
  }
  // models inside a unit: [{name, count, items}]
  function models(unit) {
    const out = [];
    const rec = (s, mult) => s.children.forEach(c => {
      if (c.node.type === 'model') out.push({ sel: c, name: name(c), count: c.number * mult, items: wargear(c, c.number * mult) });
      else if (c.children.some(x => x.node.type === 'model')) rec(c, c.number * mult);
    });
    rec(unit, 1);
    return out;
  }
  function modelCount(unit) {
    if (unit.node.type === 'model') return unit.number;
    const ms = models(unit);
    return ms.length ? ms.reduce((a, m) => a + m.count, 0) : 1;
  }
  function gwSection(s, cat) {
    const p = primaryName(s, cat), all = catNames(s, cat);
    if (/^Allies/i.test(p)) return 'ALLIED UNITS';
    if (p === 'Epic Hero' || p === 'Character' || all.includes('Character') || all.includes('Epic Hero')) return 'CHARACTERS';
    if (p === 'Battleline') return 'BATTLELINE';
    if (p === 'Dedicated Transport') return 'DEDICATED TRANSPORTS';
    return 'OTHER DATASHEETS';
  }
  const SECTION_ORDER = ['CHARACTERS', 'BATTLELINE', 'DEDICATED TRANSPORTS', 'OTHER DATASHEETS', 'ALLIED UNITS'];
  const nn = (n) => n.toLocaleString('en-US');

  // ------------------------------------------------------------------ EXPORT: GW app
  function exportGW(r) {
    const cat = r.catalog;
    const total = E.rosterCost(r, cat.ptsType);
    const L = [];
    L.push(`${r.name} (${nn(total)} Points)`, '');
    L.push(lastSeg(cat.cats[0].name));
    detachments(r).forEach(d => L.push(d));
    const bs = battleSize(r);
    if (bs) L.push(`${bs.label} (${nn(bs.pts)} Points)`);
    const units = rootUnits(r);
    for (const sec of SECTION_ORDER) {
      const list = units.filter(s => gwSection(s, cat) === sec);
      if (!list.length) continue;
      L.push('', sec, '');
      for (const s of list) {
        L.push(`${s.customName || name(s)} (${nn(pts(s, cat))} Points)`);
        const own = wargear(s, s.number);
        own.filter(i => i.kind === 'warlord').forEach(() => L.push('  • Warlord'));
        const ms = s.node.type === 'model' ? [] : models(s);
        own.filter(i => i.kind === 'item').forEach(i => L.push(`  • ${i.count}x ${i.name}`));
        ms.forEach(m => {
          L.push(`  • ${m.count}x ${m.name}`);
          m.items.filter(i => i.kind === 'item').forEach(i => L.push(`     ◦ ${i.count}x ${i.name}`));
        });
        [...own, ...ms.flatMap(m => m.items)].filter(i => i.kind === 'enh').forEach(i => L.push(`  • Enhancement: ${i.name}`));
        L.push('');
      }
      L.pop();
    }
    L.push('', 'Exported with Offline List Builder');
    return L.join('\n');
  }

  // ------------------------------------------------------------------ EXPORT: WTC compact
  function exportWTC(r) {
    const cat = r.catalog;
    const FENCE = '+'.repeat(47);
    const units = rootUnits(r);
    const chars = units.filter(s => gwSection(s, cat) === 'CHARACTERS');
    const others = units.filter(s => gwSection(s, cat) !== 'CHARACTERS');
    const label = new Map(); chars.forEach((s, i) => label.set(s, `Char${i + 1}`));
    const allItems = (s) => { const own = wargear(s, s.number); const ms = s.node.type === 'model' ? [] : models(s); return { own, ms }; };
    const warlord = chars.find(s => allItems(s).own.some(i => i.kind === 'warlord'));
    const enhLines = [];
    units.forEach(s => { const { own, ms } = allItems(s); [...own, ...ms.flatMap(m => m.items)].filter(i => i.kind === 'enh').forEach(i => enhLines.push(`${i.name} (on ${label.has(s) ? label.get(s) + ': ' : ''}${name(s)})`)); });
    const L = [FENCE];
    L.push(`+ LIST NAME: ${r.name}`);
    L.push(`+ FACTION KEYWORD: ${cat.cats[0].name}`);
    L.push(`+ DETACHMENT: ${detachments(r).join(', ') || '—'}`);
    L.push(`+ TOTAL ARMY POINTS: ${E.rosterCost(r, cat.ptsType)}pts`);
    L.push(`+ POINTS LIMIT: ${r.costLimit}pts`);
    L.push('+');
    L.push(`+ WARLORD: ${warlord ? label.get(warlord) + ': ' + name(warlord) : '—'}`);
    if (enhLines.length) enhLines.forEach(e => L.push(`+ ENHANCEMENT: ${e}`)); else L.push('+ ENHANCEMENT: —');
    L.push(`+ NUMBER OF UNITS: ${units.length}`);
    L.push(FENCE, '');
    const line = (s) => {
      const { own, ms } = allItems(s);
      const parts = [];
      if (own.some(i => i.kind === 'warlord')) parts.push('Warlord');
      own.filter(i => i.kind === 'item').forEach(i => parts.push(i.count > 1 ? `${i.count}x ${i.name}` : i.name));
      ms.forEach(m => { const it = m.items.filter(i => i.kind === 'item').map(i => (i.count > m.count ? `${i.count / m.count}x ` : '') + i.name); parts.push(`${m.count} with ${it.join(', ') || m.name}`); });
      const out = [`${label.has(s) ? label.get(s) + ': ' : ''}${modelCount(s)}x ${s.customName || name(s)} (${pts(s, cat)} pts): ${parts.join(', ')}`];
      [...own, ...ms.flatMap(m => m.items)].filter(i => i.kind === 'enh').forEach(i => out.push(`Enhancement: ${i.name}${i.pts ? ` (+${i.pts} pts)` : ''}`));
      return out.join('\n');
    };
    chars.forEach(s => L.push(line(s)));
    if (chars.length) L.push('');
    others.forEach(s => L.push(line(s)));
    return L.join('\n') + '\n';
  }

  // ------------------------------------------------------------------ IMPORT helpers (shared)
  // all entry options below a parent (through groups): [{node, groups}]
  function optionsUnder(cat, P) {
    const out = [];
    const base = P.isForce ? cat.rootNodes() : cat.children(P.node);
    const walk = (opts, groups) => opts.forEach(o => { if (o.kind === 'group') walk(cat.children(o), groups.concat([o])); else out.push({ node: o, groups }); });
    walk(base, []);
    return out;
  }
  function bestMatch(cands, wanted, getName) {
    const w = norm(wanted);
    if (!w) return null;
    let c = cands.find(x => getName(x).toLowerCase() === String(wanted).toLowerCase().trim()); if (c) return c;
    c = cands.find(x => norm(getName(x)) === w); if (c) return c;
    // ignore trailing tags like [Legends]
    c = cands.find(x => norm(getName(x).replace(/\[[^\]]*\]/g, '')) === w); if (c) return c;
    // singular/plural
    c = cands.find(x => { const a = norm(getName(x)); return a + 's' === w || w + 's' === a; }); if (c) return c;
    // contained
    const cont = cands.filter(x => { const a = norm(getName(x)); return a.length > 3 && (a.includes(w) || w.includes(a)); });
    if (cont.length) return cont.sort((a, b) => Math.abs(norm(getName(a)).length - w.length) - Math.abs(norm(getName(b)).length - w.length))[0];
    return null;
  }
  // choose an option under P (radio groups replace the previous choice); n = count per parent instance
  function choose(cat, P, opt, n) {
    const ex = E.selsOf(P, opt.node);
    if (ex.length) { if (n && ex[0].number !== n) { ex[0].number = n; E.bump(); } return ex[0]; }
    const g = opt.groups[opt.groups.length - 1];
    if (g) {
      const gv = E.makeVirtual(P, g, opt.groups.slice(0, -1));
      const gmax = E.constraintValue(g, gv, 'max', ['parent']);
      if (gmax === 1) E.selsInGroup(P, g).forEach(x => E.removeSel(x));
    }
    return E.addSel(P, opt.node, opt.groups, n || 1);
  }
  function multiplier(P) { let m = 1, x = P; while (x && !x.isForce) { m *= x.number; x = x.parent; } return m; }

  // ------------------------------------------------------------------ IMPORT: BattleScribe / New Recruit roster (.ros / .rosz)
  async function unzipFirst(buf) {
    const dv = new DataView(buf); const u8 = new Uint8Array(buf);
    // find end of central directory
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('Not a valid .rosz (zip) file');
    const cdOff = dv.getUint32(eocd + 16, true), count = dv.getUint16(eocd + 10, true);
    let p = cdOff;
    for (let k = 0; k < count; k++) {
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const fname = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + elen + clen;
      if (!/\.ros$/i.test(fname) && count > 1) continue;
      const lnlen = dv.getUint16(lho + 26, true), lelen = dv.getUint16(lho + 28, true);
      const data = u8.subarray(lho + 30 + lnlen + lelen, lho + 30 + lnlen + lelen + csize);
      if (method === 0) return new TextDecoder().decode(data);
      if (method === 8) {
        if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot unzip .rosz files – export a .ros file instead, or use Chrome/Edge.');
        const ds = new DecompressionStream('deflate-raw');
        const stream = new Blob([data]).stream().pipeThrough(ds);
        return await new Response(stream).text();
      }
      throw new Error('Unsupported zip compression (' + method + ')');
    }
    throw new Error('No .ros roster found inside the .rosz file');
  }
  async function readRosFile(file) {
    const buf = await file.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 2));
    if (head[0] === 0x50 && head[1] === 0x4b) return unzipFirst(buf);
    return new TextDecoder().decode(buf);
  }
  function parseRos(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('The roster file is not valid XML');
    const root = doc.documentElement;
    if (!root || root.localName !== 'roster') throw new Error('Not a BattleScribe roster file');
    const kids = (el, tag) => [...el.children].filter(c => c.localName === tag);
    const one = (el, tag) => kids(el, tag)[0];
    const readSel = (el) => ({
      name: el.getAttribute('name') || '', entryId: el.getAttribute('entryId') || '', entryGroupId: el.getAttribute('entryGroupId') || '',
      number: Number(el.getAttribute('number') || 1), type: el.getAttribute('type') || '',
      customName: el.getAttribute('customName') || '',
      primaryCat: (() => { const c = one(el, 'categories'); const p = c && kids(c, 'category').find(x => x.getAttribute('primary') === 'true'); return p ? (p.getAttribute('entryId') || '').split('::').pop() : ''; })(),
      pts: (() => { const c = one(el, 'costs'); const p = c && kids(c, 'cost').find(x => x.getAttribute('name') === 'pts'); return p ? Number(p.getAttribute('value')) : null; })(),
      children: (() => { const s = one(el, 'selections'); return s ? kids(s, 'selection').map(readSel) : []; })(),
    });
    const forces = [];
    const readForce = (el) => {
      const s = one(el, 'selections');
      forces.push({ name: el.getAttribute('name'), entryId: el.getAttribute('entryId'), catalogueId: el.getAttribute('catalogueId'), catalogueName: el.getAttribute('catalogueName'), sels: s ? kids(s, 'selection').map(readSel) : [] });
      const fs = one(el, 'forces'); if (fs) kids(fs, 'force').forEach(readForce);
    };
    const fs = one(root, 'forces'); if (fs) kids(fs, 'force').forEach(readForce);
    const cl = one(root, 'costLimits');
    const lim = cl && kids(cl, 'costLimit').find(x => x.getAttribute('name') === 'pts');
    return { name: root.getAttribute('name') || 'Imported roster', gameSystemId: root.getAttribute('gameSystemId'), generatedBy: root.getAttribute('generatedBy') || '', costLimit: lim ? Number(lim.getAttribute('value')) : null, forces };
  }
  // build a Roster from a parsed .ros; catalog = opened Catalog for forces[0].catalogueId
  function buildFromRos(cat, ros) {
    const report = { unmatched: [], ptsDiff: [], notes: [] };
    const r = new E.Roster(cat, { name: ros.name, costLimit: ros.costLimit || 2000 });
    const fr = ros.forces[0];
    const fe = cat.forceEntries().find(f => f.id === fr.entryId) || cat.forceEntries().find(f => f.name === fr.name) || cat.forceEntries()[0];
    const force = new E.Force(r, fe); r.forces.push(force);
    if (ros.forces.length > 1) report.notes.push(`The file has ${ros.forces.length} forces – only the first (${fr.catalogueName || fr.name}) was imported.`);
    const segs = (id) => String(id || '').split('::').filter(Boolean);
    const add = (P, xs, path) => {
      // merge repeated identical entries (BattleScribe can list each model separately)
      for (const x of xs) {
        const opts = optionsUnder(cat, P);
        const ids = segs(x.entryId), gids = segs(x.entryGroupId);
        const last = ids[ids.length - 1];
        let cand = opts.filter(o => o.node.id === last || o.node.key === last);
        if (!cand.length) cand = opts.filter(o => ids.includes(o.node.id) || ids.includes(o.node.key));
        if (cand.length > 1) { const byLink = cand.filter(o => ids.includes(o.node.key)); if (byLink.length) cand = byLink; }
        if (cand.length > 1 && x.primaryCat) { const byCat = cand.filter(o => E.ev(E.makeVirtual(P, o.node, o.groups)).primary === x.primaryCat); if (byCat.length) cand = byCat; }
        if (cand.length > 1 && gids.length) { const g = cand.filter(o => o.groups.some(gr => gids.includes(gr.id) || gids.includes(gr.key))); if (g.length) cand = g; }
        if (cand.length > 1) { const nm = cand.filter(o => norm(o.node.name) === norm(x.name)); if (nm.length) cand = nm; }
        let opt = cand[0];
        if (!opt) { opt = bestMatch(opts, x.name, o => o.node.name); if (opt) report.notes.push(`Matched “${x.name}” by name (data ids differ)`); }
        if (!opt) { report.unmatched.push(path.concat([x.name]).join(' › ')); continue; }
        const per = Math.max(1, Math.round(x.number / multiplier(P)));
        const ex = E.selsOf(P, opt.node)[0];
        if (ex && !P.isForce) { ex.number += per; E.bump(); continue; }   // same model listed again: count it, its wargear is already there
        const s = new E.Sel(P, opt.node, opt.groups, per); P.children.push(s);
        if (x.customName) s.customName = x.customName;
        if (P.isForce && x.pts !== null) s._listed = x.pts;
        add(s, x.children, path.concat([x.name]));
      }
    };
    add(force, fr.sels, []);
    E.bump();
    const hadBattleSize = force.children.some(s => /Battle Size/i.test(name(s)));
    E.forceDefaults(force);    // add any required configuration the file didn't include
    E.bump();
    // the roster's points limit is what the player set: make the Battle Size agree with it
    if (ros.costLimit) {
      const bs = force.children.find(s => /Battle Size/i.test(name(s)));
      const cur = bs && bs.children.map(c => /\((\d+)\s*Point/i.exec(name(c))).find(Boolean);
      const override = bs && selTree(bs).find(x => /^Points limit$/i.test(name(x)));
      const now = override ? override.number : (cur ? Number(cur[1]) : null);
      if (now !== ros.costLimit) setBattleSize(cat, force, ros.costLimit);
    }
    force.children.forEach(s => { if (s._listed !== undefined && !isConfig(s, cat)) { const p = pts(s, cat); if (p !== s._listed) report.ptsDiff.push(`${name(s)}: file says ${s._listed} pts, this data gives ${p} pts`); } });
    return { roster: r, report };
  }

  // ------------------------------------------------------------------ IMPORT: pasted text
  function detectFaction(text, manifest) {
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const facs = manifest.catalogues.filter(c => !c.library);
    const fk = lines.map(l => /^\+?\s*FACTION KEYWORD:\s*(.+)$/i.exec(l)).find(Boolean);
    const probes = fk ? [fk[1]] : lines.slice(0, 8);
    for (const p of probes) {
      const c = facs.find(c => norm(c.name) === norm(p)) || facs.find(c => norm(lastSeg(c.name)) === norm(p));
      if (c) return c.id;
    }
    for (const p of probes) { const c = facs.find(c => norm(p).includes(norm(lastSeg(c.name)))); if (c) return c.id; }
    return null;
  }

  function parseText(text) {
    const out = { name: '', limit: null, battleSize: '', detachments: [], units: [] };
    const lines = text.replace(/\t/g, '  ').split(/\r?\n/);
    let cur = null, curModel = null;
    const unitRe = /^(?:Char\d+:\s*)?(?:(\d+)x\s+)?(.+?)\s*\(\s*([\d,]+)\s*(?:points?|pts)\s*\)\s*(?::\s*(.*))?$/i;
    let first = true;
    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      const t = line.trim();
      if (!t) continue;
      if (/^\++$/.test(t)) continue;
      let m;
      if ((m = /^\+\s*([A-Z ]+):\s*(.*)$/.exec(t))) {
        const k = m[1].trim(), v = m[2].trim();
        if (k === 'LIST NAME') out.name = v;
        else if (k === 'DETACHMENT' && v !== '—') out.detachments.push(...v.split(/\s*,\s*/));
        else if (k === 'POINTS LIMIT') out.limit = parseInt(v.replace(/\D/g, ''), 10) || null;
        continue;
      }
      if (/^\+/.test(t) || /^exported with/i.test(t)) continue;
      if (/^(CHARACTERS?|EPIC HERO(ES)?|BATTLELINE|DEDICATED TRANSPORTS?|OTHER DATASHEETS|ALLIED UNITS|INFANTRY|VEHICLES?|MONSTERS?)$/i.test(t)) { cur = null; out._section = t.toUpperCase(); continue; }
      if ((m = /^(Incursion|Strike Force|Onslaught|Combat Patrol)\s*\(\s*([\d,]+)\s*points?\s*\)$/i.exec(t))) { out.battleSize = m[1]; out.limit = Number(m[2].replace(/,/g, '')); continue; }
      const bullet = /^[•◦\-*·▪]\s*/.test(t) || /^\s{2,}/.test(line);
      if (!bullet && (m = unitRe.exec(t))) {
        if (first && !out.name && !m[4] && !/^Char\d+:/i.test(t) && !m[1]) {
          // the first "(... Points)" line in GW format is the roster title
          out.name = m[2]; first = false; continue;
        }
        first = false;
        cur = { name: m[2].trim(), models: m[1] ? Number(m[1]) : null, pts: Number(m[3].replace(/,/g, '')), items: [], modelLines: [], section: out._section || '' };
        curModel = null;
        out.units.push(cur);
        if (m[4]) parseWtcItems(m[4], cur);
        continue;
      }
      if (first && !bullet && !cur) { if (!out.name && !/:/.test(t)) { /* faction / detachment lines */ } }
      if (!cur) { if (!bullet) out.detachments.push(t); continue; }
      // bullets / item lines
      const level = /^\s*◦/.test(line) || /^\s{4,}\S/.test(line) ? 2 : 1;
      let item = t.replace(/^[•◦\-*·▪]\s*/, '');
      if ((m = /^Enhancements?:\s*(.+?)(?:\s*\(\+?\d+\s*(?:pts|points)\))?$/i.exec(item))) { cur.items.push({ kind: 'enh', name: m[1].trim() }); continue; }
      if (/^Warlord$/i.test(item)) { cur.items.push({ kind: 'warlord' }); continue; }
      m = /^(?:(\d+)x\s+)?(.+)$/.exec(item);
      const it = { kind: 'item', name: m[2].trim(), count: m[1] ? Number(m[1]) : 1 };
      if (level === 1) { curModel = { name: it.name, count: it.count, items: [] }; cur.modelLines.push(curModel); }
      else if (curModel) curModel.items.push(it);
      else cur.items.push(it);
    }
    return out;
  }
  function parseWtcItems(s, unit) {
    // "Warlord, Bolt pistol, 4 with Bolt rifle, Grenades, 1 with Plasma"
    const parts = s.split(/\s*,\s*/);
    let group = null;
    for (let p of parts) {
      let m;
      if ((m = /^(\d+)\s+with\s+(.+)$/i.exec(p))) { group = { name: null, count: Number(m[1]), items: [] }; unit.modelLines.push(group); p = m[2]; }
      if (/^Warlord$/i.test(p)) { unit.items.push({ kind: 'warlord' }); continue; }
      m = /^(?:(\d+)x\s+)?(.+)$/.exec(p);
      const it = { kind: 'item', name: m[2].trim(), count: m[1] ? Number(m[1]) : 1 };
      if (group) group.items.push(it); else unit.items.push(it);
    }
  }
  function lineToEnh(units) {
    // WTC: "Enhancement: X (+20 pts)" lines become units? handled in parseText via cur -> fine
    return units;
  }

  function buildFromText(cat, parsed, opts) {
    const report = { unmatched: [], ptsDiff: [], notes: [] };
    const r = new E.Roster(cat, { name: parsed.name || opts.name || 'Imported list', costLimit: parsed.limit || 2000 });
    const fe = cat.forceEntries().find(f => f.name === 'Army Roster') || cat.forceEntries()[0];
    const force = new E.Force(r, fe); r.forces.push(force);
    E.forceDefaults(force);
    // battle size
    setBattleSize(cat, force, parsed.limit, parsed.battleSize);
    // detachments
    const detSel = force.children.find(s => /^Detachment$/i.test(name(s)));
    if (detSel) {
      const dopts = optionsUnder(cat, detSel);
      const found = parsed.detachments.map(d => bestMatchExact(dopts, d)).filter(Boolean);
      if (found.length) { detSel.children.slice().forEach(c => E.removeSel(c)); found.forEach(o => { if (!E.selsOf(detSel, o.node).length) E.addSel(detSel, o.node, o.groups, 1); }); }
      else if (parsed.detachments.length) report.notes.push('Detachment not recognised – kept the default (' + detSel.children.map(name).join(', ') + '). Lines checked: ' + parsed.detachments.slice(0, 4).join(' / '));
    }
    E.bump();
    const roots = optionsUnder(cat, force).filter(o => !isConfigNode(cat, force, o));
    const auto = force.children.filter(s => !isConfig(s, cat));   // units the data adds automatically
    for (const u of parsed.units) {
      // several units can share a name (e.g. a faction unit and its allied version): use the section it was listed under
      const exact = roots.filter(o => norm(o.node.name) === norm(u.name));
      let opt = exact.length > 1 ? (exact.find(o => { const p = E.ev(E.makeVirtual(force, o.node, [])).primary; const allied = /^Allies/i.test(p ? cat.catName(p) : ''); return allied === /ALLIED/.test(u.section); }) || exact[0]) : null;
      if (!opt) opt = bestMatch(roots, u.name, o => o.node.name);
      if (!opt) {
        // small typos ("Doomsday Arc" -> "Doomsday Ark")
        const w = norm(u.name);
        let best = null, bd = 99;
        roots.forEach(o => { const d = lev(norm(o.node.name), w); if (d < bd) { bd = d; best = o; } });
        if (best && bd <= Math.max(1, Math.min(3, Math.floor(w.length / 6)))) { opt = best; report.notes.push(`“${u.name}” read as “${best.node.name}” (spelling)`); }
      }
      if (!opt) { report.unmatched.push(u.name + ' (unit)'); continue; }
      const ai = auto.findIndex(x => x.node === opt.node);
      const s = ai >= 0 ? auto.splice(ai, 1)[0] : E.addSel(force, opt.node, [], 1);
      E.bump();
      applyItems(cat, s, u, report);
      E.bump();
      const p = pts(s, cat);
      if (u.pts && p !== u.pts) report.ptsDiff.push(`${u.name}: list says ${u.pts} pts, this data gives ${p} pts`);
    }
    return { roster: r, report };
  }
  function bestMatchModel(cands, wanted) {
    const w = norm(wanted), nm = (x) => x.o.node.name;
    return cands.find(x => nm(x).toLowerCase() === String(wanted).toLowerCase().trim()) || cands.find(x => norm(nm(x)) === w)
      || cands.find(x => norm(nm(x).replace(/\[[^\]]*\]/g, '')) === w) || cands.find(x => { const a = norm(nm(x)); return a + 's' === w || w + 's' === a; }) || null;
  }
  // pick the Battle Size option for a points limit (or use the "override points limit" option)
  function setBattleSize(cat, force, limit, label) {
    const bsSel = force.children.find(s => /Battle Size/i.test(name(s)));
    if (!bsSel || (!limit && !label)) return;
    const opts = optionsUnder(cat, bsSel);
    const o = opts.find(o => limit && new RegExp('\\(' + limit + '\\s*Point', 'i').test(o.node.name)) || opts.find(o => label && norm(o.node.name).includes(norm(label)));
    if (o) { choose(cat, bsSel, o, 1); E.bump(); return; }
    if (!limit) return;
    const ov = opts.find(o => /override/i.test(o.node.name));
    if (!ov) return;
    const ovSel = choose(cat, bsSel, ov, 1); E.bump();
    const pl = optionsUnder(cat, ovSel).find(o => /points limit/i.test(o.node.name));
    if (pl) { const x = choose(cat, ovSel, pl, limit); x.number = limit; E.bump(); }
  }
  function lev(a, b) {
    if (a === b) return 0; if (!a.length) return b.length; if (!b.length) return a.length;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) { const cur = [i]; for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = cur; }
    return prev[b.length];
  }
  function bestMatchExact(cands, wanted) { const w = norm(wanted); return cands.find(c => norm(c.node.name) === w) || null; }
  function isConfigNode(cat, force, o) { const v = E.makeVirtual(force, o.node, []); const p = E.ev(v).primary; return p && cat.catName(p) === 'Configuration'; }

  // all selections in a unit (for searching where an item can go)
  function selTree(s) { const out = [s]; s.children.forEach(c => out.push(...selTree(c))); return out; }
  function bestMatchStrict(opts, wanted) {
    const w = norm(wanted);
    return opts.find(o => o.node.name === String(wanted).trim()) || opts.find(o => o.node.name.toLowerCase() === String(wanted).toLowerCase().trim()) || opts.find(o => norm(o.node.name) === w)
      || opts.find(o => norm(o.node.name.replace(/\[[^\]]*\]/g, '')) === w) || opts.find(o => { const a = norm(o.node.name); return a + 's' === w || w + 's' === a; }) || null;
  }
  // options (through groups) inside an option node, without selecting it
  function optionsInNode(cat, node) {
    const out = [];
    const walk = (opts, groups) => opts.forEach(o => { if (o.kind === 'group') walk(cat.children(o), groups.concat([o])); else out.push({ node: o, groups }); });
    walk(cat.children(node), []);
    return out;
  }
  // Find where an item / model can be selected inside a unit.
  //  pass 1: options of existing selections (exact names)
  //  pass 2: inside option "packages" that aren't selected yet (e.g. "5 models", "2 Lascannons and 2 Flamers") - selects the package
  //  pass 3: fuzzy names on existing selections
  function locate(cat, unit, itemName, want, prefer, listed, skip) {
    const kindOk = (o, P) => (want === 'model' ? o.node.type === 'model' : o.node.type !== 'model') && !(skip && P && E.selsOf(P, o.node).some(x => skip.has(x)));
    const own = prefer ? selTree(prefer) : [];
    const places = own.concat(selTree(unit).filter(x => !own.includes(x)));
    const visible = (P) => (o) => !E.ev(E.makeVirtual(P, o.node, o.groups)).hidden || E.selsOf(P, o.node).length;
    // would choosing this option replace something else the list asks for?
    const displaces = (P, o) => {
      if (!listed || E.selsOf(P, o.node).length) return false;
      const g = o.groups[o.groups.length - 1]; if (!g) return false;
      const gmax = E.constraintValue(g, E.makeVirtual(P, g, o.groups.slice(0, -1)), 'max', ['parent']);
      if (gmax !== 1) return false;
      return E.selsInGroup(P, g).some(x => x.node !== o.node && listed.has(norm(E.ev(x).name)));
    };
    const pass1 = [];
    for (const P of places) { const o = bestMatchStrict(optionsUnder(cat, P).filter(x => kindOk(x, P)).filter(visible(P)), itemName); if (o) pass1.push({ P, opt: o }); }
    for (const P of places) { const o = bestMatchStrict(optionsUnder(cat, P).filter(x => kindOk(x, P)), itemName); if (o && !pass1.some(h => h.P === P && h.opt.node === o.node)) pass1.push({ P, opt: o }); }
    const clean = pass1.find(h => !displaces(h.P, h.opt));
    if (clean) return clean;
    // packages that contain the item
    for (const P of places) {
      for (const c of optionsUnder(cat, P).filter(o => o.node.type !== 'model' && !E.selsOf(P, o.node).length)) {
        const inner = optionsInNode(cat, c.node);
        if (!inner.length) continue;
        const o = bestMatchStrict(inner.filter(x => kindOk(x, null)), itemName);
        if (!o) continue;
        if (E.ev(E.makeVirtual(P, c.node, c.groups)).hidden) continue;
        if (displaces(P, c)) continue;
        const C = choose(cat, P, c, 1); E.bump();
        return { P: C, opt: o };
      }
    }
    if (pass1.length) return pass1[0];
    // models renamed by their wargear ("Veteran w/ frag cannon"): match on the part before "w/"
    if (want === 'model') {
      const stem = (n) => norm(String(n).split(/\s+w\/\s+|\s+with\s+/i)[0]);
      const w = stem(itemName);
      for (const P of places) { const o = optionsUnder(cat, P).filter(x => kindOk(x, P)).find(x => stem(x.node.name) === w); if (o) return { P, opt: o }; }
    }
    if (want !== 'model') for (const P of places) { const o = bestMatch(optionsUnder(cat, P).filter(x => kindOk(x, P)), itemName, x => x.node.name); if (o) return { P, opt: o }; }
    return null;
  }
  function applyItems(cat, unit, u, report) {
    const listed = new Set();
    u.items.forEach(i => i.name && listed.add(norm(i.name)));
    u.modelLines.forEach(m => { if (m.name) listed.add(norm(m.name)); m.items.forEach(i => listed.add(norm(i.name))); });
    // 1) models
    const named = u.modelLines.filter(m => m.name);
    const used = new Set();
    // unit-size "packages" (e.g. "5 models" / "10 models"): pick the one matching the listed model count
    const total = named.length ? named.reduce((a, m) => a + m.count, 0) : (u.models || 0);
    if (total) {
      for (const P of selTree(unit)) {
        const pk = optionsUnder(cat, P).filter(o => o.node.type !== 'model' && optionsInNode(cat, o.node).some(i => i.node.type === 'model'));
        if (pk.length < 2) continue;
        const want = pk.find(o => { const m = /(\d+)\s*(?:models?|man|-man)?/i.exec(o.node.name); return m && Number(m[1]) === total && /model|man/i.test(o.node.name); });
        if (want && !E.selsOf(P, want.node).length && !E.ev(E.makeVirtual(P, want.node, want.groups)).hidden) { choose(cat, P, want, 1); E.bump(); }
      }
    }
    for (const ml of named) {
      // the same model listed again with different wargear ("1x Neophyte Hybrid w/ Heavy Weapon" twice):
      // it gets its own selection so each can carry its own weapons
      const again = [...used].find(x => norm(E.ev(x).name) === norm(ml.name));
      const other = again && locate(cat, unit, ml.name, 'model', null, null, used);
      if (again && !(other && norm(E.ev(E.makeVirtual(other.P, other.opt.node, other.opt.groups)).name) === norm(ml.name))) {
        const per = Math.max(1, Math.round(ml.count / multiplier(again.parent)));
        const ms = E.addSel(again.parent, again.node, again.groups, per); E.bump();
        used.add(ms); ml.sel = ms; continue;
      }
      const hit = locate(cat, unit, ml.name, 'model', null, null, used);
      if (!hit) {
        if (ml.items.length) { ml.unresolved = true; continue; }   // model named differently: matched by its wargear below
        // a top-level bullet that isn't a model: wargear on the unit
        u.items.push({ kind: 'item', name: ml.name, count: ml.count });
        continue;
      }
      const per = Math.max(1, Math.round(ml.count / multiplier(hit.P)));
      const ms = choose(cat, hit.P, hit.opt, per);
      if (ms.number !== per) { ms.number = per; }
      E.bump();
      used.add(ms); ml.sel = ms;
    }
    if (used.size) {
      // remove default models the list doesn't mention (same group / same container as a listed model)
      selTree(unit).filter(x => x.node.type === 'model' && x !== unit && !used.has(x) && !selTree(x).some(y => used.has(y))).forEach(x => {
        const g = x.groups[x.groups.length - 1];
        if ([...used].some(y => (g && y.groups.includes(g)) || y.parent === x.parent)) E.removeSel(x);
      });
      E.bump();
    }
    // WTC "N with ..." groups (no model names): work out which model type each group is
    const unnamed = u.modelLines.filter(m => !m.name || m.unresolved);
    if (unnamed.length) {
      const modelSels = () => selTree(unit).filter(x => x.node.type === 'model' && x !== unit);
      // all model options reachable in the unit (selected or not)
      const modelOpts = []; selTree(unit).forEach(P => optionsUnder(cat, P).filter(o => o.node.type === 'model' && !E.ev(E.makeVirtual(P, o.node, o.groups)).hidden).forEach(o => modelOpts.push({ P, o })));
      const score = (node, items) => { const inner = optionsInNode(cat, node); const deep = []; inner.forEach(i => { deep.push(i); if (i.node.type !== 'model') optionsInNode(cat, i.node).forEach(j => deep.push(j)); });
        return items.filter(it => bestMatchStrict(deep, it.name)).length; };
      const assigned = new Set();
      if (modelOpts.length) {
        // GW text lumps a unit's models together ("3x Wraith: 3x claws, 1x particle caster"):
        // split such a group across model types when some weapons are carried by fewer models
        const expanded = [];
        for (const g of unnamed) {
          const special = g.name ? g.items.filter(i => i.count < g.count) : [];
          if (!special.length || modelOpts.length < 2) { expanded.push(g); continue; }
          let left = g.count; const common = g.items.filter(i => i.count >= g.count);
          for (const sp of special) {
            const host = modelOpts.find(mo => score(mo.o.node, [sp]) && !expanded.some(e => e._node === mo.o.node));
            if (!host || sp.count > left) continue;
            expanded.push({ name: g.name, count: sp.count, items: [{ kind: 'item', name: sp.name, count: sp.count }].concat(common.map(c => Object.assign({}, c, { count: sp.count }))), _node: host.o.node, _pref: host });
            left -= sp.count;
          }
          if (left > 0) expanded.push({ name: g.name, count: left, items: common.map(c => Object.assign({}, c, { count: left })), _avoid: special.map(x => x.name) });
        }
        unnamed.length = 0; unnamed.push(...expanded);
        for (const g of unnamed) {
          let best = null, bestScore = -1;
          for (const mo of modelOpts) {
            if (g._pref && mo !== g._pref) continue;
            let sc = score(mo.o.node, g.items) * 10;
            // a model type already used can be used again (same model, different weapons) only on a wargear match
            if (assigned.has(mo.o.node)) { if (sc < 10) continue; sc -= 8; }
            if (g._avoid && score(mo.o.node, g._avoid.map(n => ({ name: n }))) ) sc -= 5;
            const ex = E.selsOf(mo.P, mo.o.node)[0];
            if (ex && ex.number * multiplier(mo.P) === g.count) sc += 3;
            if (ex) sc += 1;
            if (sc > bestScore) { bestScore = sc; best = mo; }
          }
          if (!best) { g.items.forEach(i => u.items.push(Object.assign({}, i, { perModelOf: g.count }))); continue; }
          if (g.name) report.notes.push(`“${g.name}” matched to the model “${best.o.node.name}” by its wargear`);
          const reuse = assigned.has(best.o.node);
          assigned.add(best.o.node);
          const per = Math.max(1, Math.round(g.count / multiplier(best.P)));
          const ms = reuse ? E.addSel(best.P, best.o.node, best.o.groups, per) : choose(cat, best.P, best.o, per); ms.number = per; E.bump();
          used.add(ms);
          for (const it of g.items) {
            const hit = locate(cat, unit, it.name, 'item', ms, listed);
            if (!hit) { report.unmatched.push(`${u.name} › ${it.name}`); continue; }
            const per = g.name ? Math.max(1, Math.round((it.count || 1) / multiplier(hit.P))) : Math.max(1, it.count || 1);
            choose(cat, hit.P, hit.opt, per); E.bump();
          }
        }
        // drop default models the list doesn't account for
        modelSels().filter(x => !used.has(x) && !selTree(x).some(y => used.has(y))).forEach(x => {
          const gx = x.groups[x.groups.length - 1];
          if ([...used].some(y => (gx && y.groups.includes(gx)) || y.parent === x.parent)) E.removeSel(x);
        });
        E.bump();
      } else unnamed.forEach(g => g.items.forEach(i => u.items.push(Object.assign({}, i, { perModelOf: g.count }))));
    }
    // model wargear
    for (const ml of named) {
      if (!ml.sel || ml.unresolved) continue;
      for (const it of ml.items) {
        const hit = locate(cat, unit, it.name, 'item', ml.sel, listed);
        if (!hit) { report.unmatched.push(`${u.name} › ${ml.name} › ${it.name}`); continue; }
        const per = Math.max(1, Math.round(it.count / multiplier(hit.P)));
        choose(cat, hit.P, hit.opt, per); E.bump();
      }
    }
    // 2) unit-level items, warlord, enhancements
    for (const it of u.items) {
      if (it.kind === 'warlord') {
        const hit = locate(cat, unit, 'Warlord', 'item');
        if (hit) choose(cat, hit.P, hit.opt, 1); else report.unmatched.push(`${u.name} › Warlord`);
        continue;
      }
      const hit = locate(cat, unit, it.name, 'item', null, listed);
      if (!hit) { report.unmatched.push(`${u.name} › ${it.kind === 'enh' ? 'Enhancement: ' : ''}${it.name}`); continue; }
      let per = 1;
      if (it.kind === 'item') per = Math.max(1, Math.round((it.perModelOf ? it.count * it.perModelOf : it.count) / multiplier(hit.P)));
      const sel = choose(cat, hit.P, hit.opt, per); E.bump();
      (it.nested || []).forEach(n => { const h2 = locate(cat, unit, n.name, 'item', sel); if (h2) { choose(cat, h2.P, h2.opt, Math.max(1, Math.round(n.count / multiplier(h2.P)))); E.bump(); } else report.unmatched.push(`${u.name} › ${it.name} › ${n.name}`); });
    }
  }

  global.ListIO = { exportGW, exportWTC, readRosFile, parseRos, buildFromRos, detectFaction, parseText, buildFromText, _norm: norm };
})(typeof window !== 'undefined' ? window : globalThis);
