//! Independent acceptance for #125, authored against 3ad582f before implementation.
//! These fixtures describe presentation geometry only, never gameplay entities.
use three_d_animation::{Mat4, Quat};
use three_d_camera::PerspectiveCamera;
use three_d_core::{Mesh, Vec3};
use three_d_projective::{
    picking::{CullMode, PickHit, PickRay},
    transform_point_projective,
};

const VIEWPORT: [u32; 2] = [800, 400];
const CENTER: [f64; 2] = [400.0, 200.0];

fn camera() -> PerspectiveCamera {
    PerspectiveCamera::new(
        Vec3::new(0.0, 0.0, 5.0),
        Vec3::ZERO,
        Vec3::new(0.0, 1.0, 0.0),
        std::f32::consts::FRAC_PI_2,
        2.0,
        1.0,
        11.0,
    )
    .unwrap()
}

fn ray(pixel: [f64; 2]) -> PickRay {
    PickRay::from_viewport(camera().view_projection_matrix(), VIEWPORT, pixel).unwrap()
}

fn plane(z: f32) -> Mesh {
    Mesh::new(
        vec![
            Vec3::new(-20.0, -20.0, z),
            Vec3::new(20.0, -20.0, z),
            Vec3::new(0.0, 20.0, z),
        ],
        vec![0, 1, 2],
    )
    .unwrap()
}

fn hit(ray: &PickRay, mesh: &Mesh, model: Mat4) -> PickHit {
    ray.intersect_mesh(mesh, model, CullMode::None)
        .unwrap()
        .expect("fixture geometry must be hit")
}

fn close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 0.000_02,
        "expected {expected}, got {actual}"
    );
}

fn point_close(actual: [f64; 3], expected: [f64; 3]) {
    for (actual, expected) in actual.into_iter().zip(expected) {
        close(actual, expected);
    }
}

#[test]
fn center_ray_uses_webgpu_near_and_far_planes_and_world_distance() {
    let ray = ray(CENTER);
    point_close(ray.origin(), [0.0, 0.0, 4.0]);
    point_close(ray.direction(), [0.0, 0.0, -1.0]);
    close(ray.max_distance(), 10.0);
    let hit = hit(&ray, &plane(0.0), Mat4::IDENTITY);
    close(hit.distance, 4.0);
    point_close(hit.position, [0.0, 0.0, 0.0]);
    assert_eq!(hit.triangle_index, 0);
}

#[test]
fn top_left_origin_and_aspect_match_existing_camera_projection() {
    // Independent analytic expectation: a 90 degree vertical FOV, aspect 2.
    let ray = ray([600.0, 100.0]);
    point_close(ray.origin(), [1.0, 0.5, 4.0]);
    let length = 2.25_f64.sqrt();
    point_close(ray.direction(), [1.0 / length, 0.5 / length, -1.0 / length]);
    let result = hit(&ray, &plane(0.0), Mat4::IDENTITY);
    point_close(result.position, [5.0, 2.5, 0.0]);
    close(result.distance, 4.0 * length);
    let ndc =
        transform_point_projective(camera().view_projection_matrix(), Vec3::new(5.0, 2.5, 0.0))
            .unwrap();
    close(f64::from(ndc.x), 0.5);
    close(f64::from(ndc.y), 0.5);
}

#[test]
fn translated_rotated_camera_ray_hits_the_projected_world_point() {
    let camera = PerspectiveCamera::new(
        Vec3::new(8.0, 3.0, -5.0),
        Vec3::new(3.0, 1.0, 2.0),
        Vec3::new(0.0, 1.0, 0.0),
        50_f32.to_radians(),
        2.0,
        0.1,
        100.0,
    )
    .unwrap();
    let target = Vec3::new(3.0, 1.0, 2.0);
    let ndc = transform_point_projective(camera.view_projection_matrix(), target).unwrap();
    let pixel = [
        (f64::from(ndc.x) + 1.0) * 400.0,
        (1.0 - f64::from(ndc.y)) * 200.0,
    ];
    let ray = PickRay::from_viewport(camera.view_projection_matrix(), VIEWPORT, pixel).unwrap();
    let result = hit(&ray, &Mesh::unit_cube(), Mat4::translation(target));
    // The camera is on the -Z side, so the cube's -Z face is reached first.
    close(result.position[2], 1.5);
    assert!(result.distance > 0.0 && result.distance < ray.max_distance());
}

#[test]
fn transformed_box_hits_compare_in_world_units_under_nonuniform_scale_and_yaw() {
    let transform = Mat4::trs(
        Vec3::new(0.0, 0.0, -1.0),
        Quat::from_axis_angle(Vec3::new(0.0, 1.0, 0.0), std::f32::consts::FRAC_PI_2).unwrap(),
        Vec3::new(4.0, 2.0, 1.0),
    );
    let ray = ray(CENTER);
    let result = hit(&ray, &Mesh::unit_cube(), transform);
    point_close(result.position, [0.0, 0.0, 1.0]);
    close(result.distance, 3.0);
    let wall = hit(&ray, &plane(2.0), Mat4::IDENTITY);
    assert!(
        wall.distance < result.distance,
        "nearer scenery occludes the box"
    );
    let ordinary = hit(&ray, &Mesh::unit_cube(), Mat4::IDENTITY);
    close(ordinary.distance, 3.5);
}

