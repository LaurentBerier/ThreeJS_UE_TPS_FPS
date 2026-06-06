# ThreeJS UE TPS/FPS Template

A console-grade **third-person _and_ first-person shooter** template for the Sandscape
app — built on Three.js, with an Unreal-Engine-friendly asset/export boundary and the
production touches that make a demo feel like a *game*: a cinematic spring-arm camera,
procedural aim leaning, physics ragdoll deaths, a living daytime sky, and enemies that
hunt you instead of orbiting a wall.

- **TPS + FPS in one** — boots third-person with the **UE Mannequin** on screen;
  press **V** to drop into first-person (arms + weapon) seamlessly. One
  look-orientation drives both views. The third-person camera is a true spring-arm
  **spline**: collision only dollies it in/out along the boom (never sideways, so your
  character never swings across frame), pull-in is instant so the lens can't knife
  through walls, and a near-plane **cull** plus a proximity **dither-dissolve** stipple
  away anything the lens crowds — head, body, even the enemy you're hugging — so the
  shot is never blocked.
- **Procedural aim leaning** — the third-person upper body bends to point the gun
  exactly where you look up/down. **Two-state** lean: barely-there while you're just
  moving and looking around (so the run reads natural and calm), ramping smoothly to a
  strong, gun-tracking lean the moment you aim down sights. The lean angle is
  low-passed so a jogging torso never judders.
- **Exact weapon aim + two-hand IK** — on top of that lean, an alignment layer rotates the
  in-hand gun so the **barrel points precisely at the crosshair's world target** — the *same*
  camera-centre ray the bullet uses, so there's no over-the-shoulder parallax between where you
  aim and where the gun visibly points. The aim **direction** tracks the crosshair live while the
  **depth** is eased, so the barrel and support arm don't snap as the crosshair crosses a near/far
  edge — and the bullet still uses the exact instantaneous hit, so accuracy is unchanged. A
  two-bone IK keeps the **support hand planted on the foregrip** (the dominant hand holds the grip
  for free — the gun pivots at its wrist). It engages only while **aiming or shooting** and blends
  out otherwise, so idle/jog locomotion is left exactly as authored; clamped + low-passed so it's
  responsive, not floaty. Works in TPS **and** FPS, is per-weapon tunable (grip/muzzle sockets,
  hand offsets, blend speeds), and ships with a live debug overlay (press **K**) drawing the aim
  target, the barrel vs. the corrected direction, and the IK grip sockets. See
  [WeaponAimIK.js](js/entities/Player/WeaponAimIK.js).
- **UE Mannequin player** (`SK_Mannequin`) driven by UE rifle animations, layered into
  independent **upper/lower body** halves — reload or fire from the torso while the legs
  keep their own walk/run cycle, with crossfades tuned so sprint start/stop stays smooth.
- **Enemy AI with teeth** — two archetypes: a **2×-scale root-motion beast** (melee
  bruiser) and a velocity-driven UE **soldier** (ranged gunner). Navmesh pathfinding, a
  patrol/chase/attack FSM, and awareness via a wide view cone **plus** a close proximity
  sense (both gated by line of sight) so a player beside or behind is *noticed*, not
  ignored. In the chase the beast **re-acquires your position several times a second**,
  so it tracks you tightly. And it can't get stuck: a decisive **failsafe** gives it two
  unstick tries (drop the blocking waypoint → repath); if it's still pinned mid-hunt, a
  small, subtle teleport breaks it loose.
- **Physics ragdoll deaths** — enemies don't play a canned death clip; they **crumple**.
  On death a self-contained verlet ragdoll is built from the character's own skeleton
  (inspired by the rapierjs-ragdoll demo) and takes over the skinned mesh, knocking the
  body away from the shot and letting it fold at the joints and settle on the ground.
  Works for both the mutant and the UE soldier rigs, with a safe fallback.
- **Living bright-day sky** — a drifting, FBM-noise **cloud deck** (ported from the
  SkibidiTower storm sky and re-graded for daylight) paints broken white cumulus across
  the blue, thinning to real sky gaps at the horizon and brightening on the sun side.
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
| **Double-tap Ctrl** | Forward dodge roll (momentum + i-frames, TPS & FPS) |
| **Left click** | Fire |
| **Right click** | Aim down sights (FP) |
| **R** | Reload |
| **1 / 2 / wheel** | Switch weapon |
| **V** | Toggle TPS ⇄ FPS |
| **P** | Export `level_ue.glb` + `mechanics.json` |

