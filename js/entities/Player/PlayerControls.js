import * as THREE from 'three'
import Component from '../../Component.js'
import Input from '../../Input.js'
import {Ammo, AmmoHelper, CollisionFilterGroups} from '../../AmmoLib.js'

import DebugShapes from '../../DebugShapes.js'


export default class PlayerControls extends Component{
    constructor(camera){
        super();
        this.name = 'PlayerControls';
        this.camera = camera;

        this.timeZeroToMax = 0.08;

        this.walkSpeed = 7.0;
        this.sprintMultiplier = 1.6;
        this.maxSpeed = this.walkSpeed;
        this.speed = new THREE.Vector3();
        this.acceleration = this.walkSpeed / this.timeZeroToMax;
        this.decceleration = -7.0;
        this.isSprinting = false;

        this.mouseSpeed = 0.002;
        this.physicsComponent = null;
        this.isLocked = false;
        // When a dev tool (WeaponPlacementDebug) takes over the camera, we freeze the
        // player and stop placing the camera so the tool's free-fly cam can own it.
        this.cameraOverride = false;

        this.angles = new THREE.Euler();
        this.pitch = new THREE.Quaternion();
        this.yaw = new THREE.Quaternion();

        this.jumpVelocity = 5;
        this.yOffset = 0.5;
        this.tempVec = new THREE.Vector3();
        this.moveDir = new THREE.Vector3();
        this.xAxis = new THREE.Vector3(1.0, 0.0, 0.0);
        this.yAxis = new THREE.Vector3(0.0, 1.0, 0.0);

        // Camera mode: 'TPS' (third-person orbit-follow, default — showcases the
        // UE Mannequin) or 'FPS' (first-person, the arms/weapon viewmodel).
        // The same yaw/pitch (this.angles) drives both; only the camera placement
        // differs. Press V to toggle. Combat aim is FP-authoritative in v1.
        this.cameraMode = 'TPS';
        this.tpsDistance = 2.6;   // boom length behind the player (metres)
        this.tpsMinDistance = 0.6;// HARD floor on the boom: collision never dollies closer than this (see UpdateCamera)
        this.tpsPivotHeight = 0.25; // pivot above eye height
        this.tpsShoulder = 0.85;  // lateral rig shift: bigger => character further frame-left, reticle further right (in front of the gun)
        this._vLatch = false;

        // Precise-aim mode (hold right click in TPS): the boom pulls in over the
        // shoulder, the FOV zooms, and the mouse slows for finer aim. Targets are
        // eased toward each frame so entering/leaving aim glides rather than snaps.
        this.aiming = false;
        // Physical right-button state, tracked so a dodge roll (which force-drops aim, see TryStartRoll)
        // can RESTORE aim when it ends if the button is still held — otherwise aiming stays stuck off
        // until you release and re-press, which read as "I'm holding aim but nothing's aiming".
        this._aimHeld = false;
        this.tpsAimDistance = 1.5;    // tighter boom while aiming
        this.tpsAimShoulder = 0.55;   // pull the shoulder offset in a little
        this.tpsAimFov = 35;          // zoom (base FOV is captured in Initialize)
        this.aimLerpSpeed = 12;
        this.aimSensitivity = 0.55;   // mouse multiplier while aiming
        this.aimMoveMultiplier = 0.4; // top-speed scale while aiming — a slow, deliberate ADS walk
        this.baseFov = 50;            // overwritten from the camera in Initialize
        // Smoothed current values driven each frame in UpdateCamera.
        this._curDistance = this.tpsDistance;
        this._curShoulder = this.tpsShoulder;
        this._curFov = this.baseFov;
        // Scratch vectors for the TPS boom (avoid per-frame allocation).
        this._cap = new THREE.Vector3();
        this._pivot = new THREE.Vector3();
        this._fwd = new THREE.Vector3();
        this._right = new THREE.Vector3();
        this._fwdBase = new THREE.Vector3(0, 0, -1);
        this._rightBase = new THREE.Vector3(1, 0, 0);

        // --- Aim target (the single source of truth for "where the player is aiming"). Each frame
        // we cast the SAME camera-centre ray the weapon fires (screen-centre unproject; see
        // Weapon.Raycast) into the physics world and store the world point it hits. The weapon
        // alignment + two-hand IK (PlayerBody / WeaponAimIK) point the visible barrel AT this point,
        // so the gun lines up with the actual projectile trace — same ray, same target, no parallax
        // between the crosshair and the muzzle. Valid=true when the ray hit geometry; otherwise the
        // target is a far point straight down the crosshair (still a correct aim direction).
        this.aimTarget = new THREE.Vector3();      // world point under the crosshair
        this.aimOrigin = new THREE.Vector3();      // camera world position the ray starts from
        this.aimDir = new THREE.Vector3(0, 0, -1); // unit camera-forward (crosshair direction; carries shake/wobble)
        this.aimDirRaw = new THREE.Vector3(0, 0, -1); // FX-FREE look forward (pure yaw*pitch) — for cosmetic head-aim
        this.aimTargetValid = false;               // true => the ray hit something (else far fallback)
        this.aimDistance = 0;                      // metres from the camera to the (smoothed) aim target
        this.aimMaxDistance = 150;                 // far fallback distance when nothing is hit (m)
        // The aim DISTANCE is low-passed while the DIRECTION stays instant. Sweeping the crosshair
        // across an edge (near pillar -> far background) makes the raw hit point jump in DEPTH; because
        // the visible barrel points AT that point, a raw depth jump would swing the gun + support arm
        // hard for a few frames (parallax is depth-sensitive). Easing only the distance kills that jerk
        // while keeping lateral aim fully responsive (the direction is the live crosshair). The actual
        // shot still uses the exact instantaneous hit (Weapon.Raycast), so accuracy is unaffected and a
        // steady aim still converges the barrel exactly on the target.
        // Depth ease rate (1/s). The visible barrel points AT aimTarget, so a raw hit-depth JUMP as the
        // crosshair sweeps a near/far edge — which happens constantly WHILE TURNING — swings the muzzle
        // (it is offset from the camera, so the muzzle->point direction is depth/parallax sensitive) and
        // reads as the gun/arms "strobing" on a turn. Easing the depth lower-passes that swing; kept
        // responsive enough that a steady aim still converges the barrel on the target. The SHOT uses
        // the exact instantaneous hit (Weapon.Raycast), so accuracy is unaffected by this smoothing.
        this.aimDistLerp = 6;
        this._aimDistSmooth = 0;                   // low-passed aim distance
        this._aimDistSeeded = false;               // seed on first use so it doesn't ease in from 0
        this._aimNear = new THREE.Vector3();       // scratch: near-plane crosshair point
        this._aimFar = new THREE.Vector3();        // scratch: far-plane crosshair point
        this._aimHit = { intersectionPoint: new THREE.Vector3(), intersectionNormal: new THREE.Vector3() };

        // --- First-person camera: rides the body's head bone (same character), with
        // the head mesh hidden by the camera's near plane ("cull distance"). ---
        this.body = null;               // PlayerBody, queried for the head-bone position
        this.fpsEyeForward = 0.14;      // nudge the eye ahead of the head bone...
        this.fpsEyeUp = 0.08;           // ...and up a touch, onto the real eye line
        this.fpsNear = 0.18;            // near plane that culls the head at the eye
        this.tpsNear = 0.01;            // crisp near for the third-person boom (set in Initialize)
        this._headPos = new THREE.Vector3();

        // --- TPS spring-arm "spline" collision (simple & glitch-free). The camera rides a
        // straight SPLINE from the centred pivot (above the head) out to the over-the-shoulder
        // REST point. Collision only ever slides the camera ALONG that line — closer to the
        // pivot or further out — NEVER sideways. Because every point on the line shares one
        // direction from the pivot, the character keeps the SAME on-screen framing at any boom
        // length (it just scales up as the camera nears), so a wall pulling the camera in can
        // never swing the character across the screen — there is nothing lateral to "centre".
        // A swept sphere (radius camRadius) finds how far out the camera can sit; the camera
        // pulls IN to it IMMEDIATELY (so it can never slide through a wall while moving) and
        // eases back OUT, so it tracks cover crisply yet still glides out when the wall clears.
        this.camRadius = 0.24;          // sphere radius for the spline collision sweep (metres)
        // Dolly response is ASYMMETRIC: pulling IN (a wall encroaching) is INSTANT so the camera
        // keeps up with walking/running toward cover and never lags into geometry — with the
        // spline this is a pure dolly, so it reads as a quick close-up, not a swing. Pulling OUT
        // (a wall clearing) eases at boomReturnRate so it glides back rather than popping.
        this.boomReturnRate = 10.0;     // pull-OUT ease toward the rest length (1/s); pull-IN is instant
        this._curT = 1;                 // smoothed 0..1 position ALONG the pivot->rest spline (1 = fully out)
        this._camDist = this.tpsDistance; // live camera->pivot distance (m); drives CameraProximity
        this._camTarget = new THREE.Vector3();  // (first-person eye target)
        this._camInit = false;
        this._free = new THREE.Vector3();       // scratch: over-the-shoulder rest point (far end of the spline)
        this._sweepRes = { point: new THREE.Vector3(), normal: new THREE.Vector3(), fraction: 1 };

        // --- Near-plane "close-mesh cull". As the camera dollies in toward the character the
        // near clip plane is pushed OUT, so meshes very close to the lens (the character it is
        // tucked behind, a wall it is pressed against) are clipped away instead of smearing
        // across the view. Crisp (tpsNear) at rest; grows to tpsNearMax once the camera is in
        // at tpsMinDistance, back to tpsNear past tpsNearGrowDist.
        this.tpsNearMax = 0.45;         // near plane (m) when the camera is dollied fully in
        this.tpsNearGrowDist = 1.5;     // camera-to-pivot distance (m) at/above which the near plane returns to tpsNear

        // --- Sprint pullback. Running pulls the boom back a little for a faster, more
        // cinematic sense of speed. Eased on its own gentle rate so it breathes in/out
        // rather than snapping when the player starts/stops sprinting.
        this.tpsSprintExtra = 0.7;      // extra boom length while sprinting (m)
        this.sprintLerpSpeed = 3.5;     // gentle ease for the sprint pullback (1/s)
        this._curSprint = 0.0;          // smoothed sprint extension

        // --- Collision FOV. The camera NEVER imposes any rotation to dodge geometry; the
        // only thing it may do is dolly along the look axis — pull away or push IN toward
        // the player (down to a first-person POV at the extreme, which we try to avoid but
        // allow). When collision PUSHES the boom in, we open the FOV a little so the closer
        // shot feels less claustrophobic and reveals more around the character. Suspended
        // while aiming, where the precise-aim zoom FOV must stay exact.
        this.collisionFovExtra = 12;    // extra degrees of FOV at a full collision push-in

        // --- High-angle pull-back. The further DOWN the camera looks, the further the boom
        // pulls back & up into a high overhead view, opening a gap so objects can travel
        // between the camera and the character. This only raises the DESIRED length —
        // collision still clamps it to the clearance, so it never trades away no-clip.
        //
        // The response is an EASE-OUT of the down angle (not the old ease-in square): pull-back
        // is PRIVILEGED — it engages strongly the instant the camera tilts even slightly down,
        // then ramps progressively to full, instead of staying flat until a steep angle and then
        // snapping back. Its own gentle ease (lookDownLerpSpeed, slower than the aim zoom) makes
        // the pull-back↔push-in transition glide rather than jump as you sweep the pitch.
        this.tpsLookDownExtra = 1.9;    // extra boom length at full look-down (m) — pull back
        this.lookDownLerpSpeed = 4.0;   // gentle ease for the look-down pull-back (1/s) — progressive
        this._curLookDown = 0;          // eased look-down boom extra (m)

        // --- Camera shake / recoil ("juice"): a subtle trauma-driven shake on taking
        // a hit and a tiny kick per shot. Kept ROTATION-ONLY (no positional shake) and
        // small, applied on top of the look orientation so the crosshair stays put. ---
        this._fxTime = 0.0;
        this.trauma = 0.0;              // 0..1; decays each frame
        this.traumaDecay = 2.0;        // trauma/sec (settles a touch quicker so hits don't linger as a shake)
        this.maxShakeRot = 0.009;      // radians at full trauma (small rotation only) — trimmed for less buzz
        this.recoilPitch = 0.0;        // transient view kick, recovers to 0
        this.recoilYaw = 0.0;
        this.recoilRecover = 11.0;     // 1/s settle rate (snappier recovery, less lingering wobble)
        // Precise aim must stay STEADY: while ADS the trauma shake + per-shot recoil kick are scaled
        // DOWN (not off — a hair of gun kick still reads) so the crosshair doesn't jitter while you
        // line up / hold a shot. The user's "camera shakes while aiming + shooting" complaint is this —
        // damped hard so sustained ADS fire stays calm (a clean, barely-there kick, not a buzz).
        this.aimShakeDamp = 0.16;
        this._shakeEuler = new THREE.Euler();
        this._shakeQuat = new THREE.Quaternion();

        // --- Aim-move wobble (TPS). While AIMING AND MOVING the body's hips are stabilized
        // (PlayerBody.StabilizeHips) for a steady aim, which reads unnaturally still in motion.
        // Add a gentle, footfall-paced sway to the VIEW so movement still registers. Rotation-only
        // (like the shake) so the reticle stays anchored. Scales mostly off an eased on/off weight
        // (so the deliberately-slow aim walk still conveys) plus a little speed.
        this._aimWobbleW = 0;                                  // eased 0..1 weight (aiming & moving)
        this.aimWobbleLerp = 6;                                // ease in/out rate (1/s)
        // Kept DELIBERATELY small: this exists only so the slow ADS walk doesn't read as a frozen
        // glide, but at the old 1.1° it presented as the "camera shakes when aiming" the user flagged.
        // Trimmed to a barely-there footfall breath — the aim stays steady enough to hold a shot.
        this.aimWobbleAmount = THREE.MathUtils.degToRad(0.4);  // peak roll sway (rad); pitch/yaw scale off this
        this.aimWobbleFreq = 5.0;                              // base stride frequency for the sway
        this._wobbleEuler = new THREE.Euler();
        this._wobbleQuat = new THREE.Quaternion();

        // --- Directional dodge roll (double-tap a movement key: W/A/S/D). A short, committed burst in
        // the tapped key's direction with an invulnerability window, driven by the roll animation on
        // PlayerBody. Maintains momentum (drives the capsule at rollSpeed, eased out near the end) and
        // ALWAYS releases control when the timer elapses, so it can never lock the player. Works in TPS
        // and FPS (same body anim; the FP camera rides the head bone through the roll). See UpdateRoll.
        // (Moved OFF double-tap Ctrl: that collides with OS-level shortcuts — PowerToys "Find My
        // Mouse", IME/accessibility toggles — which a web page can't suppress.)
        this.rolling = false;
        this.rollTimer = 0.0;
        this.rollDuration = 0.78;        // s of locked roll movement (~ the 0.97s clip at 1.25x)
        this.rollSpeed = 10.0;           // forward m/s at the start of the roll (boosted momentum)
        this.rollEndSpeedFactor = 0.55;  // speed multiplier by the end of the roll (eases out)
        // Front-loaded impulse: a short, fast surge of EXTRA speed in the very first slice of the roll
        // so it kicks off with a satisfying pop/lunge, then settles into the normal eased momentum
        // within ~0.1 s. Shapes the per-frame roll velocity (a one-shot velocity impulse would be
        // overwritten next frame, since UpdateRoll re-sets the linear velocity each tick).
        this.rollImpulseBoost = 0.6;     // peak extra fraction of rollSpeed at the very start (u=0)
        this.rollImpulseDecay = 9.0;     // how fast the surge decays over normalized roll progress u
        this.rollCooldown = 0.18;        // s after a roll before another can start (prevents chaining)
        this._rollCooldownTimer = 0.0;
        this.rollDir = new THREE.Vector3();   // world-horizontal roll direction (camera forward)
        this._rollResidual = new THREE.Vector3();   // scratch: world roll velocity
        this._yawInv = new THREE.Quaternion();      // scratch: inverse look-yaw (world->local)
        // Invulnerability window. Because the whole roll is a COMMITTED, control-locked dodge (you
        // can't act until it releases), i-frames cover essentially the entire window: they start on
        // the very first frame (0.0) so a reactive roll into an incoming hit is trustworthy, and run
        // to rollIFrameEnd — just shy of the release — leaving only a tiny actionable recovery sliver
        // vulnerable. PlayerHealth checks this.invulnerable. Not exploitable: the double-tap + cooldown
        // + grounded checks gate it. 0..rollDuration.
        this.invulnerable = false;
        this.rollIFrameStart = 0.0;
        this.rollIFrameEnd = 0.70;
        // Double-tap detection for a MOVEMENT key (W/A/S/D). Input only reports held state, so we
        // edge-detect each key; a second tap of the SAME key inside doubleTapWindow fires a roll in
        // that key's (camera-relative) direction. Kept fairly tight so an ordinary quick re-tap while
        // moving rarely triggers an accidental dodge (the cooldown backs this up).
        this._moveKeys = ['KeyW', 'KeyS', 'KeyA', 'KeyD'];
        this._moveKeyPrev = { KeyW: 0, KeyS: 0, KeyA: 0, KeyD: 0 };
        this._lastTapKey = null;         // movement key whose first tap is awaiting a second
        this._lastTapTime = -10.0;       // _tapClock time of that first tap
        this.doubleTapWindow = 0.28;     // s between the two taps to count as a double-tap
        this._tapClock = 0.0;            // monotonic clock for tap timing (advanced each Update)
    }

