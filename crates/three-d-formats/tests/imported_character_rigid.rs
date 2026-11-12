//! Rigid, node-animated characters (#184): asset-tooling `zoo-animals` quadruped-rigid and
//! biped-rigid entries carry unskinned mesh parts on clip-targeted joint nodes.
use serde_json::{Value, json};
use three_d_animation::Transform;
use three_d_formats::load_gltf_imported_character;

const ZEBRA: (&[u8], &[u8]) = (
    include_bytes!("../../../fixtures/zoo-animals/scenes/zoo.animal.zebra/expressive.gltf"),
    include_bytes!(
        "../../../fixtures/zoo-animals/resources/7c21835a9f09a0306a2003ab335d065ed5647548e91f4ad725624174a2faf131.bin"
    ),
);
const PENGUIN: (&[u8], &[u8]) = (
    include_bytes!("../../../fixtures/zoo-animals/scenes/zoo.animal.penguin/expressive.gltf"),
    include_bytes!(
        "../../../fixtures/zoo-animals/resources/3927d94bfe50995a16a6b877d72f6719c520c0a72a9b1a5c3e3dccb46918f6f2.bin"
    ),
);

fn document((gltf, _): (&[u8], &[u8])) -> Value {
    serde_json::from_slice(gltf).unwrap()
}

/// Pack a bundle `.gltf` and its single external buffer into GLB bytes.
fn glb(mut json: Value, bin: &[u8]) -> Vec<u8> {
    json["buffers"][0].as_object_mut().unwrap().remove("uri");
    let mut text = serde_json::to_vec(&json).unwrap();
    while !text.len().is_multiple_of(4) {
        text.push(b' ');
    }
    let mut bin = bin.to_vec();
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }
    let total = 28 + text.len() + bin.len();
    let mut out = Vec::with_capacity(total);
    out.extend(0x4654_6c67u32.to_le_bytes());
    out.extend(2u32.to_le_bytes());
    out.extend((total as u32).to_le_bytes());
    out.extend((text.len() as u32).to_le_bytes());
    out.extend(0x4e4f_534au32.to_le_bytes());
    out.extend(&text);
    out.extend((bin.len() as u32).to_le_bytes());
    out.extend(0x004e_4942u32.to_le_bytes());
    out.extend(&bin);
    out
}

fn sample(asset: &three_d_formats::ImportedCharacter, clip: &str, time: f32) -> Vec<Transform> {
    let mut pose: Vec<_> = asset.nodes.iter().map(|n| n.local).collect();
    asset
        .rig
        .animations()
        .iter()
        .find(|c| c.name() == clip)
        .unwrap()
        .sample_resolved(time, &mut pose)
        .unwrap();
    pose
}

#[test]
fn rigid_zoo_animals_load_as_node_animated_characters() {
    for (fixture, mesh_parts) in [(ZEBRA, 16), (PENGUIN, 11)] {
        let asset = load_gltf_imported_character(&glb(document(fixture), fixture.1)).unwrap();
        assert!(asset.skin_nodes.is_empty() && asset.mesh_nodes.is_empty());
        assert!(asset.primitives.is_empty() && asset.rig.influences().is_empty());
        assert_eq!(asset.rigid_mesh_nodes.len(), mesh_parts);
        let clips: Vec<_> = asset.rig.animations().iter().map(|c| c.name()).collect();
        assert_eq!(clips, ["idle", "walk", "feed", "rest"]);
        assert!(asset.rig.animations().iter().all(|c| c.duration() > 0.0));
        // The Rust clip sampler moves the joint nodes that carry rigid parts.
        let leg = asset.node_names.iter().position(|n| n == "leg_0").unwrap();
        let a = sample(&asset, "walk", 0.0)[leg].matrix();
        let b = sample(&asset, "walk", 0.25)[leg].matrix();
        assert!(
            a.elements
                .iter()
                .zip(&b.elements)
                .any(|(x, y)| (x - y).abs() > 1e-4),
            "walk must move leg_0"
        );
    }
}

#[test]
fn rigid_meshes_without_an_animated_ancestor_remain_rejected() {
    let mut json = document(ZEBRA);
    json.as_object_mut().unwrap().remove("animations");
    let error = load_gltf_imported_character(&glb(json, ZEBRA.1))
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("rigid mesh node driven by an animated node"),
        "{error}"
    );

    // Clips that only animate a mesh-free sibling do not drive any rigid part.
    let mut json = document(ZEBRA);
    let nodes = json["nodes"].as_array_mut().unwrap();
    nodes.push(json!({"name": "marker"}));
    let marker = nodes.len() - 1;
    let scene = json["scene"].as_u64().unwrap_or(0) as usize;
    json["scenes"][scene]["nodes"]
        .as_array_mut()
        .unwrap()
        .push(json!(marker));
    for animation in json["animations"].as_array_mut().unwrap() {
        for channel in animation["channels"].as_array_mut().unwrap() {
            channel["target"]["node"] = json!(marker);
        }
    }
    let error = load_gltf_imported_character(&glb(json, ZEBRA.1))
        .unwrap_err()
        .to_string();
    assert!(error.contains("rigid mesh node driven"), "{error}");
}

#[test]
fn rigid_mesh_geometry_is_validated() {
    let mut json = document(PENGUIN);
    // Shrinking POSITION leaves the part's existing indices out of range.
    let position = json["meshes"][0]["primitives"][0]["attributes"]["POSITION"]
        .as_u64()
        .unwrap() as usize;
    json["accessors"][position]["count"] = json!(1);
    let error = load_gltf_imported_character(&glb(json, PENGUIN.1))
        .unwrap_err()
        .to_string();
    assert!(error.contains("rigid mesh index out of range"), "{error}");
}
