//! Explicit semantic humanoid retargeting.
//!
//! Retargeting owns no renderer, asset parser, clock, or IK. Both rigs provide
//! their authoritative rest pose and a semantic-to-node map. Animation is
//! transferred as a delta from the source rest pose onto the target rest pose.

use core::fmt;

use three_d_core::Vec3;

use crate::{Quat, Transform};

const EPSILON: f32 = 1.0e-6;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum HumanoidBone {
    Hips = 0,
    Spine,
    Chest,
    Neck,
    Head,
    LeftUpperArm,
    LeftLowerArm,
    LeftHand,
    RightUpperArm,
    RightLowerArm,
    RightHand,
    LeftUpperLeg,
    LeftLowerLeg,
    LeftFoot,
    RightUpperLeg,
    RightLowerLeg,
    RightFoot,
    /// Character-space root. Production rigs keep this separate from pelvic motion on Hips.
    Root,
    /// Left clavicle / shoulder girdle joint.
    LeftShoulder,
    /// Right clavicle / shoulder girdle joint.
    RightShoulder,
    LeftToes,
    RightToes,
}

impl HumanoidBone {
    pub const COUNT: usize = 22;
    pub const ALL: [Self; Self::COUNT] = [
        Self::Hips,
        Self::Spine,
        Self::Chest,
        Self::Neck,
        Self::Head,
        Self::LeftUpperArm,
        Self::LeftLowerArm,
        Self::LeftHand,
        Self::RightUpperArm,
        Self::RightLowerArm,
        Self::RightHand,
        Self::LeftUpperLeg,
        Self::LeftLowerLeg,
        Self::LeftFoot,
        Self::RightUpperLeg,
        Self::RightLowerLeg,
        Self::RightFoot,
        Self::Root,
        Self::LeftShoulder,
        Self::RightShoulder,
        Self::LeftToes,
        Self::RightToes,
    ];

    const REQUIRED: [Self; 11] = [
        Self::Hips,
        Self::Spine,
        Self::Head,
        Self::LeftUpperArm,
        Self::LeftLowerArm,
        Self::RightUpperArm,
        Self::RightLowerArm,
        Self::LeftUpperLeg,
        Self::LeftLowerLeg,
        Self::RightUpperLeg,
        Self::RightLowerLeg,
    ];

    const fn index(self) -> usize {
        self as usize
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HumanoidBinding {
    pub bone: HumanoidBone,
    pub node: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HumanoidRig {
    rest_pose: Vec<Transform>,
    nodes: [Option<usize>; HumanoidBone::COUNT],
    reference_height: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum RetargetError {
    EmptyPose,
    InvalidReferenceHeight,
    NodeOutOfBounds {
        bone: HumanoidBone,
        node: usize,
        node_count: usize,
    },
    DuplicateBone(HumanoidBone),
    DuplicateNode(usize),
    MissingRequiredBone(HumanoidBone),
    InvalidRestTransform {
        node: usize,
    },
    InvalidPoseTransform {
        node: usize,
    },
    PoseLengthMismatch {
        role: &'static str,
        expected: usize,
        actual: usize,
    },
}

impl fmt::Display for RetargetError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyPose => formatter.write_str("humanoid rig requires a non-empty rest pose"),
            Self::InvalidReferenceHeight => {
                formatter.write_str("humanoid reference height must be finite and positive")
            }
            Self::NodeOutOfBounds {
                bone,
                node,
                node_count,
            } => write!(
                formatter,
                "{bone:?} maps to node {node}, but the rest pose has {node_count} nodes"
            ),
            Self::DuplicateBone(bone) => {
                write!(formatter, "humanoid bone {bone:?} is mapped twice")
            }
            Self::DuplicateNode(node) => write!(formatter, "humanoid node {node} is mapped twice"),
            Self::MissingRequiredBone(bone) => {
                write!(formatter, "required humanoid bone {bone:?} is not mapped")
            }
            Self::InvalidRestTransform { node } => {
                write!(
                    formatter,
                    "rest transform for node {node} must be finite and invertible"
                )
            }
            Self::InvalidPoseTransform { node } => {
                write!(
                    formatter,
                    "animated transform for node {node} must be finite"
                )
            }
            Self::PoseLengthMismatch {
                role,
                expected,
                actual,
            } => write!(
                formatter,
                "{role} pose length mismatch: expected {expected}, got {actual}"
            ),
        }
    }
}

impl std::error::Error for RetargetError {}

fn finite_vec3(value: Vec3) -> bool {
    value.x.is_finite() && value.y.is_finite() && value.z.is_finite()
}

fn finite_quat(value: Quat) -> bool {
    value.x.is_finite() && value.y.is_finite() && value.z.is_finite() && value.w.is_finite()
}

fn valid_transform(value: Transform, require_invertible_scale: bool) -> bool {
    finite_vec3(value.translation)
        && finite_quat(value.rotation)
        && value.rotation.length() > EPSILON
        && finite_vec3(value.scale)
        && (!require_invertible_scale
            || (value.scale.x.abs() > EPSILON
                && value.scale.y.abs() > EPSILON
                && value.scale.z.abs() > EPSILON))
}

fn quat_conjugate(value: Quat) -> Quat {
    Quat::new(-value.x, -value.y, -value.z, value.w)
}

fn quat_mul(left: Quat, right: Quat) -> Quat {
    Quat::new(
        left.w * right.x + left.x * right.w + left.y * right.z - left.z * right.y,
        left.w * right.y - left.x * right.z + left.y * right.w + left.z * right.x,
        left.w * right.z + left.x * right.y - left.y * right.x + left.z * right.w,
        left.w * right.w - left.x * right.x - left.y * right.y - left.z * right.z,
    )
    .normalized()
    .unwrap_or(Quat::IDENTITY)
}

fn quat_inverse(value: Quat) -> Quat {
    quat_conjugate(value.normalized().unwrap_or(Quat::IDENTITY))
}

impl HumanoidRig {
    pub fn new(
        rest_pose: Vec<Transform>,
        bindings: &[HumanoidBinding],
        reference_height: f32,
    ) -> Result<Self, RetargetError> {
        if rest_pose.is_empty() {
            return Err(RetargetError::EmptyPose);
        }
        if !reference_height.is_finite() || reference_height <= EPSILON {
            return Err(RetargetError::InvalidReferenceHeight);
        }
        for (node, transform) in rest_pose.iter().copied().enumerate() {
            if !valid_transform(transform, true) {
                return Err(RetargetError::InvalidRestTransform { node });
            }
        }

        let mut nodes = [None; HumanoidBone::COUNT];
        let mut used_nodes = vec![false; rest_pose.len()];
        for binding in bindings {
            if binding.node >= rest_pose.len() {
                return Err(RetargetError::NodeOutOfBounds {
                    bone: binding.bone,
                    node: binding.node,
                    node_count: rest_pose.len(),
                });
            }
            let slot = &mut nodes[binding.bone.index()];
            if slot.is_some() {
                return Err(RetargetError::DuplicateBone(binding.bone));
            }
            if used_nodes[binding.node] {
                return Err(RetargetError::DuplicateNode(binding.node));
            }
            *slot = Some(binding.node);
            used_nodes[binding.node] = true;
        }

        for bone in HumanoidBone::REQUIRED {
            if nodes[bone.index()].is_none() {
                return Err(RetargetError::MissingRequiredBone(bone));
            }
        }

        Ok(Self {
            rest_pose,
            nodes,
            reference_height,
        })
    }

