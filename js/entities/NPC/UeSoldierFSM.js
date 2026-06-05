import {FiniteStateMachine, State} from '../../FiniteStateMachine.js'


// Behaviour FSM for the velocity-driven UE Mannequin soldier. Unlike the mutant's
// CharacterFSM (which keys a specific locomotion clip per state and is moved by
// root motion), this FSM only sets the soldier's *movement intent* — a desired
// speed and a navigation target. The controller then moves the body at that speed
// and picks idle/walk/run from the resulting velocity each frame (see
// UeSoldierController.UpdateLocomotionAnim). Attack and death are the only states
// that take direct control of the animation, overriding locomotion.
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
        this.AddState('attack', new AttackState(this));
        this.AddState('dead', new DeadState(this));
    }
}

class IdleState extends State{
    constructor(parent){
        super(parent);
        this.maxWaitTime = 5.0;
        this.minWaitTime = 1.0;
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

class PatrolState extends State{
    get Name(){return 'patrol'}

    Enter(){
        this.parent.proxy.SetMoveIntent(this.parent.proxy.walkSpeed);
        this.parent.proxy.NavigateToRandomPoint();
    }

    Update(){
        if(this.parent.proxy.AcquireTarget()){
            this.parent.SetState('chase');
        }else if(this.parent.proxy.path && this.parent.proxy.path.length === 0){
            this.parent.SetState('idle');
        }
    }
}

// Chase to get within firing range of the current target with a clear line of sight, then
// hand off to the ranged AttackState. Re-acquires the target each tick so it can switch
// victims mid-chase (e.g. an ENEMY abandons the player to deal with a nearer CHAOTIC).
class ChaseState extends State{
    constructor(parent){
        super(parent);
        this.updateFrequency = 0.3;
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

        // Re-pick the best target (faction priority) from whoever is currently visible.
        const visible = proxy.AcquireTarget();
        if(visible){ this.lostTimer = 0.0; }
        else{
            // Lost sight of everything hostile — pursue the last-seen spot briefly, then give up.
            this.lostTimer += t;
            if(this.lostTimer >= 2.5 || !proxy.hasLastSeen){
                this.parent.SetState('patrol');
                return;
            }
        }

        // In range with a clear shot? Plant and open fire.
        if(proxy.target && proxy.InRangeOf(proxy.target) && proxy.HasLineOfSightTo(proxy.target)){
            proxy.ClearPath();
            this.parent.SetState('attack');
            return;
        }

        // Otherwise keep repathing toward the target (or its last-seen spot) to get an angle.
        if(this.updateTimer <= 0.0){
            proxy.NavigateToTarget();
            this.updateTimer = this.updateFrequency;
        }
        this.updateTimer -= t;
    }
}

// Ranged fire: stand, face the target, and squeeze off rounds on a cadence. Re-acquires each
// tick so a higher-priority victim can steal focus; if the shot is lost for a moment, fall
// back to chasing to reacquire.
class AttackState extends State{
    constructor(parent){
        super(parent);
        this.fireTimer = 0.0;
        this.loseSightTimer = 0.0;
        this.retargetTimer = 0.0;
    }

    get Name(){return 'attack'}

    Enter(){
        const proxy = this.parent.proxy;
        proxy.SetMoveIntent(0.0);
        proxy.ClearPath();
        proxy.BeginAttack();
        this.fireTimer = 0.35;      // brief wind-up before the first round
        this.loseSightTimer = 0.0;
        this.retargetTimer = 0.4;
    }

    Exit(){
        this.parent.proxy.EndAttack();
    }

    Update(t){
        const proxy = this.parent.proxy;

        // Periodically re-evaluate the best target so focus can shift to a nearer threat.
        this.retargetTimer -= t;
        if(this.retargetTimer <= 0.0){
            proxy.AcquireTarget();
            this.retargetTimer = 0.4;
        }

        proxy.FaceTarget(t);

        const hasShot = proxy.target && proxy.InRangeOf(proxy.target) && proxy.HasLineOfSightTo(proxy.target);
        if(!hasShot){
            this.loseSightTimer += t;
            if(this.loseSightTimer >= 0.6){
                this.parent.SetState('chase');
            }
            return;
        }
        this.loseSightTimer = 0.0;

        this.fireTimer -= t;
        if(this.fireTimer <= 0.0){
            proxy.FireAtTarget();
            this.fireTimer = proxy.fireInterval;
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
