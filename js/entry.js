/**
 * entry.js
 * 
 * This is the first file loaded. It sets up the Renderer, 
 * Scene, Physics and Entities. It also starts the render loop and 
 * handles window resizes.
 * 
 */

import * as THREE from 'three'
import {AmmoHelper, Ammo, createConvexHullShape} from './AmmoLib.js'
import EntityManager from './EntityManager.js'
import Entity from './Entity.js'
import Sky from './entities/Sky/Sky2.js'
import LevelSetup from './entities/Level/LevelSetup.js'
import PlayerControls from './entities/Player/PlayerControls.js'
import PlayerPhysics from './entities/Player/PlayerPhysics.js'
import Stats from 'three/examples/jsm/libs/stats.module.js'
import {  FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js'
import {  GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {  OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js'
import {  SkeletonUtils } from 'three/examples/jsm/utils/SkeletonUtils.js'
import NpcCharacterController from './entities/NPC/CharacterController.js'
import Input from './Input.js'

// Buildless asset URLs. Webpack used `import x from './assets/..'` (file-loader
// turned each into a hashed URL string); native ESM has no such loader, so these
// are plain root-relative URL strings the Three.js loaders fetch directly.
// Paths are relative to index.html (the document base), not this module.
const level = 'assets/level.glb'
const navmesh = 'assets/navmesh.obj'

// Enemy NPC keeps the mutant rig (root-motion locomotion). Spaces URL-encoded.
const mutant = 'assets/animations/mutant.fbx'
const idleAnim = 'assets/animations/mutant%20breathing%20idle.fbx'
const attackAnim = 'assets/animations/mutant%20punch.fbx'
const walkAnim = 'assets/animations/mutant%20walking.fbx'
const runAnim = 'assets/animations/mutant%20run.fbx'
const dieAnim = 'assets/animations/mutant%20dying.fbx'

// UE Mannequin player body: a single GLB (mesh + skeleton + 4 named clips:
// idle/walk/reload/shoot) baked from the UE FBX by tools/ue_fbx_to_glb.html.
// (r127's FBXLoader cannot parse the UE2020 animation FBX, so we convert with a
// modern loader offline and load clean glTF here.) Kept in native UE space
// (Z-up, centimetres); PlayerBody applies the Y-up/metre transform at runtime.
const ueChar = 'assets/characters/ue/SK_Mannequin.glb'

//AK47 Model and textures
const ak47 = 'assets/guns/ak47/ak47.glb'
const muzzleFlash = 'assets/muzzle_flash.glb'
//Shot sound
const ak47Shot = 'assets/sounds/ak47_shot.wav'

//Ammo box
const ammobox = 'assets/ammo/AmmoBox.fbx'
const ammoboxTexD = 'assets/ammo/AmmoBox_D.tga.png'
const ammoboxTexN = 'assets/ammo/AmmoBox_N.tga.png'
const ammoboxTexM = 'assets/ammo/AmmoBox_M.tga.png'
const ammoboxTexR = 'assets/ammo/AmmoBox_R.tga.png'
const ammoboxTexAO = 'assets/ammo/AmmoBox_AO.tga.png'

//Bullet Decal
const decalColor = 'assets/decals/decal_c.jpg'
const decalNormal = 'assets/decals/decal_n.jpg'
const decalAlpha = 'assets/decals/decal_a.jpg'

//Sky
const skyTex = 'assets/sky.jpg'

import DebugDrawer from './DebugDrawer.js'
import Navmesh from './entities/Level/Navmesh.js'
import AttackTrigger from './entities/NPC/AttackTrigger.js'
import DirectionDebug from './entities/NPC/DirectionDebug.js'
import CharacterCollision from './entities/NPC/CharacterCollision.js'
import Hands from './entities/Player/Hands.js'
import WeaponManager from './entities/Player/WeaponManager.js'
import PlayerBody from './entities/Player/PlayerBody.js'
import UIManager from './entities/UI/UIManager.js'
import AmmoBox from './entities/AmmoBox/AmmoBox.js'
import LevelBulletDecals from './entities/Level/BulletDecals.js'
import PlayerHealth from './entities/Player/PlayerHealth.js'
import UeExporter from './export/UeExporter.js'

class FPSGameApp{

  constructor(){
    this.lastFrameTime = null;
    this.assets = {};
    this.animFrameId = 0;

    AmmoHelper.Init(()=>{this.Init();});
  }

  Init(){
    this.LoadAssets();
    this.SetupGraphics();
    this.SetupStartButton();
  }

  SetupGraphics(){
    this.scene = new THREE.Scene();
    this.renderer = new THREE.WebGLRenderer({antialias: true});
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.renderer.toneMapping = THREE.ReinhardToneMapping;
		this.renderer.toneMappingExposure = 1;
		this.renderer.outputEncoding = THREE.sRGBEncoding;

    this.camera = new THREE.PerspectiveCamera();
    this.camera.near = 0.01;

    // create an AudioListener and add it to the camera
    this.listener = new THREE.AudioListener();
    this.camera.add( this.listener );

    // renderer
    this.renderer.setPixelRatio(window.devicePixelRatio);

    this.WindowResizeHanlder();
    window.addEventListener('resize', this.WindowResizeHanlder);

    document.body.appendChild( this.renderer.domElement );

    // Stats.js
    this.stats = new Stats();
    document.body.appendChild(this.stats.dom);
  }

  SetupPhysics() {
    // Physics configuration
    const collisionConfiguration = new Ammo.btDefaultCollisionConfiguration();
    const dispatcher = new Ammo.btCollisionDispatcher( collisionConfiguration );
    const broadphase = new Ammo.btDbvtBroadphase();
    const solver = new Ammo.btSequentialImpulseConstraintSolver();
    this.physicsWorld = new Ammo.btDiscreteDynamicsWorld( dispatcher, broadphase, solver, collisionConfiguration );
    this.physicsWorld.setGravity( new Ammo.btVector3( 0.0, -9.81, 0.0 ) );
    // The WASM Ammo build requires an Emscripten signature for addFunction
    // (the asm.js build the reference used inferred it). The internal tick
    // callback is void(btDynamicsWorld* world, btScalar timeStep) => 'vif'
    // (void; i32 pointer; float). The asm.js build ignores the extra arg, so
    // this stays compatible if the vendored build is ever swapped.
    const fp = Ammo.addFunction(this.PhysicsUpdate, 'vif');
    this.physicsWorld.setInternalTickCallback(fp);
    this.physicsWorld.getBroadphase().getOverlappingPairCache().setInternalGhostPairCallback(new Ammo.btGhostPairCallback());

    //Physics debug drawer
    //this.debugDrawer = new DebugDrawer(this.scene, this.physicsWorld);
    //this.debugDrawer.enable();
  }

  SetAnim(name, obj){
    const clip = obj.animations[0];
    this.mutantAnims[name] = clip;
  }

  PromiseProgress(proms, progress_cb){
    let d = 0;
    progress_cb(0);
    for (const p of proms) {
      p.then(()=> {    
        d++;
        progress_cb( (d / proms.length) * 100 );
      });
    }
    return Promise.all(proms);
  }

  AddAsset(asset, loader, name){
    return loader.loadAsync(asset).then( result =>{
      this.assets[name] = result;
    });
  }

  OnProgress(p){
    const progressbar = document.getElementById('progress');
    progressbar.style.width = `${p}%`;
  }

  HideProgress(){
    this.OnProgress(0);
  }

  SetupStartButton(){
    document.getElementById('start_game').addEventListener('click', this.StartGame);
  }

  ShowMenu(visible=true){
    document.getElementById('menu').style.visibility = visible?'visible':'hidden';
  }

  async LoadAssets(){
    const gltfLoader = new GLTFLoader();
    const fbxLoader = new FBXLoader();
    const objLoader = new OBJLoader();
    const audioLoader = new THREE.AudioLoader();
    const texLoader = new THREE.TextureLoader();
    const promises = [];

    //Level
    promises.push(this.AddAsset(level, gltfLoader, "level"));
    promises.push(this.AddAsset(navmesh, objLoader, "navmesh"));
    //Mutant (enemy NPC)
    promises.push(this.AddAsset(mutant, fbxLoader, "mutant"));
    promises.push(this.AddAsset(idleAnim, fbxLoader, "idleAnim"));
    promises.push(this.AddAsset(walkAnim, fbxLoader, "walkAnim"));
    promises.push(this.AddAsset(runAnim, fbxLoader, "runAnim"));
    promises.push(this.AddAsset(attackAnim, fbxLoader, "attackAnim"));
    promises.push(this.AddAsset(dieAnim, fbxLoader, "dieAnim"));
    //UE Mannequin (player body) — GLB with embedded idle/walk/reload/shoot clips
    promises.push(this.AddAsset(ueChar, gltfLoader, "ueChar"));
    //AK47
    promises.push(this.AddAsset(ak47, gltfLoader, "ak47"));
    promises.push(this.AddAsset(muzzleFlash, gltfLoader, "muzzleFlash"));
    promises.push(this.AddAsset(ak47Shot, audioLoader, "ak47Shot"));
    //Ammo box
    promises.push(this.AddAsset(ammobox, fbxLoader, "ammobox"));
    promises.push(this.AddAsset(ammoboxTexD, texLoader, "ammoboxTexD"));
    promises.push(this.AddAsset(ammoboxTexN, texLoader, "ammoboxTexN"));
    promises.push(this.AddAsset(ammoboxTexM, texLoader, "ammoboxTexM"));
    promises.push(this.AddAsset(ammoboxTexR, texLoader, "ammoboxTexR"));
    promises.push(this.AddAsset(ammoboxTexAO, texLoader, "ammoboxTexAO"));
    //Decal
    promises.push(this.AddAsset(decalColor, texLoader, "decalColor"));
    promises.push(this.AddAsset(decalNormal, texLoader, "decalNormal"));
    promises.push(this.AddAsset(decalAlpha, texLoader, "decalAlpha"));

    promises.push(this.AddAsset(skyTex, texLoader, "skyTex"));

    await this.PromiseProgress(promises, this.OnProgress);

    this.assets['level'] = this.assets['level'].scene;
    this.assets['muzzleFlash'] = this.assets['muzzleFlash'].scene;

    //Extract mutant anims (enemy NPC)
    this.mutantAnims = {};
    this.SetAnim('idle', this.assets['idleAnim']);
    this.SetAnim('walk', this.assets['walkAnim']);
    this.SetAnim('run', this.assets['runAnim']);
    this.SetAnim('attack', this.assets['attackAnim']);
    this.SetAnim('die', this.assets['dieAnim']);

    //Extract UE Mannequin (player body): GLB scene + named clips. Map 'run' to
    //'walk' since the rifle set has no sprint clip; PlayerBody falls back to it.
    this.ueModel = this.assets['ueChar'].scene;
    const ueClips = this.assets['ueChar'].animations;
    const byName = (n) => ueClips.find(c => c.name === n);
    this.ueAnims = {
      idle: byName('idle'),
      walk: byName('walk'),
      run: byName('walk'),
      reload: byName('reload'),
      shoot: byName('shoot'),
    };

    this.assets['ak47'].scene.animations = this.assets['ak47'].animations;
    
    //Set ammo box textures and other props
    this.assets['ammobox'].scale.set(0.01, 0.01, 0.01);
    this.assets['ammobox'].traverse(child =>{
      child.castShadow = true;
      child.receiveShadow = true;
      
      child.material = new THREE.MeshStandardMaterial({
        map: this.assets['ammoboxTexD'],
        aoMap: this.assets['ammoboxTexAO'],
        normalMap: this.assets['ammoboxTexN'],
        metalness: 1,
        metalnessMap: this.assets['ammoboxTexM'],
        roughnessMap: this.assets['ammoboxTexR'],
        color: new THREE.Color(0.4, 0.4, 0.4)
      });
      
    });

    this.assets['ammoboxShape'] = createConvexHullShape(this.assets['ammobox']);

    this.HideProgress();
    this.ShowMenu();
  }

  EntitySetup(){
    this.entityManager = new EntityManager();

    const levelEntity = new Entity();
    levelEntity.SetName('Level');
    levelEntity.AddComponent(new LevelSetup(this.assets['level'], this.scene, this.physicsWorld));
    levelEntity.AddComponent(new Navmesh(this.scene, this.assets['navmesh']));
    levelEntity.AddComponent(new LevelBulletDecals(this.scene, this.assets['decalColor'], this.assets['decalNormal'], this.assets['decalAlpha']));
    this.entityManager.Add(levelEntity);

    const skyEntity = new Entity();
    skyEntity.SetName("Sky");
    skyEntity.AddComponent(new Sky(this.scene, this.assets['skyTex']));
    this.entityManager.Add(skyEntity);

    const playerEntity = new Entity();
    playerEntity.SetName("Player");
    playerEntity.AddComponent(new PlayerPhysics(this.physicsWorld, Ammo));
    playerEntity.AddComponent(new PlayerControls(this.camera, this.scene));
    playerEntity.AddComponent(new PlayerBody(SkeletonUtils.clone(this.ueModel), this.ueAnims, this.scene, this.camera));
    playerEntity.AddComponent(new Hands(this.camera, this.assets['ak47'].scene));
    playerEntity.AddComponent(new WeaponManager(this.camera, this.physicsWorld, this.assets['muzzleFlash'], this.assets['ak47Shot'], this.listener ));
    playerEntity.AddComponent(new PlayerHealth());
    playerEntity.SetPosition(new THREE.Vector3(2.14, 1.48, -1.36));
    playerEntity.SetRotation(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), -Math.PI * 0.5));
    this.entityManager.Add(playerEntity);

    const npcLocations = [
      [10.8, 0.0, 22.0],
    ];

    npcLocations.forEach((v,i)=>{
      const npcEntity = new Entity();
      npcEntity.SetPosition(new THREE.Vector3(v[0], v[1], v[2]));
      npcEntity.SetName(`Mutant${i}`);
      npcEntity.AddComponent(new NpcCharacterController(SkeletonUtils.clone(this.assets['mutant']), this.mutantAnims, this.scene, this.physicsWorld));
      npcEntity.AddComponent(new AttackTrigger(this.physicsWorld));
      npcEntity.AddComponent(new CharacterCollision(this.physicsWorld));
      npcEntity.AddComponent(new DirectionDebug(this.scene));
      this.entityManager.Add(npcEntity);
    });

    const uimanagerEntity = new Entity();
    uimanagerEntity.SetName("UIManager");
    uimanagerEntity.AddComponent(new UIManager());
    this.entityManager.Add(uimanagerEntity);

    // UE export layer (press P to download level_ue.glb + mechanics.json).
    const exporterEntity = new Entity();
    exporterEntity.SetName("UeExporter");
    exporterEntity.AddComponent(new UeExporter(this.scene, this.entityManager));
    this.entityManager.Add(exporterEntity);

    const ammoLocations = [
       [14.37, 0.0, 10.45],
       [32.77, 0.0, 33.84],
    ];

    ammoLocations.forEach((loc, i) => {
      const box = new Entity();
      box.SetName(`AmmoBox${i}`);
      box.AddComponent(new AmmoBox(this.scene, this.assets['ammobox'].clone(), this.assets['ammoboxShape'], this.physicsWorld));
      box.SetPosition(new THREE.Vector3(loc[0], loc[1], loc[2]));
      this.entityManager.Add(box);
    });

    this.entityManager.EndSetup();

    this.scene.add(this.camera);
    this.animFrameId = window.requestAnimationFrame(this.OnAnimationFrameHandler);
  }

  StartGame = ()=>{
    window.cancelAnimationFrame(this.animFrameId);
    Input.ClearEventListners();

    //Create entities and physics
    this.scene.clear();
    this.SetupPhysics();
    this.EntitySetup();
    this.ShowMenu(false);
  }

  // resize
  WindowResizeHanlder = () => { 
    const { innerHeight, innerWidth } = window;
    this.renderer.setSize(innerWidth, innerHeight);
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
  }

  // render loop
  OnAnimationFrameHandler = (t) => {
    if(this.lastFrameTime===null){
      this.lastFrameTime = t;
    }

    const delta = t-this.lastFrameTime;
    let timeElapsed = Math.min(1.0 / 30.0, delta * 0.001);
    this.Step(timeElapsed);
    this.lastFrameTime = t;

    this.animFrameId = window.requestAnimationFrame(this.OnAnimationFrameHandler);
  }

  PhysicsUpdate = (world, timeStep)=>{
    this.entityManager.PhysicsUpdate(world, timeStep);
  }

  Step(elapsedTime){
    this.physicsWorld.stepSimulation( elapsedTime, 10 );
    //this.debugDrawer.update();

    this.entityManager.Update(elapsedTime);

    this.renderer.render(this.scene, this.camera);
    this.stats.update();
  }

}

let _APP = null;
window.addEventListener('DOMContentLoaded', () => {
  _APP = new FPSGameApp();
  // Expose for debugging / automated QA (inspect scene, physics, entities).
  window._APP = _APP;
});