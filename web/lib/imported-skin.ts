import * as THREE from "three";
import { GLTFLoader, type GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { batchWeightedSkin } from "@moritzbrantner/three-d-renderer/weighted-skin";

export const SIMPLE_SKIN_FIXTURE_URL = "../fixtures/khronos-simpleskin-embedded.gltf";
export const SIMPLE_SKIN_SOURCE = {
  provider: "Khronos glTF Sample Assets",
  revision: "90d7ede14c7e280af263824604b427a1ca02cb66",
  path: "Models/SimpleSkin/glTF-Embedded/SimpleSkin.gltf",
  sha256: "7d0c3f48d0510d101269cb4fdd3ee035eaada0e04809a0899e0b4cfe8c38e68f",
  license: "CC0-1.0",
} as const;

export type ImportedSkinnedModel = {
  root: THREE.Group;
  mesh: THREE.SkinnedMesh<THREE.BufferGeometry, THREE.Material[]>;
  skeleton: THREE.Skeleton;
  skeletonHelper: THREE.SkeletonHelper;
  clips: THREE.AnimationClip[];
  sourceDraws: number;
  materialDraws: number;
  vertexCount: number;
  skinIndexBytesPerVertex: 4 | 8;
  dispose: () => void;
};

function copySkinAttribute(
  attribute: THREE.BufferAttribute | THREE.InterleavedBufferAttribute,
  vertexCount: number,
  integer: boolean,
) {
  const output = integer ? new Uint16Array(vertexCount * 4) : new Float32Array(vertexCount * 4);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const offset = vertex * 4;
    output[offset] = attribute.getX(vertex);
    output[offset + 1] = attribute.getY(vertex);
    output[offset + 2] = attribute.getZ(vertex);
    output[offset + 3] = attribute.getW(vertex);
  }
  return output;
}

function disposeHelper(helper: THREE.SkeletonHelper) {
  helper.geometry.dispose();
  const materials = Array.isArray(helper.material) ? helper.material : [helper.material];
  materials.forEach((material) => material.dispose());
}

/**
 * Normalize one imported glTF SkinnedMesh into the renderer's explicit weighted-skin
 * boundary. Parsing, asset provenance and animation clips remain outside the renderer.
 */
export function adaptSingleSkinnedGltf(gltf: GLTF): ImportedSkinnedModel {
  gltf.scene.updateMatrixWorld(true);
  const sources: THREE.SkinnedMesh[] = [];
  gltf.scene.traverse((object) => {
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) sources.push(object as THREE.SkinnedMesh);
  });
  if (sources.length !== 1) {
    throw new Error(`imported skin adapter requires exactly one SkinnedMesh, found ${sources.length}`);
  }

  const source = sources[0]!;
  const parent = source.parent;
  if (!parent) throw new Error("imported SkinnedMesh must have a parent node");
  if (!source.geometry.index) throw new Error("imported SkinnedMesh must use indexed geometry");
  if (Array.isArray(source.material)) throw new Error("multi-material imported primitives must be split before skin batching");

  const positions = source.geometry.getAttribute("position");
  const skinIndex = source.geometry.getAttribute("skinIndex");
  const skinWeight = source.geometry.getAttribute("skinWeight");
  if (!positions || !skinIndex || !skinWeight || skinIndex.itemSize !== 4 || skinWeight.itemSize !== 4) {
    throw new Error("imported SkinnedMesh requires POSITION, JOINTS_0 and WEIGHTS_0-compatible attributes");
  }
  if (skinIndex.count !== positions.count || skinWeight.count !== positions.count) {
    throw new Error("imported skin attributes must align with positions");
  }

  const geometry = source.geometry.clone();
  geometry.deleteAttribute("skinIndex");
  geometry.deleteAttribute("skinWeight");
  const partMatrix = parent.matrixWorld.clone().invert().multiply(source.matrixWorld);
  const joints = copySkinAttribute(skinIndex, positions.count, true) as Uint16Array;
  const weights = copySkinAttribute(skinWeight, positions.count, false) as Float32Array;

  let batch;
  try {
    batch = batchWeightedSkin(source.skeleton, [{
      geometry,
      material: source.material,
      matrix: partMatrix,
      skinIndices: joints,
      skinWeights: weights,
    }], parent.matrixWorld);
  } finally {
    geometry.dispose();
  }

  batch.mesh.name = source.name ? `${source.name}-renderer-batch` : "ImportedSkin-renderer-batch";
  batch.mesh.castShadow = source.castShadow;
  batch.mesh.receiveShadow = source.receiveShadow;
  batch.mesh.renderOrder = source.renderOrder;
  source.removeFromParent();
  source.geometry.dispose();
  parent.add(batch.mesh);

  const skeletonHelper = new THREE.SkeletonHelper(source.skeleton.bones[0]!);
  parent.add(skeletonHelper);
  const materials = [...new Set(batch.mesh.material)];

  return {
    root: gltf.scene,
    mesh: batch.mesh,
    skeleton: source.skeleton,
    skeletonHelper,
    clips: gltf.animations,
    sourceDraws: batch.sourceDraws,
    materialDraws: batch.materialDraws,
    vertexCount: batch.vertexCount,
    skinIndexBytesPerVertex: batch.skinIndexBytesPerVertex,
    dispose: () => {
      batch.mesh.geometry.dispose();
      materials.forEach((material) => material.dispose());
      disposeHelper(skeletonHelper);
      source.skeleton.dispose();
    },
  };
}

export async function loadImportedSkinnedGltf(url: string): Promise<ImportedSkinnedModel> {
  const gltf = await new GLTFLoader().loadAsync(url);
  return adaptSingleSkinnedGltf(gltf);
}
