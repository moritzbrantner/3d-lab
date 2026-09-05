import { validateMesh, type IndexedMesh } from "./mesh";

export type PackedWebGpuMesh = {
  vertices: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
};

function ownedFloat32Array(values: readonly number[]): Float32Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(values.length * Float32Array.BYTES_PER_ELEMENT);
  const view = new Float32Array(buffer);
  view.set(values);
  return view;
}

function ownedUint32Array(values: readonly number[]): Uint32Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(values.length * Uint32Array.BYTES_PER_ELEMENT);
  const view = new Uint32Array(buffer);
  view.set(values);
  return view;
}

export function packWebGpuMesh(mesh: IndexedMesh): PackedWebGpuMesh {
  validateMesh(mesh);
  return {
    vertices: ownedFloat32Array(mesh.vertices.flatMap((vertex) => [...vertex])),
    indices: ownedUint32Array(mesh.indices),
  };
}
