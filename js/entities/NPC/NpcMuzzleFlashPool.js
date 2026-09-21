import * as THREE from 'three'

// Shared muzzle-flash POINT LIGHTS for all AI soldiers.
//
// WHY a pool: each soldier used to own a PointLight it toggled `.visible` per shot. In three
// r127 the renderer's program cache keys on the number of VISIBLE lights, so every first
// occurrence of a new "N flashes at once" count recompiled every material in view — the huge
// terrain/ground shader included — a hard hitch right in the middle of a firefight (one of the
// main "stutters when the enemy AI attacks" sources). The pool keeps a FIXED set of lights in
// the scene, always visible at intensity 0, so the visible-light count never changes; a shot
// just parks a light at the muzzle and spikes its intensity for ~60 ms. This is exactly the
// pattern ImpactFx already uses for the player's own muzzle light.
//
// Two lights cover overlapping flashes (60 ms flash vs a 0.7 s per-soldier cadence — three
// simultaneous flashes are effectively impossible); if it ever happens, the oldest is stolen,
// which is imperceptible at flash timescales.
const POOL_LIGHTS = 2;

class NpcMuzzleFlashPool{
    constructor(scene){
        this.lights = [];
        for(let i = 0; i < POOL_LIGHTS; i++){
            const l = new THREE.PointLight(0xffd08a, 0.0, 7.0, 2.0);
            l.castShadow = false;
            l.userData.held = false;
            l.userData.stamp = 0;
            scene.add(l);
            this.lights.push(l);
        }
        this._stamp = 0;
    }

    // Re-parent the lights into the CURRENT scene. A game restart calls scene.clear(), which
    // strips them; every soldier calls this during Initialize (behind the loading screen), so
    // the visible-light count is stable again before the first gameplay frame renders.
    EnsureInScene(scene){
        for(const l of this.lights){
            if(l.parent !== scene){ scene.add(l); }
        }
    }

    // Borrow a light parked at `pos`. The caller drives its intensity while the flash lives and
    // MUST hand it back through Release (Release is idempotent and null-safe).
    Acquire(pos){
        let pick = null;
        for(const l of this.lights){
            if(!l.userData.held){ pick = l; break; }
        }
        if(!pick){
            pick = this.lights[0];
            for(const l of this.lights){
                if(l.userData.stamp < pick.userData.stamp){ pick = l; }
            }
        }
        pick.userData.held = true;
        pick.userData.stamp = ++this._stamp;
        pick.position.copy(pos);
        return pick;
    }

    Release(light){
        if(!light){ return; }
        light.intensity = 0.0;
        light.userData.held = false;
    }
}

// One pool per app lifetime, revived into the live scene on demand (see EnsureInScene).
let _pool = null;
export function GetNpcMuzzleFlashPool(scene){
    if(!_pool){ _pool = new NpcMuzzleFlashPool(scene); }
    else{ _pool.EnsureInScene(scene); }
    return _pool;
}
