// Lightweight AI relationship system. Every combatant belongs to a faction, and
// hostility between factions decides who an agent is willing to attack:
//
//   * PLAYER  — you. Not an AI; never auto-selects targets.
//   * ENEMY   — the standard human hostile. Attacks the PLAYER and the BEAST (and any
//               CHAOTIC). Target PRIORITY (see UeSoldierController.AcquireTarget) puts the
//               BEAST first — it's the apex threat everyone wants dead — then the player,
//               then anyone else; once the beast is gone it falls back to hunting you.
//   * CHAOTIC — aggressive chaotic: attacks EVERYONE (player, enemies, neutrals, the beast,
//               and even other chaotics). The wildcard that makes the arena a free-for-all,
//               but it too rates the BEAST as the top-priority threat.
//   * NEUTRAL — passive. Attacks no one until provoked, then retaliates against whoever
//               hit it (handled in TakeHit).
//   * BEAST   — the hulking melee creature. It runs its OWN player-hunting AI (it does not
//               use this faction's target selection), so this entry exists mainly so the
//               human factions can mark it hostile and prioritise it as the biggest threat.
export const Faction = {
    PLAYER:  'player',
    ENEMY:   'enemy',
    CHAOTIC: 'chaotic',
    NEUTRAL: 'neutral',
    BEAST:   'beast',
};

// Would an agent of faction `from` attack a target of faction `to`?
export function isHostile(from, to){
    if(!from || !to){ return false; }
    switch(from){
        case Faction.CHAOTIC: return true;                                   // everyone, no exceptions
        case Faction.ENEMY:   return to === Faction.PLAYER || to === Faction.CHAOTIC || to === Faction.BEAST;
        default:              return false;                                  // neutral / player / beast: no faction targeting
    }
}

// Is `to` the highest-priority threat for a human faction (everyone fears the beast most)?
export function isPriorityThreat(to){
    return to === Faction.BEAST;
}
