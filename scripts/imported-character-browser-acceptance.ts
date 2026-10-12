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
// Mutate real production GLB data, preserving valid framing and all unrelated bytes.
function mutate(change: (json: any, binary: Buffer) => void): Buffer {
  const jsonLength = fox.readUInt32LE(12);
  const json = JSON.parse(fox.subarray(20,20+jsonLength).toString());
  const binary = Buffer.from(fox.subarray(28+jsonLength)); change(json,binary);
  const encoded = Buffer.from(JSON.stringify(json)); const padded = Buffer.alloc(Math.ceil(encoded.length/4)*4,0x20); encoded.copy(padded);
  const result = Buffer.alloc(28+padded.length+binary.length);
  result.writeUInt32LE(0x46546c67,0); result.writeUInt32LE(2,4); result.writeUInt32LE(result.length,8);
  result.writeUInt32LE(padded.length,12); result.writeUInt32LE(0x4e4f534a,16); padded.copy(result,20);
  result.writeUInt32LE(binary.length,20+padded.length); result.writeUInt32LE(0x004e4942,24+padded.length); binary.copy(result,28+padded.length);
  return result;
}
function accessorOffset(json: any, index: number): number {
  const accessor = json.accessors[index]; return (json.bufferViews[accessor.bufferView].byteOffset ?? 0)+(accessor.byteOffset ?? 0);
}
const malformed: Array<[string, RegExp, (json: any, binary: Buffer) => void]> = [
  ["dangling active joint", /joint|skin/i, (j,b) => { b.writeUInt16LE(24, accessorOffset(j,j.meshes[0].primitives[0].attributes.JOINTS_0)); }],
  ["nonfinite weight", /weight|influence/i, (j,b) => { b.writeFloatLE(NaN, accessorOffset(j,j.meshes[0].primitives[0].attributes.WEIGHTS_0)); }],
  ["negative weight", /weight|influence/i, (j,b) => { b.writeFloatLE(-1, accessorOffset(j,j.meshes[0].primitives[0].attributes.WEIGHTS_0)); }],
  ["zero weight tuple", /weight|influence/i, (j,b) => { b.fill(0,accessorOffset(j,j.meshes[0].primitives[0].attributes.WEIGHTS_0),accessorOffset(j,j.meshes[0].primitives[0].attributes.WEIGHTS_0)+16); }],
  ["nonfinite inverse bind", /bind|matrix/i, (j,b) => { b.writeFloatLE(Infinity,accessorOffset(j,j.skins[0].inverseBindMatrices)); }],
  ["dangling clip target", /target|node/i, j => { j.animations[0].channels[0].target.node=26; }],
  ["unsupported cubic interpolation", /interpolation|cubic/i, j => { j.animations[0].samplers[0].interpolation="CUBICSPLINE"; }],
];
const negativeFixtures = malformed.map(([name,reason,change]) => {
  const damaged=mutate(change); const receipt=structuredClone(proof);
  receipt.result.outputs.output.sha256=createHash("sha256").update(damaged).digest("hex");
  receipt.result.outputs.output.byteLength=damaged.byteLength;
  return {name,reason:reason.source,bytes:Array.from(damaged),receipt};
});
// Existing active-slot contract permits out-of-range indices only at zero weight.
const inactiveDamaged=mutate((json,binary)=>{
  const primitive=json.meshes[0].primitives[0];
  const weights=accessorOffset(json,primitive.attributes.WEIGHTS_0);
  assert.equal(binary.readFloatLE(weights+8),0,"selected real source lane must already be inactive");
  binary.writeUInt16LE(65535,accessorOffset(json,primitive.attributes.JOINTS_0)+4);
});
const inactiveReceipt=structuredClone(proof);
inactiveReceipt.result.outputs.output.sha256=createHash("sha256").update(inactiveDamaged).digest("hex");
inactiveReceipt.result.outputs.output.byteLength=inactiveDamaged.byteLength;
const inactiveFixture={bytes:Array.from(inactiveDamaged),receipt:inactiveReceipt};
// Actual embedded source pixels at an unauthorized URI: acquisition must not
// succeed merely because the image happens to be identical to the approved PNG.
const foxJsonLength=fox.readUInt32LE(12);
const foxJson=JSON.parse(fox.subarray(20,20+foxJsonLength).toString());
const imageView=foxJson.bufferViews[foxJson.images[0].bufferView];
const originalPng=fox.subarray(28+foxJsonLength+(imageView.byteOffset??0),28+foxJsonLength+(imageView.byteOffset??0)+imageView.byteLength);
const externalImageBytes=mutate(json=>{delete json.images[0].bufferView;json.images[0].uri='/unapproved-fox-image.png';});
const externalImageReceipt=structuredClone(proof);
externalImageReceipt.result.outputs.output.sha256=createHash("sha256").update(externalImageBytes).digest("hex");
externalImageReceipt.result.outputs.output.byteLength=externalImageBytes.byteLength;
const externalImageFixture={bytes:Array.from(externalImageBytes),receipt:externalImageReceipt};
// Supplemental review contracts: real source structure/keys, no invented data.
const capabilityFixtures = [
  {name:"empty selected scene", reason:"scene|hierarchy|mesh|unsupported", change:(j:any)=>{j.scenes=[{nodes:[]},...j.scenes];j.scene=0;}},
  {name:"required rig outside selected mesh scene", reason:"scene|hierarchy|joint|skin|node|unsupported", change:(j:any)=>{j.scenes=[{nodes:[1]},{nodes:[0]}];j.scene=0;}},
  {name:"instantaneous single-key Survey", reason:"clip|duration|instant|animation|unsupported", change:(j:any,b:Buffer)=>{
    for(const sampler of j.animations[0].samplers){const input=j.accessors[sampler.input];const first=b.readFloatLE(accessorOffset(j,sampler.input));assert.equal(first,0);input.count=1;input.min=[first];input.max=[first];j.accessors[sampler.output].count=1;}
  }},
].map(({name,reason,change})=>{
  const bytes=mutate(change);const receipt=structuredClone(proof);
  receipt.result.outputs.output.sha256=createHash("sha256").update(bytes).digest("hex");receipt.result.outputs.output.byteLength=bytes.byteLength;
  return {name,reason,bytes:Array.from(bytes),receipt};
});
const unapprovedRequests: string[]=[];
const wasm: Array<{url: string; sha256: string; bytes: number}> = [];
const pageErrors: string[] = [];
// Disposable fixture server, no application state, decoder or model implementation.
const server = Bun.serve({ hostname:"127.0.0.1", port:0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname==='/unapproved-fox-image.png') {return new Response(originalPng,{headers:{"Content-Type":"image/png"}});}
  if (url.pathname==='/acceptance-resource-observations') {return Response.json({requests:unapprovedRequests});}
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
page.on("request",request=>{if(new URL(request.url()).pathname==='/unapproved-fox-image.png'){unapprovedRequests.push(request.url());}});
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
  const result = await page.evaluate(async ({ importedPath, negativeFixtures, inactiveFixture, externalImageFixture, capabilityFixtures }) => {
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
    const completedCases=["repeated characters share actual immutable geometry/material/skin buffers but independent poses"];
    const samples=[];
    for(const sample of oracle.samples) {
      await a.seek(sample.clip,sample.time);const actual=pose(a);
      check(mesh(a).skeleton.bones.length===24,'skin palette != scene node indices');
      check(JSON.stringify(mesh(a).skeleton.bones.map(bone=>bone.name))===JSON.stringify(sample.joints.map(joint=>joint.name)),'actual joint names/order differ');
      sample.joints.forEach((joint,i)=>close(actual.joints[i],joint.matrixWorld,0.002));
      sample.vertices.forEach((vertex,i)=>close(actual.vertices[i],vertex.world,0.02));
      check(JSON.stringify(pose(b))===bBefore,'A seek changed B');check(immutable(a)===fixed,'seek rebuilt/mutated immutable buffers');
      samples.push({clip:sample.clip,time:sample.time,...actual});
    }
    completedCases.push("public live instances seek all actual Fox joint/world-vertex oracle poses");
    await a.seek('Walk',0);const walkStart=JSON.stringify(pose(a));
    await a.seek('Walk',oracle.samples.find(sample=>sample.clip==='Walk' && sample.time>0).time);
    check(JSON.stringify(pose(a))!==walkStart,'actual Walk pose does not move');
    await a.seek('Walk',0.321);check(JSON.stringify(pose(a))!==bBefore,'nonoracle Walk pose did not move');
    await a.seek('Run',0.117);check(JSON.stringify(pose(b))===bBefore && immutable(a)===fixed,'nonoracle seek changed other instance/resources');
    await a.seek('Walk',0.321);const before=JSON.stringify(pose(a));
    for(const attempt of [()=>a.seek('Walk',NaN),()=>a.seek('Walk',Infinity),()=>a.seek('absent-clip',0),()=>a.advance(-1),()=>a.transition('Run',-1)]) {
      let rejected=false;try{await attempt();}catch{rejected=true;}
      check(rejected,'invalid runtime input succeeded');check(JSON.stringify(pose(a))===before && immutable(a)===fixed,'invalid input was not atomic');
    }
    completedCases.push("invalid seek, unknown clip and invalid transition/delta preserve valid pose and resources");
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
    const placement=new THREE.Matrix4().makeRotationY(0.37).setPosition(7,-3,11);
    // Positive inactive-lane fault: mutate only one existing zero-weight slot.
    const inactiveAsset=await module.adaptImportedCharacter(new Uint8Array(inactiveFixture.bytes),{provenance:inactiveFixture.receipt});
    const inactive=inactiveAsset.createInstance();await inactive.seek('Walk',0.321);
    const inactivePose=pose(inactive),normalPose=pose(a);
    inactivePose.joints.forEach((matrix,i)=>close(matrix,normalPose.joints[i],0.002));
    inactivePose.vertices.forEach((vertex,i)=>close(vertex,normalPose.vertices[i],0.02));
    const inactiveMesh=mesh(inactive),palette=inactiveMesh.skeleton.bones.length;
    const unsafeSlots=Array.from(inactiveMesh.geometry.attributes.skinIndex.array).filter(index=>!Number.isInteger(index)||index<0||index>=palette);
    // Existing renderer uses stock Three skinbase_vertex: it unconditionally
    // fetches all four matrices. A real guarded shader alternative requires an
    // independent source-bound assertion translation, never an unsafe allowlist.
    check(unsafeSlots.length===0,'inactive slot reaches unguarded GPU palette fetch; bounded indices or independently verified actual shader guard required');
    const inactivePixels=draw([inactive]);
    check(inactivePixels.every((value,index)=>value===moving[index]),'inactive zero-weight slot changed actual rendered frame');
    const inactiveSibling=inactiveAsset.createInstance();
    check(mesh(inactiveSibling).geometry===inactiveMesh.geometry,'inactive accepted asset did not retain shared geometry');
    draw([a]);
    // No network acquisition may occur before semantic external-image rejection.
    await a.seek('Walk',0.321);const beforeExternal=JSON.stringify(pose(a)),buffersExternal=immutable(a);
    let externalFailure;try {await module.adaptImportedCharacter(new Uint8Array(externalImageFixture.bytes),{provenance:externalImageFixture.receipt});}catch(error){externalFailure=error;}
    const acquisition=await(await fetch('/acceptance-resource-observations')).json();
    check(acquisition.requests.length===0,`external image acquired outside provenance: ${JSON.stringify(acquisition.requests)}`);
    check(externalFailure && /image|uri|external/i.test(String(externalFailure)),'external image must reject semantically, not by unrelated network failure');
    check(JSON.stringify(pose(a))===beforeExternal && immutable(a)===buffersExternal,'external image rejection damaged retained valid instance');
    await a.seek('Run',0.117);check(JSON.stringify(pose(a))!==beforeExternal,'valid instance unusable after external image rejection');
    await a.seek('Walk',0.321);
    for(const fixture of negativeFixtures) {
      const retained=await module.adaptImportedCharacter(bytes,{provenance:proof});
      const valid=retained.createInstance();await valid.seek('Walk',0.321);
      const priorPose=JSON.stringify(pose(valid)),priorBuffers=immutable(valid);
      let failure;try {await module.adaptImportedCharacter(new Uint8Array(fixture.bytes),{provenance:fixture.receipt});} catch(error) {failure=error;}
      check(failure && new RegExp(fixture.reason,'i').test(String(failure)),`${fixture.name}: semantic rejection reason missing`);
      check(JSON.stringify(pose(valid))===priorPose && immutable(valid)===priorBuffers,`${fixture.name}: damaged prior retained instance`);
      await valid.seek('Run',0.117);check(JSON.stringify(pose(valid))!==priorPose,`${fixture.name}: prior valid instance cannot be reused`);
      completedCases.push(`malformed actual Fox ${fixture.name} is rejected without damaging a retained valid instance`);
    }
    const placed=asset.createInstance({modelMatrix:placement.elements});
    await a.seek('Walk',0.321);await placed.seek('Walk',0.321);const canonical=pose(a),shifted=pose(placed);
    canonical.joints.forEach((matrix,i)=>close(shifted.joints[i],new THREE.Matrix4().multiplyMatrices(placement,new THREE.Matrix4().fromArray(matrix)).elements,0.002));
    canonical.vertices.forEach((vertex,i)=>close(shifted.vertices[i],new THREE.Vector3().fromArray(vertex).applyMatrix4(placement).toArray(),0.02));
    check(mesh(a).skeleton.bones.length===24 && proof.result.observations.nodes.length===26,'scene indices confused with skin palette slots');
    completedCases.push("model placement composes outside all nonjoint ancestors, inverse binds and skin slots");
    await a.seek('Survey',0);await b.seek('Survey',0);await a.transition('Walk',0.4);await b.transition('Walk',0.4);
    await a.advance(0.2);for(let i=0;i<20;i++){await b.advance(0.01);}
    const mid=pose(a);pose(b).joints.forEach((matrix,i)=>close(matrix,mid.joints[i],0.002));
    const target=asset.createInstance();await target.seek('Walk',0.2);check(JSON.stringify(mid)!==JSON.stringify(pose(target)),'fade instantly replaced clip');
    await a.advance(0.2);await target.seek('Walk',0.4);pose(a).joints.forEach((matrix,i)=>close(matrix,pose(target).joints[i],0.002));
    completedCases.push("live public crossfade uses measured deltas, is partition invariant and reaches target clip");
    check(completedCases.length===12,'runtime case coverage incomplete');
    const capabilities=[];
    for(const fixture of capabilityFixtures){
      await a.seek('Walk',0.321);const prior=JSON.stringify(pose(a)),buffers=immutable(a);
      let candidate,rejection;
      try{candidate=await module.adaptImportedCharacter(new Uint8Array(fixture.bytes),{provenance:fixture.receipt});}catch(error){rejection=error;}
      let error;
      try{
        if(rejection){check(new RegExp(fixture.reason,'i').test(String(rejection)),`${fixture.name}: useful adaptation capability rejection missing`);}
        else{
          const live=candidate.createInstance();
          if(fixture.name==='instantaneous single-key Survey'){
            check(candidate.clips.some(clip=>clip.name==='Survey'&&clip.duration===0),'actual single-key clip metadata lost');
          }
          // These mutations preserve every original bind/rest/key value. A
          // supported consumer must retain the original Survey first-key pose.
          for(const time of fixture.name==='instantaneous single-key Survey'?[0,1]:[0]){
            await live.seek('Survey',time);const actual=pose(live),expected=oracle.samples.find(sample=>sample.clip==='Survey'&&sample.time===0);
            expected.joints.forEach((joint,i)=>close(actual.joints[i],joint.matrixWorld,0.002));
            expected.vertices.forEach((vertex,i)=>close(actual.vertices[i],vertex.world,0.02));
          }
          const sibling=candidate.createInstance();check(mesh(sibling).geometry===mesh(live).geometry,`${fixture.name}: shared resources lost`);
          const rendered=draw([live]);let visibleGeometry=0;for(let i=0;i<rendered.length;i+=4){if(rendered[i]!==empty[i]||rendered[i+1]!==empty[i+1]||rendered[i+2]!==empty[i+2]){visibleGeometry++;}}
          check(visibleGeometry>64,`${fixture.name}: accepted geometry not visibly submitted`);
        }
        check(JSON.stringify(pose(a))===prior&&immutable(a)===buffers,`${fixture.name}: damaged retained valid instance`);
        await a.seek('Run',0.117);check(JSON.stringify(pose(a))!==prior,`${fixture.name}: retained valid Run unusable`);
      }catch(failure){error=String(failure);}
      capabilities.push({name:fixture.name,adaptationRejected:!!rejection,rejection:rejection?String(rejection):undefined,error});
    }
    check(instantiated>0,'candidate path never instantiated actual compiled WebAssembly');
    check(immutable(a)===fixed && am.geometry===bm.geometry,'fade rebuilt immutable resource');
    draw([a,placed]);
    // Presentation-only draw loop keeps a real submitted frame available for screenshot.
    const present=()=>{module.renderImportedCharacterInstances(renderer,{camera:renderCamera,instances:[a,placed]});requestAnimationFrame(present);};requestAnimationFrame(present);
    return {capabilities,externalImage:{semanticRejection:true,outboundRequests:0,priorInstanceUsable:true},inactiveSlot:{accepted:true,finitePose:true,boundedGpuPalette:true,unchangedFrame:true},completedCases,samples,visiblePixels:visible,movingPixels:changed,wasmInstances:instantiated,sharedGeometry:true,sharedInfluences:true,independentPoses:true};
  }, {importedPath,negativeFixtures,inactiveFixture,externalImageFixture,capabilityFixtures});
  await Promise.all(responses);
  assert(wasm.some(resource=>resource.bytes>8),"actual compiled Rust WASM artifact bytes were not observed; inline bridge requires independent source-bound translation");
  assert.deepEqual(pageErrors,[]);
  await page.locator("canvas").screenshot({path:resolve(output,"actual-public-character.png")});
  await writeFile(resolve(output,"evidence.json"),JSON.stringify({assetSha256:proof.result.outputs.output.sha256,...result,wasm},null,2)+'\n');
  assert(result.capabilities.every(item=>!item.error),JSON.stringify(result.capabilities));
  console.log('imported-character-browser-acceptance=passed (source authority audit also mandatory)');
} finally {
  await writeFile(resolve(output,"resource-observations.json"),JSON.stringify({unapprovedRequests},null,2)+'\n');
  await browser.close();server.stop(true);
}
