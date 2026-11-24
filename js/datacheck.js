/* Data checker for BSData JSON (used by the editor).
 * DataCheck.run(files) -> [{ sev: 'error'|'warning', code, msg, obj, file, key }]
 * files: [{ name, top, kind }]  (top = gameSystem/catalogue object)
 */
(function (global) {
  'use strict';
  const DEF = { selectionEntries: 'entry', sharedSelectionEntries: 'entry', selectionEntryGroups: 'group', sharedSelectionEntryGroups: 'group',
    profiles: 'profile', sharedProfiles: 'profile', rules: 'rule', sharedRules: 'rule', infoGroups: 'infoGroup', sharedInfoGroups: 'infoGroup',
    categoryEntries: 'category', forceEntries: 'force', sharedAssociations: 'association', costTypes: 'costType', profileTypes: 'profileType' };
  const LINKS = { entryLinks: 1, infoLinks: 1, categoryLinks: 1, catalogueLinks: 1, associationLinks: 1 };
  const SPECIAL_CHILD = new Set(['model', 'unit', 'upgrade', 'any', 'roster', 'force', 'self', 'parent']);
  const SCOPES = new Set(['self', 'parent', 'force', 'roster', 'root-entry', 'ancestor', 'unit', 'model', 'model-or-unit', 'upgrade', 'primary-catalogue', 'primary-category', 'unit-self']);
  const MOD_FIELDS = new Set(['hidden', 'name', 'category', 'annotation', 'error', 'warning', 'info', 'page', 'readme', 'description', 'defaultAmount', 'add-info', 'publicationId']);

  function run(files) {
    const issues = [];
    const parent = new Map();     // obj -> {parent, key, file}
    const defs = new Map();       // id -> [{obj, kind, file}]
    const allIds = new Set();
    const usedBy = new Map();     // targetId -> [link]
    const links = [];             // [{obj, key, file}]
    const owners = [];            // objects that may carry constraints/modifiers
    const profilesL = [];
    files.forEach(f => { allIds.add(f.top.id); parent.set(f.top, { parent: null, key: null, file: f }); });

    for (const f of files) {
      const walk = (obj) => {
        for (const k in obj) {
          const v = obj[k];
          if (!Array.isArray(v)) continue;
          for (const x of v) {
            if (!x || typeof x !== 'object') continue;
            parent.set(x, { parent: obj, key: k, file: f });
            if (x.id) allIds.add(x.id);
            if (DEF[k] && x.id) { if (!defs.has(x.id)) defs.set(x.id, []); defs.get(x.id).push({ obj: x, kind: DEF[k], file: f }); }
            if (LINKS[k]) { links.push({ obj: x, key: k, file: f }); if (x.targetId) { if (!usedBy.has(x.targetId)) usedBy.set(x.targetId, []); usedBy.get(x.targetId).push(x); } }
            if (x.constraints || x.modifiers || x.modifierGroups) owners.push(x);
            if (DEF[k] === 'profile') profilesL.push(x);
            walk(x);
          }
        }
      };
      walk(f.top);
    }
    const fileOf = (o) => (parent.get(o) || {}).file;
    const kindOf = (o) => { const p = parent.get(o); return p && p.key ? (DEF[p.key] || (LINKS[p.key] ? 'link' : p.key)) : 'file'; };
    const def = (id, kinds) => { const l = defs.get(id) || []; return (kinds ? l.find(d => kinds.includes(d.kind)) : l[0]) || null; };
    const nameOf = (o) => (o && (o.name || o.id)) || '?';
    const ownerName = (o) => { let x = o; while (x && !x.name) x = (parent.get(x) || {}).parent; return x ? x.name : '?'; };
    const ownerObj = (o) => { let x = o; while (x && !(x.id && x.name)) x = (parent.get(x) || {}).parent; return x || o; };
    const add = (sev, code, msg, obj, keyExtra) => {
      const own = ownerObj(obj);
      issues.push({ sev, code, msg, obj: own, file: fileOf(own) || fileOf(obj), key: code + '|' + (own && own.id || '') + '|' + (keyExtra || '') });
    };
    const catName = (id) => { const d = def(id, ['category']); return d ? d.obj.name : null; };

    // ---- 1. links
    const wantKind = (l, key) => {
      if (key === 'entryLinks') return l.type === 'selectionEntryGroup' ? ['group'] : ['entry'];
      if (key === 'infoLinks') return { profile: ['profile'], rule: ['rule'], infoGroup: ['infoGroup'] }[l.type] || ['profile', 'rule', 'infoGroup'];
      if (key === 'categoryLinks') return ['category'];
      if (key === 'associationLinks') return ['association'];
      return null;
    };
    for (const { obj: l, key } of links) {
      if (key === 'catalogueLinks') { if (!files.some(f => f.top.id === l.targetId)) add('error', 'link-missing', `Catalogue link “${l.name}” points to a file that isn't in the folder`, l, l.targetId); continue; }
      if (!l.targetId) { add('error', 'link-missing', `Link “${nameOf(l)}” has no target`, l, l.id); continue; }
      const kinds = wantKind(l, key);
      const any = defs.get(l.targetId);
      if (!any) { add('error', 'link-missing', `“${ownerName(parent.get(l).parent)}” has a ${key === 'categoryLinks' ? 'keyword/category' : 'link'} “${l.name || '?'}” pointing to something that no longer exists`, l, l.targetId); continue; }
      if (kinds && !any.some(d => kinds.includes(d.kind))) add('error', 'link-kind', `Link “${l.name}” points to a ${any[0].kind} but should point to a ${kinds.join('/')}`, l, l.targetId);
    }

    // ---- 2. duplicate ids
    for (const [id, list] of defs) {
      if (list.length < 2) continue;
      const kinds = new Set(list.map(d => d.kind));
      // same kind, defined in more than one place
      for (const k of kinds) {
        const same = list.filter(d => d.kind === k);
        if (same.length > 1) add('error', 'dup-id', `Id ${id} is used by ${same.length} different ${k}s (${same.map(d => '“' + d.obj.name + '” in ' + d.file.top.name).join(', ')})`, same[1].obj, id);
      }
    }

    // ---- 3. groups: default choice
    for (const [, list] of defs) for (const d of list) {
      if (d.kind !== 'group') continue;
      const g = d.obj, dflt = g.defaultSelectionEntryId;
      if (!dflt || dflt === 'none') continue;
      const kids = [];
      const gather = (x) => { kids.push(...(x.selectionEntries || []), ...(x.entryLinks || [])); (x.selectionEntryGroups || []).forEach(gather); };
      gather(g);
      if (!kids.some(k => k.id === dflt || k.targetId === dflt)) add('warning', 'group-default', `Group “${g.name}” has a default choice that isn't one of its options`, g, dflt);
    }

    // ---- 4. constraints / modifiers / conditions references
    const checkCond = (c, owner, where) => {
      if (c.childId && !SPECIAL_CHILD.has(c.childId) && !allIds.has(c.childId)) add('warning', 'cond-child', `${where} on “${ownerName(owner)}” refers to something that doesn't exist (${c.childName || c.childId})`, owner, c.childId);
      if (c.scope && !SCOPES.has(c.scope) && !allIds.has(c.scope)) add('warning', 'cond-scope', `${where} on “${ownerName(owner)}” uses a scope that doesn't exist (${c.scope})`, owner, c.scope);
      if (c.field && c.field !== 'selections' && c.field !== 'forces' && c.field !== 'associations' && !allIds.has(c.field)) add('warning', 'cond-field', `${where} on “${ownerName(owner)}” counts an unknown cost type (${c.field})`, owner, c.field);
      if (c.value !== undefined && Number.isNaN(Number(c.value))) add('warning', 'cond-value', `${where} on “${ownerName(owner)}” has a non-number value (${c.value})`, owner, String(c.value));
    };
    const walkGroups = (gs, owner, where) => (gs || []).forEach(g => {
      (g.conditions || []).forEach(c => checkCond(c, owner, where));
      walkGroups(g.conditionGroups, owner, where);
      (g.localConditionGroups || []).forEach(lg => (lg.conditions || []).forEach(c => checkCond(c, owner, where)));
    });
    const checkMods = (mods, owner) => (mods || []).forEach(m => {
      if (m.field && !MOD_FIELDS.has(m.field) && !allIds.has(m.field)) add('warning', 'mod-field', `A modifier on “${ownerName(owner)}” changes something that doesn't exist (${m.field})`, owner, m.field);
      if (m.field === 'category' && m.value && !def(m.value, ['category'])) add('warning', 'mod-cat', `A modifier on “${ownerName(owner)}” uses a keyword/category that doesn't exist (${m.value})`, owner, m.value);
      if (['increment', 'decrement', 'multiply', 'divide'].includes(m.type) && Number.isNaN(Number(m.value))) add('warning', 'mod-value', `A modifier on “${ownerName(owner)}” does maths with a non-number (${m.value})`, owner, String(m.value));
      (m.conditions || []).forEach(c => checkCond(c, owner, 'A modifier condition'));
      walkGroups(m.conditionGroups, owner, 'A modifier condition');
      (m.repeats || []).forEach(r => checkCond(r, owner, 'A modifier repeat'));
    });
    for (const o of owners) {
      (o.constraints || []).forEach(c => {
        if (c.value === undefined || c.value === '' || Number.isNaN(Number(c.value))) add('warning', 'con-value', `A limit on “${ownerName(o)}” has no number`, o, c.id);
        if (c.childId) checkCond(c, o, 'A limit');
        else if (c.scope && !SCOPES.has(c.scope) && !allIds.has(c.scope)) add('warning', 'cond-scope', `A limit on “${ownerName(o)}” uses a scope that doesn't exist`, o, c.scope);
      });
      const cons = o.constraints || [];
      for (const mn of cons.filter(c => c.type === 'min')) {
        const mx = cons.find(c => c.type === 'max' && c.scope === mn.scope && c.field === mn.field && c.childId === mn.childId && c.value >= 0);
        if (mx && mn.value > mx.value) add('warning', 'con-minmax', `“${ownerName(o)}” has a minimum (${mn.value}) bigger than its maximum (${mx.value})`, o, mn.id);
      }
      checkMods(o.modifiers, o);
      const mg = (gs) => (gs || []).forEach(g => { (g.conditions || []).forEach(c => checkCond(c, o, 'A modifier-group condition')); walkGroups(g.conditionGroups, o, 'A modifier-group condition'); checkMods(g.modifiers, o); mg(g.modifierGroups); });
      mg(o.modifierGroups);
    }

    // ---- 5. names / profiles
    for (const [, list] of defs) for (const d of list) {
      if (['entry', 'group', 'profile', 'rule', 'category'].includes(d.kind) && !String(d.obj.name || '').trim()) add('warning', 'no-name', `A ${d.kind} has no name`, (parent.get(d.obj) || {}).parent || d.obj, d.obj.id);
    }
    for (const p of profilesL) {
      if (p.typeId && !def(p.typeId, ['profileType'])) add('error', 'profile-type', `Profile “${p.name}” has a profile type that doesn't exist`, p, p.id);
      const ch = p.characteristics || [];
      if (!ch.length || ch.every(c => !String(c.$text || '').trim())) add('warning', 'profile-empty', `Profile “${p.name}” has no values filled in`, p, p.id);
    }

    // ---- 6. unit checks (root entries of every faction file)
    const subtree = (e, fn, depth, seen) => {
      if (!e || depth > 8) return;
      seen = seen || new Set(); if (seen.has(e)) return; seen.add(e);
      fn(e);
      (e.selectionEntries || []).forEach(x => subtree(x, fn, depth + 1, seen));
      (e.selectionEntryGroups || []).forEach(x => subtree(x, fn, depth + 1, seen));
      (e.entryLinks || []).forEach(l => { fn(l); const t = def(l.targetId, ['entry', 'group']); if (t) subtree(t.obj, fn, depth + 1, seen); });
    };
    const roots = [];
    for (const f of files) {
      if (f.kind !== 'catalogue' || f.top.library) continue;
      (f.top.entryLinks || []).forEach(l => { const t = def(l.targetId, ['entry']); if (t && (t.obj.type === 'unit' || t.obj.type === 'model')) roots.push({ link: l, t: t.obj, fac: f }); });
      (f.top.selectionEntries || []).forEach(e => { if (e.type === 'unit' || e.type === 'model') roots.push({ link: null, t: e, fac: f }); });
    }
    const rootTargets = new Set(roots.map(r => r.t));
    const unitNames = new Map(); roots.forEach(r => unitNames.set(r.t.name.toLowerCase(), r.t));
    const pts = (files.find(f => f.kind === 'gameSystem') || { top: {} }).top.costTypes || [];
    const ptsId = (pts.find(c => c.name === 'pts') || {}).id;
    const checked = new Set();
    const byFacName = new Map();
    for (const r of roots) {
      const { link, t, fac } = r;
      const k2 = fac.top.id + '|' + t.name.toLowerCase();
      if (byFacName.has(k2) && byFacName.get(k2) !== t) add('warning', 'dup-name', `${fac.top.name} has two different units called “${t.name}”`, link || t, k2);
      byFacName.set(k2, t);
      if (checked.has(t)) continue; checked.add(t);
      const cats = [].concat(t.categoryLinks || [], link ? link.categoryLinks || [] : []);
      const catNames = cats.map(c => catName(c.targetId)).filter(Boolean);
      const where = `“${t.name}”`;
      if (ptsId && !(t.costs || []).some(c => c.typeId === ptsId) && !(link && (link.costs || []).some(c => c.typeId === ptsId))) add('warning', 'unit-pts', `${where} has no points value`, t, 'pts');
      if (!cats.some(c => c.primary) && !((t.modifiers || []).some(m => m.type === 'set-primary'))) add('warning', 'unit-primary', `${where} has no primary category, so it won't sort into an army list section (Character, Battleline…)`, t, 'primary');
      if (!catNames.some(n => /^Faction:/i.test(n))) add('warning', 'unit-faction', `${where} has no “Faction: …” keyword`, t, 'faction');
      let hasUnitProfile = false, hasModel = t.type === 'model';
      subtree(t, (x) => {
        if ((x.profiles || []).some(p => p.typeName === 'Unit')) hasUnitProfile = true;
        (x.infoLinks || []).forEach(il => { const p = def(il.targetId, ['profile']); if (p && p.obj.typeName === 'Unit') hasUnitProfile = true; });
        if (x.type === 'model') hasModel = true;
        if (x.targetId) { const tt = def(x.targetId, ['entry']); if (tt && tt.obj.type === 'model') hasModel = true; }
      }, 0);
      if (!hasUnitProfile) add('warning', 'unit-profile', `${where} has no Unit stat profile (M, T, Sv…)`, t, 'profile');
      if (!hasModel) add('warning', 'unit-models', `${where} is a unit with no models in it`, t, 'models');
      const isLeader = catNames.some(n => /^Leader$/i.test(n));
      const assocs = (t.associations || []).filter(a => a.action === 'group');
      if (isLeader && !assocs.length && !(t.associationLinks || []).length) add('warning', 'leader-none', `${where} has the Leader keyword but no “Can lead” list, so it can't be attached to anything`, t, 'leader');
      assocs.forEach(a => {
        let n = 0; const cnt = (g) => { (g.conditions || []).forEach(c => { if (c.type === 'instanceOf') n++; }); (g.conditionGroups || []).forEach(cnt); };
        cnt(a);
        if (!n) add('error', 'leader-empty', `${where}'s “${a.label || a.name}” list has no units it can attach to`, t, a.id);
      });
      const own = catNames.some(n => n.toLowerCase() === t.name.toLowerCase());
      const other = catNames.find(n => n.toLowerCase() !== t.name.toLowerCase() && unitNames.has(n.toLowerCase()) && unitNames.get(n.toLowerCase()) !== t);
      if (!own && other) add('warning', 'unit-keyword', `${where} uses another unit's keyword (“${other}”) – Leaders that can join ${other} will also be able to join this unit`, t, other);
    }
    // unit entries not used anywhere
    for (const [, list] of defs) for (const d of list) {
      const e = d.obj;
      if (d.kind !== 'entry' || !(e.type === 'unit') || rootTargets.has(e)) continue;
      const p = parent.get(e);
      if (!p || p.key !== 'sharedSelectionEntries') continue;
      if (!(usedBy.get(e.id) || []).length) add('warning', 'unit-orphan', `Unit “${e.name}” isn't added to any faction's unit list, so it won't appear in the list builder`, e, 'orphan');
    }
    return issues;
  }

  global.DataCheck = { run };
})(typeof window !== 'undefined' ? window : globalThis);
