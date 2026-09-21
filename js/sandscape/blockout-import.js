// blockout-import.js — load an UNTEXTURED (greybox) Level Editor level into the game.
//
// The counterpart to level-import.js, for the case that one cannot cover. level-import reads
// ASSET PLACEMENTS: empty wrappers carrying `userData.modelPath`. A procgen level with no kit
// applied has none — the editor stores it as a seed and rebuilds the greybox from
// `userData.sandscapeProcgen` on load, so the saved document is layout parameters and nothing
// else. That is why an untextured level appears to "not load": there is genuinely nothing in the
// file to place, level-import correctly returns null, and the game builds its own level instead.
//
// The missing geometry is produced offline by `apps/client/tools/bake-blockout.mts`, which runs
// the EDITOR'S OWN emitter over that layout and writes a plain `Scene.toJSON()` document beside
// the scene (`<name>.blockout.json`). This module loads it with THREE's ObjectLoader — so the
// geometry, the greybox colours and the door frames' openings are the editor's, not a
// reconstruction. Nothing here derives anything: if it looks wrong, the bake is stale.
//
// Same design rules as level-import: FAIL SOFT (any miss returns null and the game builds its own
// level) and CACHE-BUST (a re-bake writes the same path in place).

const DEFAULT_CANDIDATES = ['scenes/level.blockout.json'];

/**
 * Fetch and parse a baked blockout level.
 *
 * @param {object}   THREE injected, never imported — one three instance per page (see kit-uv.js).
 * @param {object}   [opts]
 * @param {string[]} [opts.candidates] paths to try, first hit wins
 * @param {string}   [opts.param='blockout'] query param for override / 'off'
 * @returns {Promise<{group: object, markers: object[], source: string, meta: object}|null>}
 */
export async function loadBlockoutBake(THREE, opts = {}) {
  const { param = 'blockout' } = opts;
  const override = new URLSearchParams(location.search).get(param);
  if (override === 'off') return null;

  const candidates = [override, ...(opts.candidates || DEFAULT_CANDIDATES)].filter(Boolean);

  for (const path of candidates) {
    let doc;
    try {
      const res = await fetch(`${encodeURI(path)}?t=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) continue;
      doc = await res.json();
    } catch {
      continue;
    }

    const meta = doc && doc.object && doc.object.userData && doc.object.userData.sandscapeBlockoutBake;
    if (!meta) {
      // Refuse anything that is not a bake rather than parsing it hopefully. An ordinary edited
      // scene reaching this path would load its ASSET WRAPPERS as empty Object3Ds — an invisible,
      // collider-less level that looks like the game silently failed to draw anything.
      console.warn(`[blockout-import] ${path} is not a bake-blockout document — ignoring.`);
      continue;
    }

    let group;
    try {
      group = new THREE.ObjectLoader().parse(doc);
    } catch (err) {
      console.warn(`[blockout-import] ${path} failed to parse:`, err.message);
      continue;
    }
    if (!group.children.length) {
      console.warn(`[blockout-import] ${path} has no pieces — ignoring.`);
      continue;
    }

    // Gameplay MARKER icons are editor furniture, not level art: the emitter bakes a floating
    // cone / octahedron / gem (plus its heading arrow) for every spawn, encounter and special. They
    // are in the bake because the bake is "every proc piece", and a game that adds the group
    // wholesale renders them as scenery. Pull them out and hand them back separately — their
    // transform agrees with `layout.zones` by construction, so they are a usable cross-check on a
    // reader, never a replacement for it (the zones channel is the contract; see the README).
    const markers = group.children
      .filter((c) => c.userData && c.userData.procKind === 'marker');
    for (const m of markers) group.remove(m);

    console.log(
      `[blockout-import] ${path}: ${group.children.length} greybox pieces` +
      `${markers.length ? `, ${markers.length} gameplay markers held back` : ''} (seed ${meta.seed})`,
    );
    return { group, markers, source: path, meta };
  }

  return null;
}
