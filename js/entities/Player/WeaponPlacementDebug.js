import * as THREE from 'three'
import Component from '../../Component.js'
import Input from '../../Input.js'
import { WEAPON_GRIP_DEFAULT, WEAPON_GRIP_FPS_DEFAULT, WEAPON_GRIP_FPS_AIM_DEFAULT } from '../Common/UeMannequin.js'


// Live in-hand weapon placement tool. Toggle with the backquote key (`) to nudge the AK's grip
// transform by eye instead of guessing offsets in code.
//
// PER CAMERA MODE. The AK is the same mesh in first- and third-person (the FP camera rides the
// body's head bone, so FPS shows this body's gun), but each mode wants its own seat — the framing
// differs. This panel edits whichever seat is ACTIVE (it follows PlayerBody.ActiveGripMode):
//   * TPS      — open the panel in third-person.
//   * FPS      — open the panel in first-person (hip seat).
//   * FPS_AIM  — open the panel in first-person while HOLDING right click (the down-the-sights seat,
//                so you can place the weapon where you want it when aiming). The header shows FPS_AIM.
// Each seat keeps its own values, and the edit is pushed to PlayerBody (SetWeaponGripLive), which
// seats the pivot and re-syncs the aim IK, so it shows live (the IK is suspended while the panel owns
// the camera, so the gun holds still at the seat as you nudge it). Switch TPS<->FPS by closing the
// panel, pressing V, reopening; switch FPS<->FPS_AIM by holding/releasing right click.
//
// Units match WEAPON_GRIP: position in hand-local centimetres, rotation in degrees. Whatever looks
// right pastes straight back into WEAPON_GRIP (TPS) / WEAPON_GRIP_FPS (FPS) / WEAPON_GRIP_FPS_AIM
// (FPS aim) in UeMannequin.js.
//
// Keys (only while the panel is open):
//   [ ]            select previous / next field (posX..rotZ)
//   ArrowUp/Down   decrease / increase the selected field by the current step
//   ArrowLeft/Right  cycle the step size (fine <-> coarse)
//   Enter          print + copy a paste-ready grip snippet for the active mode
//   Backspace      reset the active mode to its code defaults
//
// This is a dev aid; it ships off and costs nothing until you press `.
export default class WeaponPlacementDebug extends Component{
    constructor(){
        super();
        this.name = 'WeaponPlacementDebug';
        this.active = false;
        this.pivot = null;
        this.el = null;

        // Editable state PER CAMERA MODE, in the pivot's own units: position in hand-local cm,
        // rotation in degrees (converted to the Euler radians on apply). Seeded from the code
        // defaults in Initialize.
        this.modes = {
            TPS: { pos: { x: 0, y: 0, z: 0 }, rotDeg: { x: 0, y: 0, z: 0 } },
            FPS: { pos: { x: 0, y: 0, z: 0 }, rotDeg: { x: 0, y: 0, z: 0 } },
            FPS_AIM: { pos: { x: 0, y: 0, z: 0 }, rotDeg: { x: 0, y: 0, z: 0 } },
        };

        this.fields = ['posX', 'posY', 'posZ', 'rotX', 'rotY', 'rotZ'];
        this.selected = 0;

        // Shared step index maps to a position step (cm) and a rotation step (deg).
        this.posSteps = [0.1, 0.5, 1, 2, 5];
        this.rotSteps = [1, 5, 15, 45, 90];
        this.stepIndex = 2;   // 1 cm / 15 deg

        // Free-fly camera while the panel is open: WASD to move, Q/E down/up, mouse to
        // look (Shift = faster). PlayerControls yields the camera and freezes the
        // player so you can orbit the grip and place it precisely.
        this.camPos = new THREE.Vector3();
        this.camYaw = 0;
        this.camPitch = 0;
        this.flySpeed = 4.0;     // m/s
        this.flyFast = 3.0;      // Shift multiplier
        this.lookSpeed = 0.002;
        this._q = new THREE.Quaternion();
        this._e = new THREE.Euler(0, 0, 0, 'YXZ');
        this._move = new THREE.Vector3();
        this._fwd = new THREE.Vector3();
        this._right = new THREE.Vector3();
        this._up = new THREE.Vector3(0, 1, 0);
    }

    Initialize(){
        this.body = this.GetComponent('PlayerBody');
        this.pivot = this.body ? this.body.weaponPivot : null;
        this.controls = this.GetComponent('PlayerControls');
        this.camera = this.controls ? this.controls.camera : null;

        // Seed each mode's editable state from its code default so the readout shows clean numbers
        // (e.g. 90, not a quaternion round-trip).
        this.modes.TPS = this.FromGrip(WEAPON_GRIP_DEFAULT);
        this.modes.FPS = this.FromGrip(WEAPON_GRIP_FPS_DEFAULT);
        this.modes.FPS_AIM = this.FromGrip(WEAPON_GRIP_FPS_AIM_DEFAULT);

        this.BuildPanel();
        Input.AddKeyDownListner(this.OnKeyDown);
        Input.AddMouseMoveListner(this.OnMouseMove);
    }

