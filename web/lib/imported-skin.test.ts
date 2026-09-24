import { describe, expect, test } from "bun:test";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { adaptSingleSkinnedGltf, SIMPLE_SKIN_SOURCE } from "./imported-skin";

const fixturePath = new URL("../../fixtures/catalog/khronos-simpleskin-embedded.gltf", import.meta.url);

async function parseFixture() {
  const source = await Bun.file(fixturePath).text();
  return new GLTFLoader().parseAsync(source, "");
}

function firstSkinned(root: THREE.Object3D): THREE.SkinnedMesh {
  let result: THREE.SkinnedMesh | null = null;
  root.traverse((object) => {
    if (!result && (object as THREE.SkinnedMesh).isSkinnedMesh) result = object as THREE.SkinnedMesh;
  });
  if (!result) throw new Error("fixture has no SkinnedMesh");
  return result;
}

function poseAt(root: THREE.Group, clip: THREE.AnimationClip, time: number) {
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  mixer.setTime(time);
  root.updateMatrixWorld(true);
  firstSkinned(root).skeleton.update();
  return mixer;
}

describe("canonical imported skinned glTF", () => {
  test("loads the pinned Khronos SimpleSkin with its skin and animation intact", async () => {
    const gltf = await parseFixture();
    const imported = adaptSingleSkinnedGltf(gltf);
    expect(imported.clips).toHaveLength(1);
    expect(imported.clips[0]!.duration).toBeCloseTo(5.5, 6);
    expect(imported.skeleton.bones).toHaveLength(2);
    expect(imported.vertexCount).toBe(10);
    expect(imported.sourceDraws).toBe(1);
    expect(imported.materialDraws).toBe(1);
    expect(imported.skinIndexBytesPerVertex).toBe(4);
    expect(imported.mesh.geometry.getAttribute("skinIndex").array).toBeInstanceOf(Uint8Array);
    expect(SIMPLE_SKIN_SOURCE.sha256).toBe("7d0c3f48d0510d101269cb4fdd3ee035eaada0e04809a0899e0b4cfe8c38e68f");
    imported.dispose();
  });

  test("renderer-normalized skin matches the GLTFLoader reference through sampled animation", async () => {
    const referenceGltf = await parseFixture();
    const candidateGltf = await parseFixture();
    const referenceMesh = firstSkinned(referenceGltf.scene);
    const imported = adaptSingleSkinnedGltf(candidateGltf);
    const referenceClip = referenceGltf.animations[0]!;
    const candidateClip = imported.clips[0]!;
    const expected = new THREE.Vector3();
    const actual = new THREE.Vector3();

    for (const time of [0, 0.25, 1, 2.75, 4.5, 5.5]) {
      const referenceMixer = poseAt(referenceGltf.scene, referenceClip, time);
      const candidateMixer = poseAt(imported.root, candidateClip, time);
      referenceMesh.updateMatrixWorld(true);
      imported.mesh.updateMatrixWorld(true);
      for (let vertex = 0; vertex < imported.vertexCount; vertex += 1) {
        referenceMesh.getVertexPosition(vertex, expected).applyMatrix4(referenceMesh.matrixWorld);
        imported.mesh.getVertexPosition(vertex, actual).applyMatrix4(imported.mesh.matrixWorld);
        expect(actual.distanceTo(expected)).toBeLessThan(2e-5);
      }
      referenceMixer.stopAllAction();
      candidateMixer.stopAllAction();
    }

    imported.dispose();
    referenceMesh.geometry.dispose();
    const materials = Array.isArray(referenceMesh.material) ? referenceMesh.material : [referenceMesh.material];
    materials.forEach((material) => material.dispose());
    referenceMesh.skeleton.dispose();
  });
});
