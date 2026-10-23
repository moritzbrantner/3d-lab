// #141 manual reference run: the published asset-tooling Ranger bundle in plain three.js
// (GLTFLoader, AnimationMixer, SkeletonUtils.clone) versus the existing 3d-lab candidate
// (`adaptImportedCharacterBundle` / `adaptImportedItemBundle` / `attach`). Measures only; it
// adds no candidate capability and is not part of routine CI.
//
//   gh release download humanoid-ranger-male -R moritzbrantner/asset-tooling -p humanoid.ranger.male.tar -p export.ref.json -D target --clobber
//   bun scripts/ranger-three-reference.ts target/humanoid.ranger.male.tar [target/ranger-three-reference]
//
// Writes `reference.json` (sampled transforms, vertices and differences) and one same-camera
// side-by-side screenshot per pose. A candidate operation that fails is recorded `unsupported`.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const tarPath = process.argv[2];
if (!tarPath) throw Error("usage: bun scripts/ranger-three-reference.ts <humanoid.ranger.male.tar> [output-dir]");
const output = resolve(process.argv[3] ?? "target/ranger-three-reference");
const bundleDir = resolve(output, "bundle");
await rm(bundleDir, { recursive: true, force: true });
await mkdir(resolve(output, "screenshots"), { recursive: true });
await mkdir(bundleDir, { recursive: true });
const untar = Bun.spawnSync(["tar", "-xf", resolve(tarPath), "-C", bundleDir]);
if (untar.exitCode !== 0) throw Error(`tar failed: ${untar.stderr}`);
const manifest = JSON.parse(await readFile(resolve(bundleDir, "manifest.json"), "utf8"));
const exportRef = JSON.parse(await readFile(resolve(bundleDir, "export.ref.json"), "utf8").catch(() => "null"));

const CHARACTER = "humanoid.ranger.male";
const EQUIPMENT = [
  { socket: "hand_r.weapon", key: "equipment.sword.arming" },
  { socket: "hand_l.shield", key: "equipment.shield.heater" },
];
const POSES = [
  { id: "rest" },
  { id: "Idle_Loop@0.5", clip: "Idle_Loop", time: 0.5 },
  ...[0, 0.25, 0.5, 0.75].map(fraction => ({ id: `Walk_Loop@${fraction}`, clip: "Walk_Loop", fraction })),
  { id: "Sword_Regular_C@0.65", clip: "Sword_Regular_C", time: 0.65 },
  { id: "Idle_Shield_Loop@0.5", clip: "Idle_Shield_Loop", time: 0.5 },
];
const VERTEX_MESHES = ["Male_Ranger_Body", "Male_Ranger_Head_Hood", "Male_Ranger_Feet_Boots", "SuperHero_Male"];

