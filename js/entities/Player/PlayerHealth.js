import Component from "../../Component.js";

export default class PlayerHealth extends Component{
    constructor(){
        super();

        this.health = 100;
    }

    TakeHit = e =>{
        // Dodge-roll i-frames: ignore all damage while the roll's invulnerability window is active.
        if(this.controls && this.controls.invulnerable){ return; }
        // Ranged shots pass an explicit `amount`; the mutant's melee hit passes none,
        // so fall back to the original flat 10.
        const amount = (e && e.amount) ? e.amount : 10;
        this.health = Math.max(0, this.health - amount);
        this.uimanager.SetHealth(this.health);
    }

    Initialize(){
        this.uimanager = this.FindEntity("UIManager").GetComponent("UIManager");
        this.controls = this.GetComponent("PlayerControls");   // i-frames during the dodge roll
        this.parent.RegisterEventHandler(this.TakeHit, "hit");
        this.uimanager.SetHealth(this.health);
    }
}