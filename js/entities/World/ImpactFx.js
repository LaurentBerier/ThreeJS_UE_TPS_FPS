import * as THREE from 'three'
import Component from '../../Component.js'
import { PALETTE, GLSL_ENCODE, sunDirection } from './DesertLook.js'


// Combat VFX: impact dust, sparks, stone chips, footstep puffs, and a muzzle flash that briefly
// lights the surfaces around the shooter.
//
// NOTHING HERE TOUCHES COMBAT. It reads events the game already broadcasts — the 'hit' the Level
// entity receives when a bullet lands on it, and the 'weapon.shoot' the player broadcasts on every
// round — and draws something. No damage value, fire rate, spread, raycast, hitbox or timing is
// read, written, or delayed by any of this. If this whole component were deleted the game would
// play identically.
//
// One pooled buffer, one draw call, zero allocation after startup. Particles are simulated
// ENTIRELY in the vertex shader from a birth time and a velocity, so a burst costs one small
// buffer write and nothing per frame afterwards — there is no CPU particle loop to show up in the
// frame budget during a firefight.
const POOL = 520

const KIND_DUST = 0.0     // warm sand puff: expands, rises, drags to a stop
const KIND_SPARK = 1.0    // hot metal spark: fast, ballistic, short-lived
const KIND_CHIP = 2.0     // stone/concrete fragment: ballistic, dark, no glow


export default class ImpactFx extends Component{
    constructor(scene, camera){
        super()
        this.name = 'ImpactFx'
        this.scene = scene
        this.camera = camera
        this.time = 0
        this.cursor = 0
        this.sunDir = sunDirection()

        // Lazily resolved on first use — the Player entity initialises after the Level entity.
        this._controls = null
        this._weapons = null
        this._footTimer = 0
    }

    Initialize(){
        this._buildPool()
        this._buildMuzzleLight()

        // Bullets landing on the level. The Level entity already receives this for its bullet
        // decals; hanging the VFX off the same event means impacts and decals can never disagree
        // about where a round hit.
        this.parent.RegisterEventHandler(this.OnHit, 'hit')

        // Every shot the player fires, for the muzzle flash light.
        const player = this.FindEntity('Player')
        if(player){ player.RegisterEventHandler(this.OnShoot, 'weapon.shoot') }
    }

