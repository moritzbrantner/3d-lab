import {
  coloredTriangleMesh,
  cubeMesh,
  expandedVertexCount,
  triangleCount,
  triangleMesh,
  uvQuadMesh,
} from "./mesh";

export type LessonId =
  | "coordinates"
  | "vertices"
  | "triangles"
  | "indexed-meshes"
  | "normals"
  | "transforms"
  | "projection"
  | "lighting"
  | "animation"
  | "normal-modes"
  | "uvs"
  | "vertex-colors"
  | "winding"
  | "procedural"
  | "matrix-composition"
  | "hierarchy"
  | "keyframes"
  | "quaternions"
  | "skinning"
  | "gltf-animation";

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
    rust: "Mesh { vertices, indices, attributes }",
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
    rust: "three_d_animation::Transform + Mat4",
    stats: [["translation", "3 values"], ["rotation", "quaternion / Euler view"], ["scale", "3 values"]],
  },
  {
    id: "projection",
    number: "07",
    title: "Projection",
    summary: "A camera turns 3D positions into a 2D image.",
    explanation: "Perspective projection makes distant objects appear smaller. Orthographic projection preserves apparent size with distance, which is useful for CAD, diagrams, and some game views.",
    notice: "Switch projection modes and compare the three equal cubes arranged at increasing depth.",
    three: "PerspectiveCamera / OrthographicCamera",
    rust: "renderer-side camera matrices remain outside mesh ownership",
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
    rust: "renderer concern; core geometry supplies positions/topology/normals",
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
    rust: "three_d_animation::AnimationClip builds on the same idea",
    stats: [["mesh", "torus knot"], ["animated values", "rotation x / y"], ["clock", "frame delta"]],
  },
  {
    id: "normal-modes",
    number: "10",
    title: "Flat vs. smooth normals",
    summary: "The same coarse shape can look faceted or smoothly rounded.",
    explanation: "Flat shading uses one face direction across each triangle. Smooth shading averages neighboring face directions at shared vertices. Geometry and normal ownership determine where a hard edge can exist.",
    notice: "Compare the left faceted icosphere with the right smooth one. Their silhouette is similar; their lighting changes because the normals differ.",
    three: "MeshStandardMaterial.flatShading + computeVertexNormals()",
    rust: "Mesh::triangle_normal + Mesh::smooth_vertex_normals",
    stats: [["left", "face-oriented shading"], ["right", "averaged vertex normals"], ["topology", "same coarse sphere"]],
  },
  {
    id: "uvs",
    number: "11",
    title: "UV coordinates",
    summary: "A second coordinate system tells a texture where it lands on a mesh.",
    explanation: "UVs are usually two numbers attached to each indexed vertex slot. They can range beyond zero-to-one for tiling, and seams may require duplicated positions because one spatial corner can need different UV coordinates.",
    notice: "The checker pattern follows the quad's UV attribute. Orbit behind the plane to see that UV data belongs to the mesh, not the camera.",
    three: "uv BufferAttribute + material.map",
    rust: "VertexAttributes::uvs with Vec2",
    stats: [["positions", String(uvQuadMesh.vertices.length)], ["UV pairs", String(uvQuadMesh.attributes?.uvs?.length ?? 0)], ["UV domain", "0..1 in this example"]],
  },
  {
    id: "vertex-colors",
    number: "12",
    title: "Vertex colors",
    summary: "Attributes can carry data that the shader interpolates across a triangle.",
    explanation: "Color can be stored per vertex just like a normal or UV. During rasterization the three corner values are interpolated for the pixels inside the triangle, producing a continuous gradient without a texture.",
    notice: "Each corner starts with a different RGB value. The colors between them are generated by interpolation across the triangle.",
    three: "color BufferAttribute + vertexColors material option",
    rust: "VertexAttributes::colors with Color3",
    stats: [["positions", String(coloredTriangleMesh.vertices.length)], ["colors", String(coloredTriangleMesh.attributes?.colors?.length ?? 0)], ["texture samples", "0"]],
  },
  {
    id: "winding",
    number: "13",
    title: "Winding & back-face culling",
    summary: "Index order determines which side of a triangle is the front.",
    explanation: "Reversing two indices flips the face normal. Renderers commonly discard triangles facing away from the camera, which saves work and makes winding consistency important for closed meshes.",
    notice: "The two triangles use opposite winding. Orbit around them, then switch to double-sided rendering to separate culling from the underlying orientation.",
    three: "FrontSide / DoubleSide + index order",
    rust: "Triangle index order + Mesh::triangle_normal",
    stats: [["left indices", "0, 1, 2"], ["right indices", "0, 2, 1"], ["normal relation", "opposites"]],
  },
  {
    id: "procedural",
    number: "14",
    title: "Subdivision & procedural meshes",
    summary: "Generate vertex and index buffers from a rule instead of loading a model.",
    explanation: "A subdivided plane is a useful first procedural mesh: an (n+1) by (n+1) vertex grid is connected into 2n² triangles. The same construction also generates aligned normals and UVs.",
    notice: "Increase the segment count and watch topology density grow quadratically while the physical size of the plane stays fixed.",
    three: "BufferGeometry generated from typed lesson data",
    rust: "Mesh::subdivided_plane",
    stats: [["vertices", "(n + 1)²"], ["triangles", "2n²"], ["generated attributes", "normal + UV"]],
  },
  {
    id: "matrix-composition",
    number: "15",
    title: "Matrix composition",
    summary: "See translation × rotation × scale become one model matrix.",
    explanation: "Homogeneous 4×4 matrices let translation, rotation, and scale share one representation. Their multiplication order matters: the model matrix here applies local scale, then rotation, then world translation.",
    notice: "Rotate the composed matrix. The wireframe cube is an untransformed reference; the solid cube is positioned entirely by an explicit matrix.",
    three: "Matrix4.makeTranslation / makeRotationY / makeScale / multiply",
    rust: "Mat4::translation × Mat4::rotation × Mat4::scale",
    stats: [["matrix", "4 × 4"], ["stored scalars", "16"], ["composition", "T × R × S"]],
  },
  {
    id: "hierarchy",
    number: "16",
    title: "Parent & child transforms",
    summary: "A child inherits the world transform accumulated above it.",
    explanation: "Scene graphs store local transforms and derive world transforms by multiplying through the parent chain. This is why moving a shoulder also moves the forearm and hand without rewriting their local coordinates.",
    notice: "Change the parent angle and watch both downstream links move. The child also has its own local rotation, composed after the parent transform.",
    three: "Object3D.add + matrixWorld",
    rust: "TransformNode + world_matrices",
    stats: [["hierarchy depth", "3"], ["world rule", "parent world × child local"], ["storage rule", "parent before child"]],
  },
  {
    id: "keyframes",
    number: "17",
    title: "Keyframes, interpolation & clips",
    summary: "Store sparse poses, then reconstruct the motion between them.",
    explanation: "A keyframe track records values at specific times. Interpolation fills the gaps, easing remaps interpolation time, and multiple tracks can be packaged into a reusable animation clip.",
    notice: "Scrub between the three keyframes, compare linear and smooth interpolation, or play the same clip repeatedly.",
    three: "VectorKeyframeTrack + AnimationClip + AnimationMixer",
    rust: "KeyframeTrack<T> + Interpolation + AnimationClip",
    stats: [["keyframes", "3"], ["clip duration", "2 s"], ["interpolation", "linear / smooth"]],
  },
  {
    id: "quaternions",
    number: "18",
    title: "Euler angles vs. quaternions",
    summary: "Euler angles are intuitive; quaternions interpolate orientation robustly.",
    explanation: "Euler rotations are three ordered axis rotations and can lose a degree of freedom near gimbal lock. Unit quaternions encode orientation without that axis alignment problem and support spherical interpolation (SLERP).",
    notice: "Move toward the 90° middle-axis rotation. The left object linearly interpolates Euler angles; the right follows a quaternion SLERP between the same endpoint orientations.",
    three: "Euler + Quaternion.slerpQuaternions",
    rust: "Quat::from_euler_xyz + Quat::slerp",
    stats: [["Euler values", "3 angles + order"], ["quaternion values", "x / y / z / w"], ["rotation interpolation", "SLERP"]],
  },
  {
    id: "skinning",
    number: "19",
    title: "Skeletons & skinning",
    summary: "Joints deform one mesh by blending multiple bone transforms.",
    explanation: "A skeleton is a transform hierarchy plus inverse bind matrices. Each skinned vertex stores joint indices and weights; the final position blends the corresponding joint skin matrices.",
    notice: "Bend the middle joint. Vertices near the joint blend two bones, so the strip deforms instead of breaking into rigid pieces.",
    three: "Bone + Skeleton + SkinnedMesh + skinIndex/skinWeight",
    rust: "Skeleton + Joint + SkinInfluence + skin_matrices",
    stats: [["joints", "3"], ["max influences / vertex", "4"], ["weight rule", "normalized sum = 1"]],
  },
  {
    id: "gltf-animation",
    number: "20",
    title: "Minimal glTF animation",
    summary: "Load the same animation concepts from a standard asset container.",
    explanation: "glTF stores nodes, accessors, buffers, animation samplers, and channels in a portable format. The tiny embedded asset has one node and one translation track, proving the model pipeline is the same keyframe machinery packaged for interchange.",
    notice: "Pause and resume the loaded glTF clip. The visible cube is attached to the animated glTF node so you can see the imported channel move it.",
    three: "GLTFLoader + AnimationMixer",
    rust: "AnimationClip/Skeleton data are ready for a later glTF adapter",
    stats: [["glTF version", "2.0"], ["nodes", "1"], ["animation channels", "1 translation"]],
  },
] as const;