/* Serialises BSData JSON in the same layout as the BSData repository files:
 * 2-space indent, and any object/array whose compact form ({"a": 1, "b": 2})
 * is <= 160 characters is kept on one line. */
(function (global) {
  'use strict';
  const WIDTH = 160;
  function compact(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(compact).join(', ') + ']';
    const ks = Object.keys(v).filter(k => v[k] !== undefined);
    return '{' + ks.map(k => JSON.stringify(k) + ': ' + compact(v[k])).join(', ') + '}';
  }
  function fmt(v, ind) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    const c = compact(v);
    if (c.length <= WIDTH) return c;
    const pad = '  '.repeat(ind + 1), end = '  '.repeat(ind);
    if (Array.isArray(v)) return '[\n' + v.map(x => pad + fmt(x, ind + 1)).join(',\n') + '\n' + end + ']';
    const ks = Object.keys(v).filter(k => v[k] !== undefined);
    return '{\n' + ks.map(k => pad + JSON.stringify(k) + ': ' + fmt(v[k], ind + 1)).join(',\n') + '\n' + end + '}';
  }
  global.BSFormat = { stringify: (doc) => fmt(doc, 0) + '\n', compact };
})(typeof window !== 'undefined' ? window : globalThis);
