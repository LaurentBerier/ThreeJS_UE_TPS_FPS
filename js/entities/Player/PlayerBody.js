import * as THREE from 'three'
import Component from '../../Component.js'
import { buildUeMannequin, UE_BODY_LAYER, collectUpperBoneNames, splitClipByBones } from '../Common/UeMannequin.js'


// Full-body player avatar: the Unreal Engine Mannequin (SK_Mannequin) driven by UE rifle
// animations and holding the AK in its right hand. The avatar lives in the world at the player's
// physics capsule and faces the look direction. In first-person it is rendered only on a dedicated
// layer the FP camera ignores (so you still see its shadow, not your own torso); in third-person
// it is shown normally. See SetCameraMode.
//
// The UE import fix, body/chest-logo textures and the in-hand weapon socket are shared with the
// enemy soldier via buildUeMannequin. The UE clips bake root motion onto the 'root' bone, which
// we lock every frame so locomotion plays in place (the capsule drives movement).
//
// ANIM GRAPH. A small directional locomotion state machine — idle + four directional jogs
// (jogF/jogB/jogL/jogR) chosen from the move direction relative to facing — plus a jump sub-graph
// (jumpStart one-shot -> jumpFall loop) that overrides the body while airborne. Every state change
// is a short crossfade; jog<->jog carries the gait phase so the feet don't skate; the directional
// jogs are FOOT-SYNCED (playback rate = ground speed / authored jog speed) so they match the floor
// at any speed. See UpdateLocomotion / DesiredLocoState / UpdateAirState / LocoTimeScale.
//
// The pose is layered into two independent body halves so the torso can act while the legs keep
// moving. Each clip is split (splitClipByBones) into a LOWER half (pelvis + legs) and an UPPER half
// (spine + arms + head). The lower layer plays the resolved locomotion; the upper layer normally
// mirrors it, but a one-shot (reload/shoot) takes over the upper layer alone — so you reload or fire
// while still moving. The two layers drive disjoint bones, so they compose on one mixer. An additive
// spine lean (UpdateAimPose) points the gun at the look altitude while aiming.
export default class PlayerBody extends Component{
    constructor(model, clips, scene, camera, textures = null, weapon = null, preOriented = false){
        super();
        this.name = 'PlayerBody';
        this.model = model;            // GLB scene (SkeletonUtils.clone)
        this.clips = clips;            // { idle, jogF, jogB, jogL, jogR, jumpStart, jumpFall, reload, shoot }
        this.scene = scene;
        this.camera = camera;
        this.textures = textures;      // { bodyColor, bodyNormal, logoColor, logoNormal } (legacy only)
        this.weapon = weapon;          // cloned SK_AK47 mesh for the right hand
        this.preOriented = preOriented;// true => Y-up, metre-scaled GLB with baked PBR

        // --- Anim graph. The legs (lower) and torso (upper) are two independent layers on one
        // mixer (disjoint bone sets — see splitClipByBones). Locomotion is a small directional
        // state machine: idle + four directional jogs (jogF/jogB/jogL/jogR) chosen from the move
        // direction relative to facing, plus a jump sub-graph (jumpStart one-shot -> jumpFall loop)
        // that overrides the body while airborne. Every state change is a short crossfade. The
        // torso mirrors the legs' state unless a reload/shoot one-shot owns it.
        this.lowerActions = {};        // idle/jogF/jogB/jogL/jogR/jumpStart/jumpFall, pelvis + legs
        this.upperActions = {};        // same locomotion + reload/shoot, spine + arms + head
        this.lowerState = null;        // locomotion name currently driving the legs
        this.upperState = null;        // locomotion name currently driving the torso
        this.oneShot = null;           // name of an in-progress reload/shoot, or null
        // Jump sub-graph: null on the ground, else 'start' (jumpStart playing) or 'fall' (jumpFall
        // loop). _groundedTimer debounces ground re-detection so the 1-frame contact flicker on
        // take-off can't abort the jump and a brief mid-air graze can't snap the legs to idle.
        this.airState = null;
        this._groundedTimer = 0;
        this.airExitDebounce = 0.1;    // ground must be stable this long (s) before we leave the air state
        this._jumpRequested = false;   // set by the 'player.jump' event; re-arms the jumpStart launch
        this.playerControls = null;
        this.rootBone = null;
        this.rootRef = null;
        this.meshes = [];

        // idle/jump/reload play at a fixed rate; the directional jogs (jogF/jogB/jogL/jogR)
        // are FOOT-SYNCED instead — their playback rate is derived from the body's ground
        // speed each frame (see LocoTimeScale), so the feet match the floor at any speed and
        // the jog reads at its authored cadence. (A fixed slow timeScale skated the feet at
        // ~2x ground speed — the "weird/glitchy" jog that didn't match the source FBX.)
        // Names not listed default to 1.0 via the ?? in LocoTimeScale (jumpStart/jumpFall/jogs).
        this.stateTimeScale = { idle: 1.0, reload: 1.0, shoot: 1.5 };

        // Foot-sync constants. The jog bakes a ground/foot speed of authoredJogSpeed m/s at
        // timeScale 1.0 (root motion 1020.002 cm * 0.01 armature scale / 1.7333 s, measured
        // straight from the source jog FBX). Playing it at timeScale = bodySpeed/authoredJogSpeed
        // makes the feet track the ground with no skate (~1.19x at the 7 m/s jog, ~1.90x at sprint).
        this.authoredJogSpeed = 5.884628;                     // m/s baked into the jog at timeScale 1.0
        this.invAuthoredJogSpeed = 1 / this.authoredJogSpeed; // per-(m/s) timeScale factor
        // Keep cadence sane: no slow-mo crawl at low speed, no flutter at the top. The normal
        // jog (1.19x) and sprint (1.90x) both sit inside this band so neither is clamped; the
        // bounds only catch brief sub-jog speeds during accel/decel and act as a safety net
        // (HorizontalSpeed is hard-clamped to maxSpeed, so 1.90x is the real max — 2.2 is insurance).
        this.locoTimeScaleMin = 0.7;
        this.locoTimeScaleMax = 2.2;
        this.locoSpeedDeadzone = 0.5;                         // below this, idle owns the pose (matches UpdateLocomotion)

        // Vertical offset from the capsule-tracked position (camera height) down
        // to the feet. Capsule is ~1.9 m tall and the camera sits 0.5 above its
        // centre; tuned so the mannequin's feet meet the ground.
        this.feetOffset = -1.45;
        // Yaw so the mannequin (faces +Z after the import tilt) aligns with the
        // look/move direction (camera looks down -Z), i.e. turn it to face -Z.
        this.yawOffset = Math.PI;
        // Third-person by default => visible to the main camera.
        this.cameraMode = 'TPS';

        // --- Body-turn delay (AAA "look around without turning"). The avatar does NOT
        // snap to the camera yaw. While moving or aiming it tracks the look direction
        // promptly so the walk/aim reads forward; while idle it holds still inside a yaw
        // deadzone and only trails the camera SOFTLY once you pan past it — so a small
        // look-around orbits the camera about a still character instead of spinning the
        // body, like Uncharted / The Last of Us. Movement and the shot ray are
        // camera-relative (PlayerControls / FP-authoritative), so this is purely cosmetic
        // and never changes where you walk or shoot.
        this._bodyYaw = null;                              // persisted, eased body yaw (rad); seeded on first update
        this.bodyTurnDeadzone = THREE.MathUtils.degToRad(45); // idle look-around arc before the body follows
        this.bodyTurnIdleLerp = 5.0;                       // soft idle catch-up (1/s) — the turn "delay"
        this.bodyTurnMoveLerp = 14.0;                      // prompt alignment while moving / aiming (1/s)

        // --- Head dither-dissolve (TPS only). When the camera comes close enough
        // that the head fills a big chunk of the screen — aiming from cover, backed
        // against a wall, the boom dollied in by collision — the head DISSOLVES away
        // via an interleaved-gradient-noise dither so it never blocks the shot. It's
        // driven by the head's estimated screen-HEIGHT coverage: the dissolve begins
        // at coverFadeStart (~30%) and the head is fully gone by coverFadeEnd.
        //
        // The head is part of the body skinned mesh (not a separate object), so the
        // dissolve is done in the material shader: fragments within a world-space
        // sphere around the head bone are dither-discarded, weighted by headDither.
        // FPS needs none of this (the camera near plane already culls the head).
        //
        // The .value holders are the literal shader uniforms — shared across every
        // body material so one per-frame write updates them all (see InstallHeadDither).
        this.headDither = { value: 0 };                  // 0 = solid head, 1 = fully dissolved
        this.headCenter = { value: new THREE.Vector3() };// head sphere centre, world space
        this.headDitherInner = { value: 0.16 };          // within this radius (m) the head fully dissolves
        this.headDitherOuter = { value: 0.27 };          // dither feathers out to 0 by here (m) — neck blend
        this.headCenterUp = 0.08;                        // raise the centre from the neck-top bone onto the skull
        this.headCoverRadius = 0.13;                     // head radius (m) used to estimate screen coverage
        this.coverFadeStart = 0.30;                      // screen-height fraction where the dissolve begins
        this.coverFadeEnd = 0.52;                        // ...and where the head is fully hidden
        this.headDitherLerp = 14;                        // ease rate for the dissolve in/out (1/s)
        this._camWorld = new THREE.Vector3();            // scratch: camera world position
        // Whole-body camera-proximity dissolve (same shader): when collision floors the
        // boom and the lens ends up jammed against the character, the WHOLE body — not
        // just the head — stipples away so it never fills the screen / clips the lens.
        // Tuned tight so the over-the-shoulder back stays solid at normal aim distance and
        // only dissolves once collision has pulled the camera in near tpsMinDistance.
        this.headProxNear = { value: 0.45 };             // camera distance (m) at/under which the body is gone
        this.headProxFar  = { value: 0.90 };             // ...and beyond which it's fully solid

        // --- Additive look-pitch lean (TPS). Procedurally lean the spine chain (which
        // carries the arms + gun) toward the look ALTITUDE so the third-person weapon points
        // where you aim up/down. Active whenever the TPS body is on screen — NOT only while
        // holding aim — so the gun tracks the camera continuously; layered on top of the
        // played animation, eased in/out, and clamped so extreme look angles don't fold the
        // torso. Purely cosmetic (the shot ray stays camera-relative). Sign/gain are
        // rig-dependent; tune in-game (aimPitchGain = 0 disables; flip its sign if the lean
        // is inverted). See UpdateAimPose.
        this.aimBones = [];                              // [{bone, weight}] spine chain, filled in Initialize
        // TWO lean strengths (look DOWN pitches the torso/gun DOWN, and up -> up):
        //   * NOT aiming — a barely-there lean so the spine stays calm and the run reads
        //     natural (the strong always-on lean is what made the running torso buzz).
        //   * AIMING — the full STRONG lean so the third-person gun tracks the aim altitude.
        // The active gain eases between the two so entering/leaving aim glides, and the lean
        // angle itself is low-passed so camera micro-jitter can't buzz the spine while moving.
        this.aimPitchGainIdle = 0.16;                    // subtle look-lean when NOT aiming
        this.aimPitchGainAim  = 1.0;                     // full gun-tracking lean while aiming (unchanged)
        this._aimGain = this.aimPitchGainIdle;           // eased current strength
        this.aimGainLerp = 7;                            // ease rate between the two strengths (1/s)
        this.aimPitchMax = THREE.MathUtils.degToRad(75); // clamp on the total lean so a full up/down look doesn't fold the torso
        this.aimPitchLerp = 12;                          // ease rate for blending the lean in/out (1/s)
        this._aimPitchWeight = 0;                        // smoothed 0..1 lean blend (ramps with TPS on screen)
        this._aimPitchValue = 0;                         // low-passed lean angle (rad) — kills running jitter
        this._aimRight = new THREE.Vector3();
        this._aimR = new THREE.Quaternion();
        this._aimPW = new THREE.Quaternion();
        this._aimPWInv = new THREE.Quaternion();
        this._aimDelta = new THREE.Quaternion();

        // --- Additive YAW convergence on camera COLLISION push-in (TPS). At the normal boom length
        // the over-the-shoulder framing puts the reticle in front of the gun, but when a wall dollies
        // the camera IN close (collision), the framing collapses and the right-hand gun ends up
        // pointing BESIDE the reticle. A small additive yaw on the SAME spine chain (about world up)
        // toes the gun back onto the aim target, scaled by how far collision has pushed the camera in
        // (PlayerControls.CameraPushIn, 0..1). Sign: + is CCW about vertical (turns the gun LEFT
        // toward the reticle — the correction needed here); flip the sign if a future rig converges
        // the other way. Layered on top of the pitch lean, eased/clamped the same way, and purely
        // cosmetic (the shot ray stays camera-relative). Tune collisionAimYaw in-game like the pitch.
        this.collisionAimYaw = THREE.MathUtils.degToRad(8); // full correction at max collision push-in (CCW+) — TUNE
        this.aimYawMax  = THREE.MathUtils.degToRad(20);  // clamp so it can never wrench the torso sideways
        this._aimYawValue = 0;                            // eased / low-passed current yaw (rad)
        this._aimUp = new THREE.Vector3(0, 1, 0);         // world up — the yaw axis
        this._aimYawQ = new THREE.Quaternion();           // scratch: per-bone yaw rotation

        // --- Hip/body stabilization on camera PROXIMITY. When the camera is close to the character
        // (aiming, or collision pushing the boom in), the locomotion bob/sway reads as an unstable
        // character right in front of the lens. We damp the PELVIS toward a settled (low-passed)
        // pose — which calms the hips AND everything that rides them (torso, head, the close camera)
        // — while the LEGS, children of the pelvis, keep their full stride so the feet still plant.
        // Capped (hipStabMax < 1) so a subtle wobble always remains to convey the locomotion.
        this._pelvisBone = null;
        this._pelvisRefPos = new THREE.Vector3();
        this._pelvisRefQuat = new THREE.Quaternion();
        this._hipRefSeeded = false;
        this._hipStab = 0;                                // eased current stabilization 0..1
        this.hipStabMax = 0.9;                            // cap (1 = frozen hips); leaves a subtle wobble
        this.hipStabLerp = 8;                             // ease rate (1/s) entering/leaving stabilization
        this.hipRefLerp = 1.5;                            // low-pass rate (1/s) for the settled pelvis reference

        // --- Recently-fired window. The additive aim pose ALSO activates when the camera is close
        // and you're shooting from the hip (not aiming), so the gun re-points at the reticle for the
        // collapsed close-camera framing. Set on each shot; decays so burst/auto fire keeps it on.
        this._shootHold = 0;
        this.shootHoldTime = 0.25;                        // s the aim pose lingers active after a shot
        this.aimProxThreshold = 0.4;                      // camera proximity above which hip-fire engages the aim pose
    }

