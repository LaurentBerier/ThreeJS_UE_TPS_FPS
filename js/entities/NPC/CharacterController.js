import * as THREE from 'three'
import Component from '../../Component.js'
import {Ammo, AmmoHelper, CollisionFilterGroups} from '../../AmmoLib.js'
import CharacterFSM from './CharacterFSM.js'
import { installProximityDitherOnObject } from '../Common/CameraDither.js'
import Ragdoll from './Ragdoll.js'

import DebugShapes from '../../DebugShapes.js'


export default class CharacterController extends Component{
    constructor(model, clips, scene, physicsWorld){
        super();
        this.name = 'CharacterController';
        this.physicsWorld = physicsWorld;
        this.scene = scene;
        this.mixer = null;
        this.clips = clips;
        this.animations = {};
        this.model = model;
        this.dir = new THREE.Vector3();
        this.forwardVec = new THREE.Vector3(0,0,1);
        this.upAxis = new THREE.Vector3(0,1,0);
        this.pathDebug = new DebugShapes(scene);
        this.path = [];
        this.tempRot = new THREE.Quaternion();

        // The creature is scaled up 2x for a hulking, dangerous beast. Its origin sits at
        // the feet, so scaling about it keeps the feet planted on the ground. The SAME
        // scale converts the root bone's per-frame displacement (in the clip's local units)
        // into world metres in ApplyRootMotion, so the strides don't foot-slide at any scale.
        this.modelScale = 0.02;

        // ApplyRootMotion rejects implausibly large per-frame root deltas (the spike when a clip
        // LOOPS and the root snaps back). That cap MUST scale with the model: the tuned value was
        // 0.1 m at the original 0.01 scale, so at 2x the legitimate run step is ~2x bigger and the
        // cap has to be too — otherwise normal run steps get rejected and the beast slides in
        // place (animates but doesn't advance), which reads exactly as "stuck against the wall".
        this.rootMotionMaxStep = 0.1 * (this.modelScale / 0.01);
        this.rootMotionMaxStepSq = this.rootMotionMaxStep * this.rootMotionMaxStep;

        // Distance at which a waypoint counts as "reached". Generous (and bigger now the agent is
        // 2x) because root motion can't land precisely on a point; accepting waypoints early lets
        // it round corners instead of orbiting them and arcing into walls.
        this.waypointRadius = 1.0;

        // Stuck detection & recovery — OSCILLATION-PROOF. The old detector sampled raw displacement
        // per interval, so an agent jittering/sliding against a wall (root motion shoves it, the
        // navmesh clamp slides it tangentially) registered as "progress" and never recovered. This
        // version anchors a position and only counts real progress once we travel progressRadius
        // AWAY from that anchor; jittering in place can never reset it, so the no-progress timer
        // always climbs when wedged. Escalation is purely time-based (decoupled from path churn):
        // two repath tries, then — while chasing — a forward-biased teleport that can never fail to
        // free the beast.
        this.progressAnchor = new THREE.Vector3();
        this.lastGoodPos = new THREE.Vector3();   // last spot we were provably making progress
        this.progressRadius = 0.5;                // must travel this far from the anchor to count as progress
        this.progressRadiusSq = this.progressRadius * this.progressRadius;
        this.noProgressTime = 0.0;                // seconds since we last genuinely advanced
        this.stuckRepathTime = 0.5;               // 1st reroute try
        this.stuckRepath2Time = 0.95;             // 2nd reroute try
        this.stuckTeleportTime = 1.4;             // still wedged => teleport (chasing) / random repath (else)
        this._didRepath1 = false;
        this._didRepath2 = false;

        // Death ragdoll (built on death; drives the skinned mesh in place of the mixer).
        this.dead = false;
        this.ragdoll = null;

        // Awareness: a wide forward view CONE plus a close PROXIMITY sense that fires
        // regardless of facing (both still need line of sight), so a visible player who walks
        // up beside/behind the mutant is noticed instead of ignored. See CanSeeThePlayer.
        this.viewAngle = Math.cos(Math.PI / 3.0);   // 120° field of view (was 90°)
        this.proximitySenseRadius = 12.0;           // sense a visible player within this radius, any facing
        this.proximitySenseSq = this.proximitySenseRadius * this.proximitySenseRadius;
        this.maxViewDistance = 20.0 * 20.0;
        this.tempVec = new THREE.Vector3();
        this.senseVec = new THREE.Vector3();
        this.desiredPos = new THREE.Vector3();
        this.clampTarget = new THREE.Vector3();
        this.navGroup = null;
        this.navNode = null;
        this.attackDistance = 2.2;

        this.canMove = true;
        this.health = 100;
    }

