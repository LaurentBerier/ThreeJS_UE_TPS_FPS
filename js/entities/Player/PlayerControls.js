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
        this.tpsDistance = 3.0;   // boom length behind the player (metres)
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
        // wall blocks it, the camera simply DOLLIES straight in along the view axis —
        // it "gets closer to the character" — keeping camRadius of clearance so it never
        // clips. There is NO sideways re-projection, so the camera never slides against
        // the player's input (that was the source of the jumps/fighting). As you pan,
        // the unobstructed length changes continuously, so the camera glides smoothly
        // along the wall on its own. Orientation always tracks the look input exactly
        // (no positional lag on the look), so aiming stays 1:1.
        //
        // The boom LENGTH is the only thing smoothed: pulling IN is quick but bounded so
        // it can never lag into a wall; returning OUT (a wall clearing) is slow and
        // gentle so it never snaps or "fast-readjusts".
        this.camRadius = 0.32;          // clearance kept from geometry (metres)
        this.pullInRate = 14.0;         // boom-shortening smoothing (1/s) — quick, soft
        this.returnRate = 3.5;          // boom-lengthening smoothing (1/s) — slow, elegant
        this.softLag = 0.18;            // max the boom may trail the hard limit while pulling in (< camRadius => still no clip)
        this._curLen = this.tpsDistance; // smoothed boom length
        this._camTarget = new THREE.Vector3();  // (first-person eye target)
        this._camInit = false;
        this._free = new THREE.Vector3();
        this._sweepRes = { point: new THREE.Vector3(), normal: new THREE.Vector3(), fraction: 1 };

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
    OnPlayerHit = () => { this.AddTrauma(0.18); }
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

        // Ease the boom length / shoulder offset / FOV toward their precise-aim or
        // hip targets so toggling right click glides in and out of the zoom.
        const k = Math.min(1, t * this.aimLerpSpeed);
        const targetDistance = this.aiming ? this.tpsAimDistance : this.tpsDistance;
        const targetShoulder = this.aiming ? this.tpsAimShoulder : this.tpsShoulder;
        const targetFov      = this.aiming ? this.tpsAimFov      : this.baseFov;
        this._curDistance += (targetDistance - this._curDistance) * k;
        this._curShoulder += (targetShoulder - this._curShoulder) * k;
        this._curFov      += (targetFov      - this._curFov)      * k;
        this.camera.fov = this._curFov;
        this.camera.updateProjectionMatrix();

        // TPS orbit-follow boom: pivot near the head, camera pulled back along the
        // look direction (pitch tilts it), with an over-the-shoulder offset.
        this._fwd.copy(this._fwdBase).applyQuaternion(this.parent.Rotation);
        this._right.copy(this._rightBase).applyQuaternion(this.parent.Rotation);
        this._pivot.copy(capPos);
        this._pivot.y += this.tpsPivotHeight;
        // Shift the whole boom rig (look target AND camera) laterally by tpsShoulder.
        // Because the camera looks at this shifted target, the character ends up that
        // far to the LEFT of the view axis (frame-left) while the screen-centre reticle
        // floats in the open space to their right — in front of the gun the mannequin
        // holds in its right hand. (Applying the offset to the camera alone, as before,
        // just angled the view and kept the character centred under the reticle.)
        this._pivot.addScaledVector(this._right, this._curShoulder);

        // Where the camera WANTS to sit: straight behind the pivot along the view axis.
        this._free.copy(this._pivot).addScaledVector(this._fwd, -this._curDistance);

        // Sweep a sphere along that boom. If a wall blocks it, the unobstructed length
        // is shorter (fraction < 1) and the camera dollies in by exactly that much —
        // the sphere centre at the hit is already camRadius off the wall, so the camera
        // never clips. No hit => full length.
        let rawLen = this._curDistance;
        if(this.physicsWorld && AmmoHelper.SphereSweep(
            this.physicsWorld, this.camRadius, this._pivot, this._free, this._sweepRes, CollisionFilterGroups.StaticFilter)){
            rawLen = this._curDistance * this._sweepRes.fraction;
        }

        // Smooth the boom LENGTH only — purely radial, so the camera never moves
        // sideways against the player's input. Pull IN quickly but bounded (it may trail
        // the hard limit by at most softLag, which is < camRadius so there's still no
        // clip); return OUT slowly and gently. Because rawLen changes continuously as
        // you pan, the dolly glides — it reads as the camera sliding along the wall.
        if(!this._camInit){
            this._curLen = rawLen;
            this._camInit = true;
        }else if(rawLen < this._curLen){
            this._curLen += (rawLen - this._curLen) * (1 - Math.exp(-this.pullInRate * t));
            if(this._curLen > rawLen + this.softLag){ this._curLen = rawLen + this.softLag; }
        }else{
            this._curLen += (rawLen - this._curLen) * (1 - Math.exp(-this.returnRate * t));
        }

        this.camera.position.copy(this._pivot).addScaledVector(this._fwd, -this._curLen);
        this.camera.lookAt(this._pivot);
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