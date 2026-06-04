import * as THREE from 'three'
import Component from '../../Component.js'
import { buildUeMannequin, UE_BODY_LAYER } from '../Common/UeMannequin.js'


// Full-body player avatar: the Unreal Engine Mannequin (SK_Mannequin) driven by
// UE rifle animations (idle / walk / run / reload / shoot) and holding the AK in
// its right hand. The avatar lives in the world at the player's physics capsule
// and faces the look direction. In first-person it is rendered only on a dedicated
// layer the FP camera ignores (so you still see its shadow, not your own torso);
// in third-person it is shown normally. See SetCameraMode.
//
// The UE import fix, body/chest-logo textures and the in-hand weapon socket are
// shared with the enemy soldier via buildUeMannequin. The UE clips bake root
// motion onto the 'root' bone, which we lock every frame so locomotion plays in
// place (the capsule drives movement).
export default class PlayerBody extends Component{
    constructor(model, clips, scene, camera, textures = null, weapon = null, preOriented = false){
        super();
        this.name = 'PlayerBody';
        this.model = model;            // GLB scene (SkeletonUtils.clone)
        this.clips = clips;            // { idle, walk, run, reload, shoot }
        this.scene = scene;
        this.camera = camera;
        this.textures = textures;      // { bodyColor, bodyNormal, logoColor, logoNormal } (legacy only)
        this.weapon = weapon;          // cloned SK_AK47 mesh for the right hand
        this.preOriented = preOriented;// true => Y-up, metre-scaled GLB with baked PBR

        this.animations = {};
        this.currentState = null;
        this.oneShot = null;           // name of an in-progress reload/shoot, or null
        this.playerControls = null;
        this.rootBone = null;
        this.rootRef = null;
        this.meshes = [];

        // walk and run share the single UE jog clip; play it slower for a walk and
        // a touch faster for a sprint so the two locomotion states read distinctly.
        this.stateTimeScale = { idle: 1.0, walk: 0.6, run: 1.15, reload: 1.0, shoot: 1.5 };

        // Vertical offset from the capsule-tracked position (camera height) down
        // to the feet. Capsule is ~1.9 m tall and the camera sits 0.5 above its
        // centre; tuned so the mannequin's feet meet the ground.
        this.feetOffset = -1.45;
        // Yaw so the mannequin (faces +Z after the import tilt) aligns with the
        // look/move direction (camera looks down -Z), i.e. turn it to face -Z.
        this.yawOffset = Math.PI;
        // Third-person by default => visible to the main camera.
        this.cameraMode = 'TPS';
    }

    SetupAnimations(){
        this.mixer = new THREE.AnimationMixer(this.model);
        ['idle', 'walk', 'run', 'reload', 'shoot'].forEach(name => {
            const clip = this.clips[name];
            if(!clip){ return; }
            this.animations[name] = this.mixer.clipAction(clip);
        });
        // reload/shoot are full-body one-shots.
        ['reload', 'shoot'].forEach(name => {
            const a = this.animations[name];
            if(a){ a.setLoop(THREE.LoopOnce); a.clampWhenFinished = true; }
        });
        this.mixer.addEventListener('finished', this.OnOneShotFinished);
    }

    Initialize(){
        this.playerControls = this.GetComponent('PlayerControls');

        // Shared UE avatar build: import fix, textured material, AK socketed to hand_r.
        const built = buildUeMannequin(this.model, { textures: this.textures, weapon: this.weapon, preOriented: this.preOriented });
        this.modelRoot = built.modelRoot;
        this.rootBone = built.rootBone;
        this.meshes = built.meshes;
        this.weaponPivot = built.weaponPivot;   // in-hand AK group; used by WeaponPlacementDebug

        if(this.rootBone){
            this.rootRef = {
                position: this.rootBone.position.clone(),
                quaternion: this.rootBone.quaternion.clone(),
                scale: this.rootBone.scale.clone(),
            };
        }

        this.SetupAnimations();
        this.scene.add(this.modelRoot);

        // Let the level's shadow-casting light see UE_BODY_LAYER so the avatar still
        // throws a shadow even when hidden from the FP camera.
        let light = null;
        this.scene.traverse(o => { if(o.isLight && o.shadow){ light = o; } });
        if(light){ light.shadow.camera.layers.enable(UE_BODY_LAYER); }

        this.SetCameraMode(this.cameraMode);
        this.SetState('idle');

        // React to TPS/FPS toggles broadcast by PlayerControls.
        this.parent.RegisterEventHandler(this.OnCameraMode, 'camera.mode');
        // Optional body reactions to weapon actions.
        this.parent.RegisterEventHandler(this.OnReload, 'weapon.reload');
        this.parent.RegisterEventHandler(this.OnShoot, 'weapon.shoot');
    }

