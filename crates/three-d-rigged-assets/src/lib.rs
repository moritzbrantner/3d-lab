//! Renderer-independent composition and automatic collision-proxy fitting for rigged 3D assets.
//!
//! This crate composes existing three-d-animation authority with lightweight joint-local
//! collision approximations. It does not parse file formats, generate rigs, own provenance,
//! render meshes, or perform physics simulation.

use core::fmt;
use three_d_animation::{
    AnimationClip, ClipError, Skeleton, SkeletonError, SkinInfluence, Transform,
};
use three_d_core::Vec3;

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum CollisionProxyShape {
    Box { size: Vec3 },
    Sphere { radius: f32 },
    Capsule { radius: f32, segment_length: f32 },
}

impl CollisionProxyShape {
    fn validate(self) -> Result<Self, CollisionProxyError> {
        match self {
            Self::Box { size } => {
                if !finite_vec3(size) || size.x <= 0.0 || size.y <= 0.0 || size.z <= 0.0 {
                    return Err(CollisionProxyError::InvalidBoxSize);
                }
            }
            Self::Sphere { radius } => {
                if !radius.is_finite() || radius <= 0.0 {
                    return Err(CollisionProxyError::InvalidSphereRadius);
                }
            }
            Self::Capsule {
                radius,
                segment_length,
            } => {
                if !radius.is_finite() || radius <= 0.0 {
                    return Err(CollisionProxyError::InvalidCapsuleRadius);
                }
                if !segment_length.is_finite() || segment_length <= 0.0 {
                    return Err(CollisionProxyError::InvalidCapsuleSegmentLength);
                }
            }
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct JointCollisionProxy {
    joint: usize,
    center: Vec3,
    shape: CollisionProxyShape,
}

impl JointCollisionProxy {
    pub fn new(
        joint: usize,
        center: Vec3,
        shape: CollisionProxyShape,
    ) -> Result<Self, CollisionProxyError> {
        if !finite_vec3(center) {
            return Err(CollisionProxyError::NonFiniteCenter);
        }
        Ok(Self {
            joint,
            center,
            shape: shape.validate()?,
        })
    }

    pub const fn joint(&self) -> usize {
        self.joint
    }

    pub const fn center(&self) -> Vec3 {
        self.center
    }

    pub const fn shape(&self) -> CollisionProxyShape {
        self.shape
    }

    fn validate_joint(self, joint_count: usize) -> Result<Self, CollisionProxyError> {
        if self.joint >= joint_count {
            return Err(CollisionProxyError::JointOutOfBounds {
                joint: self.joint,
                joint_count,
            });
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CollisionProxyError {
    NonFiniteCenter,
    InvalidBoxSize,
    InvalidSphereRadius,
    InvalidCapsuleRadius,
    InvalidCapsuleSegmentLength,
    JointOutOfBounds { joint: usize, joint_count: usize },
}

impl fmt::Display for CollisionProxyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NonFiniteCenter => formatter.write_str("collision proxy center must be finite"),
            Self::InvalidBoxSize => {
                formatter.write_str("collision proxy box size must be finite and strictly positive")
            }
            Self::InvalidSphereRadius => formatter
                .write_str("collision proxy sphere radius must be finite and strictly positive"),
            Self::InvalidCapsuleRadius => formatter
                .write_str("collision proxy capsule radius must be finite and strictly positive"),
            Self::InvalidCapsuleSegmentLength => formatter.write_str(
                "collision proxy capsule segment length must be finite and strictly positive",
            ),
            Self::JointOutOfBounds { joint, joint_count } => write!(
                formatter,
                "collision proxy references joint {joint}, but skeleton has {joint_count} joints"
            ),
        }
    }
}

impl std::error::Error for CollisionProxyError {}

#[derive(Debug, Clone, PartialEq)]
pub struct RiggedAsset {
    skeleton: Skeleton,
    influences: Vec<SkinInfluence>,
    animations: Vec<AnimationClip>,
    collision_proxies: Vec<JointCollisionProxy>,
}

impl RiggedAsset {
    pub fn new(
        skeleton: Skeleton,
        influences: Vec<SkinInfluence>,
        animations: Vec<AnimationClip>,
        collision_proxies: Vec<JointCollisionProxy>,
    ) -> Result<Self, RiggedAssetError> {
        let joint_count = skeleton.joints().len();

        for (vertex, influence) in influences.iter().copied().enumerate() {
            influence
                .validate_joints(joint_count)
                .map_err(|source| RiggedAssetError::InvalidSkinInfluence { vertex, source })?;
        }

        let mut pose = vec![Transform::IDENTITY; joint_count];
        for (clip, animation) in animations.iter().enumerate() {
            animation
                .sample(0.0, &mut pose)
                .map_err(|source| RiggedAssetError::InvalidAnimation { clip, source })?;
        }

        for (proxy, collision_proxy) in collision_proxies.iter().copied().enumerate() {
            collision_proxy
                .validate_joint(joint_count)
                .map_err(|source| RiggedAssetError::InvalidCollisionProxy { proxy, source })?;
        }

        Ok(Self {
            skeleton,
            influences,
            animations,
            collision_proxies,
        })
    }

    pub const fn skeleton(&self) -> &Skeleton {
        &self.skeleton
    }

    pub fn influences(&self) -> &[SkinInfluence] {
        &self.influences
    }

    pub fn animations(&self) -> &[AnimationClip] {
        &self.animations
    }

    pub fn collision_proxies(&self) -> &[JointCollisionProxy] {
        &self.collision_proxies
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RiggedAssetError {
    InvalidSkinInfluence {
        vertex: usize,
        source: SkeletonError,
    },
    InvalidAnimation {
        clip: usize,
        source: ClipError,
    },
    InvalidCollisionProxy {
        proxy: usize,
        source: CollisionProxyError,
    },
}

impl fmt::Display for RiggedAssetError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSkinInfluence { vertex, source } => {
                write!(formatter, "skin influence {vertex} is invalid: {source}")
            }
            Self::InvalidAnimation { clip, source } => {
                write!(
                    formatter,
                    "animation clip {clip} is invalid for this skeleton: {source}"
                )
            }
            Self::InvalidCollisionProxy { proxy, source } => {
                write!(formatter, "collision proxy {proxy} is invalid: {source}")
            }
        }
    }
}

impl std::error::Error for RiggedAssetError {}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CollisionFitOptions {
    pub min_vertices_per_joint: usize,
    pub min_dominant_weight: f32,
    pub padding: f32,
    pub minimum_extent: f32,
    pub sphere_aspect_ratio: f32,
    pub capsule_aspect_ratio: f32,
}

impl Default for CollisionFitOptions {
    fn default() -> Self {
        Self {
            min_vertices_per_joint: 4,
            min_dominant_weight: 0.5,
            padding: 0.01,
            minimum_extent: 0.01,
            sphere_aspect_ratio: 1.25,
            capsule_aspect_ratio: 1.75,
        }
    }
}

impl CollisionFitOptions {
    fn validate(self) -> Result<Self, CollisionFitError> {
        if self.min_vertices_per_joint == 0 {
            return Err(CollisionFitError::InvalidOption {
                field: "min_vertices_per_joint",
            });
        }
        if !self.min_dominant_weight.is_finite() || !(0.0..=1.0).contains(&self.min_dominant_weight)
        {
            return Err(CollisionFitError::InvalidOption {
                field: "min_dominant_weight",
            });
        }
        if !self.padding.is_finite() || self.padding < 0.0 {
            return Err(CollisionFitError::InvalidOption { field: "padding" });
        }
        if !self.minimum_extent.is_finite() || self.minimum_extent <= 0.0 {
            return Err(CollisionFitError::InvalidOption {
                field: "minimum_extent",
            });
        }
        if !self.sphere_aspect_ratio.is_finite() || self.sphere_aspect_ratio < 1.0 {
            return Err(CollisionFitError::InvalidOption {
                field: "sphere_aspect_ratio",
            });
        }
        if !self.capsule_aspect_ratio.is_finite() || self.capsule_aspect_ratio <= 1.0 {
            return Err(CollisionFitError::InvalidOption {
                field: "capsule_aspect_ratio",
            });
        }
        Ok(self)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CollisionFitObservations {
    pub vertex_count: usize,
    pub assigned_vertices: usize,
    pub low_confidence_vertices: usize,
    pub represented_vertices: usize,
    pub unrepresented_assigned_vertices: usize,
    pub represented_joint_count: usize,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CollisionFitResult {
    proxies: Vec<JointCollisionProxy>,
    observations: CollisionFitObservations,
}

impl CollisionFitResult {
    pub fn proxies(&self) -> &[JointCollisionProxy] {
        &self.proxies
    }

    pub const fn observations(&self) -> CollisionFitObservations {
        self.observations
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CollisionFitError {
    VertexInfluenceCountMismatch {
        positions: usize,
        influences: usize,
    },
    InvalidOption {
        field: &'static str,
    },
    NonFinitePosition {
        vertex: usize,
    },
    InvalidSkinInfluence {
        vertex: usize,
        source: SkeletonError,
    },
    NonFiniteJointLocalPosition {
        vertex: usize,
        joint: usize,
    },
    GeneratedProxyInvalid {
        joint: usize,
        source: CollisionProxyError,
    },
}

impl fmt::Display for CollisionFitError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::VertexInfluenceCountMismatch {
                positions,
                influences,
            } => write!(
                formatter,
                "collision fitting received {positions} positions but {influences} skin influences"
            ),
            Self::InvalidOption { field } => {
                write!(formatter, "collision fitting option '{field}' is invalid")
            }
            Self::NonFinitePosition { vertex } => {
                write!(formatter, "bind-pose position {vertex} must be finite")
            }
            Self::InvalidSkinInfluence { vertex, source } => {
                write!(formatter, "skin influence {vertex} is invalid: {source}")
            }
            Self::NonFiniteJointLocalPosition { vertex, joint } => write!(
                formatter,
                "bind-pose position {vertex} became non-finite in joint {joint} local space"
            ),
            Self::GeneratedProxyInvalid { joint, source } => {
                write!(
                    formatter,
                    "generated collision proxy for joint {joint} is invalid: {source}"
                )
            }
        }
    }
}

impl std::error::Error for CollisionFitError {}

#[derive(Debug, Clone, Copy)]
struct Bounds {
    min: Vec3,
    max: Vec3,
    count: usize,
}

impl Bounds {
    const fn first(point: Vec3) -> Self {
        Self {
            min: point,
            max: point,
            count: 1,
        }
    }

    fn include(&mut self, point: Vec3) {
        self.min.x = self.min.x.min(point.x);
        self.min.y = self.min.y.min(point.y);
        self.min.z = self.min.z.min(point.z);
        self.max.x = self.max.x.max(point.x);
        self.max.y = self.max.y.max(point.y);
        self.max.z = self.max.z.max(point.z);
        self.count += 1;
    }

    fn center(self) -> Vec3 {
        (self.min + self.max) * 0.5
    }

    fn padded_size(self, options: CollisionFitOptions) -> Vec3 {
        let raw = self.max - self.min;
        let extra = options.padding * 2.0;
        Vec3::new(
            raw.x.max(options.minimum_extent) + extra,
            raw.y.max(options.minimum_extent) + extra,
            raw.z.max(options.minimum_extent) + extra,
        )
    }
}

pub fn fit_joint_collision_proxies(
    positions: &[Vec3],
    influences: &[SkinInfluence],
    skeleton: &Skeleton,
    options: CollisionFitOptions,
) -> Result<CollisionFitResult, CollisionFitError> {
    if positions.len() != influences.len() {
        return Err(CollisionFitError::VertexInfluenceCountMismatch {
            positions: positions.len(),
            influences: influences.len(),
        });
    }
    let options = options.validate()?;
    let joint_count = skeleton.joints().len();
    let mut bounds = vec![None::<Bounds>; joint_count];
    let mut assigned_vertices = 0usize;
    let mut low_confidence_vertices = 0usize;

    for (vertex, (position, influence)) in positions
        .iter()
        .copied()
        .zip(influences.iter().copied())
        .enumerate()
    {
        if !finite_vec3(position) {
            return Err(CollisionFitError::NonFinitePosition { vertex });
        }
        let influence = influence
            .validate_joints(joint_count)
            .map_err(|source| CollisionFitError::InvalidSkinInfluence { vertex, source })?;
        let (joint, weight) = dominant_joint(influence);
        if weight < options.min_dominant_weight {
            low_confidence_vertices += 1;
            continue;
        }

        let local = skeleton.joints()[joint]
            .inverse_bind
            .transform_point(position);
        if !finite_vec3(local) {
            return Err(CollisionFitError::NonFiniteJointLocalPosition { vertex, joint });
        }

        assigned_vertices += 1;
        match &mut bounds[joint] {
            Some(current) => current.include(local),
            slot @ None => *slot = Some(Bounds::first(local)),
        }
    }

    let mut proxies = Vec::new();
    let mut represented_vertices = 0usize;
    for (joint, joint_bounds) in bounds.into_iter().enumerate() {
        let Some(joint_bounds) = joint_bounds else {
            continue;
        };
        if joint_bounds.count < options.min_vertices_per_joint {
            continue;
        }

        represented_vertices += joint_bounds.count;
        let center = joint_bounds.center();
        let size = joint_bounds.padded_size(options);
        let shape = choose_shape(size, options);
        let proxy = JointCollisionProxy::new(joint, center, shape)
            .map_err(|source| CollisionFitError::GeneratedProxyInvalid { joint, source })?;
        proxies.push(proxy);
    }

    Ok(CollisionFitResult {
        observations: CollisionFitObservations {
            vertex_count: positions.len(),
            assigned_vertices,
            low_confidence_vertices,
            represented_vertices,
            unrepresented_assigned_vertices: assigned_vertices - represented_vertices,
            represented_joint_count: proxies.len(),
        },
        proxies,
    })
}

fn dominant_joint(influence: SkinInfluence) -> (usize, f32) {
    let mut slot = 0usize;
    for candidate in 1..influence.weights.len() {
        if influence.weights[candidate] > influence.weights[slot] {
            slot = candidate;
        }
    }
    (influence.joints[slot] as usize, influence.weights[slot])
}

fn choose_shape(size: Vec3, options: CollisionFitOptions) -> CollisionProxyShape {
    let min_extent = size.x.min(size.y).min(size.z);
    let max_extent = size.x.max(size.y).max(size.z);
    if max_extent / min_extent <= options.sphere_aspect_ratio {
        return CollisionProxyShape::Sphere {
            radius: max_extent * 0.5,
        };
    }

    let lateral_extent = size.x.max(size.z);
    if size.y / lateral_extent >= options.capsule_aspect_ratio {
        let radius = lateral_extent * 0.5;
        return CollisionProxyShape::Capsule {
            radius,
            segment_length: (size.y - radius * 2.0).max(options.minimum_extent),
        };
    }

    CollisionProxyShape::Box { size }
}

fn finite_vec3(value: Vec3) -> bool {
    value.x.is_finite() && value.y.is_finite() && value.z.is_finite()
}

#[cfg(test)]
mod tests {
    use super::*;
    use three_d_animation::{AnimationTrack, Interpolation, Joint, Keyframe, KeyframeTrack, Mat4};

    fn skeleton(inverse_bind: Mat4) -> Skeleton {
        Skeleton::new(vec![Joint {
            parent: None,
            inverse_bind,
        }])
        .expect("fixture skeleton is valid")
    }

    fn rigid_influence(joint: u16) -> SkinInfluence {
        SkinInfluence::new([joint, 0, 0, 0], [1.0, 0.0, 0.0, 0.0])
            .expect("fixture influence is valid")
    }

    fn elongated_vertices(offset_x: f32) -> Vec<Vec3> {
        let mut vertices = Vec::new();
        for x in [-0.2, 0.2] {
            for y in [-1.0, 1.0] {
                for z in [-0.2, 0.2] {
                    vertices.push(Vec3::new(offset_x + x, y, z));
                }
            }
        }
        vertices
    }

    #[test]
    fn fits_local_y_capsule_for_elongated_joint_region() {
        let positions = elongated_vertices(0.0);
        let influences = vec![rigid_influence(0); positions.len()];
        let fitted = fit_joint_collision_proxies(
            &positions,
            &influences,
            &skeleton(Mat4::IDENTITY),
            CollisionFitOptions::default(),
        )
        .expect("fixture collision fit is valid");

        assert_eq!(fitted.proxies().len(), 1);
        assert_eq!(fitted.proxies()[0].joint(), 0);
        assert!(matches!(
            fitted.proxies()[0].shape(),
            CollisionProxyShape::Capsule { .. }
        ));
        assert_eq!(fitted.observations().represented_vertices, positions.len());
    }

    #[test]
    fn fitting_uses_inverse_bind_to_measure_joint_local_bounds() {
        let positions = elongated_vertices(10.0);
        let influences = vec![rigid_influence(0); positions.len()];
        let fitted = fit_joint_collision_proxies(
            &positions,
            &influences,
            &skeleton(Mat4::translation(Vec3::new(-10.0, 0.0, 0.0))),
            CollisionFitOptions::default(),
        )
        .expect("fixture collision fit is valid");

        assert!(fitted.proxies()[0].center().x.abs() < 1.0e-5);
    }

    #[test]
    fn low_confidence_vertices_do_not_create_collision_authority() {
        let positions = elongated_vertices(0.0);
        let influence = SkinInfluence::new([0, 0, 0, 0], [0.4, 0.3, 0.2, 0.1])
            .expect("fixture influence is valid");
        let influences = vec![influence; positions.len()];
        let fitted = fit_joint_collision_proxies(
            &positions,
            &influences,
            &skeleton(Mat4::IDENTITY),
            CollisionFitOptions::default(),
        )
        .expect("fixture collision fit is valid");

        assert!(fitted.proxies().is_empty());
        assert_eq!(
            fitted.observations().low_confidence_vertices,
            positions.len()
        );
        assert_eq!(fitted.observations().assigned_vertices, 0);
    }

    #[test]
    fn rigged_asset_rejects_animation_target_outside_skeleton() {
        let clip = AnimationClip::new(
            "invalid",
            vec![AnimationTrack::Translation {
                node: 1,
                track: KeyframeTrack::new(
                    vec![Keyframe {
                        time: 0.0,
                        value: Vec3::ZERO,
                    }],
                    Interpolation::Linear,
                )
                .expect("fixture track is valid"),
            }],
        )
        .expect("fixture clip is valid");

        assert_eq!(
            RiggedAsset::new(
                skeleton(Mat4::IDENTITY),
                vec![rigid_influence(0)],
                vec![clip],
                vec![],
            ),
            Err(RiggedAssetError::InvalidAnimation {
                clip: 0,
                source: ClipError::NodeOutOfBounds {
                    node: 1,
                    node_count: 1,
                },
            })
        );
    }

    #[test]
    fn rigged_asset_rejects_collision_target_outside_skeleton() {
        let proxy =
            JointCollisionProxy::new(1, Vec3::ZERO, CollisionProxyShape::Sphere { radius: 0.5 })
                .expect("fixture proxy geometry is valid");

        assert_eq!(
            RiggedAsset::new(
                skeleton(Mat4::IDENTITY),
                vec![rigid_influence(0)],
                vec![],
                vec![proxy],
            ),
            Err(RiggedAssetError::InvalidCollisionProxy {
                proxy: 0,
                source: CollisionProxyError::JointOutOfBounds {
                    joint: 1,
                    joint_count: 1,
                },
            })
        );
    }

    #[test]
    fn fitting_rejects_position_influence_length_mismatch() {
        assert_eq!(
            fit_joint_collision_proxies(
                &[Vec3::ZERO],
                &[],
                &skeleton(Mat4::IDENTITY),
                CollisionFitOptions::default(),
            ),
            Err(CollisionFitError::VertexInfluenceCountMismatch {
                positions: 1,
                influences: 0,
            })
        );
    }
}
