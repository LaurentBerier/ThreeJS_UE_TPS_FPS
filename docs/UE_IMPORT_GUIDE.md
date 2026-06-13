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

- **Mesh:** `assets/characters/ue/SK_Mannequin_new.glb` — a **Y-up, metre-scaled**
  GLB (Blender / Sandscape FBX→GLB converter) with baked PBR materials + OpenGL
  normal maps. It carries the full UE4 skeleton (`pelvis` / `spine_01` …) but no
  animation, and lands upright as-is (no tilt/scale; `preOriented: true`).
- **Animations:** the rifle clip set (`idle`, `walk`, directional jogs, `aim`,
  `reload`, `shoot`, jump start/fall) comes from the
  legacy `assets/characters/ue/SK_Mannequin.glb` (baked from `SK_Mannequin.FBX` +
  `A_Rifle_*.FBX` by [`tools/ue_fbx_to_glb.html`](../tools/ue_fbx_to_glb.html)) and
  are adapted onto the Y-up rig at load. The two rigs are byte-identical below the
  pelvis; the whole Z-up→Y-up difference is a `rotX(-90)` on the pelvis plus the
  0.01 armature scale, so `adaptClipToPreOriented` (in
  [`UeMannequin.js`](../js/entities/Common/UeMannequin.js)) drops the `root` track
  and rotates only the pelvis tracks.
- **Back into UE:** import the original FBX (`assets/characters/ue/*.FBX`) the
  normal way — it *is* the Unreal source. Retarget the rifle animations onto
  your UE5 Manny/Quinn via IK Retargeter if needed (the source `.mb`/`HIK` rigs in
  `_Character/UE_Anim` carry the Human-IK setup).

The runtime applies a fixed −90° X tilt + 0.01 scale to render this UE asset upright
in metres — that is the inverse of the §1 rule and never touches the source file.

**Body textures.** The GLB carries no images (the UE `.fbm` textures are TGA and do
not survive the FBX→glTF export), so the runtime reapplies them from the original
`.fbm` sidecar with `TGALoader` (r127 ships it): `M_MannequinUE4_Body_*` on the body
primitive and `M_MannequinUE4_ChestLogo_*` on the chest-logo primitive. The shared
builder [`js/entities/Common/UeMannequin.js`](../js/entities/Common/UeMannequin.js)
applies the import fix, these textures, and the in-hand weapon for **both** the
player body and the enemy soldier. Colour maps are tagged sRGB and loaded with
`flipY=false` (glTF UV convention); flip that flag on a map if it renders inverted.

**Third-person weapon.** The mannequin holds `assets/guns/New/SK_AK47.FBX` (a UE
SkeletalMesh AK, FBX v7300 — old enough for r127's FBXLoader). It is socketed into
the `hand_r` bone and auto-scaled to a rifle length, so it tracks the rifle clips'
hand pose. The first-person view keeps its own arms+gun viewmodel; the TPS AK hides
on the body's render layer in first-person (shadow only), like the body mesh.

While **aiming or shooting**, the player body also runs a cosmetic aim-alignment +
two-hand IK layer ([`WeaponAimIK.js`](../js/entities/Player/WeaponAimIK.js), driven by
`PlayerBody.UpdateWeaponAim`): it rotates the in-hand gun about the wrist so the barrel
points at the crosshair target (the same camera-centre ray the bullet uses) and two-bone
IKs the support arm (`upperarm_l` → `lowerarm_l` → `hand_l`) back onto the foregrip,
eased in only while aiming and out otherwise. In UE this maps to an **Aim Offset** plus a
hand **FABRIK / Control Rig** pass. It is player-only — the UE soldier (§7) does not use it.

**Locomotion clips.** The rifle set carries `idle`, a walk, directional jogs and
jump start/fall, but no sprint or death clip. A **run** is surfaced by
playing the jog slightly faster (`stateTimeScale` / `animTimeScale`). The **crouch**
is split: crouch-**idle** is an authored clip — `A_Rifle_Crouch_Idle.fbx`, baked to
`assets/characters/ue/CrouchIdle.glb` by
[`tools/run_crouchidle_bake.mjs`](../tools/run_crouchidle_bake.mjs) (see §"Baking UE
anim FBX" — r127's FBXLoader can't parse it) and driven as the `crouchIdle` loco state
so entering crouch is a smooth mixer crossfade (no body-drop + FootIK knee-snap);
crouch-**walk** has no clip, so it stays procedural (capsule resize + eased body-drop +
foot IK, [`FootIK.js`](../js/entities/Player/FootIK.js) — in UE this maps to a crouched
blendspace or a Control Rig foot-placement pass). **Death** hands the skinned
mesh to the shared verlet ragdoll
([`Ragdoll.js`](../js/entities/NPC/Ragdoll.js)) rather than playing a clip.

---

## 4. Why characters are excluded from `level_ue.glb`

Skinned-mesh export through a browser GLTF exporter is lossy (skeletons/clips do not
survive a generic clone cleanly). Characters therefore round-trip from their
**source assets** instead:

- Player → `SK_Mannequin.FBX` (+ `A_Rifle_*.FBX`) — native UE.
- Enemy (mutant) → the mutant FBX in `assets/animations/` (Mixamo rig); import via
  FBX and retarget as desired.
- Enemy (UE soldier) → the same `SK_Mannequin` rig + `A_Rifle_*` clips as the
  player. It reuses the UE source assets unchanged; in UE this is just the
  Mannequin driven by an AI controller. See §7 for the runtime difference.

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

---

## 7. Two enemy locomotion styles (root-motion vs velocity-driven)

The template ships two enemies side by side to contrast how locomotion can be
driven — useful when mapping to UE's own options:

| | Mutant (Mixamo) | UE soldier |
|---|---|---|
| Rig | mutant FBX | UE Mannequin (same as player) |
| Controller | [`CharacterController`](../js/entities/NPC/CharacterController.js) | [`UeSoldierController`](../js/entities/NPC/UeSoldierController.js) |
| Movement | **root motion** baked in the clip advances the body | explicit **velocity** (path-follow at a target speed, navmesh-clamped) |
| Animation | one clip keyed per FSM state | **chosen from the measured speed** (idle/walk/run) each frame |

The UE-soldier path is the one that maps cleanly onto a UE `CharacterMovementComponent`
+ a locomotion blendspace driven by `Velocity` — i.e. "velocity-driven". Both share
the same navmesh AI core (`patrol → chase → attack`/`combat`; the soldier adds a
**`search`** state that investigates the target's last-seen position before giving
up — in UE
terms, an extra Behaviour Tree branch off AI Perception's "lost sight" event) and
the bullet-hit volumes
([`UeSoldierCollision`](../js/entities/NPC/UeSoldierCollision.js) reads the UE bone
names; the mutant's reads Mixamo names). Death on both rigs is the shared verlet
ragdoll ([`Ragdoll.js`](../js/entities/NPC/Ragdoll.js)).
