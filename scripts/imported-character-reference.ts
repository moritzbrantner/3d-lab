// Independent reference preparation only: GLTFLoader owns source decoding.
// Serve repository root, then bun scripts/imported-character-reference.mjs URL OUTPUT.
// This does not exercise a candidate imported-character API or claim #87 complete.
import {chromium} from "playwright";
import {writeFile} from 'node:fs/promises';
const base = process.argv[2] ?? 'http://127.0.0.1:4187/';
const output = process.argv[3] ?? 'target/imported-character-reference.json';
const browser=await chromium.launch({headless:true,args:['--enable-unsafe-swiftshader']});
try {
 const page=await browser.newPage();await page.goto(base);
 await page.evaluate(()=>{const s=document.createElement('script');s.type='importmap';s.textContent=JSON.stringify({imports:{three:'/node_modules/three/build/three.module.js'}});document.head.appendChild(s);});
 const result=await page.evaluate(async()=>{
  const THREE=await import('three');const {GLTFLoader}=await import('/node_modules/three/examples/jsm/loaders/GLTFLoader.js');
  const gltf=await new GLTFLoader().loadAsync('/fixtures/imported-character/fox.glb');
  const mesh=[];gltf.scene.traverse(o=>{if(o.isSkinnedMesh)mesh.push(o);});if(mesh.length!==1)throw Error('expected one skin');
  const skin=mesh[0];const vertices=[0,100,500,1000,1727];const samples=[];
  for(const clip of gltf.animations){
   const mixer=new THREE.AnimationMixer(gltf.scene);const action=mixer.clipAction(clip);action.setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;action.play();
   for(const fraction of [0,0.25,0.5,0.75,1]){
    const time=clip.duration*fraction;mixer.setTime(time);gltf.scene.updateMatrixWorld(true);skin.skeleton.update();
    samples.push({clip:clip.name,time,joints:skin.skeleton.bones.map(b=>({name:b.name,translation:b.position.toArray(),rotation:b.quaternion.toArray(),scale:b.scale.toArray(),matrixWorld:b.matrixWorld.toArray()})),vertices:vertices.map(index=>({index,world:skin.getVertexPosition(index,new THREE.Vector3()).applyMatrix4(skin.matrixWorld).toArray()}))});
   }
   mixer.stopAllAction();mixer.uncacheRoot(gltf.scene);
  }
  return {reference:'Three.js GLTFLoader + AnimationMixer + SkinnedMesh.getVertexPosition',threeVersion:THREE.REVISION,assetSha256:'e8f4a6cc4677f7f5942fb6c0c9c639586fb2d6617ec4b2802c82fca72f6ef505',samples};
 });await writeFile(output,JSON.stringify(result,null,2)+'\n');
}finally{await browser.close();}
