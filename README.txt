OFFLINE LIST BUILDER – Warhammer 40,000 (11th edition, BSData)
================================================================

START
  Double-click  index.html  (opens in your browser – Chrome or Edge recommended).
  No internet or install needed.

USER GUIDE
  Open  help.html  (or click the  ?  button at the top right of the list builder,
  or "? Help" in the data editor) for a full illustrated guide to every feature.

USING IT
  * Home screen: pick a faction, name, battle size and force type -> Create roster.
  * Left column: your army by category. Click a unit to edit it; ⧉ duplicates, ✕ removes.
    Detachment, Battle Size and Force Disposition sit under CONFIGURATION – click to change.
  * Middle column: "Add unit" list (search + category filters), or the selected unit's options.
  * Right column: the unit's datasheet (stats, weapons, abilities, rules, keywords).
  * Top bar: points total, Detachment Points, validation issues (click to list them),
    undo/redo (Ctrl+Z / Ctrl+Y), Export text, Print / PDF, Save file.
  * Rosters save automatically in this browser. Use "Save file" / "Import roster file…"
    to back them up or move them to another computer.

UPDATING THE DATA (when BSData publishes fixes)
  Option A (easiest): download the new wh40k-11e repo, open the app, and on the home screen
    click "Load data folder…" and pick the folder with the .json files.
    ("Use bundled data" switches back to the data/ folder.)
  Option B: replace the wh40k-11e-main folder and run:  python build_data.py
    (regenerates the data/ folder).

FILES
  index.html, css/, js/      the app
  data/                      the BSData files converted so the browser can load them offline
  build_data.py              rebuilds data/ from wh40k-11e-main/
  wh40k-11e-main/            your original BSData files (untouched)

LIMITATIONS
  * Leader/attachment ("associations") rules and a few cross-unit effects (e.g. weapon
    profile tweaks from upgrades, mostly Crusade content) are not modelled, so a handful
    of edge-case checks won't appear. Points, options, limits, detachments, enhancements
    and most validation follow the BSData rules.
  * Data is community-maintained by BSData and not endorsed by Games Workshop.
