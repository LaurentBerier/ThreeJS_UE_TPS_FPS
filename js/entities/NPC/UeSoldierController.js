import * as THREE from 'three'
import Component from '../../Component.js'
import {Ammo, AmmoHelper, CollisionFilterGroups} from '../../AmmoLib.js'
import UeSoldierFSM from './UeSoldierFSM.js'
import { buildUeMannequin } from '../Common/UeMannequin.js'


// A velocity-driven UE Mannequin enemy ("soldier"). It shares the player's rig,
// textures and AK, but is AI-driven. The defining contrast with the mutant's
// CharacterController is locomotion: the mutant is moved by *root motion* baked
// into its clips, whereas this soldier is moved by an explicit *velocity* each
// frame (path-follow at a target speed, clamped to the navmesh) and then chooses
// idle / walk / run purely from how fast it actually moved — the animation follows
// the velocity, not the other way around. Behaviour (idle/patrol/chase/attack/
// dead) lives in UeSoldierFSM; this class owns the body, movement and animation.
export default class UeSoldierController extends Component{
    constructor(model, clips, scene, physicsWorld, textures = null, weapon = null, preOriented = false){
        super();
        this.name = 'UeSoldierController';
        this.model = model;
        this.clips = clips;
        this.scene = scene;
        this.physicsWorld = physicsWorld;
        this.textures = textures;
        this.weapon = weapon;
        this.preOriented = preOriented;   // true => Y-up, metre-scaled GLB with baked PBR

        // Movement intent set by the FSM, realised by Locomote each frame.
        this.walkSpeed = 2.2;      // patrol m/s
        this.runSpeed = 4.6;       // chase m/s
        this.desiredSpeed = 0.0;
        this.currentSpeed = 0.0;   // smoothed actual speed -> drives the anim choice
        this.canMove = true;

        // walk/run blend thresholds (m/s) for the velocity-driven animation.
        this.runAnimThreshold = 3.2;
        this.walkAnimThreshold = 0.25;
        // walk and run reuse the single UE jog clip; slow it for a walk.
        this.animTimeScale = { idle: 1.0, walk: 0.6, run: 1.15, shoot: 1.4 };

        this.animations = {};
        this.locoState = null;     // 'idle' | 'walk' | 'run'
        this.override = null;      // 'attack' | 'dead' overriding locomotion, or null

        // Navigation.
        this.path = [];
        this.navGroup = null;
        this.navNode = null;
        this.waypointRadius = 0.6;

        // Perception / combat.
        this.viewAngle = Math.cos(Math.PI / 4.0);
        this.maxViewDistance = 20.0 * 20.0;
        this.attackDistance = 2.2;
        this.attackDuration = 1.0;     // melee cadence (no punch clip; uses 'shoot')
        this.health = 100;

        // Facing: a smoothed yaw the body turns toward (movement dir or the player).
        this.facingYaw = 0.0;
        this.targetYaw = 0.0;

        // Death.
        this.dead = false;
        this.deadTimer = 0.0;
        this.deadDuration = 1.1;

        // Scratch (avoid per-frame allocation).
        this.forwardVec = new THREE.Vector3(0, 0, 1);
        this.upAxis = new THREE.Vector3(0, 1, 0);
        this.tempVec = new THREE.Vector3();
        this.tempVec2 = new THREE.Vector3();
        this.desiredPos = new THREE.Vector3();
        this.clampTarget = new THREE.Vector3();
        this.facePos = new THREE.Vector3();
        this.parentQuat = new THREE.Quaternion();
    }

    Initialize(){
        this.navmesh = this.FindEntity('Level').GetComponent('Navmesh');
        this.hitbox = this.GetComponent('AttackTrigger');
        this.collision = this.GetComponent('UeSoldierCollision');
        this.player = this.FindEntity('Player');

        this.parent.RegisterEventHandler(this.TakeHit, 'hit');

        // Build the shared UE avatar: import fix, textured material, AK in hand.
        const built = buildUeMannequin(this.model, { textures: this.textures, weapon: this.weapon, preOriented: this.preOriented });
        this.modelRoot = built.modelRoot;
        this.rootBone = built.rootBone;
        this.rootRef = this.rootBone ? {
            position: this.rootBone.position.clone(),
            quaternion: this.rootBone.quaternion.clone(),
            scale: this.rootBone.scale.clone(),
        } : null;

        // Feet sit on the navmesh at the spawn position.
        this.position = this.parent.Position.clone();
        this.modelRoot.position.copy(this.position);

        this.mixer = new THREE.AnimationMixer(this.model);
        this.SetupAnimations();

        // Cache the navmesh group/node we start on so movement can be clamped to it.
        this.navGroup = this.navmesh.GetGroup(this.position);
        if(this.navGroup !== null){
            this.navNode = this.navmesh.GetClosestNode(this.position, this.navGroup);
        }

        this.scene.add(this.modelRoot);

        this.stateMachine = new UeSoldierFSM(this);
        this.stateMachine.SetState('idle');
    }

