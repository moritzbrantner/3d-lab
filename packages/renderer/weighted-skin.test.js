import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { batchWeightedSkin } from "./weighted-skin.js";

function fixture() {
  const root = new THREE.Group();
  root.position.set(1.5, -0.25, 2);
  root.rotation.y = 0.2;
  const parent = new THREE.Bone();
  const child = new THREE.Bone();
  child.position.y = 1;
  parent.add(child);
  root.add(parent);
  root.updateMatrixWorld(true);
  const skeleton = new THREE.Skeleton([parent, child]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute([
    -0.2, 0.2, 0,
     0.2, 0.6, 0,
     0.2, 1.0, 0,
    -0.2, 0.8, 0,
  ], 3));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  const material = new THREE.MeshBasicMaterial();
  const skinIndices = new Uint16Array([
    0, 0, 0, 0,
    0, 1, 0, 0,
    1, 0, 0, 0,
    0, 1, 0, 0,
  ]);
  const skinWeights = new Float32Array([
    1, 0, 0, 0,
    0.5, 0.5, 0, 0,
    1, 0, 0, 0,
    0.25, 0.75, 0, 0,
  ]);
  return { root, parent, child, skeleton, geometry, material, skinIndices, skinWeights };
}

function worldForBone(mesh, skeleton, position, boneIndex) {
  const matrix = new THREE.Matrix4().fromArray(skeleton.boneMatrices, boneIndex * 16);
  return position.clone()
    .applyMatrix4(mesh.bindMatrix)
    .applyMatrix4(matrix)
    .applyMatrix4(mesh.bindMatrixInverse)
    .applyMatrix4(mesh.matrixWorld);
}

describe("weighted GPU skin batching", () => {
  test("preserves authored weights, batches materials and compacts small joint palettes", () => {
    const f = fixture();
    const result = batchWeightedSkin(f.skeleton, [{
      geometry: f.geometry,
      material: f.material,
      matrix: new THREE.Matrix4(),
      skinIndices: f.skinIndices,
      skinWeights: f.skinWeights,
    }], f.root.matrixWorld);
    expect(result.sourceDraws).toBe(1);
    expect(result.materialDraws).toBe(1);
    expect(result.multiJointVertices).toBe(2);
    expect(result.skinIndexBytesPerVertex).toBe(4);
    expect(result.mesh.geometry.getAttribute("skinIndex").array).toBeInstanceOf(Uint8Array);
    expect(Array.from(result.mesh.geometry.getAttribute("skinWeight").array)).toEqual(Array.from(f.skinWeights));
  });

  test("matches linear blend skinning after child motion", () => {
    const f = fixture();
    const result = batchWeightedSkin(f.skeleton, [{
      geometry: f.geometry,
      material: f.material,
      matrix: new THREE.Matrix4(),
      skinIndices: f.skinIndices,
      skinWeights: f.skinWeights,
    }], f.root.matrixWorld);
    f.root.add(result.mesh);
    f.child.rotation.z = 0.7;
    f.root.updateMatrixWorld(true);
    f.skeleton.update();
    const source = new THREE.Vector3().fromBufferAttribute(f.geometry.getAttribute("position"), 1);
    const parent = worldForBone(result.mesh, f.skeleton, source, 0);
    const child = worldForBone(result.mesh, f.skeleton, source, 1);
    const expected = parent.clone().multiplyScalar(0.5).addScaledVector(child, 0.5);
    const actual = result.mesh.getVertexPosition(1, new THREE.Vector3()).applyMatrix4(result.mesh.matrixWorld);
    expect(actual.distanceTo(expected)).toBeLessThan(2e-5);
  });

  test("bind pose is unchanged by smooth weighting", () => {
    const f = fixture();
    const result = batchWeightedSkin(f.skeleton, [{
      geometry: f.geometry,
      material: f.material,
      matrix: new THREE.Matrix4(),
      skinIndices: f.skinIndices,
      skinWeights: f.skinWeights,
    }], f.root.matrixWorld);
    f.root.add(result.mesh);
    f.root.updateMatrixWorld(true);
    f.skeleton.update();
    for (let vertex = 0; vertex < f.geometry.getAttribute("position").count; vertex += 1) {
      const expected = new THREE.Vector3().fromBufferAttribute(f.geometry.getAttribute("position"), vertex)
        .applyMatrix4(f.root.matrixWorld);
      const actual = result.mesh.getVertexPosition(vertex, new THREE.Vector3()).applyMatrix4(result.mesh.matrixWorld);
      expect(actual.distanceTo(expected)).toBeLessThan(2e-5);
    }
  });

  test("rejects malformed weights atomically and leaves source geometry untouched", () => {
    const f = fixture();
    const run = (skinIndices, skinWeights) => batchWeightedSkin(f.skeleton, [{
      geometry: f.geometry,
      material: f.material,
      matrix: new THREE.Matrix4(),
      skinIndices,
      skinWeights,
    }], f.root.matrixWorld);
    const wrongSum = f.skinWeights.slice();
    wrongSum[0] = 0.5;
    expect(() => run(f.skinIndices, wrongSum)).toThrow("sum to 1");
    const negative = f.skinWeights.slice();
    negative[0] = -0.1;
    negative[1] = 1.1;
    expect(() => run(f.skinIndices, negative)).toThrow("between 0 and 1");
    const invalidJoint = f.skinIndices.slice();
    invalidJoint[0] = 2;
    expect(() => run(invalidJoint, f.skinWeights)).toThrow("invalid joint");
    expect(() => run(f.skinIndices.subarray(0, 8), f.skinWeights)).toThrow("exactly four");
    expect(f.geometry.getAttribute("skinIndex")).toBeUndefined();
    expect(f.geometry.getAttribute("skinWeight")).toBeUndefined();
  });
});
