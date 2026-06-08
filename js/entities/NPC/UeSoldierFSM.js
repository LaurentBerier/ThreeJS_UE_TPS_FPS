import {FiniteStateMachine, State} from '../../FiniteStateMachine.js'


// Behaviour FSM for the velocity-driven UE Mannequin soldier. The FSM sets the soldier's *movement
// intent* (a desired speed + a navigation target); the controller moves the body and picks the
// directional locomotion (idle + jogF/B/L/R) from the resulting velocity, and layers a shoot OVERLAY
// on the torso so the soldier can fire while the legs strafe.
//
// AAA combat behaviour: soldiers acquire almost instantly, keep MOVING rather than standing around
// (continuous patrol/roam; in a firefight they STRAFE around the target while firing — a moving,
// flanking target that's hard to shoot), and fight with VARIETY — each instance has a randomized
// style (aggression / preferred range / flank side / cadence) so the squad never moves in lockstep.
// The loop is chase -> combat (strafe + fire) -> chase. Combat and death drive the body directly.
export default class UeSoldierFSM extends FiniteStateMachine{
    constructor(proxy){
        super();
        this.proxy = proxy;
        this.Init();
    }

    Init(){
        this.AddState('idle', new IdleState(this));
        this.AddState('patrol', new PatrolState(this));
        this.AddState('chase', new ChaseState(this));
        this.AddState('combat', new CombatState(this));
        this.AddState('dead', new DeadState(this));
    }
}

// Lookout pause. The soldier stops and actively SWEEPS its view around (UpdateScan), hunting for the
// player or the beast, before resuming its roam — so it reads as an alert sentry scanning the area
// rather than a guard staring at a wall. Acquires every tick, so it bails to a target the instant one
// comes into the (sweeping) view. A touch longer than before so a scan sweep or two actually plays.
class IdleState extends State{
    constructor(parent){
        super(parent);
        this.maxWaitTime = 3.5;
        this.minWaitTime = 1.5;
        this.waitTime = 0.0;
    }

    get Name(){return 'idle'}

    Enter(){
        this.parent.proxy.SetMoveIntent(0.0);
        this.parent.proxy.ClearPath();
        this.parent.proxy.scanTargetYaw = null;   // start a fresh sweep from the current facing/last-seen
        this.waitTime = Math.random() * (this.maxWaitTime - this.minWaitTime) + this.minWaitTime;
    }

    Update(t){
        if(this.parent.proxy.AcquireTarget()){
            this.parent.SetState('chase');
            return;
        }

        // Sweep the view to look for threats while paused (genuinely widens the forward cone's coverage).
        this.parent.proxy.UpdateScan(t);

        this.waitTime -= t;
        if(this.waitTime <= 0.0){
            this.parent.SetState('patrol');
        }
    }
}

// Continuous roam: walk to a random point and, on arrival, immediately pick another (so the soldier
// keeps repositioning and never just stands). Only rarely drops to a short idle. Acquires every tick.
class PatrolState extends State{
    get Name(){return 'patrol'}

    Enter(){
        this.parent.proxy.SetMoveIntent(this.parent.proxy.walkSpeed);
        this.parent.proxy.NavigateToRandomPoint();
    }

    Update(){
        const proxy = this.parent.proxy;
        if(proxy.AcquireTarget()){
            this.parent.SetState('chase');
            return;
        }
        if(proxy.path && proxy.path.length === 0){
            // Stop to scan the area fairly often (a roaming sentry that keeps pausing to look around),
            // otherwise pick the next roam point and keep moving.
            if(Math.random() < 0.4){
                this.parent.SetState('idle');
            }else{
                proxy.NavigateToRandomPoint();
            }
        }
    }
}

// Chase to get within firing range of the current target with a clear line of sight, then hand off
// to CombatState. Re-acquires each tick (threat priority — the beast steals focus from the player).
class ChaseState extends State{
    constructor(parent){
        super(parent);
        this.updateFrequency = 0.2;
        this.updateTimer = 0.0;
        this.lostTimer = 0.0;
    }

    get Name(){return 'chase'}

    Enter(){
        this.parent.proxy.SetMoveIntent(this.parent.proxy.runSpeed);
        this.updateTimer = 0.0;
        this.lostTimer = 0.0;
    }

    Exit(){
        // Leave target-facing off for whatever comes next (patrol/idle face the move/scan dir). Combat
        // re-asserts it in its own Enter, so a chase->combat handoff stays target-faced throughout.
        this.parent.proxy.combatFacing = false;
    }

    Update(t){
        const proxy = this.parent.proxy;

        const visible = proxy.AcquireTarget();
        // ALWAYS FACE THE TARGET while it's in sight, even mid-approach: the soldier keeps its body (and
        // gun) trained on the player and STRAFES/advances laterally toward it, instead of turning its
        // back to run along the path. While the target is out of sight (closing on its last-seen spot)
        // it faces the move direction so the run reads naturally toward where it last saw you.
        proxy.combatFacing = !!(visible && proxy.target);
        if(visible){ this.lostTimer = 0.0; }
        else{
            this.lostTimer += t;
            if(this.lostTimer >= 2.5 || !proxy.hasLastSeen){
                this.parent.SetState('patrol');
                return;
            }
        }

        // In range with a clear shot? Move into the strafing firefight.
        if(proxy.target && proxy.InRangeOf(proxy.target) && proxy.HasLineOfSightTo(proxy.target)){
            this.parent.SetState('combat');
            return;
        }

        if(this.updateTimer <= 0.0){
            proxy.NavigateToTarget();
            this.updateTimer = this.updateFrequency;
        }
        this.updateTimer -= t;
    }
}

