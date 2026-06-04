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
        this.controls = this.GetComponent('PlayerControls');
        this.body = this.GetComponent('PlayerBody');

        this.SetupMuzzleFlash();
        this.SetupSound();
        this.BuildLoadout();
        this.SetupInput();

        this.parent.RegisterEventHandler(this.AmmoPickup, 'AmmoPickup');
        // The third-person body reload anim finishing refills the mag (see PlayerBody).
        this.parent.RegisterEventHandler(this.OnReloadDone, 'reload.done');

        this.EquipWeapon(0);

        // After the loadout is equipped (FPS flash parented, in-hand AK socketed).
        this.SetupTpsMuzzleFlash();
    }

    SetupMuzzleFlash(){
        this.flash.children[0].material.blending = THREE.AdditiveBlending;
    }

    // Third-person muzzle flash. The FPS flash above rides the arms viewmodel, which
    // is hidden in TPS, so the body needs its own. Clone the flash quad + an
    // independent additive material and drop it straight in the world; each frame
    // UpdateTpsMuzzleFlash parks it just past the in-hand AK's muzzle and fades it in
    // lock-step with the active weapon's flash life.
    SetupTpsMuzzleFlash(){
        this.tpsFlash = null;
        this.weaponPivot = this.body ? this.body.weaponPivot : null;
        if(!this.body || !this.weaponPivot){ return; }

        this.tpsFlash = this.flash.clone(true);
        const mat = this.tpsFlash.children[0].material.clone();
        mat.blending = THREE.AdditiveBlending;
        mat.transparent = true;
        mat.depthWrite = false;
        this.tpsFlash.children[0].material = mat;
        this.tpsFlash.visible = false;
        this.tpsFlash.renderOrder = 999;   // additive flash draws last, over the gun
        this.body.scene.add(this.tpsFlash);

        // Size it for the third-person boom distance rather than reusing the FPS
        // flash's tiny up-close viewmodel scale (which is near-invisible at ~3 m).
        // Measure the quad's native size at unit scale and scale to a fixed world
        // size so it reads clearly off the muzzle.
        const TPS_FLASH_SIZE = 0.45;   // metres
        this.tpsFlash.scale.set(1, 1, 1);
        this.tpsFlash.updateMatrixWorld(true);
        const native = new THREE.Box3().setFromObject(this.tpsFlash).getSize(new THREE.Vector3());
        const longest = Math.max(native.x, native.y, native.z) || 1;
        const s = TPS_FLASH_SIZE / longest;
        this._tpsFlashScale = new THREE.Vector3(s, s, s);
        this.tpsFlash.scale.copy(this._tpsFlashScale);

        // Anchor the flash at the AK's real muzzle, in the gun's own frame, so it
        // tracks the barrel regardless of camera angle (placing it by camera-forward
        // drifts off the tip because the view isn't aligned with the barrel).
        this.BuildMuzzleAnchor();
        this.tpsFlashRaise = 0.08;   // world-up nudge (m) onto the barrel line

        // Scratch + per-shot variety, reused each frame.
        this._tpsRoll = 0;
    }

    // Drop an empty anchor at the in-hand AK's muzzle. The gun's barrel is its
    // longest local axis; the muzzle is the end of that axis farther from the wrist
    // (hand bone), taken at the centre of the bbox's front face. Computed in the
    // weapon pivot's local frame so it rides the gun's animation/orientation.
    BuildMuzzleAnchor(){
        const pivot = this.weaponPivot;
        pivot.updateWorldMatrix(true, true);
        const toLocal = new THREE.Matrix4().copy(pivot.matrixWorld).invert();

        // Gather the gun geometry's bounding box expressed in pivot-local space.
        const local = new THREE.Box3();
        const corner = new THREE.Vector3();
        pivot.traverse(o => {
            if(!o.isMesh || !o.geometry){ return; }
            o.geometry.computeBoundingBox();
            const bb = o.geometry.boundingBox;
            for(let i = 0; i < 8; i++){
                corner.set(
                    (i & 1) ? bb.max.x : bb.min.x,
                    (i & 2) ? bb.max.y : bb.min.y,
                    (i & 4) ? bb.max.z : bb.min.z,
                );
                corner.applyMatrix4(o.matrixWorld).applyMatrix4(toLocal);
                local.expandByPoint(corner);
            }
        });

        const size = local.getSize(new THREE.Vector3());
        const center = local.getCenter(new THREE.Vector3());
        const axis = (size.x >= size.y && size.x >= size.z) ? 'x'
                   : (size.y >= size.z ? 'y' : 'z');

        // The two end-faces along the barrel axis (other axes at the bbox centre).
        const endA = center.clone(); endA[axis] = local.max[axis];
        const endB = center.clone(); endB[axis] = local.min[axis];

        // Muzzle = whichever end is farther from the wrist (hand bone). pivot.parent
        // is the hand_r bone that the gun is socketed to.
        const handPos = new THREE.Vector3();
        (pivot.parent || pivot).getWorldPosition(handPos);
        const wa = endA.clone().applyMatrix4(pivot.matrixWorld);
        const wb = endB.clone().applyMatrix4(pivot.matrixWorld);
        const muzzleLocal = wa.distanceToSquared(handPos) >= wb.distanceToSquared(handPos) ? endA : endB;

        this.muzzleAnchor = new THREE.Object3D();
        this.muzzleAnchor.position.copy(muzzleLocal);
        pivot.add(this.muzzleAnchor);
    }

    // Re-roll the TPS flash's spin and width on each shot, mirroring the FPS flash.
    TriggerTpsFlash(){
        if(!this.tpsFlash){ return; }
        this._tpsRoll = Math.PI * Math.random();
        const stretch = Math.random() * (1.5 - 0.8) + 0.8;
        this.tpsFlash.scale.set(
            this._tpsFlashScale.x * stretch,
            this._tpsFlashScale.y,
            this._tpsFlashScale.z,
        );
    }

    UpdateTpsMuzzleFlash(){
        if(!this.tpsFlash){ return; }
        const inTps = !this.controls || this.controls.cameraMode === 'TPS';
        const life = this.flash.life;
        if(!inTps || life <= 0 || !this.active){
            this.tpsFlash.visible = false;
            return;
        }
        // Park the flash at the AK's muzzle anchor (in the gun's own frame, so it
        // sits on the barrel tip whatever the camera/gun orientation), nudged up a
        // touch since the barrel runs along the top of the gun's bounding box.
        this.muzzleAnchor.getWorldPosition(this.tpsFlash.position);
        this.tpsFlash.position.y += this.tpsFlashRaise;
        // Billboard toward the camera, with the per-shot roll for variety.
        this.tpsFlash.quaternion.copy(this.camera.quaternion);
        this.tpsFlash.rotateZ(this._tpsRoll);
        this.tpsFlash.children[0].material.opacity = life / this.active.fireRate;
        this.tpsFlash.visible = true;
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
            fireRate: 0.1, damage: 2, magSize: 30, infiniteAmmo: true,
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
            fireRate: 0.06, damage: 1, magSize: 25, infiniteAmmo: true,
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

    OnReloadDone = () => {
        this.active && this.active.ReloadDone();
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
            // Drive the third-person body's full-body shoot one-shot (no-op in FP
            // where the body is hidden) and re-roll the TPS muzzle flash.
            this.Broadcast({topic: 'weapon.shoot'});
            this.TriggerTpsFlash();
        }

        weapon.AnimateMuzzle(t);
        this.UpdateTpsMuzzleFlash();
    }
}