Dev toggles (off by default, no cost until pressed): **`** opens the in-hand weapon
**placement** tool (TPS) for nudging the grip transform; **K** toggles the weapon
**aim-IK debug** overlay (aim target, crosshair ray, barrel vs. corrected direction, IK
grip sockets, live blend value).

## Layout

```
index.html          importmap + ammo <script> + HUD/menu
serve.py            static server with correct .js/.wasm/.glb MIME types
js/
  entry.js          app bootstrap, asset loading, entity wiring, game loop
  Entity/EntityManager/Component/Input/FiniteStateMachine/AmmoLib   engine core
  entities/
    Player/         PlayerControls (dual camera: spline collision + near cull; aim-target raycast),
                    PlayerBody (UE Mannequin + two-state aim-pitch lean + weapon aim-IK driver), Hands (FP arms),
                    Weapon/WeaponManager/WeaponFSM, PlayerPhysics, PlayerHealth,
                    WeaponAimIK (exact barrel aim + two-hand IK) + WeaponAimDebug (K overlay) + WeaponPlacementDebug (` grip tool)
    NPC/            CharacterController/CharacterFSM (2× beast) + UeSoldierController/
                    UeSoldierFSM (ranged soldier): awareness + stuck-recovery, hitboxes,
                    Ragdoll (shared verlet death ragdoll for both rigs)
    Common/         UeMannequin (shared rig build), CameraDither (close-mesh dither rule)
    Level/          LevelSetup, Navmesh (three-pathfinding), BulletDecals
    Sky/            Sky2 (sky dome + light) + Clouds (drifting bright-day deck)
    UI/ AmmoBox/
  export/UeExporter.js   P-key glTF + mechanics export
assets/
  characters/ue/    SK_Mannequin_new.glb (Y-up mesh, baked PBR) + SK_Mannequin.glb (clip source) + source FBX
  vendor/ammo/      ammo.wasm.js + .wasm
  level.glb, navmesh.obj, guns/, animations/ (enemy), decals/, sounds/, ui/, css/
data/mechanics.schema.json   schema for the export "blueprint data"
docs/UE_IMPORT_GUIDE.md      UE round-trip guide (axis/scale, character retarget)
tools/
  ue_fbx_to_glb.html + convert_ue.mjs   bake the UE FBX -> SK_Mannequin.glb (headless)
  aim_test.mjs      headless aim-IK check (Chrome for Testing): barrel-on-target + two-hand
                    attachment, TPS & FPS  ->  node tools/aim_test.mjs
  smoke_test.mjs    headless regression check: boot, AI run-and-gun, ragdoll, dodge roll
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
  [WeaponManager.js](js/entities/Player/WeaponManager.js). A weapon can declare its own aim-IK
  sockets/offsets via an `ikConfig` (right/left grip, muzzle + `muzzleForwardAxis`, hand offsets,
  per-weapon correction strength/clamp — all in the in-hand weapon's local space), consumed by
  [WeaponAimIK.js](js/entities/Player/WeaponAimIK.js) on equip; omit it to auto-resolve the muzzle
  + barrel axis from the gun's bounding box and the grip sockets from where the clips pose the hands.
  The **global** aim/IK feel (blend speed, IK weight, correction strength + max-angle clamp,
  direction smoothing — `AimAlignmentBlendSpeed` / `WeaponIKBlendAlpha` / `AimCorrectionStrength` /
  `MaxAimCorrectionAngle` / `AimSmoothingSpeed`) is the default `opts` in
  [WeaponAimIK.js](js/entities/Player/WeaponAimIK.js) (overridable per weapon via `ikConfig`); the
  aim-**depth** smoothing rate is `aimDistLerp` in [PlayerControls.js](js/entities/Player/PlayerControls.js).
- **Level** — replace `assets/level.glb` + `assets/navmesh.obj` (export a matching
  navmesh from your level).
- **Enemy** — the melee beast keeps the mutant rig (root-motion), scaled 2× in
  [CharacterController.js](js/entities/NPC/CharacterController.js) (`modelScale`; the
  same factor scales the root-motion stride so the feet don't slide). To use the UE
  Mannequin for enemies too, switch `CharacterController` from root-motion to
  velocity-driven movement (the UE clips are in-place).
- **Ragdoll** — death physics is rig-agnostic
  ([Ragdoll.js](js/entities/NPC/Ragdoll.js)): it walks any SkinnedMesh's skeleton,
  keeps the major bones, and simulates them. Tune feel via `boneStiffness` /
  `braceStiffness` / `iterations`; the knock-back impulse is set where each controller
  calls `Die()`.
- **Sky / clouds** — re-grade the cloud deck in
  [Clouds.js](js/entities/Sky/Clouds.js) (coverage threshold, colours, `uTime` drift
  speed, sun direction) to swap bright day for overcast, dawn, etc.

## How UE compatibility works

The runtime stays Y-up / metres (Three.js + Ammo are Y-up); UE conventions live at
the **boundary**. The UE Mannequin GLB is stored in native UE space (Z-up, cm) and
the runtime applies a fixed −90° X tilt + 0.01 scale to render it upright. The
exporter applies the inverse (+90° X, ×100) so `level_ue.glb` drops into UE
oriented and scaled correctly. Details in
[docs/UE_IMPORT_GUIDE.md](docs/UE_IMPORT_GUIDE.md).

## Credits

Seeded from the [three-fps](https://github.com/mohsenheydari/three-fps) entity/
component demo (MIT). The death ragdoll is inspired by the
[rapierjs-ragdoll](https://mavon.ie/demos/rapierjs-ragdoll) demo (re-implemented as a
self-contained verlet sim on Ammo's world), and the drifting cloud deck is ported from
the in-house SkibidiTower storm sky and re-graded for daylight. AK-47, ammo box, mutant
and sky assets carry their original licences (see the reference project). UE Mannequin
© Epic Games.