    pub fn rest_pose(&self) -> &[Transform] {
        &self.rest_pose
    }

    pub fn reference_height(&self) -> f32 {
        self.reference_height
    }

    pub fn node(&self, bone: HumanoidBone) -> Option<usize> {
        self.nodes[bone.index()]
    }
}

fn retarget_transform(
    source_rest: Transform,
    source_pose: Transform,
    target_rest: Transform,
    translation_scale: f32,
) -> Transform {
    let translation_delta = source_pose.translation - source_rest.translation;
    let rotation_delta = quat_mul(quat_inverse(source_rest.rotation), source_pose.rotation);
    let scale_ratio = Vec3::new(
        source_pose.scale.x / source_rest.scale.x,
        source_pose.scale.y / source_rest.scale.y,
        source_pose.scale.z / source_rest.scale.z,
    );

    Transform {
        translation: target_rest.translation + translation_delta * translation_scale,
        rotation: quat_mul(target_rest.rotation, rotation_delta),
        scale: Vec3::new(
            target_rest.scale.x * scale_ratio.x,
            target_rest.scale.y * scale_ratio.y,
            target_rest.scale.z * scale_ratio.z,
        ),
    }
}

/// Transfer source local-pose deltas to the target rest pose.
///
/// Target nodes with optional semantics absent from the source remain exactly at
/// their target rest transform. The function writes into caller-owned output and
/// performs no allocation on the successful hot path.
pub fn retarget_pose(
    source: &HumanoidRig,
    source_pose: &[Transform],
    target: &HumanoidRig,
    output: &mut [Transform],
) -> Result<(), RetargetError> {
    if source_pose.len() != source.rest_pose.len() {
        return Err(RetargetError::PoseLengthMismatch {
            role: "source",
            expected: source.rest_pose.len(),
            actual: source_pose.len(),
        });
    }
    if output.len() != target.rest_pose.len() {
        return Err(RetargetError::PoseLengthMismatch {
            role: "target output",
            expected: target.rest_pose.len(),
            actual: output.len(),
        });
    }

    output.copy_from_slice(&target.rest_pose);
    let translation_scale = target.reference_height / source.reference_height;

    for semantic_index in 0..HumanoidBone::COUNT {
        let Some(source_node) = source.nodes[semantic_index] else {
            continue;
        };
        let Some(target_node) = target.nodes[semantic_index] else {
            continue;
        };
        let animated = source_pose[source_node];
        if !valid_transform(animated, false) {
            return Err(RetargetError::InvalidPoseTransform { node: source_node });
        }
        output[target_node] = retarget_transform(
            source.rest_pose[source_node],
            animated,
            target.rest_pose[target_node],
            translation_scale,
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const REQUIRED: [HumanoidBone; 11] = [
        HumanoidBone::Hips,
        HumanoidBone::Spine,
        HumanoidBone::Head,
        HumanoidBone::LeftUpperArm,
        HumanoidBone::LeftLowerArm,
        HumanoidBone::RightUpperArm,
        HumanoidBone::RightLowerArm,
        HumanoidBone::LeftUpperLeg,
        HumanoidBone::LeftLowerLeg,
        HumanoidBone::RightUpperLeg,
        HumanoidBone::RightLowerLeg,
    ];

    fn bindings() -> Vec<HumanoidBinding> {
        REQUIRED
            .iter()
            .copied()
            .enumerate()
            .map(|(node, bone)| HumanoidBinding { bone, node })
            .collect()
    }

    fn rig(height: f32, arm_rest_radians: f32) -> HumanoidRig {
        let mut rest = vec![Transform::IDENTITY; REQUIRED.len()];
        rest[3].translation = Vec3::new(-0.4 * height, 0.7 * height, 0.0);
        rest[3].rotation = Quat::from_euler_xyz(0.0, 0.0, arm_rest_radians);
        rest[4].translation = Vec3::new(-0.35 * height, 0.0, 0.0);
        HumanoidRig::new(rest, &bindings(), height).unwrap()
    }

    fn assert_quat_equivalent(actual: Quat, expected: Quat) {
        let dot = actual
            .normalized()
            .unwrap()
            .dot(expected.normalized().unwrap())
            .abs();
        assert!((1.0 - dot).abs() < 1.0e-5, "{actual:?} != {expected:?}");
    }

    #[test]
    fn transfers_rest_relative_rotation_across_different_bind_orientations() {
        let source = rig(2.0, 0.25);
        let target = rig(3.0, -0.4);
        let mut source_pose = source.rest_pose().to_vec();
        let delta = Quat::from_euler_xyz(0.0, 0.0, 0.6);
        source_pose[3].rotation = quat_mul(source_pose[3].rotation, delta);
        let mut output = vec![Transform::IDENTITY; target.rest_pose().len()];

        retarget_pose(&source, &source_pose, &target, &mut output).unwrap();

        let expected = quat_mul(target.rest_pose()[3].rotation, delta);
        assert_quat_equivalent(output[3].rotation, expected);
    }

    #[test]
    fn scales_root_motion_by_explicit_reference_height_ratio() {
        let source = rig(2.0, 0.0);
        let target = rig(3.0, 0.0);
        let mut source_pose = source.rest_pose().to_vec();
        source_pose[0].translation = Vec3::new(1.0, 0.0, 0.0);
        let mut output = target.rest_pose().to_vec();

        retarget_pose(&source, &source_pose, &target, &mut output).unwrap();

        assert_eq!(output[0].translation, Vec3::new(1.5, 0.0, 0.0));
    }

    #[test]
    fn optional_target_bones_stay_at_target_rest_when_source_has_no_mapping() {
        let source = rig(2.0, 0.0);
        let mut target_bindings = bindings();
        target_bindings.push(HumanoidBinding {
            bone: HumanoidBone::LeftHand,
            node: REQUIRED.len(),
        });
        let mut target_rest = rig(3.0, 0.0).rest_pose().to_vec();
        target_rest.push(Transform {
            translation: Vec3::new(-0.4, 0.0, 0.0),
            ..Transform::IDENTITY
        });
        let target = HumanoidRig::new(target_rest, &target_bindings, 3.0).unwrap();
        let source_pose = source.rest_pose().to_vec();
        let mut output = vec![Transform::IDENTITY; target.rest_pose().len()];

        retarget_pose(&source, &source_pose, &target, &mut output).unwrap();

        let hand = target.node(HumanoidBone::LeftHand).unwrap();
        assert_eq!(output[hand], target.rest_pose()[hand]);
    }

    #[test]
    fn missing_required_semantics_fail_at_rig_boundary() {
        let mut map = bindings();
        map.retain(|binding| binding.bone != HumanoidBone::Head);
        assert_eq!(
            HumanoidRig::new(vec![Transform::IDENTITY; REQUIRED.len()], &map, 2.0),
            Err(RetargetError::MissingRequiredBone(HumanoidBone::Head))
        );
    }

    #[test]
    fn retargeting_reuses_caller_owned_output() {
        let source = rig(2.0, 0.0);
        let target = rig(3.0, 0.0);
        let source_pose = source.rest_pose().to_vec();
        let mut output = target.rest_pose().to_vec();
        let pointer = output.as_ptr();

        for _ in 0..128 {
            retarget_pose(&source, &source_pose, &target, &mut output).unwrap();
            assert_eq!(output.as_ptr(), pointer);
        }
    }
}
