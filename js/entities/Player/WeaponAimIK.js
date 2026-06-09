import * as THREE from 'three'
import { IKChainSolver } from '../Common/IKUtils.js'


// Weapon aim-alignment + two-hand IK solver (reusable; the player wires one of these in PlayerBody).
//
// WHAT IT FIXES. The visible gun is the AK socketed into hand_r (weaponPivot), posed only by the
// rifle clips + the additive spine lean (PlayerBody.UpdateAimPose). That lean APPROXIMATES pointing
// the gun at the look altitude, but it never accounts for the over-the-shoulder parallax between the
// TPS camera and the gun — so the barrel can read as pointing BESIDE the crosshair even though the
// bullet (a camera-centre ray) goes dead-centre. This solver makes the barrel point EXACTLY at the
// aim target (PlayerControls.aimTarget — the same point the shot ray hits), so the visual and the
// projectile agree, then IKs the support hand back onto the foregrip so both hands stay attached.
//
// HOW. Two layers, both eased in only while aiming/shooting and out otherwise (so idle/jog/locomotion
// are untouched when you're not aiming):
//   1) WEAPON ALIGNMENT — rotate weaponPivot about the WRIST (hand_r origin, the bone it hangs from)
//      so its muzzle-forward axis points from the muzzle at the aim target. Rotating about the wrist
//      keeps the dominant hand attached for free (the gun is the hand's child; the grip stays in the
//      palm and the gun pivots at the wrist, exactly how a shooter fine-aims). Clamped so an extreme
//      look can't wrench the gun, low-passed so it's smooth but responsive, and a refine pass nails
//      the convergence (the muzzle moves as it rotates about the wrist).
//   2) SUPPORT-HAND IK — once the gun has rotated, its foregrip has moved off where the animation put
//      the left hand, so a two-bone analytic IK (upperarm_l -> lowerarm_l -> hand_l) plants the left
//      hand back on the foregrip socket. The elbow keeps the animation's bend plane (no flip), so no
//      broken wrist / twisted elbow.
//
// STATELESS PER FRAME. The mixer rewrites every arm bone each frame BEFORE this runs, so the solver
// reads the freshly-animated pose, applies its deltas on top, and never accumulates — blending all
// the way out returns to the pure animation with no drift and no snap. The dominant hand needs no IK
// (the gun is its child); only the support arm is solved.
//
// SOCKETS are in weaponPivot-LOCAL space. The muzzle + barrel axis are derived from the gun's bbox
// (deterministic); the grip sockets are captured from where the rifle clips actually pose the hands
// on the gun (so engaging aim doesn't shift the hands). All are overridable per weapon via
// SetWeaponConfig for a real rigged weapon with authored sockets.
//
// NETWORKING. This template is single-player, so there's nothing to replicate here. If multiplayer
// is added later this layer stays purely COSMETIC and CLIENT-SIDE: each client already needs a
// remote player's look orientation / aim point to render them, and feeding that as `aimTarget` makes
// the remote avatar's barrel + hands resolve identically on every client with no extra state to sync
// (the solve is deterministic from the pose + aim target). Authoritative hit detection stays where it
// is — the camera-centre shot ray — independent of this visual alignment.
export default class WeaponAimIK{
    constructor(model, weaponPivot, opts = {}){
        this.model = model;
        this.weaponPivot = weaponPivot;
        this.handBoneR = weaponPivot ? weaponPivot.parent : null;   // hand_r — the wrist we pivot the gun about

        // ---- Designer-facing tuning (the names the feature request asks for) ----
        this.AimAlignmentBlendSpeed = opts.AimAlignmentBlendSpeed ?? 12;   // ease rate (1/s) blending the whole correction in/out
        this.WeaponIKBlendAlpha     = opts.WeaponIKBlendAlpha     ?? 1.0;  // max weight of the SUPPORT-HAND IK (0..1)
        this.AimCorrectionStrength  = opts.AimCorrectionStrength  ?? 1.0;  // 0..1 — how fully the barrel snaps onto the target
        this.MaxAimCorrectionAngle  = opts.MaxAimCorrectionAngle  ?? THREE.MathUtils.degToRad(55); // clamp on the barrel rotation
        this.AimSmoothingSpeed      = opts.AimSmoothingSpeed      ?? 20;   // low-pass rate (1/s) on the aim DIRECTION (responsive, not floaty)
        this.MuzzleForwardAxis      = opts.MuzzleForwardAxis ? opts.MuzzleForwardAxis.clone() : null; // local barrel axis (auto-detected if null)
        this.RightHandOffset        = opts.RightHandOffset ? opts.RightHandOffset.clone() : new THREE.Vector3(); // dominant grip socket nudge (pivot-local)
        this.LeftHandOffset         = opts.LeftHandOffset  ? opts.LeftHandOffset.clone()  : new THREE.Vector3(); // support grip socket nudge (pivot-local)
        this.twoHanded              = opts.twoHanded ?? true;              // false => one-handed (skip support-hand foregrip IK)
        // One-handed off-hand relax: for a single-handed weapon (twoHanded:false) the support hand has no
        // foregrip to grab, so instead of leaving it reaching for a phantom grip (the rifle clips pose it
        // there), ease the support arm toward HANGING DOWN. Rig-agnostic (blends the shoulder->elbow
        // direction toward world-down), weighted by the grip blend. 0 = leave on the animation.
        this.offHandRelax           = opts.offHandRelax ?? 0.6;
        this.minAimDistance         = opts.minAimDistance ?? 0.9;         // target closer than this to the muzzle => aim down camera-forward instead
        this.refineIterations       = opts.refineIterations ?? 1;         // muzzle-move refine passes for exact convergence

        // Support-hand WRIST LOCK. On by default: the support hand is glued to the gun in BOTH
        // translation (the two-bone IK plants it on the foregrip) AND orientation (the palm keeps the
        // exact hand-vs-gun rotation the animation had at rest, carried by the gun as it aims). This is
        // what kills the "the hand drifts off the gun / the contact offsets" glitch — without it the
        // wrist follows the forearm as animated and slides on the grip when the gun rotates to aim. The
        // rest relationship is CAPTURED from the posed hand (CaptureGripSockets), so it self-calibrates
        // to whatever grip the rifle clips author — no per-rig hand-tuned angle needed.
        this.lockSupportHand       = opts.lockSupportHand ?? true;
        this.leftGripQuatLocal     = new THREE.Quaternion();   // hand_l orientation in weaponPivot-local frame (rest)
        this._leftGripQuatCaptured = false;
        // Legacy explicit-offset path (a real weapon can author a palm angle instead of the captured
        // rest). When matchHandToGrip is on it overrides the captured lock with weaponWorld*offset.
        this.matchHandToGrip       = opts.matchHandToGrip ?? false;
        this.LeftHandRotationOffset = opts.LeftHandRotationOffset ? opts.LeftHandRotationOffset.clone() : new THREE.Quaternion();

        // ---- Resolved rig + sockets ----
        this.bones = { upperarm_l: null, lowerarm_l: null, hand_l: null, hand_r: null };
        this.muzzleLocal = new THREE.Vector3();      // barrel tip, weaponPivot-local (muzzle flash / trace origin)
        this.aimSocketLocal = new THREE.Vector3();   // aim-alignment socket (the point the barrel ray emanates from) — defaults to the muzzle
        this.forwardLocal = new THREE.Vector3(0, 0, 1); // unit barrel-forward, weaponPivot-local
        this.rightGripLocal = new THREE.Vector3();   // dominant hand contact on the gun (debug / 1-handed)
        this.leftGripLocal = new THREE.Vector3();    // support hand contact (foregrip) — the IK target
        this._aimSocketOverridden = false;           // true once a weapon supplies its own aim socket
        this._barrelResolved = false;
        this._socketsCaptured = false;

        // ---- Base weapon placement (the static WEAPON_GRIP from buildUeMannequin). The TPS AK is not
        // animated, so its local transform is constant; we recompute the aim correction from this base
        // every frame so there's no drift. ----
        this._baseQuat = new THREE.Quaternion();
        this._basePos = new THREE.Vector3();
        this._baseCaptured = false;

        // ---- Eased state ----
        // TWO independent blends (the split that kills the idle<->aim<->shoot hand SNAP). Previously a
        // single `_alpha` gated BOTH the barrel alignment AND the support-hand grip together, eased in
        // only while aiming/shooting — so leaving aim RELEASED the support hand from the foregrip back
        // to the raw clip pose (the visible snap). Now:
        //   * _gripAlpha — eases toward 1 whenever a two-handed weapon is HELD (independent of aim).
        //     Drives the support-hand two-bone IK + wrist-lock, so the hands are ALWAYS glued to the
        //     gun and never release. At rest the captured socket == the animated hand, so it's a no-op
        //     until the gun actually moves (aim/lean/locomotion). The clip becomes elbow-pose influence.
        //   * _aimAlpha — eases in/out with aiming/shooting exactly as the old `_alpha` did. Drives ONLY
        //     the hand_r barrel rotation (the gun's aim DIRECTION). So engaging aim only swings the
        //     barrel; the hands stay put and the support arm re-solves onto the moved foregrip smoothly.
        this._gripAlpha = 0;                          // 0..1 support-hand grip blend (always-on for 2-handed)
        this._aimAlpha = 0;                           // 0..1 barrel-alignment blend (aim/shoot only)
        this.GripBlendSpeed = opts.GripBlendSpeed ?? 8; // grip ease rate (1/s) — a touch slower so the hand GLIDES onto the gun on spawn
        this._aimDir = new THREE.Vector3(0, 0, -1);  // low-passed world aim direction
        this._aimDirSeeded = false;

        // ---- Scratch (no per-frame allocation) ----
        this._P = new THREE.Vector3();               // wrist world position (rotation pivot)
        this._aimW = new THREE.Vector3();            // aim-socket world position (alignment ray origin)
        this._fwdW = new THREE.Vector3();
        this._desired = new THREE.Vector3();
        this._rawDesired = new THREE.Vector3();
        this._qA = new THREE.Quaternion();
        this._qB = new THREE.Quaternion();
        this._qFull = new THREE.Quaternion();
        this._qApplied = new THREE.Quaternion();
        this._qLocal = new THREE.Quaternion();
        this._handWQ = new THREE.Quaternion();
        this._handWQInv = new THREE.Quaternion();
        this._hq1 = new THREE.Quaternion();          // scratch: optional wrist-wrap target
        this._hq2 = new THREE.Quaternion();          // scratch: optional wrist-wrap blend
        this._weaponWQ = new THREE.Quaternion();
        this._tmpV = new THREE.Vector3();
        this._tmpV2 = new THREE.Vector3();
        this._leftTarget = new THREE.Vector3();
        this._ikE = new THREE.Vector3();
        // Off-hand relax scratch (one-handed weapons).
        this._offA = new THREE.Vector3(); this._offB = new THREE.Vector3();
        this._offCur = new THREE.Vector3(); this._offDes = new THREE.Vector3();
        this._offDown = new THREE.Vector3(0, -1, 0); this._offQ = new THREE.Quaternion();
        // Two-bone IK scratch.
        this._R = new THREE.Vector3(); this._M = new THREE.Vector3(); this._E = new THREE.Vector3();
        this._v1 = new THREE.Vector3();
        this._n = new THREE.Vector3(); this._u = new THREE.Vector3();
        this._Mp = new THREE.Vector3(); this._Ep = new THREE.Vector3();
        this._re = new THREE.Vector3(); this._rt = new THREE.Vector3(); this._rt2 = new THREE.Vector3();
        this._pW = new THREE.Quaternion(); this._pWInv = new THREE.Quaternion();
        this._qDelta = new THREE.Quaternion(); this._qWorld = new THREE.Quaternion();
        this._idQ = new THREE.Quaternion();          // permanent identity (slerp base) — never mutated
        this._scaleQ = new THREE.Quaternion();       // scratch for _scaleQuatAngle
        this._perp = new THREE.Vector3();            // scratch for the straight-arm bend-plane fallback
        // Elbow-pole stabilization (kills the support-arm flip on extreme cross-body aim): a stable
        // anatomical reference the support elbow should bend toward (down + a touch forward), and the
        // scratch it's resolved into.
        this._poleRef  = new THREE.Vector3();        // reference pole (world-down) projected into the bend plane
        this._poleDown = new THREE.Vector3(0, -1, 0);// the support elbow hangs DOWN — a fixed, gimbal-free ref
        // How strongly the support elbow is locked to the down reference (0 = pure animation/gimbal,
        // 1 = always straight down). High enough to kill the swivel/gimbal as the aim sweeps while still
        // reading natural for a rifle grip.
        this.supportElbowStabilize = 0.7;

        // Shared two-bone IK solver (analytic, sign-safe). Owns its own scratch pool so the support-arm
        // solve never clobbers the leg solves' intermediates. The two-bone scratch declared above is now
        // unused (the solver owns it) but left in place to keep this refactor behaviour-neutral; _pW/
        // _pWInv/_poleDown/_idQ/_scaleQ ARE still used directly below (wrist-lock, clamp, pole hint).
        this.ik = new IKChainSolver();

        // Debug snapshot for WeaponAimDebug (filled each frame; read-only for consumers).
        this._debug = {
            active: false, alpha: 0, gripAlpha: 0, valid: false, distance: 0,
            aimTarget: new THREE.Vector3(),
            muzzle: new THREE.Vector3(),
            barrelFwd: new THREE.Vector3(),     // where the barrel actually points after correction
            correctedDir: new THREE.Vector3(),  // muzzle -> aim target (desired)
            rightGrip: new THREE.Vector3(),
            leftGrip: new THREE.Vector3(),
            handTarget: new THREE.Vector3(),
        };

        if(this.weaponPivot){ this.ResolveBones(); }
    }

