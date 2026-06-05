// Lightweight AI relationship system. Every combatant belongs to a faction, and
// hostility between factions decides who an agent is willing to attack:
//
//   * PLAYER  — you. Not an AI; never auto-selects targets.
//   * ENEMY   — the standard hostile. Hunts the PLAYER, but treats a CHAOTIC as the
//               bigger threat and will shoot one that gets near (see target priority
//               in UeSoldierController.AcquireTarget). Ignores other enemies / neutrals.
//   * CHAOTIC — aggressive chaotic: attacks EVERYONE (player, enemies, neutrals, and
//               even other chaotics). The wildcard that makes the arena a free-for-all.
//   * NEUTRAL — passive. Attacks no one until provoked, then retaliates against whoever
//               hit it (handled in TakeHit).
export const Faction = {
    PLAYER:  'player',
    ENEMY:   'enemy',
    CHAOTIC: 'chaotic',
    NEUTRAL: 'neutral',
};

// Would an agent of faction `from` attack a target of faction `to`?
export function isHostile(from, to){
    if(!from || !to){ return false; }
    switch(from){
        case Faction.CHAOTIC: return true;                                   // everyone, no exceptions
        case Faction.ENEMY:   return to === Faction.PLAYER || to === Faction.CHAOTIC;
        default:              return false;                                  // neutral / player: passive
    }
}
