export type AnatomyStep = {
  id: "scene" | "node" | "mesh" | "primitive" | "accessors" | "buffer" | "material";
  title: string;
  reference: string;
  explanation: string;
};

const MODEL_BUFFER_BASE64 =
  "ZmZmv2ZmJr8AAAAAZmZmP2ZmJr8AAAAAAAAAAGZmZj8AAAAAAAAAAAAAAAAAAIA/AAAAAAAAAAAAAIA/AAAAAAAAAAAAAIA/AAABAAIA";

export const MINIMAL_MODEL_GLTF_DOCUMENT = {
  asset: { version: "2.0", generator: "3d-lab model-pipeline lesson" },
  scene: 0,
  scenes: [{ name: "Lesson Scene", nodes: [0] }],
  nodes: [{ name: "Triangle Node", mesh: 0 }],
  meshes: [
    {
      name: "Triangle Mesh",
      primitives: [
        {
          attributes: { POSITION: 0, NORMAL: 1 },
          indices: 2,
          material: 0,
          mode: 4,
        },
      ],
    },
  ],
  materials: [
    {
      name: "Blue PBR",
      doubleSided: false,
      pbrMetallicRoughness: {
        baseColorFactor: [0.18, 0.55, 0.95, 1.0],
        metallicFactor: 0.1,
        roughnessFactor: 0.55,
      },
    },
  ],
  buffers: [
    {
      byteLength: 78,
      uri: `data:application/octet-stream;base64,${MODEL_BUFFER_BASE64}`,
    },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: 36, target: 34962 },
    { buffer: 0, byteOffset: 36, byteLength: 36, target: 34962 },
    { buffer: 0, byteOffset: 72, byteLength: 6, target: 34963 },
  ],
  accessors: [
    {
      bufferView: 0,
      componentType: 5126,
      count: 3,
      type: "VEC3",
      min: [-0.9, -0.65, 0],
      max: [0.9, 0.9, 0],
    },
    {
      bufferView: 1,
      componentType: 5126,
      count: 3,
      type: "VEC3",
    },
    {
      bufferView: 2,
      componentType: 5123,
      count: 3,
      type: "SCALAR",
    },
  ],
} as const;

export const MINIMAL_MODEL_GLTF = JSON.stringify(MINIMAL_MODEL_GLTF_DOCUMENT);

export const ANATOMY_STEPS: readonly AnatomyStep[] = [
  {
    id: "scene",
    title: "Scene",
    reference: "scenes[0].nodes → [0]",
    explanation: "The active scene chooses which root nodes enter the loaded world. It does not contain vertex bytes itself.",
  },
  {
    id: "node",
    title: "Node",
    reference: "nodes[0].mesh → 0",
    explanation: "A node places or organizes content and points at a mesh. Transforms belong here; geometry does not.",
  },
  {
    id: "mesh",
    title: "Mesh",
    reference: "meshes[0].primitives[0]",
    explanation: "A glTF mesh is a named collection of primitives. One mesh can therefore use several materials or draw modes.",
  },
  {
    id: "primitive",
    title: "Primitive",
    reference: "POSITION: 0 · NORMAL: 1 · indices: 2 · material: 0",
    explanation: "The primitive is the draw-shaped record: it connects semantic attributes, an index accessor, and a material.",
  },
  {
    id: "accessors",
    title: "Accessors",
    reference: "accessors → bufferViews",
    explanation: "Accessors say how typed values should be interpreted—component type, vector shape, and element count—without owning the bytes.",
  },
  {
    id: "buffer",
    title: "Buffer views + buffer",
    reference: "bufferViews → buffers[0] (78 bytes)",
    explanation: "Buffer views carve contiguous byte ranges out of a buffer. The buffer is storage; meaning comes from the accessor and primitive above it.",
  },
  {
    id: "material",
    title: "Material",
    reference: "materials[0].pbrMetallicRoughness",
    explanation: "The material supplies surface intent separately from geometry: base color plus metallic and roughness factors in this minimal PBR example.",
  },
];