    Initialize(){
        this.physicsComponent = this.GetComponent("PlayerPhysics");
        this.physicsBody = this.physicsComponent.body;
        this.physicsWorld = this.physicsComponent.world; // for the TPS boom raycast
        this.body = this.GetComponent('PlayerBody');     // head-bone eye in first-person
        this.transform = new Ammo.btTransform();
        this.zeroVec = new Ammo.btVector3(0.0, 0.0, 0.0);
        this.angles.setFromQuaternion(this.parent.Rotation);
        this.UpdateRotation();

        Input.AddMouseMoveListner(this.OnMouseMove);

        // Capture the resting FOV so precise-aim can zoom from / back to it.
        this.baseFov = this.camera.fov;
        this._curFov = this.camera.fov;

        // Remember the crisp third-person near plane, then apply the near for the
        // starting mode (FPS uses a larger near to cull the head mesh at the eye).
        this.tpsNear = this.camera.near;
        this.ApplyNearForMode();

        // Camera juice: shake on taking a hit, a kick per shot fired.
        this.parent.RegisterEventHandler(this.OnPlayerHit, 'hit');
        this.parent.RegisterEventHandler(this.OnWeaponShoot, 'weapon.shoot');

        // Right click holds precise-aim. (In FPS the arms viewmodel runs its own ADS
        // via Hands; this TPS aim only applies in the TPS camera branch below.)
        Input.AddMouseDownListner(e => { if(e.button === 2){ this.aiming = true; this._aimHeld = true; } });
        Input.AddMouseUpListner(e => { if(e.button === 2){ this.aiming = false; this._aimHeld = false; } });

        document.addEventListener('pointerlockchange', this.OnPointerlockChange)

        Input.AddClickListner( () => {
            if(!this.isLocked){
                document.body.requestPointerLock();
            }
        });
    }

