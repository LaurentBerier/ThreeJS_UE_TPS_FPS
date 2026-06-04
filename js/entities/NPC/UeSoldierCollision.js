import * as THREE from 'three'
import Component from '../../Component.js'
import {Ammo, AmmoHelper} from '../../AmmoLib.js'


// Bullet hit volumes for the UE Mannequin soldier. The mutant's CharacterCollision
// is hard-coded to Mixamo bone names ("MutantSpine" …); the UE skeleton uses
// different names, so the soldier gets its own set. Each entry is a sphere trigger
// that follows a UE bone every frame; the trigger carries `parentEntity` so the
// player's weapon raycast (Weapon.Raycast) can broadcast a 'hit' to this entity.
// Spheres (not oriented capsules) keep it rotation-free and are plenty for hit
// detection on a humanoid.
const HIT_BONES = {
    head:        0.13,
    spine_03:    0.19,
    spine_01:    0.20,
    pelvis:      0.17,
    upperarm_l:  0.09,
    upperarm_r:  0.09,
    lowerarm_l:  0.08,
    lowerarm_r:  0.08,
    thigh_l:     0.12,
    thigh_r:     0.12,
    calf_l:      0.10,
    calf_r:      0.10,
};

export default class UeSoldierCollision extends Component{
    constructor(physicsWorld){
        super();
        this.name = 'UeSoldierCollision';
        this.world = physicsWorld;
        this.bonePos = new THREE.Vector3();
        this.parts = [];
        this.enabled = true;
    }

    Initialize(){
        this.controller = this.GetComponent('UeSoldierController');

        let skinnedMesh = null;
        this.controller.model.traverse(child => {
            if(child.isSkinnedMesh){ skinnedMesh = child; }
        });
        if(!skinnedMesh){ return; }

        Object.entries(HIT_BONES).forEach(([boneName, radius]) => {
            const bone = skinnedMesh.skeleton.bones.find(b => b.name === boneName);
            if(!bone){ return; }

            const shape = new Ammo.btSphereShape(radius);
            const object = AmmoHelper.CreateTrigger(shape);
            object.parentEntity = this.parent;
            // Default group/mask (like CharacterCollision) => hittable by the bullet
            // ray, which masks out only SensorTrigger.
            this.world.addCollisionObject(object);

            this.parts.push({bone, object});
        });
    }

    Disable(){
        if(!this.enabled){ return; }
        this.enabled = false;
        for(const {object} of this.parts){
            this.world.removeCollisionObject(object);
        }
    }

    Update(t){
        if(!this.enabled){ return; }

        for(const {bone, object} of this.parts){
            bone.getWorldPosition(this.bonePos);
            const transform = object.getWorldTransform();
            transform.getOrigin().setValue(this.bonePos.x, this.bonePos.y, this.bonePos.z);
        }
    }
}
