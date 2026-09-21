import Component from '../../Component.js'

// ---------------------------------------------------------------------------------------------
// UI MANAGER — HUD readouts + the campaign overlays.
//
// Original readouts (ammo / health / weapon name / reticle / damage vignette) unchanged. Added
// for the journey's goal/progression layer (see JourneyProgress.js, which drives everything new):
//
//   * #objective        — the current goal line (top-centre): where to go / what's left to kill;
//   * #journey_bar      — the route-progress bar + metres remaining to the citadel;
//   * #toast            — transient event announcements (CONTACT / AREA CLEAR / boss wake);
//   * #finale           — the victory overlay (boss down): stats + restart;
//   * #death            — the defeat overlay (health reached 0): stats + restart.
//
// The overlays are DOM + CSS only. Restart reloads the page, which is exactly a fresh NEW GAME
// (assets are browser-cached, so it lands on the menu instantly) — no engine state to unwind.
// ---------------------------------------------------------------------------------------------
export default class UIManager extends Component{
    constructor(){
        super();
        this.name = 'UIManager';
        this._toastTimer = null;
        this._lastHealth = 100;
    }

    SetAmmo(mag, rest){
        document.getElementById("current_ammo").innerText = mag;
        document.getElementById("max_ammo").innerText = (rest === Infinity) ? '∞' : rest;
    }

    SetHealth(health){
        document.getElementById("health_progress").style.width = `${health}%`;
        // Defeat: the health readout is the one place every damage path already reports through,
        // so the death overlay keys off it crossing zero (idempotent — health clamps at 0).
        if(health <= 0 && this._lastHealth > 0){ this.ShowDeath(); }
        this._lastHealth = health;
    }

    SetWeaponName(name){
        document.getElementById("weapon_name").innerText = name;
    }

    // Quick red screen vignette when the player is hit. Snap to a strong tint with the transition
    // disabled, then re-enable it and fade back to clear next frame so it pulses cleanly even on
    // rapid consecutive hits (each call restarts the pulse).
    FlashDamage(){
        const el = document.getElementById("blood_overlay");
        if(!el){ return; }
        el.style.transition = 'none';
        el.style.opacity = '0.8';
        requestAnimationFrame(() => {
            el.style.transition = 'opacity 0.6s ease';
            el.style.opacity = '0';
        });
    }

    // Set the on-screen reticle SPREAD (centre-to-tick gap, in vw). Driven by WeaponManager so the
    // reticle opens up for hipfire and tightens when aiming / blooms a touch while firing. Only the gap
    // changes — the tick thickness/length are fixed in CSS, so the outline weight is constant.
    SetReticleSize(vw){
        const el = document.getElementById("crosshair");
        if(el){ el.style.setProperty('--reticle-gap', `${vw}vw`); }
    }

    // Toggle the reticle's ADS "lock" look (hot amber, tightened frame, faster scanner ring). Driven
    // by WeaponManager alongside SetReticleSize so the crosshair visibly engages when aiming.
    SetReticleAiming(on){
        const el = document.getElementById("crosshair");
        if(el){ el.classList.toggle('aiming', !!on); }
    }

    // ---- Journey campaign layer (driven by JourneyProgress) ------------------------------------

    // The current goal line. `alert` swaps the calm cyan for a hot amber while hostiles remain.
    SetObjective(text, alert = false){
        const el = document.getElementById('objective');
        if(!el){ return; }
        if(el.innerText !== text){ el.innerText = text; }
        el.classList.toggle('alert', !!alert);
    }

    // Route progress: fraction 0..1 across the authored spine + metres remaining to the citadel.
    SetJourneyProgress(frac, remainMetres){
        const fill = document.getElementById('journey_fill');
        if(fill){ fill.style.width = `${(Math.max(0, Math.min(1, frac)) * 100).toFixed(1)}%`; }
        const dist = document.getElementById('journey_dist');
        if(dist && dist.dataset.m !== String(remainMetres)){
            dist.dataset.m = String(remainMetres);
            dist.innerText = `${remainMetres} m`;
        }
    }

    // Transient announcement (CONTACT / AREA CLEAR / ...). Re-triggering restarts the fade timer.
    ShowToast(text, holdMs = 2200){
        const el = document.getElementById('toast');
        if(!el){ return; }
        el.innerText = text;
        el.classList.add('show');
        if(this._toastTimer){ clearTimeout(this._toastTimer); }
        this._toastTimer = setTimeout(() => el.classList.remove('show'), holdMs);
    }

    // Victory overlay — the citadel finale. Stats: journey time + hostiles eliminated.
    ShowFinale(stats){
        const el = document.getElementById('finale');
        if(!el){ return; }
        const t = document.getElementById('finale_time');
        const k = document.getElementById('finale_kills');
        if(t && stats){ t.innerText = stats.time; }
        if(k && stats){ k.innerText = String(stats.kills); }
        el.classList.add('show');
    }

    // Defeat overlay.
    ShowDeath(){
        const el = document.getElementById('death');
        if(!el){ return; }
        const t = document.getElementById('death_time');
        if(t){
            const s = Math.floor(this._journeyTime || 0);
            t.innerText = `${Math.floor(s / 60)}:${s % 60 < 10 ? '0' : ''}${s % 60}`;
        }
        el.classList.add('show');
    }

    // JourneyProgress hands its clock over so the death overlay can show the same journey time.
    SetJourneyTime(sec){ this._journeyTime = sec; }

    Initialize(){
        document.getElementById("game_hud").style.visibility = 'visible';
    }
}
