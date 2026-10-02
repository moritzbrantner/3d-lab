// Deterministic static GLB fixtures for the reusable renderer's static-asset adapter.
// They mirror the shapes asset-tooling's Blender rock/tree exports produce (Y-up, factor-only
// metallic-roughness materials, NORMAL/TANGENT/TEXCOORD_0, multiple mesh nodes) while staying
// small enough to commit and to reason about exactly in tests.
//
// bun scripts/static-glb-fixtures.mjs   # rewrites fixtures/static-glb/*.glb
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const FLOAT = 5126;
const UNSIGNED_BYTE = 5121;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

/** Encode a glTF JSON document plus one binary chunk as GLB 2.0 bytes. */
export function encodeGlb(json, binary = new Uint8Array(0)) {
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = align4(jsonBytes.length);
  const binLength = align4(binary.length);
  const hasBin = binary.length > 0;
  const total = 12 + 8 + jsonLength + (hasBin ? 8 + binLength : 0);
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  bytes.fill(0x20, 20, 20 + jsonLength);
  bytes.set(jsonBytes, 20);
  if (hasBin) {
    const offset = 20 + jsonLength;
    view.setUint32(offset, binLength, true);
    view.setUint32(offset + 4, 0x004e4942, true); // "BIN\0"
    bytes.set(binary, offset + 8);
  }
  return bytes;
}

function align4(value) {
  return Math.ceil(value / 4) * 4;
}

/** Accumulates buffer views/accessors into one GLB binary chunk. */
class GltfBuilder {
  constructor() {
    this.chunks = [];
    this.byteLength = 0;
    this.bufferViews = [];
    this.accessors = [];
  }

  bufferView(bytes, { target, byteStride } = {}) {
    const byteOffset = this.byteLength;
    this.chunks.push({ byteOffset, bytes });
    this.byteLength = align4(byteOffset + bytes.byteLength);
    this.bufferViews.push({
      buffer: 0,
      byteOffset,
      byteLength: bytes.byteLength,
      ...(byteStride === undefined ? {} : { byteStride }),
      ...(target === undefined ? {} : { target }),
    });
    return this.bufferViews.length - 1;
  }

  accessor(values, { type, componentType = FLOAT, normalized, target, bounds = false }) {
    const ArrayType = { [FLOAT]: Float32Array, [UNSIGNED_BYTE]: Uint8Array, [UNSIGNED_SHORT]: Uint16Array, [UNSIGNED_INT]: Uint32Array }[componentType];
    const flat = values.flat();
    const typed = ArrayType.from(flat);
    const bufferView = this.bufferView(new Uint8Array(typed.buffer), { target });
    return this.pushAccessor({ bufferView, componentType, normalized, count: values.length, type, values: bounds ? values : null });
  }

  pushAccessor({ bufferView, byteOffset, componentType, normalized, count, type, values }) {
    const accessor = { bufferView, componentType, count, type };
    if (byteOffset) accessor.byteOffset = byteOffset;
    if (normalized) accessor.normalized = true;
    if (values) {
      accessor.min = values[0].map((_, axis) => Math.min(...values.map((value) => value[axis])));
      accessor.max = values[0].map((_, axis) => Math.max(...values.map((value) => value[axis])));
    }
    this.accessors.push(accessor);
    return this.accessors.length - 1;
  }

  /** POSITION and NORMAL interleaved in one strided buffer view (as many exporters emit). */
  interleavedPositionNormal(positions, normals) {
    const floats = new Float32Array(positions.length * 6);
    positions.forEach((position, index) => {
      floats.set(position, index * 6);
      floats.set(normals[index], index * 6 + 3);
    });
    const bufferView = this.bufferView(new Uint8Array(floats.buffer), { target: ARRAY_BUFFER, byteStride: 24 });
    return {
      POSITION: this.pushAccessor({ bufferView, componentType: FLOAT, count: positions.length, type: "VEC3", values: positions }),
      NORMAL: this.pushAccessor({ bufferView, byteOffset: 12, componentType: FLOAT, count: positions.length, type: "VEC3" }),
    };
  }

  binary() {
    const bytes = new Uint8Array(this.byteLength);
    for (const chunk of this.chunks) bytes.set(chunk.bytes, chunk.byteOffset);
    return bytes;
  }

