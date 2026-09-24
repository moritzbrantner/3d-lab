import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { buildCharacterModel } from "./character-model";
import { disposeRenderableResources } from "./three-resources";

describe("batched teaching character", () => {
  test("ratchets 31 authored parts into one smoothly weighted mesh and three color-pass groups", () => {
    const character = buildCharacterModel();
    let meshCount = 0;
    character.model.traverse((object) => { if ((object as THREE.Mesh).isMesh) meshCount += 1; });
    expect(meshCount).toBe(1);
    expect(character.sourceDraws).toBe(31);
    expect(character.materialDraws).toBe(3);
    expect(character.mesh.geometry.groups).toHaveLength(3);
    expect(character.skeleton.bones).toHaveLength(13);
    expect(character.blendedVertexCount).toBeGreaterThan(0);
    expect(character.skinIndexBytesPerVertex).toBe(4);
    expect(character.mesh.geometry.getAttribute("skinIndex").array).toBeInstanceOf(Uint8Array);
    const weights = character.mesh.geometry.getAttribute("skinWeight");
    let smoothVertices = 0;
    for (let vertex = 0; vertex < weights.count; vertex += 1) {
      const lanes = [weights.getX(vertex), weights.getY(vertex), weights.getZ(vertex), weights.getW(vertex)];
      expect(lanes.reduce((sum, weight) => sum + weight, 0)).toBeCloseTo(1, 5);
      expect(lanes.filter((weight) => weight > 0).length).toBeLessThanOrEqual(2);
      if (lanes.filter((weight) => weight > 0).length > 1) smoothVertices += 1;
    }
    expect(smoothVertices).toBe(character.blendedVertexCount);
  });

  test("helper follows bone world space without applying model transform twice", () => {
    const character = buildCharacterModel();
    const scene = new THREE.Scene();
    scene.add(character.model, character.skeletonHelper);
    character.model.position.set(3, 1.9, -2);
    character.model.rotation.y = 0.4;
    scene.updateMatrixWorld(true);
    character.skeletonHelper.matrixWorld.elements.forEach((value, index) => {
      expect(value).toBeCloseTo(character.bones.hips.matrixWorld.elements[index], 6);
    });
  });

  test("bind-pose feet touch the floor rather than penetrating it", () => {
    const character = buildCharacterModel();
    character.model.updateMatrixWorld(true);
    character.skeleton.update();
    const point = new THREE.Vector3();
    let minimum = Infinity;
    const count = character.mesh.geometry.getAttribute("position").count;
    for (let vertex = 0; vertex < count; vertex += 1) {
      character.mesh.getVertexPosition(vertex, point).applyMatrix4(character.mesh.matrixWorld);
      expect([point.x, point.y, point.z].every(Number.isFinite)).toBe(true);
      minimum = Math.min(minimum, point.y);
    }
    expect(minimum).toBeCloseTo(0, 5);
  });

  test("upper torso reaches both shoulder joint regions", () => {
    const character = buildCharacterModel();
    character.model.updateMatrixWorld(true);
    character.skeleton.update();
    const chestIndex = character.skeleton.bones.indexOf(character.bones.chest);
    const indices = character.mesh.geometry.getAttribute("skinIndex");
    const shoulderY = character.bones.leftUpperArm.getWorldPosition(new THREE.Vector3()).y;
    const point = new THREE.Vector3();
    let left = Infinity, right = -Infinity;
    for (let vertex = 0; vertex < indices.count; vertex += 1) {
      if (indices.getX(vertex) !== chestIndex) continue;
      character.mesh.getVertexPosition(vertex, point).applyMatrix4(character.mesh.matrixWorld);
      if (Math.abs(point.y - shoulderY) > 0.06) continue;
      left = Math.min(left, point.x);
      right = Math.max(right, point.x);
    }
    expect(left).toBeLessThan(-0.51);
    expect(right).toBeGreaterThan(0.51);
  });

  test("poses reuse topology and the joint palette instead of rebuilding meshes", () => {
    const character = buildCharacterModel();
    const geometry = character.mesh.geometry;
    const positions = geometry.getAttribute("position").array;
    const indices = geometry.index!.array;
    const palette = character.skeleton.boneMatrices;
    for (let frame = 0; frame < 120; frame += 1) {
      character.bones.rightUpperArm.rotation.z = Math.sin(frame / 20);
      character.model.updateMatrixWorld(true);
      character.skeleton.update();
      expect(character.mesh.geometry).toBe(geometry);
      expect(geometry.getAttribute("position").array).toBe(positions);
      expect(geometry.index!.array).toBe(indices);
      expect(character.skeleton.boneMatrices).toBe(palette);
    }
  });

  test("disposes renderer-package geometry and shared materials exactly once", () => {
    const character = buildCharacterModel();
    const scene = new THREE.Scene();
    scene.add(character.model, character.skeletonHelper);
    const counts = new Map<THREE.BufferGeometry | THREE.Material, number>();
    const helperMaterials = Array.isArray(character.skeletonHelper.material)
      ? character.skeletonHelper.material : [character.skeletonHelper.material];
    const resources = [character.mesh.geometry, character.skeletonHelper.geometry,
      ...character.materials, ...helperMaterials];
    for (const resource of resources) {
      counts.set(resource, 0);
      resource.addEventListener("dispose", () => counts.set(resource, counts.get(resource)! + 1));
    }
    disposeRenderableResources(scene);
    for (const resource of resources) expect(counts.get(resource)).toBe(1);
    character.skeleton.dispose();
  });
});
