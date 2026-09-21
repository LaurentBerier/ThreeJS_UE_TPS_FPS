import * as THREE from 'three'
import Component from '../../Component.js'
import { SPINE, SPAWNS } from '../World/JourneyWorld.js'

// ---------------------------------------------------------------------------------------------
// JOURNEY PROGRESS — the goal/progression wiring over the authored level.
//
// The journey level already owns its layout, spawns and triggers (JourneyWorld -> Terrain ->
// Structures -> NavmeshGen, encounters woken by AiDirector). What it didn't own was any READABLE
// campaign layer: the player was never told where they were on the ~800 m route, an encounter
// waking or clearing was invisible, and the game had no finish — killing the summit boss changed
// nothing on screen, and dying was a silent 0 HP bar.
//
// This component is the thin read-only layer that closes those gaps. It owns NO gameplay: it
// polls (at 4 Hz) state that already exists and surfaces it —
//
//   * ROUTE PROGRESS: the player is projected onto the authored SPINE polyline (the same data the
//     terrain was built from), giving a 0..1 journey fraction for the HUD bar and a remaining
//     route distance to the citadel;
//   * ENCOUNTER STATES: the AiDirector's encounter groups are watched for the dormant -> engaged
//     -> cleared transitions, announced as HUD toasts ("CONTACT", "AREA CLEAR") and summarised in
//     the objective line while a fight is live;
//   * THE GOAL: when the boss's group clears, the finale overlay fires (after a short beat so the
//     ragdoll reads) with journey time + kill count and a restart button;
//   * DEFEAT: UIManager.SetHealth(0) shows the death overlay (see UIManager).
//
// Nothing here mutates AI, physics or level state, so it can be removed without a trace.
// ---------------------------------------------------------------------------------------------
export default class JourneyProgress extends Component{
    constructor(){
        super();
        this.name = 'JourneyProgress';
        this.sweepInterval = 0.25;      // seconds between polls (matches AiDirector's cadence)
        this._timer = 0;
        this.time = 0;                  // journey clock, for the finale stats
        this.victory = false;
        this._finalePending = false;
    }

    Initialize(){
        this.player = this.FindEntity('Player');
        const directorEntity = this.FindEntity('AiDirector');
        this.director = directorEntity ? directorEntity.GetComponent('AiDirector') : null;
        this.uimanager = this.FindEntity('UIManager').GetComponent('UIManager');

        // Arc-length table over the authored spine (the same polyline the terrain corridor was
        // cut from). ~21 points — projection below is a brute-force walk, trivially cheap at 4 Hz.
        this.pts = SPINE.map(p => new THREE.Vector2(p.x, p.z));
        this.cum = [0];
        for(let i = 1; i < this.pts.length; i++){
            this.cum.push(this.cum[i - 1] + this.pts[i].distanceTo(this.pts[i - 1]));
        }
        this.totalArc = this.cum[this.cum.length - 1];

        // The boss is the LAST entry of entry.js's beastLocations (SPAWNS.beasts, then SPAWNS.boss),
        // named Mutant<i> in that order — so the boss entity's name is derivable, not hardcoded.
        this.bossName = `Mutant${SPAWNS.beasts.length}`;

        // Per-group state: 'dormant' | 'engaged' | 'cleared'. Seeded from the director's own
        // groups so this layer can never disagree with what actually wakes.
        this.groupState = new Map();
        if(this.director){
            for(const g of this.director.groups){ this.groupState.set(g, 'dormant'); }
        }

        this.uimanager.SetObjective('REACH THE CITADEL');
        this.uimanager.SetJourneyProgress(0, Math.round(this.totalArc));
    }

    // Nearest-point projection of (x,z) onto the spine polyline -> arc length from the start.
    _projectArc(x, z){
        let bestArc = 0, bestD2 = Infinity;
        for(let i = 0; i < this.pts.length - 1; i++){
            const a = this.pts[i], b = this.pts[i + 1];
            const abx = b.x - a.x, abz = b.y - a.y;
            const len2 = abx * abx + abz * abz;
            let t = ((x - a.x) * abx + (z - a.y) * abz) / len2;
            t = Math.max(0, Math.min(1, t));
            const px = a.x + abx * t, pz = a.y + abz * t;
            const dx = px - x, dz = pz - z;
            const d2 = dx * dx + dz * dz;
            if(d2 < bestD2){ bestD2 = d2; bestArc = this.cum[i] + Math.sqrt(len2) * t; }
        }
        return bestArc;
    }

    _onGroupEngaged(isBoss, alive){
        if(isBoss){
            this.uimanager.ShowToast('THE SUMMIT BEAST AWAKES', 3200);
        }else{
            this.uimanager.ShowToast(`CONTACT — ${alive} HOSTILE${alive > 1 ? 'S' : ''}`);
        }
    }

    _onGroupCleared(isBoss){
        if(isBoss && !this.victory && !this._finalePending){
            this._finalePending = true;
            // A short beat so the boss ragdoll settles and the last shot's VFX read before the
            // overlay fades in over them.
            setTimeout(() => this._showFinale(), 2600);
        }else if(!isBoss){
            this.uimanager.ShowToast('AREA CLEAR');
        }
    }

    _showFinale(){
        if(this.victory){ return; }
        this.victory = true;
        // Kills: every AI that reached `dead` across all encounter groups.
        let kills = 0;
        if(this.director){
            for(const g of this.director.groups){
                for(const m of g.members){ if(m.controller.dead){ kills++; } }
            }
        }
        const mins = Math.floor(this.time / 60), secs = Math.floor(this.time % 60);
        this.uimanager.ShowFinale({
            time: `${mins}:${secs < 10 ? '0' : ''}${secs}`,
            kills,
        });
    }

    Update(t){
        this.time += t;
        this._timer -= t;
        if(this._timer > 0){ return; }
        this._timer = this.sweepInterval;
        if(!this.director || !this.uimanager || !this.player){ return; }
        this.uimanager.SetJourneyTime(this.time);

        // --- Route progress -----------------------------------------------------------------
        const p = this.player.Position;
        const arc = this._projectArc(p.x, p.z);
        const frac = Math.min(1, arc / this.totalArc);
        const remain = Math.max(0, Math.round(this.totalArc - arc));
        this.uimanager.SetJourneyProgress(frac, remain);

        // --- Encounter states ----------------------------------------------------------------
        let engagedAlive = 0;
        for(const g of this.director.groups){
            let alive = 0, isBoss = false;
            for(const m of g.members){
                if(m.entity.Name === this.bossName){ isBoss = true; }
                if(!m.controller.dead){ alive++; }
            }
            const prev = this.groupState.get(g);
            if(alive === 0){
                if(prev !== 'cleared'){
                    this.groupState.set(g, 'cleared');
                    this._onGroupCleared(isBoss);
                }
            }else if(g.active){
                if(prev !== 'engaged'){
                    this.groupState.set(g, 'engaged');
                    this._onGroupEngaged(isBoss, alive);
                }
                engagedAlive += alive;
            }else if(prev === 'engaged'){
                // The fight drifted beyond the deactivate radius: back to dormant, so re-engaging
                // announces again (AiDirector's 90/125 m hysteresis keeps this from flickering).
                this.groupState.set(g, 'dormant');
            }
        }

        // --- Objective line -------------------------------------------------------------------
        if(!this.victory && !this._finalePending){
            if(engagedAlive > 0){
                this.uimanager.SetObjective(`HOSTILES — ${engagedAlive} REMAINING`, true);
            }else{
                this.uimanager.SetObjective('PUSH TOWARD THE CITADEL');
            }
        }
    }
}
