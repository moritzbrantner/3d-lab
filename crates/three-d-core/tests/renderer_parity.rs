use serde::Deserialize;
use three_d_core::Mesh;

#[derive(Debug, Deserialize)]
struct RendererParityFixture {
    mesh: MeshFixture,
}

#[derive(Debug, Deserialize)]
struct MeshFixture {
    positions: Vec<[f32; 3]>,
    indices: Vec<u32>,
}

fn fixture() -> RendererParityFixture {
    serde_json::from_str(include_str!(
        "../../../fixtures/renderer-parity/cube-and-transform.json"
    ))
    .expect("renderer parity fixture must remain valid JSON")
}

#[test]
fn unit_cube_matches_renderer_parity_fixture() {
    let fixture = fixture();
    let mesh = Mesh::unit_cube();
    let positions = mesh
        .vertices()
        .iter()
        .map(|position| [position.x, position.y, position.z])
        .collect::<Vec<_>>();

    assert_eq!(positions, fixture.mesh.positions);
    assert_eq!(mesh.indices(), fixture.mesh.indices);
}