// The firefight, run as a PLANT <-> STRAFE duty cycle so the soldier both "stops and shoots" and
// "strafes and shoots", instead of skating around non-stop:
//   * HOLD  — plant, stop moving, and fire on cadence (more accurate while still; see FireAtTarget).
//             Cautious soldiers hold longer, aggressive ones reposition sooner.
//   * STRAFE— pick a fresh flanking position (LOS-scored, near its preferred range) and move to it
//             while STILL facing the target and firing — a moving, hard-to-hit shooter.
// It ALWAYS faces the target (combatFacing) the entire time — planted or strafing — so the gun is
// trained on you whenever it can shoot. If a strafe can't find a path it just holds and fires (so
// "strafe and shoot" degrades to "stop and shoot" rather than the soldier freezing dumbly). Re-
// acquires each tick (beast > player) and drops back to chase if the shot stays lost.
class CombatState extends State{
    constructor(parent){
        super(parent);
        this.fireTimer = 0.0;
        this.phase = 'hold';          // 'hold' (plant & fire) | 'strafe' (reposition & fire)
        this.phaseTimer = 0.0;
        this.loseSightTimer = 0.0;
        this.retargetTimer = 0.0;
    }

    get Name(){return 'combat'}

    Enter(){
        const proxy = this.parent.proxy;
        proxy.AcquireTarget();
        proxy.combatFacing = true;                 // always face the target (planted AND strafing)
        proxy.BeginFire();                          // the torso fires throughout combat
        this.fireTimer = 0.15;                      // short wind-up: engage almost immediately
        this.loseSightTimer = 0.0;
        this.retargetTimer = 0.4;
        // Open by planting and firing so the engagement reads as "stop & shoot", then alternate.
        this.EnterHold(proxy);
    }

    Exit(){
        const proxy = this.parent.proxy;
        proxy.EndFire();
        proxy.combatFacing = false;
    }

    // Plant and fire. Hold ~0.6..2.9s — longer when cautious (low aggression), shorter when
    // aggressive — jittered per soldier so a squad doesn't plant/strafe in unison.
    EnterHold(proxy){
        this.phase = 'hold';
        proxy.SetMoveIntent(0.0);                    // stop: the legs settle to idle, the torso keeps firing
        proxy.ClearPath();
        const base = 2.2 - 1.4 * proxy.aggression;   // cautious ~2.2s, aggressive ~0.8s
        this.phaseTimer = base * (0.7 + Math.random() * 0.6);
    }

    // Reposition: pick a fresh flanking spot and strafe to it while facing + firing. Some soldiers
    // (holdGroundChance) skip the move and just hold again, for variety. No usable path => hold.
    EnterStrafe(proxy){
        if(!proxy.target || Math.random() < proxy.holdGroundChance){ this.EnterHold(proxy); return; }
        const ok = proxy.NavigateToCombatPosition(proxy.target);
        if(!ok){ this.EnterHold(proxy); return; }
        this.phase = 'strafe';
        proxy.SetMoveIntent(proxy.combatMoveSpeed);
        // Strafe for a juke or two; shorter than the hold so movement stays unpredictable.
        this.phaseTimer = 0.7 + Math.random() * (0.5 + proxy.repositionInterval * 0.4);
    }

    Update(t){
        const proxy = this.parent.proxy;

        // Re-evaluate the best target so focus can shift (beast > player > nearest).
        this.retargetTimer -= t;
        if(this.retargetTimer <= 0.0){
            proxy.AcquireTarget();
            this.retargetTimer = 0.4;
        }

        // Lost everyone hostile: fall back to chase (which pursues last-seen, then patrols).
        if(!proxy.target && !proxy.hasLastSeen){
            this.parent.SetState('chase');
            return;
        }

        // Fire whenever we have a shot — planted OR strafing (the soldier faces the target either way).
        const hasShot = proxy.target && proxy.InRangeOf(proxy.target) && proxy.HasLineOfSightTo(proxy.target);
        if(hasShot){
            this.loseSightTimer = 0.0;
            this.fireTimer -= t;
            if(this.fireTimer <= 0.0){
                proxy.FireAtTarget();
                this.fireTimer = proxy.fireInterval;
            }
        }else{
            this.loseSightTimer += t;
            // No shot for a moment (target behind cover / broke the angle): go regain LOS rather than
            // standing firing at a wall. A planted soldier reacts a touch sooner than a strafing one.
            const patience = this.phase === 'hold' ? 0.8 : 1.3;
            if(this.loseSightTimer >= patience){ this.parent.SetState('chase'); return; }
        }

        // Advance the duty cycle: alternate plant <-> strafe on the phase timer, and end a strafe the
        // instant it reaches its chosen spot (so it plants and fires there instead of overshooting).
        this.phaseTimer -= t;
        const reachedSpot = this.phase === 'strafe' && (!proxy.path || proxy.path.length === 0);
        if(this.phaseTimer <= 0.0 || reachedSpot){
            if(this.phase === 'hold'){ this.EnterStrafe(proxy); }
            else{ this.EnterHold(proxy); }
        }
    }
}

class DeadState extends State{
    get Name(){return 'dead'}

    Enter(){
        this.parent.proxy.SetMoveIntent(0.0);
        this.parent.proxy.ClearPath();
        this.parent.proxy.Die();
    }

    Update(t){
        this.parent.proxy.UpdateDeath(t);
    }
}