    SetAnim(name, clip){
        const action = this.mixer.clipAction(clip);
        this.animations[name] = {clip, action};
    }

    SetupAnimations(){
        Object.keys(this.clips).forEach(key=>{this.SetAnim(key, this.clips[key])});
    }

    Initialize(){
        this.stateMachine = new CharacterFSM(this);
        this.navmesh = this.FindEntity('Level').GetComponent('Navmesh');
        this.hitbox = this.GetComponent('AttackTrigger');
        this.player = this.FindEntity("Player");

        this.parent.RegisterEventHandler(this.TakeHit, 'hit');

        const scene = this.model;

        // 2x scale for a hulking beast. The FBX origin is at the feet, so scaling about it
        // keeps the feet on the ground at the spawn Y (no manual feet offset needed).
        scene.scale.setScalar(this.modelScale);
        scene.position.copy(this.parent.position);
        
        this.mixer = new THREE.AnimationMixer( scene );

        scene.traverse(child => {
            if ( !child.isSkinnedMesh  ) {
                return;
            }

            child.frustumCulled = false;
            child.castShadow = true;
            child.receiveShadow = true;
            this.skinnedmesh = child;
            this.rootBone = child.skeleton.bones.find(bone => bone.name == 'MutantHips');
            this.rootBone.refPos = this.rootBone.position.clone();
            this.lastPos = this.rootBone.position.clone();
        });

        // The TPS camera passes straight through enemies; dither this mutant out when the lens
        // clips into it instead of showing the inside of the mesh (the general close-mesh rule).
        installProximityDitherOnObject(this.model, { near: 0.35, far: 1.0 });

        this.SetupAnimations();

        // Cache the navmesh group/node the agent starts on so we can clamp its
        // movement to the mesh every frame (see ApplyRootMotion).
        this.navGroup = this.navmesh.GetGroup(this.model.position);
        if(this.navGroup !== null){
            this.navNode = this.navmesh.GetClosestNode(this.model.position, this.navGroup);
        }
        this.progressAnchor.copy(this.model.position);
        this.lastGoodPos.copy(this.model.position);

        this.scene.add(scene);
        this.stateMachine.SetState('idle');
    }

    UpdateDirection(){
        this.dir.copy(this.forwardVec);
        this.dir.applyQuaternion(this.parent.rotation);
    }

    CanSeeThePlayer(){
        const modelPos = this.tempVec.copy(this.model.position);
        modelPos.y += 1.35;
        const toPlayer = this.senseVec.copy(this.player.Position).sub(modelPos);

        const distSq = toPlayer.lengthSq();
        if(distSq > this.maxViewDistance){
            return false;
        }

        toPlayer.normalize();
        // Noticed if inside the forward view CONE, OR close enough to sense regardless of
        // which way the mutant faces (peripheral / spatial awareness).
        const inCone = toPlayer.dot(this.dir) >= this.viewAngle;
        const inProximity = distSq <= this.proximitySenseSq;
        if(!inCone && !inProximity){
            return false;
        }

        // Line of sight LAST (most expensive): the ray must reach the player unobstructed.
        const rayInfo = {};
        const collisionMask = CollisionFilterGroups.AllFilter & ~CollisionFilterGroups.SensorTrigger;
        if(AmmoHelper.CastRay(this.physicsWorld, modelPos, this.player.Position, rayInfo, collisionMask)){
            const body = Ammo.castObject( rayInfo.collisionObject, Ammo.btRigidBody );

            if(body == this.player.GetComponent('PlayerPhysics').body){
                return true;
            }
        }

        return false;
    }

    NavigateToRandomPoint(){
        const node = this.navmesh.GetRandomNode(this.model.position, 50);
        if(!node){ return; }
        this.path = this.navmesh.FindPath(this.model.position, node);
    }

    NavigateToPlayer(){
        this.tempVec.copy(this.player.Position);
        this.tempVec.y = 0.5;
        this.path = this.navmesh.FindPath(this.model.position, this.tempVec);

        /*
        if(this.path){
            this.pathDebug.Clear();
            for(const point of this.path){
                this.pathDebug.AddPoint(point, "blue");
            }
        }
        */
    }

    // Build a yaw-only orientation (about world up) that points the model's
    // forward (+Z) along a horizontal direction. This keeps the humanoid upright
    // and, unlike setFromUnitVectors, is well-defined when the target is exactly
    // behind the agent (a 180deg turn) — that degenerate case is what made the
    // enemy briefly roll/flip when reversing direction.
    YawToward(dir, out){
        out.setFromAxisAngle(this.upAxis, Math.atan2(dir.x, dir.z));
        return out;
    }

