import * as THREE from 'three'
import Component from '../../Component.js'
import { PALETTE, gradeCharacter, forEachMaterial } from './DesertLook.js'


// Weathers the things that MOVE: the player, the soldiers, the beast, their weapons, and the ammo
// pickups.
//
// Everything here is a fragment-shader change to colour. No model, skeleton, bone, hitbox, clip,
// animation timing, movement speed, health value, faction or AI state is touched, and this
// component has no Update at all — it runs once at startup and then does nothing, so it cannot
// affect frame timing or any per-frame gameplay logic.
//
// Two jobs beyond dirt:
//
//   * RIM LIGHT. Added to outgoing light after shading, so it does not depend on where the sun is.
//     This is what satisfies "enemies must remain clearly visible in every lighting condition": a
//     soldier in the black shadow of a container, backlit by a 15-degree sun, still carries a warm
//     edge that separates them from whatever is behind them. Without it, darkening the containers
//     to charcoal would have cost real combat readability.
//
//   * CLASS DISTINCTION. Each enemy archetype gets its own rim colour and accent, so the two are
//     still instantly separable at a glance — the beast reads warm and huge, the soldiers read
//     cooler with sparse cyan tech glints. That is deliberately the world's ONLY cool emissive,
//     which is what makes it read as "technology" rather than decoration.
//
// Runs from its own entity added last in entry.js, so every character and pickup exists by the
// time it initialises.
export default class DesertActors extends Component{
    constructor(){
        super()
        this.name = 'DesertActors'
        this.graded = { player: 0, soldier: 0, beast: 0, pickup: 0, weapon: 0 }
    }

    Initialize(){
        const em = this.parent.parent          // EntityManager
        if(!em || !em.entities){ return }

        for(const entity of em.entities){
            const name = entity.Name || ''

            if(name === 'Player'){
                const body = entity.GetComponent('PlayerBody')
                if(body && body.model){
                    // Much weaker rim than the enemies get. The rim exists to keep ENEMIES legible
                    // against dark cover; the player always knows where they are, and the body
                    // avatar is drawn in first person too — so at enemy strength it put a hot white
                    // edge on the forearms directly under the lens.
                    this.graded.player += this._grade(body.model, {
                        key: 'player', rimColor: PALETTE.sun, rimStrength: 0.12,
                        dust: 0.6, dustTop: 1.3,
                    })
                }
                // First-person arms + viewmodel weapon: same dressing, weaker rim (they are always
                // right under the lens, so a strong rim would read as a glow).
                const hands = entity.GetComponent('Hands')
                if(hands && hands.model){
                    this.graded.weapon += this._grade(hands.model, {
                        key: 'hands', rimColor: PALETTE.sun, rimStrength: 0.16, dust: 0.25, dustTop: 3.0,
                    })
                }
            }else if(/UeSoldier/.test(name)){
                const c = entity.GetComponent('UeSoldierController')
                if(c && c.model){
                    // All five soldiers share one material set (SkeletonUtils clones share
                    // materials), so this grades the whole squad in one pass.
                    this.graded.soldier += this._grade(c.model, {
                        key: 'soldier', rimColor: PALETTE.sun, rimStrength: 0.55,
                        accent: PALETTE.techCyan, accentStrength: 0.5,
                        dust: 0.7, dustTop: 1.3,
                    })
                }
            }else if(/Mutant/.test(name)){
                const c = entity.GetComponent('CharacterController')
                if(c && c.model){
                    // The beast is 2x scale, so its dust line has to rise with it. Warmer, stronger
                    // rim and no cyan: nothing about it should read as equipped.
                    this.graded.beast += this._grade(c.model, {
                        key: 'beast', rimColor: PALETTE.sunDeep, rimStrength: 0.6,
                        dust: 0.85, dustTop: 2.6,
                    })
                }
            }else if(/AmmoBox/.test(name)){
                this._gradePickup(entity)
            }
        }
    }

    _grade(root, opts){
        let n = 0
        forEachMaterial(root, (mat) => {
            gradeCharacter(mat, opts)
            n++
        })
        return n
    }

    // Pickups have the opposite problem to enemies: they must NOT blend in. In a world graded to
    // charcoal and burnt orange, an ammo crate sitting in shadow becomes genuinely hard to spot, so
    // it gets the cyan tech accent as a real emissive — the one place the palette's "very limited
    // cyan-blue emissive technology" is doing a gameplay job rather than a decorative one.
    _gradePickup(entity){
        const box = entity.GetComponent('AmmoBox')
        const root = box && (box.mesh || box.model)
        if(!root){ return }
        forEachMaterial(root, (mat) => {
            gradeCharacter(mat, {
                key: 'pickup', rimColor: PALETTE.techCyan, rimStrength: 1.05,
                accent: PALETTE.techCyan, accentStrength: 0.35,
                dust: 0.55, dustTop: 0.9,
            })
            if(mat.emissive){
                mat.emissive.copy(PALETTE.techCyan)
                mat.emissiveIntensity = 0.22
            }
            this.graded.pickup++
        })
    }
}
