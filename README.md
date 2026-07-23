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
  In first-person ADS the **arms hold the authored `A_Rifle_Aim` pose** (captured at load,
  blended in by the aim weight) so the elbows read right, while the dual-hand IK gently
  plants the hands on the gun — and the ADS FOV tightens to a real **~1.25× zoom**.
- **Movement feel** — a procedural **clipless crouch** (capsule resize + eased pose, no
  crouch clip needed; standing back up is gated on real head clearance) with a
  near-walk-speed crouch-walk; **foot/terrain IK** ([FootIK.js](js/entities/Player/FootIK.js))
  plants the feet on slopes and keeps crouched knees stable; and **forgiving jumps**:
  coyote time + a jump buffer so ledge edges and faceted terrain never eat the input, a
  crouch-jump that fires the same frame as a standing jump, and a one-shot **wall
  double-jump** — press jump again mid-air near any vertical surface for a boosted hop
  with a small kick off the wall. Brief ballistic hops over terrain crests stay in the
  ground locomotion (air-entry debounce) instead of flashing the jump pose.
- **Enemy AI with teeth** — two archetypes: a **2×-scale root-motion beast** (melee
  bruiser) and a velocity-driven UE **soldier** (ranged gunner). Navmesh pathfinding, a
  patrol/chase/attack FSM, and awareness via a wide view cone **plus** a close proximity
  sense (both gated by line of sight) so a player beside or behind is *noticed*, not
  ignored. A soldier that loses sight of you doesn't shrug and wander off: it walks to
  where it **last saw you, sweeps the area, and pokes nearby spots** (a `search` state
  between chase and patrol) — and being shot from anywhere snaps it straight back into
  the hunt. In the chase the beast **re-acquires your position several times a second**,
  so it tracks you tightly. And it can't get stuck: a decisive **failsafe** gives it two
  unstick tries (drop the blocking waypoint → repath); if it's still pinned mid-hunt, a
  small, subtle teleport breaks it loose.
- **Physics ragdoll deaths** — enemies don't play a canned death clip; they **crumple**.
  On death a self-contained verlet ragdoll is built from the character's own skeleton
  (inspired by the rapierjs-ragdoll demo) and takes over the skinned mesh, knocking the
  body away from the shot and letting it fold at the joints and settle on the ground.
  Works for both the mutant and the UE soldier rigs, with a safe fallback.
- **The journey to the castle** — the game is now a deliberate ~800 m trek across a dark
  sci-fi desert at golden hour, ending in a boss fight on a castle summit. The whole level
  is **generated at runtime** from one authored layout
  ([JourneyWorld.js](js/entities/World/JourneyWorld.js)): a path spine (start overlook →
  dune basin → buried ruins → canyon → wreck field → switchback ascent → fortified gate →
  summit arena) synthesises the terrain heightfield, the walkable navmesh is generated over
  the same data ([NavmeshGen.js](js/entities/World/NavmeshGen.js)), and the castle, gate,
  arches, collapsed walls, wreck hulks, barricades, parapets, banners and cyan tech seams
  are built with real static colliders ([Structures.js](js/entities/World/Structures.js))
  tagged exactly like the old level hulls — so bullet decals, impact VFX, AI line of sight
  and the TPS camera sweep work on them unchanged. The journey runs INTO the sunset: the
  ruined **gothic-brutalist castle** sits on the sun's bearing, permanently backlit, visible
  from nearly every outdoor beat, and it grows as you approach. Encounters ramp — 2 → 3 →
  ambush → soldiers + beast → overwatch → gate trio → the boss — with optional side spurs
  (overwatch ledge, canyon cache, vista parapet) paying out ammo.

  **The boss arena is enforced by level design, not scripts**: the entrance is a drop-in
  ledge too tall to jump back, and the slope cut it makes in the generated navmesh leaves
  the summit bowl a separate island — the beast's own movement clamp confines it there with
  zero special-case AI. A victory stair through a wall breach (structure, not navmesh) lets
  the player out afterwards. Around it all: the procedural dusk **sky**, three-layer
  **storm deck**, **dune sea** to the horizon, dust plumes, sun shafts, drifting sand and
  machinery smoke — none of it collidable, none of it at combat depth. Filmic (ACES) tone
  mapping, restrained bloom and a split-tone grade finish the frame
  ([js/PostFx.js](js/PostFx.js)). Combat readability stays a hard constraint: enemies carry
  a rim light added *after* shading, the sand stays the brightest surface, pickups get the
  world's only strong cyan emissive, fog is tuned to spare both combat range and the 600 m
  landmark. The old container depot (level.glb + navmesh.obj) is no longer loaded but stays
  on disk, as does the original bright-day sky
  ([Sky2.js](js/entities/Sky/Sky2.js) + [Clouds.js](js/entities/Sky/Clouds.js)).
- **Ammo.js physics** — capsule controller, raycast combat, bullet decals, ammo
  pickups, melee hitboxes.
- **UE export** — press **P** to download `level_ue.glb` (Z-up, centimetres) +
  `mechanics.json` (tunable "blueprint data"). See
  [docs/UE_IMPORT_GUIDE.md](docs/UE_IMPORT_GUIDE.md).
- **Buildless & fully self-contained** — native ES modules + importmap, no bundler
  and **no external/CDN fetches**: three.js + its addons, three-pathfinding, ammo.js
  and the HDR environment all ship vendored under `assets/`. This is what makes the
  game Sandscape-compatible (the platform serves the bundle statically, offline).

## Run

```bash
python serve.py          # or double-click Start-Server.bat on Windows
# open http://127.0.0.1:8070/index.html
```

