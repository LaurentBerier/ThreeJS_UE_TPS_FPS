import * as THREE from 'three'
import Component from '../../Component.js'
import {Ammo, AmmoHelper, CollisionFilterGroups} from '../../AmmoLib.js'
import CharacterFSM from './CharacterFSM.js'
import { installProximityDither } from '../Common/CameraDither.js'

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

        // Distance at which a waypoint counts as "reached". Kept generous because
        // the agent moves via root motion and can't land precisely on a point;
        // accepting waypoints early lets it round corners instead of orbiting them.
        this.waypointRadius = 0.5;

        // Stuck detection: if the agent is supposed to be following a path but
        // stops making progress (e.g. wedged in a corner against a collision),
        // we drop the current waypoint so it re-aims and frees itself.
        this.stuckCheckPos = new THREE.Vector3();
        this.stuckTimer = 0.0;
        this.stuckCheckInterval = 0.5;
        this.minProgressSq = 0.15 * 0.15;

        this.viewAngle = Math.cos(Math.PI / 4.0);
        this.maxViewDistance = 20.0 * 20.0;
        this.tempVec = new THREE.Vector3();
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

        scene.scale.setScalar(0.01);
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

            // The TPS camera passes straight through enemies; dither this mutant's body
            // out when the lens clips into it instead of showing the inside of the mesh.
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach(m => installProximityDither(m, { near: 0.35, far: 1.0 }));
        });

        this.SetupAnimations();

        // Cache the navmesh group/node the agent starts on so we can clamp its
        // movement to the mesh every frame (see ApplyRootMotion).
        this.navGroup = this.navmesh.GetGroup(this.model.position);
        if(this.navGroup !== null){
            this.navNode = this.navmesh.GetClosestNode(this.model.position, this.navGroup);
        }

        this.scene.add(scene);
        this.stateMachine.SetState('idle');
    }

    UpdateDirection(){
        this.dir.copy(this.forwardVec);
        this.dir.applyQuaternion(this.parent.rotation);
    }

    CanSeeThePlayer(){
        const playerPos = this.player.Position.clone();
        const modelPos = this.model.position.clone();
        modelPos.y += 1.35;
        const charToPlayer = playerPos.sub(modelPos);

        if(playerPos.lengthSq() > this.maxViewDistance){
            return;
        }

        charToPlayer.normalize();
        const angle = charToPlayer.dot(this.dir);

        if(angle < this.viewAngle){
            return false;
        }

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
            // Turn briskly so the agent doesn't arc wide into walls on corners.
            this.model.quaternion.slerp(this.tempRot, 8.0 * t);
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

    // Detects when the agent is failing to make progress along its path and
    // skips the blocking waypoint so it can re-aim and slide out of the corner.
    CheckStuck(t){
        // Only meaningful while we're actively trying to walk a path.
        if(!this.canMove || !this.path?.length){
            this.stuckTimer = 0.0;
            this.stuckCheckPos.copy(this.model.position);
            return;
        }

        this.stuckTimer += t;
        if(this.stuckTimer < this.stuckCheckInterval){ return; }

        const movedSq = this.stuckCheckPos.distanceToSquared(this.model.position);
        this.stuckTimer = 0.0;
        this.stuckCheckPos.copy(this.model.position);

        if(movedSq >= this.minProgressSq){ return; }

        // No real progress this interval: drop the current waypoint and target
        // the next one. Emptying the path ends navigation just like arriving.
        this.path.shift();
        if(this.path.length === 0){
            this.Broadcast({topic: 'nav.end', agent: this});
        }
    }

    ApplyRootMotion(){
        if(this.canMove){
            const vel = this.rootBone.position.clone();
            vel.sub(this.lastPos).multiplyScalar(0.01);
            vel.y = 0;

            vel.applyQuaternion(this.model.quaternion);

            if(vel.lengthSq() < 0.1 * 0.1){
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