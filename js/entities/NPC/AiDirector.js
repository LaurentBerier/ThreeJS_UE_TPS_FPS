import * as THREE from 'three'
import Component from '../../Component.js'

// ---------------------------------------------------------------------------------------------
// AI DIRECTOR — proximity-based enemy activation (the "spawning system").
//
// The journey scatters ~16 AI (soldiers + beasts) along an ~800 m route, and every one of them
// used to run its FULL per-frame cost from the first frame: skinned mesh draw (their meshes are
// frustumCulled=false, so they rendered even off-screen), animation mixer, foot/weapon IK,
// perception raycasts, pathfinding, hit-sphere sync and attack-sensor overlap tests. The player
// only ever fights one encounter at a time, so almost all of that was waste — and it's why the
// game stuttered even far from any visible enemy.
//
// This director clusters the enemies into their authored ENCOUNTER GROUPS (spawn proximity) and
// keeps every group DORMANT — invisible, zero per-frame logic, zero draw — until the player
// closes in. Groups wake TOGETHER (so squad call-outs and the designed group fights still work)
// when any live member is inside activateRadius, and go back to sleep with hysteresis once every
// member is beyond deactivateRadius. Waking also happens reactively: a dormant enemy that takes
// a hit or hears close gunfire asks for its whole group to wake (controllers call requestWake),
// so sniping / noise can never interact with a frozen statue.
//
// All enemies are still fully BUILT at load time, behind the loading screen — activation is just
// a visibility + logic toggle, so waking a group mid-game costs nothing and never hitches.
// ---------------------------------------------------------------------------------------------
export default class AiDirector extends Component{
    constructor(){
        super();
        this.name = 'AiDirector';
        this.groups = [];              // [{ members: [{entity, controller}], active, stayUntil }]
        this.checkInterval = 0.25;     // seconds between activation sweeps (cheap: a few distances)
        this.checkTimer = 0.0;
        this.time = 0.0;
        // Activation envelope. activate sits WELL beyond every perception radius (max sight 34 m,
        // hearing 32 m) so a waking group can never pop into view already shooting; deactivate is
        // farther out so a fight that drifts around the boundary doesn't flicker groups on/off.
        this.activateRadius = 90;
        this.deactivateRadius = 125;
        this.activateSq = this.activateRadius * this.activateRadius;
        this.deactivateSq = this.deactivateRadius * this.deactivateRadius;
        // Spawns within this distance of each other merge into one encounter group. Matches the
        // authored encounter spacing (squads sit within ~25 m; separate encounters are 100 m+).
        this.clusterRadius = 26;
        // A group woken reactively (shot / heard gunfire) stays awake at least this long even if
        // the player is outside the deactivate radius, so it can investigate before re-sleeping.
        this.reactiveWakeTime = 12.0;
        this.tempVec = new THREE.Vector3();
    }

    Initialize(){
        this.player = this.FindEntity('Player');
        const manager = this.parent.parent;

        // Gather every AI agent present after level setup.
        const agents = [];
        for(const entity of manager.entities){
            if(!entity.GetComponent){ continue; }
            const c = entity.GetComponent('UeSoldierController') || entity.GetComponent('CharacterController');
            if(c && c.SetDormant){ agents.push({ entity, controller: c }); }
        }

        // Union spawns into encounter clusters.
        for(const a of agents){
            let placed = null;
            for(const g of this.groups){
                for(const m of g.members){
                    if(m.entity.Position.distanceTo(a.entity.Position) < this.clusterRadius){ placed = g; break; }
                }
                if(placed){ break; }
            }
            if(!placed){
                placed = { members: [], active: true, stayUntil: 0 };
                this.groups.push(placed);
            }
            placed.members.push(a);
        }

        // Wire the reactive wake hook, then put the whole world to sleep and immediately wake
        // whatever the player spawns near (usually nothing — the first fight is ~120 m out).
        for(const g of this.groups){
            for(const m of g.members){
                m.controller.requestWake = () => this.WakeGroup(g);
            }
            this._SetGroupActive(g, false);
        }
        this._Evaluate();

        console.log(`[AiDirector] ${agents.length} AI in ${this.groups.length} encounter groups; ` +
            `activate<${this.activateRadius}m, deactivate>${this.deactivateRadius}m`);
    }

    WakeGroup(group){
        group.stayUntil = this.time + this.reactiveWakeTime;
        this._SetGroupActive(group, true);
    }

    _SetGroupActive(group, active){
        if(group.active === active){ return; }
        group.active = active;
        for(const m of group.members){
            // Dead members run their own corpse lifecycle (ragdoll -> despawn); leave them be.
            if(m.controller.dead){ continue; }
            m.controller.SetDormant(!active);
        }
    }

    _Evaluate(){
        const p = this.player.Position;
        for(const g of this.groups){
            // Drop members whose entities despawned (corpse removal) so distances stay honest.
            let nearestSq = Infinity, anyAlive = false;
            for(const m of g.members){
                if(m.controller.dead){ continue; }
                anyAlive = true;
                const d2 = this.tempVec.copy(m.entity.Position).sub(p).lengthSq();
                if(d2 < nearestSq){ nearestSq = d2; }
            }
            if(!anyAlive){ continue; }

            if(!g.active && nearestSq <= this.activateSq){
                this._SetGroupActive(g, true);
            }else if(g.active && nearestSq >= this.deactivateSq && this.time >= g.stayUntil){
                this._SetGroupActive(g, false);
            }
        }
    }

    Update(t){
        this.time += t;
        this.checkTimer -= t;
        if(this.checkTimer > 0){ return; }
        this.checkTimer = this.checkInterval;
        this._Evaluate();
    }
}