#[test]
fn mesh_indices_choose_geometry_instead_of_its_bounds_or_triangle_order() {
    let mesh = Mesh::new(
        vec![
            Vec3::new(-1.0, -1.0, -2.0),
            Vec3::new(1.0, -1.0, -2.0),
            Vec3::new(0.0, 1.0, -2.0),
            Vec3::new(-1.0, -1.0, 1.0),
            Vec3::new(1.0, -1.0, 1.0),
            Vec3::new(0.0, 1.0, 1.0),
        ],
        vec![0, 1, 2, 3, 4, 5],
    )
    .unwrap();
    let result = hit(&ray(CENTER), &mesh, Mat4::IDENTITY);
    assert_eq!(
        result.triangle_index, 1,
        "nearest triangle beats first listed"
    );
    close(result.distance, 3.0);
    // A point inside the triangle's AABB but outside its actual silhouette.
    let ndc =
        transform_point_projective(camera().view_projection_matrix(), Vec3::new(0.8, 0.8, 1.0))
            .unwrap();
    let miss = ray([
        (f64::from(ndc.x) + 1.0) * 400.0,
        (1.0 - f64::from(ndc.y)) * 200.0,
    ]);
    assert!(
        miss.intersect_mesh(&mesh, Mat4::IDENTITY, CullMode::None)
            .unwrap()
            .is_none()
    );
}

#[test]
fn clipping_rejects_surfaces_before_near_beyond_far_and_behind_camera() {
    let ray = ray(CENTER);
    for z in [4.5, -6.5, 6.0] {
        assert!(
            ray.intersect_mesh(&plane(z), Mat4::IDENTITY, CullMode::None)
                .unwrap()
                .is_none(),
            "z={z}"
        );
    }
    // The API accepts the represented VP matrix, not nominal camera parameters.
    // This perspective has exactly representable depth coefficients A=B=-2,
    // so both inclusive boundaries are exact even after matrix construction.
    let camera = PerspectiveCamera::new(
        Vec3::ZERO,
        Vec3::new(0.0, 0.0, -1.0),
        Vec3::new(0.0, 1.0, 0.0),
        std::f32::consts::FRAC_PI_2,
        2.0,
        1.0,
        2.0,
    )
    .unwrap();
    let exact = PickRay::from_viewport(camera.view_projection_matrix(), VIEWPORT, CENTER).unwrap();
    close(hit(&exact, &plane(-1.0), Mat4::IDENTITY).distance, 0.0);
    close(hit(&exact, &plane(-2.0), Mat4::IDENTITY).distance, 1.0);
}

fn large_far_span() -> PickRay {
    let camera = PerspectiveCamera::new(
        Vec3::ZERO,
        Vec3::new(0.0, 0.0, -1.0),
        Vec3::new(0.0, 1.0, 0.0),
        std::f32::consts::FRAC_PI_2,
        2.0,
        1.0,
        1_000_000.0,
    )
    .unwrap();
    PickRay::from_viewport(camera.view_projection_matrix(), VIEWPORT, CENTER).unwrap()
}

#[test]
fn large_far_span_never_expands_the_near_plane_or_clamps_an_off_surface_hit() {
    let ray = large_far_span();
    point_close(ray.origin(), [0.0, 0.0, -1.0]);
    assert!(ray.max_distance() > 1_000_000.0);
    assert!(
        ray.intersect_mesh(&plane(-0.75), Mat4::IDENTITY, CullMode::None)
            .unwrap()
            .is_none(),
        "a longer far range must not admit a surface 0.25 before near"
    );
}

#[test]
fn large_far_span_never_expands_the_represented_far_plane() {
    let ray = large_far_span();
    let endpoint = ray.origin()[2] + ray.direction()[2] * ray.max_distance();
    let outside = (endpoint - 0.25) as f32;
    assert!(f64::from(outside) < endpoint - 0.1);
    assert!(
        ray.intersect_mesh(&plane(outside), Mat4::IDENTITY, CullMode::None)
            .unwrap()
            .is_none(),
        "a surface beyond the actual unprojected endpoint must not become a clamped hit"
    );
}