    SetupAnimations(){
        this.mixer = new THREE.AnimationMixer(this.model);

        // Bones from spine_01 up are the "upper body"; everything else is "lower".
        const upperBones = collectUpperBoneNames(this.model, 'spine_01');

        // Looping locomotion (idle + the four directional jogs) drives BOTH layers: the lower
        // half plays on the legs, the matching upper half on the torso whenever no one-shot owns it.
        ['idle', 'jogF', 'jogB', 'jogL', 'jogR'].forEach(name => {
            const clip = this.clips[name];
            if(!clip){ return; }
            const { upper, lower } = splitClipByBones(clip, upperBones);
            this.lowerActions[name] = this.mixer.clipAction(lower);
            this.upperActions[name] = this.mixer.clipAction(upper);
        });

        // Jump sub-graph (full-body, both layers): jumpStart is a one-shot launch that CLAMPS on
        // its last frame, then hands off to the looping jumpFall (which is also the fall pose).
        const jumpStartClip = this.clips['jumpStart'];
        if(jumpStartClip){
            const { upper, lower } = splitClipByBones(jumpStartClip, upperBones);
            const lo = this.mixer.clipAction(lower); lo.setLoop(THREE.LoopOnce); lo.clampWhenFinished = true;
            const up = this.mixer.clipAction(upper); up.setLoop(THREE.LoopOnce); up.clampWhenFinished = true;
            this.lowerActions['jumpStart'] = lo;
            this.upperActions['jumpStart'] = up;
        }
        const jumpFallClip = this.clips['jumpFall'];
        if(jumpFallClip){
            const { upper, lower } = splitClipByBones(jumpFallClip, upperBones);
            this.lowerActions['jumpFall'] = this.mixer.clipAction(lower);
            this.upperActions['jumpFall'] = this.mixer.clipAction(upper);
        }

        // reload/shoot are UPPER-body-only one-shots that layer over the torso while
        // the legs keep their locomotion. Only the upper half of each clip is used.
        ['reload', 'shoot'].forEach(name => {
            const clip = this.clips[name];
            if(!clip){ return; }
            const { upper } = splitClipByBones(clip, upperBones);
            const a = this.mixer.clipAction(upper);
            a.setLoop(THREE.LoopOnce);
            a.clampWhenFinished = true;
            this.upperActions[name] = a;
        });

        this.mixer.addEventListener('finished', this.OnOneShotFinished);
    }

