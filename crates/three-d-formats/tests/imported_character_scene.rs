//! Imported hierarchy composition uses the same canonical Rust pose/rig models.
use three_d_animation::{TransformNode, world_matrices};
use three_d_formats::load_gltf_imported_character;

#[test]
fn full_source_scene_preserves_authored_palette_and_all_world_pose_evidence() {
    let asset = load_gltf_imported_character(include_bytes!(
        "../../../fixtures/imported-character/fox.glb"
    ))
    .unwrap();
    assert_eq!(asset.nodes.len(), 26);
    assert_eq!(asset.skin_nodes.len(), 24);
    assert_eq!(asset.rig.skeleton().joints().len(), 26);
    assert_eq!(asset.primitive_indices[0].len(), 1728);
    let oracle: serde_json::Value = serde_json::from_str(include_str!(
        "../../../fixtures/imported-character/fox.pose-oracle.json"
    ))
    .unwrap();
    for sample in oracle["samples"].as_array().unwrap() {
        let clip = asset
            .rig
            .animations()
            .iter()
            .find(|c| c.name() == sample["clip"].as_str().unwrap())
            .unwrap();
        let mut pose = asset.nodes.iter().map(|n| n.local).collect::<Vec<_>>();
        clip.sample_resolved(sample["time"].as_f64().unwrap() as f32, &mut pose)
            .unwrap();
        let nodes = asset
            .nodes
            .iter()
            .zip(pose)
            .map(|(n, local)| TransformNode {
                parent: n.parent,
                local,
            })
            .collect::<Vec<_>>();
        let worlds = world_matrices(&nodes).unwrap();
        for joint in sample["joints"].as_array().unwrap() {
            let index = asset
                .node_names
                .iter()
                .position(|n| n == joint["name"].as_str().unwrap())
                .unwrap();
            for (a, b) in worlds[index]
                .elements
                .iter()
                .zip(joint["matrixWorld"].as_array().unwrap())
            {
                assert!((f64::from(*a) - b.as_f64().unwrap()).abs() < 0.002);
            }
        }
    }
}