#[test]
fn edges_vertices_and_equal_depth_ties_are_stable() {
    let mesh = Mesh::new(
        vec![
            Vec3::new(0.0, 0.0, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
        ],
        vec![0, 1, 2, 0, 1, 2],
    )
    .unwrap();
    let result = hit(&ray(CENTER), &mesh, Mat4::IDENTITY);
    assert_eq!(
        result.triangle_index, 0,
        "coplanar ties use lowest triangle index"
    );
    let edge = Mesh::new(
        vec![
            Vec3::new(-1.0, 0.0, 0.0),
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
        ],
        vec![0, 1, 2],
    )
    .unwrap();
    close(hit(&ray(CENTER), &edge, Mat4::IDENTITY).distance, 4.0);
}

#[test]
fn culling_follows_world_winding_including_reflections() {
    let ray = ray(CENTER);
    let front = plane(0.0);
    assert!(
        ray.intersect_mesh(&front, Mat4::IDENTITY, CullMode::Back)
            .unwrap()
            .is_some()
    );
    assert!(
        ray.intersect_mesh(&front, Mat4::IDENTITY, CullMode::Front)
            .unwrap()
            .is_none()
    );
    let reflected = Mat4::scale(Vec3::new(-1.0, 1.0, 1.0));
    assert!(
        ray.intersect_mesh(&front, reflected, CullMode::Back)
            .unwrap()
            .is_none()
    );
    assert!(
        ray.intersect_mesh(&front, reflected, CullMode::Front)
            .unwrap()
            .is_some()
    );
    assert!(
        ray.intersect_mesh(&front, reflected, CullMode::None)
            .unwrap()
            .is_some()
    );
}

#[test]
fn empty_collinear_and_parallel_geometry_produce_no_phantom_hits() {
    let ray = ray(CENTER);
    let empty = Mesh::new(vec![], vec![]).unwrap();
    let degenerate = Mesh::new(
        vec![
            Vec3::ZERO,
            Vec3::new(1.0, 0.0, 0.0),
            Vec3::new(2.0, 0.0, 0.0),
        ],
        vec![0, 1, 2, 0, 0, 0],
    )
    .unwrap();
    let parallel = Mesh::new(
        vec![
            Vec3::new(1.0, -1.0, 1.0),
            Vec3::new(1.0, 1.0, 1.0),
            Vec3::new(1.0, 0.0, -1.0),
        ],
        vec![0, 1, 2],
    )
    .unwrap();
    for mesh in [empty, degenerate, parallel] {
        assert!(
            ray.intersect_mesh(&mesh, Mat4::IDENTITY, CullMode::None)
                .unwrap()
                .is_none()
        );
    }
    let mixed = Mesh::new(
        vec![
            Vec3::new(-1.0, -1.0, 0.0),
            Vec3::new(1.0, -1.0, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
        ],
        vec![0, 0, 0, 0, 1, 2],
    )
    .unwrap();
    assert_eq!(hit(&ray, &mixed, Mat4::IDENTITY).triangle_index, 1);
}

#[test]
fn ray_start_inside_box_obeys_culling_and_still_reports_an_exit_surface() {
    let camera = PerspectiveCamera::new(
        Vec3::ZERO,
        Vec3::new(0.0, 0.0, -1.0),
        Vec3::new(0.0, 1.0, 0.0),
        1.0,
        2.0,
        0.1,
        10.0,
    )
    .unwrap();
    let ray = PickRay::from_viewport(camera.view_projection_matrix(), VIEWPORT, CENTER).unwrap();
    close(hit(&ray, &Mesh::unit_cube(), Mat4::IDENTITY).distance, 0.4);
    assert!(
        ray.intersect_mesh(&Mesh::unit_cube(), Mat4::IDENTITY, CullMode::Back)
            .unwrap()
            .is_none()
    );
}

#[test]
fn invalid_viewport_point_and_matrix_fail_closed_instead_of_clamping() {
    let vp = camera().view_projection_matrix();
    for viewport in [[0, 400], [800, 0], [0, 0]] {
        assert!(PickRay::from_viewport(vp, viewport, CENTER).is_err());
    }
    for pixel in [
        [f64::NAN, 0.0],
        [0.0, f64::INFINITY],
        [-1.0, 200.0],
        [801.0, 200.0],
        [400.0, -1.0],
        [400.0, 401.0],
    ] {
        assert!(
            PickRay::from_viewport(vp, VIEWPORT, pixel).is_err(),
            "{pixel:?}"
        );
    }
    // Continuous viewport coordinates include their exact outer edges.
    for pixel in [[0.0, 0.0], [800.0, 400.0]] {
        assert!(PickRay::from_viewport(vp, VIEWPORT, pixel).is_ok());
    }
    let mut nonfinite = vp;
    nonfinite.elements[4] = f32::NAN;
    let singular = Mat4::scale(Vec3::new(1.0, 0.0, 1.0));
    for matrix in [nonfinite, singular] {
        assert!(PickRay::from_viewport(matrix, VIEWPORT, CENTER).is_err());
    }
}

#[test]
fn invalid_model_transforms_fail_closed() {
    let ray = ray(CENTER);
    let mesh = Mesh::unit_cube();
    let mut nonfinite = Mat4::IDENTITY;
    nonfinite.elements[12] = f32::INFINITY;
    let mut projective = Mat4::IDENTITY;
    projective.elements[3] = 0.1;
    for model in [nonfinite, projective, Mat4::scale(Vec3::new(1.0, 0.0, 1.0))] {
        assert!(ray.intersect_mesh(&mesh, model, CullMode::None).is_err());
    }
}