    // Find the arm chain + hands by UE bone name (confirmed present on SK_Mannequin: upperarm_l,
    // lowerarm_l, hand_l, hand_r). Missing bones leave the solver a graceful no-op for that part.
    ResolveBones(){
        const want = this.bones;
        this.model.traverse(o => {
            if(!o.isBone){ return; }
            if(o.name in want && !want[o.name]){ want[o.name] = o; }
        });
        // The wrist we pivot the gun about is the bone the weapon is parented to (hand_r).
        if(!this.handBoneR){ this.handBoneR = want.hand_r; }
    }

    // Muzzle + barrel-forward axis from the gun's bounding box, in weaponPivot-local space — the same
    // derivation WeaponManager.BuildMuzzleAnchor uses for the flash, so they agree. The barrel is the
    // gun's longest local axis; the muzzle is the end of it farther from the wrist; forward points
    // from the gun centre out the muzzle. Deterministic (geometry-relative), so it needs no posed
    // frame — resolved once, lazily, on the first Update.
    ResolveBarrel(){
        const pivot = this.weaponPivot;
        if(!pivot){ return; }
        pivot.updateWorldMatrix(true, true);
        const toLocal = new THREE.Matrix4().copy(pivot.matrixWorld).invert();
        const box = new THREE.Box3();
        const corner = new THREE.Vector3();
        let any = false;
        pivot.traverse(o => {
            if(!o.isMesh || !o.geometry){ return; }
            o.geometry.computeBoundingBox();
            const bb = o.geometry.boundingBox;
            for(let i = 0; i < 8; i++){
                corner.set((i & 1) ? bb.max.x : bb.min.x, (i & 2) ? bb.max.y : bb.min.y, (i & 4) ? bb.max.z : bb.min.z);
                corner.applyMatrix4(o.matrixWorld).applyMatrix4(toLocal);
                box.expandByPoint(corner);
                any = true;
            }
        });
        if(!any){ this.forwardLocal.set(0, 0, 1); this._barrelResolved = true; return; }

        const size = box.getSize(this._tmpV);
        const center = box.getCenter(this._tmpV2);
        const axis = (size.x >= size.y && size.x >= size.z) ? 'x' : (size.y >= size.z ? 'y' : 'z');

        const endA = center.clone(); endA[axis] = box.max[axis];
        const endB = center.clone(); endB[axis] = box.min[axis];
        // Muzzle = the barrel end farther from the wrist (hand_r), measured in world space.
        const handPos = new THREE.Vector3();
        (this.handBoneR || pivot).getWorldPosition(handPos);
        const wa = endA.clone().applyMatrix4(pivot.matrixWorld);
        const wb = endB.clone().applyMatrix4(pivot.matrixWorld);
        const muzzle = wa.distanceToSquared(handPos) >= wb.distanceToSquared(handPos) ? endA : endB;
        this.muzzleLocal.copy(muzzle);
        // The aim-alignment socket defaults to the muzzle (a weapon can override it to e.g. a sight).
        if(!this._aimSocketOverridden){ this.aimSocketLocal.copy(muzzle); }
        // Forward = from gun centre toward the muzzle (unit), unless overridden per weapon.
        if(this.MuzzleForwardAxis){ this.forwardLocal.copy(this.MuzzleForwardAxis).normalize(); }
        else{ this.forwardLocal.copy(muzzle).sub(center).normalize(); }
        this._barrelResolved = true;
    }