    Initialize(){
        this.playerControls = this.GetComponent('PlayerControls');

        // Shared UE avatar build: import fix, textured material, AK socketed to hand_r.
        const built = buildUeMannequin(this.model, { textures: this.textures, weapon: this.weapon, preOriented: this.preOriented });
        this.modelRoot = built.modelRoot;
        this.rootBone = built.rootBone;
        this.headBone = built.headBone;         // first-person camera rides this bone
        this.meshes = built.meshes;
        this.weaponPivot = built.weaponPivot;   // in-hand AK group; used by WeaponPlacementDebug
        this._headWorld = new THREE.Vector3();

        if(this.rootBone){
            this.rootRef = {
                position: this.rootBone.position.clone(),
                quaternion: this.rootBone.quaternion.clone(),
                scale: this.rootBone.scale.clone(),
            };
        }

        this.SetupAnimations();

        // Wire the head dither-dissolve into the body materials (not the in-hand
        // weapon — it's nowhere near the head sphere, so skip the shader cost).
        const weaponMeshes = new Set();
        if(this.weaponPivot){ this.weaponPivot.traverse(o => { if(o.isMesh){ weaponMeshes.add(o); } }); }
        for(const mesh of this.meshes){
            if(weaponMeshes.has(mesh)){ continue; }
            this.InstallHeadDither(mesh.material);
        }

        // Spine chain (root -> tip) for the additive aim-pitch, with weights that sum to 1
        // so the total lean is shared smoothly up the torso rather than snapping at one joint.
        const spineWeights = { spine_01: 0.30, spine_02: 0.35, spine_03: 0.35 };
        const spineBones = {};
        this.model.traverse(o => { if(o.isBone && spineWeights[o.name]){ spineBones[o.name] = o; } });
        ['spine_01', 'spine_02', 'spine_03'].forEach(n => {
            if(spineBones[n]){ this.aimBones.push({ bone: spineBones[n], weight: spineWeights[n] }); }
        });

        // Pelvis (hips) for proximity stabilization; seed the settled-pose reference from its bind.
        this.model.traverse(o => { if(o.isBone && o.name === 'pelvis'){ this._pelvisBone = o; } });
        if(this._pelvisBone){
            this._pelvisRefPos.copy(this._pelvisBone.position);
            this._pelvisRefQuat.copy(this._pelvisBone.quaternion);
            this._hipRefSeeded = true;
        }

        this.scene.add(this.modelRoot);

        // Let the level's shadow-casting light see UE_BODY_LAYER so the avatar still
        // throws a shadow even when hidden from the FP camera.
        let light = null;
        this.scene.traverse(o => { if(o.isLight && o.shadow){ light = o; } });
        if(light){ light.shadow.camera.layers.enable(UE_BODY_LAYER); }

        this.SetCameraMode(this.cameraMode);
        this.SetLowerState('idle');
        this.SetUpperState('idle');

        // React to TPS/FPS toggles broadcast by PlayerControls.
        this.parent.RegisterEventHandler(this.OnCameraMode, 'camera.mode');
        // Optional body reactions to weapon actions.
        this.parent.RegisterEventHandler(this.OnReload, 'weapon.reload');
        this.parent.RegisterEventHandler(this.OnShoot, 'weapon.shoot');
        // Take-off: PlayerControls fires this the frame a jump is issued (see its comment for why
        // IsGrounded can't be used). We re-arm the jump sub-graph so the jumpStart pop always plays.
        this.parent.RegisterEventHandler(this.OnJump, 'player.jump');
    }

