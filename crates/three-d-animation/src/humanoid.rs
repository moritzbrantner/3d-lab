//! Production humanoid skeleton composition.
//!
//! `Skeleton` remains authoritative for joint hierarchy and inverse-bind data,
//! while `HumanoidRig` owns semantic bone mapping and the retargeting rest pose.
//! This module composes those existing contracts into a stricter profile for
//! reusable game characters without moving gameplay, rendering, or asset parsing
//! into the animation crate.

use core::fmt;

use crate::retarget::{HumanoidBone, HumanoidRig};
use crate::{Skeleton, Transform};

const EPSILON: f32 = 1.0e-6;

const PRODUCTION_REQUIRED_BONES: [HumanoidBone; 20] = [
    HumanoidBone::Root,
    HumanoidBone::Hips,
    HumanoidBone::Spine,
    HumanoidBone::Chest,
    HumanoidBone::Neck,
    HumanoidBone::Head,
    HumanoidBone::LeftShoulder,
    HumanoidBone::LeftUpperArm,
    HumanoidBone::LeftLowerArm,
    HumanoidBone::LeftHand,
    HumanoidBone::RightShoulder,
    HumanoidBone::RightUpperArm,
    HumanoidBone::RightLowerArm,
    HumanoidBone::RightHand,
    HumanoidBone::LeftUpperLeg,
    HumanoidBone::LeftLowerLeg,
    HumanoidBone::LeftFoot,
    HumanoidBone::RightUpperLeg,
    HumanoidBone::RightLowerLeg,
    HumanoidBone::RightFoot,
];