    // Capture the static base placement of the weapon (the WEAPON_GRIP transform). Done once; the TPS
    // AK is never animated, so this is constant and is the clean base every aim correction starts from.
    CaptureBase(){
        if(!this.weaponPivot){ return; }
        this._baseQuat.copy(this.weaponPivot.quaternion);
        this._basePos.copy(this.weaponPivot.position);
        this._baseCaptured = true;
    }

    // Capture the grip sockets from where the rifle clips currently pose the hands ON the gun, so
    // engaging aim doesn't shift the hands (the IK target equals the animated hand position at rest).
    // Must run with the weapon at its base transform and a posed (idle) frame — called on first Update.
    CaptureGripSockets(){
        const pivot = this.weaponPivot;
        if(!pivot){ return; }
        pivot.updateWorldMatrix(true, false);
        if(this.bones.hand_l){
            this.bones.hand_l.getWorldPosition(this._tmpV);
            this.leftGripLocal.copy(pivot.worldToLocal(this._tmpV.clone()));
            // Capture hand_l's orientation RELATIVE to the gun at rest (pivot-local). The wrist lock
            // keeps exactly this hand-vs-gun rotation as the gun rotates to aim, so the palm stays
            // wrapped on the foregrip instead of sliding/twisting off it — self-calibrating, no offset.
            pivot.getWorldQuaternion(this._pW);
            this.bones.hand_l.getWorldQuaternion(this._hq2);
            this.leftGripQuatLocal.copy(this._pW).invert().multiply(this._hq2);
            this._leftGripQuatCaptured = true;
        }else{
            // No left hand bone: default the foregrip to ~35% up the barrel from centre.
            this.leftGripLocal.copy(this.muzzleLocal).multiplyScalar(0.55);
        }
        if(this.bones.hand_r){
            this.bones.hand_r.getWorldPosition(this._tmpV);
            this.rightGripLocal.copy(pivot.worldToLocal(this._tmpV.clone()));
        }
        this._socketsCaptured = true;
    }

