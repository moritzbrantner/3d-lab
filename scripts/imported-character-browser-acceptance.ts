// Independent #87 real browser consumer, before implementation. Proposed public
// routine names may be translated independently; authority/outputs may not.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(process.argv[2] ?? "target/imported-character-browser-acceptance");
await mkdir(output, { recursive: true });
const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const entry = manifest.exports["./imported-character"];
const importedPath = entry && (typeof entry === "string" ? entry : entry.import);
const proof = JSON.parse(await readFile(resolve(root,"fixtures/imported-character/fox.production-import.json"),"utf8"));
const fox = await readFile(resolve(root,"fixtures/imported-character/fox.glb"));
assert.equal(createHash("sha256").update(fox).digest("hex"), proof.result.outputs.output.sha256);
assert.equal(fox.byteLength, proof.result.outputs.output.byteLength);
const wasm: Array<{url: string; sha256: string; bytes: number}> = [];
const pageErrors: string[] = [];
// Disposable fixture server, no application state, decoder or model implementation.
const server = Bun.serve({ hostname:"127.0.0.1", port:0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/") {
    return new Response('<!doctype html><html><body><canvas aria-label="Actual public imported character" width="640" height="480"></canvas></body></html>', { headers:{"Content-Type":"text/html"} });
  }
  const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
  if (!path.startsWith(root.endsWith(sep) ? root : root+sep)) { return new Response("outside fixture root",{status:403}); }
  const file = Bun.file(path);
  if (!await file.exists()) { return new Response("missing candidate resource",{status:404}); }
  return new Response(file);
}});
const browser = await chromium.launch({headless:true,channel:"chromium",args:["--enable-unsafe-swiftshader","--use-gl=angle","--use-angle=swiftshader"]});
const page = await browser.newPage({viewport:{width:800,height:600}});
page.on("pageerror",error=>pageErrors.push(error.message));
const responses: Promise<void>[] = [];
page.on("response",response=> {
  if (response.headers()["content-type"]?.includes("application/wasm") || new URL(response.url()).pathname.endsWith(".wasm")) {
    responses.push(response.body().then(bytes=>{wasm.push({url:response.url(),sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.byteLength});}));
  }
});
try {
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.evaluate(()=>{
    const map=document.createElement("script");map.type="importmap";
    map.textContent=JSON.stringify({imports:{three:"/node_modules/three/build/three.module.js","three/":"/node_modules/three/"}});
    document.head.appendChild(map);
  });
  const result = await page.evaluate(async ({ importedPath }) => {
    const THREE = await import("three");
    const publicRenderer = await import("/packages/renderer/index.js");
    const canvas=document.querySelector("canvas")!;
    const renderer=publicRenderer.createThreeSceneRenderer(canvas,{background:0,shadows:false,antialias:false});
    renderer.setSize(640,480,1);
    const gl=canvas.getContext("webgl2");
    if(!gl || gl.isContextLost()) { throw Error("actual public renderer WebGL context unavailable"); }
    if(!importedPath) { throw Error("#87 public imported-character export absent after real renderer initialization"); }
    // Observe genuine WebAssembly compilation/instantiation without replacing its
    // execution/results. Source audit must bind this module to Rust sampling.
    let instantiated=0;
    const originalInstantiate=WebAssembly.instantiate.bind(WebAssembly);
    WebAssembly.instantiate=async(...args)=>{const result=await originalInstantiate(...args);instantiated+=1;return result;};
    const originalStreaming=WebAssembly.instantiateStreaming.bind(WebAssembly);
    WebAssembly.instantiateStreaming=async(...args)=>{const result=await originalStreaming(...args);instantiated+=1;return result;};
    const module=await import('/'+importedPath.replace(/^\.\//,''));
    const proof=await (await fetch('/fixtures/imported-character/fox.production-import.json')).json();
    const oracle=await (await fetch('/fixtures/imported-character/fox.pose-oracle.json')).json();
    const bytes=new Uint8Array(await (await fetch('/fixtures/imported-character/fox.glb')).arrayBuffer());
    const asset=await module.adaptImportedCharacter(bytes,{provenance:proof});
    const a=asset.createInstance();const b=asset.createInstance();
    function mesh(instance) {
      const list=[];instance.root.traverse(node=>{if(node.isSkinnedMesh){list.push(node);}});
      if(list.length!==1){throw Error('actual Fox must contain one skinned primitive');}
      instance.root.updateMatrixWorld(true);list[0].skeleton.update();return list[0];
    }
    function pose(instance) {
      const m=mesh(instance);return {joints:m.skeleton.bones.map(bone=>bone.matrixWorld.toArray()),
        vertices:[0,100,500,1000,1727].map(index=>m.getVertexPosition(index,new THREE.Vector3()).applyMatrix4(m.matrixWorld).toArray())};
    }
    function check(condition,message) {if(!condition){throw Error(message);}}
    function close(a,b,tolerance) {check(a.length===b.length,'numeric shape changed');a.forEach((v,i)=>check(Number.isFinite(v)&&Math.abs(v-b[i])<tolerance,`numeric evidence differs ${v} vs ${b[i]}`));}
    function immutable(instance) {const m=mesh(instance);return JSON.stringify([m.geometry.index,...Object.values(m.geometry.attributes)].map(a=>Array.from(a.array)));}
    await a.seek('Survey',0);await b.seek('Survey',0);
    const am=mesh(a),bm=mesh(b);const fixed=immutable(a),bBefore=JSON.stringify(pose(b));
    check(am.geometry===bm.geometry && am.material===bm.material,'immutable geometry/material must be shared');
    check(am.geometry.attributes.skinIndex.array===bm.geometry.attributes.skinIndex.array && am.geometry.attributes.skinWeight.array===bm.geometry.attributes.skinWeight.array,'actual influence buffers not shared');
    check(am.skeleton!==bm.skeleton && am.skeleton.bones[0]!==bm.skeleton.bones[0],'poses alias');
    const material=Array.isArray(am.material)?am.material[0]:am.material;
    check(material.map && material.map.image && material.map.image.width>0 && material.map.image.height>0,'actual embedded texture must be decoded, not dropped');
    const samples=[];
    for(const sample of oracle.samples) {
      await a.seek(sample.clip,sample.time);const actual=pose(a);
      check(mesh(a).skeleton.bones.length===24,'skin palette != scene node indices');
      sample.joints.forEach((joint,i)=>close(actual.joints[i],joint.matrixWorld,0.002));
      sample.vertices.forEach((vertex,i)=>close(actual.vertices[i],vertex.world,0.02));
      check(JSON.stringify(pose(b))===bBefore,'A seek changed B');check(immutable(a)===fixed,'seek rebuilt/mutated immutable buffers');
      samples.push({clip:sample.clip,time:sample.time,...actual});
    }
    await a.seek('Walk',0.321);const before=JSON.stringify(pose(a));
    for(const attempt of [()=>a.seek('Walk',NaN),()=>a.seek('Walk',Infinity),()=>a.seek('absent-clip',0),()=>a.advance(-1),()=>a.transition('Run',-1)]) {
      let rejected=false;try{await attempt();}catch{rejected=true;}
      check(rejected,'invalid runtime input succeeded');check(JSON.stringify(pose(a))===before && immutable(a)===fixed,'invalid input was not atomic');
    }
    // Explicit source-unit camera fixture; no gameplay/camera authority created.
    await a.seek('Survey',0);
    const bounds=new THREE.Box3().setFromObject(a.root);const center=bounds.getCenter(new THREE.Vector3());const span=bounds.getSize(new THREE.Vector3()).length();
    const camera=new THREE.PerspectiveCamera(45,640/480,Math.max(span/1000,0.01),span*20);
    camera.position.copy(center).add(new THREE.Vector3(span*0.6,span*0.35,span*1.6));camera.lookAt(center);camera.updateMatrixWorld(true);
    const renderCamera={viewMatrix:camera.matrixWorldInverse.toArray(),projectionMatrix:camera.projectionMatrix.toArray()};
    function draw(instances) {
      // Routine submission name may change; must reuse this existing renderer,
      // never create a second renderer/private preview or CPU-drawn stand-in.
      module.renderImportedCharacterInstances(renderer,{camera:renderCamera,instances});
      const pixels=new Uint8Array(640*480*4);gl.readPixels(0,0,640,480,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
      check(gl.getError()===gl.NO_ERROR,'actual frame readback failed');return pixels;
    }
    const empty=draw([]);const first=draw([a]);
    let visible=0;for(let i=0;i<first.length;i+=4){if(first[i]!==empty[i]||first[i+1]!==empty[i+1]||first[i+2]!==empty[i+2]){visible++;}}
    check(visible>64,'real public canvas has no visible character geometry');
    await a.seek('Walk',0.321);const moving=draw([a]);let changed=0;
    for(let i=0;i<moving.length;i+=4){if(moving[i]!==first[i]||moving[i+1]!==first[i+1]||moving[i+2]!==first[i+2]){changed++;}}
    check(changed>8,'actual rendered clip has no visible motion');
    const placed=asset.createInstance({modelMatrix:new THREE.Matrix4().makeTranslation(span*0.8,0,0).elements});
    await placed.seek('Walk',0.321);const canonical=pose(a),shifted=pose(placed);
    canonical.vertices.forEach((vertex,i)=>close(shifted.vertices[i],[vertex[0]+span*0.8,vertex[1],vertex[2]],0.02));
    await a.seek('Survey',0);await b.seek('Survey',0);await a.transition('Walk',0.4);await b.transition('Walk',0.4);
    await a.advance(0.2);for(let i=0;i<20;i++){await b.advance(0.01);}
    const mid=pose(a);pose(b).joints.forEach((matrix,i)=>close(matrix,mid.joints[i],0.002));
    const target=asset.createInstance();await target.seek('Walk',0.2);check(JSON.stringify(mid)!==JSON.stringify(pose(target)),'fade instantly replaced clip');
    await a.advance(0.2);await target.seek('Walk',0.4);pose(a).joints.forEach((matrix,i)=>close(matrix,pose(target).joints[i],0.002));
    check(instantiated>0,'candidate path never instantiated actual compiled WebAssembly');
    check(immutable(a)===fixed && am.geometry===bm.geometry,'fade rebuilt immutable resource');
    draw([a,placed]);
    // Presentation-only draw loop keeps a real submitted frame available for screenshot.
    const present=()=>{module.renderImportedCharacterInstances(renderer,{camera:renderCamera,instances:[a,placed]});requestAnimationFrame(present);};requestAnimationFrame(present);
    return {samples,visiblePixels:visible,movingPixels:changed,wasmInstances:instantiated,sharedGeometry:true,sharedInfluences:true,independentPoses:true};
  }, {importedPath});
  await Promise.all(responses);
  assert(wasm.some(resource=>resource.bytes>8),"actual compiled Rust WASM artifact bytes were not observed; inline bridge requires independent source-bound translation");
  assert.deepEqual(pageErrors,[]);
  await page.locator("canvas").screenshot({path:resolve(output,"actual-public-character.png")});
  await writeFile(resolve(output,"evidence.json"),JSON.stringify({assetSha256:proof.result.outputs.output.sha256,...result,wasm},null,2)+'\n');
  console.log('imported-character-browser-acceptance=passed (source authority audit also mandatory)');
} finally {
  await browser.close();server.stop(true);
}
