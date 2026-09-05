use serde::Deserialize;
use three_d_animation::{Mat4, Quat};
use three_d_core::Vec3;

const MATRIX_EPSILON: f32 = 1.0e-5;

#[derive(Debug, Deserialize)]
struct RendererParityFixture {
    transform: TransformFixture,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TransformFixture {
    translation: [f32; 3],
    rotation_axis: [f32; 3],
    rotation_radians: f32,
    scale: [f32; 3],
    column_major_matrix: [f32; 16],
}

fn fixture() -> RendererParityFixture {
    serde_json::from_str(include_str!(
        "../../../fixtures/renderer-parity/cube-and-transform.json"
    ))
    .expect("renderer parity fixture must remain valid JSON")
}

fn vec3([x, y, z]: [f32; 3]) -> Vec3 {
    Vec3::new(x, y, z)
}

#[test]
fn trs_matrix_matches_renderer_parity_fixture() {
    let fixture = fixture().transform;
    let rotation = Quat::from_axis_angle(vec3(fixture.rotation_axis), fixture.rotation_radians)
        .expect("fixture rotation axis must be non-zero");
    let matrix = Mat4::trs(vec3(fixture.translation), rotation, vec3(fixture.scale));

    for (index, (actual, expected)) in matrix
        .elements
        .iter()
        .zip(fixture.column_major_matrix)
        .enumerate()
    {
        assert!(
            (*actual - expected).abs() <= MATRIX_EPSILON,
            "matrix element {index} differs: expected {expected}, got {actual}"
        );
    }
}