    // Per-weapon override: authored sockets/offsets/forward-axis (pivot-local). Any field omitted keeps
    // the auto-resolved/captured value. Resets the low-pass so a switch mid-aim doesn't snap.
    SetWeaponConfig(cfg = {}){
        if(cfg.muzzle){ this.muzzleLocal.copy(cfg.muzzle); this._barrelResolved = true; }
        if(cfg.aimSocket){ this.aimSocketLocal.copy(cfg.aimSocket); this._aimSocketOverridden = true; }
        if(cfg.muzzleForwardAxis){ this.MuzzleForwardAxis = cfg.muzzleForwardAxis.clone(); this.forwardLocal.copy(cfg.muzzleForwardAxis).normalize(); }
        if(cfg.rightGrip){ this.rightGripLocal.copy(cfg.rightGrip); }
        if(cfg.leftGrip){ this.leftGripLocal.copy(cfg.leftGrip); this._socketsCaptured = true; }
        if(cfg.LeftHandOffset){ this.LeftHandOffset.copy(cfg.LeftHandOffset); }
        if(cfg.RightHandOffset){ this.RightHandOffset.copy(cfg.RightHandOffset); }
        if(cfg.LeftHandRotationOffset){ this.LeftHandRotationOffset.copy(cfg.LeftHandRotationOffset); }
        if(cfg.matchHandToGrip !== undefined){ this.matchHandToGrip = cfg.matchHandToGrip; }
        if(cfg.twoHanded !== undefined){ this.twoHanded = cfg.twoHanded; }
        if(cfg.offHandRelax !== undefined){ this.offHandRelax = cfg.offHandRelax; }
        if(cfg.AimCorrectionStrength !== undefined){ this.AimCorrectionStrength = cfg.AimCorrectionStrength; }
        if(cfg.MaxAimCorrectionAngle !== undefined){ this.MaxAimCorrectionAngle = cfg.MaxAimCorrectionAngle; }
        if(cfg.AimSmoothingSpeed !== undefined){ this.AimSmoothingSpeed = cfg.AimSmoothingSpeed; }
        if(cfg.AimAlignmentBlendSpeed !== undefined){ this.AimAlignmentBlendSpeed = cfg.AimAlignmentBlendSpeed; }
        this._aimDirSeeded = false;   // reseed the low-pass to avoid a visible swing on the swap
    }