    SetupAnimations(){
        ['idle', 'walk', 'run', 'shoot'].forEach(name => {
            const clip = this.clips[name];
            if(clip){ this.animations[name] = this.mixer.clipAction(clip); }
        });
    }

    // ---- Interface consumed by UeSoldierFSM ----
    SetMoveIntent(speed){ this.desiredSpeed = speed; this.canMove = speed > 0.0; }

    ClearPath(){ if(this.path){ this.path.length = 0; } }

    NavigateToRandomPoint(){
        const node = this.navmesh.GetRandomNode(this.position, 50);
        if(!node){ this.path = []; return; }
        this.path = this.navmesh.FindPath(this.position, node) || [];
    }

    NavigateToPlayer(){
        this.tempVec.copy(this.player.Position);
        this.tempVec.y = 0.5;
        this.path = this.navmesh.FindPath(this.position, this.tempVec) || [];
    }

    CanSeeThePlayer(){
        const playerPos = this.tempVec.copy(this.player.Position);
        const eyePos = this.tempVec2.copy(this.position);
        eyePos.y += 1.6;                              // roughly the soldier's head
        const toPlayer = playerPos.clone().sub(eyePos);

        if(toPlayer.lengthSq() > this.maxViewDistance){ return false; }

        toPlayer.normalize();
        // Facing direction in world xz from the smoothed yaw.
        const facing = this.forwardVec.set(Math.sin(this.facingYaw), 0, Math.cos(this.facingYaw));
        if(toPlayer.dot(facing) < this.viewAngle){ return false; }

        const rayInfo = {};
        const mask = CollisionFilterGroups.AllFilter & ~CollisionFilterGroups.SensorTrigger;
        if(AmmoHelper.CastRay(this.physicsWorld, eyePos, this.player.Position, rayInfo, mask)){
            const body = Ammo.castObject(rayInfo.collisionObject, Ammo.btRigidBody);
            if(body == this.player.GetComponent('PlayerPhysics').body){ return true; }
        }
        return false;
    }

    get IsCloseToPlayer(){
        this.tempVec.copy(this.player.Position).sub(this.position);
        return this.tempVec.lengthSq() <= this.attackDistance * this.attackDistance;
    }

    get IsPlayerInHitbox(){ return this.hitbox.overlapping; }

    HitPlayer(){ this.player.Broadcast({topic: 'hit'}); }

    FacePlayer(t, rate = 6.0){
        this.tempVec.copy(this.player.Position).sub(this.position);
        this.tempVec.y = 0.0;
        if(this.tempVec.lengthSq() < 1e-6){ return; }
        this.targetYaw = Math.atan2(this.tempVec.x, this.tempVec.z);
        this.facingYaw = this.StepYaw(this.facingYaw, this.targetYaw, rate * t);
    }

    BeginAttack(){
        this.override = 'attack';
        const action = this.animations['shoot'];
        if(!action){ return; }
        action.reset();
        action.setLoop(THREE.LoopRepeat);
        action.setEffectiveWeight(1.0);
        action.setEffectiveTimeScale(this.animTimeScale.shoot);
        if(this.locoState && this.animations[this.locoState]){
            action.crossFadeFrom(this.animations[this.locoState], 0.15, true);
        }
        action.play();
        this.locoState = null;
    }

    EndAttack(){
        const action = this.animations['shoot'];
        if(action){ action.fadeOut(0.15); }
        this.override = null;
    }

    Die(){
        if(this.dead){ return; }
        this.dead = true;
        this.override = 'dead';
        this.canMove = false;
        this.deadTimer = 0.0;
        // Freeze the current pose and let the body sink + fade (no death clip in the
        // UE rifle set). Disable the hit capsules so the corpse stops absorbing fire.
        this.mixer.stopAllAction();
        this.collision && this.collision.Disable();
        this.modelRoot.traverse(child => {
            if(child.isMesh || child.isSkinnedMesh){
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                mats.forEach(m => { m.transparent = true; });
            }
        });
    }

    UpdateDeath(t){
        this.deadTimer += t;
        const k = Math.min(1.0, this.deadTimer / this.deadDuration);
        // Sink into the floor and fade out, then hide the corpse.
        this.modelRoot.position.y = this.position.y - 2.0 * k * k;
        this.modelRoot.traverse(child => {
            if(child.isMesh || child.isSkinnedMesh){
                const mats = Array.isArray(child.material) ? child.material : [child.material];
                mats.forEach(m => { m.opacity = 1.0 - k; });
            }
        });
        if(k >= 1.0){ this.modelRoot.visible = false; }
    }

