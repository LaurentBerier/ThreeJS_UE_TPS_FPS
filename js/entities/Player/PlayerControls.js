import * as THREE from 'three'
import Component from '../../Component.js'
import Input from '../../Input.js'
import {Ammo, AmmoHelper, CollisionFilterGroups} from '../../AmmoLib.js'

import DebugShapes from '../../DebugShapes.js'


export default class PlayerControls extends Component{
    constructor(camera){
        super();
        this.name = 'PlayerControls';
        this.camera = camera;

        this.timeZeroToMax = 0.08;

        this.walkSpeed = 7.0;
        this.sprintMultiplier = 1.6;
        this.maxSpeed = this.walkSpeed;
        this.speed = new THREE.Vector3();
        this.acceleration = this.walkSpeed / this.timeZeroToMax;
        this.decceleration = -7.0;
        this.isSprinting = false;

        this.mouseSpeed = 0.002;
        this.physicsComponent = null;
        this.isLocked = false;
        // When a dev tool (WeaponPlacementDebug) takes over the camera, we freeze the
        // player and stop placing the camera so the tool's free-fly cam can own it.
        this.cameraOverride = false;

        this.angles = new THREE.Euler();
        this.pitch = new THREE.Quaternion();
        this.yaw = new THREE.Quaternion();

        this.jumpVelocity = 5;
        this.yOffset = 0.5;
        this.tempVec = new THREE.Vector3();
        this.moveDir = new THREE.Vector3();
        this.xAxis = new THREE.Vector3(1.0, 0.0, 0.0);
        this.yAxis = new THREE.Vector3(0.0, 1.0, 0.0);

        // Camera mode: 'TPS' (third-person orbit-follow, default — showcases the
        // UE Mannequin) or 'FPS' (first-person, the arms/weapon viewmodel).
        // The same yaw/pitch (this.angles) drives both; only the camera placement
        // differs. Press V to toggle. Combat aim is FP-authoritative in v1.
        this.cameraMode = 'TPS';
        this.tpsDistance = 2.6;   // boom length behind the player (metres)
        this.tpsMinDistance = 0.6;// HARD floor on the boom: collision never dollies closer than this (see UpdateCamera)
        this.tpsPivotHeight = 0.25; // pivot above eye height
        this.tpsShoulder = 0.85;  // lateral rig shift: bigger => character further frame-left, reticle further right (in front of the gun)
        this._vLatch = false;

        // Precise-aim mode (hold right click in TPS): the boom pulls in over the
        // shoulder, the FOV zooms, and the mouse slows for finer aim. Targets are
        // eased toward each frame so entering/leaving aim glides rather than snaps.
        this.aiming = false;
        this.tpsAimDistance = 1.5;    // tighter boom while aiming
        this.tpsAimShoulder = 0.55;   // pull the shoulder offset in a little
        this.tpsAimFov = 35;          // zoom (base FOV is captured in Initialize)
        this.aimLerpSpeed = 12;
        this.aimSensitivity = 0.55;   // mouse multiplier while aiming
        this.baseFov = 50;            // overwritten from the camera in Initialize
        // Smoothed current values driven each frame in UpdateCamera.
        this._curDistance = this.tpsDistance;
        this._curShoulder = this.tpsShoulder;
        this._curFov = this.baseFov;
        // Scratch vectors for the TPS boom (avoid per-frame allocation).
        this._cap = new THREE.Vector3();
        this._pivot = new THREE.Vector3();
        this._fwd = new THREE.Vector3();
        this._right = new THREE.Vector3();
        this._fwdBase = new THREE.Vector3(0, 0, -1);
        this._rightBase = new THREE.Vector3(1, 0, 0);

        // --- First-person camera: rides the body's head bone (same character), with
        // the head mesh hidden by the camera's near plane ("cull distance"). ---
        this.body = null;               // PlayerBody, queried for the head-bone position
        this.fpsEyeForward = 0.14;      // nudge the eye ahead of the head bone...
        this.fpsEyeUp = 0.08;           // ...and up a touch, onto the real eye line
        this.fpsNear = 0.18;            // near plane that culls the head at the eye
        this.tpsNear = 0.01;            // crisp near for the third-person boom (set in Initialize)
        this._headPos = new THREE.Vector3();

        // --- TPS boom collision (AAA-smooth, radial). The boom is a SWEPT SPHERE
        // (radius camRadius) cast from the pivot to where the camera wants to sit; if a
        // wall blocks it, the camera DOLLIES straight in along the view axis — it "gets
        // closer to the character" — stopping at the swept clearance (sphere centre held
        // camRadius off the surface) so it can NEVER clip. There is NO sideways
        // re-projection, so the camera never slides against the player's input. As you pan,
        // the unobstructed length changes continuously, so the camera glides smoothly along
        // the wall on its own. Orientation always tracks the look input exactly, so aiming
        // stays 1:1.
        //
        // Pull-in is INSTANT — the camera snaps to the clearance the very frame a wall
        // appears, so it can never lag into geometry for even one frame. Return-out (a wall
        // clearing) is slow and gentle so it never snaps. That asymmetry is what guarantees
        // no-clip while still reading as smooth and cinematic.
        this.camRadius = 0.24;          // clearance kept from geometry (metres)
        this.returnRate = 3.0;          // boom-lengthening smoothing (1/s) — slow, elegant
        this.shoulderSlideRate = 2.5;   // lateral shoulder-slide ease (1/s) — long & cinematic, both ways; a camRadius safety backstop keeps it no-clip
        this._curLen = this.tpsDistance; // current boom length (instant in, eased out)
        this._curShoulderFactor = 1;    // 0..1 collision clamp on the shoulder offset (slides to 0 at a side wall)
        this._shoulderInit = false;
        this._camTarget = new THREE.Vector3();  // (first-person eye target)
        this._cCam = new THREE.Vector3();       // centred camera point (behind player, pre-shoulder)
        this._camInit = false;
        this._free = new THREE.Vector3();
        this._sweepRes = { point: new THREE.Vector3(), normal: new THREE.Vector3(), fraction: 1 };

        // --- Sprint pullback. Running pulls the boom back a little for a faster, more
        // cinematic sense of speed. Eased on its own gentle rate so it breathes in/out
        // rather than snapping when the player starts/stops sprinting.
        this.tpsSprintExtra = 0.7;      // extra boom length while sprinting (m)
        this.sprintLerpSpeed = 3.5;     // gentle ease for the sprint pullback (1/s)
        this._curSprint = 0.0;          // smoothed sprint extension

        // --- Collision FOV. The camera NEVER imposes any rotation to dodge geometry; the
        // only thing it may do is dolly along the look axis — pull away or push IN toward
        // the player (down to a first-person POV at the extreme, which we try to avoid but
        // allow). When collision PUSHES the boom in, we open the FOV a little so the closer
        // shot feels less claustrophobic and reveals more around the character. Suspended
        // while aiming, where the precise-aim zoom FOV must stay exact.
        this.collisionFovExtra = 12;    // extra degrees of FOV at a full collision push-in

        // --- High-angle pull-back. The further DOWN the camera looks, the further the boom
        // pulls back & up into a high overhead view, opening a gap so objects can travel
        // between the camera and the character. This only raises the DESIRED length —
        // collision still clamps it to the clearance, so it never trades away no-clip.
        this.tpsLookDownExtra = 1.6;    // extra boom length at full look-down (m) — pull back

        // --- Camera shake / recoil ("juice"): a subtle trauma-driven shake on taking
        // a hit and a tiny kick per shot. Kept ROTATION-ONLY (no positional shake) and
        // small, applied on top of the look orientation so the crosshair stays put. ---
        this._fxTime = 0.0;
        this.trauma = 0.0;              // 0..1; decays each frame
        this.traumaDecay = 1.7;        // trauma/sec
        this.maxShakeRot = 0.012;      // radians at full trauma (small rotation only)
        this.recoilPitch = 0.0;        // transient view kick, recovers to 0
        this.recoilYaw = 0.0;
        this.recoilRecover = 9.0;      // 1/s settle rate
        this._shakeEuler = new THREE.Euler();
        this._shakeQuat = new THREE.Quaternion();
    }

