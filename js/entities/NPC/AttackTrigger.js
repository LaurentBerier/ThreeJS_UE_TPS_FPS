import Component from '../../Component.js'
import {Ammo, AmmoHelper, CollisionFilterGroups} from '../../AmmoLib.js'

export default class AttackTrigger extends Component{
    constructor(physicsWorld){
        super();
        this.name = 'AttackTrigger';
        this.physicsWorld = physicsWorld;

        //Relative to parent
        this.localTransform = new Ammo.btTransform();
        this.localTransform.setIdentity();
        this.localTransform.getOrigin().setValue(0.0, 1.0, 1.0);

        this.quat = new Ammo.btQuaternion();

        this.overlapping = false;
    }

    SetupTrigger(){
        const shape = new Ammo.btSphereShape(0.4);
        this.ghostObj = AmmoHelper.CreateTrigger(shape);

        // MASK = DefaultFilter: this sensor exists solely to overlap the PLAYER CAPSULE (a
        // group-1 dynamic body). The old default AllFilter mask paired it with the terrain and
        // every static hull around it — dozens of broadphase pairs per trigger that the narrow
        // phase processed each step for nothing.
        this.physicsWorld.addCollisionObject(this.ghostObj, CollisionFilterGroups.SensorTrigger, CollisionFilterGroups.DefaultFilter);
    }

    Initialize(){
        this.playerPhysics = this.FindEntity('Player').GetComponent('PlayerPhysics');
        // The owning AI controller (soldier or beast), for the dormancy gate below.
        this.npc = this.GetComponent('UeSoldierController') || this.GetComponent('CharacterController');
        this.SetupTrigger();
    }

    PhysicsUpdate(world, t){
        if(!this.ghostObj){ return; }
        // Dormant owner (AiDirector asleep): the player is far beyond melee range by definition —
        // skip the per-tick overlap scan.
        if(this.npc && this.npc.dormant){ this.overlapping = false; return; }
        this.overlapping = AmmoHelper.IsTriggerOverlapping(this.ghostObj, this.playerPhysics.body);
    }

    // Remove the sensor ghost from the world when the entity is despawned (else it lingers as a
    // phantom trigger where the dead character used to be).
    Dispose(){
        if(this.ghostObj){
            this.physicsWorld.removeCollisionObject(this.ghostObj);
            this.ghostObj = null;
        }
    }

    Update(t){
        if(!this.ghostObj){ return; }
        // Dormant owner: park the sensor at the resting spot ONCE, then skip the per-frame sync
        // (never leave it at the world origin — see UeSoldierCollision).
        if(this.npc && this.npc.dormant){
            if(this._parked){ return; }
            this._parked = true;
        }else{
            this._parked = false;
        }
        const entityPos = this.parent.position;
        const entityRot = this.parent.rotation;
        const transform = this.ghostObj.getWorldTransform();

        this.quat.setValue(entityRot.x, entityRot.y, entityRot.z, entityRot.w);
        transform.setRotation(this.quat);
        transform.getOrigin().setValue(entityPos.x, entityPos.y, entityPos.z);
        transform.op_mul(this.localTransform);
    }
}