    _buildPool(){
        const g = new THREE.BufferGeometry()
        const pos = new Float32Array(POOL * 3)
        const vel = new Float32Array(POOL * 3)
        const par = new Float32Array(POOL * 4)      // birth, life, size, kind
        const col = new Float32Array(POOL * 3)
        // Park the pool far below the world with life 0 so nothing draws until it is spawned.
        for(let i = 0; i < POOL; i++){ par[i * 4 + 1] = 0 }

        g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
        g.setAttribute('vel', new THREE.BufferAttribute(vel, 3))
        g.setAttribute('par', new THREE.BufferAttribute(par, 4))
        g.setAttribute('col', new THREE.BufferAttribute(col, 3))
        // A fixed, generous bound: the pool is written on the GPU timeline, so three cannot compute
        // a meaningful bounding sphere from the buffer and would cull the whole system at random.
        g.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 30, 0), 900)

        const mat = new THREE.ShaderMaterial({
            transparent: true,
            depthWrite: false,
            depthTest: true,
            blending: THREE.NormalBlending,
            fog: false,
            uniforms: { uTime: { value: 0 } },
            vertexShader: /* glsl */`
                attribute vec3 vel;
                attribute vec4 par;      // x birth, y life, z size, w kind
                attribute vec3 col;
                uniform float uTime;
                varying vec3 vCol;
                varying float vAlpha;
                varying float vKind;

                void main(){
                    float age = uTime - par.x;
                    float life = par.y;
                    vKind = par.w;

                    if(life <= 0.0 || age < 0.0 || age > life){
                        // Retired: collapse to a degenerate point off-screen.
                        gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
                        gl_PointSize = 0.0;
                        vAlpha = 0.0;
                        return;
                    }

                    float t = age / life;
                    vec3 p = position;

                    if(par.w < 0.5){
                        // Dust: strong initial push that drags to a halt, then buoyant drift up.
                        float drag = 1.0 - exp(-age * 3.2);
                        p += vel * drag * 0.31;
                        p.y += age * 0.55 * (1.0 - t * 0.4);
                    }else{
                        // Sparks and chips: ballistic.
                        p += vel * age;
                        p.y -= 4.9 * age * age;
                    }

                    vec4 mv = modelViewMatrix * vec4(p, 1.0);
                    float dist = max(-mv.z, 0.05);

                    // Dust expands as it disperses; debris stays the size it started.
                    float grow = (par.w < 0.5) ? (0.45 + t * 2.3) : 1.0;
                    gl_PointSize = clamp(par.z * grow * 620.0 / dist, 1.0, 190.0);

                    // Dust fades in fast and out slowly; debris just fades out.
                    vAlpha = (par.w < 0.5)
                        ? smoothstep(0.0, 0.08, t) * (1.0 - smoothstep(0.25, 1.0, t))
                        : (1.0 - t) * (1.0 - t);

                    vCol = col;
                    gl_Position = projectionMatrix * mv;
                }
            `,
            fragmentShader: /* glsl */`
                varying vec3 vCol;
                varying float vAlpha;
                varying float vKind;
                ${GLSL_ENCODE}
                void main(){
                    vec2 d = gl_PointCoord - 0.5;
                    float r2 = dot(d, d);
                    if(r2 > 0.25){ discard; }
                    float a = vAlpha;
                    if(vKind < 0.5){
                        // Soft, cloudy falloff for dust.
                        a *= (1.0 - r2 * 4.0);
                        a *= 0.5;
                    }else{
                        // Hard little dot for sparks and chips.
                        a *= smoothstep(0.25, 0.05, r2);
                    }
                    gl_FragColor = vec4(dl_toLinear(vCol), clamp(a, 0.0, 1.0));
                }
            `,
        })

        const pts = new THREE.Points(g, mat)
        pts.frustumCulled = false
        pts.renderOrder = 10
        pts.userData.noExport = true
        this.points = pts
        this.mat = mat
        this.geo = g
        this.scene.add(pts)
    }

    // A short, bright point light at the muzzle. This is the "muzzle flashes that briefly
    // illuminate nearby surfaces" bit — the existing flash card is unlit geometry and throws no
    // light on the world. Matches the light the AI soldiers already carry (UeSoldierController),
    // so the player and the enemies now light the level the same way when they fire.
    _buildMuzzleLight(){
        this.muzzleLight = new THREE.PointLight(0xffcf92, 0.0, 9.0, 2.0)
        this.muzzleLight.castShadow = false
        this.muzzleLight.userData.noExport = true
        this.scene.add(this.muzzleLight)
        this._muzzleLife = 0
    }

    // Write one particle into the pool at the rotating cursor.
    _emit(px, py, pz, vx, vy, vz, life, size, kind, color){
        const i = this.cursor
        this.cursor = (this.cursor + 1) % POOL
        const pos = this.geo.attributes.position.array
        const vel = this.geo.attributes.vel.array
        const par = this.geo.attributes.par.array
        const col = this.geo.attributes.col.array
        pos[i * 3] = px; pos[i * 3 + 1] = py; pos[i * 3 + 2] = pz
        vel[i * 3] = vx; vel[i * 3 + 1] = vy; vel[i * 3 + 2] = vz
        par[i * 4] = this.time; par[i * 4 + 1] = life; par[i * 4 + 2] = size; par[i * 4 + 3] = kind
        col[i * 3] = color.r; col[i * 3 + 1] = color.g; col[i * 3 + 2] = color.b
        this._dirty = true
    }

    // A bullet landed on the level. Spray dust along the surface normal, plus material-appropriate
    // debris — sparks off metal, chips off stone.
    OnHit = (e) => {
        if(!e || !e.hitResult){ return }
        const p = e.hitResult.intersectionPoint
        const n = e.hitResult.intersectionNormal
        if(!p || !n){ return }
        this.Impact(p.x, p.y, p.z, n.x, n.y, n.z)
    }

    // Public so anything else (an explosion, a melee hit) can trigger the same burst.
    Impact(px, py, pz, nx, ny, nz, scale = 1){
        const dust = PALETTE.dust
        const spark = PALETTE.sun
        const chip = PALETTE.stoneDark

        // Dust cone along the surface normal.
        for(let i = 0; i < 7; i++){
            const s = 1.6 * scale
            this._emit(
                px + (Math.random() - 0.5) * 0.12,
                py + (Math.random() - 0.5) * 0.12,
                pz + (Math.random() - 0.5) * 0.12,
                nx * s + (Math.random() - 0.5) * 1.5,
                ny * s + (Math.random() - 0.5) * 1.5 + 0.5,
                nz * s + (Math.random() - 0.5) * 1.5,
                0.55 + Math.random() * 0.5,
                0.05 + Math.random() * 0.055,
                KIND_DUST, dust,
            )
        }
        // Sparks — the hot, fast read that says "this hit something hard".
        for(let i = 0; i < 5; i++){
            const s = 4.5 * scale
            this._emit(px, py, pz,
                nx * s * 0.6 + (Math.random() - 0.5) * s,
                ny * s * 0.6 + Math.random() * s * 0.8,
                nz * s * 0.6 + (Math.random() - 0.5) * s,
                0.18 + Math.random() * 0.22,
                0.012 + Math.random() * 0.012,
                KIND_SPARK, spark)
        }
        // Fragments.
        for(let i = 0; i < 4; i++){
            const s = 3.2 * scale
            this._emit(px, py, pz,
                nx * s * 0.5 + (Math.random() - 0.5) * s,
                ny * s * 0.5 + Math.random() * s * 0.7,
                nz * s * 0.5 + (Math.random() - 0.5) * s,
                0.5 + Math.random() * 0.45,
                0.014 + Math.random() * 0.016,
                KIND_CHIP, chip)
        }
    }

    // The player fired. Pulse the muzzle light.
    OnShoot = () => {
        this._muzzleLife = 0.055
    }

    // Sand kicked up under a running player.
    _footDust(pos){
        const dust = PALETTE.dust
        for(let i = 0; i < 3; i++){
            this._emit(
                pos.x + (Math.random() - 0.5) * 0.35,
                pos.y - 0.85,
                pos.z + (Math.random() - 0.5) * 0.35,
                (Math.random() - 0.5) * 0.8, 0.25 + Math.random() * 0.4, (Math.random() - 0.5) * 0.8,
                0.6 + Math.random() * 0.35,
                0.06 + Math.random() * 0.05,
                KIND_DUST, dust)
        }
    }

    Update(t){
        this.time += t
        this.mat.uniforms.uTime.value = this.time

        if(this._dirty){
            this.geo.attributes.position.needsUpdate = true
            this.geo.attributes.vel.needsUpdate = true
            this.geo.attributes.par.needsUpdate = true
            this.geo.attributes.col.needsUpdate = true
            this._dirty = false
        }

        // --- Muzzle light. Parked at the in-hand gun's muzzle anchor while lit, intensity 0 the
        // rest of the time so it costs nothing in the shader's light loop budget.
        if(this._muzzleLife > 0){
            this._muzzleLife = Math.max(0, this._muzzleLife - t)
            const wm = this._weaponManager()
            if(wm && wm.muzzleAnchor){
                wm.muzzleAnchor.getWorldPosition(this.muzzleLight.position)
                this.muzzleLight.intensity = 9.0 * (this._muzzleLife / 0.055)
            }else{
                this.muzzleLight.intensity = 0
            }
        }else if(this.muzzleLight.intensity !== 0){
            this.muzzleLight.intensity = 0
        }

        // --- Footstep dust, on a cadence that tracks stride speed.
        const pc = this._playerControls()
        if(pc && pc.IsGrounded){
            const speed = pc.HorizontalSpeed || 0
            if(speed > 1.2){
                this._footTimer -= t * speed
                if(this._footTimer <= 0){
                    this._footTimer = 2.4
                    this._footDust(pc.parent.Position)
                }
            }else{
                this._footTimer = 0
            }
        }
    }

    _playerControls(){
        if(this._controls){ return this._controls }
        const p = this.FindEntity('Player')
        this._controls = p ? p.GetComponent('PlayerControls') : null
        return this._controls
    }

    _weaponManager(){
        if(this._weapons){ return this._weapons }
        const p = this.FindEntity('Player')
        this._weapons = p ? p.GetComponent('WeaponManager') : null
        return this._weapons
    }

    Dispose(){
        if(this.points){ this.scene.remove(this.points); this.geo.dispose(); this.mat.dispose() }
        if(this.muzzleLight){ this.scene.remove(this.muzzleLight) }
    }
}
