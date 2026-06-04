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
        if(this.parent.proxy.CanSeeThePlayer()){
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
        if(this.parent.proxy.CanSeeThePlayer()){
            this.parent.SetState('chase');
        }else if(this.parent.proxy.path && this.parent.proxy.path.length === 0){
            this.parent.SetState('idle');
        }
    }
}

// Chase to get within firing range with a clear line of sight, then hand off to the
// ranged AttackState. (Previously this closed all the way to melee distance.)
class ChaseState extends State{
    constructor(parent){
        super(parent);
        this.updateFrequency = 0.5;
        this.updateTimer = 0.0;
    }

    get Name(){return 'chase'}

    Enter(){
        this.parent.proxy.SetMoveIntent(this.parent.proxy.runSpeed);
        this.updateTimer = 0.0;
    }

    Update(t){
        const proxy = this.parent.proxy;

        // In range with a clear shot? Plant and open fire.
        if(proxy.InShootRange && proxy.HasLineOfSightToPlayer()){
            proxy.ClearPath();
            this.parent.SetState('attack');
            return;
        }

        // Otherwise keep repathing toward the player to close the gap / get an angle.
        if(this.updateTimer <= 0.0){
            proxy.NavigateToPlayer();
            this.updateTimer = this.updateFrequency;
        }
        this.updateTimer -= t;
    }
}

// Ranged fire: stand, face the player, and squeeze off rounds on a cadence. If the
// shot is lost (player breaks range or ducks behind cover) for a moment, fall back
// to chasing to reacquire.
class AttackState extends State{
    constructor(parent){
        super(parent);
        this.fireTimer = 0.0;
        this.loseSightTimer = 0.0;
    }

    get Name(){return 'attack'}

    Enter(){
        const proxy = this.parent.proxy;
        proxy.SetMoveIntent(0.0);
        proxy.ClearPath();
        proxy.BeginAttack();
        this.fireTimer = 0.35;      // brief wind-up before the first round
        this.loseSightTimer = 0.0;
    }

    Exit(){
        this.parent.proxy.EndAttack();
    }

    Update(t){
        const proxy = this.parent.proxy;
        proxy.FacePlayer(t);

        const hasShot = proxy.InShootRange && proxy.HasLineOfSightToPlayer();
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
            proxy.FireAtPlayer();
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
