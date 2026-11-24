#!/usr/bin/env python3
"""Convert BSData JSON files (wh40k-11e-main) into script files the offline app
can load straight from disk (file://), with no web server.

Usage:  python build_data.py [source_folder] [output_folder]
Defaults: source = ./wh40k-11e-main, output = ./data
(You can also skip this script entirely and use "Load data folder" inside the app.)
"""
import json, os, sys, glob, re, datetime

here = os.path.dirname(os.path.abspath(__file__))
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(here, 'wh40k-11e-main')
out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(here, 'data')
os.makedirs(out, exist_ok=True)

def safe(s):
    return re.sub(r'[^A-Za-z0-9_-]', '_', s)

manifest = {'gameSystem': None, 'catalogues': [], 'built': datetime.datetime.now().isoformat(timespec='seconds'), 'source': 'bundled'}
written = set()
for path in sorted(glob.glob(os.path.join(src, '*.json'))):
    with open(path, encoding='utf-8') as f:
        try:
            doc = json.load(f)
        except Exception as e:
            print('skip', path, e); continue
    kind = 'gameSystem' if 'gameSystem' in doc else ('catalogue' if 'catalogue' in doc else None)
    if not kind:
        continue
    o = doc[kind]
    fid = safe(o['id'])
    fname = fid + '.js'
    with open(os.path.join(out, fname), 'w', encoding='utf-8') as f:
        f.write('BSD_LOADED(' + json.dumps(o['id']) + ',')
        json.dump(doc, f, separators=(',', ':'), ensure_ascii=False)
        f.write(');\n')
    written.add(fname)
    info = {'id': o['id'], 'name': o.get('name', ''), 'file': fname, 'revision': o.get('revision')}
    if kind == 'gameSystem':
        manifest['gameSystem'] = info
    else:
        info['library'] = bool(o.get('library'))
        info['links'] = [{'id': l.get('targetId'), 'importRootEntries': bool(l.get('importRootEntries'))} for l in o.get('catalogueLinks', [])]
        manifest['catalogues'].append(info)
    print('ok ', o.get('name'))

with open(os.path.join(out, 'manifest.js'), 'w', encoding='utf-8') as f:
    f.write('window.BSD_MANIFEST = ' + json.dumps(manifest, ensure_ascii=False, indent=1) + ';\n')
# remove stale data files
for p in glob.glob(os.path.join(out, '*.js')):
    b = os.path.basename(p)
    if b != 'manifest.js' and b not in written:
        os.remove(p)
print('Done:', len(manifest['catalogues']), 'catalogues ->', out)
