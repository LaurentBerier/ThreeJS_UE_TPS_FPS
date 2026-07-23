import * as THREE from 'three'
import Component from '../../Component.js'
import { gradeStructure, gradeGround, forEachMaterial } from './DesertLook.js'


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
    constructor(){
        super()
        this.name = 'DesertSurfaces'
        this.graded = 0
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
        gradeGround(terrain.mesh.material)
        terrain.mesh.material.needsUpdate = true
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
