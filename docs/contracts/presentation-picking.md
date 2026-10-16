# Native presentation picking

Independent acceptance for [#125](https://github.com/moritzbrantner/3d-lab/issues/125),
established against `3ad582f7e288a40792155e41b27611804e254dc8` before implementation.
The API below is specified by the acceptance tests; it was absent at that baseline.

`three_d_projective::picking` composes the existing projective, camera, transform
and validated `Mesh` owners. It does not introduce a renderer or physics solver.

- `PickRay::from_viewport(view_projection: Mat4, viewport: [u32; 2], pixel: [f64; 2])`
  returns a `Result<PickRay, _>`. Coordinates are continuous physical viewport
  coordinates, top-left origin, including exact outer edges. Invalid dimensions,
  nonfinite/outside points and nonfinite/singular matrices are errors, not clamps.
- The right-handed WebGPU `0..1` depth convention matches `PerspectiveCamera`.
  `origin() -> [f64; 3]` is the unprojected near-plane point,
  `direction() -> [f64; 3]` is the unit world direction toward the far plane, and
  `max_distance() -> f64` bounds the near-to-far segment. Distances are world units
  from the near-plane point, not camera-eye distances, local distances or depth values.
  Reuse existing trusted projective inversion; do not add another inverse solver.
- `ray.intersect_mesh(&Mesh, model: Mat4, CullMode) -> Result<Option<PickHit>, _>`
  returns the nearest triangle surface on the inclusive bounded segment. Its
  endpoints come from the supplied, represented view-projection matrix, which
  can differ from the camera's nominal near/far parameters after f32 rounding.
  A longer far range must not expand the near bound or admit geometry outside
  the actual segment. Do not clamp an off-segment intersection into a hit at a
  position that is not on the triangle surface. A miss
  is `Ok(None)`. `PickHit` exposes `distance: f64`, `position: [f64; 3]` and
  `triangle_index: usize`. Equal-depth triangles choose the lowest index.
- Model matrices are finite, nonsingular affine transforms. Translation, rotation,
  nonuniform scale and reflections are supported. Projective or invalid model
  matrices are errors. `Mesh::unit_cube()` under the same rendered model matrix
  supplies box geometry; do not substitute its world AABB for the surface.
- `CullMode::{None, Back, Front}` explicitly selects two-sided, back-face or
  front-face culling. Front winding is counterclockwise in transformed world
  geometry. Reflections reverse it; callers must match their renderer's policy.
- Indexed triangle surfaces, edges and vertices are eligible hits. Empty meshes,
  zero-area/repeated-index/collinear triangles and parallel rays create no hits;
  degenerate triangles do not hide another valid triangle in the mesh.

Meshes are already validated by `three-d-core`. The caller supplies its actually
drawn geometry and transforms, compares hit distances across objects and owns
object identities and any equal-depth object policy. This library owns neither
an object list nor scene hierarchy, gestures, selection, NPC interaction, gameplay
range, collision authority, acceleration structures or skin deformation. An
adapter must supply the geometry pose that it draws; bind-pose picking does not
claim animated silhouette parity. Alpha-cutout/displaced materials are outside
this triangle-surface contract. No browser behavior changes are implied.

Run `cargo test -p three-d-projective --test presentation_picking` and
`cargo run -p three-d-projective --example presentation_picking`. The example
demonstrates public native API depth composition. This technical enabler does not
prove a downstream game's physical input, connected host or GPU acceptance.
