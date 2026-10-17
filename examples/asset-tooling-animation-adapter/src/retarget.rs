//! `animation.retarget`: a thin adapter over `three_d_animation::retarget::retarget_pose`.
//!
//! The adapter only decodes rigs, samples source channels with the existing
//! `KeyframeTrack` semantics, calls `retarget_pose` per sample time and encodes the
//! target channels. It owns no retargeting solver.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use three_d_animation::retarget::{HumanoidBinding, HumanoidBone, HumanoidRig, retarget_pose};
use three_d_animation::{Quat, Transform};
use three_d_core::Vec3;

use super::{
    ANIMATION_SCHEMA_VERSION, AnimationDocument, ChannelDocument, QuatKeyframeDocument,
    Vec3KeyframeDocument, assert_finite, quat_track, vec3_track,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RigNodeDocument {
    parent: Option<usize>,
    translation: [f32; 3],
    rotation: [f32; 4],
    scale: [f32; 3],
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RigDocument {
    nodes: Vec<RigNodeDocument>,
    bindings: BTreeMap<String, usize>,
    reference_height: f32,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum RootMotion {
    Keep,
    InPlace,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RetargetParameters {
    source: RigDocument,
    target: RigDocument,
    sample_times_seconds: Vec<f32>,
    root_motion: RootMotion,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RetargetObservations {
    source_keyframe_count: usize,
    sample_count: usize,
    mapped_bone_count: usize,
    result_channel_count: usize,
    result_keyframe_count: usize,
    root_motion: RootMotion,
}

struct DecodedRig {
    rig: HumanoidRig,
    parents: Vec<Option<usize>>,
}

fn vec3(value: [f32; 3]) -> Vec3 {
    Vec3::new(value[0], value[1], value[2])
}

fn decode_rig(document: &RigDocument, role: &str) -> Result<DecodedRig, String> {
    let node_count = document.nodes.len();
    let mut parents = Vec::with_capacity(node_count);
    let mut rest_pose = Vec::with_capacity(node_count);
    for (index, node) in document.nodes.iter().enumerate() {
        let location = format!("parameters.{role}.nodes[{index}]");
        for (component, value) in node
            .translation
            .iter()
            .chain(&node.rotation)
            .chain(&node.scale)
            .enumerate()
        {
            assert_finite(*value, &format!("{location} component {component}"))?;
        }
        if let Some(parent) = node.parent
            && (parent >= node_count || parent == index)
        {
            return Err(format!(
                "{location}.parent {parent} is not a valid node index"
            ));
        }
        parents.push(node.parent);
        let [x, y, z, w] = node.rotation;
        rest_pose.push(Transform {
            translation: vec3(node.translation),
            rotation: Quat::new(x, y, z, w),
            scale: vec3(node.scale),
        });
    }
    for start in 0..node_count {
        let mut current = parents[start];
        for _ in 0..node_count {
            match current {
                Some(parent) => current = parents[parent],
                None => break,
            }
        }
        if current.is_some() {
            return Err(format!(
                "parameters.{role}.nodes contain a parent cycle through node {start}"
            ));
        }
    }

    let mut bindings = Vec::with_capacity(document.bindings.len());
    for (id, node) in &document.bindings {
        let bone = HumanoidBone::from_id(id).ok_or_else(|| {
            format!("parameters.{role}.bindings has unknown humanoid bone '{id}'")
        })?;
        bindings.push(HumanoidBinding { bone, node: *node });
    }
    let rig = HumanoidRig::new(rest_pose, &bindings, document.reference_height)
        .map_err(|error| format!("{role} rig: {error}"))?;
    Ok(DecodedRig { rig, parents })
}

fn validate_sample_times(times: &[f32]) -> Result<(), String> {
    if times.is_empty() {
        return Err("parameters.sampleTimesSeconds must be non-empty".into());
    }
    for (index, time) in times.iter().enumerate() {
        assert_finite(*time, &format!("parameters.sampleTimesSeconds[{index}]"))?;
        if *time < 0.0 {
            return Err(format!(
                "parameters.sampleTimesSeconds[{index}] must be non-negative"
            ));
        }
        if index > 0 && *time <= times[index - 1] {
            return Err("parameters.sampleTimesSeconds must be strictly increasing".into());
        }
    }
    Ok(())
}

#[cfg(test)]
fn quat_mul(left: Quat, right: Quat) -> Quat {
    Quat::new(
        left.w * right.x + left.x * right.w + left.y * right.z - left.z * right.y,
        left.w * right.y - left.x * right.z + left.y * right.w + left.z * right.x,
        left.w * right.z + left.x * right.y - left.y * right.x + left.z * right.w,
        left.w * right.w - left.x * right.x - left.y * right.y - left.z * right.z,
    )
}

fn rotate(rotation: Quat, value: Vec3) -> Vec3 {
    let axis = Vec3::new(rotation.x, rotation.y, rotation.z);
    let twice = axis.cross(value) * 2.0;
    value + twice * rotation.w + axis.cross(twice)
}

/// Vertical projection of `node`'s local translation deltas through the static rest
/// chain of its ancestors, whose model-space linear part is `M = L_0 * ... * L_k`
/// (`L_i = R_i * S_i`, root-most first). A local delta `d` has model-space height
/// `e_y . (M d) = (M^T e_y) . d`, and a model-space vertical offset `h` maps back to
/// `M^-1 e_y * h`. Returns `(M^-1 e_y, M^T e_y)`; both are `e_y` for an unrotated,
/// unscaled chain.
fn parent_space_vertical(rig: &DecodedRig, node: usize) -> (Vec3, Vec3) {
    let rest = rig.rig.rest_pose();
    let mut ancestors = Vec::new();
    let mut current = rig.parents[node];
    while let Some(parent) = current {
        ancestors.push(parent);
        current = rig.parents[parent];
    }
    let mut inverse_up = Vec3::new(0.0, 1.0, 0.0);
    let mut height_row = Vec3::new(0.0, 1.0, 0.0);
    for ancestor in ancestors.into_iter().rev() {
        let transform = rest[ancestor];
        let rotation = transform.rotation.normalized().unwrap_or(Quat::IDENTITY);
        let inverse_rotation = Quat::new(-rotation.x, -rotation.y, -rotation.z, rotation.w);
        let scale = transform.scale;
        let unrotated = rotate(inverse_rotation, inverse_up);
        inverse_up = Vec3::new(
            unrotated.x / scale.x,
            unrotated.y / scale.y,
            unrotated.z / scale.z,
        );
        let unrotated = rotate(inverse_rotation, height_row);
        height_row = Vec3::new(
            unrotated.x * scale.x,
            unrotated.y * scale.y,
            unrotated.z * scale.z,
        );
    }
    (inverse_up, height_row)
}

enum SourceTrack {
    Translation(three_d_animation::KeyframeTrack<Vec3>),
    Rotation(three_d_animation::KeyframeTrack<Quat>),
    Scale(three_d_animation::KeyframeTrack<Vec3>),
}

pub(crate) fn retarget_document(
    document: &AnimationDocument,
    parameters: &RetargetParameters,
) -> Result<(AnimationDocument, RetargetObservations), String> {
    validate_sample_times(&parameters.sample_times_seconds)?;
    let source = decode_rig(&parameters.source, "source")?;
    let target = decode_rig(&parameters.target, "target")?;
    let source_node_count = source.rig.rest_pose().len();

    let mut tracks = Vec::with_capacity(document.channels.len());
    let mut source_scaled = vec![false; source_node_count];
    for (index, channel) in document.channels.iter().enumerate() {
        let (node, track) = match channel {
            ChannelDocument::Translation { node, keyframes } => {
                (*node, SourceTrack::Translation(vec3_track(keyframes)?))
            }
            ChannelDocument::Rotation { node, keyframes } => {
                (*node, SourceTrack::Rotation(quat_track(keyframes)?))
            }
            ChannelDocument::Scale { node, keyframes } => {
                (*node, SourceTrack::Scale(vec3_track(keyframes)?))
            }
        };
        if node >= source_node_count {
            return Err(format!(
                "channels[{index}].node {node} is outside the source rig ({source_node_count} nodes)"
            ));
        }
        if matches!(track, SourceTrack::Scale(_)) {
            source_scaled[node] = true;
        }
        tracks.push((node, track));
    }

    // Target nodes that receive channels, ordered by target node index.
    let mut mapped: Vec<(usize, HumanoidBone, usize)> = HumanoidBone::ALL
        .into_iter()
        .filter_map(|bone| Some((target.rig.node(bone)?, bone, source.rig.node(bone)?)))
        .collect();
    mapped.sort_by_key(|(target_node, ..)| *target_node);

    let sample_count = parameters.sample_times_seconds.len();
    let mut source_pose = source.rig.rest_pose().to_vec();
    let mut target_pose = target.rig.rest_pose().to_vec();
    let mut samples: Vec<Vec<Transform>> = vec![Vec::with_capacity(sample_count); mapped.len()];
    for time in &parameters.sample_times_seconds {
        source_pose.copy_from_slice(source.rig.rest_pose());
        for (node, track) in &tracks {
            match track {
                SourceTrack::Translation(track) => {
                    source_pose[*node].translation = track.sample(*time)
                }
                SourceTrack::Rotation(track) => source_pose[*node].rotation = track.sample(*time),
                SourceTrack::Scale(track) => source_pose[*node].scale = track.sample(*time),
            }
        }
        retarget_pose(&source.rig, &source_pose, &target.rig, &mut target_pose)
            .map_err(|error| format!("retarget at {time}s: {error}"))?;
        for (slot, (target_node, ..)) in samples.iter_mut().zip(&mapped) {
            slot.push(target_pose[*target_node]);
        }
    }

    let times = &parameters.sample_times_seconds;
    let mut channels = Vec::new();
    for ((target_node, bone, source_node), values) in mapped.iter().zip(&samples) {
        if matches!(bone, HumanoidBone::Hips | HumanoidBone::Root) {
            let rest = target.rig.rest_pose()[*target_node].translation;
            let (inverse_up, height_row) = parent_space_vertical(&target, *target_node);
            channels.push(ChannelDocument::Translation {
                node: *target_node,
                keyframes: times
                    .iter()
                    .zip(values)
                    .map(|(time, value)| {
                        let translation = match parameters.root_motion {
                            RootMotion::Keep => value.translation,
                            RootMotion::InPlace => {
                                rest + inverse_up * (value.translation - rest).dot(height_row)
                            }
                        };
                        Vec3KeyframeDocument {
                            time: *time,
                            value: [translation.x, translation.y, translation.z],
                        }
                    })
                    .collect(),
            });
        }
        channels.push(ChannelDocument::Rotation {
            node: *target_node,
            keyframes: times
                .iter()
                .zip(values)
                .map(|(time, value)| {
                    let rotation = value.rotation.normalized().unwrap_or(Quat::IDENTITY);
                    QuatKeyframeDocument {
                        time: *time,
                        value: [rotation.x, rotation.y, rotation.z, rotation.w],
                    }
                })
                .collect(),
        });
        if source_scaled[*source_node] {
            channels.push(ChannelDocument::Scale {
                node: *target_node,
                keyframes: times
                    .iter()
                    .zip(values)
                    .map(|(time, value)| Vec3KeyframeDocument {
                        time: *time,
                        value: [value.scale.x, value.scale.y, value.scale.z],
                    })
                    .collect(),
            });
        }
    }

    let source_keyframe_count = document
        .channels
        .iter()
        .map(ChannelDocument::keyframe_count)
        .sum();
    let result_channel_count = channels.len();
    let output = AnimationDocument {
        schema_version: ANIMATION_SCHEMA_VERSION,
        channels,
    };
    super::validate_document(&output)?;
    Ok((
        output,
        RetargetObservations {
            source_keyframe_count,
            sample_count,
            mapped_bone_count: mapped.len(),
            result_channel_count,
            result_keyframe_count: result_channel_count * sample_count,
            root_motion: parameters.root_motion,
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AdapterOperation, Request, parse_request, probe_json, validate_document};
    use core::f32::consts::FRAC_PI_2;

    const SOURCE_FINGER: usize = 12;
    const TARGET_HIPS: usize = 1;
    const TARGET_CHEST: usize = 7;
    const TARGET_LEFT_UPPER_ARM: usize = 9;
    const TARGET_LEFT_HAND: usize = 11;
    const TARGET_FINGER: usize = 12;

    fn z_up_root() -> Quat {
        Quat::from_axis_angle(Vec3::new(1.0, 0.0, 0.0), -FRAC_PI_2).unwrap()
    }

    fn quat_array(value: Quat) -> [f32; 4] {
        [value.x, value.y, value.z, value.w]
    }

    fn node(parent: Option<usize>, translation: [f32; 3], rotation: Quat) -> RigNodeDocument {
        RigNodeDocument {
            parent,
            translation,
            rotation: quat_array(rotation),
            scale: [1.0, 1.0, 1.0],
        }
    }

    fn bindings(entries: &[(&str, usize)]) -> BTreeMap<String, usize> {
        entries
            .iter()
            .map(|(bone, node)| ((*bone).to_owned(), *node))
            .collect()
    }

    /// Blender-style Z-up armature (root -90 deg about X), 1.0 hip height, plus an unmapped finger.
    fn source_rig() -> RigDocument {
        let id = Quat::IDENTITY;
        RigDocument {
            nodes: vec![
                node(None, [0.0, 0.0, 0.0], z_up_root()),
                node(Some(0), [0.0, 0.0, 1.0], id),
                node(Some(1), [0.0, 0.0, 0.2], id),
                node(Some(2), [0.0, 0.0, 0.5], id),
                node(
                    Some(2),
                    [0.2, 0.0, 0.4],
                    Quat::from_euler_xyz(0.0, 0.0, 0.3),
                ),
                node(Some(4), [0.25, 0.0, 0.0], id),
                node(Some(2), [-0.2, 0.0, 0.4], id),
                node(Some(6), [-0.25, 0.0, 0.0], id),
                node(Some(1), [0.1, 0.0, -0.1], id),
                node(Some(8), [0.0, 0.0, -0.45], id),
                node(Some(1), [-0.1, 0.0, -0.1], id),
                node(Some(10), [0.0, 0.0, -0.45], id),
                node(Some(5), [0.05, 0.0, 0.0], id),
            ],
            bindings: bindings(&[
                ("root", 0),
                ("hips", 1),
                ("spine", 2),
                ("head", 3),
                ("left-upper-arm", 4),
                ("left-lower-arm", 5),
                ("right-upper-arm", 6),
                ("right-lower-arm", 7),
                ("left-upper-leg", 8),
                ("left-lower-leg", 9),
                ("right-upper-leg", 10),
                ("right-lower-leg", 11),
            ]),
            reference_height: 1.8,
        }
    }

    /// Different node order, 1.5 hip height, different arm rest rotation, target-only
    /// chest/left-hand semantics and an unmapped finger.
    fn target_rig() -> RigDocument {
        let id = Quat::IDENTITY;
        RigDocument {
            nodes: vec![
                node(None, [0.0, 0.0, 0.0], z_up_root()),
                node(Some(0), [0.0, 0.0, 1.5], id),
                node(Some(1), [0.15, 0.0, -0.1], id),
                node(Some(2), [0.0, 0.0, -0.7], id),
                node(Some(1), [-0.15, 0.0, -0.1], id),
                node(Some(4), [0.0, 0.0, -0.7], id),
                node(Some(1), [0.0, 0.0, 0.25], id),
                node(Some(6), [0.0, 0.0, 0.3], id),
                node(Some(7), [0.0, 0.0, 0.4], id),
                node(
                    Some(7),
                    [0.3, 0.0, 0.2],
                    Quat::from_euler_xyz(0.0, 0.0, -0.5),
                ),
                node(Some(9), [0.35, 0.0, 0.0], id),
                node(Some(10), [0.3, 0.0, 0.0], id),
                node(Some(11), [0.08, 0.0, 0.0], id),
                node(Some(7), [-0.3, 0.0, 0.2], id),
                node(Some(13), [-0.35, 0.0, 0.0], id),
            ],
            bindings: bindings(&[
                ("root", 0),
                ("hips", TARGET_HIPS),
                ("left-upper-leg", 2),
                ("left-lower-leg", 3),
                ("right-upper-leg", 4),
                ("right-lower-leg", 5),
                ("spine", 6),
                ("chest", TARGET_CHEST),
                ("head", 8),
                ("left-upper-arm", TARGET_LEFT_UPPER_ARM),
                ("left-lower-arm", 10),
                ("left-hand", TARGET_LEFT_HAND),
                ("right-upper-arm", 13),
                ("right-lower-arm", 14),
            ]),
            reference_height: 2.7,
        }
    }

    fn arm_delta() -> Quat {
        Quat::from_euler_xyz(0.0, 0.0, 0.6)
    }

    fn source_animation() -> AnimationDocument {
        let arm_rest = Quat::from_euler_xyz(0.0, 0.0, 0.3);
        let vec3_keys = |keys: &[(f32, [f32; 3])]| {
            keys.iter()
                .map(|(time, value)| Vec3KeyframeDocument {
                    time: *time,
                    value: *value,
                })
                .collect()
        };
        let quat_keys = |keys: &[(f32, Quat)]| {
            keys.iter()
                .map(|(time, value)| QuatKeyframeDocument {
                    time: *time,
                    value: quat_array(*value),
                })
                .collect()
        };
        let document = AnimationDocument {
            schema_version: 1,
            channels: vec![
                ChannelDocument::Translation {
                    node: 1,
                    keyframes: vec3_keys(&[
                        (0.0, [0.0, 0.0, 1.0]),
                        (0.5, [0.2, -0.3, 1.05]),
                        (1.0, [0.4, -0.6, 1.0]),
                    ]),
                },
                ChannelDocument::Rotation {
                    node: 4,
                    keyframes: quat_keys(&[
                        (0.0, arm_rest),
                        (1.0, quat_mul(arm_rest, arm_delta()).normalized().unwrap()),
                    ]),
                },
                ChannelDocument::Rotation {
                    node: SOURCE_FINGER,
                    keyframes: quat_keys(&[
                        (0.0, Quat::IDENTITY),
                        (1.0, Quat::from_euler_xyz(0.0, 0.4, 0.0)),
                    ]),
                },
            ],
        };
        validate_document(&document).unwrap();
        document
    }

    fn parameters(root_motion: RootMotion) -> RetargetParameters {
        RetargetParameters {
            source: source_rig(),
            target: target_rig(),
            sample_times_seconds: vec![0.0, 0.5, 1.0],
            root_motion,
        }
    }

    fn retarget(root_motion: RootMotion) -> AnimationDocument {
        retarget_document(&source_animation(), &parameters(root_motion))
            .unwrap()
            .0
    }

    fn translation_keys(document: &AnimationDocument, target: usize) -> Vec<Vec3> {
        document
            .channels
            .iter()
            .find_map(|channel| match channel {
                ChannelDocument::Translation { node, keyframes } if *node == target => Some(
                    keyframes
                        .iter()
                        .map(|keyframe| vec3(keyframe.value))
                        .collect(),
                ),
                _ => None,
            })
            .expect("translation channel")
    }

    fn assert_close(actual: Vec3, expected: Vec3) {
        assert!(
            (actual - expected).length() < 1.0e-5,
            "{actual:?} != {expected:?}"
        );
    }

    #[test]
    fn missing_required_target_bone_fails_with_retarget_error() {
        let mut parameters = parameters(RootMotion::Keep);
        parameters.target.bindings.remove("head");
        let error = retarget_document(&source_animation(), &parameters).unwrap_err();
        assert_eq!(
            error,
            "target rig: required humanoid bone Head is not mapped"
        );
    }

    #[test]
    fn invalid_rigs_times_and_channels_fail_visibly() {
        let source = source_animation();
        let mut bad_binding = parameters(RootMotion::Keep);
        bad_binding.source.bindings.insert("left-hand".into(), 99);
        assert!(
            retarget_document(&source, &bad_binding)
                .unwrap_err()
                .contains("LeftHand maps to node 99")
        );

        let mut unknown_bone = parameters(RootMotion::Keep);
        unknown_bone.target.bindings.insert("tail".into(), 12);
        assert!(
            retarget_document(&source, &unknown_bone)
                .unwrap_err()
                .contains("unknown humanoid bone 'tail'")
        );

        let mut cycle = parameters(RootMotion::Keep);
        cycle.target.nodes[0].parent = Some(1);
        assert!(
            retarget_document(&source, &cycle)
                .unwrap_err()
                .contains("parent cycle")
        );

        let mut non_finite = parameters(RootMotion::Keep);
        non_finite.source.nodes[3].translation[1] = f32::NAN;
        assert!(
            retarget_document(&source, &non_finite)
                .unwrap_err()
                .contains("must be finite")
        );

        for times in [vec![], vec![0.5, 0.5], vec![1.0, 0.0]] {
            let mut bad_times = parameters(RootMotion::Keep);
            bad_times.sample_times_seconds = times;
            assert!(
                retarget_document(&source, &bad_times)
                    .unwrap_err()
                    .contains("sampleTimesSeconds")
            );
        }

        let mut outside = source.clone();
        if let ChannelDocument::Rotation { node, .. } = &mut outside.channels[2] {
            *node = 40;
        }
        assert!(
            retarget_document(&outside, &parameters(RootMotion::Keep))
                .unwrap_err()
                .contains("outside the source rig")
        );
    }

    #[test]
    fn mapped_rotation_delta_transfers_across_different_arm_rests() {
        let output = retarget(RootMotion::Keep);
        let keys = output
            .channels
            .iter()
            .find_map(|channel| match channel {
                ChannelDocument::Rotation { node, keyframes } if *node == TARGET_LEFT_UPPER_ARM => {
                    Some(keyframes.clone())
                }
                _ => None,
            })
            .unwrap();
        let target_rest = Quat::from_euler_xyz(0.0, 0.0, -0.5);
        let [x, y, z, w] = keys[2].value;
        let expected = quat_mul(target_rest, arm_delta()).normalized().unwrap();
        assert!((Quat::new(x, y, z, w).dot(expected).abs() - 1.0).abs() < 1.0e-5);
        let [x, y, z, w] = keys[0].value;
        assert!((Quat::new(x, y, z, w).dot(target_rest).abs() - 1.0).abs() < 1.0e-5);
    }

    #[test]
    fn only_semantics_mapped_in_both_rigs_receive_channels() {
        let output = retarget(RootMotion::Keep);
        let mut rotations = Vec::new();
        let mut translations = Vec::new();
        for channel in &output.channels {
            match channel {
                ChannelDocument::Rotation { node, keyframes } => {
                    assert_eq!(keyframes.len(), 3);
                    rotations.push(*node);
                }
                ChannelDocument::Translation { node, .. } => translations.push(*node),
                ChannelDocument::Scale { .. } => panic!("source animates no scale"),
            }
        }
        assert_eq!(rotations, vec![0, 1, 2, 3, 4, 5, 6, 8, 9, 10, 13, 14]);
        assert_eq!(translations, vec![0, TARGET_HIPS]);
        for unmapped in [TARGET_CHEST, TARGET_LEFT_HAND, TARGET_FINGER] {
            assert!(!rotations.contains(&unmapped));
        }
    }

    #[test]
    fn scale_channels_follow_source_scale_animation_on_mapped_nodes() {
        let mut source = source_animation();
        source.channels.push(ChannelDocument::Scale {
            node: 4,
            keyframes: vec![
                Vec3KeyframeDocument {
                    time: 0.0,
                    value: [1.0, 1.0, 1.0],
                },
                Vec3KeyframeDocument {
                    time: 1.0,
                    value: [2.0, 1.0, 1.0],
                },
            ],
        });
        let (output, _) = retarget_document(&source, &parameters(RootMotion::Keep)).unwrap();
        let scales: Vec<_> = output
            .channels
            .iter()
            .filter_map(|channel| match channel {
                ChannelDocument::Scale { node, keyframes } => Some((*node, keyframes[1].value)),
                _ => None,
            })
            .collect();
        assert_eq!(scales, vec![(TARGET_LEFT_UPPER_ARM, [1.5, 1.0, 1.0])]);
    }

    #[test]
    fn hips_translation_is_scaled_by_reference_height_ratio() {
        let hips = translation_keys(&retarget(RootMotion::Keep), TARGET_HIPS);
        assert_close(hips[0], Vec3::new(0.0, 0.0, 1.5));
        assert_close(hips[1], Vec3::new(0.3, -0.45, 1.575));
        assert_close(hips[2], Vec3::new(0.6, -0.9, 1.5));
    }

    #[test]
    fn in_place_removes_model_space_horizontal_drift_and_keeps_bob() {
        let root = z_up_root();
        let rest_model = rotate(root, Vec3::new(0.0, 0.0, 1.5));
        let kept = translation_keys(&retarget(RootMotion::Keep), TARGET_HIPS);
        let in_place_output = retarget(RootMotion::InPlace);
        let in_place = translation_keys(&in_place_output, TARGET_HIPS);

        let drift = rotate(root, kept[2]) - rest_model;
        assert!(drift.x.abs() > 0.5 && drift.z.abs() > 0.5, "{drift:?}");

        for (index, key) in in_place.iter().enumerate() {
            let model = rotate(root, *key);
            let kept_model = rotate(root, kept[index]);
            assert!((model.x - rest_model.x).abs() < 1.0e-5, "{model:?}");
            assert!((model.z - rest_model.z).abs() < 1.0e-5, "{model:?}");
            assert!((model.y - kept_model.y).abs() < 1.0e-5, "{model:?}");
        }
        assert!((rotate(root, in_place[1]).y - rest_model.y - 0.075).abs() < 1.0e-5);

        for key in translation_keys(&in_place_output, 0) {
            assert_close(key, Vec3::ZERO);
        }
    }

    #[test]
    fn in_place_projects_through_non_uniform_ancestor_scale() {
        let root = z_up_root();
        let scale = Vec3::new(2.0, 3.0, 0.5);
        let model = |key: Vec3| {
            rotate(
                root,
                Vec3::new(key.x * scale.x, key.y * scale.y, key.z * scale.z),
            )
        };
        let run = |root_motion| {
            let mut parameters = parameters(root_motion);
            parameters.target.nodes[0].scale = [scale.x, scale.y, scale.z];
            let (output, _) = retarget_document(&source_animation(), &parameters).unwrap();
            translation_keys(&output, TARGET_HIPS)
        };
        let kept = run(RootMotion::Keep);
        let in_place = run(RootMotion::InPlace);
        let rest_model = model(Vec3::new(0.0, 0.0, 1.5));
        for (key, kept_key) in in_place.iter().zip(&kept) {
            let actual = model(*key);
            assert!((actual.x - rest_model.x).abs() < 1.0e-5, "{actual:?}");
            assert!((actual.z - rest_model.z).abs() < 1.0e-5, "{actual:?}");
            assert!((actual.y - model(*kept_key).y).abs() < 1.0e-5, "{actual:?}");
        }
        assert!((model(in_place[1]).y - rest_model.y - 0.0375).abs() < 1.0e-5);
    }

    #[test]
    fn retarget_output_is_deterministic() {
        let first =
            retarget_document(&source_animation(), &parameters(RootMotion::InPlace)).unwrap();
        let second =
            retarget_document(&source_animation(), &parameters(RootMotion::InPlace)).unwrap();
        assert_eq!(
            serde_json::to_vec(&first.0).unwrap(),
            serde_json::to_vec(&second.0).unwrap()
        );
        assert_eq!(first.1, second.1);
        assert_eq!(first.1.mapped_bone_count, 12);
        assert_eq!(first.1.result_keyframe_count, 14 * 3);
    }

    #[test]
    fn retarget_protocol_identity_and_request_shape() {
        let operation = AdapterOperation::Retarget;
        let probe: serde_json::Value =
            serde_json::from_str(&probe_json(operation).unwrap()).unwrap();
        let component = &probe[0];
        assert_eq!(component["id"], "three-d-animation-retarget");
        assert_eq!(
            component["algorithm"],
            "three-d-animation-humanoid-retarget-v1"
        );
        assert_eq!(component["protocol"], "asset-tooling-process-adapter-v1");
        assert_eq!(component["codec"], "three-d-animation-json-v1");

        let rig = serde_json::json!({
            "nodes": [{ "parent": null, "translation": [0.0, 1.0, 0.0], "rotation": [0.0, 0.0, 0.0, 1.0], "scale": [1.0, 1.0, 1.0] }],
            "bindings": { "hips": 0 },
            "referenceHeight": 1.0
        });
        let request = |operation: &str, extra: Option<(&str, serde_json::Value)>| {
            let mut parameters = serde_json::json!({
                "source": rig,
                "target": rig,
                "sampleTimesSeconds": [0.0, 1.0],
                "rootMotion": "in-place"
            });
            if let Some((key, value)) = extra {
                parameters[key] = value;
            }
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1,
                "operation": operation,
                "inputPath": "clip.json",
                "parameters": parameters
            }))
            .unwrap()
        };
        let parsed: Request<RetargetParameters> =
            parse_request(operation, &request("animation.retarget", None)).unwrap();
        assert_eq!(parsed.parameters.root_motion, RootMotion::InPlace);
        assert!(
            parse_request::<RetargetParameters>(operation, &request("animation.resample", None))
                .unwrap_err()
                .contains("unsupported operation")
        );
        assert!(
            parse_request::<RetargetParameters>(
                operation,
                &request(
                    "animation.retarget",
                    Some(("solver", serde_json::json!("ik")))
                )
            )
            .is_err()
        );
        assert!(
            parse_request::<RetargetParameters>(
                operation,
                &request(
                    "animation.retarget",
                    Some(("rootMotion", serde_json::json!("xz")))
                )
            )
            .is_err()
        );
    }
}
