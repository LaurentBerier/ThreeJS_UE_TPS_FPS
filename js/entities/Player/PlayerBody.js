import * as THREE from 'three'
import Component from '../../Component.js'
import { buildUeMannequin, UE_BODY_LAYER, collectUpperBoneNames, splitClipByBones, WEAPON_GRIP_DEFAULT, WEAPON_GRIP_FPS_DEFAULT, WEAPON_GRIP_FPS_AIM_DEFAULT } from '../Common/UeMannequin.js'
import WeaponAimIK from './WeaponAimIK.js'
import FootIK from './FootIK.js'
import HurtFlinch from '../Common/HurtFlinch.js'


// Force a clip to loop with ZERO seam: overwrite each track's LAST keyframe with a copy of its
// FIRST. The exported UE 'shoot' clip ends ~2.6° off where it began (the recoil doesn't fully settle
// back), so LoopRepeat jumps that small gap every wrap. On its own that gap is barely visible — but
// the weapon-aim IK and the additive spine lean re-solve from the freshly-animated pose every frame,
// and when the gun is aimed off to the side those corrections are LARGE, so they amplify the tiny
// seam into a ~30-40° one-frame snap of the arms/spine at the loop point (measured via
// tools/diag_shootpop.mjs: zero spikes firing straight, 40° spikes firing to the side, all exactly at
// the clip wrap). Zeroing the seam removes the discontinuity the corrections were amplifying. The gap
// is tiny, so snapping the last key to the first is visually negligible (the body still plays the full
// recoil, it just returns cleanly to the start each cycle). Mutates the clip in place; safe because
// splitClipByBones hands us freshly-cloned tracks.
function makeClipSeamlessLoop(clip){
    for(const track of clip.tracks){
        const v = track.values;
        const stride = track.getValueSize();           // 4 for quaternions, 3 for vectors
        if(!v || v.length < stride * 2){ continue; }
        const last = v.length - stride;
        for(let i = 0; i < stride; i++){ v[last + i] = v[i]; }   // last keyframe := first keyframe
    }
    return clip;
}


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
    constructor(model, clips, scene, camera, textures = null, weapon = null, preOriented = false, magReloadClip = null){
        super();
        this.name = 'PlayerBody';
        this.model = model;            // GLB scene (SkeletonUtils.clone)
        this.clips = clips;            // { idle, jogF, jogB, jogL, jogR, jumpStart, jumpFall, reload, shoot }
        this.scene = scene;
        this.camera = camera;
        this.textures = textures;      // { bodyColor, bodyNormal, logoColor, logoNormal } (legacy only)
        this.weapon = weapon;          // cloned SK_AK47 mesh for the right hand
        this.preOriented = preOriented;// true => Y-up, metre-scaled GLB with baked PBR
        // In-hand AK magazine-reload clip ('Magazine' bone tracks only — the whole-gun 'Root'
        // motion was stripped at load so the gun stays socketed in the hand). Played on THIS
        // body's mixer in lockstep with the reload one-shot (see PlayGunReload); null if unbaked.
        this.magReloadClip = magReloadClip;
        this.gunReloadAction = null;   // mixer action for magReloadClip, built in SetupAnimations

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
        // Forward dodge roll: a FULL-BODY one-shot (both layers) that overrides locomotion AND any
        // upper one-shot for its duration, then blends straight back to locomotion. Driven by the
        // 'player.roll' event from PlayerControls (which owns the input, momentum + i-frames). The
        // root motion is stripped like every clip, so the physical displacement is the capsule's —
        // the animation just sells the roll in place. Works in TPS and FPS (FP camera rides the head).
        this.rolling = false;
        this._rollDuration = 0;        // seconds (read from the clip in SetupAnimations)
        this.rollTimeScale = 1.25;     // play the ~0.97s roll a touch faster so it reads snappy/responsive
        // Cut the last few frames of the roll's stand-up and instead ease into idle/locomotion over a
        // longer crossfade, so the recovery blends smoothly into the resting pose rather than snapping
        // off the clip's final frame. rollEndLead is in CLIP seconds (the roll bakes at 30 fps).
        this.rollEndLead = 5 / 30;     // end the clip ~5 frames early...
        // Blend out with SEPARATE lengths per body half. The legs just settle into the idle/jog stance
        // (a moderate fade), but the TORSO + arms carry the rifle: the roll tucks them away from the
        // gun-hold pose, so they get a noticeably LONGER crossfade to ease the weapon back up into the
        // idle holding pose instead of snapping it into the hands.
        this.rollBlendOut = 0.35;      // legs -> idle (settling to a stop: a moderate fade)
        // When the roll ends while STILL MOVING, snap the legs into the matching jog over a much
        // SHORTER fade so they're "walking the moment the feet touch back down" — a long blend leaves
        // the roll pose mixed with the jog for too long and the (foot-synced) feet skate over the
        // ground. The jog's playback rate is foot-synced to the live ground speed from frame one
        // (LocoTimeScale in SetLowerState), so a quick blend lands clean with no slide.
        this.rollLandFade = 0.12;      // legs -> jog when landing into movement (fast, anti-slide)
        this.rollUpperBlendOut = 0.55; // torso + gun arms -> idle gun-hold (longer, smoother weapon settle)
        // The UPPER body (torso + gun) starts blending into the FOLLOWING animation a LOT earlier than
        // the legs: the legs need the whole roll to tumble, but the arms can recover the rifle to its
        // held idle/locomotion pose over most of the roll. rollUpperLead is CLIP seconds before the
        // clip end at which that upper blend kicks off (vs rollEndLead for the legs). Bigger = earlier.
        this.rollUpperLead = 0.5;      // ~half the ~0.97s roll: gun recovery begins around the midpoint
        this._upperBlendStarted = false;
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
        // While a dodge roll is playing the body faces the ROLL direction (not the camera look), so the
        // forward-somersault clip travels the way the player dodged — needed now the dodge is directional
        // (double-tap W/A/S/D). Snapped on roll start, held through the roll, then released back to look.
        this._rollYaw = 0;
        this.rollYawLerp = 18;                             // ease rate (1/s) holding the body on the roll dir
        this.bodyTurnDeadzone = THREE.MathUtils.degToRad(45); // idle look-around arc before the body follows
        this.bodyTurnIdleLerp = 5.0;                       // soft idle catch-up (1/s) — the turn "delay"
        this.bodyTurnMoveLerp = 14.0;                      // prompt alignment while moving / aiming (1/s)
        // FPS body-turn. In first-person the camera is the player's eyes and the arms + gun hang off
        // THIS body, so it must track the look yaw TIGHTLY — there's no idle deadzone/soft-trail (that
        // TPS "look around a still character" behaviour swings the whole viewmodel out of frame on a
        // fast turn). A high lerp keeps only a SMALL natural lag, so a portion of the arms/weapon
        // always stays on screen and snaps back to centre as you stop turning.
        this.fpsBodyTurnLerp = 18.0;                       // tight look-yaw tracking in FPS (1/s)
        // FPS aim centring: while ADS in first-person the right-held gun is biased toward the screen
        // centre so it lines up under the camera, then WeaponAimIK points the barrel exactly at the
        // target — together the gun reads as properly shouldered on the crosshair. Eased so entering/
        // leaving ADS glides. Sign: + turns the body so the right-hand gun swings toward centre (flip
        // if a future rig centres the other way). Cosmetic — the body is invisible in FPS (head culled).
        this.fpsAimYawBias = THREE.MathUtils.degToRad(13); // body-yaw bias that centres the gun while ADS
        this.fpsAimBiasLerp = 10.0;                        // ease rate for the centring bias (1/s)
        this._fpsAimBias = 0;                              // eased current bias (rad)

        // --- FPS weapon look-pitch. In first-person the body only tracks the look YAW, so the held
        // gun stays flat when you look up/down and slides off the screen. To keep it framed, pitch the
        // weapon up/down with the look altitude ALWAYS (even when NOT aiming). It rotates BOTH upper
        // arms (which carry the gun + the support hand) about the body-right axis — NOT the spine —
        // so the head bone (and the FPS eye that rides it) stays put while the weapon tilts. Eased +
        // clamped; the IK still re-aims the barrel exactly when you ADS. Tune the gain/clamp in-game.
        this.fpsArmBones = [];                             // [upperarm_r, upperarm_l], filled in Initialize
        this.fpsLookPitchGain = 0.8;                       // fraction of the look pitch fed to the arms
        this.fpsLookPitchMax = THREE.MathUtils.degToRad(60); // clamp on the weapon tilt
        this._fpsPitchValue = 0;                           // eased current arm pitch (rad)

        // --- Per-camera-mode body proximity-dither thresholds (the head-dither shader's whole-body
        // term). TPS dissolves the body when collision jams the lens against it; FPS pulls the
        // thresholds right in so the arms + hands holding the weapon stay SOLID (you can see your
        // hands on the gun) — only something basically at the eye dithers, and the head is near-plane
        // culled anyway. Applied to the shared uniform holders in ApplyProxDitherForMode.
        this.tpsHeadProxNear = 0.45;
        this.tpsHeadProxFar  = 0.90;
        this.fpsHeadProxNear = 0.08;                       // keep the FPS arms/hands on the gun visible
        this.fpsHeadProxFar  = 0.22;

        // Active in-hand grip seat: 'TPS' | 'FPS' (hip) | 'FPS_AIM' (down-the-sights). Re-seated when
        // the FPS aim state flips so the weapon comes up/centres for ADS (see UpdateActiveGrip).
        this._activeGripMode = 'TPS';

        // --- Crouch (procedural, NO crouch clip). PlayerControls owns the input + the capsule resize
        // (PlayerPhysics) and exposes `crouching`. Here we lower the VISUAL body — the whole modelRoot in
        // WORLD metres (so the units are unambiguous, sidestepping the pelvis-local-scale question) — and
        // FootIK then plants the feet at the ground, which is what BENDS THE KNEES into the crouch. A
        // small additive spine forward-lean adds character. The head bone rides the lowered body, so the
        // FPS eye lowers automatically; the TPS camera lowers via PlayerControls.crouchCamDrop.
        this._crouchEased = 0;                                  // eased 0..1 crouch blend
        this.crouchModelDrop = 0.32;                           // how far the body lowers when crouched (world m)
        this.crouchLerp = 8;                                   // ease rate (1/s) for crouch in/out
        this.crouchSpineLean = THREE.MathUtils.degToRad(10);   // subtle forward torso lean while crouched
        this._crouchLeanR = new THREE.Quaternion();            // scratch: crouch-lean world rotation
        this._crouchLeanPW = new THREE.Quaternion();           // scratch: parent world quat
        this._crouchLeanDelta = new THREE.Quaternion();        // scratch: bone-local delta

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

        // --- Additive RUN-aim yaw (TPS). While AIMING AND MOVING (jog/run), the locomotion swings
        // the torso so the right-hand gun drifts off the reticle. A fixed additive yaw on the SAME
        // spine chain twists the upper body back so the gun bears on the target. Sign convention
        // matches collisionAimYaw above (+ = CCW about vertical / gun LEFT); the run twist is CW,
        // hence NEGATIVE. Eased in/out with movement and added on top of the collision convergence.
        this.runAimYaw = THREE.MathUtils.degToRad(-20);   // ~20° CW spine twist while aiming + running — TUNE/flip sign
        this._runAimYawValue = 0;                          // eased current run-aim yaw (rad)
        this.runAimYawLerp = 8;                            // ease in/out rate with movement (1/s)

        // --- Additive HIP-FIRE aim yaw (TPS). When shooting WITHOUT aiming (hip fire), the body only
        // SOFT-trails the camera (the idle look-around deadzone), so the torso isn't squared to where
        // you're shooting. A small additive spine yaw twists the upper body toward the aim target's
        // horizontal direction, so the torso reads as oriented at the threat while you spray from the
        // hip. Computed as the signed yaw from the body facing to the aim direction, scaled by a gain
        // and clamped; eased in/out. Zero while AIMING (ADS already squares the body to the look) and
        // in FPS. Purely cosmetic (the shot ray stays camera-relative). Flip hipAimYawGain if inverted.
        this.hipAimYawGain = 0.6;                          // fraction of the body->aim yaw offset twisted into the spine
        this.hipAimYawMax  = THREE.MathUtils.degToRad(32); // clamp on the hip-fire torso twist
        // Rear-cone falloff: fade the twist to 0 as the aim goes far behind the body, so the wrapped
        // signed-angle can't flip the torso the long way round when the aim crosses directly-behind
        // (and so you don't twist toward something behind you). Full within fadeStart, none by fadeEnd.
        this.hipAimYawFadeStart = THREE.MathUtils.degToRad(75);
        this.hipAimYawFadeEnd   = THREE.MathUtils.degToRad(130);
        this._hipAimYawValue = 0;                           // eased current hip-aim yaw (rad)
        this._aimFwd = new THREE.Vector3();                 // scratch: horizontal aim direction

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
        // While AIMING, damp the hips harder than for a plain collision push-in: a near-frozen pelvis
        // keeps the strafing legs from swinging the torso/gun off the aim target (the look-facing body
        // + steady idle aim pose then point the gun right at the reticle while you strafe).
        this.aimHipStab = 0.96;
        this.hipStabLerp = 8;                             // ease rate (1/s) entering/leaving stabilization
        this.hipRefLerp = 1.5;                            // low-pass rate (1/s) for the settled pelvis reference

        // --- Recently-fired window. The additive aim pose ALSO activates when the camera is close
        // and you're shooting from the hip (not aiming), so the gun re-points at the reticle for the
        // collapsed close-camera framing. Set on each shot; decays so burst/auto fire keeps it on.
        this._shootHold = 0;
        this.shootHoldTime = 0.25;                        // s the aim pose lingers active after a shot
        this.aimProxThreshold = 0.4;                      // camera proximity above which hip-fire engages the aim pose

        // --- Weapon aim-alignment + two-hand IK (WeaponAimIK). The additive spine lean above is the
        // GROSS aim (it bends the torso toward the look altitude); this is the FINE, exact layer: it
        // rotates the in-hand gun so the barrel points precisely at the crosshair's world target
        // (PlayerControls.aimTarget — the same point the shot ray hits, killing the over-shoulder
        // parallax) and IKs the support hand back onto the foregrip. Built in Initialize once the rig
        // + weaponPivot exist; driven each frame (UpdateWeaponAim) only while aiming/shooting, eased
        // out otherwise so plain locomotion is left exactly as authored. Works in TPS and FPS.
        this.weaponAimIK = null;
        this._weaponAimActive = false;                    // cached gate (for the debug overlay)

        // --- Head aim. Orient the head to look in the PURE DIRECTION of the crosshair (camera-forward)
        // so the character looks where the camera looks. Applied as an additive world-space rotation on
        // the head bone AFTER the spine lean + weapon IK (final say on the head), eased in/out and
        // clamped so the neck never over-rotates. Purely cosmetic and TPS-visible — in FPS the head is
        // culled and the camera orientation IS the look direction, so it's inert there.
        //
        // The reference gaze is the head's ACTUAL animated world-forward (not the bare body yaw): the
        // head is a child of spine_03, so it already carries the spine pitch-lean + hip-fire twist this
        // frame; referencing the head's PRE-FLINCH world-forward keeps the delta from DOUBLE-COUNTING
        // them (which over-rotated the head and made it slew when the lean/twist eased) WHILE letting the
        // hurt flinch survive. The head's local gaze axis is pre-seeded once from the rig's rest pose
        // (Initialize), so it's rig-agnostic and never latches onto a transient. Past the neck clamp the
        // head HOLDS at its limit (tracking the target's azimuth) and only eases out very near 180°,
        // where the shortest-arc axis is unstable — that was the head "snap/roll" on a fast camera whip.
        this.headAimWeight = 0;                          // eased 0..1 blend
        // The head tracks the aim point CONTINUOUSLY in TPS (not only while aiming) so the character
        // visibly looks where the camera looks, and FASTER than the gun (the weapon IK eases at ~12)
        // so the gaze leads — the head snaps onto the target and the gun follows, like a real shooter.
        this.headAimLerp = 16;                           // ease rate (1/s) for the look in/out
        this.maxHeadAimAngle = THREE.MathUtils.degToRad(70); // clamp so the head can't wring the neck
        // Antiparallel safety: ease the WHOLE look delta out only when the target is nearly directly
        // behind the body (this band), where setFromUnitVectors' axis collapses/flips. Below it the head
        // simply HOLDS at the neck clamp and tracks the target's azimuth — no direction reversal.
        this.headAimAntiparallelStart = THREE.MathUtils.degToRad(150);
        this.headAimAntiparallelEnd   = THREE.MathUtils.degToRad(175);
        this._headFwdRef = new THREE.Vector3();
        this._headFwdDes = new THREE.Vector3();
        this._headAimPos = new THREE.Vector3();
        this._headWorldQ = new THREE.Quaternion();       // scratch: head world quat (rest pre-seed)
        this._headPreFlinchWQ = new THREE.Quaternion();  // head world quat snapshot BEFORE the flinch (the gaze reference)
        this._headFwdLocal = null;                       // head-forward local axis, pre-seeded from the rest pose
        this._headAimQ = new THREE.Quaternion();         // full look delta (world)
        this._headAimWorld = new THREE.Quaternion();     // clamped+eased look delta (world)
        this._headAimId = new THREE.Quaternion();        // identity (slerp base) — never mutated
        this._headAimPW = new THREE.Quaternion();
        this._headAimPWInv = new THREE.Quaternion();
        this._headAimLocal = new THREE.Quaternion();
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

        // Forward roll: a FULL-BODY one-shot on BOTH layers (legs + torso roll together), LoopOnce
        // and clamped on the last frame so it holds the recovered pose until EndRoll blends out.
        const rollClip = this.clips['roll'];
        if(rollClip){
            const { upper, lower } = splitClipByBones(rollClip, upperBones);
            const lo = this.mixer.clipAction(lower); lo.setLoop(THREE.LoopOnce); lo.clampWhenFinished = true;
            const up = this.mixer.clipAction(upper); up.setLoop(THREE.LoopOnce); up.clampWhenFinished = true;
            this.lowerActions['roll'] = lo;
            this.upperActions['roll'] = up;
            this._rollDuration = rollClip.duration;
        }

        // reload/shoot are UPPER-body overlays that layer over the torso while the legs keep their
        // locomotion. Only the upper half of each clip is used. RELOAD is a one-shot (clamps + the
        // 'finished' event hands back). SHOOT instead LOOPS while the trigger is held: re-triggering a
        // one-shot on every round (full-auto fires ~10/s) re-zeroed the clip every ~100 ms, snapping
        // the torso back to the firing pose's first frame — that was the upper-body "stutter/jitter"
        // when shooting. Looping plays a continuous fire cadence; EndShoot hands the torso back when
        // _shootHold lapses (no shot for shootHoldTime). Mirrors the soldier's BeginFire/EndFire.
        ['reload', 'shoot'].forEach(name => {
            const clip = this.clips[name];
            if(!clip){ return; }
            const { upper } = splitClipByBones(clip, upperBones);
            if(name === 'shoot'){ makeClipSeamlessLoop(upper); }   // kill the ~2.6° loop seam (see helper)
            const a = this.mixer.clipAction(upper);
            if(name === 'shoot'){
                a.setLoop(THREE.LoopRepeat);
            }else{
                a.setLoop(THREE.LoopOnce);
                a.clampWhenFinished = true;
            }
            this.upperActions[name] = a;
        });

        // In-hand AK magazine reload. The clip's only tracks are 'Magazine.*' (the whole-gun
        // 'Root' motion was stripped at load), and the socketed gun is a descendant of this rig
        // (hand_r -> weaponPivot -> SK_AK47 -> Root -> Grip -> Magazine), so it binds by bone
        // name on THIS body's mixer — which keeps the mag drop frame-locked to the character
        // reload one-shot (same mixer/clock; both clips are 2.2333s). LoopOnce + clamp leaves the
        // mag reseated when done; PlayGunReload rewinds it to frame 0 on each reload. It drives a
        // DISJOINT bone (Magazine) from the body clips, so it composes cleanly with them.
        if(this.magReloadClip){
            const gun = this.mixer.clipAction(this.magReloadClip);
            gun.setLoop(THREE.LoopOnce);
            gun.clampWhenFinished = true;
            this.gunReloadAction = gun;
        }

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

        // Upper-arm bones for the FPS weapon look-pitch (carry the gun + support hand without moving
        // the head/eye). Each pitches by the FULL look angle so the gun's orientation tracks the look.
        const armBones = { upperarm_r: null, upperarm_l: null };
        this.model.traverse(o => { if(o.isBone && (o.name in armBones) && !armBones[o.name]){ armBones[o.name] = o; } });
        ['upperarm_r', 'upperarm_l'].forEach(n => { if(armBones[n]){ this.fpsArmBones.push(armBones[n]); } });

        // Pre-seed the head-aim gaze axis from the rig's REST pose (the bones are still at bind here —
        // no mixer update has run). _headFwdLocal is the head-bone-LOCAL axis that points along the
        // character's forward (modelRoot-local +Z) at rest; carrying it by the head's live world quat
        // each frame then yields the head's true world gaze (incl. spine lean/twist), so the head-aim
        // delta supplies only the residual. Computed from the head's orientation RELATIVE TO modelRoot
        // (so it's independent of modelRoot's current world yaw) at the guaranteed-clean bind pose, so
        // it can never latch onto a flinch/roll/idle-bob transient and is always set (fixes the "never
        // calibrated when entering already-aiming" double-count). Rig-agnostic.
        if(this.headBone){
            this.modelRoot.updateMatrixWorld(true);
            const rootWQ = new THREE.Quaternion();
            this.modelRoot.getWorldQuaternion(rootWQ);
            this.headBone.getWorldQuaternion(this._headWorldQ);
            // headRel = root⁻¹ · head (head orientation in modelRoot-local space); local fwd = headRel⁻¹ · (+Z).
            const headRel = new THREE.Quaternion().copy(rootWQ).invert().multiply(this._headWorldQ);
            this._headFwdLocal = new THREE.Vector3(0, 0, 1).applyQuaternion(headRel.invert()).normalize();
        }

        // Pelvis (hips) for proximity stabilization; seed the settled-pose reference from its bind.
        this.model.traverse(o => { if(o.isBone && o.name === 'pelvis'){ this._pelvisBone = o; } });
        if(this._pelvisBone){
            this._pelvisRefPos.copy(this._pelvisBone.position);
            this._pelvisRefQuat.copy(this._pelvisBone.quaternion);
            this._hipRefSeeded = true;
        }

        // Weapon aim-alignment + two-hand IK. Needs the rig (arm bones, by name) and the in-hand
        // weaponPivot, both built above. Sockets + the barrel axis are auto-resolved lazily on its
        // first Update (from the gun bbox + the posed hands); WeaponManager can override per weapon.
        if(this.weaponPivot){
            this.weaponAimIK = new WeaponAimIK(this.model, this.weaponPivot);
        }

        // Procedural foot/terrain IK (legs). Raycasts the level under each foot and plants the ankles +
        // tilts the feet to the slope; also what bends the knees into the crouch (the crouch lowers the
        // body, FootIK keeps the feet on the ground). Needs the Ammo world to raycast against; the
        // PlayerPhysics component holds it (set in its constructor, so it's available here).
        const physics = this.GetComponent('PlayerPhysics');
        this.footIK = new FootIK(this.model, this.modelRoot, physics ? physics.world : null);

        // --- Per-camera-mode in-hand grip. The AK is the SAME mesh in both modes (FPS rides the head
        // bone, so first-person shows THIS body's gun), but the framing differs, so each mode gets its
        // own seat: ApplyWeaponGrip swaps the pivot transform on a mode switch and the placement tool
        // (`) edits whichever mode is active. Both are seeded from the code defaults (FPS == TPS until
        // tuned). Stored as position(Vector3)+quaternion(Quaternion) ready to drop onto the pivot.
        this.weaponGrips = {
            TPS: {
                position: WEAPON_GRIP_DEFAULT.position.clone(),
                quaternion: new THREE.Quaternion().setFromEuler(WEAPON_GRIP_DEFAULT.rotationEuler),
            },
            FPS: {
                position: WEAPON_GRIP_FPS_DEFAULT.position.clone(),
                quaternion: new THREE.Quaternion().setFromEuler(WEAPON_GRIP_FPS_DEFAULT.rotationEuler),
            },
            // Down-the-sights FPS seat (the gun comes up/centres while ADS); see ActiveGripMode.
            FPS_AIM: {
                position: WEAPON_GRIP_FPS_AIM_DEFAULT.position.clone(),
                quaternion: new THREE.Quaternion().setFromEuler(WEAPON_GRIP_FPS_AIM_DEFAULT.rotationEuler),
            },
        };

        // Hurt feedback: an additive upper-body flinch layered on top of the pose when the player is
        // damaged (a torso recoil + head twitch), so getting shot reads on the third-person body
        // without dropping locomotion or aim. Skipped during the dodge roll / i-frames (see OnHurt).
        this.hurtFlinch = new HurtFlinch(this.model);

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
        // Dodge roll: PlayerControls fires this on a double-tap of a movement key.
        this.parent.RegisterEventHandler(this.OnRoll, 'player.roll');
        // Taking damage: trigger the additive hurt flinch (PlayerHealth handles the health bookkeeping).
        this.parent.RegisterEventHandler(this.OnHurt, 'hit');
    }

    // Back-compat alias: the leg (locomotion) state is the body's overall state for
    // callers that just want "is it walking/idle" (QA harness, debug overlays).
    get currentState(){ return this.lowerState; }

    OnCameraMode = (msg) => { this.SetCameraMode(msg.mode); }
    OnReload = () => { this.PlayOneShot('reload'); this.PlayGunReload(); }
    // Don't re-arm the recently-fired window mid-roll: the roll owns the body (PlayOneShot already
    // no-ops while rolling), and a held trigger firing through the roll would otherwise keep _shootHold
    // alive so the aim-IK/aim-pose snap on at recovery instead of easing in. ResetAimPoseAccumulators
    // clears it on roll exit too.
    OnShoot = () => { this.PlayOneShot('shoot'); if(!this.rolling){ this._shootHold = this.shootHoldTime; } }
    OnJump = () => { this._jumpRequested = true; }
    OnRoll = () => { this.StartRoll(); }
    // Hit reaction. A dodge roll's i-frames negate the damage, so don't flinch then (and the roll owns
    // the whole body anyway). Scale the jolt by the damage so a beast melee rocks harder than an AK round.
    OnHurt = (msg) => {
        if(!this.hurtFlinch || this.rolling || (this.playerControls && this.playerControls.invulnerable)){ return; }
        const amount = (msg && msg.amount) ? msg.amount : 10;
        this.hurtFlinch.Trigger(amount / 12);
    }

    // Begin the full-body forward roll: snap both layers onto the roll one-shot, fading out whatever
    // locomotion / upper one-shot was playing so neither layer is ever left empty (no bind-pose flash).
    StartRoll(){
        const lo = this.lowerActions['roll'];
        const up = this.upperActions['roll'];
        if(!lo || !up || this.rolling){ return; }
        this.rolling = true;
        this.oneShot = null;                                   // the roll owns the upper layer now
        // Face the body along the roll direction so the forward-somersault clip travels the dodged way
        // (directional double-tap dodge). Snap to it now (the somersault sells the turn) and hold it in
        // UpdateBodyYaw for the roll's duration; it eases back to the look direction once the roll ends.
        const rd = this.playerControls ? this.playerControls.rollDir : null;
        this._rollYaw = (rd && (rd.x * rd.x + rd.z * rd.z) > 1e-6)
            ? Math.atan2(rd.x, rd.z)
            : (this._bodyYaw !== null ? this._bodyYaw : 0);
        this._bodyYaw = this._rollYaw;
        // The roll branch in Update skips UpdateLocomotion, which is the only place airState/_groundedTimer
        // are maintained — so clear the jump sub-graph to a known-grounded state now. Otherwise a roll
        // started just after landing (still inside airExitDebounce) would leave airState='fall' frozen and
        // flash the jumpFall pose for a frame when EndRoll hands back to locomotion.
        this.airState = null;
        this._groundedTimer = this.airExitDebounce;

        // Lower layer: crossfade the legs from their current locomotion into the roll.
        const prevLo = this.lowerState ? this.lowerActions[this.lowerState] : null;
        lo.reset();
        lo.setEffectiveTimeScale(this.rollTimeScale);
        lo.setEffectiveWeight(1.0);
        lo.play();
        if(prevLo && prevLo !== lo){ lo.crossFadeFrom(prevLo, 0.08, false); }
        this.lowerState = null;                                // normal loco no longer drives the legs

        // Upper layer: make the roll the sole full-weight upper action (fades out loco + any one-shot).
        up.reset();
        up.setEffectiveTimeScale(this.rollTimeScale);
        up.play();
        this.SetUpperPrimary(up, 0.08);
        this.upperState = null;
        this._upperBlendStarted = false;                       // re-arm the early upper-body blend
    }

    // Advance the roll. The UPPER body (torso + gun) starts blending into the following locomotion/idle
    // a LOT earlier than the legs (rollUpperLead), so the rifle eases back to its held pose over most
    // of the roll; the legs keep rolling until rollEndLead, then EndRoll settles the lower half. Both
    // roll actions keep playing (and clamp) THROUGH their fades, so nothing hard-cuts.
    UpdateRoll(){
        const lo = this.lowerActions['roll'];
        if(!lo){ this.rolling = false; this.ResetAimPoseAccumulators(); return; }
        const dur = lo.getClip().duration;

        // Early UPPER-body hand-off: torso + gun arms blend to the following anim well before the end.
        if(!this._upperBlendStarted && lo.time >= dur - this.rollUpperLead){
            this.StartUpperRollBlend();
        }

        const end = Math.max(0.05, dur - this.rollEndLead);
        if(lo.time >= end){ this.EndRoll(); }
    }

    // Begin the long upper-body crossfade from the roll into the gun-holding idle (or matching
    // locomotion). The roll keeps driving the LEGS until EndRoll; this only re-homes the torso+arms.
    StartUpperRollBlend(){
        const loco = this.DesiredLocoState();
        this.upperState = 'roll';
        this.PlayUpperLocomotion(this.DesiredUpperState(loco), this.rollUpperBlendOut);
        this._upperBlendStarted = true;
    }

    // Hand the body back to the locomotion graph after the roll, from whatever the legs are doing now
    // (idle when settling, a jog if still carrying movement) — over a longer crossfade so the stand-up
    // eases into the resting/locomotion pose instead of snapping.
    // Zero EVERY eased additive-pose accumulator on a roll clear: the spine pitch-lean weight/value,
    // collision + run-aim yaws, hip-fire twist, head-aim blend, AND the hip stabilizer. UpdateAimPose,
    // UpdateHeadAim and StabilizeHips are all skipped for the whole ~0.8s roll, so without this they
    // THAW at their frozen pre-roll values and re-apply in a single frame — a one-frame torso/head/gun/
    // pelvis pop. Zeroing the weights lets each early-return guard fire on frame 1 so the whole pose
    // eases back in coherently (in lockstep), not half-snapped/half-eased; clearing _hipRefSeeded makes
    // StabilizeHips re-acquire its settled-pelvis reference from the live post-roll stand-up pose.
    ResetAimPoseAccumulators(){
        this._aimPitchWeight = 0;
        this._aimPitchValue = 0;
        this._fpsPitchValue = 0;        // FPS weapon look-pitch — ease back in cleanly after a roll
        this._aimYawValue = 0;
        this._runAimYawValue = 0;
        this._hipAimYawValue = 0;
        this.headAimWeight = 0;
        this._hipStab = 0;
        this._hipRefSeeded = false;
        // Also clear the recently-fired window and hard-reset the weapon aim-IK blend: if you rolled
        // while HOLDING fire, _shootHold stays re-armed and the IK's master blend freezes near 1 through
        // the roll (Update skipped), snapping the gun/support-hand on in one frame at recovery. Zeroing
        // both makes the IK ease back in from nothing if you're still firing out of the roll.
        this._shootHold = 0;
        if(this.weaponAimIK){ this.weaponAimIK.Reset(); }
        // Crouch + foot IK ease back in from zero after a roll (the roll owns the whole body and skips
        // them, so without this they'd thaw at their frozen pre-roll values and pop the pelvis/legs).
        this._crouchEased = 0;
        if(this.footIK){ this.footIK.Reset(); }
    }

    EndRoll(){
        this.rolling = false;
        this.ResetAimPoseAccumulators();
        const loco = this.DesiredLocoState();
        // Fade the legs from the roll into the resolved locomotion: a FAST blend into a jog when
        // landing in motion (so the feet are walking immediately and don't slide), a moderate one when
        // settling to a stop. The jog is foot-synced to the ground speed from the first frame.
        this.lowerState = 'roll';
        const landFade = this.IsJogState(loco) ? this.rollLandFade : this.rollBlendOut;
        this.SetLowerState(loco, landFade);
        // If the torso already homed to this SAME jog during the early upper blend, phase-match the
        // legs to it so the torso bob and the footfalls don't run out of sync coming out of the roll.
        if(this._upperBlendStarted && this.upperState === loco && this.IsJogState(loco)){
            const up = this.upperActions[loco], lo = this.lowerActions[loco];
            if(up && lo){ lo.time = up.time; }
        }
        // The torso + gun arms already began easing back to the held pose at rollUpperLead; only start
        // it here as a fallback if that early hand-off never fired (e.g. a very short clip).
        if(!this._upperBlendStarted){ this.StartUpperRollBlend(); }
    }

    // The same full-body avatar is rendered in BOTH camera modes now: in TPS the
    // boom looks at it from behind; in FPS the camera rides its head bone and the
    // head mesh is culled by the camera's near plane (see PlayerControls). So the
    // body always stays on the visible layer — we no longer hide it for first-person.
    SetCameraMode(mode){
        this.cameraMode = mode;
        for(const mesh of this.meshes){
            mesh.layers.set(0);
        }
        // Seat the in-hand gun for this mode (TPS / FPS-hip / FPS-ADS framing) and set the body
        // proximity-dither thresholds for the mode (keep the FPS hands on the gun solid).
        this._activeGripMode = this.ActiveGripMode();
        this.ApplyWeaponGrip(this._activeGripMode);
        this.ApplyProxDitherForMode(mode);
    }

    // The grip seat the current camera/aim state wants: TPS, the FPS hip grip, or the FPS down-the-
    // sights grip while aiming in first-person. Drives both the live seat (UpdateActiveGrip) and which
    // grip the placement tool edits (it reads this), so HOLDING right click in FPS edits the AIM grip.
    ActiveGripMode(){
        if(this.cameraMode !== 'FPS'){ return 'TPS'; }
        const aiming = !!(this.playerControls && this.playerControls.aiming);
        return aiming ? 'FPS_AIM' : 'FPS';
    }

    // Re-seat the in-hand gun when the active grip mode changes (e.g. FPS hip <-> FPS ADS as you press
    // / release aim) so the weapon comes up and centres down the sights. Cheap: only acts on a change.
    UpdateActiveGrip(){
        const mode = this.ActiveGripMode();
        if(mode === this._activeGripMode){ return; }
        this._activeGripMode = mode;
        this.ApplyWeaponGrip(mode);
    }

    // Per-camera-mode body proximity-dither thresholds (the head-dither shader's whole-body term).
    // TPS: dissolve the body when a collision push-in jams the lens against it. FPS: pull the
    // thresholds right in so the arms + hands holding the weapon stay SOLID and you can see your hands
    // on the gun (the head is already culled by the near plane).
    ApplyProxDitherForMode(mode){
        if(mode === 'FPS'){
            this.headProxNear.value = this.fpsHeadProxNear;
            this.headProxFar.value  = this.fpsHeadProxFar;
        }else{
            this.headProxNear.value = this.tpsHeadProxNear;
            this.headProxFar.value  = this.tpsHeadProxFar;
        }
    }

    // Drop the active camera mode's grip transform onto the weapon pivot and re-sync the aim IK's
    // captured base to it, so the swap is correct both at rest (the pivot just sits at the grip) and
    // while aiming (WeaponAimIK resets the pivot to this base every frame before correcting it). The
    // barrel/foregrip sockets are pivot-LOCAL, so they don't need re-deriving — they ride the new seat.
    ApplyWeaponGrip(mode){
        if(!this.weaponPivot || !this.weaponGrips){ return; }
        const g = this.weaponGrips[mode] || this.weaponGrips.TPS;
        this.weaponPivot.position.copy(g.position);
        this.weaponPivot.quaternion.copy(g.quaternion);
        if(this.weaponAimIK){ this.weaponAimIK.CaptureBase(); }
    }

    // Live edit from the placement tool: store the grip for `mode` (hand-local cm position + degree
    // Euler) and, if it's the active mode, apply it immediately so the nudge shows in real time.
    SetWeaponGripLive(mode, pos, rotDeg){
        if(!this.weaponGrips || !this.weaponGrips[mode]){ return; }
        this.weaponGrips[mode].position.set(pos.x, pos.y, pos.z);
        this.weaponGrips[mode].quaternion.setFromEuler(new THREE.Euler(
            THREE.MathUtils.degToRad(rotDeg.x),
            THREE.MathUtils.degToRad(rotDeg.y),
            THREE.MathUtils.degToRad(rotDeg.z),
        ));
        // Apply immediately if it's the seat currently shown (TPS / FPS hip / FPS ADS), so a nudge in
        // the placement tool reads live — including the FPS_AIM grip while holding right click in FPS.
        if(mode === this.ActiveGripMode()){ this.ApplyWeaponGrip(mode); }
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

    // Smooth crossfade of the UPPER layer into `name` — used for the shoot/reload EXIT. SetUpperPrimary
    // snaps the incoming action to full weight (great for ENTERING a one-shot with no bind-pose flash,
    // but it makes the incoming pose pop in at ~50% on the first frame — the "rough" fire-to-idle cut).
    // This does a TRUE crossFadeFrom instead: the incoming action eases 0->1 while the outgoing one-shot
    // eases 1->0, so the recoil pose melts into idle/aim. Safe because the outgoing one-shot is still at
    // full weight here, so the layer is never emptied (no bind/T-pose flash); any OTHER residual upper
    // action is also faded out so the layer keeps summing to ~1.
    CrossfadeUpper(name, fade){
        const next = this.upperActions[name];
        if(!next){ return; }
        const prev = (this.upperState && this.upperActions[this.upperState] !== next)
            ? this.upperActions[this.upperState] : null;
        next.reset();
        next.setEffectiveTimeScale(this.LocoTimeScale(name));
        if(this.lowerActions[name]){ next.time = this.lowerActions[name].time; }   // phase-match the legs
        next.enabled = true;
        next.play();
        if(prev){
            prev.enabled = true;
            // warp=false: a plain weight crossfade. Warping timescales between the fast fire LOOP and the
            // idle/jog clip (very different cadences) was causing a brief speed hitch at the end of a
            // burst when not aiming — a straight weight blend is glitch-free here.
            next.crossFadeFrom(prev, fade, false);    // incoming 0->1, outgoing 1->0 — a real crossfade
            for(const key in this.upperActions){      // fade any OTHER lingering action so the layer stays ~1
                const a = this.upperActions[key];
                if(a !== next && a !== prev && a.enabled && a.getEffectiveWeight() > 1e-3){ a.fadeOut(fade); }
            }
        }else{
            this.SetUpperPrimary(next, fade);         // nothing to crossfade from: snap in (no bare layer)
        }
        this.upperState = name;
    }

    PlayOneShot(name){
        // While rolling the roll owns the WHOLE body (both layers). A reload/shoot one-shot would
        // hijack the torso mid-roll and leave the upper layer in a stale 'oneShot' state when the
        // roll hands back to locomotion — so ignore one-shots during the roll. The weapon itself
        // still fires (WeaponManager is independent); only the torso anim is suppressed for ~0.8s.
        if(this.rolling){ return; }
        const action = this.upperActions[name];
        if(!action){ return; }
        // Already mid one-shot of this clip. For 'shoot' (held-trigger, full-auto) it's a LOOP — leave
        // it cycling so the fire motion stays smooth (re-zeroing it every round was the firing stutter);
        // _shootHold + EndShoot tear it down when the trigger releases. A reload re-trigger restarts.
        if(this.oneShot === name){
            if(name !== 'shoot'){ action.time = 0; }
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

    // Play the in-hand AK's magazine drop/reseat in lockstep with the body reload one-shot. Gated
    // exactly like PlayOneShot('reload') — suppressed mid-roll (the roll owns the body and tucks the
    // gun away). reset() rewinds to a seated mag so a re-reload (or auto-reload) replays from the top.
    // Runs on the body mixer, so no separate update/teardown is needed; it clamps reseated when done.
    PlayGunReload(){
        if(this.rolling || !this.gunReloadAction){ return; }
        this.gunReloadAction.reset();
        this.gunReloadAction.play();
    }

    // End the looped shoot overlay (trigger released — _shootHold lapsed) and hand the torso back to
    // its locomotion / aim pose, exactly like the reload one-shot's finish handler. No-op if a reload
    // or roll has since taken the upper layer (oneShot is no longer 'shoot').
    EndShoot(){
        if(this.oneShot !== 'shoot'){ return; }
        this.oneShot = null;
        this.upperState = 'shoot';                   // so the crossfade eases out of it
        // Long, TRUE crossfade out of the fire pose (incoming idle/aim rises 0->1 as the recoil pose
        // falls) so the hand-off is a smooth melt, not the old snap-to-half-weight pop.
        this.CrossfadeUpper(this.DesiredUpperState(this.lowerState || 'idle'), 0.38);
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
        this.upperState = finished;                  // so the crossfade eases out of it
        // Smooth, true crossfade so a finished shoot/reload melts into idle/aim rather than popping.
        this.CrossfadeUpper(this.DesiredUpperState(this.lowerState || 'idle'), 0.3);
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
        // FREE-RUN (TPS, not aiming): the body turns to face its MOVEMENT direction (UpdateBodyYaw),
        // so it's always moving straight forward relative to itself — play the forward jog. This is
        // what kills the diagonal foot-slide: a single directional jog can't match a 45° travel, so
        // running diagonally on the forward/strafe clips skated the feet. Orienting to the heading +
        // running forward makes the stride match the actual travel in every direction.
        if(this.cameraMode === 'TPS' && !this.IsAiming()){ return 'jogF'; }
        // AIMING (or FPS): the body faces the camera/look and STRAFES, so pick the directional jog
        // from the local velocity (W+D reads as a forward jog, A/D as a strafe, S as a backpedal).
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
        if(this._shootHold > 0){
            this._shootHold = Math.max(0, this._shootHold - t);
            // Trigger released (no shot for shootHoldTime): tear down the looped shoot overlay.
            if(this._shootHold === 0){ this.EndShoot(); }
        }

        // Strip root motion so the clip animates in place; the capsule moves us.
        if(this.rootBone && this.rootRef){
            this.rootBone.position.copy(this.rootRef.position);
            this.rootBone.quaternion.copy(this.rootRef.quaternion);
            this.rootBone.scale.copy(this.rootRef.scale);
        }

        // Ease the crouch blend toward the controls' effective crouch (grounded, not rolling). The body
        // lowers by crouchModelDrop·_crouchEased in WORLD metres below; FootIK then re-plants the feet
        // at the ground, bending the knees into the crouch (no crouch clip). Eased so it glides in/out.
        const crouchWant = (this.playerControls && this.playerControls.crouching && !this.rolling) ? 1 : 0;
        this._crouchEased += (crouchWant - this._crouchEased) * (1 - Math.exp(-this.crouchLerp * t));

        // Follow the capsule; the facing is eased (not snapped) so panning the camera
        // doesn't instantly whip the body — see UpdateBodyYaw. The crouch drop lowers the whole avatar.
        const p = this.parent.Position;
        this.modelRoot.position.set(p.x, p.y + this.feetOffset - this.crouchModelDrop * this._crouchEased, p.z);
        this.UpdateBodyYaw(t);
        // Re-seat the in-hand gun if the FPS aim state flipped (FPS hip <-> FPS ADS grip).
        this.UpdateActiveGrip();
        if(this.rolling){
            // The roll owns the WHOLE body while it plays: no hip stabilization, no aim lean and no
            // locomotion graph (any of which would fight the roll). Just advance it and, when the
            // clamped clip finishes, blend straight back to locomotion (EndRoll) — a clean hand-off
            // that prevents the animation locking or snapping.
            this.UpdateRoll();
        }else{
            // Damp the hip bob when the camera is close (aim / collision) so the character is stable in
            // front of the lens. Runs after the mixer/root-lock and BEFORE the spine aim lean, since the
            // lean reads the (now-stabilized) pelvis as its parent.
            this.StabilizeHips(t);
            // Subtle crouch torso lean: a small forward spine pitch while crouched, for character. Runs
            // before the aim lean so the two compose (additive world-space rotations on the spine chain).
            this.ApplyCrouchLean();
            // Additive lean so the arms + gun aim at the right altitude while aiming (or hip-firing
            // close). Runs after the body yaw (it reads the facing) and before the head dither (it moves
            // the head). It edits the animated pose this frame, on top of the mixer.
            this.UpdateAimPose(t);
            // Snapshot the head's PRE-FLINCH world orientation (it already carries the spine lean+twist
            // from UpdateAimPose) as the head-aim gaze reference. Taken before the flinch so the head-aim
            // delta — which re-points the gaze onto the crosshair — does NOT cancel the flinch's head
            // jolt: the flinch displacement, applied after, rides through to the final gaze.
            if(this.headBone){ this.headBone.getWorldQuaternion(this._headPreFlinchWQ); }
            // Additive hurt flinch on the torso + head (idle no-op when not recently hit). Runs BEFORE
            // the weapon IK so that, while aiming, the IK re-plants the support hand on the (flinched)
            // gun and holds the barrel on target — the torso/head jolt reads, the hands stay attached.
            this.hurtFlinch && this.hurtFlinch.Update(t, this._bodyYaw);
            // Fine layer: rotate the in-hand gun so the barrel points EXACTLY at the crosshair target
            // and IK the support hand back onto the foregrip. Runs after the gross spine lean so it
            // corrects the leaned pose; eased in/out so it's inert when not aiming/shooting.
            this.UpdateWeaponAim(t);
            // Head looks in the pure direction of the aim target. Last, so it overrides the head pose
            // the spine lean / locomotion left (and the weapon IK never touches the head).
            this.UpdateHeadAim(t);

            this.UpdateLocomotion(t);
            this.UpdateLocoTimeScale();   // foot-sync the live directional-jog playback rate to ground speed
            // Foot/terrain IK is the LAST pose write: it solves the legs with the FINAL hip position
            // (after crouch + every spine/arm edit) and nothing downstream reads the legs. It refreshes
            // world matrices itself. Runs after UpdateLocomotion so airState is current for the gating.
            this.UpdateFootIK(t);
        }
        // Dissolve the head when the camera crowds it (TPS aim-from-cover).
        this.UpdateHeadDither(t);

        // FPS eye re-sync. PlayerControls placed the camera at the START of the frame, reading the head
        // bone from LAST frame's pose (components update Controls-before-Body). Now that the body is
        // fully posed for THIS frame, re-seat the eye on the current head bone so the eye and the
        // gun/arms it holds are locked to the same frame — otherwise the one-frame desync reads as the
        // viewmodel strobing against the view when turning. Position only; orientation/shake stay as
        // PlayerControls set them.
        if(this.cameraMode === 'FPS' && this.playerControls && !this.playerControls.cameraOverride){
            this.playerControls.PlaceFpsEyePosition(this.parent.Position);
        }
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
        // Steady the hips when the camera is close to the body. In TPS that's ADS (boom pulled in) OR a
        // collision push-in. In FPS the camera RIDES the head bone, so the walk bob shakes the view —
        // steady it while AIMING (so ADS is rock-steady) but leave the natural first-person head bob
        // when not aiming. The head mesh stays glued to the (damped) bone, so the camera never desyncs.
        const tpsAiming = this.IsAiming();
        const fpsAiming = (this.cameraMode === 'FPS') && !!(pc && pc.aiming);
        const aiming = tpsAiming || fpsAiming;
        const close = (this.cameraMode === 'TPS')
            ? Math.max(tpsAiming ? 1 : 0, pc ? pc.CameraProximity : 0)
            : (fpsAiming ? 1 : 0);
        const moving = this.IsJogState(this.lowerState);
        // Aiming damps harder (steady gun while strafing) than a plain collision push-in.
        const cap = aiming ? this.aimHipStab : this.hipStabMax;
        const target = (moving ? close : 0) * cap;
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

    // Subtle crouch torso lean: pitch the spine chain FORWARD by a small amount scaled by the eased
    // crouch blend, for character (a crouched stance hunches a little). World-space additive on the same
    // spine bones the aim lean uses, applied BEFORE it so the two compose. Rotation-only, so it's unit-
    // scale-agnostic (unlike the pelvis-position drop, which is why the crouch DROP is done on modelRoot).
    ApplyCrouchLean(){
        if(this._crouchEased < 1e-3 || !this.aimBones.length){ return; }
        const pitch = this.crouchSpineLean * this._crouchEased;        // + = lean forward (same sign as look-down)
        this._aimRight.set(Math.cos(this._bodyYaw), 0, -Math.sin(this._bodyYaw));   // body-right axis (world)
        for(const ab of this.aimBones){
            this._crouchLeanR.setFromAxisAngle(this._aimRight, pitch * ab.weight);
            ab.bone.parent.getWorldQuaternion(this._crouchLeanPW);
            // newLocal = parentWorld^-1 * R * parentWorld * oldLocal
            this._crouchLeanDelta.copy(this._crouchLeanPW).invert().multiply(this._crouchLeanR).multiply(this._crouchLeanPW);
            ab.bone.quaternion.premultiply(this._crouchLeanDelta);
        }
    }

    // Additive look-pitch lean: lean the spine chain by the look pitch so the arms + gun
    // point at the right altitude, layered on top of the played animation. Each bone is
    // rotated in its PARENT's world space about the character's horizontal right axis, so
    // the lean is a clean forward/back pitch regardless of the bone's local-axis convention.
    // Processing root -> tip and re-reading each parent's world orientation composes the
    // per-bone shares correctly. Active whenever the TPS body is on screen (so the gun
    // tracks the camera all the time, not just while aiming), eased in/out and clamped.
    UpdateAimPose(t){
        // FPS: tilt the held weapon up/down with the look pitch so it stays on screen — even when NOT
        // aiming. Handled separately because it rotates the ARMS (not the spine), so the head bone and
        // the FPS eye that rides it don't move. None of the TPS spine yaw twists below apply in FPS.
        if(this.cameraMode === 'FPS'){ this.UpdateFpsWeaponPitch(t); return; }
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

        // Hip-fire torso twist: when shooting WITHOUT aiming in TPS (at ANY camera distance — its own
        // gate, broader than the close-only hipFire above), twist the spine toward the aim target's
        // horizontal direction so the torso reads as oriented at the threat while you spray from the
        // hip. Signed yaw from the body facing to the aim direction, scaled + clamped, eased on its OWN
        // value so it applies even when the pitch lean is inactive (it is NOT scaled by the pitch
        // weight below). Zero when aiming (ADS squares the body to the look already) and in FPS. Body
        // facing angle = _bodyYaw (forward = (sin,0,cos)); aim angle = atan2(aimDir.x, aimDir.z).
        const hipAimActive = (this.cameraMode === 'TPS') && (this._shootHold > 0) && !this.IsAiming();
        let hipYawTarget = 0;
        if(hipAimActive && pc){
            this._aimFwd.set(pc.aimDir.x, 0, pc.aimDir.z);
            if(this._aimFwd.lengthSq() > 1e-4){
                this._aimFwd.normalize();
                let d = Math.atan2(this._aimFwd.x, this._aimFwd.z) - this._bodyYaw;
                d = Math.atan2(Math.sin(d), Math.cos(d));   // shortest signed arc, [-π,π]
                // Rear-cone falloff: fade the twist out as |d| grows so a near-180° aim (the wrap point,
                // reachable on a fast standing whip while the body trails) can't flip the torso sign.
                const fall = 1 - THREE.MathUtils.smoothstep(Math.abs(d), this.hipAimYawFadeStart, this.hipAimYawFadeEnd);
                hipYawTarget = THREE.MathUtils.clamp(
                    d * this.hipAimYawGain, -this.hipAimYawMax, this.hipAimYawMax) * fall;
            }
        }
        this._hipAimYawValue += (hipYawTarget - this._hipAimYawValue) * (1 - Math.exp(-this.aimPitchLerp * t));

        // Nothing to apply unless the pitch lean is active OR the hip-fire twist is non-negligible.
        if(this._aimPitchWeight < 0.001 && Math.abs(this._hipAimYawValue) < 1e-4){ return; }

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

        // Run-aim yaw: while AIMING AND running FORWARD, twist the spine ~20° CW so the forward jog's
        // torso swing doesn't carry the gun off the reticle. This twist is calibrated for the FORWARD
        // swing only — applying it while STRAFING (jogL/jogR) or backpedalling pushed the gun off the
        // aim target, so it's now restricted to jogF. When strafing, the gun stays on target via the
        // body facing the look direction + the steady idle aim pose + the additive pitch lean (and the
        // firmer aim hip-stabilization below keeps the strafing legs from swinging it off).
        const runYawActive = (this.IsAiming() && this.lowerState === 'jogF') ? 1 : 0;
        this._runAimYawValue += (this.runAimYaw * runYawActive - this._runAimYawValue)
            * (1 - Math.exp(-this.runAimYawLerp * t));

        // The collision + run-aim yaws ride the pitch-lean weight (they're aim-coupled); the hip-fire
        // twist is added RAW (its own ease above) so it works even when the pitch lean is inactive.
        const yaw = (this._aimYawValue + this._runAimYawValue) * this._aimPitchWeight + this._hipAimYawValue;

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

    // FPS weapon look-pitch: tilt the held weapon up/down with the look altitude so it stays framed on
    // screen even when NOT aiming (the FPS body only tracks yaw, so without this the gun points flat
    // when you look up/down and slides out of view). Rotates BOTH upper arms — which carry the gun and
    // the support hand — about the body-right axis by the look pitch, NOT the spine, so the head bone
    // (and the FPS eye riding it) stays put. Same sign convention as the TPS spine lean (-angles.x =>
    // look up tilts the gun up). Eased + clamped; the barrel IK still re-aims exactly while ADS.
    UpdateFpsWeaponPitch(t){
        const pc = this.playerControls;
        if(!pc || !this.fpsArmBones.length){ return; }
        const targetPitch = THREE.MathUtils.clamp(
            -pc.angles.x * this.fpsLookPitchGain, -this.fpsLookPitchMax, this.fpsLookPitchMax);
        this._fpsPitchValue += (targetPitch - this._fpsPitchValue) * (1 - Math.exp(-this.aimPitchLerp * t));
        if(Math.abs(this._fpsPitchValue) < 1e-4){ return; }
        // Body-right axis in world: local +X carried through the (yaw-only) facing.
        this._aimRight.set(Math.cos(this._bodyYaw), 0, -Math.sin(this._bodyYaw));
        for(const bone of this.fpsArmBones){
            this._aimR.setFromAxisAngle(this._aimRight, this._fpsPitchValue);   // full pitch on each arm
            bone.parent.getWorldQuaternion(this._aimPW);
            this._aimPWInv.copy(this._aimPW).invert();
            // newLocal = parentWorld^-1 * R * parentWorld * oldLocal
            this._aimDelta.copy(this._aimPWInv).multiply(this._aimR).multiply(this._aimPW);
            bone.quaternion.premultiply(this._aimDelta);
        }
    }

    // Aiming (right-click ADS, either camera mode) OR recently fired (full-auto re-arms _shootHold
    // each shot). This is the gate for the weapon alignment + two-hand IK — "point the gun at the
    // target while aiming or shooting", and leave plain locomotion alone otherwise.
    IsAimingOrShooting(){
        const pc = this.playerControls;
        return (!!pc && pc.aiming) || this._shootHold > 0;
    }

    // Drive the weapon barrel alignment + two-hand IK each frame. Runs AFTER the additive spine lean
    // (it reads the leaned arm pose) and only while aiming/shooting — never during a reload one-shot
    // (the hands must be free to work the mag) and never during a roll (that branch skips this
    // entirely). WeaponAimIK eases the whole correction in/out, so when it's inactive the gun + arms
    // are left exactly as the animation posed them. Feeds it the crosshair's world target + a
    // camera-forward fallback for too-close / behind-the-muzzle aim.
    UpdateWeaponAim(t){
        if(!this.weaponAimIK || !this.playerControls){ return; }
        const pc = this.playerControls;
        // Suppress the IK while the placement tool owns the camera (cameraOverride) so the gun sits
        // stable at the raw grip while you nudge the FPS_AIM seat, instead of re-aiming at the fly-cam.
        const active = this.IsAimingOrShooting() && this.oneShot !== 'reload' && !pc.cameraOverride;
        // ALWAYS-ON GRIP: the support hand stays glued to the gun whenever a weapon is held — NOT only
        // while aiming. This is what kills the aim<->idle<->shoot hand snap (the hand never releases the
        // foregrip and re-grabs). Dropped only during a reload (the off-hand works the mag) and under the
        // placement-tool camera. The barrel still only swings while `active` (aiming/shooting).
        const gripActive = this.oneShot !== 'reload' && !pc.cameraOverride;
        this._weaponAimActive = active;
        this.weaponAimIK.Update(t, {
            active,
            gripActive,
            aimTarget: pc.aimTarget,
            aimValid: pc.aimTargetValid,
            cameraForward: pc.aimDir,
        });
    }

    // Drive the foot/terrain IK (legs). Gated to grounded, non-rolling, non-airborne so the legs follow
    // the jump/fall/roll clip in the air; FootIK itself fades out with ground speed so the foot-synced
    // jog isn't fought. Reads the live ground speed + the body facing (knee pole). Last pose write.
    UpdateFootIK(t){
        if(!this.footIK || !this.playerControls){ return; }
        const pc = this.playerControls;
        const enabled = pc.IsGrounded && this.airState === null && !this.rolling;
        // Floor the weight at the crouch amount: a crouched body is lowered, so the feet must stay
        // planted (knees bent) even while crouch-walking, not fade out and sink through the floor.
        this.footIK.Update(t, { enabled, speed: pc.HorizontalSpeed, bodyYaw: this._bodyYaw, floor: this._crouchEased });
    }

    // Orient the head to look along the crosshair direction, so the character visibly looks where the
    // camera looks. ALWAYS-ON in TPS (eased fast so the gaze LEADS the gun); inert in FPS (head culled).
    // Builds a world-space delta from the head's PRE-FLINCH animated gaze (reference) onto the crosshair
    // DIRECTION (desired), holds at the neck clamp + eases out only near 180°, eased by the weight, and
    // applies it additively to the head bone (world delta -> bone-local). See the constructor note:
    // direction (not point) kills depth-parallax swing; pre-flinch actual-gaze reference kills the
    // double-count WHILE preserving the hurt flinch; the hold-at-clamp avoids a direction reversal and
    // the near-180° ease avoids the antiparallel axis flip.
    UpdateHeadAim(t){
        if(!this.headBone || !this.playerControls){ return; }
        const pc = this.playerControls;
        const active = (this.cameraMode === 'TPS') ? 1 : 0;
        this.headAimWeight += (active - this.headAimWeight) * (1 - Math.exp(-this.headAimLerp * t));
        if(this.headAimWeight < 1e-3){ return; }

        // Desired gaze = the pure crosshair DIRECTION (the FX-free look forward, pc.aimDirRaw). NOT the
        // world aim POINT (the TPS camera is behind/beside the head, so head->point is depth/parallax-
        // sensitive and the depth low-pass would swing the head on a near/far edge crossing), and NOT
        // pc.aimDir (which carries the camera shake + ADS-walk wobble and would leak that into the head).
        // A direction is depth-free; lateral tracking stays instant. (The GUN still uses the exact point.)
        this._headFwdDes.copy(pc.aimDirRaw || pc.aimDir);
        if(this._headFwdDes.lengthSq() < 1e-6){ return; }
        this._headFwdDes.normalize();

        // Reference gaze = the head's PRE-FLINCH world-forward this frame (snapshot in Update, before
        // hurtFlinch). It already carries the spine lean + hip twist (so the delta supplies only the
        // residual — no double-count), but NOT the flinch (so the head-aim doesn't cancel the hit jolt).
        // _headFwdLocal is the rest-pose gaze axis pre-seeded in Initialize, so it's always set.
        if(this._headFwdLocal){
            this._headFwdRef.copy(this._headFwdLocal).applyQuaternion(this._headPreFlinchWQ).normalize();
        }else{
            // Defensive fallback (no head bone at init): the bare body facing is correct while un-leaned.
            this._headFwdRef.set(Math.sin(this._bodyYaw), 0, Math.cos(this._bodyYaw));
        }

        // Look delta (ref -> desired), eased by the weight. Past the neck clamp the head HOLDS at its
        // limit (s = maxAngle/ang keeps the rendered turn at exactly maxAngle while still tracking the
        // target's AZIMUTH — no direction reversal). A SEPARATE near-180° ease drops the whole delta to 0
        // only where the target is nearly directly behind, the one region where setFromUnitVectors' axis
        // is unstable — so the head gives up gracefully there instead of snapping/rolling.
        this._headAimQ.setFromUnitVectors(this._headFwdRef, this._headFwdDes);
        const ang = Math.acos(THREE.MathUtils.clamp(this._headFwdRef.dot(this._headFwdDes), -1, 1));
        let s = this.headAimWeight;
        if(ang > this.maxHeadAimAngle){ s *= this.maxHeadAimAngle / ang; }
        s *= 1 - THREE.MathUtils.smoothstep(ang, this.headAimAntiparallelStart, this.headAimAntiparallelEnd);
        this._headAimWorld.copy(this._headAimId).slerp(this._headAimQ, s);

        // Apply the world delta about the head's origin: newLocal = parentW^-1 * delta * parentW * old.
        this.headBone.parent.getWorldQuaternion(this._headAimPW);
        this._headAimPWInv.copy(this._headAimPW).invert();
        this._headAimLocal.copy(this._headAimPWInv).multiply(this._headAimWorld).multiply(this._headAimPW);
        this.headBone.quaternion.premultiply(this._headAimLocal);
        this.headBone.updateWorldMatrix(false, false);
    }

    // Ease the avatar's facing toward the camera yaw instead of snapping to it. While
    // moving or aiming the body tracks promptly (the walk/aim must read forward); while
    // idle it stays put inside bodyTurnDeadzone and only trails the camera softly past
    // it, so looking around orbits the camera about a still character. Yaw maths use the
    // shortest signed arc (atan2 of sin/cos) so the body never spins the long way round.
    UpdateBodyYaw(t){
        const target = this.playerControls.angles.y + this.yawOffset;
        if(this._bodyYaw === null){ this._bodyYaw = target; }

        // Dodge roll: hold the body on the roll direction (snapped in StartRoll) so the forward
        // somersault travels the way the player dodged, regardless of where the camera looks.
        if(this.rolling){
            const dR = Math.atan2(Math.sin(this._rollYaw - this._bodyYaw), Math.cos(this._rollYaw - this._bodyYaw));
            this._bodyYaw += dR * (1 - Math.exp(-this.rollYawLerp * t));
            this._bodyYaw = Math.atan2(Math.sin(this._bodyYaw), Math.cos(this._bodyYaw));
            this.modelRoot.rotation.set(0, this._bodyYaw, 0);
            return;
        }

        // First-person: track the look yaw tightly (small lag) so the arms/gun stay in frame, with an
        // eased aim-centring bias while ADS. No deadzone/idle-trail here — that's a TPS-only behaviour.
        if(this.cameraMode === 'FPS'){
            const aiming = !!(this.playerControls && this.playerControls.aiming);
            const biasTarget = aiming ? this.fpsAimYawBias : 0;
            this._fpsAimBias += (biasTarget - this._fpsAimBias) * (1 - Math.exp(-this.fpsAimBiasLerp * t));
            const goalF = target + this._fpsAimBias;
            const dF = Math.atan2(Math.sin(goalF - this._bodyYaw), Math.cos(goalF - this._bodyYaw));
            this._bodyYaw += dF * (1 - Math.exp(-this.fpsBodyTurnLerp * t));
            this._bodyYaw = Math.atan2(Math.sin(this._bodyYaw), Math.cos(this._bodyYaw));
            this.modelRoot.rotation.set(0, this._bodyYaw, 0);
            return;
        }

        const aiming = this.IsAiming();
        const moving = this.playerControls.HorizontalSpeed > 0.5;
        let goal, rate;
        if(aiming){
            // ADS: square the body to the camera/look and STRAFE (directional jogs) so the gun stays
            // trained on the reticle while you sidestep.
            goal = target;
            rate = this.bodyTurnMoveLerp;
        }else if(moving){
            // Free-run: face the actual WORLD MOVEMENT heading and run forward (DesiredLocoState plays
            // jogF), so a diagonal run doesn't foot-slide a single directional clip across a 45° travel.
            // Heading = look yaw + the local velocity's heading offset (atan2(0,-1)=π folds in yawOffset,
            // so pure-forward W lands exactly on `target`).
            goal = this.playerControls.angles.y
                + Math.atan2(this.playerControls.speed.x, this.playerControls.speed.z);
            rate = this.bodyTurnMoveLerp;
        }else{
            // Idle: hold inside the deadzone; past it, trail the camera by exactly the deadzone so the
            // body follows gently rather than chasing every micro-pan.
            const diff = Math.atan2(Math.sin(target - this._bodyYaw), Math.cos(target - this._bodyYaw));
            goal = Math.abs(diff) <= this.bodyTurnDeadzone
                ? this._bodyYaw
                : this._bodyYaw + Math.sign(diff) * (Math.abs(diff) - this.bodyTurnDeadzone);
            rate = this.bodyTurnIdleLerp;
        }
        const d = Math.atan2(Math.sin(goal - this._bodyYaw), Math.cos(goal - this._bodyYaw));
        this._bodyYaw += d * (1 - Math.exp(-rate * t));
        this._bodyYaw = Math.atan2(Math.sin(this._bodyYaw), Math.cos(this._bodyYaw));
        this.modelRoot.rotation.set(0, this._bodyYaw, 0);
    }
}