    FacePlayer(t, rate = 3.0){
        this.tempVec.copy(this.player.Position).sub(this.model.position);
        this.tempVec.y = 0.0;
        this.tempVec.normalize();

        this.YawToward(this.tempVec, this.tempRot);
        this.model.quaternion.rotateTowards(this.tempRot, rate * t);
    }

    get IsCloseToPlayer(){
        this.tempVec.copy(this.player.Position).sub(this.model.position);

        if(this.tempVec.lengthSq() <= this.attackDistance * this.attackDistance){
            return true;
        }

        return false;
    }

    get IsPlayerInHitbox(){
        return this.hitbox.overlapping;
    }

    HitPlayer(){
        this.player.Broadcast({topic: 'hit'});
    }

    TakeHit = msg => {
        this.health = Math.max(0, this.health - msg.amount);

        if(this.health == 0){
            this.stateMachine.SetState('dead');
        }else{
            const stateName = this.stateMachine.currentState.Name;
            if(stateName == 'idle' || stateName == 'patrol'){
                this.stateMachine.SetState('chase');
            }
        }
    }

    MoveAlongPath(t){
        if(!this.path?.length) return;

        const target = this.path[0].clone().sub( this.model.position );
        target.y = 0.0;

        if (target.lengthSq() > this.waypointRadius * this.waypointRadius) {
            target.normalize();
            this.YawToward(target, this.tempRot);
            // Turn briskly so the agent doesn't arc wide into walls on corners (a touch faster
            // now it's 2x scale and covering ground quicker).
            this.model.quaternion.slerp(this.tempRot, 10.0 * t);
        } else {
            // Remove node from the path we calculated
            this.path.shift();

            if(this.path.length===0){
                this.Broadcast({topic: 'nav.end', agent: this});
            }
        }
    }

    ClearPath(){
        if(this.path){
            this.path.length = 0;
        }
    }

    // Oscillation-proof stuck detection. Runs every frame (cheap) while we should be travelling.
    // "Progress" is only credited when we get progressRadius AWAY from an anchor we drop the
    // moment we last advanced — so sliding/jittering in place against a wall can never look like
    // progress and the no-progress timer always climbs when wedged. Escalation is time-based and
    // independent of how often the path is rebuilt: reroute, reroute again, then teleport.
    CheckStuck(t){
        // Only meaningful while we're actively trying to walk a path.
        if(!this.canMove || !this.path?.length){
            this.noProgressTime = 0.0;
            this._didRepath1 = this._didRepath2 = false;
            this.progressAnchor.copy(this.model.position);
            return;
        }

        // Genuine travel away from the anchor => real progress: re-anchor and clear the timers.
        if(this.progressAnchor.distanceToSquared(this.model.position) >= this.progressRadiusSq){
            this.progressAnchor.copy(this.model.position);
            this.lastGoodPos.copy(this.model.position);
            this.noProgressTime = 0.0;
            this._didRepath1 = this._didRepath2 = false;
            return;
        }

        this.noProgressTime += t;
        const chasing = this.stateMachine?.currentState?.Name === 'chase';

        // Try 1: reroute (the player may have moved; a fresh path can route around the obstacle).
        if(this.noProgressTime >= this.stuckRepathTime && !this._didRepath1){
            this._didRepath1 = true;
            this.RepathForRecovery();
            return;
        }
        // Try 2: reroute once more.
        if(this.noProgressTime >= this.stuckRepath2Time && !this._didRepath2){
            this._didRepath2 = true;
            this.RepathForRecovery();
            return;
        }
        // Still pinned after two tries: break it loose. While chasing this is a forward-biased
        // teleport (can never fail to free it); off-chase, a gentler fresh random route.
        if(this.noProgressTime >= this.stuckTeleportTime){
            if(chasing){
                this.SubtleTeleport();
            }else{
                this.NavigateToRandomPoint();
            }
            this.noProgressTime = 0.0;
            this._didRepath1 = this._didRepath2 = false;
            this.progressAnchor.copy(this.model.position);
        }
    }

    // Re-evaluate the path: hunt the player if we're onto them, otherwise resume patrol.
    RepathForRecovery(){
        const aware = (this.stateMachine?.currentState?.Name === 'chase') || this.CanSeeThePlayer();
        if(aware){ this.NavigateToPlayer(); }
        else{ this.NavigateToRandomPoint(); }
    }

