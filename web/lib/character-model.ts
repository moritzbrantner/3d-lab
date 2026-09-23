import * as THREE from "three";
import { batchRigidSkin } from "@moritzbrantner/three-d-renderer/rigid-skin";

function segment(material: THREE.Material, length: number, radius: number, direction: 1 | -1 = -1) {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, Math.max(length - radius * 2, 0.05), 5, 10), material);
  mesh.position.y = direction * length * 0.5;
  return mesh;
}

function joint(material: THREE.Material, radius = 0.1) {
  return new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), material);
}

/** Teaching-model composition only. The renderer adapter owns GPU batching. */
export function buildCharacterModel() {
  const model = new THREE.Group();
  model.position.y = 1.9;
  const skinMaterial = new THREE.MeshStandardMaterial({ color: 0xb6c6db, roughness: 0.62, metalness: 0.05 });
  const accentMaterial = new THREE.MeshStandardMaterial({ color: 0x6f8fb7, roughness: 0.5, metalness: 0.08 });
  const jointMaterial = new THREE.MeshStandardMaterial({ color: 0xf0b969, roughness: 0.38, metalness: 0.12 });
  const materials = [skinMaterial, accentMaterial, jointMaterial];

  function bone(name: string, parent?: THREE.Bone, x = 0, y = 0) {
    const result = new THREE.Bone();
    result.name = name;
    result.position.set(x, y, 0);
    parent?.add(result);
    return result;
  }
  const hips = bone("Hips");
  const spine = bone("Spine", hips, 0, 0.72);
  const chest = bone("Chest", spine, 0, 0.72);
  const neck = bone("Neck", chest, 0, 0.48);
  const head = bone("Head", neck, 0, 0.3);
  const leftUpperArm = bone("LeftUpperArm", chest, -0.62, 0.3);
  const leftLowerArm = bone("LeftLowerArm", leftUpperArm, 0, -0.7);
  const rightUpperArm = bone("RightUpperArm", chest, 0.62, 0.3);
  const rightLowerArm = bone("RightLowerArm", rightUpperArm, 0, -0.7);
  const leftUpperLeg = bone("LeftUpperLeg", hips, -0.28, -0.1);
  const leftLowerLeg = bone("LeftLowerLeg", leftUpperLeg, 0, -0.9);
  const rightUpperLeg = bone("RightUpperLeg", hips, 0.28, -0.1);
  const rightLowerLeg = bone("RightLowerLeg", rightUpperLeg, 0, -0.9);

  // Anchor each torso section at its proximal joint. The previous showcase
  // started the lower torso at Spine, leaving Hips -> Spine uncovered.
  hips.add(segment(skinMaterial, 0.72, 0.25, 1), joint(jointMaterial, 0.13));
  spine.add(segment(skinMaterial, 0.72, 0.31, 1), joint(jointMaterial));
  // A broad upper torso reaches the shoulder joints; a narrow vertical
  // neck capsule left both arms visually floating away from the body.
  const upperTorso = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), skinMaterial);
  upperTorso.scale.set(0.58, 0.27, 0.23);
  upperTorso.position.y = 0.2;
  chest.add(upperTorso, joint(jointMaterial));
  neck.add(segment(skinMaterial, 0.3, 0.1, 1), joint(jointMaterial, 0.08));
  const skull = new THREE.Mesh(new THREE.SphereGeometry(0.29, 24, 18), skinMaterial);
  skull.position.y = 0.24;
  head.add(skull);
  // Small facial features make model facing unambiguous during inspection.
  for (const x of [-0.1, 0.1]) {
    const eye = joint(accentMaterial, 0.04);
    eye.position.set(x, 0.3, 0.26);
    head.add(eye);
  }

  for (const [upper, lower] of [[leftUpperArm, leftLowerArm], [rightUpperArm, rightLowerArm]]) {
    upper.add(segment(skinMaterial, 0.7, 0.13), joint(jointMaterial, 0.09));
    lower.add(segment(skinMaterial, 0.62, 0.11), joint(jointMaterial, 0.08));
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), skinMaterial);
    hand.scale.set(0.8, 1.25, 0.65);
    hand.position.y = -0.67;
    lower.add(hand);
  }
  for (const [upper, lower] of [[leftUpperLeg, leftLowerLeg], [rightUpperLeg, rightLowerLeg]]) {
    upper.add(segment(accentMaterial, 0.9, 0.16), joint(jointMaterial, 0.1));
    lower.add(segment(accentMaterial, 0.84, 0.14), joint(jointMaterial, 0.09));
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.5), accentMaterial);
    foot.position.set(0, -0.82, 0.13);
    lower.add(foot);
  }

  model.add(hips);
  model.updateMatrixWorld(true);
  const bones = { hips, spine, chest, leftUpperArm, leftLowerArm, rightUpperArm, rightLowerArm,
    leftUpperLeg, leftLowerLeg, rightUpperLeg, rightLowerLeg };
  const jointList: THREE.Bone[] = [];
  const sources: THREE.Mesh<THREE.BufferGeometry, THREE.Material>[] = [];
  model.traverse((object) => {
    if (object instanceof THREE.Bone) jointList.push(object);
    if (object instanceof THREE.Mesh) sources.push(object);
  });
  const indices = new Map(jointList.map((entry, index) => [entry, index]));
  const skeleton = new THREE.Skeleton(jointList);
  const inverseModel = model.matrixWorld.clone().invert();
  const originalGeometries = new Set(sources.map((source) => source.geometry));
  let batch;
  try {
    batch = batchRigidSkin(skeleton, sources.map((source) => {
      const index = indices.get(source.parent as THREE.Bone);
      if (index === undefined) throw new Error("teaching attachment must have a joint parent");
      return {
        geometry: source.geometry,
        material: source.material,
        joint: index,
        matrix: inverseModel.clone().multiply(source.matrixWorld),
      };
    }), model.matrixWorld);
  } catch (error) {
    materials.forEach((material) => material.dispose());
    skeleton.dispose();
    throw error;
  } finally {
    originalGeometries.forEach((geometry) => geometry.dispose());
  }
  sources.forEach((source) => source.removeFromParent());
  model.add(batch.mesh);
  const skeletonHelper = new THREE.SkeletonHelper(hips);
  // SkeletonHelper already uses the root's world matrix. Add it beside model
  // in the scene, NOT below model, otherwise model transforms apply twice.
  return { model, skeletonHelper, skeleton, mesh: batch.mesh, materials, bones,
    sourceDraws: batch.sourceDraws, materialDraws: batch.materialDraws };
}
