# Unreal Engine Import Guide

This template is **UE-compatible at the asset/export boundary**: it runs Y-up in
metres internally (Three.js + Ammo.js convention), but every asset and coordinate
can be moved into Unreal's **Z-up, centimetre** space cleanly. This guide covers
the round trip in both directions.

---

## 1. Coordinate & unit convention

| | This template (Three.js) | Unreal Engine |
|---|---|---|
| Up axis | **+Y** | **+Z** |
| Units | metres | centimetres |
| Handedness | right-handed | left-handed |

**Conversion rule (game → UE):** rotate **+90° about X** (Y-up → Z-up) and scale
**× 100** (m → cm). UE's glTF importer also flips handedness automatically.

The in-game exporter (`UeExporter`, press **P**) bakes this conversion into
`level_ue.glb`, so you import it with *no* further axis/scale changes.

---

## 2. Exporting from the game (press **P**)

Pressing **P** in-game downloads two files:

- **`level_ue.glb`** — static level + prop geometry, **pre-converted** to UE space
  (Z-up, centimetres). Skinned characters are excluded on purpose (see §4).
- **`mechanics.json`** — the entities and their tunable mechanics (player speeds,
  weapon stats, NPC AI params, spawn positions). This is the *blueprint data* you
  map onto UE Blueprints / Data Assets. Conforms to
  [`data/mechanics.schema.json`](../data/mechanics.schema.json). Coordinates are
  in the game's native Y-up metres — apply the §1 rule to place them in UE.

### Importing `level_ue.glb`
1. **Content Browser → Import**, choose `level_ue.glb`.
2. Because the file is **already** Z-up/cm:
   - Uniform Scale: **1.0**
   - "Convert Scene" / "Force Front XAxis": **off** (leave defaults that do *not*
     re-rotate; the file is pre-oriented).
3. Import as Static Mesh(es). Drag into the level — geometry lands at UE-correct
   scale and orientation.

> If you ever export the **raw** Three.js scene (un-baked, Y-up/m) instead, then
> let UE's glTF importer do the conversion: enable axis conversion and set uniform
> scale **100**. Do not double-convert.

---

## 3. The player character (UE Mannequin)

The player avatar is the **UE Mannequin** and is *already* a UE-native asset, so it
round-trips with zero conversion:

- **Mesh + animations:** `assets/characters/ue/SK_Mannequin.glb` — a single GLB
  baked from the source UE FBX (`SK_Mannequin.FBX` + `A_Rifle_*.FBX`) by
  [`tools/ue_fbx_to_glb.html`](../tools/ue_fbx_to_glb.html). It contains the full
  UE4 skeleton (`root` / `pelvis` / `spine_01` …) and four clips: `idle`, `walk`,
  `reload`, `shoot`.
- **Back into UE:** import the original FBX (`assets/characters/ue/*.FBX`) the
  normal way — it *is* the Unreal source. Retarget the four rifle animations onto
  your UE5 Manny/Quinn via IK Retargeter if needed (the source `.mb`/`HIK` rigs in
  `_Character/UE_Anim` carry the Human-IK setup).

The runtime applies a fixed −90° X tilt + 0.01 scale to render this UE asset upright
in metres — that is the inverse of the §1 rule and never touches the source file.

---

## 4. Why characters are excluded from `level_ue.glb`

Skinned-mesh export through a browser GLTF exporter is lossy (skeletons/clips do not
survive a generic clone cleanly). Characters therefore round-trip from their
**source assets** instead:

- Player → `SK_Mannequin.FBX` (+ `A_Rifle_*.FBX`) — native UE.
- Enemy → the mutant FBX in `assets/animations/` (Mixamo rig); import via FBX and
  retarget as desired.

This keeps the geometry export robust while giving you lossless characters.

---

## 5. Recreating mechanics in UE

`mechanics.json` is a faithful inventory, not executable script. Typical mapping:

| mechanics.json | UE target |
|---|---|
| `PlayerControls` (walkSpeed, sprint, jump, tpsDistance) | Character Movement Component + Spring Arm |
| `WeaponManager.weapons[]` (fireRate, damage, magSize, ammo) | Weapon Data Asset / Blueprint vars |
| `CharacterController` (health, attackDistance, maxViewDistance) | Enemy AI Blueprint + Behaviour Tree / Perception |
| entity `position` (× conversion) | Actor spawn transform |

Full Blueprint/`.uasset` generation is out of scope (it cannot be produced from a
browser). The JSON is designed to be read by a small editor utility or copied by
hand into Data Assets.

---

## 6. Optional: offline GLB pipeline (needs Blender)

`tools/` carries the reference Blender scripts (`fbx_verify.py`, `glb_anim_split.py`,
`glb_weapon_rigged.py`, …) for an offline FBX↔GLB pipeline with full skeleton/anim
fidelity. These require a local **Blender** install (not bundled). The in-browser
converter (`tools/ue_fbx_to_glb.html`, run via `tools/convert_ue.mjs`) covers the
mannequin without Blender.