    // Last-resort unstick: hop onto a nearby walkable navmesh node, biased toward the player so
    // the beast ends up PAST the obstacle (making progress) rather than beside or behind it.
    // Samples several candidate nodes across a few radii and picks the one closest to the player;
    // falls back to the last spot we were provably on the mesh. Always frees the agent.
    SubtleTeleport(){
        const px = this.player.Position.x, pz = this.player.Position.z;
        let best = null, bestScore = Infinity;
        for(const range of [2.0, 3.5, 5.0]){
            for(let i = 0; i < 3; i++){
                const node = this.navmesh.GetRandomNode(this.model.position, range);
                if(!node){ continue; }
                const dx = node.x - px, dz = node.z - pz;
                const score = dx * dx + dz * dz;          // closer to the player == better
                if(score < bestScore){ bestScore = score; best = node; }
            }
        }
        if(!best && this.lastGoodPos.lengthSq() > 0){ best = this.lastGoodPos; }
        if(!best){ return; }

        this.model.position.set(best.x, this.model.position.y, best.z);
        this.navGroup = this.navmesh.GetGroup(this.model.position);
        this.navNode = this.navGroup !== null ? this.navmesh.GetClosestNode(this.model.position, this.navGroup) : null;
        // Snap-face the player.
        this.tempVec.copy(this.player.Position).sub(this.model.position);
        this.tempVec.y = 0.0;
        if(this.tempVec.lengthSq() > 1e-6){
            this.tempVec.normalize();
            this.YawToward(this.tempVec, this.tempRot);
            this.model.quaternion.copy(this.tempRot);
        }
        this.progressAnchor.copy(this.model.position);
        this.noProgressTime = 0.0;
        this._didRepath1 = this._didRepath2 = false;
        this.RepathForRecovery();
    }

    // Death is PURELY a physics ragdoll — no die clip, no crossfade. Build a verlet ragdoll
    // from the current pose, stop the mixer so the bones are handed entirely to physics, and
    // let the beast crumple and settle.
    Die(){
        if(this.dead){ return; }
        this.dead = true;
        this.canMove = false;
        this.ClearPath();

        try{
            // Knock the corpse away from the player (horizontal) with some lift.
            const impulse = this.tempVec.copy(this.model.position).sub(this.player.Position);
            impulse.y = 0;
            if(impulse.lengthSq() < 1e-4){ impulse.set(0, 0, 1); }
            impulse.normalize().multiplyScalar(3.0);
            impulse.y = 2.2;

            this.ragdoll = new Ragdoll(this.skinnedmesh, {
                groundY: this.model.position.y,
                impulse: impulse.clone(),
            });
        }catch(e){
            console.error('Mutant ragdoll failed to build:', e);
            this.ragdoll = null;
        }
        // Stop the animation either way so no canned pose plays over/instead of the ragdoll.
        this.mixer.stopAllAction();
    }

    ApplyRootMotion(){
        if(this.canMove){
            const vel = this.rootBone.position.clone();
            // Convert the root bone's local displacement to world metres with the SAME
            // scale applied to the model, so a 2x-bigger beast strides 2x as far per cycle
            // without the feet sliding.
            vel.sub(this.lastPos).multiplyScalar(this.modelScale);
            vel.y = 0;

            vel.applyQuaternion(this.model.quaternion);

            // Reject only the clip-loop spike (scale-relative cap); normal run steps pass.
            if(vel.lengthSq() < this.rootMotionMaxStepSq){
                if(this.navNode && this.navGroup !== null){
                    // Constrain the move to the navmesh so the agent can't clip
                    // through collisions and wander off the walkable surface.
                    this.desiredPos.copy(this.model.position).add(vel);
                    this.navNode = this.navmesh.ClampStep(
                        this.model.position, this.desiredPos, this.navNode, this.navGroup, this.clampTarget
                    );
                    // clampStep projects onto the mesh plane; keep the original
                    // height so the enemy doesn't pop vertically.
                    this.clampTarget.y = this.desiredPos.y;
                    this.model.position.copy(this.clampTarget);
                } else {
                    this.model.position.add(vel);
                }
            }
        }

        //Reset the root bone horizontal position
        this.lastPos.copy(this.rootBone.position);
        this.rootBone.position.z = this.rootBone.refPos.z;
        this.rootBone.position.x = this.rootBone.refPos.x;
    }

    Update(t){
        // Dead with a ragdoll: physics drives the skinned mesh; skip the mixer/AI entirely.
        if(this.ragdoll){
            try{ this.ragdoll.update(t); }
            catch(e){ console.error('Mutant ragdoll update failed:', e); this.ragdoll = null; }
            return;
        }

        // Dead but the ragdoll couldn't be built (shouldn't happen): freeze, no clip.
        if(this.dead){ return; }

        this.mixer && this.mixer.update(t);
        this.ApplyRootMotion();

        this.UpdateDirection();
        this.MoveAlongPath(t);
        this.CheckStuck(t);
        this.stateMachine.Update(t);

        this.parent.SetRotation(this.model.quaternion);
        this.parent.SetPosition(this.model.position);
    }
}