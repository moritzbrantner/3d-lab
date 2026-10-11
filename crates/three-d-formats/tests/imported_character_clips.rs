//! Independent native animation proof for the actual production-imported Fox.
//! This is clip authority evidence, not scene/skin composition or native rendering.
use three_d_animation::{Quat, Transform};
use three_d_core::Vec3;
use three_d_formats::load_gltf_animation_clips;

const GLB: &[u8] = include_bytes!("../../../fixtures/imported-character/fox.glb");
const ORACLE: &str = include_str!("../../../fixtures/imported-character/fox.pose-oracle.json");
const PROVENANCE: &str =
    include_str!("../../../fixtures/imported-character/fox.production-import.json");

fn vec3(value: &serde_json::Value) -> Vec3 {
    Vec3::new(
        value[0].as_f64().unwrap() as f32,
        value[1].as_f64().unwrap() as f32,
        value[2].as_f64().unwrap() as f32,
    )
}

fn transform(value: &serde_json::Value) -> Transform {
    let rotation = &value["rotation"];
    Transform {
        translation: vec3(&value["translation"]),
        rotation: Quat::new(
            rotation[0].as_f64().unwrap() as f32,
            rotation[1].as_f64().unwrap() as f32,
            rotation[2].as_f64().unwrap() as f32,
            rotation[3].as_f64().unwrap() as f32,
        ),
        scale: vec3(&value["scale"]),
    }
}

#[test]
fn actual_production_import_retains_three_named_clips_and_native_seek_matches_independent_browser()
{
    let clips = load_gltf_animation_clips(GLB).unwrap();
    assert_eq!(
        clips.iter().map(|clip| clip.name()).collect::<Vec<_>>(),
        ["Survey", "Walk", "Run"]
    );
    let oracle: serde_json::Value = serde_json::from_str(ORACLE).unwrap();
    let provenance: serde_json::Value = serde_json::from_str(PROVENANCE).unwrap();
    let nodes = provenance["result"]["observations"]["nodes"]
        .as_array()
        .unwrap();
    assert_eq!(nodes.len(), 26);
    assert_eq!(provenance["result"]["observations"]["skinCount"], 1);
    assert_eq!(
        provenance["result"]["observations"]["skins"][0]["joints"]
            .as_array()
            .unwrap()
            .len(),
        24
    );
    let samples = oracle["samples"].as_array().unwrap();
    assert_eq!(samples.len(), 15);
    // Original glTF node indices are the existing format clip target contract.
    // They are deliberately not silently equated with the 24 skin palette slots.
    let mut base = vec![Transform::IDENTITY; nodes.len()];
    for joint in samples[0]["joints"].as_array().unwrap() {
        let index = nodes
            .iter()
            .position(|node| node["name"] == joint["name"])
            .unwrap();
        base[index] = transform(joint);
    }
    for sample in samples {
        let clip = clips
            .iter()
            .find(|clip| clip.name() == sample["clip"].as_str().unwrap())
            .unwrap();
        let time = sample["time"].as_f64().unwrap() as f32;
        let mut pose = base.clone();
        clip.sample_resolved(time, &mut pose).unwrap();
        let mut replay = base.clone();
        clip.sample_resolved(time, &mut replay).unwrap();
        assert_eq!(pose, replay, "identical native seek must replay exactly");
        for joint in sample["joints"].as_array().unwrap() {
            let index = nodes
                .iter()
                .position(|node| node["name"] == joint["name"])
                .unwrap();
            let expected = transform(joint).matrix();
            let actual = pose[index].matrix();
            for (a, b) in actual.elements.iter().zip(expected.elements.iter()) {
                assert!(
                    (a - b).abs() < 2e-5,
                    "{} t={time} joint={} local matrix differs: {a} vs {b}",
                    clip.name(),
                    joint["name"]
                );
            }
        }
        let before = pose.clone();
        assert!(clip.sample_resolved(f32::NAN, &mut pose).is_err());
        assert_eq!(pose, before, "invalid seek must leave pose unchanged");
    }
}
