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

/// Model-space up axis expressed in `node`'s parent space, from the static rest chain.
fn parent_space_up(rig: &DecodedRig, node: usize) -> Vec3 {
    let rest = rig.rig.rest_pose();
    let mut model_rotation = Quat::IDENTITY;
    let mut current = rig.parents[node];
    while let Some(parent) = current {
        let rotation = rest[parent].rotation.normalized().unwrap_or(Quat::IDENTITY);
        model_rotation = quat_mul(rotation, model_rotation);
        current = rig.parents[parent];
    }
    let model_rotation = model_rotation.normalized().unwrap_or(Quat::IDENTITY);
    let inverse = Quat::new(
        -model_rotation.x,
        -model_rotation.y,
        -model_rotation.z,
        model_rotation.w,
    );
    rotate(inverse, Vec3::new(0.0, 1.0, 0.0))
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
            let up = parent_space_up(&target, *target_node);
            channels.push(ChannelDocument::Translation {
                node: *target_node,
                keyframes: times
                    .iter()
                    .zip(values)
                    .map(|(time, value)| {
                        let translation = match parameters.root_motion {
                            RootMotion::Keep => value.translation,
                            RootMotion::InPlace => rest + up * (value.translation - rest).dot(up),
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
