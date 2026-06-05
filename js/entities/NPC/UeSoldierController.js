import * as THREE from 'three'
import Component from '../../Component.js'
import {Ammo, AmmoHelper, CollisionFilterGroups} from '../../AmmoLib.js'
import UeSoldierFSM from './UeSoldierFSM.js'
import { buildUeMannequin } from '../Common/UeMannequin.js'
import { installProximityDitherOnObject } from '../Common/CameraDither.js'
import Ragdoll from './Ragdoll.js'
import { Faction, isHostile } from './Factions.js'


// A velocity-driven UE Mannequin enemy ("soldier"). It shares the player's rig,
// textures and AK, but is AI-driven. The defining contrast with the mutant's
// CharacterController is locomotion: the mutant is moved by *root motion* baked
// into its clips, whereas this soldier is moved by an explicit *velocity* each
// frame (path-follow at a target speed, clamped to the navmesh) and then chooses
// idle / walk / run purely from how fast it actually moved — the animation follows
// the velocity, not the other way around. Behaviour (idle/patrol/chase/attack/
// dead) lives in UeSoldierFSM; this class owns the body, movement and animation.
export default class UeSoldierController extends Component{
    constructor(model, clips, scene, physicsWorld, textures = null, weapon = null, preOriented = false, shotBuffer = null, audioListener = null, faction = Faction.ENEMY){
        super();
        this.name = 'UeSoldierController';
        this.model = model;
        this.clips = clips;
        this.scene = scene;
        this.physicsWorld = physicsWorld;
        this.textures = textures;
        this.weapon = weapon;
        this.preOriented = preOriented;   // true => Y-up, metre-scaled GLB with baked PBR
        this.shotBuffer = shotBuffer;     // optional AK shot AudioBuffer for ranged fire
        this.audioListener = audioListener;

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

        // Stuck detection & recovery. While the soldier should be travelling (chase/patrol)
        // but stops making progress, it first re-evaluates its path; if it is STILL wedged a
        // couple seconds later it does a small, subtle teleport onto a nearby navmesh node and
        // reorients — so it can never sit jammed in one spot forever (see UpdateStuckRecovery).
        this.stuckSamplePos = new THREE.Vector3();
        this.lastGoodPos = new THREE.Vector3();  // last spot we were provably moving on the navmesh
        this.stuckSampleInterval = 0.5;          // how often progress is sampled (s)
        this._stuckSampleAccum = 0.0;
        this.stuckTimer = 0.0;                   // time accumulated with no real progress (s)
        this.stuckRepathTime = 2.5;              // no progress this long => force a repath
        this.stuckTeleportTime = 4.5;            // ...still stuck this long => subtle teleport
        this.minProgressSq = 0.18 * 0.18;        // min metres² moved per sample to count as progress
        this._didRepath = false;

        // Perception / combat. This soldier is a RANGED gunner: he holds an AK and
        // shoots the player from a distance (hitscan) rather than closing to melee.
        // Awareness has TWO ways to notice the player (both still require line of sight):
        //   1) a wide forward view CONE, and
        //   2) a close PROXIMITY sense that fires regardless of facing — so a visible player
        //      who walks up beside/behind the soldier is noticed instead of being ignored.
        this.viewAngle = Math.cos(Math.PI / 3.0);   // 120° field of view (was 90°)
        this.proximitySenseRadius = 12.0;           // sense a visible player within this radius, any facing
        this.proximitySenseSq = this.proximitySenseRadius * this.proximitySenseRadius;
        this.maxViewDistance = 20.0 * 20.0;
        this.shootRange = 16.0;        // start shooting once this close (with line of sight)
        this.shootRangeSq = this.shootRange * this.shootRange;
        this.fireInterval = 0.85;      // seconds between shots
        this.shotDamage = 8;           // damage dealt to the player per landed shot
        this.hitChance = 0.5;          // chance a shot with clear LOS actually lands
        this.attackDuration = 1.0;     // legacy cadence field (unused by ranged FSM)
        // Lower than before so the player drops him in fewer bullets (player AK does
        // 2 dmg/shot => ~15 hits; previously 100 hp => ~50 hits).
        this.health = 30;

        // Facing: a smoothed yaw the body turns toward (movement dir or the target).
        this.facingYaw = 0.0;
        this.targetYaw = 0.0;

        // ---- Faction / relationships ----
        // Who this soldier is willing to attack is decided by faction hostility (see
        // Factions.js). `target` is the entity currently being hunted/shot — selected each
        // think-tick by AcquireTarget per the faction's priorities (an ENEMY prefers the
        // player but switches to a near CHAOTIC; a CHAOTIC takes the nearest of anyone).
        this.faction = faction;
        this.target = null;                       // current victim entity (player or another agent)
        this.provokedBy = null;                   // for NEUTRAL: retaliate against whoever hit it
        this.lastSeenPos = new THREE.Vector3();    // last spot the target was visible (chase memory)
        this.hasLastSeen = false;
        // An ENEMY treats a CHAOTIC within this range as the priority threat over the player.
        this.chaoticThreatRange = 16.0;
        this.chaoticThreatRangeSq = this.chaoticThreatRange * this.chaoticThreatRange;

        // Death.
        this.dead = false;
        this.deadTimer = 0.0;
        this.deadDuration = 1.1;
        this.ragdoll = null;        // verlet ragdoll built on death (drives the skeleton)

        // Muzzle flash (built in Initialize): a brief warm point light + an additive
        // sprite-ish sphere parked at the gun barrel each shot, so the ranged fire
        // reads visually and lights up the surroundings.
        this.handBone = null;
        this.flashLight = null;
        this.flashMesh = null;
        this.flashTimer = 0.0;
        this.flashDuration = 0.06;
        this.shotSound = null;

        // Scratch (avoid per-frame allocation).
        this.forwardVec = new THREE.Vector3(0, 0, 1);
        this.upAxis = new THREE.Vector3(0, 1, 0);
        this.tempVec = new THREE.Vector3();
        this.tempVec2 = new THREE.Vector3();
        this.tempVec2b = new THREE.Vector3();
        this.desiredPos = new THREE.Vector3();
        this.clampTarget = new THREE.Vector3();
        this.facePos = new THREE.Vector3();
        this.muzzlePos = new THREE.Vector3();
        this.fireDir = new THREE.Vector3();
        this.senseVec = new THREE.Vector3();
        this.parentQuat = new THREE.Quaternion();
    }

