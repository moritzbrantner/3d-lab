import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { buildCharacterModel } from "./character-model";

describe("batched teaching character", () => {
  test("ratchets 31 rigid parts into one mesh and three color-pass groups", () => {
    const character = buildCharacterModel();
    let meshCount = 0;
    character.model.traverse((object) => { if (object instanceof THREE.Mesh) meshCount += 1; });
    expect(meshCount).toBe(1);
    expect(character.sourceDraws).toBe(31);
    expect(character.materialDraws).toBe(3);
    expect(character.mesh.geometry.groups).toHaveLength(3);
    expect(character.skeleton.bones).toHaveLength(13);
    const weights = character.mesh.geometry.getAttribute("skinWeight");
    for (let vertex = 0; vertex < weights.count; vertex += 1) {
      expect(weights.getX(vertex)).toBe(1);
      expect(weights.getY(vertex) + weights.getZ(vertex) + weights.getW(vertex)).toBe(0);
    }
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
});
