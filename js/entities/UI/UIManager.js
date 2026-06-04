import Component from '../../Component.js'

export default class UIManager extends Component{
    constructor(){
        super();
        this.name = 'UIManager';
    }

    SetAmmo(mag, rest){
        document.getElementById("current_ammo").innerText = mag;
        document.getElementById("max_ammo").innerText = (rest === Infinity) ? '∞' : rest;
    }

    SetHealth(health){
        document.getElementById("health_progress").style.width = `${health}%`;
    }

    SetWeaponName(name){
        document.getElementById("weapon_name").innerText = name;
    }

    Initialize(){
        document.getElementById("game_hud").style.visibility = 'visible';
    }
}