    Initialize(){
        this.physicsComponent = this.GetComponent("PlayerPhysics");
        this.physicsBody = this.physicsComponent.body;
        this.physicsWorld = this.physicsComponent.world; // for the TPS boom raycast
        this.body = this.GetComponent('PlayerBody');     // head-bone eye in first-person
        this.transform = new Ammo.btTransform();
        this.zeroVec = new Ammo.btVector3(0.0, 0.0, 0.0);
        this.angles.setFromQuaternion(this.parent.Rotation);
        this.UpdateRotation();

        Input.AddMouseMoveListner(this.OnMouseMove);

        // Capture the resting FOV so precise-aim can zoom from / back to it.
        this.baseFov = this.camera.fov;
        this._curFov = this.camera.fov;

        // Remember the crisp third-person near plane, then apply the near for the
        // starting mode (FPS uses a larger near to cull the head mesh at the eye).
        this.tpsNear = this.camera.near;
        this.ApplyNearForMode();

        // Camera juice: shake on taking a hit, a kick per shot fired.
        this.parent.RegisterEventHandler(this.OnPlayerHit, 'hit');
        this.parent.RegisterEventHandler(this.OnWeaponShoot, 'weapon.shoot');

        // Right click holds precise-aim. (In FPS the arms viewmodel runs its own ADS
        // via Hands; this TPS aim only applies in the TPS camera branch below.)
        Input.AddMouseDownListner(e => { if(e.button === 2){ this.aiming = true; } });
        Input.AddMouseUpListner(e => { if(e.button === 2){ this.aiming = false; } });

        document.addEventListener('pointerlockchange', this.OnPointerlockChange)

        Input.AddClickListner( () => {
            if(!this.isLocked){
                document.body.requestPointerLock();
            }
        });
    }

