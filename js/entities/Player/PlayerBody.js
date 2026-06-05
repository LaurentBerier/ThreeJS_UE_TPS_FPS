import * as THREE from 'three'
import Component from '../../Component.js'
import { buildUeMannequin, UE_BODY_LAYER, collectUpperBoneNames, splitClipByBones } from '../Common/UeMannequin.js'


// Full-body player avatar: the Unreal Engine Mannequin (SK_Mannequin) driven by
// UE rifle animations (idle / walk / run / reload / shoot) and holding the AK in
// its right hand. The avatar lives in the world at the player's physics capsule
// and faces the look direction. In first-person it is rendered only on a dedicated
// layer the FP camera ignores (so you still see its shadow, not your own torso);
// in third-person it is shown normally. See SetCameraMode.
//
// The UE import fix, body/chest-logo textures and the in-hand weapon socket are
// shared with the enemy soldier via buildUeMannequin. The UE clips bake root
// motion onto the 'root' bone, which we lock every frame so locomotion plays in
// place (the capsule drives movement).
//
// Animation is layered into two independent body halves so the torso can act while
// the legs keep moving. Each locomotion clip is split (splitClipByBones) into a
// LOWER half (pelvis + legs) and an UPPER half (spine + arms + head). The lower
// layer always crossfades idle/walk/run from the player's speed; the upper layer
// normally mirrors that same locomotion, but a one-shot (reload/shoot) takes over
// the upper layer alone — so you reload or fire while still walking. The two layers
// drive disjoint bones, so they compose with no blend conflict on one mixer.
export default class PlayerBody extends Component{
    constructor(model, clips, scene, camera, textures = null, weapon = null, preOriented = false){
        super();
        this.name = 'PlayerBody';
        this.model = model;            // GLB scene (SkeletonUtils.clone)
        this.clips = clips;            // { idle, walk, run, reload, shoot }
        this.scene = scene;
        this.camera = camera;
        this.textures = textures;      // { bodyColor, bodyNormal, logoColor, logoNormal } (legacy only)
        this.weapon = weapon;          // cloned SK_AK47 mesh for the right hand
        this.preOriented = preOriented;// true => Y-up, metre-scaled GLB with baked PBR

        this.lowerActions = {};        // idle/walk/run, pelvis + legs
        this.upperActions = {};        // idle/walk/run + reload/shoot, spine + arms + head
        this.lowerState = null;        // locomotion name currently driving the legs
        this.upperState = null;        // locomotion name currently driving the torso
        this.oneShot = null;           // name of an in-progress reload/shoot, or null
        this.playerControls = null;
        this.rootBone = null;
        this.rootRef = null;
        this.meshes = [];

        // walk and run share the single UE jog clip; play it slower for a walk and
        // a touch faster for a sprint so the two locomotion states read distinctly.
        this.stateTimeScale = { idle: 1.0, walk: 0.6, run: 1.15, reload: 1.0, shoot: 1.5 };

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
    }

    SetupAnimations(){
        this.mixer = new THREE.AnimationMixer(this.model);

        // Bones from spine_01 up are the "upper body"; everything else is "lower".
        const upperBones = collectUpperBoneNames(this.model, 'spine_01');

        // Locomotion clips drive BOTH layers: the lower half plays on the legs, the
        // matching upper half plays on the torso whenever no one-shot owns it.
        ['idle', 'walk', 'run'].forEach(name => {
            const clip = this.clips[name];
            if(!clip){ return; }
            const { upper, lower } = splitClipByBones(clip, upperBones);
            this.lowerActions[name] = this.mixer.clipAction(lower);
            this.upperActions[name] = this.mixer.clipAction(upper);
        });

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
    }

    // Back-compat alias: the leg (locomotion) state is the body's overall state for
    // callers that just want "is it walking/idle" (QA harness, debug overlays).
    get currentState(){ return this.lowerState; }

    OnCameraMode = (msg) => { this.SetCameraMode(msg.mode); }
    OnReload = () => { this.PlayOneShot('reload'); }
    OnShoot = () => { this.PlayOneShot('shoot'); }

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

    // Legs: crossfade idle/walk/run independently of anything the torso is doing.
    SetLowerState(name){
        if(this.lowerState === name || !this.lowerActions[name]){ return; }
        const next = this.lowerActions[name];
        next.reset();
        next.setEffectiveWeight(1.0);
        next.setEffectiveTimeScale(this.stateTimeScale[name] ?? 1.0);
        next.play();
        if(this.lowerState && this.lowerActions[this.lowerState]){
            next.crossFadeFrom(this.lowerActions[this.lowerState], 0.3, true);
        }
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

    // The upper-body locomotion the torso should hold given the legs' state and aim:
    // the aim pose while aiming, otherwise whatever the legs are doing.
    DesiredUpperState(legs){
        return this.IsAiming() ? 'idle' : legs;
    }

    // Start an upper-body locomotion action, phase-matched to the legs so the torso
    // bob stays in sync with the footfalls of the same walk/run cycle.
    PlayUpperLocomotion(name, fade){
        const next = this.upperActions[name];
        if(!next){ return; }
        next.reset();
        next.setEffectiveTimeScale(this.stateTimeScale[name] ?? 1.0);
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

    UpdateLocomotion(){
        const speed = this.playerControls ? this.playerControls.HorizontalSpeed : 0;
        const grounded = this.playerControls ? this.playerControls.IsGrounded : true;
        let legs = 'idle';
        if(speed > 0.5 && grounded){
            legs = this.playerControls.isSprinting ? 'run' : 'walk';
        }
        // Crossfade the upper locomotion a touch slower than the default so the sprint
        // start/stop on the torso reads smooth rather than snapping between clips.
        const desiredUpper = this.DesiredUpperState(legs);
        if(!this.oneShot && this.upperState !== desiredUpper && this.upperActions[desiredUpper]){
            this.PlayUpperLocomotion(desiredUpper, 0.3);
        }
        this.SetLowerState(legs);
    }

    Update(t){
        if(!this.mixer){ return; }

        this.mixer.update(t);

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
        // Additive lean so the arms + gun aim at the right altitude while aiming. Runs
        // after the body yaw (it reads the facing) and before the head dither (it moves
        // the head). It edits the animated pose this frame, on top of the mixer.
        this.UpdateAimPose(t);

        this.UpdateLocomotion();
        // Dissolve the head when the camera crowds it (TPS aim-from-cover).
        this.UpdateHeadDither(t);
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
        // Lean whenever the third-person body is visible — the gun should always point where
        // the camera looks up/down, not only during precise-aim. (FPS owns its own aim, so 0.)
        const active = (this.cameraMode === 'TPS') ? 1 : 0;
        this._aimPitchWeight += (active - this._aimPitchWeight) * (1 - Math.exp(-this.aimPitchLerp * t));

        // Ease the lean STRENGTH between the subtle idle value and the strong aim value so the
        // torso glides into/out of the aiming lean instead of popping (and stays calm running).
        const targetGain = this.IsAiming() ? this.aimPitchGainAim : this.aimPitchGainIdle;
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
        // Character right axis in world: local +X carried through the yaw-only facing.
        this._aimRight.set(Math.cos(this._bodyYaw), 0, -Math.sin(this._bodyYaw));
        for(const ab of this.aimBones){
            this._aimR.setFromAxisAngle(this._aimRight, pitch * ab.weight);
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
