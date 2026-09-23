import type { BufferGeometry, Material, Object3D } from "three";

type Renderable = Object3D & {
  isMesh?: boolean;
  isLine?: boolean;
  isPoints?: boolean;
  geometry: BufferGeometry;
  material: Material | Material[];
};

/** Dispose geometry/materials owned by this subtree, once per shared resource.
 * Use Three's type flags: renderer-package and application constructors may
 * come from distinct module instances. Textures and skeletons stay explicit.
 */
export function disposeRenderableResources(root: Object3D): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  root.traverse((object) => {
    const renderable = object as Renderable;
    if (!renderable.isMesh && !renderable.isLine && !renderable.isPoints) return;
    geometries.add(renderable.geometry);
    const entries = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
    entries.forEach((material) => materials.add(material));
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
}