    // Back-compat alias: the leg (locomotion) state is the body's overall state for
    // callers that just want "is it walking/idle" (QA harness, debug overlays).
    get currentState(){ return this.lowerState; }

    OnCameraMode = (msg) => { this.SetCameraMode(msg.mode); }
    OnReload = () => { this.PlayOneShot('reload'); }
    OnShoot = () => { this.PlayOneShot('shoot'); this._shootHold = this.shootHoldTime; }
    OnJump = () => { this._jumpRequested = true; }

    // The same full-body avatar is rendered in BOTH camera modes now: in TPS the
    // boom looks at it from behind; in FPS the camera rides its head bone and the
    // head mesh is culled by the camera's near plane (see PlayerControls). So the
    // body always stays on the visible layer — we no longer hide it for first-person.
    SetCameraMode(mode){
        this.cameraMode = mode;
        for(const mesh of this.meshes){
            mesh.layers.set(0);
        }
    }

    // First-person eye anchor: the head bone's current world position. Returns false
    // if there's no head bone so the caller can fall back to the capsule eye height.
    GetHeadWorldPosition(target){
        if(!this.headBone){ return false; }
        this.headBone.getWorldPosition(target);
        return true;
    }

    // Patch a body material so it dither-dissolves the head when the camera is close.
    // Fragments inside a world-space sphere around the head bone (uHeadCenter, radii
    // uHeadInner..uHeadOuter) are discarded via an interleaved-gradient-noise dither,
    // weighted by uHeadDither (0 = solid, 1 = gone). The uniforms reference this
    // component's shared .value holders, so UpdateHeadDither drives every body
    // material at once. Skinning/shadows are untouched — the depth (shadow) pass uses
    // a different material, so the head keeps casting its shadow while it dissolves.
    InstallHeadDither(material){
        if(!material || material._headDitherInstalled){ return; }
        material._headDitherInstalled = true;
        const prev = material.onBeforeCompile;
        material.onBeforeCompile = (shader, renderer) => {
            if(prev){ prev(shader, renderer); }
            shader.uniforms.uHeadDither = this.headDither;
            shader.uniforms.uHeadCenter = this.headCenter;
            shader.uniforms.uHeadInner  = this.headDitherInner;
            shader.uniforms.uHeadOuter  = this.headDitherOuter;
            shader.uniforms.uHeadProxNear = this.headProxNear;
            shader.uniforms.uHeadProxFar  = this.headProxFar;

            // Vertex: carry the fragment's WORLD position (post-skinning) through. At
            // <project_vertex> `transformed` is the skinned local position, so
            // modelMatrix * transformed is its animated world position.
            shader.vertexShader = shader.vertexShader
                .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPosHD;')
                .replace('#include <project_vertex>',
                    '#include <project_vertex>\n\tvWorldPosHD = (modelMatrix * vec4(transformed, 1.0)).xyz;');

            // Fragment: discard head fragments by an ordered dither so the dissolve
            // looks like a fine stipple rather than fading to transparent.
            shader.fragmentShader = shader.fragmentShader
                .replace('#include <common>',
                    '#include <common>\n' +
                    'varying vec3 vWorldPosHD;\n' +
                    'uniform float uHeadDither;\n' +
                    'uniform vec3 uHeadCenter;\n' +
                    'uniform float uHeadInner;\n' +
                    'uniform float uHeadOuter;\n' +
                    'uniform float uHeadProxNear;\n' +
                    'uniform float uHeadProxFar;\n' +
                    'float ignHD(vec2 p){ return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }')
                .replace('#include <clipping_planes_fragment>',
                    '#include <clipping_planes_fragment>\n' +
                    // Head-region dissolve (screen-coverage driven, head sphere only)...
                    'float cutoffHD = 0.0;\n' +
                    'if(uHeadDither > 0.001){\n' +
                    '\tfloat dHD = distance(vWorldPosHD, uHeadCenter);\n' +
                    '\tfloat regionHD = 1.0 - smoothstep(uHeadInner, uHeadOuter, dHD);\n' +
                    '\tcutoffHD = uHeadDither * regionHD;\n' +
                    '}\n' +
                    // ...combined with a whole-body camera-proximity dissolve so a floored,
                    // jammed-in lens dissolves the entire body, not only the head.
                    'float distHD = length(vViewPosition);\n' +
                    'cutoffHD = max(cutoffHD, 1.0 - smoothstep(uHeadProxNear, uHeadProxFar, distHD));\n' +
                    'if(cutoffHD > 0.0 && ignHD(gl_FragCoord.xy) < cutoffHD){ discard; }');
        };
        material.needsUpdate = true;
    }

