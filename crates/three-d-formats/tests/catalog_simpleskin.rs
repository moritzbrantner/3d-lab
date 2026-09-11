use three_d_formats::{FormatError, load_gltf};

const KHRONOS_SIMPLE_SKIN: &[u8] =
    include_bytes!("../../../fixtures/catalog/khronos-simpleskin-embedded.gltf");

#[test]
fn canonical_khronos_simple_skin_fails_closed_on_unrepresented_skinning_attributes() {
    assert_eq!(
        KHRONOS_SIMPLE_SKIN.len(),
        3566,
        "pinned catalog fixture byte length drifted"
    );

    let error = load_gltf(KHRONOS_SIMPLE_SKIN)
        .expect_err("skinning attributes must not be silently discarded");

    match error {
        FormatError::UnsupportedVertexAttribute {
            mesh_index,
            primitive_index,
            semantic,
        } => {
            assert_eq!(mesh_index, 0);
            assert_eq!(primitive_index, 0);
            assert!(
                semantic.starts_with("Joints") || semantic.starts_with("Weights"),
                "unexpected unsupported semantic: {semantic}"
            );
        }
        other => panic!("expected unsupported skinning attribute, got {other}"),
    }
}