Requires Python 3 (any 3.x). No `npm install`, no build step. Three.js r127, its
loaders, ammo.js and three-pathfinding all load from the **vendored** copies under
`assets/vendor/` via the importmap — nothing is fetched from a CDN, so the game runs
with no internet connection (and uploads intact to Sandscape's static host).

## Controls

| Input | Action |
|---|---|
| **W A S D** | Move |
| **Mouse** | Look (click to lock the pointer) |
| **Shift** | Sprint |
| **Space** | Jump (coyote time + buffered press; press again mid-air near a wall for the wall double-jump) |
| **C** (toggle) / **Alt** (hold) | Crouch |
| **Double-tap W/A/S/D** | Directional dodge roll (momentum + i-frames, TPS & FPS) |
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
    Player/         PlayerControls (dual camera: spline collision + near cull; aim-target raycast;
                    crouch/jump input incl. coyote + buffer + wall double-jump),
                    PlayerBody (UE Mannequin + two-state aim-pitch lean + weapon aim-IK driver), Hands (FP arms),
                    Weapon/WeaponManager/WeaponFSM, PlayerPhysics (crouch capsule resize + head-clearance check),
                    PlayerHealth, FootIK (terrain/crouch foot planting),
                    WeaponAimIK (exact barrel aim + two-hand IK) + WeaponAimDebug (K overlay) + WeaponPlacementDebug (` grip tool)
    NPC/            CharacterController/CharacterFSM (2× beast) + UeSoldierController/
                    UeSoldierFSM (ranged soldier): awareness + stuck-recovery, hitboxes,
                    Ragdoll (shared verlet death ragdoll for both rigs)
    Common/         UeMannequin (shared rig build), CameraDither (close-mesh dither rule)
    Level/          Terrain (heightfield mesh + trimesh collider + HeightAt), Navmesh
                    (three-pathfinding wrapper), BulletDecals; LevelSetup (archived depot loader)
    World/          the journey level + the desert look:
                    JourneyWorld (authored layout -> terrain heights, spawns, arenas),
                    Structures (castle/gate/ruins/wrecks WITH colliders + footprints),
                    NavmeshGen (walkable grid -> route mesh + the boss-arena island),
                    HdrEnvironment (.hdr -> cube env + SH light probe: r127-safe IBL),
                    DesertLook (palette + shared GLSL + material graders), DesertSky (dusk sky,
                    light rig, camera-following shadow frustum, fog), DesertClouds (storm deck),
                    DesertSurfaces (sand grading), FarWorld (horizon dunes/ridges/ruins/wrecks),
                    Atmosphere (drifting sand, dust plumes, sun shafts, machinery smoke),
                    ImpactFx (impact dust / sparks / chips, footstep puffs, muzzle light),
                    DesertActors (character
                    weathering + rim light + pickup glow)
    Sky/            Sky2 + Clouds — the ORIGINAL bright-day sky, kept for a one-line revert
    UI/ AmmoBox/
  export/UeExporter.js   P-key glTF + mechanics export
assets/
  characters/ue/    SK_Mannequin_new.glb (Y-up mesh, baked PBR) + SK_Mannequin.glb (clip source) + source FBX
  vendor/ammo/      ammo.wasm.js + .wasm
  vendor/three/     three r127 build + examples/jsm addons (vendored — no CDN)
  vendor/three-pathfinding/   three-pathfinding module (vendored)
  hdri/             venice_sunset_1k.hdr (scene IBL — see World/HdrEnvironment.js)
  level.glb, navmesh.obj, guns/, animations/ (enemy), decals/, sounds/, ui/, css/
data/mechanics.schema.json   schema for the export "blueprint data"
docs/UE_IMPORT_GUIDE.md      UE round-trip guide (axis/scale, character retarget)
tools/
  ue_fbx_to_glb.html + convert_ue.mjs   bake the UE FBX -> SK_Mannequin.glb (headless)
  aim_test.mjs      headless aim-IK check (Chrome for Testing): barrel-on-target + two-hand
                    attachment, TPS & FPS  ->  node tools/aim_test.mjs
  smoke_test.mjs    headless regression check: boot, AI run-and-gun, ragdoll, dodge roll
  diag_*.mjs / *_probe.mjs   focused headless probes (crouch camera/foot-IK/jump, foot
                    planting, shoot-pop, jitter, ragdoll settle) used while tuning feel
  *.py              reference Blender scripts (optional offline pipeline)
```

## Swapping in your own content

- **Player character** — the body mesh is `assets/characters/ue/SK_Mannequin_new.glb`,
  a **Y-up, metre-scaled** GLB with baked PBR materials (the house convention: ship
  assets Y-up for clean Three.js integration). Its rifle clips
  (`idle`/`walk`/directional jogs/`aim`/`reload`/`shoot`/jump start+fall) come from the
  legacy `SK_Mannequin.glb` and are adapted onto the Y-up rig at load (`adaptClipToPreOriented` in
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
- **Sky / clouds / the whole look** — the desert grade is driven from one place:
  `PALETTE`, `SUN_AZIMUTH` and `SUN_ELEVATION` in
  [DesertLook.js](js/entities/World/DesertLook.js). The sky dome, the fog colour, the light
  rig, the cloud deck, the far world's haze and every surface grader read from it, so
  changing the hour or the palette is a single edit rather than a hunt. Sun elevation is
  the load-bearing one: the ground receives `sin(elevation)` of the key, so lowering it
  makes the sky more dramatic and the sand deader. To go back to the template's bright day,
  point `entry.js` at [Sky2.js](js/entities/Sky/Sky2.js) + [Clouds.js](js/entities/Sky/Clouds.js)
  and drop the `World/` components (`assets/sky.jpg` is still shipped for it).

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