    // Per-frame: place the head sphere on the head bone and ease the dissolve amount
    // toward the target implied by how much of the screen HEIGHT the head fills.
    // TPS only — in FPS the camera near plane already culls the head.
    UpdateHeadDither(t){
        let target = 0;
        if(this.cameraMode === 'TPS' && this.headBone && this.camera){
            // Head sphere centre: the head bone, raised onto the skull.
            this.headBone.getWorldPosition(this.headCenter.value);
            this.headCenter.value.y += this.headCenterUp;

            // Screen-HEIGHT fraction the head covers ≈ headRadius / (dist * tan(fovV/2)).
            // (Vertical view extent at `dist` is 2*dist*tan(fovV/2); head diameter is
            // 2*headCoverRadius.) Past coverFadeStart the dissolve ramps to full by end.
            this.camera.getWorldPosition(this._camWorld);
            const dist = this._camWorld.distanceTo(this.headCenter.value);
            const halfV = THREE.MathUtils.degToRad(this.camera.fov) * 0.5;
            const cover = this.headCoverRadius / Math.max(0.001, dist * Math.tan(halfV));
            target = THREE.MathUtils.clamp(
                (cover - this.coverFadeStart) / Math.max(1e-4, this.coverFadeEnd - this.coverFadeStart), 0, 1);
        }
        const k = 1 - Math.exp(-this.headDitherLerp * t);
        this.headDither.value += (target - this.headDither.value) * k;
    }

    // True for the four foot-synced directional jog states (NOT idle/jump/reload/shoot).
    IsJogState(name){
        return name === 'jogF' || name === 'jogB' || name === 'jogL' || name === 'jogR';
    }

    // Foot-synced timeScale for a locomotion action: the directional jogs scale with the body's
    // ground speed so the feet match the floor; idle/jump/reload/shoot keep their fixed rate.
    // Pinned to the floor under the idle deadzone so a stop/start never momentarily freezes the
    // cadence mid-crossfade. Multiplies by a constant (never divides by speed) so it can't NaN.
    LocoTimeScale(name){
        if(!this.IsJogState(name)){
            return this.stateTimeScale[name] ?? 1.0;
        }
        const speed = this.playerControls ? this.playerControls.HorizontalSpeed : 0;
        if(speed <= this.locoSpeedDeadzone){ return this.locoTimeScaleMin; }
        return THREE.MathUtils.clamp(
            speed * this.invAuthoredJogSpeed, this.locoTimeScaleMin, this.locoTimeScaleMax);
    }

    // Short crossfade duration (s) for a locomotion state transition, AAA-style: snap into the
    // jump launch, hand off start->fall quickly, settle into idle a touch faster than a plain
    // direction change, and land back to the ground with a brief blend.
    LocoFade(from, to){
        if(to === 'jumpStart'){ return 0.08; }                         // into the launch
        if(from === 'jumpStart' && to === 'jumpFall'){ return 0.10; }  // quick start -> fall
        if(from === 'jumpStart' || from === 'jumpFall'){ return 0.15; }// landing -> ground
        if(to === 'idle'){ return 0.12; }                              // settle to idle on stop
        return 0.15;                                                   // jog<->jog direction change
    }

    // Legs: crossfade between locomotion states independently of anything the torso is doing.
    SetLowerState(name, fade = 0.2){
        if(this.lowerState === name || !this.lowerActions[name]){ return; }
        const next = this.lowerActions[name];
        const prev = this.lowerState ? this.lowerActions[this.lowerState] : null;
        next.reset();
        next.setEffectiveWeight(1.0);
        next.setEffectiveTimeScale(this.LocoTimeScale(name));
        // Carry the gait phase across a DIRECTION change so the feet don't snap to a new cycle
        // phase and skate during the crossfade. The directional jogs have different durations, so
        // match by NORMALISED phase. idle/jump transitions start fresh (reset()'s time 0 stands).
        if(prev && this.IsJogState(name) && this.IsJogState(this.lowerState)){
            const pd = prev.getClip().duration || 1;
            next.time = (pd > 0 ? (prev.time % pd) / pd : 0) * (next.getClip().duration || 0);
        }
        next.play();
        if(prev){ next.crossFadeFrom(prev, fade, true); }
        this.lowerState = name;
    }

    // Torso: crossfade to an upper-body locomotion (or aim) action — but never while
    // a one-shot reload/shoot owns the upper layer.
    SetUpperState(name){
        if(this.oneShot || this.upperState === name || !this.upperActions[name]){ return; }
        this.PlayUpperLocomotion(name, 0.2);
    }

    // Holding precise-aim in third-person? While aiming the torso holds a steady aim
    // pose instead of mirroring the legs. For now that pose is the upper half of the
    // idle clip (a placeholder); a dedicated aim clip / blend space replaces it later.
    IsAiming(){
        return !!(this.playerControls && this.playerControls.aiming && this.cameraMode === 'TPS');
    }

