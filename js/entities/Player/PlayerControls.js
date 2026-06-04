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
        this.tpsShoulder = 0.5;   // lateral over-the-shoulder offset
        this.tpsCollisionMargin = 0.2; // keep the camera this far off a blocking wall
        this._vLatch = false;
        // Scratch vectors for the TPS boom (avoid per-frame allocation).
        this._cap = new THREE.Vector3();
        this._pivot = new THREE.Vector3();
        this._fwd = new THREE.Vector3();
        this._right = new THREE.Vector3();
        this._desired = new THREE.Vector3();
        this._boomDir = new THREE.Vector3();
        this._fwdBase = new THREE.Vector3(0, 0, -1);
        this._rightBase = new THREE.Vector3(1, 0, 0);
        this._rayRes = { intersectionPoint: new THREE.Vector3() };
    }

    Initialize(){
        this.physicsComponent = this.GetComponent("PlayerPhysics");
        this.physicsBody = this.physicsComponent.body;
        this.physicsWorld = this.physicsComponent.world; // for the TPS boom raycast
        this.transform = new Ammo.btTransform();
        this.zeroVec = new Ammo.btVector3(0.0, 0.0, 0.0);
        this.angles.setFromQuaternion(this.parent.Rotation);
        this.UpdateRotation();

        Input.AddMouseMoveListner(this.OnMouseMove);

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
    
        this.angles.y -= movementX * this.mouseSpeed;
        this.angles.x -= movementY * this.mouseSpeed;

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
        this.Broadcast({topic: 'camera.mode', mode: this.cameraMode});
        const label = document.getElementById('camera_mode');
        if(label){ label.textContent = this.cameraMode; }
    }

    // Place the camera for the current mode. capPos is the capsule-tracked
    // position (eye height); it is also Player.Position so NPC targeting/raycasts
    // are camera-mode-independent.
    UpdateCamera(capPos){
        if(this.cameraMode === 'FPS'){
            this.camera.position.copy(capPos);
            this.camera.quaternion.copy(this.parent.Rotation);
            return;
        }
        // TPS orbit-follow boom: pivot near the head, camera pulled back along the
        // look direction (pitch tilts it), with an over-the-shoulder offset.
        this._fwd.copy(this._fwdBase).applyQuaternion(this.parent.Rotation);
        this._right.copy(this._rightBase).applyQuaternion(this.parent.Rotation);
        this._pivot.copy(capPos);
        this._pivot.y += this.tpsPivotHeight;
        this._desired.copy(this._pivot)
            .addScaledVector(this._fwd, -this.tpsDistance)
            .addScaledVector(this._right, this.tpsShoulder);

        // Boom collision: cast from the pivot to the desired camera spot against
        // STATIC level geometry only (so the player capsule/NPCs never block it),
        // and pull the camera in to just shy of any wall it would clip into.
        if(this.physicsWorld && AmmoHelper.CastRay(
            this.physicsWorld, this._pivot, this._desired, this._rayRes, CollisionFilterGroups.StaticFilter)){
            this._boomDir.copy(this._desired).sub(this._pivot).normalize();
            this.camera.position.copy(this._rayRes.intersectionPoint)
                .addScaledVector(this._boomDir, -this.tpsCollisionMargin);
        } else {
            this.camera.position.copy(this._desired);
        }
        this.camera.lookAt(this._pivot);
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
            this.UpdateCamera(this._cap);
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