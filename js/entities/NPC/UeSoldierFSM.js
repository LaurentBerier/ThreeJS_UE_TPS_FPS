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

class ChaseState extends State{
    constructor(parent){
        super(parent);
        this.updateFrequency = 0.5;
        this.updateTimer = 0.0;
        this.switchDelay = 0.2;
    }

    get Name(){return 'chase'}

    Enter(){
        this.parent.proxy.SetMoveIntent(this.parent.proxy.runSpeed);
        this.updateTimer = 0.0;
        this.switchDelay = 0.2;
    }

    Update(t){
        if(this.updateTimer <= 0.0){
            this.parent.proxy.NavigateToPlayer();
            this.updateTimer = this.updateFrequency;
        }

        if(this.parent.proxy.IsCloseToPlayer){
            this.parent.proxy.ClearPath();
            this.switchDelay -= t;
            if(this.switchDelay <= 0.0){
                this.parent.SetState('attack');
            }
        }else{
            this.switchDelay = 0.1;
        }

        this.updateTimer -= t;
    }
}

class AttackState extends State{
    constructor(parent){
        super(parent);
        this.attackTime = 0.0;
        this.canHit = true;
    }

    get Name(){return 'attack'}

    Enter(){
        this.parent.proxy.SetMoveIntent(0.0);
        this.parent.proxy.ClearPath();
        this.parent.proxy.BeginAttack();
        this.attackTime = this.parent.proxy.attackDuration;
        this.attackEvent = this.attackTime * 0.85;
        this.canHit = true;
    }

    Exit(){
        this.parent.proxy.EndAttack();
    }

    Update(t){
        this.parent.proxy.FacePlayer(t);

        if(!this.parent.proxy.IsCloseToPlayer && this.attackTime <= 0.0){
            this.parent.SetState('chase');
            return;
        }

        if(this.canHit && this.attackTime <= this.attackEvent && this.parent.proxy.IsPlayerInHitbox){
            this.parent.proxy.HitPlayer();
            this.canHit = false;
        }

        if(this.attackTime <= 0.0){
            this.attackTime = this.parent.proxy.attackDuration;
            this.canHit = true;
        }

        this.attackTime -= t;
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