    // Called by WeaponManager when the active weapon changes. Only the aim low-pass is reseeded so a
    // switch WHILE aiming glides. Sockets/barrel are NOT re-derived here: re-capturing the grip from the
    // posed hand mid-aim reads it at the IK-rotated position (a wrong socket) and snaps the support arm.
    // All weapons in this template share the in-hand mesh, so the init-captured sockets already fit; a
    // genuinely different rigged mesh supplies its own via ikConfig (SetWeaponConfig), applied on equip.
    OnWeaponChanged(){
        this._aimDirSeeded = false;
    }

    // Hard-reset the eased correction to fully OFF. Used when the body hands the whole pose off to a
    // dodge roll: Update is skipped for the roll's duration, so without this the master blend stays
    // FROZEN at its pre-roll value (~1 if you rolled while firing) and re-applies the full barrel/
    // support-hand correction in a single frame at roll recovery — a one-frame pop. Reset to 0 so it
    // eases back in from nothing (and reseed the aim low-pass so it doesn't swing in from a stale dir).
    Reset(){
        this._gripAlpha = 0;
        this._aimAlpha = 0;
        this._aimDirSeeded = false;
    }

    // Main solve. Call AFTER the mixer + spine lean each frame.
    //   active        : aim/shoot is engaged (drives the BARREL alignment; eases out otherwise)
    //   gripActive    : a weapon is held and the hands should be glued to it (drives the SUPPORT-hand
    //                   grip; on for a held weapon except during a reload). Defaults to `active` so a
    //                   caller that doesn't opt into the always-on grip behaves exactly as before.
    //   aimTarget     : world point under the crosshair (PlayerControls.aimTarget)
    //   aimValid      : the crosshair ray hit geometry (else aimTarget is a far fallback)
    //   cameraForward : unit camera-forward (fallback aim direction for too-close / behind targets)
    //   t             : delta seconds
    Update(t, { active, gripActive = active, aimTarget, aimValid = true, cameraForward = null }){
        const pivot = this.weaponPivot;
        if(!pivot || !this.handBoneR){ return; }

        // Ease the TWO blends independently (the split that kills the hand snap). Grip is always-on for
        // a held weapon (so the hands never release the gun); aim eases in/out with aiming/shooting.
        const targetGrip = gripActive ? 1 : 0;
        const targetAim  = active ? 1 : 0;
        this._gripAlpha += (targetGrip - this._gripAlpha) * (1 - Math.exp(-this.GripBlendSpeed * t));
        this._aimAlpha  += (targetAim  - this._aimAlpha)  * (1 - Math.exp(-this.AimAlignmentBlendSpeed * t));
        // Keep the aim direction unseeded while aim is released, so re-aiming seeds straight to the live
        // target with no swing-in (the grip path may still run below, but the barrel apply is ~identity).
        if(this._aimAlpha < 1e-3){ this._aimDirSeeded = false; }

        // One-time lazy resolves on the FIRST update. The grip-socket capture reads where the rifle clip
        // poses hand_l ON the gun, so the FIRST update MUST land on a CLIP-posed frame, not the bind/
        // T-pose — else the always-on support IK plants the hand at the bind-pose socket (the "support
        // arm flung in the air" NPC bug). The owner guarantees this by playing an idle rifle action in its
        // Initialize BEFORE the first Update (PlayerBody + UeSoldierController both do), so frame 1 is
        // posed with the hand on the gun. NOT re-run on a weapon switch (OnWeaponChanged).
        if(!this._baseCaptured){ this.CaptureBase(); }
        if(!this._barrelResolved){ this.ResolveBarrel(); }
        if(!this._socketsCaptured){ this.CaptureGripSockets(); }

        // Both blends fully released: leave the weapon + arm entirely to the animation (so idle reads
        // exactly as authored). The mixer rewrites the arm each frame, so nothing lingers. With the
        // always-on grip this is rare while a two-handed weapon is held (grip stays engaged) — it mainly
        // fires during a reload (grip eased out so the hands work the mag) or with no weapon.
        if(this._gripAlpha < 1e-3 && this._aimAlpha < 1e-3){
            this._debug.active = false;
            this._debug.alpha = 0;
            this._aimDirSeeded = false;
            return;
        }

        // Refresh world matrices for clean reads (the spine lean just edited the chain).
        this.model.updateMatrixWorld(true);

        // --- Reset the weapon to its static base, then compute the barrel correction from it. ---
        pivot.quaternion.copy(this._baseQuat);
        pivot.position.copy(this._basePos);
        pivot.updateWorldMatrix(false, false);

        this.handBoneR.getWorldPosition(this._P);                 // wrist = rotation pivot
        pivot.getWorldQuaternion(this._weaponWQ);
        this._aimW.copy(this.aimSocketLocal).applyMatrix4(pivot.matrixWorld);   // base aim socket (world)
        this._fwdW.copy(this.forwardLocal).applyQuaternion(this._weaponWQ).normalize();   // base forward (world)

        // Desired aim direction = aim socket -> aim target, low-passed. Fall back to camera-forward
        // when the target is too close to the socket or behind it (a wall hugged point-blank), so the
        // barrel never whips to point at something inside the gun.
        this._rawDesired.copy(aimTarget).sub(this._aimW);
        const dist = this._rawDesired.length();
        const behind = cameraForward && this._rawDesired.dot(cameraForward) < 0;
        if(dist < this.minAimDistance || behind || dist < 1e-4){
            if(cameraForward){ this._rawDesired.copy(cameraForward); }
            else{ this._rawDesired.copy(this._fwdW); }
        }
        this._rawDesired.normalize();
        // Low-pass the direction (smooth but responsive). Seed on first use so it doesn't swing in.
        if(!this._aimDirSeeded){ this._aimDir.copy(this._rawDesired); this._aimDirSeeded = true; }
        else{ this._aimDir.lerp(this._rawDesired, 1 - Math.exp(-this.AimSmoothingSpeed * t)).normalize(); }
        this._desired.copy(this._aimDir);

        // --- Barrel alignment quaternion (with a refine pass: the muzzle moves as it rotates about
        // the wrist, so realign once for exact convergence). ---
        this._qA.setFromUnitVectors(this._fwdW, this._desired);
        this._qFull.copy(this._qA);
        // Refine: simulate applying qA about the wrist, recompute muzzle/forward, realign.
        for(let i = 0; i < this.refineIterations; i++){
            this._fwdW.applyQuaternion(this._qA).normalize();                 // forward after qA
            this._tmpV.copy(this._aimW).sub(this._P).applyQuaternion(this._qA).add(this._P); // aim socket after qA
            this._aimW.copy(this._tmpV);
            this._rawDesired.copy(aimTarget).sub(this._aimW);
            if(this._rawDesired.length() < 1e-4){ break; }
            this._rawDesired.normalize();
            this._qB.setFromUnitVectors(this._fwdW, this._rawDesired);
            this._qFull.premultiply(this._qB);                               // compose total
            this._qA.copy(this._qB);
        }

        // Clamp the total correction angle, scale by strength, then ease by the AIM blend (so the barrel
        // only swings while aiming/shooting — at rest _aimAlpha≈0 and this is ~identity, leaving the gun
        // at its base while the support hand still grips it via _gripAlpha below).
        this._clampQuatAngle(this._qFull, this.MaxAimCorrectionAngle);
        if(this.AimCorrectionStrength < 0.999){ this._scaleQuatAngle(this._qFull, this.AimCorrectionStrength); }
        this._qApplied.copy(this._idQ).slerp(this._qFull, this._aimAlpha);

        // Apply the aim correction to the WRIST BONE (hand_r) about its origin, NOT to the gun pivot.
        // The gun is a child of hand_r, so rotating the wrist lands the barrel in the SAME world pose a
        // pivot rotation would (the rotation is about the same point — the wrist — so muzzle position &
        // direction, and hence convergence, are identical). The difference is that the dominant hand's
        // FINGER bones are also children of hand_r, so they now rotate WITH the gun — the grip stays
        // glued in the palm. The old pivot-only rotation left the fingers at the animated (un-aimed)
        // pose while the gun swung, so the gun slid out from under them: the "hand slides a bit on the
        // gun when aiming" glitch, worst at up/down aim where the correction angle is largest. The
        // pivot stays at its captured base (reset above); the wrist articulates by the (clamped)
        // correction — exactly how a shooter cocks the wrist to fine-aim. The support hand is still
        // re-planted on the foregrip by the IK below, so BOTH hands stay attached.
        this._applyWorldQuat(this.handBoneR, this._qApplied);
        this.handBoneR.updateWorldMatrix(false, true);   // refresh the gun (child) world for the IK + debug reads

        // --- Support-hand IK: plant hand_l on the (now-rotated) foregrip socket. Weighted by the GRIP
        // blend (always-on for a held two-handed weapon), NOT the aim blend — so the support hand stays
        // glued to the gun at idle and through aim/shoot transitions (no release/re-grab snap). ---
        const ikW = this._gripAlpha * this.WeaponIKBlendAlpha;
        this._tmpV.copy(this.leftGripLocal).add(this.LeftHandOffset);
        this._leftTarget.copy(this._tmpV).applyMatrix4(pivot.matrixWorld);   // foregrip world (post-rotation)
        if(this.twoHanded && this._socketsCaptured && this.bones.upperarm_l && this.bones.lowerarm_l && this.bones.hand_l){
            this.bones.hand_l.getWorldPosition(this._ikE);
            // Blend the effector target from the animated hand to the foregrip by the IK weight, so the
            // support hand eases on/off with the aim and never snaps.
            this._tmpV2.copy(this._ikE).lerp(this._leftTarget, ikW);
            // Support-arm elbow: lock the bend plane to a FIXED world-down reference (not the animated
            // pole, and NOT an aim-relative hint — an aim-direction component made the elbow swivel/gimbal
            // as the crosshair swept). supportElbowStabilize biases the elbow to hang consistently below
            // the shoulder->hand line, killing the gimbal while the flip-guard in the solver still stops
            // an outright reverse bend on extreme cross-body aim.
            this._solveTwoBone(this.bones.upperarm_l, this.bones.lowerarm_l, this.bones.hand_l, this._tmpV2,
                this._poleDown, this.supportElbowStabilize);

            // Wrist LOCK: orient hand_l to the gun so the palm stays glued to the foregrip as the gun
            // aims (translation is already planted by the IK above). The desired world orientation is
            // the gun's world quat times the captured rest hand-vs-gun rotation (lockSupportHand, on by
            // default — self-calibrating), or an authored offset (matchHandToGrip). Blended by the IK
            // weight so it eases in/out with the aim and never snaps.
            if((this.lockSupportHand && this._leftGripQuatCaptured) || this.matchHandToGrip){
                const hand = this.bones.hand_l;
                pivot.getWorldQuaternion(this._weaponWQ);
                if(this.matchHandToGrip){ this._hq1.copy(this._weaponWQ).multiply(this.LeftHandRotationOffset); }
                else{ this._hq1.copy(this._weaponWQ).multiply(this.leftGripQuatLocal); }
                hand.getWorldQuaternion(this._hq2).slerp(this._hq1, ikW);               // blend from animated
                hand.parent.getWorldQuaternion(this._pW);
                hand.quaternion.copy(this._pWInv.copy(this._pW).invert()).multiply(this._hq2);
            }
        }else if(!this.twoHanded && this.offHandRelax > 0 && this.bones.upperarm_l && this.bones.lowerarm_l){
            // ONE-HANDED weapon: no foregrip to grab — relax the support arm toward hanging down instead
            // of leaving it reaching for a phantom grip. Eased by the grip blend (ikW).
            this._applyOffHandRest(ikW);
        }

        // --- Debug snapshot ---
        const d = this._debug;
        d.active = true; d.alpha = this._aimAlpha; d.gripAlpha = this._gripAlpha; d.valid = aimValid; d.distance = dist;
        d.aimTarget.copy(aimTarget);
        d.muzzle.copy(this.muzzleLocal).applyMatrix4(pivot.matrixWorld);
        d.barrelFwd.copy(this.forwardLocal).applyQuaternion(pivot.getWorldQuaternion(this._weaponWQ)).normalize();
        d.correctedDir.copy(aimTarget).sub(d.muzzle).normalize();
        d.rightGrip.copy(this.rightGripLocal).add(this.RightHandOffset).applyMatrix4(pivot.matrixWorld);
        d.leftGrip.copy(this._leftTarget);
        d.handTarget.copy(this._leftTarget);
    }

