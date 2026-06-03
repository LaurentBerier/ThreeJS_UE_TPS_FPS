import * as THREE from 'three'
import Component from '../../Component.js'
import Input from '../../Input.js'

import Weapon from './Weapon.js'


// Owns the weapon loadout and swaps weapons on the Hands viewmodel's socket bone.
// Weapons are independent rigid meshes; switching just holsters one and attaches the
// next to the same hand socket, reusing the shared arm animations. Adding a real
// weapon later = one registry entry + a mesh.
export default class WeaponManager extends Component{
    constructor(camera, world, flash, shotSoundBuffer, audioListner){
        super();
        this.name = 'WeaponManager';
        this.camera = camera;
        this.world = world;
        this.flash = flash;
        this.shotSoundBuffer = shotSoundBuffer;
        this.audioListner = audioListner;

        this.weapons = [];
        this.activeIndex = -1;
        this.hands = null;
        this.uimanager = null;
    }

    get active(){
        return this.activeIndex >= 0 ? this.weapons[this.activeIndex] : null;
    }

    Initialize(){
        this.hands = this.GetComponent('Hands');
        this.uimanager = this.FindEntity('UIManager').GetComponent('UIManager');

        this.SetupMuzzleFlash();
        this.SetupSound();
        this.BuildLoadout();
        this.SetupInput();

        this.parent.RegisterEventHandler(this.AmmoPickup, 'AmmoPickup');

        this.EquipWeapon(0);
    }

    SetupMuzzleFlash(){
        this.flash.children[0].material.blending = THREE.AdditiveBlending;
    }

    SetupSound(){
        // One shared shot sound is fine while weapons reuse the AK report; give each
        // weapon its own buffer here later for distinct audio.
        this.shotSound = new THREE.Audio(this.audioListner);
        this.shotSound.setBuffer(this.shotSoundBuffer);
        this.shotSound.setLoop(false);
    }

    BuildLoadout(){
        // Slot 0: the AK skinned mesh straight from the metarig — full reload/fire
        // animation (the magazine drops, the slider racks).
        const akMesh = this.hands.GetSkinnedWeaponMesh();
        const ak47 = new Weapon('AK-47', akMesh, {
            fireRate: 0.1, damage: 2, magSize: 30, ammo: 100,
        });

        // Slot 1: placeholder — a tinted SkinnedMesh clone bound to the SAME metarig,
        // so it animates identically. Proves the swap with no new art; replace with a
        // real rigged weapon mesh later (one registry entry).
        const smgMaterial = Array.isArray(akMesh.material)
            ? akMesh.material.map(m => this._tint(m))
            : this._tint(akMesh.material);
        const smgMesh = new THREE.SkinnedMesh(akMesh.geometry, smgMaterial);
        smgMesh.bind(akMesh.skeleton, akMesh.bindMatrix);
        smgMesh.frustumCulled = false;
        akMesh.parent.add(smgMesh);
        const smg = new Weapon('SMG (placeholder)', smgMesh, {
            fireRate: 0.06, damage: 1, magSize: 25, ammo: 120,
        });

        this.weapons = [ak47, smg];
        for(const weapon of this.weapons){
            weapon.owner = this.parent;
            weapon.Init({
                camera: this.camera,
                world: this.world,
                flash: this.flash,
                shotSound: this.shotSound,
                uimanager: this.uimanager,
                root: this.hands.GetModelRoot(),
            });
        }
    }

    _tint(material){
        const m = material.clone();
        m.color = new THREE.Color(0.45, 0.6, 1.0);
        return m;
    }

    EquipWeapon(index){
        if(index < 0 || index >= this.weapons.length || index === this.activeIndex){
            return;
        }

        this.active && this.active.Holster();

        this.activeIndex = index;
        const weapon = this.active;
        weapon.Attach();

        this.hands.SetActiveWeapon(weapon);
        this.hands.stateMachine.SetState('idle');

        weapon.RefreshUI();
        this.uimanager.SetWeaponName && this.uimanager.SetWeaponName(weapon.name);
    }

    CycleWeapon(dir){
        const count = this.weapons.length;
        const next = (this.activeIndex + dir + count) % count;
        this.EquipWeapon(next);
    }

    AmmoPickup = () => {
        this.active && this.active.AddAmmo(30);
        this.active && this.active.RefreshUI();
    }

    Reload(){
        const weapon = this.active;
        if(!weapon || !weapon.CanReload()){
            return;
        }

        weapon.BeginReload();
        this.hands.PlayReload();
        // Drive the third-person body's full-body reload one-shot too (no-op in FP
        // where the body is hidden, but keeps TPS in sync).
        this.Broadcast({topic: 'weapon.reload'});
    }

    SetupInput(){
        // Left click to fire.
        Input.AddMouseDownListner( e => {
            if(e.button != 0 || !this.active || this.active.reloading){
                return;
            }
            this.active.shoot = true;
            this.active.shootTimer = 0.0;
        });

        Input.AddMouseUpListner( e => {
            if(e.button != 0 || !this.active){
                return;
            }
            this.active.shoot = false;
        });

        // Right click to aim down sights (handled by the Hands viewmodel).
        Input.AddMouseDownListner( e => {
            if(e.button === 2){ this.hands.aiming = true; }
        });
        Input.AddMouseUpListner( e => {
            if(e.button === 2){ this.hands.aiming = false; }
        });

        // Suppress the context menu so right click can aim.
        document.addEventListener('contextmenu', e => e.preventDefault());

        Input.AddKeyDownListner(e => {
            if(e.repeat){ return; }

            if(e.code == 'KeyR'){
                this.Reload();
            }else if(e.code == 'Digit1'){
                this.EquipWeapon(0);
            }else if(e.code == 'Digit2'){
                this.EquipWeapon(1);
            }
        });

        // Mouse wheel cycles weapons.
        Input.AddMouseWheelListner(e => {
            this.CycleWeapon(e.deltaY > 0 ? 1 : -1);
        });
    }

    Update(t){
        const weapon = this.active;
        if(!weapon){
            return;
        }

        // Auto-reload when trying to fire an empty mag (matches the old behaviour).
        if(weapon.shoot && weapon.magAmmo === 0 && !weapon.reloading){
            this.Reload();
        }

        if(weapon.Shoot(t)){
            this.Broadcast({topic: 'ak47_shot'});
        }

        weapon.AnimateMuzzle(t);
    }
}
