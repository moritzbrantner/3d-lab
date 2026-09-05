use serde::Deserialize;
use three_d_camera::PerspectiveCamera;
use three_d_core::Vec3;

const MATRIX_EPSILON: f32 = 1.0e-5;

#[derive(Debug, Deserialize)]
struct RendererParityFixture {
    camera: CameraFixture,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CameraFixture {
    eye: [f32; 3],
    target: [f32; 3],
    up: [f32; 3],
    fov_y_radians: f32,
    aspect: f32,
    near: f32,
    far: f32,
    view_matrix: [f32; 16],
    webgpu_projection_matrix: [f32; 16],
}

fn vec3([x, y, z]: [f32; 3]) -> Vec3 {
    Vec3::new(x, y, z)
}

fn assert_matrix_close(actual: [f32; 16], expected: [f32; 16]) {
    for (index, (actual, expected)) in actual.into_iter().zip(expected).enumerate() {
        assert!(
            (actual - expected).abs() <= MATRIX_EPSILON,
            "matrix element {index} differs: expected {expected}, got {actual}"
        );
    }
}

#[test]
fn camera_matrices_match_renderer_parity_fixture() {
    let fixture: RendererParityFixture = serde_json::from_str(include_str!(
        "../../../fixtures/renderer-parity/cube-and-transform.json"
    ))
    .expect("renderer parity fixture must remain valid JSON");
    let fixture = fixture.camera;
    let camera = PerspectiveCamera::new(
        vec3(fixture.eye),
        vec3(fixture.target),
        vec3(fixture.up),
        fixture.fov_y_radians,
        fixture.aspect,
        fixture.near,
        fixture.far,
    )
    .expect("fixture camera must remain valid");

    assert_matrix_close(camera.view_matrix().elements, fixture.view_matrix);
    assert_matrix_close(
        camera.projection_matrix().elements,
        fixture.webgpu_projection_matrix,
    );
}
