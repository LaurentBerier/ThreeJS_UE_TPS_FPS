import * as THREE from 'three'


// Death ragdoll for the skinned enemies. Inspired by the rapierjs-ragdoll demo
// (https://mavon.ie/demos/rapierjs-ragdoll): build a small physics skeleton from
// the character's bones, simulate it, then map the simulated joints back onto the
// real bones so the skinned mesh crumples and settles. This game runs on Ammo.js
// (Bullet) for the world, but a full multi-body Bullet constraint ragdoll is heavy
// to tune and easy to destabilise; for a one-shot death crumple a small, fully
// self-contained CPU **verlet** ragdoll is more robust (it can never explode the
// shared physics world) and works identically for BOTH enemy skeletons — the
// Mixanmo mutant and the UE Mannequin soldier — with zero per-rig bone names.
//
// How it stays generic:
//   * It walks the SkinnedMesh's own skeleton and keeps the "major" bones (dropping
//     fingers / toes / twist / IK helpers), re-parenting kept bones to their nearest
//     kept ancestor so the kept set is still a connected tree.
//   * A particle sits at each kept bone's world joint; a distance stick links it to
//     its kept parent (the limb), plus a longer "brace" stick to its grandparent
//     that gives the chain bending stiffness so the body folds at the joints instead
//     of collapsing into a noodle.
//   * Gravity + a ground plane + the optional knock-back impulse drive it; each
//     frame every kept bone is re-oriented (root → leaf) to point along its live
//     limb direction, exactly like the reference's bone-from-body mapping.
//
// Drop-in: construct it on death from the enemy's SkinnedMesh, then call update(dt)
// each frame in place of the animation mixer. Everything is guarded by the caller
// (try/catch) so a build failure simply falls back to the old death behaviour.

// Bones we DON'T simulate (extremities / helpers add cost and visual noise without
// changing the silhouette of a falling body). Kept bones re-parent across these.
const SKIP_BONE = /ik_|_twist|twist_|^root$|toe|ball|thumb|index|middle|ring|pinky|finger|weapon|prop|attach|_corrective|_offset/i;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _restDir = new THREE.Vector3();
const _liveDir = new THREE.Vector3();

export default class Ragdoll{
    // skinnedMesh : the enemy's THREE.SkinnedMesh (its .skeleton supplies the bones)
    // options:
    //   groundY  : world Y the corpse rests on (the feet/ground height at death)
    //   impulse  : THREE.Vector3 initial knock-back velocity (m/s) — away from the killer
    //   gravity  : downward accel (default -9.81)
    constructor(skinnedMesh, { groundY = 0, impulse = null, gravity = -9.81 } = {}){
        this.mesh = skinnedMesh;
        this.groundY = groundY;
        this.gravity = gravity;
        this.particleRadius = 0.06;
        // Fairly heavy drag so the knock-back seed velocity bleeds off in ~half a second —
        // the body topples and crumples roughly in place instead of sliding across the map.
        this.damping = 0.94;           // air drag per step
        this.friction = 0.5;           // horizontal damping while touching the ground
        this.iterations = 6;           // constraint relaxation passes per step
        this.substeps = 2;             // verlet sub-steps per frame (stability)
        this.boneStiffness = 1.0;      // limb (parent) sticks hold their length hard
        // Brace stiffness must stay LOW: grandparent braces are what keep the body from
        // collapsing into a noodle, but if they're too strong they keep the corpse standing
        // up (a stick-figure with stiff braces + feet on the floor is a stable column and
        // never falls — which is exactly why no ragdoll was visible). Keep it floppy.
        this.braceStiffness = 0.16;    // grandparent braces resist bending only gently

        skinnedMesh.skeleton.bones.forEach(b => b.updateWorldMatrix(true, false));

        this._build(impulse);
    }

