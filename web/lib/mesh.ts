export type Vec3 = readonly [x: number, y: number, z: number];

export type IndexedMesh = {
  vertices: readonly Vec3[];
  indices: readonly number[];
};

export const triangleMesh: IndexedMesh = {
  vertices: [
    [-1, -0.75, 0],
    [1, -0.75, 0],
    [0, 1, 0],
  ],
  indices: [0, 1, 2],
};

export const cubeMesh: IndexedMesh = {
  vertices: [
    [-0.5, -0.5, -0.5],
    [0.5, -0.5, -0.5],
    [0.5, 0.5, -0.5],
    [-0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5],
    [0.5, -0.5, 0.5],
    [0.5, 0.5, 0.5],
    [-0.5, 0.5, 0.5],
  ],
  indices: [
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    3, 7, 6, 3, 6, 2,
    1, 2, 6, 1, 6, 5,
    0, 4, 7, 0, 7, 3,
  ],
};

export function triangleCount(mesh: IndexedMesh): number {
  if (mesh.indices.length % 3 !== 0) {
    throw new Error("index count must be divisible by three");
  }
  return mesh.indices.length / 3;
}

export function expandedVertexCount(mesh: IndexedMesh): number {
  return mesh.indices.length;
}
