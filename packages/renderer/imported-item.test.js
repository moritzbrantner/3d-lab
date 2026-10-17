import { expect, test } from "bun:test";
import * as THREE from "three";
import { readFile } from "node:fs/promises";
import { attachToJoint, loadImportedItem } from "./imported-item.js";
import { adaptImportedItemBundle, readBundleAttachment } from "./imported-character.js";
import { splitGlbToBundle } from "../../scripts/lib/gltf-resources-bundle.ts";

const fail = message => { throw new Error(message); };
const tree = new Uint8Array(await readFile(new URL("../../fixtures/static-glb/tree.glb", import.meta.url)));
const near = (a, b) => a.forEach((value, i) => expect(value).toBeCloseTo(b[i], 5));

test("an item exposes its named frames and instances share geometry and materials", async () => {
  const item = await loadImportedItem(tree, "fixture:tree", fail);
  expect(Object.keys(item.frames).sort()).toEqual(["canopy", "root-flare", "trunk", "tree"].sort());
  const a = item.createInstance(), b = item.createInstance();
  expect(a.root.children.length).toBeGreaterThan(0);
  a.root.children.forEach((mesh, i) => {
    expect(mesh.geometry).toBe(b.root.children[i].geometry);
    expect(mesh.material).toBe(b.root.children[i].material);
  });
  item.dispose();
  expect(() => item.createInstance()).toThrow(/disposed/);
});

test("an attached item's frame lands on the joint's socket transform and follows the joint", async () => {
  const item = await loadImportedItem(tree, "fixture:tree", fail);
  const joint = new THREE.Object3D();
  joint.position.set(1, 2, 3);
  joint.quaternion.setFromEuler(new THREE.Euler(0.3, -0.7, 0.2));
  const scene = new THREE.Group();
  scene.add(joint);
  const socket = new THREE.Matrix4().compose(new THREE.Vector3(0.1, -0.2, 0.05), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 1.1, 0.4)), new THREE.Vector3(1, 1, 1));
  const instance = item.createInstance();
  const handle = attachToJoint(joint, instance, { frame: "canopy", socketMatrix: socket }, fail);
  const frameWorld = () => {
    scene.updateMatrixWorld(true);
    return instance.root.matrixWorld.clone().multiply(new THREE.Matrix4().fromArray(instance.frames.canopy)).toArray();
  };
  near(frameWorld(), joint.matrixWorld.clone().multiply(socket).toArray());
  joint.position.set(-4, 0.5, 2);
  near(frameWorld(), (scene.updateMatrixWorld(true), joint.matrixWorld.clone().multiply(socket)).toArray());
  expect(() => attachToJoint(joint, instance, { frame: "canopy", socketMatrix: socket }, fail)).toThrow(/already attached/);
  handle.detach();
  expect(instance.root.parent).toBeNull();
  expect(joint.children).toHaveLength(0);
  expect(() => attachToJoint(joint, instance, { frame: "absent", socketMatrix: socket }, fail)).toThrow(/no frame absent/);
});

test("items and JSON attachments load from a gltf-resources bundle", async () => {
  const bundle = splitGlbToBundle(tree, "equipment.tree");
  const descriptor = new TextEncoder().encode(JSON.stringify({ schema: "humanoid-sockets-v1", sockets: [] }));
  bundle.files.set("attachments/sockets.json", descriptor);
  bundle.manifest.assets[0].attachments = [{ name: "humanoid-sockets", mediaType: "application/json", path: "attachments/sockets.json", byteLength: descriptor.byteLength }];
  const readResource = async path => bundle.files.get(path) ?? fail(`missing ${path}`);
  const progress = [];
  const item = await adaptImportedItemBundle({ manifest: bundle.manifest, key: "equipment.tree", readResource }, { onProgress: p => progress.push(p) });
  expect(item.resourceKey).toStartWith("bundle:equipment.tree/default:");
  expect(item.frames.trunk).toHaveLength(16);
  expect(progress.at(-1).loadedBytes).toBe(progress.at(-1).totalBytes);
  expect(await readBundleAttachment({ manifest: bundle.manifest, key: "equipment.tree", name: "humanoid-sockets", readResource })).toEqual({ schema: "humanoid-sockets-v1", sockets: [] });
  await expect(readBundleAttachment({ manifest: bundle.manifest, key: "equipment.tree", name: "other", readResource })).rejects.toThrow(/no other attachment/);
});