    OnCameraMode = (msg) => { this.SetCameraMode(msg.mode); }
    OnReload = () => { this.PlayOneShot('reload'); }
    OnShoot = () => { this.PlayOneShot('shoot'); }

    // Show in third-person, hide from the FP camera (shadow only) in first-person.
    // The in-hand AK rides the body meshes list so it hides/shows in lock-step.
    SetCameraMode(mode){
        this.cameraMode = mode;
        const fp = mode === 'FPS';
        for(const mesh of this.meshes){
            mesh.layers.set(fp ? UE_BODY_LAYER : 0);
        }
    }

    SetState(name){
        if(this.oneShot){ return; }                 // don't interrupt reload/shoot
        if(this.currentState === name || !this.animations[name]){ return; }

        const next = this.animations[name];
        next.reset();
        next.setEffectiveWeight(1.0);
        next.setEffectiveTimeScale(this.stateTimeScale[name] ?? 1.0);
        next.play();

        if(this.currentState && this.animations[this.currentState]){
            next.crossFadeFrom(this.animations[this.currentState], 0.2, true);
        }

        this.currentState = name;
    }

    PlayOneShot(name){
        const action = this.animations[name];
        if(!action){ return; }
        // Already mid one-shot of this clip (continuous fire re-triggers 'shoot'
        // every shot): just restart its time so it pulses again, WITHOUT another
        // crossFadeFrom. Re-fading in from the locomotion action — already faded to
        // weight 0 by the first crossfade — drops the total blend weight to ~0 for a
        // few frames, which snaps the skeleton to its bind (T) pose.
        if(this.oneShot === name){
            action.time = 0;
            action.setEffectiveWeight(1.0);
            return;
        }
        this.oneShot = name;
        action.reset();
        action.setEffectiveWeight(1.0);
        action.setEffectiveTimeScale(this.stateTimeScale[name] ?? 1.0);
        action.play();
        const from = this.currentState && this.animations[this.currentState];
        if(from){ action.crossFadeFrom(from, 0.1, true); }
    }

    OnOneShotFinished = (e) => {
        // The mixer fires 'finished' for ANY LoopOnce action, so ignore a stale
        // finish from a one-shot we've already moved on from — e.g. a lingering
        // 'shoot' action ending just after a reload began. Acting on it would clear
        // the active one-shot and cut the reload short.
        if(!this.oneShot || (e && e.action !== this.animations[this.oneShot])){
            return;
        }
        const finished = this.oneShot;
        this.oneShot = null;
        // The third-person body reload is the visible one in TPS, so let it drive the
        // mag refill — shooting resumes the instant this anim ends instead of waiting
        // on the longer (hidden) first-person arms reload clip. ReloadDone is
        // idempotent, so the later FP-clip finish is a harmless no-op.
        if(finished === 'reload'){
            this.Broadcast({topic: 'reload.done'});
        }
        // Blend back to locomotion from the clamped final pose.
        if(finished && this.animations[finished]){
            this.currentState = finished;            // so SetState crossfades out of it
        }
        this.UpdateLocomotion(0);
    }

    UpdateLocomotion(){
        if(this.oneShot){ return; }
        const speed = this.playerControls ? this.playerControls.HorizontalSpeed : 0;
        const grounded = this.playerControls ? this.playerControls.IsGrounded : true;
        let desired = 'idle';
        if(speed > 0.5 && grounded){
            desired = this.playerControls.isSprinting ? 'run' : 'walk';
        }
        this.SetState(desired);
    }

    Update(t){
        if(!this.mixer){ return; }

        this.mixer.update(t);

        // Strip root motion so the clip animates in place; the capsule moves us.
        if(this.rootBone && this.rootRef){
            this.rootBone.position.copy(this.rootRef.position);
            this.rootBone.quaternion.copy(this.rootRef.quaternion);
            this.rootBone.scale.copy(this.rootRef.scale);
        }

        // Follow the capsule and face the look direction.
        const p = this.parent.Position;
        this.modelRoot.position.set(p.x, p.y + this.feetOffset, p.z);
        this.modelRoot.rotation.set(0, this.playerControls.angles.y + this.yawOffset, 0);

        this.UpdateLocomotion();
    }
}