    // ---- Movement & animation ----
    // Smallest-angle step from `a` toward `b`, capped at maxStep radians.
    StepYaw(a, b, maxStep){
        let diff = b - a;
        while(diff > Math.PI){ diff -= Math.PI * 2; }
        while(diff < -Math.PI){ diff += Math.PI * 2; }
        if(Math.abs(diff) <= maxStep){ return b; }
        return a + Math.sign(diff) * maxStep;
    }

    // Move toward the current waypoint at desiredSpeed, clamped to the navmesh, and
    // record the actual speed achieved (what the animation reads).
    Locomote(t){
        let moved = 0.0;

        if(this.canMove && this.path && this.path.length){
            const wp = this.path[0];
            this.tempVec.set(wp.x - this.position.x, 0.0, wp.z - this.position.z);
            const dist = this.tempVec.length();

            if(dist <= this.waypointRadius){
                this.path.shift();
                if(this.path.length === 0){ this.Broadcast({topic: 'nav.end', agent: this}); }
            }else{
                this.tempVec.divideScalar(dist);                 // normalize move dir
                this.targetYaw = Math.atan2(this.tempVec.x, this.tempVec.z);
                this.facingYaw = this.StepYaw(this.facingYaw, this.targetYaw, 8.0 * t);

                const step = Math.min(this.desiredSpeed * t, dist);
                this.desiredPos.copy(this.position).addScaledVector(this.tempVec, step);

                if(this.navNode && this.navGroup !== null){
                    this.navNode = this.navmesh.ClampStep(
                        this.position, this.desiredPos, this.navNode, this.navGroup, this.clampTarget
                    );
                    this.clampTarget.y = this.position.y;
                    moved = this.position.distanceTo(this.clampTarget);
                    this.position.copy(this.clampTarget);
                }else{
                    moved = this.position.distanceTo(this.desiredPos);
                    this.position.copy(this.desiredPos);
                }
            }
        }

        // Smooth the measured speed so the walk/run choice doesn't flicker.
        const instSpeed = t > 0 ? moved / t : 0.0;
        this.currentSpeed += (instSpeed - this.currentSpeed) * Math.min(1.0, t * 10.0);
    }

    // Pick idle / walk / run from the actual velocity (skipped while attack/death
    // own the animation).
    UpdateLocomotionAnim(){
        if(this.override){ return; }
        let desired = 'idle';
        if(this.currentSpeed > this.runAnimThreshold){ desired = 'run'; }
        else if(this.currentSpeed > this.walkAnimThreshold){ desired = 'walk'; }
        this.SetLocoState(desired);
    }

    SetLocoState(name){
        if(this.locoState === name || !this.animations[name]){ return; }
        const next = this.animations[name];
        next.reset();
        next.setLoop(THREE.LoopRepeat);
        next.setEffectiveWeight(1.0);
        next.setEffectiveTimeScale(this.animTimeScale[name] ?? 1.0);
        next.play();
        if(this.locoState && this.animations[this.locoState]){
            next.crossFadeFrom(this.animations[this.locoState], 0.2, true);
        }
        this.locoState = name;
    }

    TakeHit = (msg) => {
        if(this.dead){ return; }
        this.health = Math.max(0, this.health - (msg.amount ?? 0));

        if(this.health === 0){
            this.stateMachine.SetState('dead');
        }else{
            const state = this.stateMachine.currentState && this.stateMachine.currentState.Name;
            if(state === 'idle' || state === 'patrol'){
                this.stateMachine.SetState('chase');
            }
        }
    }

    Update(t){
        this.mixer && this.mixer.update(t);

        // Strip baked root motion so the clip plays in place; velocity moves us.
        if(this.rootBone && this.rootRef){
            this.rootBone.position.copy(this.rootRef.position);
            this.rootBone.quaternion.copy(this.rootRef.quaternion);
            this.rootBone.scale.copy(this.rootRef.scale);
        }

        this.stateMachine.Update(t);

        if(this.dead){
            // Death tween is driven by the FSM's DeadState via UpdateDeath.
            this.SyncParentTransform();
            return;
        }

        this.Locomote(t);
        this.UpdateLocomotionAnim();

        // Apply transforms: body follows position + smoothed facing yaw.
        this.modelRoot.position.copy(this.position);
        this.modelRoot.rotation.set(0, this.facingYaw, 0);
        this.SyncParentTransform();
    }

    // Keep the entity transform in sync so AttackTrigger / hit capsules follow.
    SyncParentTransform(){
        this.parentQuat.setFromAxisAngle(this.upAxis, this.facingYaw);
        this.parent.SetPosition(this.position);
        this.parent.SetRotation(this.parentQuat);
    }
}