    OnPointerlockChange = () => {
        if (document.pointerLockElement) {
            this.isLocked = true;
            return;
        }

        this.isLocked = false;
    }

    OnMouseMove = (event) => {
        if (!this.isLocked || this.cameraOverride) {
          return;
        }

        const { movementX, movementY } = event

        // Finer aim while holding precise-aim in third-person.
        const sens = (this.cameraMode === 'TPS' && this.aiming)
            ? this.mouseSpeed * this.aimSensitivity
            : this.mouseSpeed;

        this.angles.y -= movementX * sens;
        this.angles.x -= movementY * sens;

        this.angles.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.angles.x));

        this.UpdateRotation();
    }

    UpdateRotation(){
        this.pitch.setFromAxisAngle(this.xAxis, this.angles.x);
        this.yaw.setFromAxisAngle(this.yAxis, this.angles.y);

        // parent.Rotation is the single look orientation (yaw*pitch). The camera
        // is positioned/oriented from it each frame in Update, per camera mode, so
        // we no longer write camera.quaternion here.
        this.parent.Rotation.multiplyQuaternions(this.yaw, this.pitch).normalize();
    }

    ToggleCamera(){
        this.cameraMode = this.cameraMode === 'TPS' ? 'FPS' : 'TPS';
        // Drop aim on a mode switch; reseed the smoothed FOV from the live camera so
        // re-entering TPS doesn't jump (FPS ADS, owned by Hands, may have changed it).
        this.aiming = false;
        this._curFov = this.camera.fov;
        // The two modes place the camera in very different spots (head vs spline), so
        // snap to the new spot next frame rather than flying the camera through the
        // body, and swap the near plane (FPS culls the head).
        this._camInit = false;
        this.ApplyNearForMode();
        this.Broadcast({topic: 'camera.mode', mode: this.cameraMode});
        const label = document.getElementById('camera_mode');
        if(label){ label.textContent = this.cameraMode; }
    }

    ApplyNearForMode(){
        this.camera.near = this.cameraMode === 'FPS' ? this.fpsNear : this.tpsNear;
        this.camera.updateProjectionMatrix();
    }

    // --- Camera juice hooks ---
    // Getting hit: a SMALL, quickly-settling shake — rotation ONLY (ApplyCameraShake never moves
    // the camera in space). Kept gentle: a bigger trauma read as a lurch/recoil "pull back". Tune.
    OnPlayerHit = () => { this.AddTrauma(0.25); }
    OnWeaponShoot = () => { this.AddRecoil(); }

    AddTrauma(amount){ this.trauma = Math.min(1.0, this.trauma + amount); }

    AddRecoil(){
        // Mostly a clean vertical kick; only a hair of horizontal jitter. Less trauma per shot so
        // sustained auto-fire doesn't pile into a buzzing view (it reads as a firm kick, not a shake).
        this.trauma = Math.min(1.0, this.trauma + 0.012);
        this.recoilPitch += 0.005;                          // small kick up (the main feedback)
        this.recoilYaw += (Math.random() - 0.5) * 0.0014;   // very slight horizontal jitter
    }

    // Apply trauma-driven shake + the per-shot recoil kick on top of the look
    // orientation, then decay both. Keeps the crosshair fixed while the view shakes.
    ApplyCameraShake(t){
        this.trauma = Math.max(0.0, this.trauma - this.traumaDecay * t);
        const settle = Math.exp(-this.recoilRecover * t);
        this.recoilPitch *= settle;
        this.recoilYaw *= settle;

        // Steady the view while aiming: scale the whole shake + recoil contribution down so a precise
        // aim doesn't jitter (the crosshair, the gun barrel IK and the shot all read off this view).
        const steady = this.aiming ? this.aimShakeDamp : 1.0;
        const shake = this.trauma * this.trauma * steady;   // ease-in so light trauma is subtle
        const f = this._fxTime;
        const recoilP = this.recoilPitch * steady;
        const recoilY = this.recoilYaw * steady;

        // Rotation-only shake (no positional offset) so the camera never lurches in
        // space — just a small, quickly-settling jitter of the view angle, plus the
        // per-shot recoil kick.
        const rp = (shake > 0.0001 ? Math.sin(f * 59.0) * shake * this.maxShakeRot : 0) + recoilP;
        const ry = (shake > 0.0001 ? Math.sin(f * 43.0 + 0.5) * shake * this.maxShakeRot : 0) + recoilY;
        const rz = shake > 0.0001 ? Math.sin(f * 67.0 + 1.1) * shake * this.maxShakeRot * 0.6 : 0;
        if(rp || ry || rz){
            this._shakeEuler.set(rp, ry, rz);
            this._shakeQuat.setFromEuler(this._shakeEuler);
            this.camera.quaternion.multiply(this._shakeQuat);
        }
    }

    // While AIMING AND MOVING in TPS, add a gentle footfall-paced sway to the view. The aim pose
    // stabilizes the hips, so without this the moving aim reads too still; this puts a little
    // movement back into the camera. Rotation-only (composed on top of the look) so the crosshair
    // stays anchored. Eased in/out so entering/leaving aim or stopping glides rather than pops.
    ApplyAimMoveWobble(t){
        const moving = this.HorizontalSpeed > 0.5 && this.IsGrounded;
        const active = (this.cameraMode === 'TPS' && this.aiming && moving) ? 1 : 0;
        this._aimWobbleW += (active - this._aimWobbleW) * (1 - Math.exp(-this.aimWobbleLerp * t));
        if(this._aimWobbleW < 0.001){ return; }

        // Mostly the eased weight (the aim walk is intentionally slow) plus a touch more the faster
        // you go, so a sprint-aim conveys a bit harder than a creep.
        const speedRatio = THREE.MathUtils.clamp(this.HorizontalSpeed / this.walkSpeed, 0, 1.6);
        const amp = this.aimWobbleAmount * (0.6 + 0.4 * speedRatio) * this._aimWobbleW;
        const f = this._fxTime * this.aimWobbleFreq * (0.7 + 0.3 * speedRatio);

        // Footfall feel: vertical bob at 2x the stride; lateral roll + a little yaw at the stride.
        const rp = Math.sin(f * 2.0) * amp * 0.6;   // pitch bob (up/down per footfall)
        const rz = Math.sin(f) * amp;               // roll sway (side to side per stride)
        const ry = Math.cos(f) * amp * 0.4;         // slight yaw drift
        this._wobbleEuler.set(rp, ry, rz);
        this._wobbleQuat.setFromEuler(this._wobbleEuler);
        this.camera.quaternion.multiply(this._wobbleQuat);
    }

    // Place the first-person eye on the body's head bone (+ a small forward/up nudge onto the eye
    // line), flooring the height during a roll so the somersault dips hard but never clips the floor.
    //
    // STROBE FIX. Components update Controls-BEFORE-Body, so the eye placed during UpdateCamera reads
    // the head bone from LAST frame's pose while the gun/arms render at THIS frame's — a one-frame
    // desync that reads as the viewmodel strobing/juddering against the view when you turn. PlayerBody
    // re-calls this at the END of its Update (after it has posed the body), so the eye and the gun it
    // holds are locked to the same frame. Reading the head bone (animation), not the camera, so there
    // is no feedback loop. capPos is the capsule eye position (Player.Position).
    PlaceFpsEyePosition(capPos){
        if(this.cameraMode !== 'FPS' || !this.camera){ return; }
        this._fwd.copy(this._fwdBase).applyQuaternion(this.parent.Rotation);
        if(this.body && this.body.GetHeadWorldPosition(this._headPos)){
            this._camTarget.copy(this._headPos)
                .addScaledVector(this._fwd, this.fpsEyeForward);
            this._camTarget.y += this.fpsEyeUp;
        }else{
            this._camTarget.copy(capPos);
        }
        if(this.rolling){
            this._camTarget.y = Math.max(this._camTarget.y, capPos.y - 0.45);
        }
        this.camera.position.copy(this._camTarget);
    }

    // Place the camera for the current mode. capPos is the capsule-tracked
    // position (eye height); it is also Player.Position so NPC targeting/raycasts
    // are camera-mode-independent.
    UpdateCamera(capPos, t = 0.016){
        this._fxTime += t;

        if(this.cameraMode === 'FPS'){
            // Same character as third-person: the eye rides the mesh's head bone, so the walk/run
            // animation gives a subtle, real head bob. PlaceFpsEyePosition sets the eye position; it is
            // also re-called by PlayerBody AFTER it has posed the body this frame (see the note there)
            // so the eye stays locked to the SAME-frame head — without that re-call the eye reads last
            // frame's pose (Controls update before Body) and the gun/arms strobe against it on a turn.
            this.PlaceFpsEyePosition(capPos);
            this._camInit = true;
            this.camera.quaternion.copy(this.parent.Rotation);
            this.ApplyCameraShake(t);
            this._camDist = this.tpsDistance;   // FPS: report "far" so TPS-only proximity logic is inert
            return;
        }

        // Pitch as a normalised factor: -1 looking straight down, +1 straight up.
        // downN ramps 0 (level/up) -> 1 (straight down) and drives the high-angle behaviour.
        const pitchN = THREE.MathUtils.clamp(this.angles.x / (Math.PI * 0.5), -1, 1);
        const downN = Math.max(0, -pitchN);

        // Sprint pullback: ease an extra boom length in/out on its own gentle rate while
        // running (suspended while aiming so precise-aim stays tight). Folded into the
        // distance target below, so it rides the same smooth path as everything else.
        const sprintTarget = (this.isSprinting && !this.aiming) ? this.tpsSprintExtra : 0;
        this._curSprint += (sprintTarget - this._curSprint) * (1 - Math.exp(-this.sprintLerpSpeed * t));

        // Looking DOWN pulls the boom back & up into a high-angle view, opening a gap so objects
        // can pass between the camera and the character rather than being shoved against the lens.
        // EASE-OUT of the down angle (downN*(2-downN)) so the pull-back is privileged — it kicks
        // in noticeably at a small down pitch and ramps progressively to full, instead of the old
        // ease-in square that stayed flat until a steep angle and then snapped. It rides its OWN
        // gentle ease (below) so sweeping the pitch glides between pulled-back and pushed-in.
        const lookDownExtra = downN * (2.0 - downN) * this.tpsLookDownExtra;
        this._curLookDown += (lookDownExtra - this._curLookDown) * (1 - Math.exp(-this.lookDownLerpSpeed * t));

        // Ease the boom length / shoulder offset / FOV toward their precise-aim or
        // hip targets so toggling right click glides in and out of the zoom.
        const k = Math.min(1, t * this.aimLerpSpeed);
        const targetDistance = (this.aiming ? this.tpsAimDistance : this.tpsDistance) + this._curSprint;
        const targetShoulder = this.aiming ? this.tpsAimShoulder : this.tpsShoulder;
        const targetFov      = this.aiming ? this.tpsAimFov      : this.baseFov;
        this._curDistance += (targetDistance - this._curDistance) * k;
        this._curShoulder += (targetShoulder - this._curShoulder) * k;
        this._curFov      += (targetFov      - this._curFov)      * k;
        // Total rest boom = the (aim/sprint) length plus the smoothly-eased look-down pull-back.
        const boom = this._curDistance + this._curLookDown;
        // FOV is applied AFTER the boom length is resolved (below), so a collision
        // push-in can widen it.

        // TPS spring-arm spline. The camera rides a straight line from the CENTRED pivot
        // (above the head) out to the over-the-shoulder REST point; collision only ever dollies
        // it ALONG that line — closer or further — never sideways. Every point on the line
        // shares one direction from the pivot, so the character keeps its framing at any boom
        // length (it just scales as the camera nears): nothing lateral to "centre", nothing to
        // swing, no glitch.
        this._fwd.copy(this._fwdBase).applyQuaternion(this.parent.Rotation);
        this._right.copy(this._rightBase).applyQuaternion(this.parent.Rotation);
        this._pivot.copy(capPos);
        this._pivot.y += this.tpsPivotHeight;   // CENTRED pivot — start of the spline
        // Far end of the spline: behind by the (aim/sprint + look-down) distance + over the shoulder.
        this._free.copy(this._pivot)
            .addScaledVector(this._fwd, -boom)
            .addScaledVector(this._right, this._curShoulder);

        // Sweep a sphere from the pivot to the rest point; the hit fraction is how far out the
        // camera may sit along the line (0..1). No static hit => fully out (1).
        let safeT = 1;
        if(this.physicsWorld && AmmoHelper.SphereSweep(
            this.physicsWorld, this.camRadius, this._pivot, this._free, this._sweepRes, CollisionFilterGroups.StaticFilter)
            && this._sweepRes.fraction < 1){
            safeT = this._sweepRes.fraction;
        }
        // Floor the dolly so the camera never comes closer to the pivot than tpsMinDistance —
        // it HOLDS back rather than jamming into the head (the body dither + near cull cover the
        // close shot). Expressed as the matching fraction along this spline's length.
        const splineLen = Math.max(0.001, this._pivot.distanceTo(this._free));
        const minT = Math.min(1, this.tpsMinDistance / splineLen);
        const targetT = Math.max(safeT, minT);
        // Dolly toward the target. Pull IN (targetT below where we are — a wall encroaching) is
        // INSTANT so the camera keeps up with walking/running into cover and can never slide
        // through geometry; pull OUT (the wall clearing) eases so it glides back rather than
        // popping. With the spline the in-snap is a pure dolly — the framing never moves — so it
        // does not read as the old lateral "jump".
        if(!this._camInit || targetT < this._curT){
            this._curT = targetT;
            this._camInit = true;
        }else{
            this._curT += (targetT - this._curT) * (1 - Math.exp(-this.boomReturnRate * t));
        }

        // Position: slide the camera along the spline by the lagged dolly param.
        this.camera.position.copy(this._pivot).lerp(this._free, this._curT);
        // Orientation is ALWAYS exactly the player's look (yaw*pitch) — the camera never imposes
        // any pitch/yaw/roll of its own; collision only dollies it along the spline above. lookAt
        // is intentionally NOT used: with the shoulder offset it would tilt the view sideways.
        this.camera.quaternion.copy(this.parent.Rotation);

        // Collision push-in widens the FOV a touch (never while aiming): the further the dolly
        // is drawn in along the spline (1 - _curT), the more FOV eases in, softening the close
        // shot. Driven by the already-lagged dolly param, so it glides.
        let fov = this._curFov;
        if(!this.aiming){
            const pushIn = THREE.MathUtils.clamp(1 - this._curT, 0, 1);
            fov += pushIn * this.collisionFovExtra;
        }
        this.camera.fov = fov;

        // Close-mesh cull: push the near plane OUT as the camera nears the character, so meshes
        // very close to the lens are clipped rather than smeared across the view. Mapped from the
        // camera's distance to the pivot — tpsNearMax at tpsMinDistance, tpsNear by tpsNearGrowDist.
        const camDist = this._curT * splineLen;
        this._camDist = camDist;   // expose the live camera->pivot distance for CameraProximity
        this.camera.near = THREE.MathUtils.clamp(
            THREE.MathUtils.mapLinear(camDist, this.tpsMinDistance, this.tpsNearGrowDist, this.tpsNearMax, this.tpsNear),
            this.tpsNear, this.tpsNearMax);
        this.camera.updateProjectionMatrix();

        this.ApplyAimMoveWobble(t);
        this.ApplyCameraShake(t);
    }

    // Resolve the world point under the crosshair by casting the SAME camera-centre ray the weapon
    // fires (Weapon.Raycast: screen-centre near->far unproject). Stored on this.aimTarget for the
    // weapon-alignment + hand IK (PlayerBody/WeaponAimIK) so the visible barrel points exactly where
    // the bullet goes. Runs AFTER the camera is placed each frame, with the camera matrix refreshed
    // so the unproject is current (no one-frame lag). No self-filter: the ray is identical to the
    // shot, so the aim target is exactly the shot's hit point. Cheap: one physics raycast per frame
    // (the boom already sweeps a sphere every frame).
    UpdateAimTarget(t = 0.016){
        if(!this.physicsWorld || !this.camera){ return; }
        this.camera.updateMatrixWorld();
        this.camera.getWorldPosition(this.aimOrigin);
        // Crosshair ray: NDC centre at the near and far planes, unprojected to world space.
        this._aimNear.set(0, 0, -1).unproject(this.camera);
        this._aimFar.set(0, 0, 1).unproject(this.camera);
        this.aimDir.copy(this._aimFar).sub(this._aimNear);
        if(this.aimDir.lengthSq() < 1e-12){ this.aimDir.set(0, 0, -1).applyQuaternion(this.camera.quaternion); }
        this.aimDir.normalize();
        // FX-free crosshair direction from the PURE look orientation (parent.Rotation = yaw*pitch). The
        // camera quaternion above carries the shake + ADS-walk wobble (applied in UpdateCamera); aimDir
        // therefore jitters with them. The cosmetic head-aim consumes aimDirRaw so the head doesn't
        // inherit that view jitter, while the gun/shot keep using the FX-affected aimDir/aimTarget.
        this.aimDirRaw.set(0, 0, -1).applyQuaternion(this.parent.Rotation).normalize();

        const mask = CollisionFilterGroups.AllFilter & ~CollisionFilterGroups.SensorTrigger;
        let rawDist;
        if(AmmoHelper.CastRay(this.physicsWorld, this._aimNear, this._aimFar, this._aimHit, mask)){
            rawDist = this.aimOrigin.distanceTo(this._aimHit.intersectionPoint);
            this.aimTargetValid = true;
        }else{
            // Nothing hit: aim a far point straight down the crosshair (still a correct DIRECTION).
            rawDist = this.aimMaxDistance;
            this.aimTargetValid = false;
        }
        // Low-pass the DEPTH only; the direction (aimDir) stays the live crosshair. aimTarget rides the
        // crosshair laterally with no lag, but glides along the ray when the hit depth jumps at an edge.
        if(!this._aimDistSeeded){ this._aimDistSmooth = rawDist; this._aimDistSeeded = true; }
        else{ this._aimDistSmooth += (rawDist - this._aimDistSmooth) * (1 - Math.exp(-this.aimDistLerp * t)); }
        this.aimDistance = this._aimDistSmooth;
        this.aimTarget.copy(this.aimOrigin).addScaledVector(this.aimDir, this._aimDistSmooth);
    }

    Accelarate = (direction, t) => {
        const accel = this.tempVec.copy(direction).multiplyScalar(this.acceleration * t);
        this.speed.add(accel);
        this.speed.clampLength(0.0, this.maxSpeed);
    }

    Deccelerate = (t) => {
        const frameDeccel = this.tempVec.copy(this.speed).multiplyScalar(this.decceleration * t);
        this.speed.add(frameDeccel);
    }

    // Hand camera control to a dev tool (or take it back). While overridden the
    // player is frozen in place and the camera is left for the tool to drive.
    SetCameraOverride(on){
        this.cameraOverride = on;
    }

    // Edge-detect the movement keys and start a directional roll on a double-tap of the SAME key
    // inside doubleTapWindow. Input only reports HELD state, so we track each key's previous frame to
    // find press edges and time the gap.
    UpdateRollInput(){
        for(const code of this._moveKeys){
            const down = Input.GetKeyDown(code);
            if(down && !this._moveKeyPrev[code]){
                if(this._lastTapKey === code && (this._tapClock - this._lastTapTime) <= this.doubleTapWindow){
                    this._lastTapKey = null;                 // consume the pair so a third tap can't re-fire
                    this.TryStartRoll(code);
                }else{
                    this._lastTapKey = code;                 // first tap (or a different key): arm it
                    this._lastTapTime = this._tapClock;
                }
            }
            this._moveKeyPrev[code] = down;
        }
    }

    // Start a roll only from the ground and outside the cooldown (no air-dodge / no chaining). The
    // roll travels in the double-tapped key's direction, in the camera's horizontal frame: W forward,
    // S back, D/A strafe; falls back to camera-forward.
    TryStartRoll(dirCode){
        if(this.rolling || this._rollCooldownTimer > 0 || !this.IsGrounded){ return; }
        // Couple the control-lock length to the ACTUAL roll clip length at its played-back rate, so
        // retuning the body's rollTimeScale or swapping RollForward.glb keeps movement, i-frames and
        // animation in lockstep (instead of a hand-tuned constant silently drifting from the clip).
        if(this.body && this.body._rollDuration > 0 && this.body.rollTimeScale > 0){
            this.rollDuration = this.body._rollDuration / this.body.rollTimeScale;
        }
        this.rolling = true;
        this.rollTimer = 0.0;
        this.aiming = false;                                 // a roll drops precise-aim
        // Roll direction from the tapped key, in the camera's horizontal frame (tempVec/moveDir are
        // free scratch here: a rolling frame returns before the normal movement path uses them).
        const fwd = this.tempVec.set(0, 0, -1).applyQuaternion(this.yaw);
        const right = this.moveDir.set(1, 0, 0).applyQuaternion(this.yaw);
        if(dirCode === 'KeyS'){ this.rollDir.copy(fwd).negate(); }
        else if(dirCode === 'KeyD'){ this.rollDir.copy(right); }
        else if(dirCode === 'KeyA'){ this.rollDir.copy(right).negate(); }
        else{ this.rollDir.copy(fwd); }                      // KeyW / fallback
        this.rollDir.y = 0;
        if(this.rollDir.lengthSq() < 1e-6){ this.rollDir.copy(fwd); this.rollDir.y = 0; }
        this.rollDir.normalize();
        this.Broadcast({topic: 'player.roll'});              // PlayerBody plays the roll animation
    }

    // Drive the roll each frame: a forward velocity burst (eased out toward the end) with an
    // i-frame window, then release control back to the normal movement path. ALWAYS ends on the
    // timer so the player can never get locked. Mirrors the normal capsule/camera placement.
    UpdateRoll(t){
        this.rollTimer += t;
        const u = Math.min(1.0, this.rollTimer / this.rollDuration);
        this.invulnerable = (this.rollTimer >= this.rollIFrameStart && this.rollTimer <= this.rollIFrameEnd);

        // Forward momentum from rollSpeed easing down to rollSpeed*endFactor across the roll, with a
        // brief front-loaded surge (decays over the first ~0.1 s of u) so the roll launches with a pop.
        const burst = 1 + this.rollImpulseBoost * Math.exp(-this.rollImpulseDecay * u);
        const speed = this.rollSpeed * (1 - (1 - this.rollEndSpeedFactor) * u) * burst;
        const velocity = this.physicsBody.getLinearVelocity();
        velocity.setX(this.rollDir.x * speed);
        velocity.setZ(this.rollDir.z * speed);
        this.physicsBody.setLinearVelocity(velocity);
        this.physicsBody.setAngularVelocity(this.zeroVec);
        // Mirror the roll velocity into the LOCAL (pre-yaw) speed so HorizontalSpeed reports the
        // motion AND the residual handed to the normal decel path continues along the ACTUAL world
        // travel direction (rollDir) — not a stale local vector reinterpreted against a camera the
        // player may have spun mid-roll. speed_local = yaw⁻¹ · (rollDir * speed).
        this._rollResidual.copy(this.rollDir).multiplyScalar(speed);
        this._yawInv.copy(this.yaw).invert();
        this.speed.copy(this._rollResidual).applyQuaternion(this._yawInv);

        const ms = this.physicsBody.getMotionState();
        if(ms){
            ms.getWorldTransform(this.transform);
            const p = this.transform.getOrigin();
            this._cap.set(p.x(), p.y() + this.yOffset, p.z());
            this.parent.SetPosition(this._cap);
            this.UpdateCamera(this._cap, t);
            this.UpdateAimTarget(t);
        }

        if(this.rollTimer >= this.rollDuration){
            this.rolling = false;
            this.invulnerable = false;
            this._rollCooldownTimer = this.rollCooldown;
            // Roll over: if right-click is still held, resume precise-aim (the roll dropped it in
            // TryStartRoll). Without this the camera stays un-aimed even though the button is down.
            this.aiming = this._aimHeld;
        }
    }

    Update(t){
        // Dev free-cam owns the camera: hold the player still and skip camera placement.
        if(this.cameraOverride){
            const velocity = this.physicsBody.getLinearVelocity();
            velocity.setX(0); velocity.setZ(0);
            this.physicsBody.setLinearVelocity(velocity);
            this.physicsBody.setAngularVelocity(this.zeroVec);
            const ms = this.physicsBody.getMotionState();
            if(ms){
                ms.getWorldTransform(this.transform);
                const p = this.transform.getOrigin();
                this._cap.set(p.x(), p.y() + this.yOffset, p.z());
                this.parent.SetPosition(this._cap);   // keep Player.Position valid for NPCs
            }
            return;
        }

        // Toggle TPS/FPS on a V key edge (latched so a held key fires once).
        if(Input.GetKeyDown('KeyV')){
            if(!this._vLatch){ this._vLatch = true; this.ToggleCamera(); }
        } else {
            this._vLatch = false;
        }

        // Dodge roll: watch for the double-tap, and while a roll is in progress let it OWN movement
        // (forward burst + i-frames + camera) and skip the normal input path entirely this frame.
        this._tapClock += t;
        if(this._rollCooldownTimer > 0){ this._rollCooldownTimer = Math.max(0, this._rollCooldownTimer - t); }
        this.UpdateRollInput();
        if(this.rolling){
            this.UpdateRoll(t);
            return;
        }

        const forwardFactor = Input.GetKeyDown("KeyS") - Input.GetKeyDown("KeyW");
        const rightFactor = Input.GetKeyDown("KeyD") - Input.GetKeyDown("KeyA");
        const direction = this.moveDir.set(rightFactor, 0.0, forwardFactor).normalize();

        // Sprint (hold Shift) only kicks in while running forward on the ground.
        const sprintKey = Input.GetKeyDown("ShiftLeft") || Input.GetKeyDown("ShiftRight");
        this.isSprinting = !!(sprintKey && Input.GetKeyDown("KeyW") && this.physicsComponent.canJump);
        this.maxSpeed = this.isSprinting ? this.walkSpeed * this.sprintMultiplier : this.walkSpeed;
        // Aiming = slow, deliberate movement: scale the top speed WAY down while holding aim. This
        // also suspends the sprint bonus (no sprint-aim) so the slow aim walk is consistent whether
        // or not Shift is held. The legs still read as a jog, just a slow one.
        if(this.aiming){ this.maxSpeed = this.walkSpeed * this.aimMoveMultiplier; }

        const velocity = this.physicsBody.getLinearVelocity();

        if(Input.GetKeyDown('Space') && this.physicsComponent.canJump){
            velocity.setY(this.jumpVelocity);
            this.physicsComponent.canJump = false;
            // Authoritative take-off signal for the body's jump animation. PlayerBody can't reliably
            // detect take-off from IsGrounded (canJump): we clear it THIS frame BEFORE PlayerBody
            // runs, and Input reports HELD keys, so holding Space bunny-hops on the first grounded
            // frame (inside the body's landing debounce) — without this event the body would keep
            // looping the fall pose and skip the jumpStart launch on the second hop.
            this.Broadcast({topic: 'player.jump'});
        }
        
        this.Deccelerate(t);
        this.Accelarate(direction, t);

        const moveVector = this.tempVec.copy(this.speed);
        moveVector.applyQuaternion(this.yaw);
        
        velocity.setX(moveVector.x);
        velocity.setZ(moveVector.z);

        this.physicsBody.setLinearVelocity(velocity);
        this.physicsBody.setAngularVelocity(this.zeroVec);

        const ms = this.physicsBody.getMotionState();
        if(ms){
            ms.getWorldTransform(this.transform);
            const p = this.transform.getOrigin();
            // Capsule-tracked eye position. This is Player.Position in BOTH camera
            // modes (NPCs target it), independent of where the TPS boom sits.
            this._cap.set(p.x(), p.y() + this.yOffset, p.z());
            this.parent.SetPosition(this._cap);
            this.UpdateCamera(this._cap, t);
            this.UpdateAimTarget(t);
        }

    }

    // Collision push-in: how far the spring-arm has been dollied IN from its rest length by
    // geometry (0 = fully out / no collision, →1 = jammed to the floor at tpsMinDistance). _curT
    // is the smoothed 0..1 position along the pivot→rest spline (1 = fully out), and it only drops
    // below 1 when the collision sweep pulls the camera in — so 1-_curT isolates the collision
    // dolly cleanly (aim/sprint/look-down change the boom LENGTH, not _curT). Drives the TPS body's
    // aim-yaw correction (PlayerBody) so the gun re-converges on the reticle when a wall crowds the
    // camera in close and the over-the-shoulder framing collapses.
    get CameraPushIn(){
        return THREE.MathUtils.clamp(1 - this._curT, 0, 1);
    }

    // Camera-to-character PROXIMITY, 0..1 (0 = at/over the resting boom or farther, 1 = jammed up
    // against the character at the collision floor). Reads the LIVE camera distance, so it rises
    // for aim pull-in, sprint/look-down (negative -> clamped 0), AND collision push-in alike. The
    // body uses this (with conditions) to stabilize the hips and to drive the close-range aim pose.
    get CameraProximity(){
        return THREE.MathUtils.clamp(
            (this.tpsDistance - this._camDist) / (this.tpsDistance - this.tpsMinDistance), 0, 1);
    }

    // Current horizontal move speed in m/s (used to drive the weapon bob).
    get HorizontalSpeed(){
        return this.speed.length();
    }

    get IsGrounded(){
        return this.physicsComponent ? this.physicsComponent.canJump : false;
    }
}