    // The upper-body locomotion the torso should hold given the legs' state and aim: the steady
    // aim pose (idle upper) while aiming on the ground, otherwise mirror whatever the legs do
    // (including the jump sub-states — the torso jumps/falls with the body).
    DesiredUpperState(legs){
        if(this.IsAiming() && legs !== 'jumpStart' && legs !== 'jumpFall'){ return 'idle'; }
        return legs;
    }

    // Start an upper-body locomotion action, phase-matched to the legs so the torso
    // bob stays in sync with the footfalls of the same walk/run cycle.
    PlayUpperLocomotion(name, fade){
        const next = this.upperActions[name];
        if(!next){ return; }
        next.reset();
        next.setEffectiveTimeScale(this.LocoTimeScale(name));
        next.play();
        if(this.lowerActions[name]){ next.time = this.lowerActions[name].time; }
        // Make `next` the upper-body primary (full weight now, others fade out) — this is what
        // guarantees the layer never flashes the bind/T-pose between clips. See SetUpperPrimary.
        this.SetUpperPrimary(next, fade);
        this.upperState = name;
    }

    // Make `primary` the sole full-weight action on the UPPER layer: snap it to weight 1
    // immediately (NOT a fade-IN from 0 — that can momentarily empty the layer and bare the
    // bind/T-pose, since the spine/arms/head are driven ONLY by this layer) and fade every
    // other live upper action OUT. The mixer blends by relative weight, so a full-weight
    // incoming + a fading outgoing still reads as a crossfade, but the layer's total weight
    // stays ~1 at all times — so the upper body can never snap to its bind pose for a frame.
    SetUpperPrimary(primary, fade){
        primary.enabled = true;
        primary.stopFading();
        primary.setEffectiveWeight(1.0);
        for(const key in this.upperActions){
            const a = this.upperActions[key];
            if(a !== primary && a.enabled && a.getEffectiveWeight() > 1e-3){
                a.fadeOut(fade);
            }
        }
    }

    PlayOneShot(name){
        const action = this.upperActions[name];
        if(!action){ return; }
        // Already mid one-shot of this clip (continuous fire re-triggers 'shoot' every shot):
        // just restart its time so it pulses again — it is already the upper-body primary.
        if(this.oneShot === name){
            action.time = 0;
            action.setEffectiveWeight(1.0);
            return;
        }
        this.oneShot = name;
        action.reset();
        action.setEffectiveTimeScale(this.stateTimeScale[name] ?? 1.0);
        action.play();
        // Layer over the torso (the legs keep their own locomotion on the lower layer): make
        // this one-shot the upper-body primary, fading out the locomotion AND any prior
        // one-shot — so the layer is never left empty for a frame (no bind/T-pose flash).
        this.SetUpperPrimary(action, 0.1);
    }

    OnOneShotFinished = (e) => {
        // The mixer fires 'finished' for ANY LoopOnce action, so ignore a stale
        // finish from a one-shot we've already moved on from — e.g. a lingering
        // 'shoot' action ending just after a reload began. Acting on it would clear
        // the active one-shot and cut the reload short.
        if(!this.oneShot || (e && e.action !== this.upperActions[this.oneShot])){
            return;
        }
        const finished = this.oneShot;
        this.oneShot = null;
        // The third-person body reload is the visible one in TPS, so let it drive the
        // mag refill — shooting resumes the instant this anim ends instead of waiting
        // on the longer (hidden) first-person arms reload clip. ReloadDone is
        // idempotent, so the later FP-clip finish is a harmless no-op.
        if(finished === 'reload'){
            this.Broadcast({topic: 'reload.done'});
        }
        // Blend the torso back from the clamped one-shot pose to whatever it should
        // hold now (aim pose if still aiming, else the legs' locomotion), so the
        // upper and lower layers realign.
        this.upperState = finished;                  // so PlayUpperLocomotion fades out of it
        this.PlayUpperLocomotion(this.DesiredUpperState(this.lowerState || 'idle'), 0.15);
    }

    // Ground locomotion state from the move direction RELATIVE to facing. PlayerControls.speed is
    // the local (pre-yaw) velocity, and the body faces the same yaw, so speed.x/z are already
    // relative to facing: +x = right, -z = forward. The dominant axis picks the directional jog
    // (so W+D reads as a forward jog, A/D as a strafe), and the matching clip is what makes
    // jogging backward look correct instead of moon-walking the forward clip.
    DesiredLocoState(){
        const pc = this.playerControls;
        const speed = pc ? pc.HorizontalSpeed : 0;
        if(speed <= 0.5){ return 'idle'; }
        const vx = pc.speed.x, vz = pc.speed.z;
        if(Math.abs(vz) >= Math.abs(vx)){ return vz < 0 ? 'jogF' : 'jogB'; }
        return vx > 0 ? 'jogR' : 'jogL';
    }

    // Advance the jump sub-graph and return the loco state it wants: 'jumpStart' on entry, then
    // 'jumpFall' once the (clamped) launch clip has played out — "quickly transition to fall".
    UpdateAirState(){
        if(this.airState === null){ this.airState = 'start'; return 'jumpStart'; }
        if(this.airState === 'start'){
            const a = this.lowerActions['jumpStart'];
            if(!a || a.time >= a.getClip().duration - 0.02){ this.airState = 'fall'; return 'jumpFall'; }
            return 'jumpStart';
        }
        return 'jumpFall';
    }

