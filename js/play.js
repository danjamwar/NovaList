/* Play mode – read-only army view with game trackers (wounds, CP/VP, round & phase, unit markers). */
(function () {
  'use strict';
  const E = window.Engine;
  const $ = (s, r) => (r || document).querySelector(s);
  let A = null;          // app API (set by app.js)
  let G = null;          // current game state
  let sel = null;        // selected card key
  let tab = 'unit';      // 'unit' | 'army'
  let history = [];      // undo snapshots
  const PHASES = ['Command', 'Movement', 'Shooting', 'Charge', 'Fight'];
  const TURN_MARKS = [['adv', 'Advanced'], ['fb', 'Fell Back'], ['shot', 'Shot'], ['chg', 'Charged'], ['fought', 'Fought']];
  const KEY = (id) => 'olb.game.' + id;

  // ------------------------------------------------------------------ roster helpers
  const roster = () => A.S().roster;
  const cat = () => A.S().catalog;
  const name = (s) => s.customName || E.ev(s).name;
  function units() {
    const r = roster(), out = [];
    r.forces.forEach(f => f.children.forEach((s, i) => { if (!A.isCfg(s)) out.push({ s, key: i + ':' + s.node.id }); }));
    return out;
  }
  // cards: attached characters are grouped with the unit they lead
  function cards() {
    const us = units();
    const byKey = new Map(us.map(u => [u.s, u]));
    const out = [];
    for (const u of us) {
      if (E.attachedTarget(u.s)) continue;
      const leaders = E.attachedLeaders(u.s).map(l => byKey.get(l)).filter(Boolean);
      out.push({ key: u.key, members: [u].concat(leaders) });
    }
    return out;
  }
  // model groups inside a unit (what can lose wounds)
  function modelGroups(u) {
    const s = u.s, out = [];
    const unitProfiles = E.collectInfo(s, true).profiles.filter(p => p.typeName === 'Unit');
    const wOf = (x) => {
      const own = E.collectInfo(x, false).profiles.find(p => p.typeName === 'Unit');
      const pick = own || unitProfiles.find(p => p.name === name(x)) || unitProfiles.find(p => name(x).startsWith(p.name)) || unitProfiles[0];
      if (!pick) return 1;
      const wk = Object.keys(pick.chars).find(k => /^W$/i.test(charName(pick, k)));
      const n = parseInt(wk ? pick.chars[wk] : '1', 10);
      return n > 0 ? n : 1;
    };
    const rec = (x, mult, path) => x.children.forEach((c, i) => {
      if (c.node.type === 'model') out.push({ key: path + i + ':' + c.node.id, name: E.ev(c).name, count: c.number * mult, w: wOf(c) });
      else if (c.children.some(y => y.node.type === 'model')) rec(c, c.number * mult, path + i + '.');
    });
    rec(s, 1, '');
    if (!out.length) out.push({ key: 'self', name: name(s), count: s.node.type === 'model' ? s.number : 1, w: wOf(s) });
    return out;
  }
  const charNames = new Map();
  function charName(p, typeId) {
    if (!charNames.has(typeId)) {
      const pt = cat().profileTypes.get(p.typeId);
      (pt && pt.characteristicTypes || []).forEach(c => charNames.set(c.id, c.name));
    }
    return charNames.get(typeId) || '';
  }
  function onceAbilities(u) {
    const info = E.collectInfo(u.s, true);
    const out = [];
    info.profiles.filter(p => !['Unit', 'Ranged Weapons', 'Melee Weapons', 'Transport'].includes(p.typeName))
      .forEach(p => { const t = Object.values(p.chars).join(' '); if (/once per (battle|game)/i.test(t)) out.push(p.name); });
    info.rules.forEach(r => { if (/once per (battle|game)/i.test(r.description || '')) out.push(r.name); });
    return [...new Set(out)];
  }

  // ------------------------------------------------------------------ state
  const LAST_ROUND = 5;   // a normal game ends at the end of battle round 5
  const lastRound = () => (G && G.lastRound) || LAST_ROUND;
  function blank() {
    return { v: 1, rosterId: roster().id, started: new Date().toISOString(), round: 1, phase: 0, turn: 'me', first: 'me', lastRound: LAST_ROUND, ended: false, showEnd: false,
      me: { cp: 0, pri: 0, sec: 0 }, opp: { cp: 0, pri: 0, sec: 0, name: 'Opponent' }, units: {} };
  }
  function load() {
    try { const t = localStorage.getItem(KEY(roster().id)); if (t) { const g = JSON.parse(t); if (g && g.v === 1) return g; } } catch (e) { /* ignore */ }
    return null;
  }
  function save() { try { localStorage.setItem(KEY(roster().id), JSON.stringify(G)); } catch (e) { /* ignore */ } }
  function change(fn) { history.push(JSON.stringify(G)); if (history.length > 80) history.shift(); fn(); save(); render(); }
  function U(key) { if (!G.units[key]) G.units[key] = { m: {}, marks: {}, once: {} }; return G.units[key]; }
  function mstate(key, mk) { const u = U(key); if (!u.m[mk]) u.m[mk] = { lost: 0, dmg: 0 }; return u.m[mk]; }

  function status(u) {
    const groups = modelGroups(u);
    let start = 0, alive = 0, wStart = 0, wNow = 0;
    groups.forEach(g => {
      const st = (G.units[u.key] && G.units[u.key].m[g.key]) || { lost: 0, dmg: 0 };
      start += g.count; const a = Math.max(0, g.count - st.lost); alive += a;
      wStart += g.count * g.w; wNow += a * g.w - (a ? st.dmg : 0);
    });
    const single = start === 1;
    const dead = alive === 0;
    // 11th edition: "at or below half-strength" (e.g. 5 of 10 models, or half its wounds for a single model)
    const half = !dead && (single ? wNow * 2 <= wStart : alive * 2 <= start);
    return { groups, start, alive, wStart, wNow, dead, half, single };
  }

  // ------------------------------------------------------------------ rendering
  function open() {
    A = A || window.AppAPI;
    if (!A) throw new Error('the list builder is not ready yet');
    if (!roster()) return;
    G = load() || blank();
    remCache = null; remExpanded.clear(); dmgCache.clear();
    initReserves();
    history = []; sel = null; tab = 'unit';
    const cs = cards(); if (cs.length) sel = cs[0].key;
    document.body.classList.add('playing');
    render();
  }
  function close() { document.body.classList.remove('playing'); G = null; A.back(); }

  function render() {
    if (!G) return;
    renderTop();
    const cs = cards();
    if (sel && !cs.some(c => c.key === sel)) sel = cs.length ? cs[0].key : null;
    const keep = {}; ['.pl-list', '.pl-detail'].forEach(k => { const el = $(k); if (el) keep[k] = el.scrollTop; });
    $('#main').innerHTML = `<div class="play">
      ${scoreboard()}
      <div class="pl-body">
        <aside class="pl-list">${listHtml(cs)}</aside>
        <section class="pl-detail">${G.ended ? endBannerHtml() : ''}${remindersHtml()}${reservesHtml(cs)}${bsStepHtml(cs)}${tab === 'army' ? armyHtml() : detailHtml(cs.find(c => c.key === sel))}</section>
      </div>${G.ended && G.showEnd ? endModalHtml() : ''}${woundOpen ? woundHtml() : ''}${scoresOpen ? scoresHtml() : ''}</div>`;
    Object.keys(keep).forEach(k => { const el = $(k); if (el) el.scrollTop = keep[k]; });
  }
  function renderTop() {
    const r = roster();
    $('#topbar-roster').innerHTML = `<span class="pill play-pill">▶ PLAY MODE</span><span class="pl-title">${A.esc(r.name)}</span>
      <span class="pill sub">${E.rosterCost(r, cat().ptsType)} pts</span><span class="spacer"></span>
      <button class="btn sm" data-act="pl-scores" title="Victory points scored in each battle round">📊 Scores</button>
      <button class="btn sm" data-act="pl-wound-chart" title="Wound roll reminder">🎲 Wound roll</button>
      <button class="btn sm" data-act="pl-undo" ${history.length ? '' : 'disabled'} title="Undo last game change">↶ Undo</button>
      <button class="btn sm" data-act="pl-reset">New game</button>
      <button class="btn sm primary" data-act="pl-exit">✕ Exit play mode</button>`;
  }
  function counter(side, field, label) {
    return `<div class="ctr"><span class="ctr-l">${label}</span><button class="ctr-b" data-act="pl-add" data-side="${side}" data-f="${field}" data-n="-1">−</button><span class="ctr-v">${G[side][field]}</span><button class="ctr-b" data-act="pl-add" data-side="${side}" data-f="${field}" data-n="1">+</button></div>`;
  }
  function scoreboard() {
    const tot = (x) => x.pri + x.sec;
    const turnName = G.turn === 'me' ? 'Your turn' : `${A.esc(G.opp.name)}'s turn`;
    return `<div class="pl-score">
      <div class="side me ${G.turn === 'me' ? 'active' : ''}"><div class="side-h">You <span class="vp-total">${tot(G.me)} VP</span></div>
        <div class="ctrs">${counter('me', 'cp', 'CP')}${counter('me', 'pri', 'Primary')}${counter('me', 'sec', 'Secondary')}</div></div>
      <div class="pl-round">
        <div class="rnd"><button class="ctr-b" data-act="pl-round" data-n="-1">−</button><span>Battle round <b>${G.round}</b>${G.round > LAST_ROUND ? ' <span class="ot-tag">Overtime</span>' : ''}</span><button class="ctr-b" data-act="pl-round" data-n="1">+</button></div>
        <div class="turn" data-act="pl-turn" title="Click to switch turn">${turnName}</div>
        <div class="phases">${PHASES.map((p, i) => `<button class="ph ${i === G.phase ? 'on' : ''}" data-act="pl-phase" data-i="${i}">${p}</button>`).join('')}</div>
        <div class="rnd-actions">${G.ended ? '<button class="btn sm primary" data-act="pl-endshow">🏁 Game over – results</button>' : `<button class="btn sm primary" data-act="pl-next">${lastPhaseOfGame() ? 'End battle 🏁' : 'Next phase ▸'}</button>`}
          ${!G.ended && G.phase === 0 ? '<button class="btn sm" data-act="pl-cpboth" title="Each player gains 1 CP at the start of the Command phase">+1 CP each</button>' : ''}</div>
      </div>
      <div class="side opp ${G.turn === 'opp' ? 'active' : ''}"><div class="side-h"><input class="opp-name" data-act-input="pl-oppname" value="${A.esc(G.opp.name)}"> <span class="vp-total">${tot(G.opp)} VP</span></div>
        <div class="ctrs">${counter('opp', 'cp', 'CP')}${counter('opp', 'pri', 'Primary')}${counter('opp', 'sec', 'Secondary')}</div></div>
    </div>`;
  }
  function markChips(key) {
    const m = (G.units[key] || {}).marks || {};
    const on = [];
    if (m.bs) on.push('<span class="mk bad">Battle-shocked</span>');
    TURN_MARKS.forEach(([k, l]) => { if (m[k]) on.push(`<span class="mk">${l}</span>`); });
    return on.join('');
  }
  function listHtml(cs) {
    const alive = [], dead = [], reserve = [];
    // embarked units are listed straight after their transport
    const order = [];
    cs.filter(c => !embIn(c.key) || !cs.some(x => x.key === embIn(c.key))).forEach(c => { order.push(c); cs.filter(x => embIn(x.key) === c.key).forEach(x => order.push(x)); });
    order.forEach(c => {
      const sts = c.members.map(status);
      const allDead = sts.every(x => x.dead);
      const emb = embIn(c.key);
      const html = `<div class="pl-card ${c.key === sel && tab === 'unit' ? 'sel' : ''} ${allDead ? 'dead' : ''} ${emb && !allDead ? 'embarked' : ''}" data-act="pl-sel" data-k="${A.esc(c.key)}">
        <div class="pc-name">${c.members.map((u, i) => `${i ? '<span class="muted"> + </span>' : ''}${A.esc(name(u.s))}`).join('')}</div>
        <div class="pc-stat">${c.members.map((u, i) => { const st = sts[i]; return `<span class="pc-m ${st.dead ? 'dead' : st.half ? 'half' : ''}">${st.single ? `${st.wNow}/${st.wStart} W` : `${st.alive}/${st.start} models`}${st.dead ? ' – destroyed' : st.half ? ' – half-strength or less' : ''}</span>`; }).join('')}</div>
        <div class="pc-marks">${!allDead && c.members.some(u => damagedNow(u)) ? '<span class="mk dmg">Damaged</span>' : ''}${emb && !allDead ? `<span class="mk emb">🚚 Embarked${cardByKey(emb) ? ' in ' + cardName(cardByKey(emb)) : ''}</span>` : ''}${inResSelf(c.key) && !emb && !allDead ? '<span class="mk res">In reserves</span>' : ''}${!allDead && isTransport(c) && embarkedIn(c.key).length ? `<span class="mk emb">🚚 ${embarkedIn(c.key).length} embarked</span>` : ''}${markChips(c.members[0].key)}</div>
      </div>`;
      (allDead ? dead : inRes(c.key) ? reserve : alive).push(html);
    });
    return `<button class="pl-army ${tab === 'army' ? 'sel' : ''}" data-act="pl-army">📜 Army &amp; detachment rules</button>
      ${alive.join('')}${reserve.length ? `<div class="pl-dead-h">In strategic reserves</div>${reserve.join('')}` : ''}${dead.length ? `<div class="pl-dead-h">Destroyed</div>${dead.join('')}` : ''}`;
  }
  function trackerHtml(u, idx, c) {
    const st = status(u);
    const rows = st.groups.map(g => {
      const ms = mstate(u.key, g.key);
      const alive = Math.max(0, g.count - ms.lost);
      const pips = g.w > 1 && alive ? `<div class="pips" title="Wounds left on the damaged model – tap to set">${Array.from({ length: g.w }, (_, i) => `<span class="pip ${i < g.w - ms.dmg ? 'on' : ''}" data-act="pl-wset" data-k="${A.esc(u.key)}" data-g="${A.esc(g.key)}" data-w="${g.w}" data-p="${i + 1}"></span>`).join('')}<span class="muted small">${g.w - ms.dmg}/${g.w} W</span></div>` : '';
      return `<div class="trk ${alive ? '' : 'gone'}"><div class="trk-name">${A.esc(g.name)} <span class="muted small">(${g.w}W each)</span></div>
        <div class="trk-ctl"><span class="trk-count">${alive}/${g.count}</span>
          <button class="btn sm" data-act="pl-wound" data-k="${A.esc(u.key)}" data-g="${A.esc(g.key)}" data-w="${g.w}" data-n="1" ${alive ? '' : 'disabled'}>−1 wound</button>
          <button class="btn sm" data-act="pl-kill" data-k="${A.esc(u.key)}" data-g="${A.esc(g.key)}" data-n="1" ${alive ? '' : 'disabled'}>−1 model</button>
          <button class="btn sm" data-act="pl-kill" data-k="${A.esc(u.key)}" data-g="${A.esc(g.key)}" data-n="-1" ${ms.lost || ms.dmg ? '' : 'disabled'} title="Bring back a model / heal">＋</button></div>
        ${pips}</div>`;
    }).join('');
    const marks = (G.units[u.key] || {}).marks || {};
    const once = onceAbilities(u); const used = (G.units[u.key] || {}).once || {};
    return `<div class="trk-box"><div class="trk-head"><b>${A.esc(name(u.s))}</b>
        <span class="${st.dead ? 'bad' : st.half ? 'warn' : 'muted'}">${st.dead ? 'Destroyed' : st.half ? 'At or below half-strength' : 'Above half-strength'}</span>
        ${(() => { const d = damagedNow(u); return d ? `<span class="mk dmg" title="${A.esc(d.text)}">Damaged (${d.lo}-${d.hi} W)</span>` : ''; })()}
        ${st.dead ? '' : `<button class="btn sm danger" data-act="pl-destroy" data-k="${A.esc(u.key)}">Destroyed</button>`}</div>
      ${rows}
      ${idx || st.dead ? '' : locationHtml(c ? c.key : u.key, c ? c.members : [u])}
      ${idx ? '' : `<div class="mk-row">${c && c.members.length > 1 ? '<span class="muted small">Whole unit:</span>' : ''}<button class="mkb ${marks.bs ? 'on bad' : ''}" data-act="pl-mark" data-k="${A.esc(u.key)}" data-m="bs">Battle-shocked</button>
        ${TURN_MARKS.map(([k, l]) => `<button class="mkb ${marks[k] ? 'on' : ''}" data-act="pl-mark" data-k="${A.esc(u.key)}" data-m="${k}">${l}</button>`).join('')}</div>`}
      ${once.length ? `<div class="mk-row"><span class="muted small">Once per battle:</span>${once.map(n => `<button class="mkb once ${used[n] ? 'used' : ''}" data-act="pl-once" data-k="${A.esc(u.key)}" data-n="${A.esc(n)}">${used[n] ? '✓ ' : ''}${A.esc(n)}</button>`).join('')}</div>` : ''}
    </div>`;
  }
  function detailHtml(c) {
    if (!c) return '<p class="muted">No units in this list.</p>';
    return `${c.members.map((u, i) => trackerHtml(u, i, c)).join('')}
      ${c.members.map(u => A.renderDatasheet(u.s, { damaged: damagedNow(u) })).join('')}`;
  }

  // ------------------------------------------------------------------ "Damaged" brackets
  // e.g. "Damaged: 1-6 wounds remaining – each time this model makes an attack, subtract 1 from the Hit roll"
  // or the core "Damaged X" ability (damaged at X or fewer wounds: -1 to hit).
  const dmgCache = new Map();
  function damagedRules(u) {
    if (dmgCache.has(u.key)) return dmgCache.get(u.key);
    const info = E.collectInfo(u.s, true);
    const out = [];
    const add = (nm, text) => {
      const t = String(text || '').replace(/\u00a0/g, ' ').replace(/\*\*|\^\^/g, '');
      let lo = 1, hi = null, m;
      if ((m = /Damaged:?\s*(\d+)\s*[-–]\s*(\d+)/i.exec(nm))) { lo = +m[1]; hi = +m[2]; }
      else if ((m = /^Damaged\s+(\d+)$/i.exec(nm.trim()))) { hi = +m[1]; }
      else if ((m = /(\d+)\s*[-–]\s*(\d+) wounds remaining/i.exec(t))) { lo = +m[1]; hi = +m[2]; }
      if (hi === null) return;
      const hitM = /subtract (\d+) from the Hit roll/i.exec(t) || /-(\d+) to hit rolls/i.exec(t);
      const ocM = /subtract (\d+) from (?:this model[’']?s|this models|its|that model[’']?s) Objective Control/i.exec(t);
      const halveA = /Attacks characteristics? of (?:all of )?(?:its|that model[’']?s) weapons (?:are )?halved|halve the Attacks characteristic/i.test(t);
      // anything else in the text (e.g. "can only select one ability") is shown as text
      const rest = t.replace(/^.*?wounds remaining,?\s*/i, '').replace(/subtract \d+ from (?:this model[’']?s|this models|its|that model[’']?s) Objective Control characteristic,?/ig, '')
        .replace(/(?:and )?each time this (?:model|unit) makes an attack, subtract \d+ from the Hit roll\.?/ig, '').replace(/halve the Attacks characteristic of that model[’']?s weapons,?/ig, '')
        .replace(/the Attacks characteristics of all of its weapons are halved,?/ig, '').replace(/[\s,.]+/g, ' ').trim();
      const more = /^Damaged\s+\d+$/i.test(nm.trim()) ? false : rest.replace(/^and\s*/i, '').length > 3;
      out.push({ label: nm.replace(/\s+/g, ' ').trim(), lo, hi, hit: hitM ? +hitM[1] : 0, oc: ocM ? +ocM[1] : 0, halveA, more, text: t });
    };
    info.profiles.filter(p => /^Damaged/i.test(p.name)).forEach(p => add(p.name, Object.values(p.chars).join(' ')));
    info.rules.filter(r => /^Damaged/i.test(r.name)).forEach(r => add(r.name, r.description));
    dmgCache.set(u.key, out);
    return out;
  }
  // wounds left on the model the bracket applies to: a single-model unit, or the unit's one big model
  function bracketWounds(u) {
    const st = status(u);
    if (st.dead) return null;
    if (st.single) return { w: st.wNow };
    const g = st.groups.filter(x => x.count === 1 && x.w > 1).sort((a, b) => b.w - a.w)[0];
    if (!g) return null;
    const ms = (G.units[u.key] && G.units[u.key].m[g.key]) || { lost: 0, dmg: 0 };
    if (ms.lost) return null;
    // only that model's weapons are affected
    let model = null;
    const rec = (x) => x.children.forEach(c => { if (!model && c.node.type === 'model' && E.ev(c).name === g.name) model = c; else rec(c); });
    rec(u.s);
    const only = model ? new Set(E.collectInfo(model, true).profiles.filter(p => /Weapons/.test(p.typeName || '')).map(p => p.name)) : null;
    return { w: g.w - ms.dmg, only, model: g.name };
  }
  function damagedNow(u) {
    const rs = damagedRules(u);
    if (!rs.length) return null;
    const b = bracketWounds(u);
    if (!b) return null;
    const r = rs.find(x => b.w >= x.lo && b.w <= x.hi);
    return r ? Object.assign({ wounds: b.w, only: b.only, model: b.model }, r) : null;
  }
  // Battle-shock step: in your Command phase, each unit that is battle-shocked or at/below half-strength rolls 2D6 vs Ld.
  // Passing removes battle-shock; failing makes the unit battle-shocked. Nothing clears automatically.
  function ldOf(u) {
    const p = E.collectInfo(u.s, true).profiles.find(x => x.typeName === 'Unit');
    if (!p) return '';
    const k = Object.keys(p.chars).find(id => /^L[Dd]$/.test(charName(p, id)));
    return k ? p.chars[k] : '';
  }
  function bsStepHtml(cs) {
    if (!(G.turn === 'me' && G.phase === 0)) return '';
    const res = (G.bsTests && G.bsTests[G.round]) || {};
    const rows = [];
    cs.forEach(c => {
      // an attached unit tests as one unit (the bodyguard's card key holds its markers)
      const sts = c.members.map(status);
      if (sts.every(x => x.dead) || offTable(c.key)) return;
      const marks = (G.units[c.key] || {}).marks || {};
      const r = res[c.key];
      const before = (G.bsBefore || {})[G.round + '|' + c.key];
      const wasShocked = r ? !!before : !!marks.bs;     // describe the unit as it was when it rolled
      const half = c.members.length > 1 ? (() => { const a = sts.reduce((n, x) => n + x.alive, 0), t = sts.reduce((n, x) => n + x.start, 0); return a * 2 <= t; })() : sts[0].half;
      if (!r && !wasShocked && !half) return;
      const why = [wasShocked ? 'battle-shocked' : '', half ? 'at or below half-strength' : ''].filter(Boolean).join(', ') || 'tested';
      const ld = c.members.map(ldOf).filter(Boolean).sort()[0] || '?';
      rows.push(`<div class="bs-row ${r || ''}"><div><b>${c.members.map(u => A.esc(name(u.s))).join(' + ')}</b><div class="muted small">${why} · Ld ${A.esc(ld)} (roll 2D6)</div></div>
        <div class="bs-btns">${r ? `<span class="bs-res ${r}">${r === 'pass' ? '✓ Passed' : '✗ Failed – battle-shocked'}</span><button class="btn sm" data-act="pl-bsundo" data-k="${A.esc(c.key)}">change</button>`
          : `<button class="btn sm bs-pass" data-act="pl-bs" data-k="${A.esc(c.key)}" data-r="pass">Passed</button><button class="btn sm bs-fail" data-act="pl-bs" data-k="${A.esc(c.key)}" data-r="fail">Failed</button>`}</div></div>`);
    });
    if (!rows.length) return `<div class="bs-step none">Battle-shock step: no units need to test this turn.</div>`;
    const left = rows.length - Object.keys(res).filter(k => cs.some(c => c.key === k)).length;
    // (rows include units already rolled this phase, so the count stays right)
    return `<div class="bs-step"><div class="bs-h">⚠ Battle-shock step – ${left > 0 ? left + ' unit(s) still to test' : 'all tests done'}</div>
      <div class="muted small">Each unit that is battle-shocked or at/below half-strength rolls 2D6 against its Leadership. Passing removes battle-shock; failing means it is battle-shocked.</div>${rows.join('')}</div>`;
  }
  function armyHtml() {
    const html = A.armyRulesHtml(roster());
    return html ? `<div class="pl-armyrules">${html}</div>` : '<p class="muted">No detachment selected.</p>';
  }

  // ------------------------------------------------------------------ phase reminders
  // Abilities and rules whose text mentions a phase, grouped so each shows once with the units that have it.
  let remCache = null, remOpen = true;
  const remExpanded = new Set();
  const STAT_TYPES = ['Unit', 'Ranged Weapons', 'Melee Weapons', 'Transport'];
  function splitSentences(text) { return String(text || '').replace(/ /g, ' ').replace(/\*\*|\^\^/g, '').replace(/\s*\n+\s*/g, ' ').split(/(?<=[.!?:])\s+(?=[A-Z■•(])/); }
  // A trigger like "At the start of your turn" only counts at the start of a sentence or clause,
  // not in "…was within Engagement Range at the start of the turn".
  const CLAUSE = String.raw`(?:^|[,:;■•–-]\s*)`;
  const reAt = (body) => new RegExp(CLAUSE + String.raw`at the ` + body, 'i');
  function classifyPhases(text) {
    const out = [];
    const sents = splitSentences(text).map(st0 => ({
      st0,
      // durations and "as if" don't say when the ability is used
      st: st0.trim()
        .replace(/as if it were (your|the|your opponent['’]s) \w+ phase/gi, '')
        .replace(/until the (start|end) of (your |the |your opponent['’]s |that |this )?(next )?(\w+ )?phase/gi, '')
        .replace(/until the (start|end) of (your |the |your opponent['’]s |that |this )?(next )?(turn|battle round|battle)/gi, ''),
    }));
    // "at the start of any phase", "at the end of a phase": every phase
    const anyHits = sents.filter(x => reAt(String.raw`(start|end) of (any|each|every|a|the) phase`).test(x.st)).map(x => x.st0);
    PHASES.forEach((P, i) => {
      let me = false, opp = false, any = false, round = false, first = false; const hits = [];
      for (const { st0, st } of sents) {
        let m = false;
        if (new RegExp(`opponent['’]s ${P} phase`, 'i').test(st)) { opp = true; m = true; }
        if (new RegExp(String.raw`\byour ${P} phase`, 'i').test(st)) { me = true; m = true; }
        if (!m && new RegExp(String.raw`\b${P} phase`, 'i').test(st)) { any = true; m = true; }
        if (i === 0) {
          if (reAt(String.raw`start of the first battle round`).test(st)) { first = true; m = true; }
          else if (reAt(String.raw`start of (the|each|every|a) battle round`).test(st)) { round = true; m = true; }
          else if (reAt(String.raw`start of (your|your opponent['’]s|each|every|a|the) turn`).test(st)) {
            if (/opponent['’]s turn/i.test(st)) opp = true; else if (/your turn/i.test(st)) me = true; else any = true; m = true;
          }
        }
        if (i === 1 && !m && /Reinforcements step/i.test(st)) { me = true; m = true; }
        if (i === 4) {
          if (reAt(String.raw`end of (the|each|every|a) battle round`).test(st)) { round = true; m = true; }
          else if (reAt(String.raw`end of (the|each|every|a|your|your opponent['’]s) turn`).test(st)) {
            if (/opponent['’]s turn/i.test(st)) opp = true; else if (/your turn/i.test(st)) me = true; else any = true; m = true;
          }
        }
        if (m) hits.push(st0);
      }
      // start of the battle round: first player's Command phase; end of the battle round: second player's Fight phase
      if (hits.length) out.push({ phase: i, who: any || (me && opp) ? 'both' : me ? 'me' : opp ? 'opp' : first ? 'round1' : 'round', hits });
      else if (anyHits.length) out.push({ phase: i, who: 'any', hits: anyHits });
    });
    return out;
  }
  function buildReminders() {
    const map = new Map();
    const add = (group, item, unitKey, unitName) => {
      const text = item.text || '';
      if (!text) return;
      const k = group + '|' + item.name + '|' + text;
      let r = map.get(k);
      if (!r) {
        const ph = classifyPhases(text);
        if (!ph.length) { map.set(k, null); return; }
        r = { group, name: item.name, source: item.source || '', text, ph, units: [] };
        map.set(k, r);
      }
      if (r && unitKey && !r.units.some(u => u.key === unitKey)) r.units.push({ key: unitKey, name: unitName });
    };
    try { (A.armyRuleItems ? A.armyRuleItems(roster()) : []).forEach(i => add('army', i, null, null)); } catch (e) { /* ignore */ }
    units().forEach(u => {
      const info = E.collectInfo(u.s, true);
      info.profiles.filter(p => !STAT_TYPES.includes(p.typeName)).forEach(p => add('unit', { name: p.name, text: Object.values(p.chars).join('\n') }, u.key, name(u.s)));
      info.rules.forEach(r => add('rule', { name: r.name, text: r.description }, u.key, name(u.s)));
    });
    return [...map.values()].filter(Boolean);
  }
  function remindersNow() {
    if (!remCache) remCache = buildReminders();
    const who = G.turn;
    const alive = new Set(units().filter(u => !status(u).dead).map(u => u.key));
    const out = [];
    for (const r of remCache) {
      const roundTurn = G.phase === 0 ? G.turn === G.first : G.turn !== G.first;
      const p = r.ph.find(x => x.phase === G.phase && (x.who === 'both' || x.who === 'any' || x.who === who || (x.who === 'round' && roundTurn) || (x.who === 'round1' && roundTurn && G.round === 1)));
      if (!p) continue;
      const us = r.units.filter(u => alive.has(u.key));
      if (r.group !== 'army' && !us.length) continue;
      out.push({ r, hits: p.hits, us, grp: p.who === 'any' ? 'any' : r.group });
    }
    const order = { army: 0, unit: 1, rule: 2, any: 3 };
    return out.sort((a, b) => order[a.grp] - order[b.grp] || a.r.name.localeCompare(b.r.name));
  }
  function remindersHtml() {
    if (G.ended) return '';
    const list = remindersNow();
    const P = PHASES[G.phase];
    const whose = G.turn === 'me' ? `Your ${P} phase` : `${A.esc(G.opp.name)}'s ${P} phase`;
    const hl = (t) => A.esc(t.replace(/\*\*|\^\^/g, '')).replace(new RegExp(`((?:your |your opponent['’]s |opponent['’]s |each |the |a |any )?${P} phase|Reinforcements step|(?:start|end) of (?:any|each|every|a|the) phase|(?:start|end) of [^,.]*?(?:battle round|turn))`, 'gi'), '<mark>$1</mark>');
    const total = remCache ? remCache.length : 0;
    const uNames = (us) => us.length > 4 ? `${us.length} units` : us.map(u => A.esc(u.name)).join(', ');
    const head = { army: 'Army & detachment', unit: 'Unit abilities', rule: 'Rules', any: 'Any phase' };
    let last = null, rows = '';
    list.forEach(({ r, hits, us, grp }) => {
      if (grp !== last) { rows += `<div class="rem-h">${head[grp]}</div>`; last = grp; }
      const id = r.group + '|' + r.name + '|' + r.text.length;
      const open = remExpanded.has(id);
      rows += `<div class="rem-item ${open ? 'open' : ''}" data-act="pl-rem" data-k="${A.esc(id)}" title="Click to ${open ? 'hide' : 'show'} the full text">
        <div class="rem-name"><b>${A.esc(r.name)}</b>${r.group === 'army' ? (r.source ? ` <span class="muted small">– ${A.esc(r.source)}</span>` : '') : ` <span class="muted small">– ${uNames(us)}</span>`}</div>
        <div class="rem-text">${open ? A.fmt(r.text) : hits.map(hl).join(' ')}</div></div>`;
    });
    return `<div class="pl-rem ${remOpen ? '' : 'closed'}">
      <div class="rem-top" data-act="pl-remtoggle"><b>📋 ${whose}</b> <span class="muted">· ${list.length ? list.length + ' reminder' + (list.length > 1 ? 's' : '') : 'nothing from your army'}</span><span class="spacer"></span><span class="muted small">${remOpen ? 'Hide ▴' : 'Show ▾'}</span></div>
      ${remOpen && list.length ? `<div class="rem-list">${rows}<div class="muted small rem-foot">Abilities found in your army's rules text that mention this phase. Click one to see its full text.</div></div>` : ''}
    </div>`;
  }

  // ------------------------------------------------------------------ strategic reserves (core rules 20, 23)
  let pendingToast = '';
  // a unit embarked within a TRANSPORT is wherever its transport is
  const embIn = (key) => { const t = G.units[key] && G.units[key].emb; return t && t !== key ? t : null; };
  const inResSelf = (key) => !!(G.units[key] && G.units[key].res);
  const inRes = (key) => { const t = embIn(key); return t ? inResSelf(t) : inResSelf(key); };
  const offTable = (key) => !!embIn(key) || inRes(key);   // not on the battlefield
  function catNames(u) { const e = E.ev(u.s); return [...e.cats].map(id => cat().catName(id)); }
  const isAircraft = (c) => c.members.some(u => catNames(u).some(n => /^Aircraft$/i.test(n)));
  const hasDeepStrike = (c) => c.members.every(u => { const i = E.collectInfo(u.s, true); return i.rules.some(r => /^Deep Strike$/i.test(r.name)) || i.profiles.some(p => /^Deep Strike$/i.test(p.name)); });
  const cardPts = (c) => c.members.reduce((a, u) => a + E.totalCost(u.s, cat().ptsType), 0);
  const cardName = (c) => c.members.map(u => A.esc(name(u.s))).join(' + ');
  const cardDead = (c) => c.members.every(u => status(u).dead);
  const transportCap = (c) => { for (const u of c.members) { const i = E.collectInfo(u.s, false); const p = i.profiles.find(x => x.typeName === 'Transport'); if (p) return Object.values(p.chars).join(' '); } return null; };
  const isTransport = (c) => transportCap(c) !== null || c.members.some(u => catNames(u).some(n => /^Transport$/i.test(n)));
  const cardByKey = (k) => cards().find(c => c.key === k);
  const embarkedIn = (tkey) => cards().filter(c => embIn(c.key) === tkey);
  // points that count towards the strategic reserves limit: the unit plus anything embarked in it
  const resPtsOf = (c) => cardPts(c) + embarkedIn(c.key).reduce((a, x) => a + cardPts(x), 0);
  // AIRCRAFT units must start the battle in strategic reserves
  function initReserves() {
    if (G.resInit) return;
    G.resInit = true;
    if (G.round > 1 || G.phase > 0 || G.turn !== G.first) { G.begun = true; save(); return; }   // a game saved before this feature
    cards().forEach(c => { if (isAircraft(c)) U(c.key).res = true; });
    save();
  }
  function setReserve(key, on) {
    const st = U(key);
    if (on) { st.res = true; if (G.begun) st.rep = true; }   // put in reserves during the battle = repositioned unit
    else { st.res = false; if (G.begun) st.ing = true; }
  }
  function arrive(key) {
    const st = U(key); st.res = false; st.ing = true; st.arr = G.round;
    embarkedIn(key).forEach(c => { U(c.key).ing = true; });   // embarked units arrived with their transport
  }
  function embark(key, tkey) {
    const st = U(key);
    if (!tkey) { delete st.emb; if (G.begun) st.ing = true; return; }       // disembarked = on the battlefield
    if (tkey === key || embIn(tkey)) return;
    st.emb = tkey; st.res = false;
  }
  function destroyCard(c) { c.members.forEach(u => modelGroups(u).forEach(g => { const ms = mstate(u.key, g.key); ms.lost = g.count; ms.dmg = 0; })); }
  // end of the opponent's turn: AIRCRAFT on the battlefield go back into strategic reserves
  function aircraftToReserves() {
    const moved = cards().filter(c => isAircraft(c) && !inRes(c.key) && !cardDead(c));
    moved.forEach(c => { const st = U(c.key); st.res = true; st.rep = true; });
    if (moved.length) pendingToast += `Aircraft returned to strategic reserves: ${moved.map(c => c.members.map(u => name(u.s)).join(' + ')).join(', ')}. `;
  }
  // end of battle round 3: units that never made an ingress move are destroyed (repositioned units excepted)
  function reservesLost() {
    const lost = cards().filter(c => { const st = G.units[c.key] || {}; return !embIn(c.key) && st.res && !st.ing && !st.rep && !cardDead(c); });
    lost.slice().forEach(t => embarkedIn(t.key).forEach(c => { if (!cardDead(c)) lost.push(c); }));
    lost.forEach(destroyCard);
    if (lost.length) pendingToast += `Never arrived from strategic reserves, so destroyed at the end of battle round 3: ${lost.map(c => c.members.map(u => name(u.s)).join(' + ')).join(', ')} (Undo reverses this). `;
  }
  function embarkSelect(key) {
    const c = cardByKey(key);
    if (!c || isTransport(c)) return '';
    const ts = cards().filter(t => t.key !== key && isTransport(t) && !embIn(t.key) && !cardDead(t));
    if (!ts.length) return '';
    const cur = embIn(key);
    return `<select class="emb-sel" data-act-input="pl-emb" data-k="${A.esc(key)}">
      <option value="">${cur && G.begun ? 'Disembark' : 'Not embarked'}</option>
      ${ts.map(t => `<option value="${A.esc(t.key)}" ${cur === t.key ? 'selected' : ''}>🚚 Embarked in ${cardName(t)}</option>`).join('')}</select>`;
  }
  function locationHtml(key, members) {
    const c = { key, members };
    const emb = embIn(key);
    const on = inResSelf(key) && !emb;
    const t = emb && cardByKey(emb);
    const transportInfo = (() => {
      const full = cardByKey(key);
      if (!full || !isTransport(full)) return '';
      const inside = embarkedIn(key);
      const cap = transportCap(full);
      return `<div class="emb-info"><span class="muted small">🚚 Transport${cap ? ` – <i>${A.esc(cap.length > 160 ? cap.slice(0, 157) + '…' : cap)}</i>` : ''}</span>
        <div>${inside.length ? 'Embarked: ' + inside.map(x => `<b>${cardName(x)}</b> <button class="btn sm" data-act="pl-disembark" data-k="${A.esc(x.key)}">Disembark</button>`).join(' ') : '<span class="muted small">Nothing embarked.</span>'}</div></div>`;
    })();
    if (emb) return `<div class="mk-row"><span class="muted small">${members.length > 1 ? 'Whole unit:' : 'Location:'}</span>
      <span class="mk emb">🚚 Embarked in ${t ? cardName(t) : 'a transport'}${t && inResSelf(emb) ? ' (in strategic reserves)' : ''}</span>
      ${t && cardDead(t) ? '<span class="bad small">Its transport is destroyed – disembark this unit.</span>' : ''}
      <button class="btn sm" data-act="pl-disembark" data-k="${A.esc(key)}">Disembark</button></div>`;
    return `${transportInfo}<div class="mk-row"><span class="muted small">${members.length > 1 ? 'Whole unit:' : 'Location:'}</span>
      <button class="mkb ${on ? '' : 'on'}" data-act="pl-res" data-k="${A.esc(key)}" data-v="0">On the battlefield</button>
      <button class="mkb ${on ? 'on res' : ''}" data-act="pl-res" data-k="${A.esc(key)}" data-v="1">In strategic reserves</button>
      ${embarkSelect(key)}
      ${hasDeepStrike(c) ? '<span class="mk ds" title="Can be set up anywhere more than 8&quot; horizontally from all enemy units when it makes an ingress move">Deep Strike</span>' : ''}
      ${isAircraft(c) ? '<span class="mk ds" title="Starts in strategic reserves; returns to reserves at the end of your opponent\'s turn">Aircraft</span>' : ''}</div>`;
  }
  function reservesHtml(cs) {
    if (G.ended) return '';
    const live = cs.filter(c => !cardDead(c));
    const res = live.filter(c => inResSelf(c.key) && !embIn(c.key));
    const limit = Math.floor((roster().costLimit || 0) / 2);
    const resPts = res.reduce((a, c) => a + resPtsOf(c), 0);
    const ptsLine = limit ? `<span class="${resPts > limit ? 'bad' : 'muted'}">${resPts} / ${limit} pts in reserves${resPts > limit ? ' – over the 50% limit!' : ' (max 50% of your points limit)'}</span>` : '';
    const tag = (c) => `${hasDeepStrike(c) ? ' <span class="mk ds">Deep Strike</span>' : ''}${isAircraft(c) ? ' <span class="mk ds">Aircraft</span>' : ''}`;
    // before the battle: choose which units start in reserves
    if (!G.begun) {
      const ordered = [];
      live.filter(c => !embIn(c.key)).forEach(c => { ordered.push(c); live.filter(x => embIn(x.key) === c.key).forEach(x => ordered.push(x)); });
      const rows = ordered.map(c => {
        const emb = embIn(c.key);
        const inside = embarkedIn(c.key);
        const btn = emb ? '' : `<button class="btn sm ${inResSelf(c.key) ? 'primary' : ''}" data-act="pl-res" data-k="${A.esc(c.key)}" data-v="${inResSelf(c.key) ? 0 : 1}">${inResSelf(c.key) ? '✓ In reserves' : 'Put in reserves'}</button>`;
        return `<div class="res-row ${emb ? 'embarked' : ''}"><div><b>${cardName(c)}</b>${tag(c)} <span class="muted small">${cardPts(c)} pts${inside.length ? ` + ${inside.reduce((a, x) => a + cardPts(x), 0)} pts embarked` : ''}</span>${isTransport(c) ? ' <span class="mk emb">🚚 Transport</span>' : ''}</div>
          <div class="res-ctl">${embarkSelect(c.key)}${btn}</div></div>`;
      }).join('');
      return `<div class="pl-res ${resOpen ? '' : 'closed'}"><div class="rem-top" data-act="pl-restoggle"><b>🛬 Strategic reserves – before the battle</b> <span class="muted">· ${res.length} unit${res.length === 1 ? '' : 's'}</span><span class="spacer"></span>${ptsLine}<span class="muted small" style="margin-left:8px">${resOpen ? 'Hide ▴' : 'Show ▾'}</span></div>
        ${resOpen ? `<div class="rem-list"><div class="muted small">Choose units to hold back in the Declare Battle Formations step, and which units start embarked in a transport. Units embarked in a transport that's in reserves count towards the 50% limit. Reserves arrive from battle round 2 with an ingress move; any that haven't arrived by the end of battle round 3 are destroyed. Aircraft must start in reserves.</div>${rows || '<p class="muted">No units.</p>'}</div>` : ''}</div>`;
    }
    if (!res.length || G.phase !== 1) return '';
    const mine = G.turn === 'me';
    if (mine && G.round < 2) return `<div class="pl-res"><div class="rem-top"><b>🛬 Strategic reserves</b><span class="muted">&nbsp;· ${res.length} unit${res.length === 1 ? '' : 's'} – they can't arrive until battle round 2.</span></div></div>`;
    if (!mine && G.round < 2) return '';
    const notes = mine ? [
      'Each unit makes an <b>ingress move</b>: set it up wholly within 6" of a battlefield edge and more than 8" horizontally from all enemy units.',
      G.round < 3 ? 'Before battle round 3, no models can be set up in your opponent\'s deployment zone (Deep Strike units excepted).' : '',
      'Deep Strike units can instead be set up anywhere more than 8" horizontally from all enemy units.',
      G.round === 3 ? '<span class="bad">Units that haven\'t arrived by the end of this battle round are destroyed.</span>' : '',
    ].filter(Boolean) : ['<b>Rapid Ingress</b> (1 CP, end of your opponent\'s Movement phase): one unit (not Aircraft) can make an ingress move.'];
    const list = res.filter(c => mine || !isAircraft(c));
    if (!list.length) return '';
    const rows = list.map(c => `<div class="res-row"><div><b>${cardName(c)}</b>${tag(c)}${embarkedIn(c.key).length ? ` <span class="muted small">with ${embarkedIn(c.key).map(cardName).join(', ')} embarked</span>` : ''}</div>
      <button class="btn sm primary" data-act="pl-arrive" data-k="${A.esc(c.key)}" ${mine ? '' : 'data-cp="1"'}>${mine ? 'Arrived ✓' : 'Arrived (−1 CP)'}</button></div>`).join('');
    return `<div class="pl-res"><div class="rem-top"><b>🛬 ${mine ? 'Arriving from strategic reserves' : 'Rapid Ingress'}</b><span class="muted">&nbsp;· ${res.length} unit${res.length === 1 ? '' : 's'} in reserves</span></div>
      <div class="rem-list"><ul class="res-notes">${notes.map(n => `<li>${n}</li>`).join('')}</ul>${rows}</div></div>`;
  }
  let resOpen = true;

  // ------------------------------------------------------------------ score history by battle round
  let scoresOpen = false;
  function logScore(side, f, d) {
    if (!G.hist) G.hist = {};
    const h = G.hist[G.round] || (G.hist[G.round] = { me: { pri: 0, sec: 0 }, opp: { pri: 0, sec: 0 } });
    h[side][f] += d;
  }
  // rows for each battle round so far, plus "not recorded" for VP from before this feature existed
  function scoreRows() {
    const hist = G.hist || {};
    const last = Math.max(G.round, ...Object.keys(hist).map(Number));
    const rows = [];
    const sum = { me: { pri: 0, sec: 0 }, opp: { pri: 0, sec: 0 } };
    for (let r = 1; r <= last; r++) {
      const h = hist[r] || { me: { pri: 0, sec: 0 }, opp: { pri: 0, sec: 0 } };
      ['me', 'opp'].forEach(sd => { sum[sd].pri += h[sd].pri; sum[sd].sec += h[sd].sec; });
      rows.push({ label: `Round ${r}${r > LAST_ROUND ? ' (OT)' : ''}`, r, h });
    }
    const extra = { me: { pri: G.me.pri - sum.me.pri, sec: G.me.sec - sum.me.sec }, opp: { pri: G.opp.pri - sum.opp.pri, sec: G.opp.sec - sum.opp.sec } };
    if (['me', 'opp'].some(sd => extra[sd].pri || extra[sd].sec)) rows.unshift({ label: 'Not recorded', r: 0, h: extra });
    return rows;
  }
  function scoreTableHtml() {
    const rows = scoreRows();
    const name = A.esc(G.opp.name);
    const cell = (x) => `<td>${x.pri || ''}</td><td>${x.sec || ''}</td><td class="st-tot">${x.pri + x.sec || '–'}</td>`;
    let runMe = 0, runOpp = 0;
    const body = rows.map(row => {
      runMe += row.h.me.pri + row.h.me.sec; runOpp += row.h.opp.pri + row.h.opp.sec;
      return `<tr class="${row.r === G.round && !G.ended ? 'st-now' : ''}"><td class="st-l">${row.label}</td>${cell(row.h.me)}${cell(row.h.opp)}<td class="st-run">${runMe} – ${runOpp}</td></tr>`;
    }).join('');
    return `<table class="st-table">
      <tr><th></th><th colspan="3">You</th><th colspan="3">${name}</th><th></th></tr>
      <tr class="st-sub"><th></th><th>Pri</th><th>Sec</th><th>Total</th><th>Pri</th><th>Sec</th><th>Total</th><th>Running score</th></tr>
      ${body}
      <tr class="st-final"><td class="st-l">Total</td><td>${G.me.pri}</td><td>${G.me.sec}</td><td class="st-tot">${G.me.pri + G.me.sec}</td><td>${G.opp.pri}</td><td>${G.opp.sec}</td><td class="st-tot">${G.opp.pri + G.opp.sec}</td><td></td></tr>
    </table>`;
  }
  function scoresHtml() {
    return `<div class="pl-endmodal" data-act="pl-scores-close"><div class="pl-endbox st-box">
      <div class="row-between"><h2>📊 Score by round</h2><button class="icon" data-act="pl-scores-close" title="Close">✕</button></div>
      <p class="muted small">VP are counted in the battle round they were added. Use the − buttons on the scoreboard to correct a mistake – it comes off the current round.</p>
      ${scoreTableHtml()}
    </div></div>`;
  }

  // ------------------------------------------------------------------ wound roll reminder (core rules 05.02)
  let woundOpen = false, wS = 4, wT = 4;
  const WOUND_ROWS = [
    ['twice', 'Strength is <b>TWICE</b> (or more than twice) the Toughness', 2],
    ['greater', 'Strength is <b>GREATER</b> than the Toughness', 3],
    ['equal', 'Strength is <b>EQUAL</b> to the Toughness', 4],
    ['less', 'Strength is <b>LESS</b> than the Toughness', 5],
    ['half', 'Strength is <b>HALF</b> (or less than half) the Toughness', 6],
  ];
  function woundRow(S, T) {
    if (S >= 2 * T) return 'twice';
    if (S > T) return 'greater';
    if (S === T) return 'equal';
    if (2 * S <= T) return 'half';
    return 'less';
  }
  function woundHtml() {
    const hit = woundRow(wS, wT);
    const need = WOUND_ROWS.find(r => r[0] === hit)[2];
    const spin = (id, label, v) => `<div class="wr-in"><span>${label}</span><button class="ctr-b" data-act="pl-wr" data-k="${id}" data-n="-1">−</button><b>${v}</b><button class="ctr-b" data-act="pl-wr" data-k="${id}" data-n="1">+</button></div>`;
    return `<div class="pl-endmodal" data-act="pl-wound-close"><div class="pl-endbox wr-box" data-act="pl-wr-box">
      <div class="row-between"><h2>🎲 Wound roll</h2><button class="icon" data-act="pl-wound-close" title="Close">✕</button></div>
      <p class="muted small">Make one wound roll for each hit by rolling one D6. Check each result against the first line below that applies.</p>
      <table class="wr-table">
        <tr><td>Unmodified <span class="die">1</span></td><td class="wr-fail">FAILS</td></tr>
        <tr><td>Unmodified <span class="die">6</span></td><td class="wr-ok">CRITICAL WOUND</td></tr>
        <tr><td>Equal to or greater than the required result below</td><td class="wr-ok">WOUND</td></tr>
        <tr><td colspan="2" class="wr-sub"><table>
          <tr><th>Attack's Strength vs target's Toughness</th><th>Required result</th></tr>
          ${WOUND_ROWS.map(r => `<tr class="${r[0] === hit ? 'wr-hit' : ''}"><td>${r[1]}</td><td><span class="die">${r[2]}</span>+</td></tr>`).join('')}
        </table></td></tr>
        <tr><td>Any other result</td><td class="wr-fail">FAILS</td></tr>
      </table>
      <div class="wr-calc">${spin('s', 'Strength', wS)}${spin('t', 'Toughness', wT)}<div class="wr-need">Wounds on <b>${need}+</b></div></div>
    </div></div>`;
  }

  // ------------------------------------------------------------------ end of the battle
  function lastPhaseOfGame() {
    return G.round >= lastRound() && G.turn !== G.first && G.phase === PHASES.length - 1;
  }
  function result() {
    const me = G.me.pri + G.me.sec, opp = G.opp.pri + G.opp.sec;
    const name = A.esc(G.opp.name);
    const line = me > opp ? 'You win!' : me < opp ? `${name} wins` : 'It’s a draw';
    return { me, opp, name, line, cls: me > opp ? 'good' : me < opp ? 'bad' : '' };
  }
  function endBannerHtml() {
    const r = result();
    return `<div class="pl-endbar"><b>🏁 Game over</b> after battle round ${G.round}${G.round > LAST_ROUND ? ' (overtime)' : ''} – You ${r.me} VP · ${r.name} ${r.opp} VP – <span class="${r.cls}">${r.line}</span>
      <span class="spacer"></span><button class="btn sm" data-act="pl-overtime">＋ Overtime round</button></div>`;
  }
  function endModalHtml() {
    const r = result();
    return `<div class="pl-endmodal"><div class="pl-endbox">
      <div class="pl-endicon">🏁</div>
      <h2>The battle is over</h2>
      <p class="muted">${G.round > LAST_ROUND ? `Overtime round ${G.round} has ended.` : `Battle round ${G.round} has ended – that's the end of a normal game.`}</p>
      ${scoreTableHtml()}
      <div class="pl-endres ${r.cls}">${r.line}</div>
      ${(() => { const left = cards().filter(c => inRes(c.key) && !c.members.every(u => status(u).dead)); return left.length ? `<p class="muted small">Still in strategic reserves (destroyed at the end of the battle): ${left.map(c => A.esc(c.members.map(u => name(u.s)).join(' + '))).join(', ')}</p>` : ''; })()}
      <div class="pl-endbtns">
        <button class="btn" data-act="pl-overtime">＋ Play an overtime round (round ${G.round + 1})</button>
        <button class="btn primary" data-act="pl-endclose">Finish game</button>
      </div>
      <div class="muted small">After finishing you can still change the scores, or start an overtime round from the banner. <a href="#" data-act="pl-undo">↶ Undo</a> goes back to the Fight phase.</div>
    </div></div>`;
  }

  // ------------------------------------------------------------------ actions
  function nextPhase() {
    if (G.ended) return;
    G.begun = true;
    if (G.phase < PHASES.length - 1) { G.phase++; return; }
    // end of turn: clear the active player's turn markers
    clearTurnMarks();
    if (G.turn === 'opp') aircraftToReserves();
    const second = G.first === 'me' ? 'opp' : 'me';
    if (G.turn === G.first) { G.phase = 0; G.turn = second; return; }
    // end of the battle round
    if (G.round === 3) reservesLost();
    if (G.round >= lastRound()) { G.ended = true; G.showEnd = true; return; }
    G.phase = 0; G.turn = G.first; G.round = G.round + 1;
  }
  function startOvertime() {
    G.ended = false; G.showEnd = false;
    G.lastRound = G.round + 1;
    G.round = G.round + 1; G.phase = 0; G.turn = G.first;
  }
  function clearTurnMarks() { Object.values(G.units).forEach(u => TURN_MARKS.forEach(([k]) => { delete u.marks[k]; })); }

  document.addEventListener('click', (ev) => {
    if (!G) return;
    const el = ev.target.closest('[data-act]');
    if (!el || !/^pl-/.test(el.dataset.act)) return;
    const a = el.dataset.act, k = el.dataset.k;
    if (el.tagName === 'A') ev.preventDefault();
    switch (a) {
      case 'pl-exit': close(); break;
      case 'pl-wound-chart': woundOpen = true; render(); break;
      case 'pl-remtoggle': remOpen = !remOpen; render(); break;
      case 'pl-restoggle': resOpen = !resOpen; render(); break;
      case 'pl-rem': if (remExpanded.has(k)) remExpanded.delete(k); else remExpanded.add(k); render(); break;
      case 'pl-wound-close': if (ev.target.closest('[data-act]') === el && (el.classList.contains('icon') || ev.target === el)) { woundOpen = false; render(); } break;
      case 'pl-wr-box': break;
      case 'pl-wr': if (k === 's') wS = Math.max(1, Math.min(30, wS + Number(el.dataset.n))); else wT = Math.max(1, Math.min(30, wT + Number(el.dataset.n))); render(); break;
      case 'pl-undo': if (history.length) { G = JSON.parse(history.pop()); save(); render(); } break;
      case 'pl-reset': if (confirm('Start a new game? This clears all wounds, scores, markers and reserves.')) { history = []; G = blank(); initReserves(); save(); render(); } break;
      case 'pl-sel': sel = k; tab = 'unit'; render(); $('.pl-detail').scrollTop = 0; break;
      case 'pl-army': tab = 'army'; render(); break;
      case 'pl-add': change(() => {
        const side = el.dataset.side, f = el.dataset.f, s = G[side];
        const before = s[f]; s[f] = Math.max(0, s[f] + Number(el.dataset.n));
        if ((f === 'pri' || f === 'sec') && s[f] !== before) logScore(side, f, s[f] - before);
      }); break;
      case 'pl-scores': scoresOpen = true; render(); break;
      case 'pl-scores-close': if (el.classList.contains('icon') || ev.target === el) { scoresOpen = false; render(); } break;
      case 'pl-cpboth': change(() => { G.me.cp++; G.opp.cp++; }); break;
      case 'pl-round': change(() => { G.round = Math.max(1, Math.min(Math.max(9, lastRound()), G.round + Number(el.dataset.n))); if (G.round <= lastRound() && G.ended && Number(el.dataset.n) < 0) { G.ended = false; G.showEnd = false; } }); break;
      case 'pl-overtime': change(startOvertime); break;
      case 'pl-endclose': change(() => { G.showEnd = false; }); break;
      case 'pl-endshow': change(() => { G.showEnd = true; }); break;
      case 'pl-turn': change(() => { G.turn = G.turn === 'me' ? 'opp' : 'me'; if (G.round === 1 && G.phase === 0) G.first = G.turn; }); break;
      case 'pl-phase': change(() => { G.phase = Number(el.dataset.i); }); break;
      case 'pl-next': { pendingToast = ''; change(nextPhase); if (pendingToast) A.toast(pendingToast, 8000); break; }
      case 'pl-res': change(() => setReserve(k, el.dataset.v === '1')); break;
      case 'pl-disembark': change(() => embark(k, null)); break;
      case 'pl-arrive': change(() => { arrive(k); if (el.dataset.cp === '1') G.me.cp = Math.max(0, G.me.cp - 1); }); break;
      case 'pl-wound': change(() => {
        const ms = mstate(k, el.dataset.g), w = Number(el.dataset.w);
        const g = findGroup(k, el.dataset.g); if (!g || ms.lost >= g.count) return;
        ms.dmg++; if (ms.dmg >= w) { ms.dmg = 0; ms.lost++; }
      }); break;
      case 'pl-wset': change(() => {
        const ms = mstate(k, el.dataset.g), w = Number(el.dataset.w), p = Number(el.dataset.p);
        // tap pip p: that model now has p wounds left; tapping the last remaining pip takes one more off
        const remaining = w - ms.dmg;
        const next = p === remaining ? p - 1 : p;
        if (next <= 0) { ms.dmg = 0; ms.lost++; } else ms.dmg = w - next;
      }); break;
      case 'pl-kill': change(() => {
        const ms = mstate(k, el.dataset.g), n = Number(el.dataset.n);
        const g = findGroup(k, el.dataset.g); if (!g) return;
        if (n < 0) { if (ms.dmg) ms.dmg = 0; else ms.lost = Math.max(0, ms.lost - 1); }
        else { ms.lost = Math.min(g.count, ms.lost + 1); ms.dmg = 0; }
      }); break;
      case 'pl-destroy': change(() => { const u = units().find(x => x.key === k); if (!u) return; modelGroups(u).forEach(g => { const ms = mstate(k, g.key); ms.lost = g.count; ms.dmg = 0; }); }); break;
      case 'pl-mark': change(() => { const m = U(k).marks; m[el.dataset.m] = !m[el.dataset.m]; }); break;
      case 'pl-bs': change(() => {
        if (!G.bsTests) G.bsTests = {}; if (!G.bsTests[G.round]) G.bsTests[G.round] = {};
        const m = U(k).marks;
        if (!G.bsBefore) G.bsBefore = {}; G.bsBefore[G.round + '|' + k] = !!m.bs;
        G.bsTests[G.round][k] = el.dataset.r;
        if (el.dataset.r === 'pass') delete m.bs; else m.bs = true;
      }); break;
      case 'pl-bsundo': change(() => {
        const r = G.bsTests && G.bsTests[G.round] && G.bsTests[G.round][k];
        if (!r) return;
        delete G.bsTests[G.round][k];
        // put the marker back how it was before the roll: a failed roll on a unit that wasn't shocked set it
        const m = U(k).marks; const before = (G.bsBefore || {})[G.round + '|' + k];
        if (before !== undefined) { if (before) m.bs = true; else delete m.bs; }
      }); break;
      case 'pl-once': change(() => { const o = U(k).once; o[el.dataset.n] = !o[el.dataset.n]; }); break;
    }
  });
  document.addEventListener('change', (ev) => {
    if (!G) return;
    const t = ev.target;
    if (t.dataset && t.dataset.actInput === 'pl-oppname') change(() => { G.opp.name = t.value.trim() || 'Opponent'; });
    if (t.dataset && t.dataset.actInput === 'pl-emb') change(() => embark(t.dataset.k, t.value || null));
  });
  function findGroup(k, gk) { const u = units().find(x => x.key === k); return u ? modelGroups(u).find(g => g.key === gk) : null; }

  function closeQuiet() { document.body.classList.remove('playing'); G = null; }
  window.Play = { init(api) { A = api; }, open, close, closeQuiet, isOpen: () => !!G };
})();
