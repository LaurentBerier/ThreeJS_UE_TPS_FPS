# ThreeJS UE TPS/FPS Template

A reusable **third-person _and_ first-person shooter** template for the Sandscape
app, built on Three.js with an Unreal-Engine-friendly asset/export boundary.

- **TPS + FPS in one** — boots third-person with the **UE Mannequin** visible;
  press **V** to switch to first-person (arms + weapon). One look-orientation
  drives both; the TPS camera has spring-arm wall collision.
- **UE Mannequin player** (`SK_Mannequin`) driven by UE rifle animations
  (idle / walk / reload / shoot).
- **Enemy AI** — navmesh pathfinding, line-of-sight, patrol/chase/attack FSM,
  root-motion locomotion (the reference mutant, kept as-is; turning hardened to
  stay upright through 180° reversals).
- **Ammo.js physics** — capsule controller, raycast combat, bullet decals, ammo
  pickups, melee hitboxes.
- **UE export** — press **P** to download `level_ue.glb` (Z-up, centimetres) +
  `mechanics.json` (tunable "blueprint data"). See
  [docs/UE_IMPORT_GUIDE.md](docs/UE_IMPORT_GUIDE.md).
- **Buildless** — native ES modules + importmap, no bundler. Served by a tiny
  Python static server (the Sandscape game format).

## Run

```bash
python serve.py          # or double-click Start-Server.bat on Windows
# open http://127.0.0.1:8070/index.html
```

Requires Python 3 (any 3.x). No `npm install`, no build step. Three.js, its
loaders, ammo.js and three-pathfinding load via importmap / a vendored WASM build.

## Controls

| Input | Action |
|---|---|
| **W A S D** | Move |
| **Mouse** | Look (click to lock the pointer) |
| **Shift** | Sprint |
| **Space** | Jump |
| **Left click** | Fire |
| **Right click** | Aim down sights (FP) |
| **R** | Reload |
| **1 / 2 / wheel** | Switch weapon |
| **V** | Toggle TPS ⇄ FPS |
| **P** | Export `level_ue.glb` + `mechanics.json` |

## Layout

```
index.html          importmap + ammo <script> + HUD/menu
serve.py            static server with correct .js/.wasm/.glb MIME types
js/
  entry.js          app bootstrap, asset loading, entity wiring, game loop
  Entity/EntityManager/Component/Input/FiniteStateMachine/AmmoLib   engine core
  entities/
    Player/         PlayerControls (dual camera), PlayerBody (UE Mannequin),
                    Hands (FP arms), Weapon/WeaponManager/WeaponFSM, PlayerPhysics, PlayerHealth
    NPC/            CharacterController + CharacterFSM (enemy AI), hitboxes
    Level/          LevelSetup, Navmesh (three-pathfinding), BulletDecals
    Sky/ UI/ AmmoBox/
  export/UeExporter.js   P-key glTF + mechanics export
assets/
  characters/ue/    SK_Mannequin_new.glb (Y-up mesh, baked PBR) + SK_Mannequin.glb (clip source) + source FBX
  vendor/ammo/      ammo.wasm.js + .wasm
  level.glb, navmesh.obj, guns/, animations/ (enemy), decals/, sounds/, ui/, css/
data/mechanics.schema.json   schema for the export "blueprint data"
docs/UE_IMPORT_GUIDE.md      UE round-trip guide (axis/scale, character retarget)
tools/
  ue_fbx_to_glb.html + convert_ue.mjs   bake the UE FBX -> SK_Mannequin.glb (headless)
  *.py              reference Blender scripts (optional offline pipeline)
```

## Swapping in your own content

- **Player character** — the body mesh is `assets/characters/ue/SK_Mannequin_new.glb`,
  a **Y-up, metre-scaled** GLB with baked PBR materials (the house convention: ship
  assets Y-up for clean Three.js integration). Its 4 rifle clips
  (`idle`/`walk`/`reload`/`shoot`) come from the legacy `SK_Mannequin.glb` and are
  adapted onto the Y-up rig at load (`adaptClipToPreOriented` in
  [UeMannequin.js](js/entities/Common/UeMannequin.js)). To swap in your own Y-up
  rigged GLB, point `ueChar` in [entry.js](js/entry.js) at it and build it with
  `preOriented: true`; tune `yawOffset` / `feetOffset` in
  [PlayerBody.js](js/entities/Player/PlayerBody.js) if your rig differs from the UE
  Mannequin. New FBX assets reorient + convert to Y-up GLB via the Sandscape
  FBX→GLB converter.
- **Weapons** — add a `Weapon` registry entry in
  [WeaponManager.js](js/entities/Player/WeaponManager.js).
- **Level** — replace `assets/level.glb` + `assets/navmesh.obj` (export a matching
  navmesh from your level).
- **Enemy** — the enemy keeps the mutant rig (root-motion). To use the UE Mannequin
  for enemies too, switch `CharacterController` from root-motion to velocity-driven
  movement (the UE clips are in-place).

## How UE compatibility works

The runtime stays Y-up / metres (Three.js + Ammo are Y-up); UE conventions live at
the **boundary**. The UE Mannequin GLB is stored in native UE space (Z-up, cm) and
the runtime applies a fixed −90° X tilt + 0.01 scale to render it upright. The
exporter applies the inverse (+90° X, ×100) so `level_ue.glb` drops into UE
oriented and scaled correctly. Details in
[docs/UE_IMPORT_GUIDE.md](docs/UE_IMPORT_GUIDE.md).

## Credits

Seeded from the [three-fps](https://github.com/mohsenheydari/three-fps) entity/
component demo (MIT). AK-47, ammo box, mutant and sky assets carry their original
licences (see the reference project). UE Mannequin © Epic Games.
