use three_d_animation::Transform;
use three_d_formats::{FormatError, load_gltf, load_gltf_animation_clips};

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

#[test]
fn canonical_khronos_simple_skin_animation_maps_to_animation_core() {
    let clips = load_gltf_animation_clips(KHRONOS_SIMPLE_SKIN)
        .expect("canonical SimpleSkin animation should map into three-d-animation");
    assert_eq!(clips.len(), 1);
    let clip = &clips[0];
    assert_eq!(clip.name(), "animation_0");
    assert!((clip.duration() - 5.5).abs() < 1.0e-6);
    assert_eq!(clip.tracks().len(), 1);

    // SimpleSkin targets glTF node 2. Sampling must update that pre-resolved
    // node directly without a runtime name lookup or renderer dependency.
    let mut pose = vec![Transform::IDENTITY; 3];
    clip.sample(0.0, &mut pose).unwrap();
    let start = pose[2].rotation;
    clip.sample(2.75, &mut pose).unwrap();
    let middle = pose[2].rotation;
    assert!((middle.length() - 1.0).abs() < 1.0e-5);
    assert_ne!(middle, start);

    clip.sample(5.5, &mut pose).unwrap();
    assert!((pose[2].rotation.length() - 1.0).abs() < 1.0e-5);
}
