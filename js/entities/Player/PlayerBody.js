import * as THREE from 'three'
import Component from '../../Component.js'


// Full-body player avatar: the Unreal Engine Mannequin (SK_Mannequin) driven by
// UE rifle animations (idle / walk / reload / shoot). The avatar lives in the
// world at the player's physics capsule and faces the look direction. In
// first-person it is rendered only on a dedicated layer the FP camera ignores
// (so you still see its shadow, not your own torso); in third-person it is shown
// normally. See SetCameraMode.
//
// UE assets import Z-up and in centimetres, so the raw GLB scene is wrapped in a
// gameplay group (modelRoot) and the inner model carries a fixed -90deg X tilt +
// 0.01 scale to land upright in three's Y-up metres (verified: ~1.83 m tall,
// feet at local Y=0). The UE clips bake root motion onto the 'root' bone, which
// we lock every frame so locomotion plays in place (the capsule drives movement).
const BODY_LAYER = 1;

export default class PlayerBody extends Component{
    constructor(model, clips, scene, camera){
        super();
        this.name = 'PlayerBody';
        this.model = model;            // GLB scene (SkeletonUtils.clone)
        this.clips = clips;            // { idle, walk, run, reload, shoot }
        this.scene = scene;
        this.camera = camera;

        this.animations = {};
        this.currentState = null;
        this.oneShot = null;           // name of an in-progress reload/shoot, or null
        this.playerControls = null;
        this.rootBone = null;
        this.rootRef = null;

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

        // Import-fix transform on the inner model; gameplay transform on the wrapper.
        this.model.rotation.x = -Math.PI / 2;
        this.model.scale.setScalar(0.01);
        this.modelRoot = new THREE.Group();
        this.modelRoot.add(this.model);

        this.model.traverse(child => {
            if(child.isMesh || child.isSkinnedMesh){
                child.frustumCulled = false;       // skinned bounds go stale once posed
                child.castShadow = true;
                child.receiveShadow = true;
                // The GLB's baked material renders black/invisible under r127; use a
                // fresh skinning-enabled material we control.
                child.material = new THREE.MeshStandardMaterial({
                    color: 0x8c95a1, metalness: 0.1, roughness: 0.8, skinning: true,
                });
            }
            if(child.isBone && child.name === 'root'){
                this.rootBone = child;
            }
        });

        if(this.rootBone){
            this.rootRef = {
                position: this.rootBone.position.clone(),
                quaternion: this.rootBone.quaternion.clone(),
                scale: this.rootBone.scale.clone(),
            };
        }

        this.SetupAnimations();
        this.scene.add(this.modelRoot);

        // Let the level's shadow-casting light see BODY_LAYER so the avatar still
        // throws a shadow even when hidden from the FP camera.
        let light = null;
        this.scene.traverse(o => { if(o.isLight && o.shadow){ light = o; } });
        if(light){ light.shadow.camera.layers.enable(BODY_LAYER); }

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
    SetCameraMode(mode){
        this.cameraMode = mode;
        const fp = mode === 'FPS';
        this.model.traverse(child => {
            if(child.isMesh || child.isSkinnedMesh){
                child.layers.set(fp ? BODY_LAYER : 0);
            }
        });
    }

    SetState(name){
        if(this.oneShot){ return; }                 // don't interrupt reload/shoot
        if(this.currentState === name || !this.animations[name]){ return; }

        const next = this.animations[name];
        next.reset();
        next.setEffectiveWeight(1.0);
        next.setEffectiveTimeScale(1.0);
        next.play();

        if(this.currentState && this.animations[this.currentState]){
            next.crossFadeFrom(this.animations[this.currentState], 0.2, true);
        }

        this.currentState = name;
    }

    PlayOneShot(name){
        const action = this.animations[name];
        if(!action){ return; }
        this.oneShot = name;
        action.reset();
        action.setEffectiveWeight(1.0);
        action.setEffectiveTimeScale(name === 'shoot' ? 1.5 : 1.0);
        action.play();
        const from = this.currentState && this.animations[this.currentState];
        if(from){ action.crossFadeFrom(from, 0.1, true); }
    }

    OnOneShotFinished = () => {
        const finished = this.oneShot;
        this.oneShot = null;
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
