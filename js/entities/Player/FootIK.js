import * as THREE from 'three'
import { IKChainSolver } from '../Common/IKUtils.js'
import { AmmoHelper, CollisionFilterGroups } from '../../AmmoLib.js'


// Procedural FOOT / LEG IK — terrain adaptation on top of the locomotion clip. Reusable: the player
// (PlayerBody) and the enemy soldier (UeSoldierController) each own one (both are the SAME UE rig).
// The clip stays the base influence; this layer raycasts the ground under each foot and, eased, (a)
// lowers the whole avatar (modelRoot, world metres) so the lower-ground foot can reach, (b) two-bone
// solves each leg (thigh→calf→foot) so the ankle plants on the ground, and (c) tilts the foot to the
// surface normal. On flat ground it's a near no-op.
//
// WHY modelRoot (not the pelvis bone) for the hip drop: modelRoot is a top-level scene Group, so its
// position is WORLD metres — unambiguous, no rig unit-scale to reverse-engineer — and it is NOT touched
// by PlayerBody.StabilizeHips (which low-passes the pelvis BONE), so the terrain drop can't feed back
// into the hip-stabilizer's settled reference. Crouch also lowers modelRoot (PlayerBody), so the crouch
// drop + the terrain drop compose for free, and the same foot plant that conforms to terrain is what
// bends the knees into the crouch.
//
// FOOT-SYNCED LOCOMOTION: the jogs' playback rate tracks ground speed, so a hard ankle-plant while the
// legs are cycling fights the clip and skates. So the WHOLE layer fades out with ground speed (full at
// idle / crouch-idle / slow creep — where terrain conform matters most — and off by a jog), via the
// eased master weight. Airborne / rolling / dead callers pass enabled:false and it eases fully out.
const LEGS = [
    { thigh: 'thigh_l', calf: 'calf_l', foot: 'foot_l', ball: 'ball_l' },
    { thigh: 'thigh_r', calf: 'calf_r', foot: 'foot_r', ball: 'ball_r' },
];

export default class FootIK{
    // model      : the skinned GLB scene (bones live here)
    // modelRoot  : the top-level Group positioned in world space each frame (we lower its .y for terrain)
    // physicsWorld: the Ammo world to raycast the ground against (StaticFilter = the level colliders)
    constructor(model, modelRoot, physicsWorld, opts = {}){
        this.model = model;
        this.modelRoot = modelRoot;
        this.world = physicsWorld;
        this.ik = new IKChainSolver();

        // ---- Tuning ----
        this.rayUp        = opts.rayUp        ?? 0.6;   // ground ray starts this far ABOVE the foot (m)
        this.maxDrop      = opts.maxDrop      ?? 0.85;  // ...and reaches this far below it (m)
        this.maxHipDrop   = opts.maxHipDrop   ?? 0.40;  // most the avatar lowers for terrain (m)
        this.footOrientMax= opts.footOrientMax?? THREE.MathUtils.degToRad(35); // clamp on the foot-to-slope tilt
        this.weightLerp   = opts.weightLerp   ?? 10;    // master-weight ease rate (1/s)
        this.hipDropLerp  = opts.hipDropLerp  ?? 8;     // terrain hip-drop ease rate (1/s)
        this.plantFadeLow = opts.plantFadeLow ?? 1.0;   // full foot IK at/below this ground speed (m/s)
        this.plantFadeHigh= opts.plantFadeHigh?? 3.5;   // ...fading to OFF at/above this (so the jog isn't fought)
        this.poleStabilize= opts.poleStabilize?? 0;     // 0 = preserve the clip's knee bend (pole only guards a flip)
        // PER-FOOT ankle-rest height = the foot bone's height above the detected ground at REST. Captured
        // per foot so that on FLAT ground the IK target equals the clip's own foot placement => a true
        // NO-OP (foot IK never changes the flat-ground look; it only adapts to terrain DEVIATIONS and
        // anchors the feet for crouch). Calibrated as the MINIMUM (footY - groundY) over a short idle
        // window so a transiently-lifted foot (idle weight-shift) can't inflate it. Clamp guards a wild
        // value from a mid-air calibration. Target ankle Y = detectedGroundY + this foot's offset.
        this.ankleRestMin = 0.04; this.ankleRestMax = 0.6;
        this.ankleRestDefault = 0.12;
        this.calibFrames = 30;     // idle frames to take the planted minimum over
        this._calibCount = 0;

        // ---- Eased state ----
        this._weight = 0;          // master 0..1 (grounded & slow => 1, airborne/fast => 0)
        this._hipDrop = 0;         // eased terrain hip drop (m, >= 0)
        this._calibrated = false;
        this._resolved = false;
        this.legs = null;

        // ---- Scratch (no per-frame allocation) ----
        this._footPos = new THREE.Vector3();
        this._origin  = new THREE.Vector3();
        this._dest    = new THREE.Vector3();
        this._target  = new THREE.Vector3();
        this._pole    = new THREE.Vector3();
        this._normal  = new THREE.Vector3();
        this._up      = new THREE.Vector3(0, 1, 0);
        this._idQ     = new THREE.Quaternion();    // identity (slerp base) — never mutated
        this._orientQ = new THREE.Quaternion();
        this._orientApplied = new THREE.Quaternion();
        this._hit = { intersectionPoint: new THREE.Vector3(), intersectionNormal: new THREE.Vector3() };
    }