  document(rest) {
    return {
      asset: { version: "2.0", generator: "3d-lab static-glb fixtures" },
      ...rest,
      buffers: [{ byteLength: this.byteLength }],
      bufferViews: this.bufferViews,
      accessors: this.accessors,
    };
  }
}

/** Octahedron with outward face normals, tangents, and UVs; 24 vertices, 8 triangles. */
export function octahedron(radius) {
  const axes = [
    [radius, 0, 0], [-radius, 0, 0], [0, radius, 0], [0, -radius, 0], [0, 0, radius], [0, 0, -radius],
  ];
  const faces = [
    [4, 0, 2], [0, 5, 2], [5, 1, 2], [1, 4, 2], [0, 4, 3], [5, 0, 3], [1, 5, 3], [4, 1, 3],
  ];
  const positions = [];
  const normals = [];
  const tangents = [];
  const uvs = [];
  const indices = [];
  faces.forEach((face, faceIndex) => {
    const [a, b, c] = face.map((vertex) => axes[vertex]);
    const normal = normalize(cross(subtract(b, a), subtract(c, a)));
    const tangent = normalize(subtract(b, a));
    face.forEach((vertex, corner) => {
      indices.push(positions.length);
      positions.push(axes[vertex]);
      normals.push(normal);
      tangents.push([...tangent, 1]);
      uvs.push([(faceIndex % 4) / 4 + corner / 8, faceIndex < 4 ? 0.25 : 0.75]);
    });
  });
  return { positions, normals, tangents, uvs, indices };
}

/** Axis-aligned box centred on the origin; 24 vertices, 12 triangles. */
export function box([width, height, depth]) {
  const [x, y, z] = [width / 2, height / 2, depth / 2];
  const sides = [
    { normal: [1, 0, 0], corners: [[x, -y, z], [x, -y, -z], [x, y, -z], [x, y, z]] },
    { normal: [-1, 0, 0], corners: [[-x, -y, -z], [-x, -y, z], [-x, y, z], [-x, y, -z]] },
    { normal: [0, 1, 0], corners: [[-x, y, z], [x, y, z], [x, y, -z], [-x, y, -z]] },
    { normal: [0, -1, 0], corners: [[-x, -y, -z], [x, -y, -z], [x, -y, z], [-x, -y, z]] },
    { normal: [0, 0, 1], corners: [[-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]] },
    { normal: [0, 0, -1], corners: [[x, -y, -z], [-x, -y, -z], [-x, y, -z], [x, y, -z]] },
  ];
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  for (const side of sides) {
    const base = positions.length;
    side.corners.forEach((corner, index) => {
      positions.push(corner);
      normals.push(side.normal);
      uvs.push([index === 1 || index === 2 ? 1 : 0, index >= 2 ? 1 : 0]);
    });
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, uvs, indices };
}

function subtract(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v) {
  const length = Math.hypot(...v);
  return v.map((value) => value / length);
}

/** One mesh node with a rotated/translated placement and one rock material (rock-v1 shape). */
export function rockDocument() {
  const builder = new GltfBuilder();
  const mesh = octahedron(0.5);
  const attributes = {
    POSITION: builder.accessor(mesh.positions, { type: "VEC3", target: ARRAY_BUFFER, bounds: true }),
    NORMAL: builder.accessor(mesh.normals, { type: "VEC3", target: ARRAY_BUFFER }),
    TANGENT: builder.accessor(mesh.tangents, { type: "VEC4", target: ARRAY_BUFFER }),
    TEXCOORD_0: builder.accessor(mesh.uvs, { type: "VEC2", target: ARRAY_BUFFER }),
  };
  const indices = builder.accessor(mesh.indices.map((index) => [index]), {
    type: "SCALAR",
    componentType: UNSIGNED_SHORT,
    target: ELEMENT_ARRAY_BUFFER,
  });
  const json = builder.document({
    scene: 0,
    scenes: [{ name: "Scene", nodes: [0] }],
    nodes: [{ name: "rock", mesh: 0, translation: [0, 0.5, 0], rotation: [0, 0.38268343, 0, 0.92387953] }],
    meshes: [{ name: "rock", primitives: [{ attributes, indices, material: 0 }] }],
    materials: [
      {
        name: "rock-surface",
        doubleSided: true,
        pbrMetallicRoughness: { baseColorFactor: [0.25, 0.27, 0.29, 1], metallicFactor: 0, roughnessFactor: 0.85 },
      },
    ],
  });
  return { json, binary: builder.binary() };
}