    UpdateLocomotion(t){
        const pc = this.playerControls;
        const grounded = pc ? pc.IsGrounded : true;
        // Debounce ground re-detection: physics only sets canJump on contact, and the contact can
        // flicker for a frame at take-off. Require stable ground before leaving the air state.
        if(grounded){ this._groundedTimer += t; } else { this._groundedTimer = 0; }
        const stableGround = this._groundedTimer >= this.airExitDebounce;

        // A fresh take-off (incl. a bunny-hop re-jumped inside the landing debounce, where airState
        // would still be 'fall') clears the sub-graph to null so UpdateAirState replays from
        // 'start' below — SetLowerState('jumpStart') then reset()s the clamped launch clip so its
        // pop plays again, instead of silently continuing the jumpFall loop.
        if(this._jumpRequested){ this.airState = null; this._jumpRequested = false; }

        let loco;
        if(this.airState){
            if(stableGround){ this.airState = null; loco = this.DesiredLocoState(); }  // landed
            else { loco = this.UpdateAirState(); }
        }else{
            loco = grounded ? this.DesiredLocoState() : this.UpdateAirState();          // take off
        }

        // Legs always show the resolved locomotion; the torso mirrors it unless a one-shot owns it.
        this.SetLowerState(loco, this.LocoFade(this.lowerState, loco));
        const desiredUpper = this.DesiredUpperState(loco);
        if(!this.oneShot && this.upperState !== desiredUpper && this.upperActions[desiredUpper]){
            this.PlayUpperLocomotion(desiredUpper, this.LocoFade(this.upperState, desiredUpper));
        }
    }

    // Per-frame foot-sync: drive the timeScale of the CURRENTLY active lower (and matching upper)
    // directional-jog action from the live ground speed, so the feet keep matching the floor
    // through accel/decel and across every direction + sprint. Writing ONE identical value to both
    // layers keeps them phase-locked (the mixer advances both by the same delta*timeScale).
    // NOTE: setEffectiveTimeScale() internally calls stopWarping(), which discards the duration-warp
    // that crossFadeFrom(warp=true) sets up for a jog<->jog blend. That is intended: foot-sync OWNS
    // the playback rate (timeScale = ground speed / authored speed), so the warp must yield to it.
    // Gait phase is instead carried across direction changes by SetLowerState's normalised reseat.
    UpdateLocoTimeScale(){
        if(!this.IsJogState(this.lowerState)){ return; }
        const ts = this.LocoTimeScale(this.lowerState);
        const lower = this.lowerActions[this.lowerState];
        if(lower){ lower.setEffectiveTimeScale(ts); }
        // Mirror onto the upper layer only when it is running that same jog and no one-shot owns
        // it — so reload/shoot keep their own timing and idle/jump stay at their fixed rate.
        if(!this.oneShot && this.upperState === this.lowerState){
            const upper = this.upperActions[this.upperState];
            if(upper){ upper.setEffectiveTimeScale(ts); }
        }
    }

    Update(t){
        if(!this.mixer){ return; }

        this.mixer.update(t);
        if(this._shootHold > 0){ this._shootHold = Math.max(0, this._shootHold - t); }

        // Strip root motion so the clip animates in place; the capsule moves us.
        if(this.rootBone && this.rootRef){
            this.rootBone.position.copy(this.rootRef.position);
            this.rootBone.quaternion.copy(this.rootRef.quaternion);
            this.rootBone.scale.copy(this.rootRef.scale);
        }

        // Follow the capsule; the facing is eased (not snapped) so panning the camera
        // doesn't instantly whip the body — see UpdateBodyYaw.
        const p = this.parent.Position;
        this.modelRoot.position.set(p.x, p.y + this.feetOffset, p.z);
        this.UpdateBodyYaw(t);
        // Damp the hip bob when the camera is close (aim / collision) so the character is stable in
        // front of the lens. Runs after the mixer/root-lock and BEFORE the spine aim lean, since the
        // lean reads the (now-stabilized) pelvis as its parent.
        this.StabilizeHips(t);
        // Additive lean so the arms + gun aim at the right altitude while aiming (or hip-firing
        // close). Runs after the body yaw (it reads the facing) and before the head dither (it moves
        // the head). It edits the animated pose this frame, on top of the mixer.
        this.UpdateAimPose(t);

        this.UpdateLocomotion(t);
        this.UpdateLocoTimeScale();   // foot-sync the live directional-jog playback rate to ground speed
        // Dissolve the head when the camera crowds it (TPS aim-from-cover).
        this.UpdateHeadDither(t);
    }

    // Damp the pelvis (hips) toward a settled, low-passed pose when the camera is CLOSE, so the
    // character is stable in front of the lens while aiming / when collision crowds the boom. The
    // legs are children of the pelvis, so they keep their full stride (feet still plant); only the
    // bob/sway that would ride up through the torso, head and the close camera is removed. The cap
    // (hipStabMax) always leaves a subtle wobble to convey the locomotion. Proximity-driven with
    // conditions: engages on aim OR collision proximity, and only while actually moving.
    StabilizeHips(t){
        if(!this._pelvisBone){ return; }
        const pc = this.playerControls;
        // Close = aiming (boom pulled in) OR raw camera proximity (collision push-in). TPS only.
        const close = (this.cameraMode === 'TPS')
            ? Math.max(this.IsAiming() ? 1 : 0, pc ? pc.CameraProximity : 0) : 0;
        const moving = this.IsJogState(this.lowerState);
        const target = (moving ? close : 0) * this.hipStabMax;
        this._hipStab += (target - this._hipStab) * (1 - Math.exp(-this.hipStabLerp * t));

        // Low-pass the freshly-animated pelvis (mixer just wrote it) into the bob-free reference.
        const b = this._pelvisBone;
        if(!this._hipRefSeeded){
            this._pelvisRefPos.copy(b.position); this._pelvisRefQuat.copy(b.quaternion);
            this._hipRefSeeded = true;
        }
        const k = 1 - Math.exp(-this.hipRefLerp * t);
        this._pelvisRefPos.lerp(b.position, k);
        this._pelvisRefQuat.slerp(b.quaternion, k);

        if(this._hipStab < 0.001){ return; }
        // Blend the live pelvis toward the settled pose: removes the bob/sway, keeps the baseline.
        b.position.lerp(this._pelvisRefPos, this._hipStab);
        b.quaternion.slerp(this._pelvisRefQuat, this._hipStab);
    }