    // Resolve the two leg chains by UE bone name. Ball (toe) is optional (used only as a reference).
    ResolveBones(){
        const byName = {};
        this.model.traverse(o => { if(o.isBone){ byName[o.name] = o; } });
        this.legs = [];
        for(const L of LEGS){
            const thigh = byName[L.thigh], calf = byName[L.calf], foot = byName[L.foot];
            if(thigh && calf && foot){
                this.legs.push({
                    thigh, calf, foot, ball: byName[L.ball] || null,
                    ankleRest: this.ankleRestDefault, calibMin: Infinity,
                    hit: false, ground: 0, fx: 0, fy: 0, fz: 0,
                    nx: 0, ny: 1, nz: 0,
                });
            }
        }
        this._resolved = this.legs.length > 0;
    }

    // Ease everything back to OFF (called on roll exit / despawn so the legs re-engage from zero
    // instead of thawing at a frozen pose — mirrors PlayerBody.ResetAimPoseAccumulators).
    Reset(){
        this._weight = 0;
        this._hipDrop = 0;
    }

    // Per frame. opts:
    //   enabled : grounded && !rolling && alive (else the whole layer eases out)
    //   speed   : horizontal ground speed (m/s) — fades the layer out as it rises (anti-skate)
    //   bodyYaw : facing yaw (rad), for the forward knee pole
    //   floor   : minimum weight while enabled (0..1). The player passes the eased CROUCH amount: a
    //             crouched body is lowered, so the feet MUST stay planted (knees bent) even while
    //             crouch-walking, or they'd sink through the floor when the speed-fade turned the layer
    //             off. The trade is a slightly flattened swing-foot lift at speed — preferable to feet
    //             clipping the ground. Standing (floor 0) keeps the full speed-fade (swing lift intact).
    Update(t, { enabled = true, speed = 0, bodyYaw = 0, floor = 0 } = {}){
        if(!this._resolved){ this.ResolveBones(); if(!this._resolved){ return; } }

        // Master weight: on when grounded AND slow, off when airborne/dead or moving fast (so the
        // foot-synced jog isn't fought into a skate) — but never below `floor` while enabled (crouch).
        const speedFactor = 1 - THREE.MathUtils.smoothstep(speed, this.plantFadeLow, this.plantFadeHigh);
        const target = enabled ? Math.max(speedFactor, THREE.MathUtils.clamp(floor, 0, 1)) : 0;
        this._weight += (target - this._weight) * (1 - Math.exp(-this.weightLerp * t));
        if(this._weight < 1e-3){
            this._hipDrop *= Math.exp(-this.hipDropLerp * t);   // bleed any residual drop (it's not applied here)
            return;
        }

        // Refresh from the ROOT (not `model`): we read absolute foot WORLD-Y and we move modelRoot.y
        // (Pass B), so the refresh must recompute modelRoot.matrixWorld itself — a child refresh would
        // read a stale parent matrix and miss this frame's crouch / terrain drop. Falls back to model.
        const root = this.modelRoot || this.model;
        root.updateMatrixWorld(true);

        // --- PASS A: raycast the ground under each foot's CURRENT animated position. ---
        let anyHit = false, slow = speed < 0.6;
        for(const leg of this.legs){
            leg.foot.getWorldPosition(this._footPos);
            this._origin.copy(this._footPos); this._origin.y += this.rayUp;
            this._dest.copy(this._footPos);   this._dest.y   -= this.maxDrop;
            leg.hit = AmmoHelper.CastRay(this.world, this._origin, this._dest, this._hit, CollisionFilterGroups.StaticFilter);
            if(!leg.hit){ continue; }
            anyHit = true;
            leg.ground = this._hit.intersectionPoint.y;
            leg.nx = this._hit.intersectionNormal.x;
            leg.ny = this._hit.intersectionNormal.y;
            leg.nz = this._hit.intersectionNormal.z;
            leg.fx = this._footPos.x; leg.fy = this._footPos.y; leg.fz = this._footPos.z;
            // Track each foot's MINIMUM rest offset over the idle window (the planted height).
            if(!this._calibrated && slow){
                const offset = this._footPos.y - leg.ground;
                if(offset < leg.calibMin){ leg.calibMin = offset; }
            }
        }
        // Latch the per-foot ankle rest after the window (so flat-ground targets == the clip pose: no-op).
        if(!this._calibrated && anyHit && slow && ++this._calibCount >= this.calibFrames){
            for(const leg of this.legs){
                if(Number.isFinite(leg.calibMin)){
                    leg.ankleRest = THREE.MathUtils.clamp(leg.calibMin, this.ankleRestMin, this.ankleRestMax);
                }
            }
            this._calibrated = true;
        }
        // Until calibrated, DON'T solve — only observe. The leg solve (Pass C) moves the feet, and next
        // frame Pass A would read those IK-moved positions instead of the clip's, so the calibration
        // would converge to the IK's own output (the default offset) rather than the clip's true rest.
        // Skipping the solve during the short calibration window keeps Pass A reading pure clip poses, so
        // the captured per-foot rest is correct and the flat-ground solve is a genuine no-op afterward.
        if(!this._calibrated){ return; }

        // Deepest required DESCENT (target ground below the animated foot) across the feet, for the hip drop.
        let deepest = 0;
        for(const leg of this.legs){
            if(!leg.hit){ continue; }
            const moveI = (leg.ground + leg.ankleRest) - leg.fy;   // + = foot must rise, - = foot must descend
            if(moveI < deepest){ deepest = moveI; }
        }

        // --- PASS B: lower the avatar (modelRoot, world m) by the deepest required DESCENT so that foot
        // can reach without the leg over-extending. A foot that must RISE is handled by bending its leg,
        // not by raising the hips — so only the negative (descend) case drops the hips. Eased. On flat
        // ground (and under crouch, where both feet sit below their targets) this stays 0. ---
        const dropTarget = THREE.MathUtils.clamp(-deepest, 0, this.maxHipDrop) * this._weight;
        this._hipDrop += (dropTarget - this._hipDrop) * (1 - Math.exp(-this.hipDropLerp * t));
        if(this._hipDrop > 1e-4){
            this.modelRoot.position.y -= this._hipDrop;
            root.updateMatrixWorld(true);   // refresh from the root so the leg solve reads the lowered hips
        }

        // --- PASS C: two-bone solve each leg so the ankle plants on the ground, then tilt the foot to
        // the surface. Knee pole points body-forward (+ a little up) so a degenerate/flipped animated
        // pole can't bend the knee backward; poleStabilize 0 otherwise preserves the clip's bend. The
        // ankle target eases from the animated position to the ground by the master weight (no snap). ---
        this._pole.set(Math.sin(bodyYaw), 0.4, Math.cos(bodyYaw)).normalize();
        for(const leg of this.legs){
            if(!leg.hit){ continue; }
            leg.foot.getWorldPosition(this._footPos);
            const targetY = leg.ground + leg.ankleRest;
            this._target.set(
                this._footPos.x,
                THREE.MathUtils.lerp(this._footPos.y, targetY, this._weight),
                this._footPos.z);
            this.ik.solveTwoBone(leg.thigh, leg.calf, leg.foot, this._target, this._pole, this.poleStabilize);
            this._orientFoot(leg);
        }
    }

    // Tilt the foot so its sole follows the ground normal: a world delta from world-up to the surface
    // normal, clamped to footOrientMax and weighted, applied about the ankle (so the planted position is
    // unchanged). Flat ground (normal≈up) => identity => no-op.
    _orientFoot(leg){
        const len = Math.hypot(leg.nx, leg.ny, leg.nz) || 1;
        this._normal.set(leg.nx / len, leg.ny / len, leg.nz / len);
        this._orientQ.setFromUnitVectors(this._up, this._normal);   // up -> ground normal (short arc; normal is upper-hemisphere)
        const angle = 2 * Math.acos(THREE.MathUtils.clamp(this._orientQ.w, -1, 1));
        let s = this._weight;
        if(angle > this.footOrientMax && angle > 1e-5){ s *= this.footOrientMax / angle; }
        this._orientApplied.copy(this._idQ).slerp(this._orientQ, s);
        this.ik.applyWorldQuat(leg.foot, this._orientApplied);
    }
}