/**
 * A parented tree: a scaled root with a trunk child and a rotated canopy grandchild. The trunk
 * mesh is reused by a second "root flare" node; the canopy mesh has two primitives (a vertex-colored
 * foliage primitive with normalized UNSIGNED_BYTE colors and a non-indexed bark knot).
 */
export function treeDocument() {
  const builder = new GltfBuilder();
  const trunk = box([0.2, 1, 0.2]);
  const trunkAttributes = builder.interleavedPositionNormal(trunk.positions, trunk.normals);
  trunkAttributes.TEXCOORD_0 = builder.accessor(trunk.uvs, { type: "VEC2", target: ARRAY_BUFFER });
  const trunkIndices = builder.accessor(trunk.indices.map((index) => [index]), {
    type: "SCALAR",
    componentType: UNSIGNED_INT,
    target: ELEMENT_ARRAY_BUFFER,
  });

  const canopy = octahedron(0.6);
  const foliageColors = canopy.positions.map(([, y]) => (y > 0 ? [128, 200, 64, 255] : [64, 128, 32, 255]));
  const foliageAttributes = {
    POSITION: builder.accessor(canopy.positions, { type: "VEC3", target: ARRAY_BUFFER, bounds: true }),
    NORMAL: builder.accessor(canopy.normals, { type: "VEC3", target: ARRAY_BUFFER }),
    COLOR_0: builder.accessor(foliageColors, { type: "VEC4", componentType: UNSIGNED_BYTE, normalized: true, target: ARRAY_BUFFER }),
  };
  const foliageIndices = builder.accessor(canopy.indices.map((index) => [index]), {
    type: "SCALAR",
    componentType: UNSIGNED_SHORT,
    target: ELEMENT_ARRAY_BUFFER,
  });

  const knot = box([0.12, 0.12, 0.12]);
  const knotPositions = knot.indices.map((index) => knot.positions[index].map((value, axis) => value + (axis === 0 ? 0.35 : 0)));
  const knotNormals = knot.indices.map((index) => knot.normals[index]);
  const knotAttributes = {
    POSITION: builder.accessor(knotPositions, { type: "VEC3", target: ARRAY_BUFFER, bounds: true }),
    NORMAL: builder.accessor(knotNormals, { type: "VEC3", target: ARRAY_BUFFER }),
  };

  const json = builder.document({
    scene: 0,
    scenes: [{ name: "Scene", nodes: [0] }],
    nodes: [
      { name: "tree", children: [1, 3], scale: [2, 2, 2] },
      { name: "trunk", mesh: 0, translation: [0, 0.5, 0], children: [2] },
      { name: "canopy", mesh: 1, translation: [0, 0.75, 0], rotation: [0, 0.38268343, 0, 0.92387953] },
      {
        name: "root-flare",
        mesh: 0,
        // Column-major matrix: scale (2, 0.1, 2) then translate y = 0.05.
        matrix: [2, 0, 0, 0, 0, 0.1, 0, 0, 0, 0, 2, 0, 0, 0.05, 0, 1],
      },
    ],
    meshes: [
      { name: "trunk", primitives: [{ attributes: trunkAttributes, indices: trunkIndices, material: 0 }] },
      {
        name: "canopy",
        primitives: [
          { attributes: foliageAttributes, indices: foliageIndices, material: 1 },
          { attributes: knotAttributes, material: 0 },
        ],
      },
    ],
    materials: [
      {
        name: "tree-bark",
        doubleSided: true,
        pbrMetallicRoughness: { baseColorFactor: [0.2, 0.09, 0.03, 1], metallicFactor: 0, roughnessFactor: 0.9 },
      },
      {
        name: "tree-foliage",
        doubleSided: true,
        pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 },
      },
    ],
  });
  return { json, binary: builder.binary() };
}

export const STATIC_GLB_FIXTURES = {
  "rock.glb": rockDocument,
  "tree.glb": treeDocument,
};

if (import.meta.main) {
  const directory = path.resolve(import.meta.dir, "../fixtures/static-glb");
  await mkdir(directory, { recursive: true });
  for (const [name, build] of Object.entries(STATIC_GLB_FIXTURES)) {
    const { json, binary } = build();
    await writeFile(path.join(directory, name), encodeGlb(json, binary));
  }
  console.log(`wrote ${Object.keys(STATIC_GLB_FIXTURES).join(", ")} to ${directory}`);
}
