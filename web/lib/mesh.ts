export type Vec2 = readonly [u: number, v: number];
export type Vec3 = readonly [x: number, y: number, z: number];
export type Vec4 = readonly [x: number, y: number, z: number, w: number];
export type Color3 = readonly [r: number, g: number, b: number];

export type VertexAttributes = {
  normals?: readonly Vec3[];
  tangents?: readonly Vec4[];
  uvs?: readonly Vec2[];
  colors?: readonly Color3[];
};

export type IndexedMesh = {
  vertices: readonly Vec3[];
  indices: readonly number[];
  attributes?: VertexAttributes;
};

export const MAX_SUBDIVISIONS = 256;
const TANGENT_EPSILON = 1e-8;

export const triangleMesh: IndexedMesh = {
  vertices: [
    [-1, -0.75, 0],
    [1, -0.75, 0],
    [0, 1, 0],
  ],
  indices: [0, 1, 2],
};

export const coloredTriangleMesh: IndexedMesh = {
  ...triangleMesh,
  attributes: {
    colors: [
      [1, 0.15, 0.15],
      [0.15, 1, 0.2],
      [0.2, 0.35, 1],
    ],
  },
};

export const uvQuadMesh: IndexedMesh = {
  vertices: [
    [-1, -1, 0],
    [1, -1, 0],
    [1, 1, 0],
    [-1, 1, 0],
  ],
  indices: [0, 1, 2, 0, 2, 3],
  attributes: {
    normals: [
      [0, 0, 1],
      [0, 0, 1],
      [0, 0, 1],
      [0, 0, 1],
    ],
    uvs: [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ],
  },
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

function finiteTuple(values: readonly number[]): boolean {
  return values.every(Number.isFinite);
}

export function validateMesh(mesh: IndexedMesh): void {
  mesh.vertices.forEach((vertex, index) => {
    if (!finiteTuple(vertex)) throw new Error(`vertex ${index} contains a non-finite coordinate`);
  });

  if (mesh.indices.length % 3 !== 0) {
    throw new Error("index count must be divisible by three");
  }

  mesh.indices.forEach((index) => {
    if (!Number.isInteger(index) || index < 0 || index >= mesh.vertices.length) {
      throw new Error(`index ${index} is outside the vertex buffer`);
    }
  });

  const attributes = mesh.attributes;
  if (!attributes) return;

  const entries = [
    ["normal", attributes.normals],
    ["tangent", attributes.tangents],
    ["uv", attributes.uvs],
    ["color", attributes.colors],
  ] as const;

  entries.forEach(([name, values]) => {
    if (!values) return;
    if (values.length !== mesh.vertices.length) {
      throw new Error(`${name} attribute count must match vertex count`);
    }
    values.forEach((value, index) => {
      if (!finiteTuple(value)) throw new Error(`${name} attribute ${index} contains a non-finite value`);
    });
  });
}

export function triangleCount(mesh: IndexedMesh): number {
  validateMesh(mesh);
  return mesh.indices.length / 3;
}

export function expandedVertexCount(mesh: IndexedMesh): number {
  validateMesh(mesh);
  return mesh.indices.length;
}

function subtract(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function scale(value: Vec3, factor: number): Vec3 {
  return [value[0] * factor, value[1] * factor, value[2] * factor];
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize(value: Vec3): Vec3 | null {
  const length = Math.hypot(value[0], value[1], value[2]);
  if (length <= Number.EPSILON) return null;
  return [value[0] / length, value[1] / length, value[2] / length];
}

export function triangleNormal(mesh: IndexedMesh, triangleIndex: number): Vec3 | null {
  validateMesh(mesh);
  if (!Number.isInteger(triangleIndex) || triangleIndex < 0 || triangleIndex >= triangleCount(mesh)) {
    return null;
  }

  const start = triangleIndex * 3;
  const a = mesh.vertices[mesh.indices[start]];
  const b = mesh.vertices[mesh.indices[start + 1]];
  const c = mesh.vertices[mesh.indices[start + 2]];
  return normalize(cross(subtract(b, a), subtract(c, a)));
}

export function smoothVertexNormals(mesh: IndexedMesh): Vec3[] {
  validateMesh(mesh);
  const sums = mesh.vertices.map(() => [0, 0, 0] as [number, number, number]);

  for (let triangleIndex = 0; triangleIndex < mesh.indices.length; triangleIndex += 3) {
    const ia = mesh.indices[triangleIndex];
    const ib = mesh.indices[triangleIndex + 1];
    const ic = mesh.indices[triangleIndex + 2];
    const a = mesh.vertices[ia];
    const b = mesh.vertices[ib];
    const c = mesh.vertices[ic];
    const areaWeightedNormal = cross(subtract(b, a), subtract(c, a));

    [ia, ib, ic].forEach((index) => {
      sums[index][0] += areaWeightedNormal[0];
      sums[index][1] += areaWeightedNormal[1];
      sums[index][2] += areaWeightedNormal[2];
    });
  }

  return sums.map((sum) => normalize(sum) ?? [0, 0, 0]);
}

export function deriveTangents(mesh: IndexedMesh): Vec4[] {
  validateMesh(mesh);
  const normals = mesh.attributes?.normals;
  const uvs = mesh.attributes?.uvs;
  if (!normals) throw new Error("tangent derivation requires vertex normals");
  if (!uvs) throw new Error("tangent derivation requires UV coordinates");

  const tangentSums = mesh.vertices.map(() => [0, 0, 0] as [number, number, number]);
  const bitangentSums = mesh.vertices.map(() => [0, 0, 0] as [number, number, number]);

  for (let index = 0; index < mesh.indices.length; index += 3) {
    const triangleIndex = index / 3;
    const ia = mesh.indices[index];
    const ib = mesh.indices[index + 1];
    const ic = mesh.indices[index + 2];
    const a = mesh.vertices[ia];
    const b = mesh.vertices[ib];
    const c = mesh.vertices[ic];
    const uvA = uvs[ia];
    const uvB = uvs[ib];
    const uvC = uvs[ic];
    const edgeAB = subtract(b, a);
    const edgeAC = subtract(c, a);
    const duAB = uvB[0] - uvA[0];
    const dvAB = uvB[1] - uvA[1];
    const duAC = uvC[0] - uvA[0];
    const dvAC = uvC[1] - uvA[1];
    const determinant = duAB * dvAC - dvAB * duAC;
    if (Math.abs(determinant) <= TANGENT_EPSILON) {
      throw new Error(`triangle ${triangleIndex} has a degenerate UV parameterization`);
    }

    const reciprocal = 1 / determinant;
    const tangent: Vec3 = [
      (edgeAB[0] * dvAC - edgeAC[0] * dvAB) * reciprocal,
      (edgeAB[1] * dvAC - edgeAC[1] * dvAB) * reciprocal,
      (edgeAB[2] * dvAC - edgeAC[2] * dvAB) * reciprocal,
    ];
    const bitangent: Vec3 = [
      (edgeAC[0] * duAB - edgeAB[0] * duAC) * reciprocal,
      (edgeAC[1] * duAB - edgeAB[1] * duAC) * reciprocal,
      (edgeAC[2] * duAB - edgeAB[2] * duAC) * reciprocal,
    ];

    [ia, ib, ic].forEach((vertexIndex) => {
      tangentSums[vertexIndex][0] += tangent[0];
      tangentSums[vertexIndex][1] += tangent[1];
      tangentSums[vertexIndex][2] += tangent[2];
      bitangentSums[vertexIndex][0] += bitangent[0];
      bitangentSums[vertexIndex][1] += bitangent[1];
      bitangentSums[vertexIndex][2] += bitangent[2];
    });
  }

  return normals.map((sourceNormal, vertexIndex) => {
    const normal = normalize(sourceNormal);
    if (!normal) throw new Error(`vertex ${vertexIndex} has a zero-length normal`);
    const tangentSum = tangentSums[vertexIndex];
    const tangent = normalize(subtract(tangentSum, scale(normal, dot(normal, tangentSum))));
    if (!tangent) throw new Error(`vertex ${vertexIndex} does not produce a stable tangent direction`);
    const handedness = dot(cross(normal, tangent), bitangentSums[vertexIndex]) < 0 ? -1 : 1;
    return [tangent[0], tangent[1], tangent[2], handedness] as const;
  });
}

export function subdividedPlane(segments: number): IndexedMesh {
  if (!Number.isInteger(segments) || segments < 1 || segments > MAX_SUBDIVISIONS) {
    throw new Error(`segments must be an integer from 1 to ${MAX_SUBDIVISIONS}`);
  }

  const vertices: Vec3[] = [];
  const uvs: Vec2[] = [];
  const normals: Vec3[] = [];
  const indices: number[] = [];
  const rowSize = segments + 1;

  for (let row = 0; row <= segments; row += 1) {
    const v = row / segments;
    for (let column = 0; column <= segments; column += 1) {
      const u = column / segments;
      vertices.push([-1 + u * 2, 0, -1 + v * 2]);
      uvs.push([u, v]);
      normals.push([0, 1, 0]);
    }
  }

  for (let row = 0; row < segments; row += 1) {
    for (let column = 0; column < segments; column += 1) {
      const a = row * rowSize + column;
      const b = a + 1;
      const c = a + rowSize;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }

  const mesh: IndexedMesh = { vertices, indices, attributes: { normals, uvs } };
  validateMesh(mesh);
  return mesh;
}