    _build(impulse){
        const bones = this.mesh.skeleton.bones;
        const keep = b => !SKIP_BONE.test(b.name);

        // Kept bones + a particle each, at the bone's current world position.
        this.nodes = [];                 // { bone, p, prev, restWorldQuat, parent, grand, primaryChild }
        const nodeByBone = new Map();
        for(const bone of bones){
            if(!bone.isBone || !keep(bone)){ continue; }
            const p = bone.getWorldPosition(new THREE.Vector3());
            const node = {
                bone,
                p,
                prev: p.clone(),
                restWorldQuat: bone.getWorldQuaternion(new THREE.Quaternion()),
                parent: null, grand: null, primaryChild: null,
                grounded: false,
            };
            nodeByBone.set(bone, node);
            this.nodes.push(node);
        }
        if(this.nodes.length < 2){ throw new Error('Ragdoll: too few bones'); }

        // Nearest KEPT ancestor (walk up across skipped helper bones).
        const keptAncestor = bone => {
            let p = bone.parent;
            while(p && p.isBone){
                if(nodeByBone.has(p)){ return nodeByBone.get(p); }
                p = p.parent;
            }
            return null;
        };
        for(const node of this.nodes){
            node.parent = keptAncestor(node.bone);
            node.grand = node.parent ? node.parent.parent : null;
        }

        // The graph root = the kept bone with no kept ancestor (pelvis / hips).
        this.root = this.nodes.find(n => !n.parent) || this.nodes[0];

        // Distance sticks: limb (parent) + brace (grandparent, for bending stiffness).
        this.sticks = [];
        for(const node of this.nodes){
            if(node.parent){
                this.sticks.push({ a: node, b: node.parent, len: node.p.distanceTo(node.parent.p), k: this.boneStiffness });
            }
            if(node.grand){
                this.sticks.push({ a: node, b: node.grand, len: node.p.distanceTo(node.grand.p), k: this.braceStiffness });
            }
        }

        // Primary child for orientation = the kept child whose subtree is largest (so the
        // hips follow the spine, not a leg; an arm follows down to the hand). Build child
        // lists first, then pick by descendant count.
        const children = new Map(this.nodes.map(n => [n, []]));
        for(const node of this.nodes){ if(node.parent){ children.get(node.parent).push(node); } }
        const subtreeSize = node => {
            let n = 1;
            for(const c of children.get(node)){ n += subtreeSize(c); }
            return n;
        };
        for(const node of this.nodes){
            const kids = children.get(node);
            node.children = kids;
            if(kids.length){
                node.primaryChild = kids.reduce((best, c) => subtreeSize(c) > subtreeSize(best) ? c : best, kids[0]);
                // Rest direction (world) from this bone's joint toward that child's joint.
                node.restDir = node.primaryChild.p.clone().sub(node.p).normalize();
            }
        }

        // Precompute the root -> leaf (BFS) order so _applyToBones reuses it each frame and
        // every bone reads its parent's already-updated world transform.
        this.order = [];
        const queue = [this.root];
        while(queue.length){
            const n = queue.shift();
            this.order.push(n);
            for(const c of n.children){ queue.push(c); }
        }

        // Seed velocity so the corpse is knocked OFF BALANCE and topples (verlet velocity is
        // prev = p - v*dt0). The horizontal knockback grows with a joint's height above the
        // feet, so the upper body is shoved harder than the feet — that height-weighted push
        // is a tipping torque about the feet, which reliably tips the standing pose over
        // instead of sliding it flat (a uniform push would just translate the whole body).
        if(impulse){
            const dt0 = 1 / 60;
            let baseY = Infinity, topY = -Infinity;
            for(const node of this.nodes){ baseY = Math.min(baseY, node.p.y); topY = Math.max(topY, node.p.y); }
            const span = Math.max(0.2, topY - baseY);
            const horiz = _v2.set(impulse.x, 0, impulse.z);
            const up = impulse.y;
            for(const node of this.nodes){
                const h = (node.p.y - baseY) / span;          // 0 at the feet, 1 at the head
                const hScale = 0.3 + 1.7 * h;                 // upper body shoved harder => tips over
                node.prev.copy(node.p)
                    .addScaledVector(horiz, -dt0 * hScale)
                    .addScaledVector(_v.set(0, 1, 0), -dt0 * up);
            }
        }
    }

    update(dt){
        if(!this.nodes){ return; }
        const sub = Math.max(1e-3, Math.min(1 / 30, dt)) / this.substeps;
        for(let s = 0; s < this.substeps; s++){ this._step(sub); }
        this._applyToBones();
    }

    _step(dt){
        const g = this.gravity * dt * dt;
        const floor = this.groundY + this.particleRadius;
        for(const node of this.nodes){
            // Verlet integration with drag.
            _v.copy(node.p).sub(node.prev).multiplyScalar(this.damping);
            node.prev.copy(node.p);
            node.p.add(_v);
            node.p.y += g;
            // Ground plane + friction.
            node.grounded = false;
            if(node.p.y < floor){
                node.p.y = floor;
                node.grounded = true;
                // bleed horizontal speed against the floor
                node.p.x = node.prev.x + (node.p.x - node.prev.x) * this.friction;
                node.p.z = node.prev.z + (node.p.z - node.prev.z) * this.friction;
            }
        }
        // Relax distance constraints.
        for(let it = 0; it < this.iterations; it++){
            for(const st of this.sticks){
                _v.copy(st.b.p).sub(st.a.p);
                const d = _v.length();
                if(d < 1e-5){ continue; }
                const diff = ((d - st.len) / d) * 0.5 * st.k;
                _v.multiplyScalar(diff);
                st.a.p.add(_v);
                st.b.p.sub(_v);
            }
        }
    }

    // Map the simulated joints back onto the real bones: the root bone takes its world
    // POSITION from its particle (so the body lies where it fell), and every bone takes
    // its world ORIENTATION by rotating its rest pose so its limb axis points along the
    // live direction to its primary child. Processed root → leaf so each bone reads its
    // parent's freshly-updated world transform (matches the reference's top-down walk).
    _applyToBones(){
        for(const node of this.order){
            const bone = node.bone;

            // Root position from physics (children keep their rest offsets, like the ref).
            if(node === this.root){
                _v.copy(node.p);
                if(bone.parent){ bone.parent.worldToLocal(_v); }
                bone.position.copy(_v);
            }

            // Orientation: only bones that have a primary child get re-aimed; leaves keep
            // their rest local rotation and simply ride their parent.
            if(node.primaryChild && node.restDir){
                _liveDir.copy(node.primaryChild.p).sub(node.p);
                if(_liveDir.lengthSq() > 1e-8){
                    _liveDir.normalize();
                    _restDir.copy(node.restDir);
                    _q.setFromUnitVectors(_restDir, _liveDir);     // rest-axis -> live-axis (world delta)
                    _q.multiply(node.restWorldQuat);               // target world orientation
                    if(bone.parent){
                        bone.parent.getWorldQuaternion(_q2).invert();
                        bone.quaternion.copy(_q2).multiply(_q);
                    }else{
                        bone.quaternion.copy(_q);
                    }
                }
            }

            bone.updateWorldMatrix(false, false);
        }
    }

    dispose(){
        this.nodes = null;
        this.sticks = null;
    }
}