const PRODUCTION_PARENT_RELATIONSHIPS: [(HumanoidBone, HumanoidBone); 19] = [
    (HumanoidBone::Hips, HumanoidBone::Root),
    (HumanoidBone::Spine, HumanoidBone::Hips),
    (HumanoidBone::Chest, HumanoidBone::Spine),
    (HumanoidBone::Neck, HumanoidBone::Chest),
    (HumanoidBone::Head, HumanoidBone::Neck),
    (HumanoidBone::LeftShoulder, HumanoidBone::Chest),
    (HumanoidBone::LeftUpperArm, HumanoidBone::LeftShoulder),
    (HumanoidBone::LeftLowerArm, HumanoidBone::LeftUpperArm),
    (HumanoidBone::LeftHand, HumanoidBone::LeftLowerArm),
    (HumanoidBone::RightShoulder, HumanoidBone::Chest),
    (HumanoidBone::RightUpperArm, HumanoidBone::RightShoulder),
    (HumanoidBone::RightLowerArm, HumanoidBone::RightUpperArm),
    (HumanoidBone::RightHand, HumanoidBone::RightLowerArm),
    (HumanoidBone::LeftUpperLeg, HumanoidBone::Hips),
    (HumanoidBone::LeftLowerLeg, HumanoidBone::LeftUpperLeg),
    (HumanoidBone::LeftFoot, HumanoidBone::LeftLowerLeg),
    (HumanoidBone::RightUpperLeg, HumanoidBone::Hips),
    (HumanoidBone::RightLowerLeg, HumanoidBone::RightUpperLeg),
    (HumanoidBone::RightFoot, HumanoidBone::RightLowerLeg),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum HumanoidSocket {
    Head = 0,
    Chest,
    Back,
    LeftHand,
    RightHand,
    LeftHip,
    RightHip,
}

impl HumanoidSocket {
    pub const COUNT: usize = 7;
    pub const REQUIRED: [Self; Self::COUNT] = [
        Self::Head,
        Self::Chest,
        Self::Back,
        Self::LeftHand,
        Self::RightHand,
        Self::LeftHip,
        Self::RightHip,
    ];

    const fn index(self) -> usize {
        self as usize
    }

    pub const fn expected_bone(self) -> HumanoidBone {
        match self {
            Self::Head => HumanoidBone::Head,
            Self::Chest | Self::Back => HumanoidBone::Chest,
            Self::LeftHand => HumanoidBone::LeftHand,
            Self::RightHand => HumanoidBone::RightHand,
            Self::LeftHip | Self::RightHip => HumanoidBone::Hips,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct HumanoidSocketBinding {
    pub socket: HumanoidSocket,
    pub bone: HumanoidBone,
    /// Transform from the owning semantic bone into the attachment frame.
    pub local: Transform,
}

#[derive(Debug, Clone, PartialEq)]
pub struct HumanoidSkeleton {
    skeleton: Skeleton,
    rig: HumanoidRig,
    sockets: [Option<HumanoidSocketBinding>; HumanoidSocket::COUNT],
}

#[derive(Debug, Clone, PartialEq)]
pub enum HumanoidSkeletonError {
    JointCountMismatch {
        skeleton: usize,
        rest_pose: usize,
    },
    MissingProductionBone(HumanoidBone),
    RootHasParent {
        root_node: usize,
        parent: usize,
    },
    InvalidSemanticHierarchy {
        bone: HumanoidBone,
        node: usize,
        expected_ancestor: HumanoidBone,
        expected_ancestor_node: usize,
    },
    DuplicateSocket(HumanoidSocket),
    MissingRequiredSocket(HumanoidSocket),
    SocketBoneMismatch {
        socket: HumanoidSocket,
        expected: HumanoidBone,
        actual: HumanoidBone,
    },
    SocketBoneNotMapped {
        socket: HumanoidSocket,
        bone: HumanoidBone,
    },
    InvalidSocketTransform(HumanoidSocket),
}

impl fmt::Display for HumanoidSkeletonError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::JointCountMismatch {
                skeleton,
                rest_pose,
            } => write!(
                formatter,
                "humanoid skeleton has {skeleton} joints but the rig rest pose has {rest_pose} nodes"
            ),
            Self::MissingProductionBone(bone) => {
                write!(formatter, "production humanoid is missing required bone {bone:?}")
            }
            Self::RootHasParent { root_node, parent } => write!(
                formatter,
                "production humanoid root node {root_node} must not have skeleton parent {parent}"
            ),
            Self::InvalidSemanticHierarchy {
                bone,
                node,
                expected_ancestor,
                expected_ancestor_node,
            } => write!(
                formatter,
                "{bone:?} node {node} must descend from {expected_ancestor:?} node {expected_ancestor_node}"
            ),
            Self::DuplicateSocket(socket) => {
                write!(formatter, "humanoid socket {socket:?} is bound more than once")
            }
            Self::MissingRequiredSocket(socket) => {
                write!(formatter, "production humanoid is missing required socket {socket:?}")
            }
            Self::SocketBoneMismatch {
                socket,
                expected,
                actual,
            } => write!(
                formatter,
                "humanoid socket {socket:?} must bind to {expected:?}, not {actual:?}"
            ),
            Self::SocketBoneNotMapped { socket, bone } => write!(
                formatter,
                "humanoid socket {socket:?} references unmapped semantic bone {bone:?}"
            ),
            Self::InvalidSocketTransform(socket) => write!(
                formatter,
                "humanoid socket {socket:?} requires a finite, invertible local transform"
            ),
        }
    }
}

impl std::error::Error for HumanoidSkeletonError {}

impl HumanoidSkeleton {
    /// Build the strict production-humanoid profile used by game character assets.
    ///
    /// Semantic parent relationships are ancestry requirements rather than direct
    /// parent requirements, so imported rigs may retain helper/twist joints between
    /// mapped humanoid bones without changing the canonical semantics.
    pub fn production_v1(
        skeleton: Skeleton,
        rig: HumanoidRig,
        socket_bindings: &[HumanoidSocketBinding],
    ) -> Result<Self, HumanoidSkeletonError> {
        if skeleton.joints().len() != rig.rest_pose().len() {
            return Err(HumanoidSkeletonError::JointCountMismatch {
                skeleton: skeleton.joints().len(),
                rest_pose: rig.rest_pose().len(),
            });
        }

        for bone in PRODUCTION_REQUIRED_BONES {
            if rig.node(bone).is_none() {
                return Err(HumanoidSkeletonError::MissingProductionBone(bone));
            }
        }

        let root_node = rig
            .node(HumanoidBone::Root)
            .ok_or(HumanoidSkeletonError::MissingProductionBone(HumanoidBone::Root))?;
        if let Some(parent) = skeleton.joints()[root_node].parent {
            return Err(HumanoidSkeletonError::RootHasParent { root_node, parent });
        }

        for (bone, expected_ancestor) in PRODUCTION_PARENT_RELATIONSHIPS {
            validate_semantic_ancestry(&skeleton, &rig, bone, expected_ancestor)?;
        }
        validate_optional_ancestry(
            &skeleton,
            &rig,
            HumanoidBone::LeftToes,
            HumanoidBone::LeftFoot,
        )?;
        validate_optional_ancestry(
            &skeleton,
            &rig,
            HumanoidBone::RightToes,
            HumanoidBone::RightFoot,
        )?;

        let mut sockets = [None; HumanoidSocket::COUNT];
        for binding in socket_bindings {
            let expected = binding.socket.expected_bone();
            if binding.bone != expected {
                return Err(HumanoidSkeletonError::SocketBoneMismatch {
                    socket: binding.socket,
                    expected,
                    actual: binding.bone,
                });
            }
            if rig.node(binding.bone).is_none() {
                return Err(HumanoidSkeletonError::SocketBoneNotMapped {
                    socket: binding.socket,
                    bone: binding.bone,
                });
            }
            if !valid_attachment_transform(binding.local) {
                return Err(HumanoidSkeletonError::InvalidSocketTransform(binding.socket));
            }

            let slot = &mut sockets[binding.socket.index()];
            if slot.is_some() {
                return Err(HumanoidSkeletonError::DuplicateSocket(binding.socket));
            }
            *slot = Some(*binding);
        }

        for socket in HumanoidSocket::REQUIRED {
            if sockets[socket.index()].is_none() {
                return Err(HumanoidSkeletonError::MissingRequiredSocket(socket));
            }
        }

        Ok(Self {
            skeleton,
            rig,
            sockets,
        })
    }

    pub fn skeleton(&self) -> &Skeleton {
        &self.skeleton
    }

    pub fn rig(&self) -> &HumanoidRig {
        &self.rig
    }

    pub fn socket(&self, socket: HumanoidSocket) -> Option<HumanoidSocketBinding> {
        self.sockets[socket.index()]
    }

    pub fn socket_node(&self, socket: HumanoidSocket) -> Option<usize> {
        self.socket(socket)
            .and_then(|binding| self.rig.node(binding.bone))
    }
}

fn validate_semantic_ancestry(
    skeleton: &Skeleton,
    rig: &HumanoidRig,
    bone: HumanoidBone,
    expected_ancestor: HumanoidBone,
) -> Result<(), HumanoidSkeletonError> {
    let node = rig
        .node(bone)
        .ok_or(HumanoidSkeletonError::MissingProductionBone(bone))?;
    let expected_ancestor_node = rig
        .node(expected_ancestor)
        .ok_or(HumanoidSkeletonError::MissingProductionBone(expected_ancestor))?;

    if !has_ancestor(skeleton, node, expected_ancestor_node) {
        return Err(HumanoidSkeletonError::InvalidSemanticHierarchy {
            bone,
            node,
            expected_ancestor,
            expected_ancestor_node,
        });
    }
    Ok(())
}

fn validate_optional_ancestry(
    skeleton: &Skeleton,
    rig: &HumanoidRig,
    bone: HumanoidBone,
    expected_ancestor: HumanoidBone,
) -> Result<(), HumanoidSkeletonError> {
    let Some(node) = rig.node(bone) else {
        return Ok(());
    };
    let expected_ancestor_node = rig
        .node(expected_ancestor)
        .ok_or(HumanoidSkeletonError::MissingProductionBone(expected_ancestor))?;
    if !has_ancestor(skeleton, node, expected_ancestor_node) {
        return Err(HumanoidSkeletonError::InvalidSemanticHierarchy {
            bone,
            node,
            expected_ancestor,
            expected_ancestor_node,
        });
    }
    Ok(())
}

fn has_ancestor(skeleton: &Skeleton, node: usize, ancestor: usize) -> bool {
    let mut current = skeleton.joints()[node].parent;
    while let Some(parent) = current {
        if parent == ancestor {
            return true;
        }
        current = skeleton.joints()[parent].parent;
    }
    false
}

fn valid_attachment_transform(transform: Transform) -> bool {
    let translation = transform.translation;
    let scale = transform.scale;
    let rotation = transform.rotation;
    translation.x.is_finite()
        && translation.y.is_finite()
        && translation.z.is_finite()
        && rotation.x.is_finite()
        && rotation.y.is_finite()
        && rotation.z.is_finite()
        && rotation.w.is_finite()
        && rotation.length() > EPSILON
        && scale.x.is_finite()
        && scale.y.is_finite()
        && scale.z.is_finite()
        && scale.x.abs() > EPSILON
        && scale.y.abs() > EPSILON
        && scale.z.abs() > EPSILON
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::retarget::HumanoidBinding;
    use crate::{Joint, Mat4};
    use three_d_core::Vec3;

    const BONES: [HumanoidBone; 20] = [
        HumanoidBone::Root,
        HumanoidBone::Hips,
        HumanoidBone::Spine,
        HumanoidBone::Chest,
        HumanoidBone::Neck,
        HumanoidBone::Head,
        HumanoidBone::LeftShoulder,
        HumanoidBone::LeftUpperArm,
        HumanoidBone::LeftLowerArm,
        HumanoidBone::LeftHand,
        HumanoidBone::RightShoulder,
        HumanoidBone::RightUpperArm,
        HumanoidBone::RightLowerArm,
        HumanoidBone::RightHand,
        HumanoidBone::LeftUpperLeg,
        HumanoidBone::LeftLowerLeg,
        HumanoidBone::LeftFoot,
        HumanoidBone::RightUpperLeg,
        HumanoidBone::RightLowerLeg,
        HumanoidBone::RightFoot,
    ];

    const PARENTS: [Option<usize>; 20] = [
        None,
        Some(0),
        Some(1),
        Some(2),
        Some(3),
        Some(4),
        Some(3),
        Some(6),
        Some(7),
        Some(8),
        Some(3),
        Some(10),
        Some(11),
        Some(12),
        Some(1),
        Some(14),
        Some(15),
        Some(1),
        Some(17),
        Some(18),
    ];

    fn socket_bindings() -> Vec<HumanoidSocketBinding> {
        HumanoidSocket::REQUIRED
            .iter()
            .copied()
            .map(|socket| HumanoidSocketBinding {
                socket,
                bone: socket.expected_bone(),
                local: Transform::IDENTITY,
            })
            .collect()
    }

    fn build_parts(
        parents: [Option<usize>; 20],
        omitted_bone: Option<HumanoidBone>,
    ) -> (Skeleton, HumanoidRig, Vec<HumanoidSocketBinding>) {
        let skeleton = Skeleton::new(
            parents
                .into_iter()
                .map(|parent| Joint {
                    parent,
                    inverse_bind: Mat4::IDENTITY,
                })
                .collect(),
        )
        .unwrap();

        let bindings: Vec<_> = BONES
            .iter()
            .copied()
            .enumerate()
            .filter(|(_, bone)| Some(*bone) != omitted_bone)
            .map(|(node, bone)| HumanoidBinding { bone, node })
            .collect();
        let mut rest_pose = vec![Transform::IDENTITY; BONES.len()];
        rest_pose[1].translation = Vec3::new(0.0, 0.9, 0.0);
        let rig = HumanoidRig::new(rest_pose, &bindings, 1.8).unwrap();
        (skeleton, rig, socket_bindings())
    }

    #[test]
    fn production_profile_accepts_canonical_humanoid_and_exposes_socket_nodes() {
        let (skeleton, rig, sockets) = build_parts(PARENTS, None);

        let humanoid = HumanoidSkeleton::production_v1(skeleton, rig, &sockets).unwrap();

        assert_eq!(
            humanoid.socket_node(HumanoidSocket::RightHand),
            humanoid.rig().node(HumanoidBone::RightHand)
        );
        assert_eq!(humanoid.skeleton().joints().len(), BONES.len());
    }

    #[test]
    fn production_profile_rejects_missing_bones_that_lightweight_retargeting_allows() {
        let (skeleton, rig, sockets) = build_parts(PARENTS, Some(HumanoidBone::Chest));

        assert_eq!(
            HumanoidSkeleton::production_v1(skeleton, rig, &sockets),
            Err(HumanoidSkeletonError::MissingProductionBone(
                HumanoidBone::Chest
            ))
        );
    }

    #[test]
    fn production_profile_rejects_semantically_wrong_arm_hierarchy() {
        let mut parents = PARENTS;
        parents[8] = Some(3);
        let (skeleton, rig, sockets) = build_parts(parents, None);

        assert_eq!(
            HumanoidSkeleton::production_v1(skeleton, rig, &sockets),
            Err(HumanoidSkeletonError::InvalidSemanticHierarchy {
                bone: HumanoidBone::LeftLowerArm,
                node: 8,
                expected_ancestor: HumanoidBone::LeftUpperArm,
                expected_ancestor_node: 7,
            })
        );
    }

    #[test]
    fn production_profile_rejects_socket_bound_to_wrong_semantic_bone() {
        let (skeleton, rig, mut sockets) = build_parts(PARENTS, None);
        let right_hand = sockets
            .iter_mut()
            .find(|binding| binding.socket == HumanoidSocket::RightHand)
            .unwrap();
        right_hand.bone = HumanoidBone::Chest;

        assert_eq!(
            HumanoidSkeleton::production_v1(skeleton, rig, &sockets),
            Err(HumanoidSkeletonError::SocketBoneMismatch {
                socket: HumanoidSocket::RightHand,
                expected: HumanoidBone::RightHand,
                actual: HumanoidBone::Chest,
            })
        );
    }

    #[test]
    fn production_profile_requires_all_standard_attachment_sockets() {
        let (skeleton, rig, mut sockets) = build_parts(PARENTS, None);
        sockets.retain(|binding| binding.socket != HumanoidSocket::Back);

        assert_eq!(
            HumanoidSkeleton::production_v1(skeleton, rig, &sockets),
            Err(HumanoidSkeletonError::MissingRequiredSocket(
                HumanoidSocket::Back
            ))
        );
    }
}