    OnPointerlockChange = () => {
        if (document.pointerLockElement) {
            this.isLocked = true;
            return;
        }

        this.isLocked = false;
    }

    OnMouseMove = (event) => {
        if (!this.isLocked || this.cameraOverride) {
          return;
        }

        const { movementX, movementY } = event

        // Finer aim while holding precise-aim in third-person.
        const sens = (this.cameraMode === 'TPS' && this.aiming)
            ? this.mouseSpeed * this.aimSensitivity
            : this.mouseSpeed;

        this.angles.y -= movementX * sens;
        this.angles.x -= movementY * sens;

        this.angles.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.angles.x));

        this.UpdateRotation();
    }

    UpdateRotation(){
        this.pitch.setFromAxisAngle(this.xAxis, this.angles.x);
        this.yaw.setFromAxisAngle(this.yAxis, this.angles.y);

        // parent.Rotation is the single look orientation (yaw*pitch). The camera
        // is positioned/oriented from it each frame in Update, per camera mode, so
        // we no longer write camera.quaternion here.
        this.parent.Rotation.multiplyQuaternions(this.yaw, this.pitch).normalize();
    }

    ToggleCamera(){
        this.cameraMode = this.cameraMode === 'TPS' ? 'FPS' : 'TPS';
        // Drop aim on a mode switch; reseed the smoothed FOV from the live camera so
        // re-entering TPS doesn't jump (FPS ADS, owned by Hands, may have changed it).
        this.aiming = false;
        this._curFov = this.camera.fov;
        // The two modes place the camera in very different spots (head vs boom), so
        // snap to the new spot next frame rather than flying the camera through the
        // body, and swap the near plane (FPS culls the head).
        this._camInit = false;
        this._shoulderInit = false;
        this.ApplyNearForMode();
        this.Broadcast({topic: 'camera.mode', mode: this.cameraMode});
        const label = document.getElementById('camera_mode');
        if(label){ label.textContent = this.cameraMode; }
    }

    ApplyNearForMode(){
        this.camera.near = this.cameraMode === 'FPS' ? this.fpsNear : this.tpsNear;
        this.camera.updateProjectionMatrix();
    }

    // --- Camera juice hooks ---
    // Getting shot: a small, quickly-settling shake — rotation ONLY (ApplyCameraShake
    // never moves the camera in space), so the view jolts but the position never lurches.
    OnPlayerHit = () => { this.AddTrauma(0.55); }
    OnWeaponShoot = () => { this.AddRecoil(); }

    AddTrauma(amount){ this.trauma = Math.min(1.0, this.trauma + amount); }

    AddRecoil(){
        this.trauma = Math.min(1.0, this.trauma + 0.025);
        this.recoilPitch += 0.005;                          // small kick up
        this.recoilYaw += (Math.random() - 0.5) * 0.0025;   // very slight horizontal jitter
    }

    // Apply trauma-driven shake + the per-shot recoil kick on top of the look
    // orientation, then decay both. Keeps the crosshair fixed while the view shakes.
    ApplyCameraShake(t){
        this.trauma = Math.max(0.0, this.trauma - this.traumaDecay * t);
        const settle = Math.exp(-this.recoilRecover * t);
        this.recoilPitch *= settle;
        this.recoilYaw *= settle;

        const shake = this.trauma * this.trauma;   // ease-in so light trauma is subtle
        const f = this._fxTime;

        // Rotation-only shake (no positional offset) so the camera never lurches in
        // space — just a small, quickly-settling jitter of the view angle, plus the
        // per-shot recoil kick.
        const rp = (shake > 0.0001 ? Math.sin(f * 59.0) * shake * this.maxShakeRot : 0) + this.recoilPitch;
        const ry = (shake > 0.0001 ? Math.sin(f * 43.0 + 0.5) * shake * this.maxShakeRot : 0) + this.recoilYaw;
        const rz = shake > 0.0001 ? Math.sin(f * 67.0 + 1.1) * shake * this.maxShakeRot * 0.6 : 0;
        if(rp || ry || rz){
            this._shakeEuler.set(rp, ry, rz);
            this._shakeQuat.setFromEuler(this._shakeEuler);
            this.camera.quaternion.multiply(this._shakeQuat);
        }
    }

    // Place the camera for the current mode. capPos is the capsule-tracked
    // position (eye height); it is also Player.Position so NPC targeting/raycasts
    // are camera-mode-independent.
    UpdateCamera(capPos, t = 0.016){
        this._fxTime += t;

        if(this.cameraMode === 'FPS'){
            // Same character as third-person: the eye rides the mesh's head bone, so
            // the walk/run animation gives a subtle, real head bob. Nudge slightly
            // forward + up toward the eye line; the head mesh itself is hidden by the
            // camera's near plane (set on the mode switch). Fall back to the capsule
            // eye height if the head bone isn't available yet.
            this._fwd.copy(this._fwdBase).applyQuaternion(this.parent.Rotation);
            if(this.body && this.body.GetHeadWorldPosition(this._headPos)){
                this._camTarget.copy(this._headPos)
                    .addScaledVector(this._fwd, this.fpsEyeForward);
                this._camTarget.y += this.fpsEyeUp;
            }else{
                this._camTarget.copy(capPos);
            }
            // Lock the eye RIGIDLY to the head bone (no follow lag here): if the camera
            // lagged, the head mesh — rigged to the same bone — would swing ahead of
            // the near plane during the walk cycle and we'd see the inside of the skull.
            // The animated head bob still comes through because the camera rides the bone.
            this.camera.position.copy(this._camTarget);
            this._camInit = true;
            this.camera.quaternion.copy(this.parent.Rotation);
            this.ApplyCameraShake(t);
            return;
        }

        // Pitch as a normalised factor: -1 looking straight down, +1 straight up.
        // downN ramps 0 (level/up) -> 1 (straight down) and drives the high-angle behaviour.
        const pitchN = THREE.MathUtils.clamp(this.angles.x / (Math.PI * 0.5), -1, 1);
        const downN = Math.max(0, -pitchN);

        // Sprint pullback: ease an extra boom length in/out on its own gentle rate while
        // running (suspended while aiming so precise-aim stays tight). Folded into the
        // distance target below, so it rides the same smooth path as everything else.
        const sprintTarget = (this.isSprinting && !this.aiming) ? this.tpsSprintExtra : 0;
        this._curSprint += (sprintTarget - this._curSprint) * (1 - Math.exp(-this.sprintLerpSpeed * t));

        // Looking DOWN pulls the boom back & up into a high-angle view (squared so it stays
        // gentle at shallow angles), opening a gap so objects can pass between the camera
        // and the character rather than being shoved against the lens.
        const lookDownExtra = downN * downN * this.tpsLookDownExtra;

        // Ease the boom length / shoulder offset / FOV toward their precise-aim or
        // hip targets so toggling right click glides in and out of the zoom.
        const k = Math.min(1, t * this.aimLerpSpeed);
        const targetDistance = (this.aiming ? this.tpsAimDistance : this.tpsDistance) + this._curSprint + lookDownExtra;
        const targetShoulder = this.aiming ? this.tpsAimShoulder : this.tpsShoulder;
        const targetFov      = this.aiming ? this.tpsAimFov      : this.baseFov;
        this._curDistance += (targetDistance - this._curDistance) * k;
        this._curShoulder += (targetShoulder - this._curShoulder) * k;
        this._curFov      += (targetFov      - this._curFov)      * k;
        // FOV is applied AFTER the boom length is resolved (below), so a collision
        // push-in can widen it.

        // TPS orbit-follow boom. The rig is resolved in TWO DECOUPLED stages so a side wall
        // can never push the camera through it:
        //   1) BOOM (behind)  — swept straight back from a CENTRED pivot above the head.
        //   2) SHOULDER (side) — the over-the-shoulder offset is then swept laterally from
        //      that centred camera point, and clamped so it only extends as far as it stays
        //      clear. When a wall is on the shoulder side the camera gently SLIDES back
        //      along the surface toward directly behind the player rather than crossing it.
        this._fwd.copy(this._fwdBase).applyQuaternion(this.parent.Rotation);
        this._right.copy(this._rightBase).applyQuaternion(this.parent.Rotation);
        this._pivot.copy(capPos);
        this._pivot.y += this.tpsPivotHeight;   // CENTRED pivot — no shoulder baked in here

        // 1) BOOM: sweep straight back from the centred pivot (always clear, so the sweep
        // never starts inside geometry). ANY static hit clamps the boom to the swept
        // clearance (sphere centre held camRadius off the surface) so it can't penetrate.
        // Pull IN is INSTANT (never beyond the clearance for even one frame); return OUT is
        // eased and gentle. Only static geometry is tested, so dynamic props/characters
        // pass freely between the camera and the player.
        this._free.copy(this._pivot).addScaledVector(this._fwd, -this._curDistance);
        let rawLen = this._curDistance;
        if(this.physicsWorld && AmmoHelper.SphereSweep(
            this.physicsWorld, this.camRadius, this._pivot, this._free, this._sweepRes, CollisionFilterGroups.StaticFilter)
            && this._sweepRes.fraction < 1){
            // A near-zero fraction means the swept sphere STARTED already touching/inside
            // geometry — a degenerate, frame-to-frame jittery result that, if obeyed, snaps
            // the boom onto the pivot and makes the camera shake when it's jammed near the
            // character. Treat that as "go to the floor", not "go to zero".
            rawLen = this._sweepRes.fraction > 0.02
                ? this._curDistance * this._sweepRes.fraction
                : this.tpsMinDistance;
        }
        // Floor the boom: collision never dollies closer than tpsMinDistance. Below it the
        // sweep turns unstable (the shake) and the shot gets claustrophobic — so the camera
        // HOLDS here and the body dithers out (PlayerBody proximity dissolve) instead of the
        // lens cramming into the character. This is the "stay back rather than jam in"
        // priority when collision bites, and it removes the near-centre shake entirely.
        rawLen = Math.max(rawLen, this.tpsMinDistance);
        if(!this._camInit){
            this._curLen = rawLen;
            this._camInit = true;
        }else if(rawLen < this._curLen){
            this._curLen = rawLen;
        }else{
            this._curLen += (rawLen - this._curLen) * (1 - Math.exp(-this.returnRate * t));
        }
        // Centred camera point (directly behind the player, no shoulder yet).
        this._cCam.copy(this._pivot).addScaledVector(this._fwd, -this._curLen);

        // 2) SHOULDER: sweep the camera sphere sideways from the centred point out to the
        // full over-the-shoulder offset. A hit clamps how far it can extend (fraction), so
        // the camera slides along the wall toward centre instead of crossing it. The slide
        // EASES (gentle, not a pop) and the camRadius probe starts the slide before contact,
        // leaving margin so it never crosses. The aim/ease of the base offset is preserved
        // by keeping the clamp a 0..1 FACTOR on top of _curShoulder.
        let shoulderFactor = 1;
        if(this.physicsWorld && Math.abs(this._curShoulder) > 1e-4){
            this._free.copy(this._cCam).addScaledVector(this._right, this._curShoulder);
            if(AmmoHelper.SphereSweep(this.physicsWorld, this.camRadius, this._cCam, this._free,
                this._sweepRes, CollisionFilterGroups.StaticFilter) && this._sweepRes.fraction < 1){
                shoulderFactor = this._sweepRes.fraction;
            }
        }
        // Ease the lateral slide on a LONG, cinematic time constant in BOTH directions so
        // panning along a wall glides instead of snapping sideways. A fast whip would
        // normally out-run a slow slide and clip the wall, so a safety backstop clamps the
        // slide to never trail the swept-safe envelope by more than the camera's own
        // clearance radius (camRadius): silky under normal motion, yet physically unable to
        // cross the wall under a hard pan because that radius buffer absorbs the lag.
        if(!this._shoulderInit){
            this._curShoulderFactor = shoulderFactor;
            this._shoulderInit = true;
        }else{
            this._curShoulderFactor += (shoulderFactor - this._curShoulderFactor) * (1 - Math.exp(-this.shoulderSlideRate * t));
            const bufferFactor = this.camRadius / Math.max(0.05, Math.abs(this._curShoulder));
            if(this._curShoulderFactor > shoulderFactor + bufferFactor){
                this._curShoulderFactor = shoulderFactor + bufferFactor;
            }
        }

        // Final position: centred boom + the clamped over-the-shoulder slide.
        this.camera.position.copy(this._cCam).addScaledVector(this._right, this._curShoulder * this._curShoulderFactor);
        // Orientation is ALWAYS exactly the player's look (yaw*pitch) — the camera never
        // imposes any pitch/yaw/roll of its own. Collision only ever dollies the camera
        // along this axis (pull away / push in toward the player, down to a POV at the
        // limit); it never re-aims the view. lookAt is intentionally NOT used: combined
        // with any positional offset it would tilt the view and "force a look-down".
        this.camera.quaternion.copy(this.parent.Rotation);

        // Collision push-in widens the FOV a touch (never while aiming): as the boom is
        // forced shorter than it wants to be, the extra FOV eases in, softening the close
        // shot and revealing more around the character. Driven by the already-smoothed
        // lengths, so it glides.
        let fov = this._curFov;
        if(!this.aiming){
            const pushIn = THREE.MathUtils.clamp(1 - this._curLen / Math.max(0.001, this._curDistance), 0, 1);
            fov += pushIn * this.collisionFovExtra;
        }
        this.camera.fov = fov;
        this.camera.updateProjectionMatrix();

        this.ApplyCameraShake(t);
    }

    Accelarate = (direction, t) => {
        const accel = this.tempVec.copy(direction).multiplyScalar(this.acceleration * t);
        this.speed.add(accel);
        this.speed.clampLength(0.0, this.maxSpeed);
    }

    Deccelerate = (t) => {
        const frameDeccel = this.tempVec.copy(this.speed).multiplyScalar(this.decceleration * t);
        this.speed.add(frameDeccel);
    }

    // Hand camera control to a dev tool (or take it back). While overridden the
    // player is frozen in place and the camera is left for the tool to drive.
    SetCameraOverride(on){
        this.cameraOverride = on;
    }

    Update(t){
        // Dev free-cam owns the camera: hold the player still and skip camera placement.
        if(this.cameraOverride){
            const velocity = this.physicsBody.getLinearVelocity();
            velocity.setX(0); velocity.setZ(0);
            this.physicsBody.setLinearVelocity(velocity);
            this.physicsBody.setAngularVelocity(this.zeroVec);
            const ms = this.physicsBody.getMotionState();
            if(ms){
                ms.getWorldTransform(this.transform);
                const p = this.transform.getOrigin();
                this._cap.set(p.x(), p.y() + this.yOffset, p.z());
                this.parent.SetPosition(this._cap);   // keep Player.Position valid for NPCs
            }
            return;
        }

        // Toggle TPS/FPS on a V key edge (latched so a held key fires once).
        if(Input.GetKeyDown('KeyV')){
            if(!this._vLatch){ this._vLatch = true; this.ToggleCamera(); }
        } else {
            this._vLatch = false;
        }

        const forwardFactor = Input.GetKeyDown("KeyS") - Input.GetKeyDown("KeyW");
        const rightFactor = Input.GetKeyDown("KeyD") - Input.GetKeyDown("KeyA");
        const direction = this.moveDir.set(rightFactor, 0.0, forwardFactor).normalize();

        // Sprint (hold Shift) only kicks in while running forward on the ground.
        const sprintKey = Input.GetKeyDown("ShiftLeft") || Input.GetKeyDown("ShiftRight");
        this.isSprinting = !!(sprintKey && Input.GetKeyDown("KeyW") && this.physicsComponent.canJump);
        this.maxSpeed = this.isSprinting ? this.walkSpeed * this.sprintMultiplier : this.walkSpeed;

        const velocity = this.physicsBody.getLinearVelocity();

        if(Input.GetKeyDown('Space') && this.physicsComponent.canJump){
            velocity.setY(this.jumpVelocity);
            this.physicsComponent.canJump = false;
        }
        
        this.Deccelerate(t);
        this.Accelarate(direction, t);

        const moveVector = this.tempVec.copy(this.speed);
        moveVector.applyQuaternion(this.yaw);
        
        velocity.setX(moveVector.x);
        velocity.setZ(moveVector.z);

        this.physicsBody.setLinearVelocity(velocity);
        this.physicsBody.setAngularVelocity(this.zeroVec);

        const ms = this.physicsBody.getMotionState();
        if(ms){
            ms.getWorldTransform(this.transform);
            const p = this.transform.getOrigin();
            // Capsule-tracked eye position. This is Player.Position in BOTH camera
            // modes (NPCs target it), independent of where the TPS boom sits.
            this._cap.set(p.x(), p.y() + this.yOffset, p.z());
            this.parent.SetPosition(this._cap);
            this.UpdateCamera(this._cap, t);
        }

    }

    // Current horizontal move speed in m/s (used to drive the weapon bob).
    get HorizontalSpeed(){
        return this.speed.length();
    }

    get IsGrounded(){
        return this.physicsComponent ? this.physicsComponent.canJump : false;
    }
}