    // Additive look-pitch lean: lean the spine chain by the look pitch so the arms + gun
    // point at the right altitude, layered on top of the played animation. Each bone is
    // rotated in its PARENT's world space about the character's horizontal right axis, so
    // the lean is a clean forward/back pitch regardless of the bone's local-axis convention.
    // Processing root -> tip and re-reading each parent's world orientation composes the
    // per-bone shares correctly. Active whenever the TPS body is on screen (so the gun
    // tracks the camera all the time, not just while aiming), eased in/out and clamped.
    UpdateAimPose(t){
        if(!this.aimBones.length){ return; }
        // Apply the additive gun lean when AIMING, or — the close-camera HIP-FIRE case — when the
        // camera is close (proximity) AND you're shooting: the collapsed close framing leaves the
        // over-shoulder gun pointing beside the reticle, so the pitch lean + collision-yaw re-aim it
        // along the new camera angle. Otherwise NOT aiming plays clean (the always-on lean made the
        // running torso buzz). FPS owns its own aim, so 0 there.
        const pc = this.playerControls;
        const prox = (this.cameraMode === 'TPS' && pc) ? pc.CameraProximity : 0;
        const hipFire = (this._shootHold > 0) && (prox >= this.aimProxThreshold);
        const aimLean = this.IsAiming() || hipFire;
        const active = (this.cameraMode === 'TPS' && aimLean) ? 1 : 0;
        this._aimPitchWeight += (active - this._aimPitchWeight) * (1 - Math.exp(-this.aimPitchLerp * t));

        // Ease the lean STRENGTH between the subtle idle value and the strong aim value so the
        // torso glides into/out of the aiming lean instead of popping (and stays calm running).
        const targetGain = aimLean ? this.aimPitchGainAim : this.aimPitchGainIdle;
        this._aimGain += (targetGain - this._aimGain) * (1 - Math.exp(-this.aimGainLerp * t));
        if(this._aimPitchWeight < 0.001){ return; }

        // Target lean = look pitch * eased gain, NEGATED so looking down pitches the torso/gun
        // down (the rig leaned the wrong way before), clamped so a full up/down look leans the
        // torso strongly but doesn't fold it in half.
        const targetPitch = THREE.MathUtils.clamp(
            -this.playerControls.angles.x * this._aimGain, -this.aimPitchMax, this.aimPitchMax);
        // Low-pass the lean angle: when running, the camera pitch wobbles a little each frame and
        // feeding it straight to the spine made the upper body judder. Easing it smooths that out.
        this._aimPitchValue += (targetPitch - this._aimPitchValue) * (1 - Math.exp(-this.aimPitchLerp * t));
        const pitch = this._aimPitchValue * this._aimPitchWeight;

        // Collision yaw convergence: a small toe-in so the right-hand gun re-points AT the reticle
        // when a wall dollies the camera in close and the framing collapses. Scaled by the collision
        // push-in (0 = no correction at rest, →full at a jammed-in camera); clamped and low-passed
        // (shares the pitch ease rate so the two read as one smooth aim pose).
        const pushIn = this.playerControls ? this.playerControls.CameraPushIn : 0;
        const targetYaw = THREE.MathUtils.clamp(
            this.collisionAimYaw * pushIn, -this.aimYawMax, this.aimYawMax);
        this._aimYawValue += (targetYaw - this._aimYawValue) * (1 - Math.exp(-this.aimPitchLerp * t));
        const yaw = this._aimYawValue * this._aimPitchWeight;

        // Character right axis in world: local +X carried through the yaw-only facing.
        this._aimRight.set(Math.cos(this._bodyYaw), 0, -Math.sin(this._bodyYaw));
        for(const ab of this.aimBones){
            // World-space additive rotation for this bone's share: pitch about the character's
            // right axis, yaw about world up. Compose as world quaternions (yaw * pitch), then
            // convert into the bone's local space below.
            this._aimR.setFromAxisAngle(this._aimRight, pitch * ab.weight);
            this._aimYawQ.setFromAxisAngle(this._aimUp, yaw * ab.weight);
            this._aimR.premultiply(this._aimYawQ);
            ab.bone.parent.getWorldQuaternion(this._aimPW);   // reflects any earlier edits up-chain
            this._aimPWInv.copy(this._aimPW).invert();
            // newLocal = parentWorld^-1 * R * parentWorld * oldLocal
            this._aimDelta.copy(this._aimPWInv).multiply(this._aimR).multiply(this._aimPW);
            ab.bone.quaternion.premultiply(this._aimDelta);
        }
    }

    // Ease the avatar's facing toward the camera yaw instead of snapping to it. While
    // moving or aiming the body tracks promptly (the walk/aim must read forward); while
    // idle it stays put inside bodyTurnDeadzone and only trails the camera softly past
    // it, so looking around orbits the camera about a still character. Yaw maths use the
    // shortest signed arc (atan2 of sin/cos) so the body never spins the long way round.
    UpdateBodyYaw(t){
        const target = this.playerControls.angles.y + this.yawOffset;
        if(this._bodyYaw === null){ this._bodyYaw = target; }

        const responsive = this.playerControls.HorizontalSpeed > 0.5 || this.IsAiming();
        let goal = target;
        if(!responsive){
            // Idle: hold inside the deadzone; past it, trail the camera by exactly the
            // deadzone so the body follows gently rather than chasing every micro-pan.
            const diff = Math.atan2(Math.sin(target - this._bodyYaw), Math.cos(target - this._bodyYaw));
            goal = Math.abs(diff) <= this.bodyTurnDeadzone
                ? this._bodyYaw
                : this._bodyYaw + Math.sign(diff) * (Math.abs(diff) - this.bodyTurnDeadzone);
        }
        const rate = responsive ? this.bodyTurnMoveLerp : this.bodyTurnIdleLerp;
        const d = Math.atan2(Math.sin(goal - this._bodyYaw), Math.cos(goal - this._bodyYaw));
        this._bodyYaw += d * (1 - Math.exp(-rate * t));
        this._bodyYaw = Math.atan2(Math.sin(this._bodyYaw), Math.cos(this._bodyYaw));
        this.modelRoot.rotation.set(0, this._bodyYaw, 0);
    }
}
