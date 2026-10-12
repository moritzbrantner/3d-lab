//! Independent current-public-path baseline, separate from proposed API compile RED.
use three_d_animation::Transform;
use three_d_export::{export_scene_glb, export_scene_glb_with_observations};
use three_d_formats::load_gltf;
use three_d_scene::{SceneMesh, SceneNode, SceneSnapshot};

#[test]
fn genuine_textured_source_is_already_validated_by_authoritative_loader() {
    let asset = load_gltf(include_bytes!("fixtures/textured.glb")).unwrap();
    assert_eq!(asset.meshes()[0].primitives().len(), 2);
    assert_eq!(asset.materials().len(), 2);
    assert_eq!(
        asset.images()[0].bytes(),
        include_bytes!("fixtures/checker.png")
    );
    assert_eq!(
        asset.materials()[0].base_color_texture().unwrap().texture(),
        0
    );
}

#[test]
fn geometry_only_legacy_export_retained_normalization_and_repeat_bytes() {
    let asset = load_gltf(include_bytes!("fixtures/geometry-only.glb")).unwrap();
    let scene = SceneSnapshot::new(
        vec![SceneMesh::new(
            "triangle",
            asset.meshes()[0].primitives()[0].mesh().clone(),
        )],
        vec![SceneNode::new(
            "instance",
            None,
            Some(0),
            Transform::IDENTITY,
        )],
    )
    .unwrap();
    let (bytes, facts) = export_scene_glb_with_observations(&scene).unwrap();
    assert_eq!(facts.normalization_pass_count, 1);
    let retained = scene.normalized().unwrap();
    let (again, facts) = export_scene_glb_with_observations(&retained).unwrap();
    assert_eq!(facts.normalization_pass_count, 0);
    assert_eq!(bytes, again);
    assert_eq!(again, export_scene_glb(&retained).unwrap());
}

#[test]
fn current_geometry_only_composition_cannot_preserve_imported_material_resources() {
    let asset = load_gltf(include_bytes!("fixtures/textured.glb")).unwrap();
    // This deliberately characterizes the only CURRENT public scene path, not
    // the intended future ownership adapter. Its test-only copy cannot be
    // accepted as a production resource-preserving composition implementation.
    let meshes = asset.meshes()[0]
        .primitives()
        .iter()
        .enumerate()
        .map(|(i, p)| SceneMesh::new(format!("primitive-{i}"), p.mesh().clone()))
        .collect();
    let nodes = (0..2)
        .map(|i| SceneNode::new(format!("node-{i}"), None, Some(i), Transform::IDENTITY))
        .collect();
    let scene = SceneSnapshot::new(meshes, nodes).unwrap();
    let bytes = export_scene_glb(&scene).unwrap();
    let exported = gltf::Gltf::from_slice(&bytes).unwrap();
    assert_eq!(
        exported.materials().count(),
        0,
        "characterize missing resource seam, not permission to lose supplied bindings in the new API"
    );
    assert_eq!(exported.images().count(), 0);
}
