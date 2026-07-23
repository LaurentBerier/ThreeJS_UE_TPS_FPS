// Lightweight AI relationship system. Every combatant belongs to a faction, and
// hostility between factions decides who an agent is willing to attack:
//
//   * PLAYER  — you. Not an AI; never auto-selects targets.
//   * ENEMY   — the standard human hostile. ALL enemies are ONE SIDE against the player: a human
//               attacks the PLAYER and ONLY the player. It never fires on a fellow human, and it
//               never fires on the beast either — soldiers and beasts are both "the enemy", and
//               the enemy does not fight itself (no AI-vs-AI sideshows stealing the player's
//               fight or thinning encounters before the player arrives).
//   * CHAOTIC — legacy label, kept so old spawn configs still resolve. Behaves exactly like an
//               ENEMY now. Prefer ENEMY for new spawns.
//   * NEUTRAL — passive. Attacks no one until provoked, then retaliates against whoever hit it
//               (handled in TakeHit / Alert(fromDamage)).
//   * BEAST   — the hulking melee creature. It runs its OWN player-hunting AI (it does not use
//               this faction's target selection — and that AI only ever hunts the player), so
//               this entry exists mainly so FactionOf can classify it.
export const Faction = {
    PLAYER:  'player',
    ENEMY:   'enemy',
    CHAOTIC: 'chaotic',
    NEUTRAL: 'neutral',
    BEAST:   'beast',
};

// The human factions. They form a single cooperative side: a human never attacks another human,
// regardless of which of these labels each one carries.
const HUMAN_FACTIONS = new Set([Faction.ENEMY, Faction.CHAOTIC, Faction.NEUTRAL]);
export function isHuman(faction){ return HUMAN_FACTIONS.has(faction); }

// Would an agent of faction `from` attack a target of faction `to`?
//   * Humans (ENEMY / CHAOTIC) attack ONLY the player — never each other, and never the beast
//     (the request: "the enemies don't attack each other"; every hostile is on one side and the
//     player is that side's only prey).
//   * NEUTRAL never auto-attacks via this table (it only retaliates against whoever shot it, which
//     is handled by provokedBy in AcquireTarget — not here).
//   * PLAYER / BEAST don't use this table at all (the player is you; the beast runs its own
//     player-only AI).
export function isHostile(from, to){
    if(!from || !to || from === to){ return false; }
    switch(from){
        case Faction.ENEMY:
        case Faction.CHAOTIC:
            return to === Faction.PLAYER;
        default:
            return false;   // neutral / player / beast: no faction-driven targeting
    }
}

// Is `to` a high-priority (apex) threat that outranks distance in target scoring? Nothing is any
// more: the beast left the humans' target list when the factions collapsed into one side vs the
// player, and the player is scored on proximity alone. Kept (returning false) so the controller's
// threat-weighting hook stays in place for any future faction that should out-rank distance.
export function isPriorityThreat(/* to */){
    return false;
}
