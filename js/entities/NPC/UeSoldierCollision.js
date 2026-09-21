import * as THREE from 'three'
import Component from '../../Component.js'
import {Ammo, AmmoHelper, CollisionFilterGroups} from '../../AmmoLib.js'


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
            // Tag the sphere with the bone it represents + its radius, so a bullet that lands here can plant its
            // blood decal on the EXACT bone that was hit (not the ambiguous nearest bone in the rifle pose) and
            // SIZE the decal to this body part (radius ~ the part's half-width) so it hugs it without overhang.
            object.hitBone = bone;
            object.hitRadius = radius;
            // CharacterFilter group (NOT the default): addCollisionObject(obj) with no group
            // defaults to the STATIC filter group in this Ammo build, which the TPS camera
            // spring-arm sweeps against — so the camera would dolly off the soldier's body
            // capsules. CharacterFilter stays hittable by the weapon ray (mask = All & ~Sensor)
            // while the camera (mask = StaticFilter) passes through. See CharacterCollision.
            // MASK = DefaultFilter, not AllFilter: these spheres exist to be RAY-HIT (rays carry
            // group DefaultFilter, so (sphereGroup & rayMask) && (rayGroup & sphereMask) still
            // passes). An AllFilter mask made every sphere form broadphase pairs with the terrain
            // trimesh, the structures and every OTHER sphere — thousands of useless pairs the
            // narrow phase chewed on each step. DefaultFilter keeps only pairs vs group-1 bodies
            // (the player capsule, dropped guns) — a handful.
            this.world.addCollisionObject(object, CollisionFilterGroups.CharacterFilter, CollisionFilterGroups.DefaultFilter);

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

    // Despawn cleanup: drop the hit volumes from the world (no-op if already Disabled on death).
    Dispose(){ this.Disable(); }

    Update(t){
        if(!this.enabled){ return; }
        // Dormant soldier (AiDirector asleep): sync ONCE so the spheres park at the resting pose,
        // then skip the per-frame bone syncs. The one-shot park is critical — a soldier dormant
        // from birth has never run an Update, and without it every ghost in the level sat stacked
        // at the WORLD ORIGIN, which alone generated ~18k broadphase pairs (~40 ms of narrow
        // phase per step). A bullet that finds a parked sphere still lands (TakeHit wakes the
        // encounter).
        if(this.controller && this.controller.dormant){
            if(!this._parked){ this._parked = true; this.SyncToBones(); }
            return;
        }
        this._parked = false;
        this.SyncToBones();
    }

    SyncToBones(){
        for(const {bone, object} of this.parts){
            bone.getWorldPosition(this.bonePos);
            const transform = object.getWorldTransform();
            transform.getOrigin().setValue(this.bonePos.x, this.bonePos.y, this.bonePos.z);
        }
    }
}
