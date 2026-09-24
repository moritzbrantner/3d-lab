import {
  Float32BufferAttribute,
  SkinnedMesh,
  Uint8BufferAttribute,
  Uint16BufferAttribute,
} from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

function requireFiniteInvertibleMatrix(matrix, label) {
  if (!matrix?.elements?.every(Number.isFinite) || matrix.determinant() === 0) {
    throw new Error(`${label} must be finite and invertible`);
  }
}

function validateInfluences(label, influences, vertexCount, jointCount) {
  const expected = vertexCount * 4;
  if (!influences?.joints || !influences?.weights ||
      influences.joints.length !== expected || influences.weights.length !== expected) {
    throw new Error(`${label} requires exactly four joint indices and weights per vertex`);
  }
  let multiJointVertices = 0;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    let sum = 0;
    let positive = 0;
    const seen = new Set();
    for (let lane = 0; lane < 4; lane += 1) {
      const offset = vertex * 4 + lane;
      const joint = influences.joints[offset];
      const weight = influences.weights[offset];
      if (!Number.isInteger(joint) || joint < 0 || joint >= jointCount) {
        throw new Error(`${label} references invalid joint ${String(joint)}`);
      }
      if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
        throw new Error(`${label} weights must be finite values between 0 and 1`);
      }
      if (weight > 0) {
        if (seen.has(joint)) throw new Error(`${label} repeats a positive joint influence`);
        seen.add(joint);
        positive += 1;
      }
      sum += weight;
    }
    if (Math.abs(sum - 1) > 1e-5) {
      throw new Error(`${label} weights must sum to 1 for every vertex`);
    }
    if (positive > 1) multiJointVertices += 1;
  }
  return multiJointVertices;
}

/**
 * Internal shared GPU-skin batcher. Callers author influences; this module only
 * validates, packs and batches them. It deliberately owns no rig-generation or
 * animation policy.
 */
export function batchSkinParts(skeleton, parts, bindMatrix, label, createInfluences) {
  if (parts.length === 0) throw new Error(`${label} requires at least one part`);
  if (skeleton.bones.length === 0 || skeleton.bones.length > 65536) {
    throw new Error(`${label} requires 1..65536 joints`);
  }
  requireFiniteInvertibleMatrix(bindMatrix, "bind matrix");

  const prepared = [];
  let multiJointVertices = 0;
  for (const part of parts) {
    const geometry = part.geometry;
    if (!geometry?.index || !geometry.getAttribute("position")) {
      throw new Error(`${label} requires indexed geometry with positions`);
    }
    if (geometry.drawRange.start !== 0 ||
        (geometry.drawRange.count !== Infinity && geometry.drawRange.count !== geometry.index.count)) {
      throw new Error(`${label} does not accept partial draw ranges`);
    }
    if (geometry.getAttribute("skinIndex") || geometry.getAttribute("skinWeight") ||
        Object.keys(geometry.morphAttributes).length !== 0) {
      throw new Error(`${label} does not accept existing skin or morph data`);
    }
    if (!part.matrix?.elements?.every(Number.isFinite) || part.matrix.determinant() <= 0) {
      throw new Error("part matrix must be finite, invertible and non-reflecting");
    }
    if (!part.material || Array.isArray(part.material)) {
      throw new Error(`each ${label} part must supply one material`);
    }
    const vertexCount = geometry.getAttribute("position").count;
    const influences = createInfluences(part, vertexCount);
    multiJointVertices += validateInfluences(label, influences, vertexCount, skeleton.bones.length);
    prepared.push({ part, influences });
  }

  // Material identity is the draw boundary. Keep one contiguous group per
  // material instead of retaining one group per authored source part.
  const batches = new Map();
  for (const record of prepared) {
    const batch = batches.get(record.part.material) ?? [];
    batch.push(record);
    batches.set(record.part.material, batch);
  }

  const compactJointIndices = skeleton.bones.length <= 256;
  const JointArray = compactJointIndices ? Uint8Array : Uint16Array;
  const JointAttribute = compactJointIndices ? Uint8BufferAttribute : Uint16BufferAttribute;
  const copies = [];
  const groups = [];
  let merged = null;
  let offset = 0;
  try {
    for (const batch of batches.values()) {
      const start = offset;
      for (const { part, influences } of batch) {
        const copy = part.geometry.clone();
        copies.push(copy);
        copy.applyMatrix4(part.matrix);
        copy.setAttribute("skinIndex", new JointAttribute(new JointArray(influences.joints), 4));
        copy.setAttribute("skinWeight", new Float32BufferAttribute(new Float32Array(influences.weights), 4));
        offset += copy.index.count;
      }
      groups.push({ start, count: offset - start });
    }
    merged = mergeGeometries(copies, false);
    if (!merged) throw new Error(`${label} part vertex attributes must be compatible`);
    merged.clearGroups();
    groups.forEach((group, index) => merged.addGroup(group.start, group.count, index));
    const mesh = new SkinnedMesh(merged, [...batches.keys()]);
    mesh.bind(skeleton, bindMatrix);
    // Bind-pose bounds are not animated bounds. Consumers may enable culling
    // only when they provide conservative bounds for all reachable poses.
    mesh.frustumCulled = false;
    return {
      mesh,
      sourceDraws: parts.length,
      materialDraws: batches.size,
      vertexCount: merged.getAttribute("position").count,
      multiJointVertices,
      skinIndexBytesPerVertex: compactJointIndices ? 4 : 8,
    };
  } catch (error) {
    merged?.dispose();
    throw error;
  } finally {
    copies.forEach((geometry) => geometry.dispose());
  }
}
