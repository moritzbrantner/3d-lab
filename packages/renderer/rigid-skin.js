import { Float32BufferAttribute, SkinnedMesh, Uint16BufferAttribute } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/**
 * Bake already-authored rigid attachments into one indexed GPU-skinned mesh.
 * This is a renderer adapter, not a rig generator or animation authority.
 * Parts use mesh-local -> model-bind-local matrices and one joint per vertex.
 * Input geometry, materials, skeleton and bone ordering remain caller-owned.
 */
export function batchRigidSkin(skeleton, parts, bindMatrix) {
  if (parts.length === 0) throw new Error("rigid skin requires at least one part");
  if (skeleton.bones.length === 0 || skeleton.bones.length > 65536) {
    throw new Error("rigid skin requires 1..65536 joints");
  }
  if (!bindMatrix.elements.every(Number.isFinite) || bindMatrix.determinant() === 0) {
    throw new Error("bind matrix must be finite and invertible");
  }

  // Group by material identity, not material name. One contiguous group per
  // material is essential: one group per source part would retain all draws.
  const batches = new Map();
  for (const part of parts) {
    if (!Number.isInteger(part.joint) || part.joint < 0 || part.joint >= skeleton.bones.length) {
      throw new Error(`rigid part references invalid joint ${part.joint}`);
    }
    const geometry = part.geometry;
    if (!geometry.index || !geometry.getAttribute("position")) {
      throw new Error("rigid skin requires indexed geometry with positions");
    }
    if (geometry.drawRange.start !== 0 ||
        (geometry.drawRange.count !== Infinity && geometry.drawRange.count !== geometry.index.count)) {
      throw new Error("rigid skin does not accept partial draw ranges");
    }
    if (geometry.getAttribute("skinIndex") || geometry.getAttribute("skinWeight") ||
        Object.keys(geometry.morphAttributes).length !== 0) {
      throw new Error("rigid skin does not accept existing skin or morph data");
    }
    if (!part.matrix.elements.every(Number.isFinite) || part.matrix.determinant() <= 0) {
      throw new Error("part matrix must be finite, invertible and non-reflecting");
    }
    if (!part.material || Array.isArray(part.material)) {
      throw new Error("each rigid part must supply one material");
    }
    const batch = batches.get(part.material) ?? [];
    batch.push(part);
    batches.set(part.material, batch);
  }

  const copies = [];
  const groups = [];
  let merged = null;
  let offset = 0;
  try {
    for (const batch of batches.values()) {
      const start = offset;
      for (const part of batch) {
        const copy = part.geometry.clone();
        copies.push(copy);
        copy.applyMatrix4(part.matrix);
        const count = copy.getAttribute("position").count;
        const joints = new Uint16Array(count * 4);
        const weights = new Float32Array(count * 4);
        for (let vertex = 0; vertex < count; vertex += 1) {
          joints[vertex * 4] = part.joint;
          weights[vertex * 4] = 1;
        }
        copy.setAttribute("skinIndex", new Uint16BufferAttribute(joints, 4));
        copy.setAttribute("skinWeight", new Float32BufferAttribute(weights, 4));
        offset += copy.index.count;
      }
      groups.push({ start, count: offset - start });
    }
    merged = mergeGeometries(copies, false);
    if (!merged) throw new Error("rigid part vertex attributes must be compatible");
    merged.clearGroups();
    groups.forEach((group, index) => merged.addGroup(group.start, group.count, index));
    const mesh = new SkinnedMesh(merged, [...batches.keys()]);
    mesh.bind(skeleton, bindMatrix);
    // A bind-pose sphere is NOT an animated bound. The small teaching model
    // avoids CPU vertex skinning for culling. Consumers may enable culling
    // only when they supply/update conservative animated bounds.
    mesh.frustumCulled = false;
    return {
      mesh,
      sourceDraws: parts.length,
      materialDraws: batches.size,
      vertexCount: merged.getAttribute("position").count,
    };
  } catch (error) {
    merged?.dispose();
    throw error;
  } finally {
    copies.forEach((geometry) => geometry.dispose());
  }
}
