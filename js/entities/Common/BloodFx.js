import * as THREE from 'three'
import Component from '../../Component.js'


// Pooled blood-splatter burst, shared by every combatant. A single instance lives on the Level
// entity; the enemy controllers and PlayerHealth fetch it (FindEntity('Level').GetComponent('BloodFx'))
// and call Emit() at the bullet's hit point when something takes a ranged hit.
//
// It's a fixed ring-buffer pool of billboarded sprites with PER-SPRITE materials (so each droplet
// fades on its own), a procedurally-generated soft radial dot for the texture (no art asset needed),
// and a tiny verlet-free particle step (velocity + gravity, opacity + size over life). Cheap and
// self-contained: nothing to dispose beyond the sprites, and a burst that outruns the pool simply
// recycles the oldest droplets — there is no unbounded growth.
export default class BloodFx extends Component{
    constructor(scene, { poolSize = 96 } = {}){
        super();
        this.name = 'BloodFx';
        this.scene = scene;
        this.gravity = -11.0;                 // droplets arc and fall
        this.texture = this._makeTexture();

        // Particle pool. Each entry owns its sprite + a per-instance material (individual opacity).
        this.pool = [];
        this.cursor = 0;
        for(let i = 0; i < poolSize; i++){
            const mat = new THREE.SpriteMaterial({
                map: this.texture,
                color: 0x8a0008,             // dark arterial red
                transparent: true,
                depthWrite: false,
                opacity: 0,
            });
            const sprite = new THREE.Sprite(mat);
            sprite.visible = false;
            sprite.scale.setScalar(0.1);
            sprite.renderOrder = 998;
            this.scene.add(sprite);
            this.pool.push({ sprite, life: 0, maxLife: 1, size: 0.1, grow: 0, vel: new THREE.Vector3() });
        }

        this._dir = new THREE.Vector3();
        this._rnd = new THREE.Vector3();
    }

    // Crisp round droplet: a near-SOLID white core (the sprite material tints it red) with only a thin
    // soft edge, so it reads as a sharp blood speck rather than a blurry blob. The per-particle opacity
    // still fades the whole droplet cleanly.
    _makeTexture(){
        const s = 64;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = s;
        const ctx = canvas.getContext('2d');
        const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
        g.addColorStop(0.0, 'rgba(255,255,255,1)');
        g.addColorStop(0.72, 'rgba(255,255,255,1)');    // solid core out to ~72% — much less blur
        g.addColorStop(0.9, 'rgba(255,255,255,0.65)');
        g.addColorStop(1.0, 'rgba(255,255,255,0)');     // thin antialiased edge only
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(s / 2, s / 2, s / 2, 0, Math.PI * 2);
        ctx.fill();
        const tex = new THREE.CanvasTexture(canvas);
        return tex;
    }

    // Spray a burst of droplets from world-space `point`, biased along `dir` (the bullet's travel
    // direction — the spray mostly continues that way, like an exit splatter) with a wide random cone
    // and an upward pop, then gravity pulls them down. `opts.scale` sizes it up for big targets (beast).
    Emit(point, dir = null, opts = {}){
        const count = opts.count ?? 14;
        const speed = opts.speed ?? 3.4;
        const spread = opts.spread ?? 0.85;   // 0 = a tight jet along dir, 1 = nearly omnidirectional
        const scale = opts.scale ?? 1.0;
        const life = opts.life ?? 0.5;

        const base = this._dir;
        if(dir && dir.lengthSq() > 1e-6){ base.copy(dir).normalize(); }
        else{ base.set(0, 0, 0); }

        for(let i = 0; i < count; i++){
            const p = this.pool[this.cursor];
            this.cursor = (this.cursor + 1) % this.pool.length;

            // Random unit vector, blended toward the bullet direction by (1 - spread), plus an up pop.
            this._rnd.set(Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1);
            if(this._rnd.lengthSq() < 1e-6){ this._rnd.set(0, 1, 0); }
            this._rnd.normalize().multiplyScalar(spread).add(base);
            if(this._rnd.lengthSq() < 1e-6){ this._rnd.set(0, 1, 0); }
            this._rnd.normalize();

            p.vel.copy(this._rnd).multiplyScalar(speed * (0.45 + Math.random() * 0.85));
            p.vel.y += 1.4 + Math.random() * 0.8;    // initial upward pop so it sprays then falls

            p.life = life * (0.7 + Math.random() * 0.6);
            p.maxLife = p.life;
            // Smaller droplets (finer spray) that barely grow, so the splatter reads as crisp specks.
            p.size = (0.02 + Math.random() * 0.035) * scale;
            p.grow = (0.04 + Math.random() * 0.08) * scale;

            const sp = p.sprite;
            sp.position.copy(point);
            sp.scale.setScalar(p.size);
            sp.material.opacity = 0.95;
            sp.visible = true;
        }
    }

    Update(t){
        if(t > 0.1){ t = 0.1; }           // clamp a hitch so droplets don't teleport
        for(const p of this.pool){
            const sp = p.sprite;
            if(!sp.visible){ continue; }
            p.life -= t;
            if(p.life <= 0){ sp.visible = false; sp.material.opacity = 0; continue; }
            p.vel.y += this.gravity * t;
            sp.position.addScaledVector(p.vel, t);
            const k = p.life / p.maxLife;             // 1 -> 0 over the droplet's life
            sp.material.opacity = Math.min(1, k * 1.5);   // hold opaque, then fade out near the end
            sp.scale.setScalar(p.size + (1 - k) * p.grow);
        }
    }

    Dispose(){
        for(const p of this.pool){
            this.scene.remove(p.sprite);
            p.sprite.material.dispose();
        }
        this.texture.dispose();
        this.pool.length = 0;
    }
}