    Initialize(){
        this.navmesh = this.FindEntity('Level').GetComponent('Navmesh');
        this.hitbox = this.GetComponent('AttackTrigger');
        this.collision = this.GetComponent('UeSoldierCollision');
        this.player = this.FindEntity('Player');
        this.manager = this.parent.parent;   // EntityManager — used to enumerate other agents
        this.target = this.player;            // default target until AcquireTarget runs

        this.parent.RegisterEventHandler(this.TakeHit, 'hit');

        // Build the shared UE avatar: import fix, textured material, AK in hand.
        const built = buildUeMannequin(this.model, { textures: this.textures, weapon: this.weapon, preOriented: this.preOriented });
        this.modelRoot = built.modelRoot;
        this.rootBone = built.rootBone;
        this.handBone = built.handBone;   // muzzle flash rides forward of the gun hand
        this.skinnedmesh = built.meshes.find(m => m.isSkinnedMesh) || null;   // ragdoll skeleton source
        this.rootRef = this.rootBone ? {
            position: this.rootBone.position.clone(),
            quaternion: this.rootBone.quaternion.clone(),
            scale: this.rootBone.scale.clone(),
        } : null;

        // Feet sit on the navmesh at the spawn position.
        this.position = this.parent.Position.clone();
        this.modelRoot.position.copy(this.position);
        this.stuckSamplePos.copy(this.position);
        this.lastGoodPos.copy(this.position);

        this.mixer = new THREE.AnimationMixer(this.model);
        this.SetupAnimations();

        // Cache the navmesh group/node we start on so movement can be clamped to it.
        this.navGroup = this.navmesh.GetGroup(this.position);
        if(this.navGroup !== null){
            this.navNode = this.navmesh.GetClosestNode(this.position, this.navGroup);
        }

        this.scene.add(this.modelRoot);

        // The TPS camera passes straight through enemies (it only collides with static
        // geometry), so dither-dissolve this soldier's body + gun when the lens clips into
        // it — far more elegant than seeing the inside of the mesh (the general close-mesh
        // rule). Materials are already per-instance clones (buildUeMannequin), so this only
        // affects this soldier.
        installProximityDitherOnObject(this.modelRoot, { near: 0.35, far: 1.0 });

        this.SetupMuzzleFlash();

        this.stateMachine = new UeSoldierFSM(this);
        this.stateMachine.SetState('idle');
    }

