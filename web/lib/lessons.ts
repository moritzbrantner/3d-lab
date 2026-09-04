import { cubeMesh, expandedVertexCount, triangleCount, triangleMesh } from "./mesh";

export type LessonId =
  | "coordinates"
  | "vertices"
  | "triangles"
  | "indexed-meshes"
  | "normals"
  | "transforms"
  | "projection"
  | "lighting"
  | "animation";

export type Lesson = {
  id: LessonId;
  number: string;
  title: string;
  summary: string;
  explanation: string;
  notice: string;
  three: string;
  rust: string;
  stats: readonly [label: string, value: string][];
};

export const lessons: readonly Lesson[] = [
  {
    id: "coordinates",
    number: "01",
    title: "Coordinate systems",
    summary: "Position everything with x, y, and z.",
    explanation: "A 3D scene is a coordinate system. Positions are vectors measured from an origin, and axes give those numbers a spatial meaning.",
    notice: "Orbit the camera and watch how the same fixed axes are viewed from different directions.",
    three: "THREE.Vector3, Object3D.position, AxesHelper",
    rust: "three_d_core::Vec3",
    stats: [["dimensions", "3"], ["origin", "(0, 0, 0)"], ["axes", "x / y / z"]],
  },
  {
    id: "vertices",
    number: "02",
    title: "Vertices",
    summary: "A vertex is a data record, not a little rendered ball.",
    explanation: "At minimum, a mesh vertex can carry a position. Real meshes often attach normals, UV coordinates, colors, skin weights, and other attributes to the same logical corner.",
    notice: "The three visible points are only a visualization of three position records.",
    three: "BufferAttribute attached to BufferGeometry",
    rust: "Vec<Vec3> inside Mesh",
    stats: [["positions", String(triangleMesh.vertices.length)], ["components / position", "3"], ["position scalars", "9"]],
  },
  {
    id: "triangles",
    number: "03",
    title: "Triangles",
    summary: "Three corners form the primitive GPUs love to rasterize.",
    explanation: "A triangle is defined by three vertex references. Winding order gives the triangle an orientation, which affects its normal and whether back-face culling considers it front-facing.",
    notice: "Rotate behind the triangle. The lesson uses a double-sided material so its winding remains inspectable from either side.",
    three: "BufferGeometry + Mesh",
    rust: "Triangle([u32; 3]) + Mesh::triangle_normal",
    stats: [["vertices", String(triangleMesh.vertices.length)], ["indices", String(triangleMesh.indices.length)], ["triangles", String(triangleCount(triangleMesh))]],
  },
  {
    id: "indexed-meshes",
    number: "04",
    title: "Indexed meshes",
    summary: "Reuse vertex data instead of duplicating every triangle corner.",
    explanation: "An index buffer lets many triangles refer to the same vertex positions. This cube has eight unique positions but twelve triangles and thirty-six indexed corners.",
    notice: "The wireframe reveals twelve triangles while the point markers reveal only eight unique positions.",
    three: "geometry.setIndex(...) + position attribute",
    rust: "Mesh { vertices, indices }",
    stats: [["unique vertices", String(cubeMesh.vertices.length)], ["triangle corners", String(expandedVertexCount(cubeMesh))], ["triangles", String(triangleCount(cubeMesh))]],
  },
  {
    id: "normals",
    number: "05",
    title: "Normals",
    summary: "Normals tell lighting which way a surface faces.",
    explanation: "A triangle normal is derived from two edges using a cross product. Vertex normals can then be shared or averaged to make lighting appear faceted or smooth.",
    notice: "The short line segments point in the direction used by the lighting calculation.",
    three: "computeVertexNormals() + VertexNormalsHelper",
    rust: "Vec3::cross + Mesh::triangle_normal",
    stats: [["cube vertices", "24 rendered"], ["normal components", "3"], ["normal length", "1"]],
  },
  {
    id: "transforms",
    number: "06",
    title: "Transforms",
    summary: "Translate, rotate, and scale geometry without rewriting its vertices.",
    explanation: "Object transforms are composed into matrices. The model's local vertex data stays the same while a transform places that model into world space.",
    notice: "Use the controls below the viewport. The cube's source mesh remains unchanged while its Object3D transform changes.",
    three: "Object3D.position / rotation / scale / matrix",
    rust: "future transform layer consuming Vec3 and Mesh",
    stats: [["translation", "3 values"], ["rotation", "3 Euler angles"], ["scale", "3 values"]],
  },
  {
    id: "projection",
    number: "07",
    title: "Projection",
    summary: "A camera turns 3D positions into a 2D image.",
    explanation: "Perspective projection makes distant objects appear smaller. Orthographic projection preserves apparent size with distance, which is useful for CAD, diagrams, and some game views.",
    notice: "Switch projection modes and compare the three equal cubes arranged at increasing depth.",
    three: "PerspectiveCamera / OrthographicCamera",
    rust: "future renderer-side camera matrices, outside Mesh ownership",
    stats: [["perspective", "depth scales size"], ["orthographic", "size is depth-invariant"], ["camera output", "clip space"]],
  },
  {
    id: "lighting",
    number: "08",
    title: "Lighting",
    summary: "Geometry, normals, material, and lights meet in shading.",
    explanation: "Lighting evaluates how a surface orientation relates to light sources and material properties. The mesh topology itself does not need to know which lighting model renders it.",
    notice: "Orbit around the sphere and compare the lit side, the grazing edge, and the shadowed side.",
    three: "MeshStandardMaterial + AmbientLight + DirectionalLight",
    rust: "renderer concern; core geometry only supplies positions/topology/normals",
    stats: [["ambient lights", "1"], ["directional lights", "1"], ["material", "standard"]],
  },
  {
    id: "animation",
    number: "09",
    title: "Animation",
    summary: "Change scene state over time, then render another frame.",
    explanation: "Animation is repeated state evolution. A renderer does not inherently require skeletal animation: even incrementing an object's rotation every frame is already an animation loop.",
    notice: "Pause the animation to separate the static mesh from the time-varying transform.",
    three: "requestAnimationFrame + Object3D.rotation",
    rust: "future animation/evaluation layer above renderer-independent Mesh",
    stats: [["mesh", "torus knot"], ["animated values", "rotation x / y"], ["clock", "frame delta"]],
  },
] as const;