const within = (base: string, path: string) => path.startsWith(base.endsWith(sep) ? base : base + sep);
const pageHtml = `<!doctype html><html><head><style>
body{margin:0;background:#05070b;color:#d8dee9;font:14px system-ui,sans-serif}
#row{display:flex;gap:8px;padding:8px}figure{margin:0}figcaption{padding:4px 0}#pose{padding:8px 8px 0;font-weight:600}
</style></head><body><div id="pose"></div><div id="row">
<figure><canvas id="ref2d" width="480" height="540"></canvas><figcaption>three.js reference (GLTFLoader, AnimationMixer, SkeletonUtils.clone)</figcaption></figure>
<figure><canvas id="cand2d" width="480" height="540"></canvas><figcaption id="candcap">3d-lab candidate (adaptImportedCharacterBundle)</figcaption></figure>
</div><canvas id="refgl" width="480" height="540" hidden></canvas><canvas id="candgl" width="480" height="540" hidden></canvas></body></html>`;

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/") return new Response(pageHtml, { headers: { "Content-Type": "text/html" } });
  const base = url.pathname.startsWith("/bundle/") ? bundleDir : root;
  const relative = url.pathname.startsWith("/bundle/") ? url.pathname.slice("/bundle/".length) : url.pathname;
  const path = resolve(base, `./${decodeURIComponent(relative)}`);
  if (!within(base, path)) return new Response("outside root", { status: 403 });
  const file = Bun.file(path);
  return (await file.exists()) ? new Response(file) : new Response("missing", { status: 404 });
} });
const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader"] });
const page = await browser.newPage({ viewport: { width: 984, height: 620 } });
const pageErrors: string[] = [];
page.on("pageerror", error => pageErrors.push(error.message));
try {
  await page.goto(`http://127.0.0.1:${server.port}/`);
  await page.evaluate(() => {
    const map = document.createElement("script"); map.type = "importmap";
    map.textContent = JSON.stringify({ imports: { three: "/node_modules/three/build/three.module.js", "three/": "/node_modules/three/" } });
    document.head.appendChild(map);
  });
  const setup = await page.evaluate(async ({ manifest, CHARACTER, EQUIPMENT, VERTEX_MESHES }) => {
    const THREE = await import("three");
    const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
    const { clone: cloneSkeleton } = await import("three/examples/jsm/utils/SkeletonUtils.js");
    const { DEFAULT_SKY, DEFAULT_SUN } = await import("/packages/renderer/environment.js");
    const publicRenderer = await import("/packages/renderer/index.js");
    const module = await import("/packages/renderer/imported-character.js");
    const entry = (key: string) => manifest.assets.find((asset: any) => asset.key === key && asset.variant === "default");
    const readResource = async (path: string) => {
      const response = await fetch(`/bundle/${path}`);
      if (!response.ok) throw Error(`missing bundle file ${path}`);
      return response.arrayBuffer();
    };
    const message = (error: unknown) => String((error as any)?.message ?? error);
    const sockets = (await module.readBundleAttachment({ manifest, key: CHARACTER, name: "humanoid-sockets", readResource }) as any).sockets;
    const clipTable = (await module.readBundleAttachment({ manifest, key: CHARACTER, name: "humanoid-clips", readResource }) as any).clips;
    const socketMatrix = (id: string) => {
      const socket = sockets.find((s: any) => s.id === id) ?? (() => { throw Error(`no socket ${id}`); })();
      return { socket, matrix: new THREE.Matrix4().compose(new THREE.Vector3(...socket.translation), new THREE.Quaternion(...socket.rotation), new THREE.Vector3(1, 1, 1)) };
    };

    // Reference: plain three.js, the way a consumer would load the bundle.
    const loader = new GLTFLoader();
    const character = await loader.loadAsync(`/bundle/${entry(CHARACTER).path}`);
    const items = Object.fromEntries(await Promise.all(EQUIPMENT.map(async (e: any) => [e.key, await loader.loadAsync(`/bundle/${entry(e.key).path}`)])));
    const referenceInstance = () => {
      const root = cloneSkeleton(character.scene);
      const attached = EQUIPMENT.map((e: any) => {
        const { socket, matrix } = socketMatrix(e.socket);
        const item = items[e.key].scene.clone(true); item.updateMatrixWorld(true);
        const grip = item.getObjectByName("grip");
        const holder = new THREE.Group(); holder.matrixAutoUpdate = false;
        holder.matrix.multiplyMatrices(matrix, grip.matrixWorld.clone().invert());
        holder.add(item); root.getObjectByName(socket.joint).add(holder);
        return { socket: e.socket, gripWorld: () => grip.matrixWorld.toArray(), root: item };
      });
      return { root, attached };
    };

    // Candidate: the existing 3d-lab imported-character path, unchanged.
    const candidate: any = { status: "supported" };
    try { candidate.asset = await module.adaptImportedCharacterBundle({ manifest, key: CHARACTER, readResource }); }
    catch (error) { candidate.status = "unsupported"; candidate.error = `adaptImportedCharacterBundle: ${message(error)}`; }
    candidate.items = {};
    for (const e of EQUIPMENT as any[]) {
      try { candidate.items[e.key] = await module.adaptImportedItemBundle({ manifest, key: e.key, readResource }); }
      catch (error) { candidate.items[e.key] = { unsupported: `adaptImportedItemBundle(${e.key}): ${message(error)}` }; }
    }
    const candidateInstance = () => {
      const instance = candidate.asset.createInstance();
      const attached = (EQUIPMENT as any[]).map(e => {
        const item = candidate.items[e.key];
        if (item.unsupported) return { socket: e.socket, unsupported: item.unsupported };
        const { socket, matrix } = socketMatrix(e.socket);
        const itemInstance = item.createInstance();
        try { instance.attach(itemInstance, { joint: socket.joint, socket: matrix.toArray(), frame: "grip" }); }
        catch (error) { return { socket: e.socket, unsupported: `attach(${e.socket}): ${message(error)}` }; }
        const grip = new THREE.Matrix4().fromArray(itemInstance.frames.grip);
        return { socket: e.socket, gripWorld: () => itemInstance.root.matrixWorld.clone().multiply(grip).toArray(), root: itemInstance.root };
      });
      return { instance, root: instance.root, attached };
    };

    const measure = (root: any, attached: any[]) => {
      root.updateMatrixWorld(true);
      const meshes: any[] = []; root.traverse((n: any) => { if (n.isSkinnedMesh) meshes.push(n); });
      const joints: Record<string, number[]> = {};
      for (const mesh of meshes) for (const bone of mesh.skeleton.bones) joints[bone.name] ??= bone.matrixWorld.toArray();
      const socketWorld: Record<string, any> = {};
      for (const a of attached) {
        const { socket, matrix } = socketMatrix(a.socket);
        const bone = root.getObjectByName(socket.joint);
        socketWorld[a.socket] = a.unsupported ? { unsupported: a.unsupported } : { socket: bone.matrixWorld.clone().multiply(matrix).toArray(), grip: a.gripWorld() };
      }
      const vertices: Record<string, any[]> = {};
      for (const name of VERTEX_MESHES) {
        const mesh = meshes.find(m => m.name === name);
        if (!mesh) continue;
        const count = mesh.geometry.attributes.position.count;
        vertices[name] = [0, Math.floor(count / 3), Math.floor((2 * count) / 3), count - 1].map(index => ({ index, world: mesh.getVertexPosition(index, new THREE.Vector3()).applyMatrix4(mesh.matrixWorld).toArray() }));
      }
      return { joints, sockets: socketWorld, vertices };
    };
    const materials = (root: any) => {
      const list: any[] = [];
      root.traverse((n: any) => { if (n.isMesh) for (const m of Array.isArray(n.material) ? n.material : [n.material]) list.push({ mesh: n.name, type: m.type, map: !!m.map, normalMap: !!m.normalMap, roughnessMap: !!m.roughnessMap, color: m.color?.getHexString(), roughness: m.roughness, metalness: m.metalness }); });
      return list;
    };

    // Same camera and light values for both renderers; gameplay distance (~6 m).
    const camera = new THREE.PerspectiveCamera(40, 480 / 540, 0.1, 100);
    camera.position.set(2.4, 1.8, 5.4); camera.lookAt(0, 0.95, 0); camera.updateMatrixWorld(true);
    const renderCamera = { viewMatrix: camera.matrixWorldInverse.toArray(), projectionMatrix: camera.projectionMatrix.toArray() };
    const refRenderer = new THREE.WebGLRenderer({ canvas: document.getElementById("refgl") as HTMLCanvasElement, antialias: false });
    refRenderer.setSize(480, 540, false);
    const refScene = new THREE.Scene(); refScene.background = new THREE.Color(0x0c111a);
    refScene.add(new THREE.HemisphereLight(DEFAULT_SKY.skyColor, DEFAULT_SKY.groundColor, DEFAULT_SKY.intensity));
    const sun = new THREE.DirectionalLight(DEFAULT_SUN.color, DEFAULT_SUN.intensity); sun.position.set(...DEFAULT_SUN.direction); refScene.add(sun);
    const candRenderer = publicRenderer.createThreeSceneRenderer(document.getElementById("candgl"), { background: 0x0c111a, shadows: false, antialias: false });
    candRenderer.setSize(480, 540, 1);
    const blit = (from: string, to: string) => (document.getElementById(to) as HTMLCanvasElement).getContext("2d")!.drawImage(document.getElementById(from) as HTMLCanvasElement, 0, 0);
    const clear2d = (to: string, text: string) => { const c = (document.getElementById(to) as HTMLCanvasElement).getContext("2d")!; c.fillStyle = "#0c111a"; c.fillRect(0, 0, 480, 540); c.fillStyle = "#e5a50a"; c.font = "16px system-ui"; c.fillText("unsupported", 16, 32); c.font = "12px system-ui"; text.match(/.{1,70}/g)?.forEach((line, i) => c.fillText(line, 16, 56 + i * 16)); };

    let current: any = {};
    (window as any).__lab = {
      // Repeatable seek and independent instances: A seeks, B seeks another clip, A seeks again.
      instances() {
        if (candidate.status !== "supported") return { unsupported: candidate.error };
        const walk = character.animations.find((c: any) => c.name === "Walk_Loop"), t = walk.duration * 0.25;
        const a = candidateInstance(), b = candidateInstance();
        a.instance.seek("Walk_Loop", t); const first = measure(a.root, a.attached);
        b.instance.seek("Sword_Regular_C", 0.65); a.instance.seek("Idle_Loop", 0.5); a.instance.seek("Walk_Loop", t);
        const again = measure(a.root, a.attached), other = measure(b.root, b.attached);
        a.instance.dispose(); b.instance.dispose();
        const r1 = referenceInstance(), r2 = referenceInstance();
        const m1 = new THREE.AnimationMixer(r1.root), m2 = new THREE.AnimationMixer(r2.root);
        m1.clipAction(walk).play(); m1.setTime(t); m2.clipAction(character.animations.find((c: any) => c.name === "Sword_Regular_C")).play(); m2.setTime(0.65);
        return { candidateFirst: first, candidateAgain: again, candidateOther: other, referenceFirst: measure(r1.root, r1.attached), referenceOther: measure(r2.root, r2.attached) };
      },
      sample(pose: any) {
        document.getElementById("pose")!.textContent = `humanoid.ranger.male (rolling) — ${pose.id} (sword on hand_r.weapon, shield on hand_l.shield)`;
        current.ref?.root.removeFromParent(); current.cand?.instance.dispose();
        const clip = pose.clip ? character.animations.find((c: any) => c.name === pose.clip) : undefined;
        if (pose.clip && !clip) throw Error(`reference has no clip ${pose.clip}`);
        const time = pose.clip ? (pose.time ?? clip.duration * pose.fraction) : null;
        const ref = referenceInstance();
        if (clip) { const mixer = new THREE.AnimationMixer(ref.root); mixer.clipAction(clip).play(); mixer.setTime(time); }
        refScene.add(ref.root);
        const reference = measure(ref.root, ref.attached);
        refRenderer.render(refScene, camera); blit("refgl", "ref2d");
        current = { ref };
        let cand: any;
        if (candidate.status !== "supported") cand = { unsupported: candidate.error };
        else {
          try {
            const c = candidateInstance(); current.cand = c;
            if (clip) c.instance.seek(pose.clip, time);
            cand = measure(c.root, c.attached);
            module.renderImportedCharacterInstances(candRenderer, { camera: renderCamera, instances: [c.instance] }); blit("candgl", "cand2d");
          } catch (error) { cand = { unsupported: `${pose.clip ? `seek(${pose.clip}, ${time})` : "createInstance"}: ${message(error)}` }; }
        }
        if (cand.unsupported) clear2d("cand2d", cand.unsupported);
        return { id: pose.id, clip: pose.clip ?? null, time, reference, candidate: cand };
      },
    };
    const refProbe = referenceInstance();
    let candMaterials: any = { unsupported: candidate.error };
    if (candidate.status === "supported") { const c = candidateInstance(); candMaterials = materials(c.root); c.instance.dispose(); }
    return {
      threeRevision: THREE.REVISION,
      candidate: { status: candidate.status, error: candidate.error ?? null, items: Object.fromEntries(Object.entries(candidate.items).map(([k, v]: any) => [k, v.unsupported ?? "supported"])) },
      clips: character.animations.map((clip: any) => ({
        name: clip.name, referenceDuration: clip.duration,
        candidateDuration: candidate.asset?.clips.find((c: any) => c.name === clip.name)?.duration ?? null,
        authoredDuration: clipTable.find((c: any) => c.name === clip.name)?.durationSeconds ?? null,
        rootMotion: clipTable.find((c: any) => c.name === clip.name)?.rootMotion ?? null,
      })),
      sockets: sockets.filter((s: any) => (EQUIPMENT as any[]).some(e => e.socket === s.id)),
      materials: { reference: materials(refProbe.root), candidate: candMaterials },
    };
  }, { manifest, CHARACTER, EQUIPMENT, VERTEX_MESHES });

  const samples = [];
  for (const pose of POSES) {
    const sample = await page.evaluate(pose => (window as any).__lab.sample(pose), pose);
    await page.screenshot({ path: resolve(output, "screenshots", `${pose.id.replace(/[^A-Za-z0-9_.-]/g, "_")}.png`) });
    samples.push({ ...sample, differences: compare(sample.reference, sample.candidate) });
  }
  const inst = await page.evaluate(() => (window as any).__lab.instances());
  const instances = inst.unsupported ? inst : {
    repeatSeek: compare(inst.candidateFirst, inst.candidateAgain).summary,
    instanceAVsReference: compare(inst.referenceFirst, inst.candidateAgain).summary,
    instanceBVsReference: compare(inst.referenceOther, inst.candidateOther).summary,
  };
  console.log("instances", JSON.stringify(instances));
  const report = {
    reference: `three.js r${setup.threeRevision} GLTFLoader + AnimationMixer + SkeletonUtils.clone`,
    candidate: "3d-lab packages/renderer/imported-character.js (adaptImportedCharacterBundle, adaptImportedItemBundle, attach, seek)",
    release: "moritzbrantner/asset-tooling humanoid-ranger-male (rolling)",
    bundle: { tar: resolve(tarPath), tarSha256: new Bun.CryptoHasher("sha256").update(await readFile(resolve(tarPath))).digest("hex"), profile: manifest.profile, exportRef, character: entryForReport(CHARACTER), equipment: EQUIPMENT.map(e => entryForReport(e.key)) },
    ...setup, samples, instances, pageErrors,
  };
  await writeFile(resolve(output, "reference.json"), JSON.stringify(report, null, 2) + "\n");
  for (const s of samples) console.log(s.id, JSON.stringify(s.differences.summary ?? s.differences));
  console.log(`ranger-three-reference written to ${output}`);
} finally {
  await browser.close(); server.stop(true);
}