    SetupMuzzleFlash(){
        // Warm point light: cheap (no shadow) and reads as the gun lighting the room.
        this.flashLight = new THREE.PointLight(0xffd08a, 0.0, 7.0, 2.0);
        this.flashLight.castShadow = false;
        this.flashLight.visible = false;
        this.scene.add(this.flashLight);

        // Small additive blob at the muzzle so the flash is visible from afar.
        const geo = new THREE.SphereGeometry(0.08, 8, 8);
        const mat = new THREE.MeshBasicMaterial({
            color: 0xffe1a8, transparent: true, opacity: 1.0,
            blending: THREE.AdditiveBlending, depthWrite: false,
        });
        this.flashMesh = new THREE.Mesh(geo, mat);
        this.flashMesh.visible = false;
        this.scene.add(this.flashMesh);

        // Positional shot audio (optional — guarded if no buffer/listener supplied).
        if(this.shotBuffer && this.audioListener){
            this.shotSound = new THREE.PositionalAudio(this.audioListener);
            this.shotSound.setBuffer(this.shotBuffer);
            this.shotSound.setRefDistance(8.0);
            this.shotSound.setVolume(0.7);
            this.modelRoot.add(this.shotSound);
        }
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

    // Path toward the current target (or its last-seen spot if it just slipped out of view).
    NavigateToTarget(){
        let dest = null;
        if(this.target && this.IsAlive(this.target)){ dest = this.target.Position; }
        else if(this.hasLastSeen){ dest = this.lastSeenPos; }
        if(!dest){ this.path = []; return; }
        this.tempVec.copy(dest);
        this.tempVec.y = 0.5;
        this.path = this.navmesh.FindPath(this.position, this.tempVec) || [];
    }

    // ---- Stuck detection & recovery ----
    // Re-evaluate the path: hunt the current target if we have one, otherwise resume patrol.
    RepathForRecovery(){
        const aware = (this.stateMachine?.currentState?.Name === 'chase') || this.AcquireTarget();
        if(aware && (this.target || this.hasLastSeen)){ this.NavigateToTarget(); }
        else{ this.NavigateToRandomPoint(); }
    }

    // ---- Faction / target acquisition ----
    // The faction of any entity in the world (PLAYER for you, the soldier's own faction for a
    // soldier, ENEMY for the melee beast). Returns null for entities that aren't combatants.
    FactionOf(entity){
        if(!entity){ return null; }
        if(entity === this.player){ return Faction.PLAYER; }
        const soldier = entity.GetComponent && entity.GetComponent('UeSoldierController');
        if(soldier){ return soldier.faction; }
        const beast = entity.GetComponent && entity.GetComponent('CharacterController');
        if(beast){ return Faction.ENEMY; }   // the mutant is a player-hunting enemy
        return null;
    }

    IsAlive(entity){
        if(!entity){ return false; }
        if(entity === this.player){ return true; }
        const soldier = entity.GetComponent('UeSoldierController');
        if(soldier){ return !soldier.dead; }
        const beast = entity.GetComponent('CharacterController');
        if(beast){ return !beast.dead; }
        return true;
    }

    // Pick the best target for THIS soldier's faction from everyone currently visible:
    //   * CHAOTIC — attacks everyone: the nearest visible hostile.
    //   * ENEMY   — hunts the player, but a CHAOTIC within chaoticThreatRange is the bigger
    //               threat and takes priority; otherwise the player, otherwise nearest hostile.
    //   * NEUTRAL — passive: only whoever provoked it (and only while still visible).
    // Sets this.target (+ remembers its last-seen position) and returns true if one was found.
    AcquireTarget(){
        if(this.faction === Faction.NEUTRAL){
            const ok = this.provokedBy && this.IsAlive(this.provokedBy) && this.CanSee(this.provokedBy);
            this._setTarget(ok ? this.provokedBy : null);
            return !!ok;
        }

        let best = null, bestDistSq = Infinity;
        let chaotic = null, chaoticDistSq = Infinity;
        let playerVisible = false;

        for(const entity of this.manager.entities){
            if(entity === this.parent){ continue; }
            const f = this.FactionOf(entity);
            if(!f || !isHostile(this.faction, f)){ continue; }
            if(!this.IsAlive(entity) || !this.CanSee(entity)){ continue; }

            const distSq = this.tempVec.copy(entity.Position).sub(this.position).lengthSq();
            if(distSq < bestDistSq){ bestDistSq = distSq; best = entity; }
            if(f === Faction.PLAYER){ playerVisible = true; }
            if(f === Faction.CHAOTIC && distSq < chaoticDistSq){ chaoticDistSq = distSq; chaotic = entity; }
        }

        let chosen = best;
        if(this.faction === Faction.ENEMY){
            // The player is the focus — unless a chaotic is near enough to be the worse threat.
            if(chaotic && chaoticDistSq <= this.chaoticThreatRangeSq){ chosen = chaotic; }
            else if(playerVisible){ chosen = this.player; }
        }
        this._setTarget(chosen);
        return !!chosen;
    }

    _setTarget(entity){
        this.target = entity;
        if(entity){ this.lastSeenPos.copy(entity.Position); this.hasLastSeen = true; }
    }

    // Last-resort: a small, subtle hop onto a nearby walkable navmesh node (or the last spot
    // we were provably on the mesh) + a snap-face toward the player, when the soldier can't
    // free itself by repathing. Short-range so it reads as "shuffling loose", not a blink.
    SubtleTeleport(){
        let dest = null;
        for(const range of [1.5, 2.5, 4.0]){
            const node = this.navmesh.GetRandomNode(this.position, range);
            if(node){ dest = node; break; }
        }
        // If we're off the mesh entirely (GetRandomNode needs a valid group), fall back to the
        // last position we were provably moving along it.
        if(!dest && this.lastGoodPos.lengthSq() > 0){ dest = this.lastGoodPos; }
        if(!dest){ return; }

        this.position.set(dest.x, this.position.y, dest.z);
        this.modelRoot.position.copy(this.position);
        // Re-acquire the navmesh group/node at the new spot so movement clamps correctly.
        this.navGroup = this.navmesh.GetGroup(this.position);
        this.navNode = this.navGroup !== null ? this.navmesh.GetClosestNode(this.position, this.navGroup) : null;
        // Snap-face the current target and rebuild the path so it resumes its goal immediately.
        const at = (this.target && this.target.Position) ? this.target.Position : this.player.Position;
        this.tempVec.copy(at).sub(this.position);
        this.tempVec.y = 0.0;
        if(this.tempVec.lengthSq() > 1e-6){
            this.facingYaw = Math.atan2(this.tempVec.x, this.tempVec.z);
            this.targetYaw = this.facingYaw;
        }
        this.stuckSamplePos.copy(this.position);
        this.RepathForRecovery();
    }

    // Per-frame: while the soldier should be travelling but isn't making progress, escalate
    // repath -> subtle teleport so it never wedges in one spot (see the constructor note).
    UpdateStuckRecovery(t){
        // Only meaningful while actively trying to travel (chase/patrol set canMove true;
        // idle/attack/dead set it false, where standing still is intended).
        if(this.dead || !this.canMove){
            this.stuckTimer = 0.0; this._stuckSampleAccum = 0.0; this._didRepath = false;
            this.stuckSamplePos.copy(this.position);
            return;
        }

        this._stuckSampleAccum += t;
        if(this._stuckSampleAccum < this.stuckSampleInterval){ return; }
        this._stuckSampleAccum = 0.0;

        const movedSq = this.stuckSamplePos.distanceToSquared(this.position);
        this.stuckSamplePos.copy(this.position);
        if(movedSq >= this.minProgressSq){
            // Making progress: remember this good spot and clear the stuck state.
            this.lastGoodPos.copy(this.position);
            this.stuckTimer = 0.0; this._didRepath = false;
            return;
        }

        this.stuckTimer += this.stuckSampleInterval;
        // Stage 1 (~2.5s): force a fresh path (attack the player or resume patrol).
        if(this.stuckTimer >= this.stuckRepathTime && !this._didRepath){
            this._didRepath = true;
            this.RepathForRecovery();
            return;
        }
        // Stage 2 (~4.5s): still wedged — subtle teleport + reorient.
        if(this.stuckTimer >= this.stuckTeleportTime){
            this.SubtleTeleport();
            this.stuckTimer = 0.0; this._didRepath = false;
        }
    }

    // Can the soldier see `entity` right now? Inside the forward view CONE, OR close enough to
    // sense regardless of facing (peripheral awareness), AND with a clear line of sight.
    CanSee(entity){
        if(!entity){ return false; }
        const eyePos = this.tempVec2.copy(this.position);
        eyePos.y += 1.6;                              // roughly the soldier's head
        const toT = this.senseVec.copy(entity.Position).sub(eyePos);

        const distSq = toT.lengthSq();
        if(distSq > this.maxViewDistance){ return false; }

        toT.normalize();
        const facing = this.forwardVec.set(Math.sin(this.facingYaw), 0, Math.cos(this.facingYaw));
        const inCone = toT.dot(facing) >= this.viewAngle;
        const inProximity = distSq <= this.proximitySenseSq;
        if(!inCone && !inProximity){ return false; }

        return this.HasLineOfSightTo(entity);
    }

    // Within firing range of the current target (line-of-sight checked separately).
    InRangeOf(entity){
        if(!entity){ return false; }
        return this.tempVec.copy(entity.Position).sub(this.position).lengthSq() <= this.shootRangeSq;
    }

    // Clear shot to `entity`: cast from the soldier's eye toward it and confirm the first thing
    // the ray reaches belongs to that entity (not a wall / another body in between). AI bodies
    // carry `parentEntity` on their hit colliders; the player is the capsule rigid body.
    HasLineOfSightTo(entity){
        if(!entity){ return false; }
        const eyePos = this.tempVec2.copy(this.position);
        eyePos.y += 1.5;
        this.tempVec.copy(entity.Position).sub(eyePos);
        const len = this.tempVec.length();
        if(len > 1e-3){ eyePos.addScaledVector(this.tempVec, 0.6 / len); }   // clear our own spheres
        const aim = this.tempVec2b.copy(entity.Position);
        if(entity !== this.player){ aim.y += 1.0; }                          // aim at a torso, not feet
        const rayInfo = {};
        const mask = CollisionFilterGroups.AllFilter & ~CollisionFilterGroups.SensorTrigger;
        if(AmmoHelper.CastRay(this.physicsWorld, eyePos, aim, rayInfo, mask)){
            const co = rayInfo.collisionObject;
            // The owning entity is stamped on the collider — on a ghost trigger for AI hit
            // spheres, on the rigid body for walls/props. Read both, same as Weapon.Raycast.
            const ghost = Ammo.castObject(co, Ammo.btPairCachingGhostObject);
            const rb = Ammo.castObject(co, Ammo.btRigidBody);
            // The player is its capsule rigid body (no parentEntity), so match it directly.
            if(entity === this.player){
                return rb == this.player.GetComponent('PlayerPhysics').body;
            }
            const ent = (ghost && ghost.parentEntity) || (rb && rb.parentEntity);
            return ent === entity;
        }
        return false;
    }

    // Fire one round at the current target: flash + sound, and (with clear LOS) a chance to land
    // a hit that damages it. The 'hit' is broadcast to the target ENTITY, so it works the same
    // whether the victim is the player, another soldier, or the beast.
    FireAtTarget(){
        if(this.dead || !this.target){ return; }

        // Park the flash just forward of the gun hand along the facing direction.
        this.fireDir.set(Math.sin(this.facingYaw), 0, Math.cos(this.facingYaw));
        if(this.handBone){ this.handBone.getWorldPosition(this.muzzlePos); }
        else{ this.muzzlePos.copy(this.position); this.muzzlePos.y += 1.4; }
        this.muzzlePos.addScaledVector(this.fireDir, 0.55);

        this.flashMesh.position.copy(this.muzzlePos);
        this.flashLight.position.copy(this.muzzlePos);
        this.flashMesh.visible = true;
        this.flashLight.visible = true;
        this.flashLight.intensity = 6.0;
        this.flashTimer = this.flashDuration;

        if(this.shotSound){
            this.shotSound.isPlaying && this.shotSound.stop();
            this.shotSound.play();
        }

        // The shot lands if there's a clear line and the accuracy roll succeeds.
        if(this.HasLineOfSightTo(this.target) && Math.random() < this.hitChance){
            this.target.Broadcast({topic: 'hit', amount: this.shotDamage, from: this.parent});
        }
    }

    UpdateMuzzleFlash(t){
        if(this.flashTimer <= 0.0){ return; }
        this.flashTimer = Math.max(0.0, this.flashTimer - t);
        const k = this.flashTimer / this.flashDuration;
        this.flashLight.intensity = 6.0 * k;
        this.flashMesh.material.opacity = k;
        if(this.flashTimer <= 0.0){
            this.flashLight.visible = false;
            this.flashMesh.visible = false;
        }
    }

    // Turn to face the current target (falls back to the player if somehow unset).
    FaceTarget(t, rate = 6.0){
        const at = (this.target && this.target.Position) ? this.target.Position : this.player.Position;
        this.tempVec.copy(at).sub(this.position);
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
        // Death is PURELY a physics ragdoll — no sink, no fade, no death clip. Stop the mixer
        // so the bones are handed entirely to physics, and disable the hit capsules so the
        // corpse stops absorbing fire.
        this.mixer.stopAllAction();
        this.collision && this.collision.Disable();
        // Kill any in-flight muzzle flash so the corpse doesn't keep glowing.
        this.flashTimer = 0.0;
        if(this.flashLight){ this.flashLight.visible = false; }
        if(this.flashMesh){ this.flashMesh.visible = false; }

        try{
            if(!this.skinnedmesh){ throw new Error('no skinned mesh'); }
            // Knock the corpse away from whoever killed it (the current target / player).
            const fromPos = (this.target && this.target.Position) ? this.target.Position : this.player.Position;
            const impulse = this.tempVec.copy(this.position).sub(fromPos);
            impulse.y = 0;
            if(impulse.lengthSq() < 1e-4){ impulse.set(0, 0, 1); }
            impulse.normalize().multiplyScalar(2.8);
            impulse.y = 2.0;
            this.ragdoll = new Ragdoll(this.skinnedmesh, {
                groundY: this.position.y,
                impulse: impulse.clone(),
            });
        }catch(e){
            console.error('Soldier ragdoll failed to build:', e);
            this.ragdoll = null;
        }
    }

    UpdateDeath(t){
        // Physics drives the skeleton each frame; nothing else. Guard so a ragdoll error can
        // never propagate up and kill the render loop.
        if(this.ragdoll){
            try{ this.ragdoll.update(t); }
            catch(e){ console.error('Soldier ragdoll update failed:', e); this.ragdoll = null; }
        }
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

        // Remember who hit us — a NEUTRAL retaliates against this attacker; everyone else uses
        // it as a fallback aggressor if they can't otherwise see anything.
        this.provokedBy = msg.from || this.player;

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
        this.UpdateMuzzleFlash(t);

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
        this.UpdateStuckRecovery(t);   // repath / subtle teleport if wedged (after the move)

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
