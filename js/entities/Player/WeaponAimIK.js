import * as THREE from 'three'


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
        this.twoHanded              = opts.twoHanded ?? true;              // false => one-handed (skip support-hand IK)
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
        this._alpha = 0;                              // 0..1 blend of the whole correction (eased toward active)
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

        // Debug snapshot for WeaponAimDebug (filled each frame; read-only for consumers).
        this._debug = {
            active: false, alpha: 0, valid: false, distance: 0,
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
        this._alpha = 0;
        this._aimDirSeeded = false;
    }

    // Main solve. Call AFTER the mixer + spine lean each frame.
    //   active        : aim/shoot is engaged (else the correction eases out)
    //   aimTarget     : world point under the crosshair (PlayerControls.aimTarget)
    //   aimValid      : the crosshair ray hit geometry (else aimTarget is a far fallback)
    //   cameraForward : unit camera-forward (fallback aim direction for too-close / behind targets)
    //   t             : delta seconds
    Update(t, { active, aimTarget, aimValid = true, cameraForward = null }){
        const pivot = this.weaponPivot;
        if(!pivot || !this.handBoneR){ return; }

        // Ease the master blend toward the active state.
        const target = active ? 1 : 0;
        this._alpha += (target - this._alpha) * (1 - Math.exp(-this.AimAlignmentBlendSpeed * t));

        // One-time lazy resolves. These run on the FIRST update — before any aim correction is applied
        // (the alpha<eps early-return below sits right after), so the gun is at its base transform and
        // the hands are in the rest/idle pose: the grip-socket capture is valid. They are NOT re-run on
        // a weapon switch (see OnWeaponChanged): re-capturing the foregrip from the posed hand WHILE
        // aiming would read the hand at the IK-rotated grip and record a wrong socket. Per-weapon sockets
        // for a genuinely different mesh come from ikConfig (SetWeaponConfig), not a mid-aim re-capture.
        if(!this._baseCaptured){ this.CaptureBase(); }
        if(!this._barrelResolved){ this.ResolveBarrel(); }
        if(!this._socketsCaptured){ this.CaptureGripSockets(); }

        // Fully released: leave the weapon + arm entirely to the animation (so locomotion/idle read
        // exactly as authored). The mixer rewrites the arm each frame, so nothing lingers. Mark the
        // direction low-pass unseeded so the NEXT time aim engages it seeds straight to the current
        // target (no swing in from a stale direction); the alpha ease still blends the pose in smoothly.
        if(this._alpha < 1e-3){
            this._debug.active = false;
            this._debug.alpha = this._alpha;
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

        // Clamp the total correction angle, scale by strength, then ease by the master blend.
        this._clampQuatAngle(this._qFull, this.MaxAimCorrectionAngle);
        if(this.AimCorrectionStrength < 0.999){ this._scaleQuatAngle(this._qFull, this.AimCorrectionStrength); }
        this._qApplied.copy(this._idQ).slerp(this._qFull, this._alpha);

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

        // --- Support-hand IK: plant hand_l on the (now-rotated) foregrip socket. ---
        const ikW = this._alpha * this.WeaponIKBlendAlpha;
        this._tmpV.copy(this.leftGripLocal).add(this.LeftHandOffset);
        this._leftTarget.copy(this._tmpV).applyMatrix4(pivot.matrixWorld);   // foregrip world (post-rotation)
        if(this.twoHanded && this.bones.upperarm_l && this.bones.lowerarm_l && this.bones.hand_l){
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
        }

        // --- Debug snapshot ---
        const d = this._debug;
        d.active = true; d.alpha = this._alpha; d.valid = aimValid; d.distance = dist;
        d.aimTarget.copy(aimTarget);
        d.muzzle.copy(this.muzzleLocal).applyMatrix4(pivot.matrixWorld);
        d.barrelFwd.copy(this.forwardLocal).applyQuaternion(pivot.getWorldQuaternion(this._weaponWQ)).normalize();
        d.correctedDir.copy(aimTarget).sub(d.muzzle).normalize();
        d.rightGrip.copy(this.rightGripLocal).add(this.RightHandOffset).applyMatrix4(pivot.matrixWorld);
        d.leftGrip.copy(this._leftTarget);
        d.handTarget.copy(this._leftTarget);
    }

    // Analytic two-bone IK (direction-matching, sign-safe). Orient (root, mid) so `end` reaches
    // targetWorld while keeping the animation's elbow side (the bend can never flip). Solve the
    // triangle (R, M', E') for the exact elbow + end positions, then rotate the upper bone so its
    // segment points at M' and the lower bone so its segment points at E' — matching DIRECTIONS, so
    // there is no angle-sign ambiguity and the end lands exactly on the target. Reads live world
    // positions and applies world-space delta rotations (converted to each bone's local frame), so it
    // composes on top of the animated pose with no drift.
    _solveTwoBone(root, mid, end, targetWorld, poleHint = null, poleStabilize = 0){
        root.getWorldPosition(this._R);
        mid.getWorldPosition(this._M);
        end.getWorldPosition(this._E);
        const a = this._R.distanceTo(this._M);   // upper arm length
        const b = this._M.distanceTo(this._E);   // forearm length
        if(a < 1e-5 || b < 1e-5){ return; }

        // n = unit root->target; d = reach, clamped so the triangle is always solvable.
        this._rt.copy(targetWorld).sub(this._R);
        const rawLen = this._rt.length();
        if(rawLen < 1e-5){ return; }
        this._n.copy(this._rt).multiplyScalar(1 / rawLen);
        const d = THREE.MathUtils.clamp(rawLen, Math.abs(a - b) + 1e-3, a + b - 1e-3);

        // u = unit perpendicular to n, pointing to the elbow side. Start from the CURRENT animated bend
        // so a good pose is preserved as-is. But on extreme cross-body aim the animated elbow can line
        // up with n (degenerate) or sit on the WRONG side, flipping the forearm into an impossible
        // reverse/twisted bend. So we also build a stable anatomical reference from poleHint (the elbow
        // should bend roughly that way — e.g. DOWN for the support arm), projected into the bend plane,
        // and (a) use it when the animated pole is degenerate, (b) blend toward it ONLY when the
        // animated pole points the wrong way (negative alignment). Aligned poses are left untouched.
        this._u.copy(this._M).sub(this._R);
        this._u.addScaledVector(this._n, -this._u.dot(this._n));   // animated pole, perpendicular to n
        const uLenSq = this._u.lengthSq();

        this._poleRef.copy((poleHint && poleHint.lengthSq() > 1e-8) ? poleHint : this._poleDown);
        this._poleRef.addScaledVector(this._n, -this._poleRef.dot(this._n));   // reference, into bend plane
        const refValid = this._poleRef.lengthSq() > 1e-6;
        if(refValid){ this._poleRef.normalize(); }

        if(uLenSq < 1e-6){
            // Degenerate animated pole (elbow colinear with root->target): use the reference, else any
            // perpendicular as a last resort.
            if(refValid){ this._u.copy(this._poleRef); }
            else{
                this._u.copy(this._n).cross(this._perp.set(0, 1, 0));
                if(this._u.lengthSq() < 1e-8){ this._u.copy(this._n).cross(this._perp.set(1, 0, 0)); }
                this._u.normalize();
            }
        }else{
            this._u.multiplyScalar(1 / Math.sqrt(uLenSq));
            if(refValid){
                // Stabilize: bias the animated pole toward the fixed reference so the elbow doesn't
                // swivel/gimbal as the animated arm (and the aim) move — it stays in a consistent plane.
                if(poleStabilize > 0){ this._u.lerp(this._poleRef, poleStabilize).normalize(); }
                // Flip-guard: if it still points to the wrong side, correct fully.
                const align = this._u.dot(this._poleRef);             // <0 => elbow on the wrong side
                if(align < 0){ this._u.lerp(this._poleRef, Math.min(1, -align)).normalize(); }
            }
        }

        // Desired elbow M' (a from R, at the law-of-cosines angle off n) and end E' (on n at distance d).
        const cosA = THREE.MathUtils.clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
        const sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
        this._Mp.copy(this._R).addScaledVector(this._n, a * cosA).addScaledVector(this._u, a * sinA);
        this._Ep.copy(this._R).addScaledVector(this._n, d);

        // 1) Upper bone: rotate (M-R) onto (M'-R).
        this._re.copy(this._M).sub(this._R).normalize();
        this._rt2.copy(this._Mp).sub(this._R).normalize();
        this._qWorld.setFromUnitVectors(this._re, this._rt2);
        this._applyWorldQuat(root, this._qWorld);
        mid.getWorldPosition(this._M);   // refresh after the upper rotation
        end.getWorldPosition(this._E);

        // 2) Lower bone: rotate (E-M) onto (E'-M).
        this._re.copy(this._E).sub(this._M).normalize();
        this._rt2.copy(this._Ep).sub(this._M).normalize();
        this._qWorld.setFromUnitVectors(this._re, this._rt2);
        this._applyWorldQuat(mid, this._qWorld);
    }

    // Apply a world-space rotation qW to a bone about its origin: newLocal = parentW^-1 * qW * parentW * oldLocal.
    _applyWorldQuat(bone, qW){
        bone.parent.getWorldQuaternion(this._pW);
        this._pWInv.copy(this._pW).invert();
        this._qDelta.copy(this._pWInv).multiply(qW).multiply(this._pW);
        bone.quaternion.premultiply(this._qDelta);
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