function entryForReport(key: string) {
  const entry = manifest.assets.find((asset: any) => asset.key === key && asset.variant === "default");
  return { key, path: entry.path, sha256: entry.sha256, source: entry.source?.metadata ?? null };
}
function position(m: number[]) { return [m[12], m[13], m[14]]; }
function distance(a: number[], b: number[]) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
function quaternion(m: number[]) {
  const sx = Math.hypot(m[0], m[1], m[2]), sy = Math.hypot(m[4], m[5], m[6]), sz = Math.hypot(m[8], m[9], m[10]);
  const r = [m[0] / sx, m[1] / sx, m[2] / sx, m[4] / sy, m[5] / sy, m[6] / sy, m[8] / sz, m[9] / sz, m[10] / sz];
  const [m11, m21, m31, m12, m22, m32, m13, m23, m33] = r, trace = m11 + m22 + m33;
  if (trace > 0) { const s = 0.5 / Math.sqrt(trace + 1); return [(m32 - m23) * s, (m13 - m31) * s, (m21 - m12) * s, 0.25 / s]; }
  if (m11 > m22 && m11 > m33) { const s = 2 * Math.sqrt(1 + m11 - m22 - m33); return [0.25 * s, (m12 + m21) / s, (m13 + m31) / s, (m32 - m23) / s]; }
  if (m22 > m33) { const s = 2 * Math.sqrt(1 + m22 - m11 - m33); return [(m12 + m21) / s, 0.25 * s, (m23 + m32) / s, (m13 - m31) / s]; }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22); return [(m13 + m31) / s, (m23 + m32) / s, 0.25 * s, (m21 - m12) / s];
}
function angleDeg(a: number[], b: number[]) {
  const qa = quaternion(a), qb = quaternion(b), na = Math.hypot(...qa), nb = Math.hypot(...qb);
  const dot = Math.min(1, Math.abs(qa.reduce((sum, v, i) => sum + v * qb[i], 0) / (na * nb)));
  return (2 * Math.acos(dot) * 180) / Math.PI;
}
function compare(reference: any, candidate: any) {
  if (candidate.unsupported) return { unsupported: candidate.unsupported };
  const names = Object.keys(reference.joints);
  const missingJoints = names.filter(name => !candidate.joints[name]);
  let maxPosition = 0, maxPositionJoint = "", sumPosition = 0, maxRotation = 0, maxRotationJoint = "";
  for (const name of names.filter(n => candidate.joints[n])) {
    const d = distance(position(reference.joints[name]), position(candidate.joints[name]));
    const r = angleDeg(reference.joints[name], candidate.joints[name]);
    sumPosition += d;
    if (d > maxPosition) { maxPosition = d; maxPositionJoint = name; }
    if (r > maxRotation) { maxRotation = r; maxRotationJoint = name; }
  }
  const sockets = Object.fromEntries(Object.entries(reference.sockets).map(([id, ref]: any) => {
    const cand = candidate.sockets[id];
    if (!cand || cand.unsupported) return [id, { unsupported: cand?.unsupported ?? "missing" }];
    return [id, { socketPositionM: distance(position(ref.socket), position(cand.socket)), socketRotationDeg: angleDeg(ref.socket, cand.socket), gripPositionM: distance(position(ref.grip), position(cand.grip)), gripRotationDeg: angleDeg(ref.grip, cand.grip) }];
  }));
  const vertexDiffs: number[] = [];
  const missingVertexMeshes: string[] = [];
  for (const [mesh, list] of Object.entries(reference.vertices) as any) {
    const other = candidate.vertices[mesh];
    if (!other) { missingVertexMeshes.push(mesh); continue; }
    list.forEach((v: any, i: number) => vertexDiffs.push(distance(v.world, other[i].world)));
  }
  const compared = names.length - missingJoints.length;
  return {
    summary: {
      joints: compared, maxJointPositionM: maxPosition, maxJointPositionJoint: maxPositionJoint, meanJointPositionM: compared ? sumPosition / compared : null,
      maxJointRotationDeg: maxRotation, maxJointRotationJoint: maxRotationJoint,
      vertices: vertexDiffs.length, maxVertexM: Math.max(0, ...vertexDiffs), meanVertexM: vertexDiffs.length ? vertexDiffs.reduce((a, b) => a + b, 0) / vertexDiffs.length : null,
    },
    missingJoints, missingVertexMeshes, sockets,
  };
}