    // One-handed off-hand relax: rotate the support upper arm so its shoulder->elbow direction eases
    // toward world-DOWN by offHandRelax*w, so the off-hand hangs naturally rather than reaching for a
    // foregrip that a one-handed weapon doesn't have. Rig-agnostic (works in world directions); the
    // forearm/hand follow as children. Applied about the shoulder so the arm just lowers.
    _applyOffHandRest(w){
        const up = this.bones.upperarm_l, lo = this.bones.lowerarm_l;
        up.getWorldPosition(this._offA);
        lo.getWorldPosition(this._offB);
        this._offCur.copy(this._offB).sub(this._offA);
        if(this._offCur.lengthSq() < 1e-8){ return; }
        this._offCur.normalize();
        this._offDes.copy(this._offCur).lerp(this._offDown, this.offHandRelax * w);
        if(this._offDes.lengthSq() < 1e-8){ return; }
        this._offDes.normalize();
        this._offQ.setFromUnitVectors(this._offCur, this._offDes);
        this._applyWorldQuat(up, this._offQ);
    }

    // Analytic two-bone IK — now delegated to the shared IKChainSolver (see IKUtils.js). The maths are
    // identical to the version this class used to own; extracting it lets FootIK reuse the exact same
    // sign-safe, pole-stabilized solver. Kept as a thin wrapper so the callsites below are unchanged.
    _solveTwoBone(root, mid, end, targetWorld, poleHint = null, poleStabilize = 0){
        this.ik.solveTwoBone(root, mid, end, targetWorld, poleHint, poleStabilize);
    }

    // Apply a world-space rotation qW to a bone about its origin (delegated to the shared solver):
    // newLocal = parentW^-1 * qW * parentW * oldLocal.
    _applyWorldQuat(bone, qW){
        this.ik.applyWorldQuat(bone, qW);
    }

    // Clamp a quaternion's rotation angle to maxAngle (radians), in place.
    _clampQuatAngle(q, maxAngle){
        q.normalize();
        if(q.w < 0){ q.x = -q.x; q.y = -q.y; q.z = -q.z; q.w = -q.w; }   // canonical: measure the SHORT arc
        const half = Math.acos(THREE.MathUtils.clamp(q.w, -1, 1));        // half-angle
        const angle = 2 * half;
        if(angle <= maxAngle || angle < 1e-6){ return; }
        const s = Math.sin(maxAngle * 0.5) / Math.max(1e-6, Math.sin(half));
        q.x *= s; q.y *= s; q.z *= s; q.w = Math.cos(maxAngle * 0.5);
        q.normalize();
    }

    // Scale a quaternion's rotation angle by k (0..1), in place (slerp from identity).
    _scaleQuatAngle(q, k){
        this._scaleQ.copy(this._idQ).slerp(q, k);
        q.copy(this._scaleQ);
    }
}
