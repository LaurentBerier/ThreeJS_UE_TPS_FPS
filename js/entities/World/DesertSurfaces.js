import * as THREE from 'three'
import Component from '../../Component.js'
import { gradeStructure, gradeGround, forEachMaterial } from './DesertLook.js'
import { GetDetailMask } from './JourneyWorld.js'


// Re-dresses the level that is already there.
//
// This is the component that does the "transform the existing geometry" half of the overhaul, and
// it does it without transforming any geometry at all — every corridor, sightline, cover position,
// entrance and exit is defined by vertices and convex hulls that this file never touches. It only
// swaps what those surfaces are MADE of.
//
// The level is a container depot: 70 boxes sharing three materials (white / blue / yellow) plus a
// concrete floor that the heightfield terrain already replaced. Those three materials become three
// weathered families, and keeping them distinct is a gameplay decision, not a decorative one —
// players navigate this level by container colour, so flattening all 70 into one grey would quietly
// damage wayfinding even though nothing moved.
//
// Runs on the Level entity after LevelSetup and Terrain, so both are built by the time it looks
// for them.
const FAMILY_BY_MATERIAL = {
    // 41 grey containers — the level's bulk. Scorched, sand-scoured concrete: the neutral mass
    // everything else reads against.
    WhiteContMat:  'concrete',
    // 25 blue containers. Blackened, oxidised steel — the darkest family, used for the stacked
    // upper tiers where a heavy silhouette against the sky is wanted.
    BlueContMat:   'steel',
    // 6 yellow containers. Rusted bronze, the warmest and rarest family — they survive as accents
    // exactly where the original level used yellow to mark a landmark stack.
    YellowContMat: 'bronze',
}

export default class DesertSurfaces extends Component{
    // groundTex: the seamless desert-hardpan photo (preloaded in entry.js). Optional — without it
    // the ground falls back to the purely procedural sand it had before.
    // renderer: only ever read for getMaxAnisotropy(). This ground is viewed almost entirely at a
    // grazing angle under a 15-degree sun, which is the exact case trilinear filtering handles
    // worst: without anisotropy the texture smears to a flat blur a few metres out and the whole
    // point of adding it is lost.
    // rugged: { albedo, normal, ctrl, meta } — the erosion bake's world-mapped sheets (see
    // tools/terrain_prep + DesertLook). Optional; the detail-weight mask that completes the
    // bundle is fetched from JourneyWorld here, because it is born with the terrain heights.
    constructor(groundTex = null, renderer = null, rugged = null){
        super()
        this.name = 'DesertSurfaces'
        this.graded = 0
        this.groundTex = groundTex
        this.renderer = renderer
        this.rugged = rugged
    }

    Initialize(){
        this.GradeTerrain()
        this.GradeStructures()
    }

    GradeTerrain(){
        const terrain = this.GetComponent('Terrain')
        if(!terrain || !terrain.mesh){ return }
        // The heightfield's vertex buffer is shared 1:1 with its Ammo collider, so the material is
        // the only safe thing to change here — and the only thing that needs changing. The dune
        // ripples it gains are a normal perturbation in the shader; the surface the player walks on,
        // the foot IK samples and the camera boom sweeps against is byte-identical to before.
        gradeGround(terrain.mesh.material, this._PrepareGroundTexture(), this._PrepareRugged())
        terrain.mesh.material.needsUpdate = true
    }

    // Configure the erosion bake's sheets for world-space sampling. All four are ONE sheet over
    // the 640 m world, flipY OFF so v=(z+half)/size lands on the bake's row convention, and NO
    // colour-space tagging — the albedo's sRGB decode is hand-rolled in GLSL (like the ground
    // photo) and the normal/ctrl sheets are data, not colour. Wrap is MIRRORED repeat: inside the
    // world square uv never leaves [0,1] so this is identical to clamp for the near ground, and it
    // lets FarWorld sample the SAME sheets past the fence with the same fold JourneyWorld's
    // RugDetailTiled applies to the geometry — far texture and far relief stay registered.
    _PrepareRugged(){
        const r = this.rugged
        if(!r || !r.albedo || !r.normal || !r.ctrl){ return null }
        const aniso = this.renderer ? this.renderer.capabilities.getMaxAnisotropy() : 1
        for(const t of [r.albedo, r.normal, r.ctrl, r.ero]){
            if(!t){ continue }              // ero is optional — the bundle works without it
            t.wrapS = t.wrapT = THREE.MirroredRepeatWrapping
            t.flipY = false
            t.anisotropy = aniso
            t.needsUpdate = true
        }
        if(!r.mask){
            // The per-cell detail weight JourneyWorld recorded while compositing the heights.
            // 257 is not a power of two, so mips are off and filtering stays linear — the mask is
            // a smooth field, it needs no minification chain.
            const m = GetDetailMask()
            const tex = new THREE.DataTexture(m.data, m.n, m.n, THREE.LuminanceFormat, THREE.UnsignedByteType)
            tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
            tex.minFilter = THREE.LinearFilter
            tex.magFilter = THREE.LinearFilter
            tex.generateMipmaps = false
            // 257 px × 1 byte rows are not 4-byte aligned; the default UNPACK_ALIGNMENT of 4
            // would shear every row of the upload.
            tex.unpackAlignment = 1
            tex.needsUpdate = true
            r.mask = tex
        }
        return r
    }

    // The texture is sampled from a plain uniform rather than being hung on material.map, because
    // the heightfield geometry has NO uv attribute (Terrain._buildMesh writes position + index
    // only) — gradeGround derives its own coordinates from world XZ instead. Two consequences:
    // RepeatWrapping is mandatory (the world is ~1584 m across at a ~3 m tile), and the sRGB
    // decode has to happen in GLSL by hand, since three only generates a decode for maps it knows
    // about. So the texture is deliberately left at the default LinearEncoding here — tagging it
    // sRGB would do nothing but mislead the next reader.
    _PrepareGroundTexture(){
        const tex = this.groundTex
        if(!tex){ return null }
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping
        tex.anisotropy = this.renderer ? this.renderer.capabilities.getMaxAnisotropy() : 1
        tex.needsUpdate = true
        return tex
    }

    GradeStructures(){
        const level = this.GetComponent('LevelSetup')
        if(!level || !level.mesh){ return }

        forEachMaterial(level.mesh, (mat) => {
            const family = FAMILY_BY_MATERIAL[mat.name]
            if(!family){ return }
            gradeStructure(mat, family)
            this.graded++
        })
    }
}
