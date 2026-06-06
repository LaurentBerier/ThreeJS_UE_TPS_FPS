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

// Brief, rare pause. Soldiers should almost never just stand around (see PatrolState, which mostly
// loops straight back into roaming), so idle is short and bails to a target instantly.
class IdleState extends State{
    constructor(parent){
        super(parent);
        this.maxWaitTime = 1.2;
        this.minWaitTime = 0.3;
        this.waitTime = 0.0;
    }

    get Name(){return 'idle'}

    Enter(){
        this.parent.proxy.SetMoveIntent(0.0);
        this.parent.proxy.ClearPath();
        this.waitTime = Math.random() * (this.maxWaitTime - this.minWaitTime) + this.minWaitTime;
    }

    Update(t){
        if(this.parent.proxy.AcquireTarget()){
            this.parent.SetState('chase');
            return;
        }

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
            if(Math.random() < 0.2){
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

    Update(t){
        const proxy = this.parent.proxy;

        const visible = proxy.AcquireTarget();
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

// The firefight: the soldier STRAFES around the target (a flank/advance/retreat juke per its style)
// while FACING it and FIRING on cadence — a moving, hard-to-hit target rather than a planted one. It
// keeps picking fresh strafe positions (LOS-scored, near its preferred range) so it never roots, and
// drops back to chase if it loses the shot for a moment. Re-acquires each tick (beast > player).
class CombatState extends State{
    constructor(parent){
        super(parent);
        this.fireTimer = 0.0;
        this.strafeTimer = 0.0;
        this.loseSightTimer = 0.0;
        this.retargetTimer = 0.0;
    }

    get Name(){return 'combat'}

    Enter(){
        const proxy = this.parent.proxy;
        proxy.AcquireTarget();
        proxy.combatFacing = true;                 // face the target while strafing (so it shoots you)
        proxy.SetMoveIntent(proxy.combatMoveSpeed); // strafe at the soldier's combat speed
        proxy.BeginFire();                          // torso fires while the legs move
        proxy.NavigateToCombatPosition(proxy.target);
        this.fireTimer = 0.15;                      // short wind-up: engage almost immediately
        this.strafeTimer = this.PickStrafeTime(proxy);
        this.loseSightTimer = 0.0;
        this.retargetTimer = 0.4;
    }

    Exit(){
        const proxy = this.parent.proxy;
        proxy.EndFire();
        proxy.combatFacing = false;
    }

    PickStrafeTime(proxy){
        // Re-juke to a new position fairly often so movement stays unpredictable (shorter than the
        // patrol-style reposition cadence, jittered per soldier so a squad never strafes in unison).
        return 0.7 + Math.random() * (0.5 + proxy.repositionInterval * 0.4);
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

        // Keep relocating: pick a fresh strafe spot on a timer, or the moment the current one is reached.
        this.strafeTimer -= t;
        if((this.strafeTimer <= 0.0 || !proxy.path || proxy.path.length === 0) && proxy.target){
            proxy.NavigateToCombatPosition(proxy.target);
            this.strafeTimer = this.PickStrafeTime(proxy);
        }

        // Fire whenever we have a shot — WHILE moving. If the shot is lost for a moment (strafed
        // behind cover / an angle), keep strafing; only drop to chase if it stays lost.
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
            if(this.loseSightTimer >= 1.3){
                this.parent.SetState('chase');
            }
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