    // Decompose a code grip ({position, rotationEuler}) into the panel's cm/degree editable state.
    FromGrip(g){
        return {
            pos: { x: g.position.x, y: g.position.y, z: g.position.z },
            rotDeg: {
                x: THREE.MathUtils.radToDeg(g.rotationEuler.x),
                y: THREE.MathUtils.radToDeg(g.rotationEuler.y),
                z: THREE.MathUtils.radToDeg(g.rotationEuler.z),
            },
        };
    }

    // The grip currently being edited. Follows PlayerBody's ACTIVE grip mode so it tracks the aim
    // state: TPS, the FPS hip grip, or — while HOLDING right click in FPS — the FPS down-the-sights
    // grip (FPS_AIM). Falls back to the raw camera mode if the body isn't wired yet.
    Mode(){
        if(this.body && this.body.ActiveGripMode){ return this.body.ActiveGripMode(); }
        return (this.controls && this.controls.cameraMode) || 'TPS';
    }
    Cur(){ return this.modes[this.Mode()] || this.modes.TPS; }

    // Mouse drives the free-fly look only while the panel is open and the pointer is
    // locked; otherwise PlayerControls owns the mouse as usual.
    OnMouseMove = (event) => {
        if(!this.active || !this.camera || !(this.controls && this.controls.isLocked)){ return; }
        this.camYaw   -= event.movementX * this.lookSpeed;
        this.camPitch -= event.movementY * this.lookSpeed;
        this.camPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.camPitch));
    }

    OnKeyDown = (e) => {
        if(e.code === 'Backquote'){
            e.preventDefault();
            this.Toggle();
            return;
        }
        if(!this.active || !this.pivot){ return; }

        switch(e.code){
            case 'BracketLeft':
                this.selected = (this.selected + this.fields.length - 1) % this.fields.length; break;
            case 'BracketRight':
                this.selected = (this.selected + 1) % this.fields.length; break;
            case 'ArrowUp':
                this.Nudge(+1); break;
            case 'ArrowDown':
                this.Nudge(-1); break;
            case 'ArrowLeft':
                this.stepIndex = Math.max(0, this.stepIndex - 1); break;
            case 'ArrowRight':
                this.stepIndex = Math.min(this.posSteps.length - 1, this.stepIndex + 1); break;
            case 'Enter':
                this.EmitSnippet(); break;
            case 'Backspace':
                this.Reset(); break;
            default:
                return;   // let other keys through (WASD look-around still works)
        }
        e.preventDefault();
        this.Apply();
        this.Render();
    }

    Nudge(sign){
        const cur = this.Cur();
        const isRot = this.selected >= 3;
        const step = sign * (isRot ? this.rotSteps[this.stepIndex] : this.posSteps[this.stepIndex]);
        const axis = ['x', 'y', 'z'][this.selected % 3];
        if(isRot){ cur.rotDeg[axis] = +(cur.rotDeg[axis] + step).toFixed(3); }
        else      { cur.pos[axis]    = +(cur.pos[axis] + step).toFixed(3); }
    }

    Reset(){
        const m = this.Mode();
        const def = m === 'FPS_AIM' ? WEAPON_GRIP_FPS_AIM_DEFAULT
                  : m === 'FPS'     ? WEAPON_GRIP_FPS_DEFAULT
                  :                   WEAPON_GRIP_DEFAULT;
        this.modes[m] = this.FromGrip(def);
    }

    // Push the active mode's grip to PlayerBody, which seats the pivot for that mode and re-syncs the
    // aim IK base — so the nudge shows live whether or not the gun is currently aim-corrected.
    Apply(){
        if(!this.body){ return; }
        const m = this.Mode();
        const s = this.modes[m];
        this.body.SetWeaponGripLive(m, s.pos, s.rotDeg);
    }

    Toggle(){
        this.active = !this.active;
        // FPS placement keeps the REAL first-person camera + aim pose intact (so the gun is placed in its
        // true ADS framing); TPS placement uses the free-fly orbit cam. Decided from the camera mode at
        // open time (mode is only swapped with the panel closed, so it can't change mid-edit).
        const fps = !!(this.controls && this.controls.cameraMode === 'FPS');
        if(this.active){
            this.Apply();
            if(!fps){ this.SyncFlyCamFromCamera(); }
        }
        if(this.controls){
            if(fps){
                // Hold the player + camera + aim steady; latch the CURRENT aim state so the seat being
                // edited (FPS hip vs FPS_AIM) is whatever you opened the panel in (hold right-click on open
                // for FPS_AIM) and can't flip while you nudge.
                this.controls.SetPlacementHold(this.active, this.active ? !!this.controls.aiming : false);
            }else{
                this.controls.SetCameraOverride(this.active);   // TPS: free-fly orbit
            }
        }
        this.el.style.display = this.active ? 'block' : 'none';
        this.Render();
    }

    // Seed the fly-cam yaw/pitch/position from wherever the gameplay camera is now,
    // so opening the panel doesn't snap the view.
    SyncFlyCamFromCamera(){
        if(!this.camera){ return; }
        this.camPos.copy(this.camera.position);
        this._e.setFromQuaternion(this.camera.quaternion, 'YXZ');
        this.camYaw = this._e.y;
        this.camPitch = this._e.x;
    }

    // Drive the free-fly camera each frame while the panel is open. Runs after
    // PlayerControls (which is yielding the camera), so this write wins.
    Update(t){
        if(!this.active || !this.camera){ return; }
        // Only drive the free-fly camera in TPS placement (cameraOverride). In FPS the panel keeps the
        // gameplay first-person camera (placementHold) so the gun stays in its true ADS framing — leave
        // the camera to PlayerControls.
        if(!(this.controls && this.controls.cameraOverride)){ return; }

        this._e.set(this.camPitch, this.camYaw, 0, 'YXZ');
        this._q.setFromEuler(this._e);
        this._fwd.set(0, 0, -1).applyQuaternion(this._q);
        this._right.set(1, 0, 0).applyQuaternion(this._q);

        const f = Input.GetKeyDown('KeyW') - Input.GetKeyDown('KeyS');
        const r = Input.GetKeyDown('KeyD') - Input.GetKeyDown('KeyA');
        const u = Input.GetKeyDown('KeyE') - Input.GetKeyDown('KeyQ');
        this._move.set(0, 0, 0)
            .addScaledVector(this._fwd, f)
            .addScaledVector(this._right, r)
            .addScaledVector(this._up, u);

        if(this._move.lengthSq() > 0){
            const fast = (Input.GetKeyDown('ShiftLeft') || Input.GetKeyDown('ShiftRight')) ? this.flyFast : 1;
            this._move.normalize().multiplyScalar(this.flySpeed * fast * t);
            this.camPos.add(this._move);
        }

        this.camera.position.copy(this.camPos);
        this.camera.quaternion.copy(this._q);
    }

    Snippet(){
        const cur = this.Cur();
        const p = cur.pos, r = cur.rotDeg;
        const n = v => Number.isInteger(v) ? v : +v.toFixed(3);
        const m = this.Mode();
        const name = m === 'FPS_AIM' ? 'WEAPON_GRIP_FPS_AIM'
                   : m === 'FPS'     ? 'WEAPON_GRIP_FPS'
                   :                   'WEAPON_GRIP';
        return (
`const ${name} = {
    position: new THREE.Vector3(${n(p.x)}, ${n(p.y)}, ${n(p.z)}),
    rotationEuler: new THREE.Euler(
        THREE.MathUtils.degToRad(${n(r.x)}),
        THREE.MathUtils.degToRad(${n(r.y)}),
        THREE.MathUtils.degToRad(${n(r.z)}),
    ),
};`);
    }

    EmitSnippet(){
        const text = this.Snippet();
        console.log(`[WeaponPlacementDebug] paste into UeMannequin.js (${this.Mode()}):\n` + text);
        try { navigator.clipboard && navigator.clipboard.writeText(text); } catch(_){ /* non-secure context */ }
    }

    BuildPanel(){
        const el = document.createElement('div');
        el.id = 'weapon-placement-debug';
        el.style.cssText = [
            'position:fixed', 'top:12px', 'right:12px', 'z-index:9999',
            'display:none', 'font:12px/1.5 monospace', 'color:#cfe',
            'background:rgba(10,14,20,0.85)', 'border:1px solid #2a3a4a',
            'border-radius:6px', 'padding:10px 12px', 'white-space:pre',
            'pointer-events:none', 'min-width:230px',
        ].join(';');
        document.body.appendChild(el);
        this.el = el;
    }

    Render(){
        if(!this.el){ return; }
        if(!this.pivot){
            this.el.textContent = 'WEAPON DEBUG: no weapon socketed.';
            return;
        }
        const cur = this.Cur();
        const isRot = this.selected >= 3;
        const step = isRot ? this.rotSteps[this.stepIndex] : this.posSteps[this.stepIndex];
        const vals = [cur.pos.x, cur.pos.y, cur.pos.z, cur.rotDeg.x, cur.rotDeg.y, cur.rotDeg.z];
        const units = ['cm', 'cm', 'cm', '°', '°', '°'];
        const rows = this.fields.map((f, i) => {
            const cursor = i === this.selected ? '▶' : ' ';
            const v = Number.isInteger(vals[i]) ? vals[i] : vals[i].toFixed(3);
            return `${cursor} ${f.padEnd(5)} ${String(v).padStart(8)} ${units[i]}`;
        }).join('\n');

        this.el.textContent =
`WEAPON PLACEMENT · ${this.Mode()}  (\` to close)
──────────────────────────
${rows}
──────────────────────────
step  ${String(step).padStart(5)} ${isRot ? '°' : 'cm'}   (←/→ change)
[ ]=field  ↑/↓=adjust
Enter=copy snippet  ⌫=reset
editing the ${this.Mode()} grip (V swaps TPS/FPS
when closed; HOLD right-click in FPS for FPS_AIM)
── free cam ──
WASD move · Q/E down/up
mouse look · Shift faster`;
    }
}
