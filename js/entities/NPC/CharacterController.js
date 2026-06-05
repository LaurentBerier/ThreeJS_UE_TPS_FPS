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

        // ---- AAA path following (the real cornering fix) ----
        // 1) Agent-radius clearance: every fresh path is pushed off the wall corners it would
        //    otherwise hug (Navmesh.SmoothPath) so this wide beast has room to round them.
        // 2) Look-ahead steering: the body steers toward a point a short distance AHEAD along the
        //    path, not the next waypoint, so it anticipates and arcs through corners smoothly
        //    instead of overshooting a corner waypoint and grinding into the wall past it.
        // 3) Wall-slide deflection: if the navmesh clamp eats most of a step (we're pressed on a
        //    wall), we steer along the direction the clamp DID allow — the wall tangent — so the
        //    beast follows the wall around the corner instead of pushing straight into it.
        // Effective agent radius. Bumped above the beast's ~0.7 m body so paths are held WELL off
        // the walls (the navmesh isn't eroded, so this "narrows" the walkable corridors the beast
        // is routed down — see Navmesh.SmoothPath). Too small and the wide body still clips the
        // corner it's routed flush against; this keeps it walking down the middle.
        this.agentClearance = 1.0;     // how far paths hold off wall corners (m) — narrows the route
        this.lookAhead = 2.0;          // steer toward this far along the path (m) — smooths corners
        this.turnRate = 11.0;          // body slerp rate toward the steer heading (rad/s-ish)
        this.wallSlideBias = 0.8;      // 0..1: how hard a blocked step bends the heading to the wall tangent
        this.blockedThreshold = 0.65;  // a step shorter than this fraction of intended == "wall contact"
        this.isBlocked = false;        // set each frame by ApplyRootMotion, read by MoveAlongPath
        this.blockedTangent = new THREE.Vector3();   // unit wall-tangent the clamp allowed (when blocked)
        this.steerTarget = new THREE.Vector3();      // scratch: look-ahead steer point
        this.steerFrom = new THREE.Vector3();        // scratch: look-ahead walk cursor
        this.steerDir = new THREE.Vector3();         // scratch: final steer direction

        // Stuck detection & recovery — WAYPOINT-CENTRIC. Progress is anchor-based and oscillation
        // proof: it's only credited once we travel progressRadius AWAY from an anchor dropped the
        // moment we last advanced, so jittering/sliding against a wall can never look like progress
        // and the no-progress timer always climbs when wedged. Escalation models "keep trying the
        // current waypoint for a couple seconds, with a retry or two, then give up on it and head
        // somewhere else": retry the path at ~1 s and ~2 s, and if STILL wedged at ~2.5 s, ABANDON
        // the waypoint and commit to a fresh detour node off the stuck axis (FindAnotherWaypoint).
        // A teleport remains only as the last resort after several detours fail to free us.
        this.progressAnchor = new THREE.Vector3();
        this.lastGoodPos = new THREE.Vector3();   // last spot we were provably making progress
        this.progressRadius = 0.5;                // must travel this far from the anchor to count as progress
        this.progressRadiusSq = this.progressRadius * this.progressRadius;
        this.noProgressTime = 0.0;                // seconds since we last genuinely advanced
        this.retryInterval = 1.0;                 // attempt a repath each ~1 s of no progress...
        this.maxRetries = 2;                      // ...for at most this many retries (1-2) before giving up
        this.stuckRetries = 0;                    // repaths already tried at the current wedge
        this.abandonTime = 2.5;                   // total no-progress budget (≈2-3 s) before abandoning the waypoint
        this.detourTimer = 0.0;                   // time still committed to a detour (suppresses target repaths)
        this.detourDuration = 2.0;                // how long to commit to a detour so it isn't instantly overwritten
        this.detourAttempts = 0;                  // consecutive detours that failed to free us
        this.maxDetours = 3;                      // after this many failed detours => last-resort teleport

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

    // Build a path and give it agent-radius corner clearance so the wide beast can round corners
    // (see Navmesh.SmoothPath). Falls back to the raw path if smoothing isn't possible.
    SetPath(raw){
        this.path = this.navmesh.SmoothPath(this.model.position, raw, this.agentClearance) || raw || [];
    }

    NavigateToRandomPoint(){
        const node = this.navmesh.GetRandomNode(this.model.position, 50);
        if(!node){ return; }
        this.SetPath(this.navmesh.FindPath(this.model.position, node));
    }

    NavigateToPlayer(){
        this.tempVec.copy(this.player.Position);
        this.tempVec.y = 0.5;
        this.SetPath(this.navmesh.FindPath(this.model.position, this.tempVec));

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

    // Find the point `lookAhead` metres along the remaining path from the agent's current
    // position (interpolating within the segment it lands in). Steering toward this look-ahead
    // point — rather than the immediate next waypoint — lets the beast anticipate corners and arc
    // through them smoothly instead of running to a corner waypoint and pivoting hard into the
    // wall. Writes the result into outVec (kept at the model's Y) and returns it.
    SteerTarget(lookAhead, outVec){
        let remaining = lookAhead;
        const from = this.steerFrom.set(this.model.position.x, 0, this.model.position.z);
        for(let i = 0; i < this.path.length; i++){
            const wp = this.path[i];
            const segX = wp.x - from.x, segZ = wp.z - from.z;
            const segLen = Math.sqrt(segX * segX + segZ * segZ);
            if(segLen >= remaining || i === this.path.length - 1){
                const f = segLen > 1e-6 ? Math.min(1.0, remaining / segLen) : 1.0;
                return outVec.set(from.x + segX * f, this.model.position.y, from.z + segZ * f);
            }
            remaining -= segLen;
            from.set(wp.x, 0, wp.z);
        }
        const last = this.path[this.path.length - 1];
        return outVec.set(last.x, this.model.position.y, last.z);
    }

    MoveAlongPath(t){
        if(!this.path?.length) return;

        // Steer toward the look-ahead point (smooth cornering)...
        this.SteerTarget(this.lookAhead, this.steerTarget);
        this.steerDir.set(
            this.steerTarget.x - this.model.position.x, 0.0,
            this.steerTarget.z - this.model.position.z
        );
        // ...biased along the wall tangent when the last step was blocked, so the beast follows
        // the wall around the corner instead of grinding into it.
        if(this.isBlocked){
            if(this.steerDir.lengthSq() > 1e-8){ this.steerDir.normalize(); }
            this.steerDir.lerp(this.blockedTangent, this.wallSlideBias);
        }
        if(this.steerDir.lengthSq() > 1e-8){
            this.steerDir.normalize();
            this.YawToward(this.steerDir, this.tempRot);
            this.model.quaternion.slerp(this.tempRot, this.turnRate * t);
        }

        // Advance past every waypoint we've reached this frame (root motion can skip several when
        // moving fast or when clearance shifted them), so we never sit pinned waiting on one.
        while(this.path.length){
            const wp = this.path[0];
            const dx = wp.x - this.model.position.x, dz = wp.z - this.model.position.z;
            if(dx * dx + dz * dz > this.waypointRadius * this.waypointRadius){ break; }
            this.path.shift();
        }
        if(this.path.length === 0){
            this.detourTimer = 0.0;   // a detour (if any) is reached — let the chase repath resume
            this.Broadcast({topic: 'nav.end', agent: this});
        }
    }

    ClearPath(){
        this.detourTimer = 0.0;   // dropping the path also drops any detour commitment, so the
                                  // chase repath isn't gated out next frame (avoids a stale-detour stall)
        if(this.path){
            this.path.length = 0;
        }
    }

    // Waypoint-centric stuck detection. Runs every frame (cheap) while we should be travelling.
    // "Progress" is only credited when we get progressRadius AWAY from an anchor we drop the
    // moment we last advanced — so sliding/jittering in place against a wall can never look like
    // progress and the no-progress timer always climbs when wedged. Escalation models "try the
    // current waypoint for a couple seconds, with a retry or two, then give up on it and head
    // elsewhere": repath at ~1 s and ~2 s, then at ~2.5 s ABANDON the waypoint for a fresh detour.
    CheckStuck(t){
        // Always bleed down a committed detour, even when standing/attacking.
        if(this.detourTimer > 0.0){ this.detourTimer -= t; }

        // Not trying to travel (idle / attacking): nothing to recover from.
        if(!this.canMove){
            this.noProgressTime = 0.0;
            this.stuckRetries = 0;
            this.progressAnchor.copy(this.model.position);
            return;
        }

        // Trying to travel but with NO path at all — e.g. the target keeps returning an empty path
        // (player on a disconnected navmesh island / momentarily off-mesh). Treat that as being
        // stuck too, so the timer still climbs to the last-resort escape instead of resetting every
        // frame and freezing forever (an empty path otherwise bypasses ALL the recovery below).
        if(!this.path?.length){
            this.noProgressTime += t;
            if(this.noProgressTime >= this.abandonTime){
                this.FindAnotherWaypoint();   // detour to a reachable node, or SubtleTeleport if none
                this.noProgressTime = 0.0;
                this.stuckRetries = 0;
                this.progressAnchor.copy(this.model.position);
            }
            return;
        }

        // Genuine travel away from the anchor => real progress: re-anchor and clear everything.
        if(this.progressAnchor.distanceToSquared(this.model.position) >= this.progressRadiusSq){
            this.progressAnchor.copy(this.model.position);
            this.lastGoodPos.copy(this.model.position);
            this.noProgressTime = 0.0;
            this.stuckRetries = 0;
            this.detourAttempts = 0;   // we got moving again — forget the failed-detour streak
            return;
        }

        this.noProgressTime += t;

        // While committed to a detour, DON'T repath to the target (that route is what wedged us);
        // let the detour play out. Only if even the detour stalls past the budget do we pick yet
        // another waypoint.
        if(this.detourTimer > 0.0){
            if(this.noProgressTime >= this.abandonTime){
                this.FindAnotherWaypoint();
                this.noProgressTime = 0.0;
                this.stuckRetries = 0;
                this.progressAnchor.copy(this.model.position);
            }
            return;
        }

        // Normal path: a retry or two (one per retryInterval of no progress) before the budget runs out.
        if(this.noProgressTime < this.abandonTime){
            const dueRetries = Math.min(this.maxRetries, Math.floor(this.noProgressTime / this.retryInterval));
            if(dueRetries > this.stuckRetries){
                this.stuckRetries = dueRetries;
                this.RepathForRecovery();
            }
            return;
        }

        // Budget (~2-3 s) exhausted with retries spent: abandon this waypoint and go elsewhere.
        this.FindAnotherWaypoint();
        this.noProgressTime = 0.0;
        this.stuckRetries = 0;
        this.progressAnchor.copy(this.model.position);
    }

    // Give up on the unreachable waypoint and commit to a DIFFERENT one: a fresh, reachable navmesh
    // node off the stuck axis, held for detourDuration so the chase logic can't instantly re-route
    // us back into the same corner. Only after several detours in a row fail to free us (genuinely
    // wedged / off-mesh) do we fall back to the last-resort teleport.
    FindAnotherWaypoint(){
        this.detourAttempts++;
        // Several detours in a row failed to free us => genuinely wedged/off-mesh: last-resort hop.
        if(this.detourAttempts > this.maxDetours){
            this.SubtleTeleport();
            this.detourAttempts = 0;
            this.detourTimer = 0.0;
            return;
        }

        // Pick a reachable alternate node and commit to it — but only if a real path exists, so we
        // never freeze for detourDuration on an empty path.
        const detour = this.PickDetourNode();
        const raw = detour ? this.navmesh.FindPath(this.model.position, detour) : null;
        if(raw && raw.length){
            this.SetPath(raw);
            this.detourTimer = this.detourDuration;
            return;
        }
        // No usable detour (off the mesh / unreachable): teleport so we can never sit frozen.
        this.SubtleTeleport();
        this.detourAttempts = 0;
        this.detourTimer = 0.0;
    }

    // Choose a detour destination: sample a few navmesh nodes and prefer one that is LATERAL to our
    // stuck heading (i.e. sideways AROUND the obstacle, not back into it), well clear of the spot
    // we're wedged on, with a mild pull toward the player so we still close in. Scores are kept in
    // comparable ~0..1.5 ranges so lateral preference dominates without a far-player node swamping it.
    PickDetourNode(){
        const px = this.player.Position.x, pz = this.player.Position.z;
        const hx = this.dir.x, hz = this.dir.z;            // current heading (the stuck direction)
        const myToPlayer = Math.hypot(this.model.position.x - px, this.model.position.z - pz);
        let best = null, bestScore = -Infinity;
        for(const range of [2.5, 4.0, 5.5]){
            for(let i = 0; i < 4; i++){
                const node = this.navmesh.GetRandomNode(this.model.position, range);
                if(!node){ continue; }
                const dx = node.x - this.model.position.x, dz = node.z - this.model.position.z;
                const len = Math.sqrt(dx * dx + dz * dz);
                if(len < 0.75){ continue; }                // must actually take us somewhere new
                const lateral = Math.abs((dx / len) * hz - (dz / len) * hx);   // |sideways vs heading| 0..1
                const away = Math.min(1.5, Math.hypot(node.x - this.progressAnchor.x, node.z - this.progressAnchor.z) / 4.0);
                const gain = (myToPlayer - Math.hypot(node.x - px, node.z - pz)) / 5.0;  // + if it closes on the player
                const score = lateral * 1.5 + away * 0.8 + gain * 0.6;
                if(score > bestScore){ bestScore = score; best = node; }
            }
        }
        return best;
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
        this.stuckRetries = 0;
        this.detourTimer = 0.0;
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
            // Knock the corpse away from the player, with per-death RANDOM variation so no two
            // crumples look alike: jitter the shove DIRECTION (±~26°), STRENGTH and LIFT, plus a
            // random TWIST so the body spins a little as it falls. Gravity + friction do the rest.
            const dir = this.tempVec.copy(this.model.position).sub(this.player.Position);
            dir.y = 0;
            if(dir.lengthSq() < 1e-4){ dir.set(0, 0, 1); }
            dir.normalize();
            const yaw = (Math.random() - 0.5) * 0.9;            // spread the shove ±~26°
            const cy = Math.cos(yaw), sy = Math.sin(yaw);
            const mag = 2.0 * (0.7 + Math.random() * 0.6);      // 1.4 .. 2.6 m/s horizontal
            const impulse = new THREE.Vector3(
                (dir.x * cy - dir.z * sy) * mag,
                1.2 * (0.8 + Math.random() * 0.6),              // lift 0.96 .. 1.68 m/s
                (dir.x * sy + dir.z * cy) * mag);
            const twist = (Math.random() - 0.5) * 5.0;          // ±2.5 rad/s spin while falling

            this.ragdoll = new Ragdoll(this.skinnedmesh, {
                groundY: this.model.position.y,
                impulse,
                twist,
            });
        }catch(e){
            console.error('Mutant ragdoll failed to build:', e);
            this.ragdoll = null;
        }
        // Stop the animation either way so no canned pose plays over/instead of the ragdoll.
        this.mixer.stopAllAction();
    }

    ApplyRootMotion(){
        this.isBlocked = false;
        if(this.canMove){
            // Defensive: a navmesh-bound agent must NEVER move unclamped — that's what let root
            // motion run the beast straight THROUGH a wall/container and vanish off the map (then
            // the failsafe teleported it back). If we've lost our navmesh reference, re-acquire it
            // at our current spot first; the clamp below then keeps every step on the mesh.
            if(!this.navNode || this.navGroup === null){
                this.navGroup = this.navmesh.GetGroup(this.model.position);
                this.navNode = this.navGroup !== null
                    ? this.navmesh.GetClosestNode(this.model.position, this.navGroup) : null;
            }

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

                    // Wall-contact test: how much of the intended horizontal step survived the
                    // navmesh clamp? If the clamp slid us along a boundary and ate most of the
                    // step, we're pressed on a wall/corner — record the (unit) direction the clamp
                    // DID allow (the wall tangent) so MoveAlongPath steers along the wall and the
                    // beast rounds the corner instead of grinding into it.
                    const intendedLen = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
                    const moveX = this.clampTarget.x - this.model.position.x;
                    const moveZ = this.clampTarget.z - this.model.position.z;
                    const movedLen = Math.sqrt(moveX * moveX + moveZ * moveZ);
                    if(intendedLen > 1e-4 && movedLen > 1e-4 && movedLen < this.blockedThreshold * intendedLen){
                        this.blockedTangent.set(moveX / movedLen, 0, moveZ / movedLen);
                        this.isBlocked = true;
                    }

                    this.model.position.copy(this.clampTarget);
                } else {
                    // Still no navmesh reference even after re-acquiring => genuinely off the mesh.
                    // Do NOT move freely (that's the through-the-wall escape). Snap back to the last
                    // spot we were provably on the mesh and let stuck-recovery take it from there.
                    if(this.lastGoodPos.lengthSq() > 0){ this.model.position.copy(this.lastGoodPos); }
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