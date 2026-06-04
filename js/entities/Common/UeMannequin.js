import * as THREE from 'three'


// Shared construction for the Unreal Engine Mannequin avatar. Both the player's
// third-person body (PlayerBody) and the velocity-driven enemy soldier
// (UeSoldierController) drive the SAME rig + the SAME four UE rifle clips
// (idle / walk / reload / shoot), so the mesh setup, the UE->three import fix, the
// body/chest-logo textures and the in-hand weapon socket all live here once.
//
// UE assets import Z-up and in centimetres. The raw GLB scene is wrapped in a
// gameplay `modelRoot` group and the inner model carries a fixed -90deg X tilt +
// 0.01 scale so it lands upright in three's Y-up metres (~1.83 m tall, feet at
// local Y=0). Callers move/rotate `modelRoot`; the inner model keeps the import fix.

// Render layer the avatar's meshes are moved to when their owning camera must NOT
// see them (the player's own first-person body). The shadow-casting light is told
// to also see this layer so the avatar still throws a shadow while hidden.
export const UE_BODY_LAYER = 1;

// In-hand weapon socket. The UE rifle clips pose hand_r to grip a rifle; these
// hand-tuned offsets seat the weapon in that grip. The socket lives in the bone's
// local space, which is native UE centimetres (the model root scales the whole rig
// by 0.01 for the world), so translation reads in centimetres.
//
// The SK_AK47 FBX is a SkeletalMesh whose geometry is NOT centred on its object
// origin (the barrel runs off to one side, bbox centre ≈ 15 units off-origin) and
// whose moving parts hang off offset bones. So parenting the raw object to the hand
// leaves the gun floating away from the palm (it ends up by the head). To make the
// placement robust regardless of how the FBX authored its pivot, the weapon is
// dropped into a pivot group and shifted so its bounding-box CENTRE sits at the
// group origin; the group is then auto-scaled (longest side -> WEAPON_LENGTH_CM)
// and seated in the hand. WEAPON_GRIP therefore offsets the gun's centre from the
// hand bone. Nudge position/rotation if the grip looks off; bump WEAPON_LENGTH_CM
// to resize.
const WEAPON_LENGTH_CM = 72;
const WEAPON_GRIP = {
    // Hand-tuned in TPS with the in-game placement tool (WeaponPlacementDebug, the `
    // panel). Position is hand-local centimetres; rotation seats the AK upright in the
    // palm with the barrel running forward. Re-tune with the panel and paste here.
    position: new THREE.Vector3(-19.5, -4.5, 4.5),
    rotationEuler: new THREE.Euler(
        THREE.MathUtils.degToRad(0),
        THREE.MathUtils.degToRad(-5),
        THREE.MathUtils.degToRad(270),
    ),
};

// Build the runtime-ready avatar from a freshly-cloned GLB scene.
//   model    : SkeletonUtils.clone() of the loaded SK_Mannequin.glb scene
//   textures : optional { bodyColor, bodyNormal, logoColor, logoNormal } THREE.Textures
//   weapon   : optional Object3D (a cloned SK_AK47 mesh) to socket into hand_r
// Returns { modelRoot, model, rootBone, handBone, meshes } — `modelRoot` is what
// the caller adds to the scene and transforms; `rootBone` is locked each frame to
// strip the clips' baked root motion; `meshes` is the skinned-mesh list for
// per-camera layer toggling.
export function buildUeMannequin(model, { textures = null, weapon = null } = {}){
    model.rotation.x = -Math.PI / 2;
    model.scale.setScalar(0.01);
    const modelRoot = new THREE.Group();
    modelRoot.add(model);

    const meshes = [];
    let rootBone = null;
    let handBone = null;
    let weaponPivot = null;

    model.traverse(child => {
        if(child.isMesh || child.isSkinnedMesh){
            child.frustumCulled = false;   // skinned bounds go stale once posed
            child.castShadow = true;
            child.receiveShadow = true;
            meshes.push(child);
        }
        if(child.isBone){
            if(child.name === 'root'){ rootBone = child; }
            if(child.name === 'hand_r'){ handBone = child; }
        }
    });

    // The GLB ships a neutral PBR material that renders black/invisible under r127,
    // so we always rebuild a skinning-enabled material we control. The mesh exports
    // two primitives in UE material-slot order: 0 = body, 1 = chest logo. Map the
    // matching UE .tga set onto each when supplied; otherwise fall back to flat grey.
    meshes.forEach((mesh, i) => {
        const isLogo = i === 1;
        const map = textures ? (isLogo ? textures.logoColor : textures.bodyColor) : null;
        const normalMap = textures ? (isLogo ? textures.logoNormal : textures.bodyNormal) : null;
        const material = new THREE.MeshStandardMaterial({
            color: map ? 0xffffff : 0x8c95a1,
            map: map || null,
            normalMap: normalMap || null,
            metalness: 0.1,
            roughness: 0.8,
            skinning: true,
        });
        // UE exports DirectX-convention normal maps (green/Y channel pointing down);
        // three's lighting expects OpenGL (+Y up). Without this the bumps invert and
        // the body reads as muddy/blotchy rather than crisply panelled. Flipping the
        // Y of normalScale reinterprets the green channel at sample time (no texture
        // rewrite needed). No effect when there's no normal map.
        if(normalMap){ material.normalScale.y *= -1; }
        mesh.material = material;
    });

    if(weapon && handBone){
        // Drop the weapon into a pivot group and recentre it so the gun's geometry
        // sits ON the pivot origin, cancelling the FBX's off-centre pivot. Measure
        // the bbox while the pivot is still at identity (world space == pivot-local
        // space), shift the weapon by -centre, then transform the pivot.
        const pivot = new THREE.Group();
        pivot.add(weapon);
        pivot.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(weapon);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const longest = Math.max(size.x, size.y, size.z) || 1;
        weapon.position.sub(center);                       // gun centre -> pivot origin

        // Auto-normalize size: scale so the longest bbox side ≈ WEAPON_LENGTH_CM in
        // the hand's centimetre space, regardless of the FBX's native units, then
        // seat the centred gun in the grip.
        pivot.scale.setScalar(WEAPON_LENGTH_CM / longest);
        pivot.position.copy(WEAPON_GRIP.position);
        pivot.quaternion.setFromEuler(WEAPON_GRIP.rotationEuler);

        pivot.traverse(child => {
            if(child.isMesh){
                child.castShadow = true;
                child.receiveShadow = true;
                child.frustumCulled = false;   // skinned AK bounds also go stale
                // Sits inside the rig, so it must follow the same layer toggles as the
                // body meshes — registering it here lets callers treat it uniformly.
                meshes.push(child);
            }
        });
        handBone.add(pivot);
        weaponPivot = pivot;
    }

    return { modelRoot, model, rootBone, handBone, weaponPivot, meshes };
}

// The default in-hand grip transform, exposed so the placement-debug tool can show
// the current values and so a found-by-debug transform can be pasted straight back
// into WEAPON_GRIP above.
export const WEAPON_GRIP_DEFAULT = WEAPON_GRIP;
