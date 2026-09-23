import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { batchRigidSkin } from "./rigid-skin.js";

function fixture() {
  const root = new THREE.Group();
  root.position.set(2, -1, 3);
  root.rotation.y = 0.35;
  root.scale.setScalar(1.25);
  const parent = new THREE.Bone();
  const child = new THREE.Bone();
  child.position.y = 1;
  parent.add(child);
  root.add(parent);
  const a = new THREE.MeshBasicMaterial();
  const b = new THREE.MeshBasicMaterial();
  const sources = [a, b, a].map((material, index) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.4, 0.3), material);
    mesh.position.set(index * 0.3, 0.2, -0.1);
    mesh.rotation.z = 0.2;
    mesh.scale.set(0.8, 1.2, 1);
    (index === 1 ? parent : child).add(mesh);
    return mesh;
  });
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton([parent, child]);
  const inverse = root.matrixWorld.clone().invert();
  const parts = sources.map((source, index) => ({
    geometry: source.geometry, material: source.material, joint: index === 1 ? 0 : 1,
    matrix: inverse.clone().multiply(source.matrixWorld),
  }));
  return { root, parent, child, skeleton, sources, parts };
}

function close(actual, expected) {
  expect(actual.distanceTo(expected)).toBeLessThan(2e-5);
}

describe("rigid GPU skin batching", () => {
  test("groups by material identity while preserving indexed topology", () => {
    const f = fixture();
    const result = batchRigidSkin(f.skeleton, f.parts, f.root.matrixWorld);
    expect(result.sourceDraws).toBe(3);
    expect(result.materialDraws).toBe(2);
    expect(result.mesh.geometry.groups).toEqual([
      { start: 0, count: 72, materialIndex: 0 },
      { start: 72, count: 36, materialIndex: 1 },
    ]);
    expect(result.vertexCount).toBe(72);
    expect(result.mesh.geometry.index.count).toBe(108);
    expect(result.mesh.material[0]).toBe(f.sources[0].material);
    expect(result.mesh.material[1]).toBe(f.sources[1].material);
    const index = result.mesh.geometry.index;
    for (let part = 0; part < 3; part += 1) {
      for (let i = 0; i < 36; i += 1) {
        expect(index.getX(part * 36 + i)).toBe(f.parts[0].geometry.index.getX(i) + part * 24);
      }
    }
  });

  test("matches original rigid attachments at bind pose and after parent/root motion", () => {
    const f = fixture();
    const result = batchRigidSkin(f.skeleton, f.parts, f.root.matrixWorld);
    f.root.add(result.mesh);
    // Material grouping makes source order 0, 2, 1.
    const sourceOrder = [f.sources[0], f.sources[2], f.sources[1]];
    for (let frame = 0; frame < 17; frame += 1) {
      f.parent.rotation.x = frame * 0.035;
      f.child.rotation.z = -frame * 0.07;
      f.root.position.x = 2 + frame * 0.1;
      f.root.rotation.y = 0.35 + frame * 0.02;
      f.root.updateMatrixWorld(true);
      f.skeleton.update();
      let offset = 0;
      for (const source of sourceOrder) {
        const position = source.geometry.getAttribute("position");
        for (let vertex = 0; vertex < position.count; vertex += 1) {
          const expected = new THREE.Vector3().fromBufferAttribute(position, vertex).applyMatrix4(source.matrixWorld);
          const actual = result.mesh.getVertexPosition(offset + vertex, new THREE.Vector3()).applyMatrix4(result.mesh.matrixWorld);
          close(actual, expected);
        }
        offset += position.count;
      }
    }
  });

  test("does not mutate or dispose borrowed geometry, skeleton or material", () => {
    const f = fixture();
    const before = f.sources.map((source) => Array.from(source.geometry.getAttribute("position").array));
    let disposed = 0;
    f.sources.forEach((source) => source.geometry.addEventListener("dispose", () => { disposed += 1; }));
    const result = batchRigidSkin(f.skeleton, f.parts, f.root.matrixWorld);
    result.mesh.geometry.dispose();
    expect(disposed).toBe(0);
    expect(result.mesh.skeleton).toBe(f.skeleton);
    f.sources.forEach((source, index) => {
      expect(Array.from(source.geometry.getAttribute("position").array)).toEqual(before[index]);
      expect(source.geometry.getAttribute("skinIndex")).toBeUndefined();
    });
  });

  test("does not reuse static bind bounds for animated culling", () => {
    const f = fixture();
    expect(batchRigidSkin(f.skeleton, f.parts, f.root.matrixWorld).mesh.frustumCulled).toBe(false);
  });

  test("validates all parts before modifying any source", () => {
    const f = fixture();
    for (const invalid of [-1, 0.5, 2, NaN]) {
      expect(() => batchRigidSkin(f.skeleton, [f.parts[0], { ...f.parts[1], joint: invalid }], f.root.matrixWorld)).toThrow("invalid joint");
    }
    expect(f.parts[0].geometry.getAttribute("skinWeight")).toBeUndefined();
  });

  test("rejects partial, pre-skinned, singular and reflected inputs explicitly", () => {
    const f = fixture();
    const run = (part) => batchRigidSkin(f.skeleton, [part], f.root.matrixWorld);
    const partial = f.parts[0].geometry.clone();
    partial.setDrawRange(3, 3);
    expect(() => run({ ...f.parts[0], geometry: partial })).toThrow("partial draw");
    const skinned = f.parts[0].geometry.clone();
    skinned.setAttribute("skinWeight", new THREE.Float32BufferAttribute(new Float32Array(96), 4));
    expect(() => run({ ...f.parts[0], geometry: skinned })).toThrow("existing skin");
    expect(() => run({ ...f.parts[0], matrix: new THREE.Matrix4().makeScale(0, 1, 1) })).toThrow("non-reflecting");
    expect(() => run({ ...f.parts[0], matrix: new THREE.Matrix4().makeScale(-1, 1, 1) })).toThrow("non-reflecting");
    expect(() => batchRigidSkin(f.skeleton, [], f.root.matrixWorld)).toThrow("at least one");
    expect(() => batchRigidSkin(f.skeleton, f.parts, new THREE.Matrix4().makeScale(0, 1, 1))).toThrow("bind matrix");
  });
});
