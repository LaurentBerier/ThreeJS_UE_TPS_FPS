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

        // --- TPS spring-arm "spline" collision (simple & glitch-free). The camera rides a
        // straight SPLINE from the centred pivot (above the head) out to the over-the-shoulder
        // REST point. Collision only ever slides the camera ALONG that line — closer to the
        // pivot or further out — NEVER sideways. Because every point on the line shares one
        // direction from the pivot, the character keeps the SAME on-screen framing at any boom
        // length (it just scales up as the camera nears), so a wall pulling the camera in can
        // never swing the character across the screen — there is nothing lateral to "centre".
        // A swept sphere (radius camRadius) finds how far out the camera can sit; the camera
        // pulls IN to it IMMEDIATELY (so it can never slide through a wall while moving) and
        // eases back OUT, so it tracks cover crisply yet still glides out when the wall clears.
        this.camRadius = 0.24;          // sphere radius for the spline collision sweep (metres)
        // Dolly response is ASYMMETRIC: pulling IN (a wall encroaching) is INSTANT so the camera
        // keeps up with walking/running toward cover and never lags into geometry — with the
        // spline this is a pure dolly, so it reads as a quick close-up, not a swing. Pulling OUT
        // (a wall clearing) eases at boomReturnRate so it glides back rather than popping.
        this.boomReturnRate = 10.0;     // pull-OUT ease toward the rest length (1/s); pull-IN is instant
        this._curT = 1;                 // smoothed 0..1 position ALONG the pivot->rest spline (1 = fully out)
        this._camTarget = new THREE.Vector3();  // (first-person eye target)
        this._camInit = false;
        this._free = new THREE.Vector3();       // scratch: over-the-shoulder rest point (far end of the spline)
        this._sweepRes = { point: new THREE.Vector3(), normal: new THREE.Vector3(), fraction: 1 };

        // --- Near-plane "close-mesh cull". As the camera dollies in toward the character the
        // near clip plane is pushed OUT, so meshes very close to the lens (the character it is
        // tucked behind, a wall it is pressed against) are clipped away instead of smearing
        // across the view. Crisp (tpsNear) at rest; grows to tpsNearMax once the camera is in
        // at tpsMinDistance, back to tpsNear past tpsNearGrowDist.
        this.tpsNearMax = 0.45;         // near plane (m) when the camera is dollied fully in
        this.tpsNearGrowDist = 1.5;     // camera-to-pivot distance (m) at/above which the near plane returns to tpsNear

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
        //
        // The response is an EASE-OUT of the down angle (not the old ease-in square): pull-back
        // is PRIVILEGED — it engages strongly the instant the camera tilts even slightly down,
        // then ramps progressively to full, instead of staying flat until a steep angle and then
        // snapping back. Its own gentle ease (lookDownLerpSpeed, slower than the aim zoom) makes
        // the pull-back↔push-in transition glide rather than jump as you sweep the pitch.
        this.tpsLookDownExtra = 1.9;    // extra boom length at full look-down (m) — pull back
        this.lookDownLerpSpeed = 4.0;   // gentle ease for the look-down pull-back (1/s) — progressive
        this._curLookDown = 0;          // eased look-down boom extra (m)

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
        // The two modes place the camera in very different spots (head vs spline), so
        // snap to the new spot next frame rather than flying the camera through the
        // body, and swap the near plane (FPS culls the head).
        this._camInit = false;
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

        // Looking DOWN pulls the boom back & up into a high-angle view, opening a gap so objects
        // can pass between the camera and the character rather than being shoved against the lens.
        // EASE-OUT of the down angle (downN*(2-downN)) so the pull-back is privileged — it kicks
        // in noticeably at a small down pitch and ramps progressively to full, instead of the old
        // ease-in square that stayed flat until a steep angle and then snapped. It rides its OWN
        // gentle ease (below) so sweeping the pitch glides between pulled-back and pushed-in.
        const lookDownExtra = downN * (2.0 - downN) * this.tpsLookDownExtra;
        this._curLookDown += (lookDownExtra - this._curLookDown) * (1 - Math.exp(-this.lookDownLerpSpeed * t));

        // Ease the boom length / shoulder offset / FOV toward their precise-aim or
        // hip targets so toggling right click glides in and out of the zoom.
        const k = Math.min(1, t * this.aimLerpSpeed);
        const targetDistance = (this.aiming ? this.tpsAimDistance : this.tpsDistance) + this._curSprint;
        const targetShoulder = this.aiming ? this.tpsAimShoulder : this.tpsShoulder;
        const targetFov      = this.aiming ? this.tpsAimFov      : this.baseFov;
        this._curDistance += (targetDistance - this._curDistance) * k;
        this._curShoulder += (targetShoulder - this._curShoulder) * k;
        this._curFov      += (targetFov      - this._curFov)      * k;
        // Total rest boom = the (aim/sprint) length plus the smoothly-eased look-down pull-back.
        const boom = this._curDistance + this._curLookDown;
        // FOV is applied AFTER the boom length is resolved (below), so a collision
        // push-in can widen it.

        // TPS spring-arm spline. The camera rides a straight line from the CENTRED pivot
        // (above the head) out to the over-the-shoulder REST point; collision only ever dollies
        // it ALONG that line — closer or further — never sideways. Every point on the line
        // shares one direction from the pivot, so the character keeps its framing at any boom
        // length (it just scales as the camera nears): nothing lateral to "centre", nothing to
        // swing, no glitch.
        this._fwd.copy(this._fwdBase).applyQuaternion(this.parent.Rotation);
        this._right.copy(this._rightBase).applyQuaternion(this.parent.Rotation);
        this._pivot.copy(capPos);
        this._pivot.y += this.tpsPivotHeight;   // CENTRED pivot — start of the spline
        // Far end of the spline: behind by the (aim/sprint + look-down) distance + over the shoulder.
        this._free.copy(this._pivot)
            .addScaledVector(this._fwd, -boom)
            .addScaledVector(this._right, this._curShoulder);

        // Sweep a sphere from the pivot to the rest point; the hit fraction is how far out the
        // camera may sit along the line (0..1). No static hit => fully out (1).
        let safeT = 1;
        if(this.physicsWorld && AmmoHelper.SphereSweep(
            this.physicsWorld, this.camRadius, this._pivot, this._free, this._sweepRes, CollisionFilterGroups.StaticFilter)
            && this._sweepRes.fraction < 1){
            safeT = this._sweepRes.fraction;
        }
        // Floor the dolly so the camera never comes closer to the pivot than tpsMinDistance —
        // it HOLDS back rather than jamming into the head (the body dither + near cull cover the
        // close shot). Expressed as the matching fraction along this spline's length.
        const splineLen = Math.max(0.001, this._pivot.distanceTo(this._free));
        const minT = Math.min(1, this.tpsMinDistance / splineLen);
        const targetT = Math.max(safeT, minT);
        // Dolly toward the target. Pull IN (targetT below where we are — a wall encroaching) is
        // INSTANT so the camera keeps up with walking/running into cover and can never slide
        // through geometry; pull OUT (the wall clearing) eases so it glides back rather than
        // popping. With the spline the in-snap is a pure dolly — the framing never moves — so it
        // does not read as the old lateral "jump".
        if(!this._camInit || targetT < this._curT){
            this._curT = targetT;
            this._camInit = true;
        }else{
            this._curT += (targetT - this._curT) * (1 - Math.exp(-this.boomReturnRate * t));
        }

        // Position: slide the camera along the spline by the lagged dolly param.
        this.camera.position.copy(this._pivot).lerp(this._free, this._curT);
        // Orientation is ALWAYS exactly the player's look (yaw*pitch) — the camera never imposes
        // any pitch/yaw/roll of its own; collision only dollies it along the spline above. lookAt
        // is intentionally NOT used: with the shoulder offset it would tilt the view sideways.
        this.camera.quaternion.copy(this.parent.Rotation);

        // Collision push-in widens the FOV a touch (never while aiming): the further the dolly
        // is drawn in along the spline (1 - _curT), the more FOV eases in, softening the close
        // shot. Driven by the already-lagged dolly param, so it glides.
        let fov = this._curFov;
        if(!this.aiming){
            const pushIn = THREE.MathUtils.clamp(1 - this._curT, 0, 1);
            fov += pushIn * this.collisionFovExtra;
        }
        this.camera.fov = fov;

        // Close-mesh cull: push the near plane OUT as the camera nears the character, so meshes
        // very close to the lens are clipped rather than smeared across the view. Mapped from the
        // camera's distance to the pivot — tpsNearMax at tpsMinDistance, tpsNear by tpsNearGrowDist.
        const camDist = this._curT * splineLen;
        this.camera.near = THREE.MathUtils.clamp(
            THREE.MathUtils.mapLinear(camDist, this.tpsMinDistance, this.tpsNearGrowDist, this.tpsNearMax, this.tpsNear),
            this.tpsNear, this.tpsNearMax);
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