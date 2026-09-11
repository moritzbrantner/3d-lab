use three_d_formats::load_gltf;

const KHRONOS_TRIANGLE: &[u8] =
    include_bytes!("../../../fixtures/catalog/khronos-triangle-embedded.gltf");

#[test]
fn canonical_khronos_triangle_decodes_into_asset_model() {
    assert_eq!(KHRONOS_TRIANGLE.len(), 1122, "pinned catalog fixture byte length drifted");

    let asset = load_gltf(KHRONOS_TRIANGLE).expect("pinned Khronos Triangle glTF loads");
    assert_eq!(asset.meshes().len(), 1);
    assert_eq!(asset.meshes()[0].primitives().len(), 1);

    let mesh = asset.meshes()[0].primitives()[0].mesh();
    assert_eq!(mesh.vertices().len(), 3);
    assert_eq!(mesh.indices(), &[0, 1, 2]);
}
