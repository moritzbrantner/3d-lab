//! Renderer-independent transform and animation fundamentals for `3d-lab`.
//!
//! This crate owns scene math and animation data, but deliberately does not own
//! rendering, GPU APIs, asset loading, or mesh topology.

use core::fmt;
use core::ops::Mul;
use three_d_core::Vec3;

const EPSILON: f32 = 1.0e-6;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Quat {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

impl Quat {
    pub const IDENTITY: Self = Self::new(0.0, 0.0, 0.0, 1.0);

    pub const fn new(x: f32, y: f32, z: f32, w: f32) -> Self {
        Self { x, y, z, w }
    }

    pub fn dot(self, rhs: Self) -> f32 {
        self.x * rhs.x + self.y * rhs.y + self.z * rhs.z + self.w * rhs.w
    }

    pub fn length(self) -> f32 {
        self.dot(self).sqrt()
    }

    pub fn normalized(self) -> Option<Self> {
        let length = self.length();
        (length > EPSILON).then(|| self.scaled(1.0 / length))
    }

    pub fn from_axis_angle(axis: Vec3, angle_radians: f32) -> Option<Self> {
        let axis = axis.normalized()?;
        let half = angle_radians * 0.5;
        let sine = half.sin();
        Some(Self::new(
            axis.x * sine,
            axis.y * sine,
            axis.z * sine,
            half.cos(),
        ))
    }

    pub fn from_euler_xyz(x_radians: f32, y_radians: f32, z_radians: f32) -> Self {
        let (sx, cx) = (x_radians * 0.5).sin_cos();
        let (sy, cy) = (y_radians * 0.5).sin_cos();
        let (sz, cz) = (z_radians * 0.5).sin_cos();

        Self::new(
            sx * cy * cz + cx * sy * sz,
            cx * sy * cz - sx * cy * sz,
            cx * cy * sz + sx * sy * cz,
            cx * cy * cz - sx * sy * sz,
        )
        .normalized()
        .unwrap_or(Self::IDENTITY)
    }

    pub fn slerp(self, rhs: Self, factor: f32) -> Self {
        let start = self.normalized().unwrap_or(Self::IDENTITY);
        let mut end = rhs.normalized().unwrap_or(Self::IDENTITY);
        let mut cosine = start.dot(end);

        if cosine < 0.0 {
            cosine = -cosine;
            end = end.scaled(-1.0);
        }

        let factor = factor.clamp(0.0, 1.0);
        if cosine > 0.9995 {
            return start
                .scaled(1.0 - factor)
                .added(end.scaled(factor))
                .normalized()
                .unwrap_or(Self::IDENTITY);
        }

        let theta = cosine.clamp(-1.0, 1.0).acos();
        let sine = theta.sin();
        if sine.abs() <= EPSILON {
            return start;
        }

        start
            .scaled(((1.0 - factor) * theta).sin() / sine)
            .added(end.scaled((factor * theta).sin() / sine))
            .normalized()
            .unwrap_or(Self::IDENTITY)
    }

    fn scaled(self, scalar: f32) -> Self {
        Self::new(
            self.x * scalar,
            self.y * scalar,
            self.z * scalar,
            self.w * scalar,
        )
    }

    fn added(self, rhs: Self) -> Self {
        Self::new(
            self.x + rhs.x,
            self.y + rhs.y,
            self.z + rhs.z,
            self.w + rhs.w,
        )
    }
}

impl Default for Quat {
    fn default() -> Self {
        Self::IDENTITY
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Mat4 {
    /// Column-major elements, matching conventional GPU and Three.js layout.
    pub elements: [f32; 16],
}

impl Mat4 {
    pub const IDENTITY: Self = Self {
        elements: [
            1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ],
    };

    pub const fn translation(value: Vec3) -> Self {
        Self {
            elements: [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, value.x, value.y,
                value.z, 1.0,
            ],
        }
    }

    pub const fn scale(value: Vec3) -> Self {
        Self {
            elements: [
                value.x, 0.0, 0.0, 0.0, 0.0, value.y, 0.0, 0.0, 0.0, 0.0, value.z, 0.0, 0.0, 0.0,
                0.0, 1.0,
            ],
        }
    }

    pub fn rotation(rotation: Quat) -> Self {
        let q = rotation.normalized().unwrap_or(Quat::IDENTITY);
        let x2 = q.x + q.x;
        let y2 = q.y + q.y;
        let z2 = q.z + q.z;
        let xx = q.x * x2;
        let xy = q.x * y2;
        let xz = q.x * z2;
        let yy = q.y * y2;
        let yz = q.y * z2;
        let zz = q.z * z2;
        let wx = q.w * x2;
        let wy = q.w * y2;
        let wz = q.w * z2;

        Self {
            elements: [
                1.0 - (yy + zz),
                xy + wz,
                xz - wy,
                0.0,
                xy - wz,
                1.0 - (xx + zz),
                yz + wx,
                0.0,
                xz + wy,
                yz - wx,
                1.0 - (xx + yy),
                0.0,
                0.0,
                0.0,
                0.0,
                1.0,
            ],
        }
    }

    pub fn trs(translation: Vec3, rotation: Quat, scale: Vec3) -> Self {
        Self::translation(translation) * Self::rotation(rotation) * Self::scale(scale)
    }

    pub fn transform_point(self, point: Vec3) -> Vec3 {
        let m = self.elements;
        Vec3::new(
            m[0] * point.x + m[4] * point.y + m[8] * point.z + m[12],
            m[1] * point.x + m[5] * point.y + m[9] * point.z + m[13],
            m[2] * point.x + m[6] * point.y + m[10] * point.z + m[14],
        )
    }
}

impl Default for Mat4 {
    fn default() -> Self {
        Self::IDENTITY
    }
}

impl Mul for Mat4 {
    type Output = Self;

    fn mul(self, rhs: Self) -> Self::Output {
        let mut elements = [0.0; 16];
        for column in 0..4 {
            for row in 0..4 {
                elements[column * 4 + row] = (0..4)
                    .map(|index| self.elements[index * 4 + row] * rhs.elements[column * 4 + index])
                    .sum();
            }
        }
        Self { elements }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Transform {
    pub translation: Vec3,
    pub rotation: Quat,
    pub scale: Vec3,
}

impl Transform {
    pub const IDENTITY: Self = Self {
        translation: Vec3::ZERO,
        rotation: Quat::IDENTITY,
        scale: Vec3::new(1.0, 1.0, 1.0),
    };

    pub fn matrix(self) -> Mat4 {
        Mat4::trs(self.translation, self.rotation, self.scale)
    }
}

impl Default for Transform {
    fn default() -> Self {
        Self::IDENTITY
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TransformNode {
    pub parent: Option<usize>,
    pub local: Transform,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HierarchyError {
    ParentMustPrecedeChild { node: usize, parent: usize },
}

impl fmt::Display for HierarchyError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ParentMustPrecedeChild { node, parent } => write!(
                formatter,
                "node {node} references parent {parent}; parents must appear before children"
            ),
        }
    }
}

impl std::error::Error for HierarchyError {}

pub fn world_matrices(nodes: &[TransformNode]) -> Result<Vec<Mat4>, HierarchyError> {
    let mut world = Vec::with_capacity(nodes.len());
    for (node_index, node) in nodes.iter().enumerate() {
        let local = node.local.matrix();
        let matrix = match node.parent {
            Some(parent) if parent >= node_index => {
                return Err(HierarchyError::ParentMustPrecedeChild {
                    node: node_index,
                    parent,
                });
            }
            Some(parent) => world[parent] * local,
            None => local,
        };
        world.push(matrix);
    }
    Ok(world)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Interpolation {
    Linear,
    SmoothStep,
}

impl Interpolation {
    fn map(self, factor: f32) -> f32 {
        let factor = factor.clamp(0.0, 1.0);
        match self {
            Self::Linear => factor,
            Self::SmoothStep => factor * factor * (3.0 - 2.0 * factor),
        }
    }
}

pub trait Interpolate: Copy {
    fn interpolate(self, rhs: Self, factor: f32) -> Self;
}

impl Interpolate for f32 {
    fn interpolate(self, rhs: Self, factor: f32) -> Self {
        self + (rhs - self) * factor
    }
}

impl Interpolate for Vec3 {
    fn interpolate(self, rhs: Self, factor: f32) -> Self {
        self * (1.0 - factor) + rhs * factor
    }
}

impl Interpolate for Quat {
    fn interpolate(self, rhs: Self, factor: f32) -> Self {
        self.slerp(rhs, factor)
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Keyframe<T> {
    pub time: f32,
    pub value: T,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TrackError {
    Empty,
    NonFiniteTime { index: usize },
    TimesNotStrictlyIncreasing { index: usize },
}

impl fmt::Display for TrackError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => {
                formatter.write_str("a keyframe track must contain at least one keyframe")
            }
            Self::NonFiniteTime { index } => {
                write!(formatter, "keyframe {index} has a non-finite time")
            }
            Self::TimesNotStrictlyIncreasing { index } => write!(
                formatter,
                "keyframe {index} does not occur after the previous keyframe"
            ),
        }
    }
}

impl std::error::Error for TrackError {}

#[derive(Debug, Clone, PartialEq)]
pub struct KeyframeTrack<T> {
    frames: Vec<Keyframe<T>>,
    interpolation: Interpolation,
}

impl<T: Copy> KeyframeTrack<T> {
    pub fn new(frames: Vec<Keyframe<T>>, interpolation: Interpolation) -> Result<Self, TrackError> {
        if frames.is_empty() {
            return Err(TrackError::Empty);
        }
        for (index, frame) in frames.iter().enumerate() {
            if !frame.time.is_finite() {
                return Err(TrackError::NonFiniteTime { index });
            }
            if index > 0 && frame.time <= frames[index - 1].time {
                return Err(TrackError::TimesNotStrictlyIncreasing { index });
            }
        }
        Ok(Self {
            frames,
            interpolation,
        })
    }

    pub fn frames(&self) -> &[Keyframe<T>] {
        &self.frames
    }

    pub fn end_time(&self) -> f32 {
        self.frames.last().expect("validated non-empty track").time
    }
}

impl<T: Interpolate> KeyframeTrack<T> {
    pub fn sample(&self, time: f32) -> T {
        let first = self.frames[0];
        if time <= first.time {
            return first.value;
        }
        let last = self.frames[self.frames.len() - 1];
        if time >= last.time {
            return last.value;
        }
        let pair = self
            .frames
            .windows(2)
            .find(|pair| time <= pair[1].time)
            .expect("time is inside validated track range");
        let start = pair[0];
        let end = pair[1];
        let factor = (time - start.time) / (end.time - start.time);
        start
            .value
            .interpolate(end.value, self.interpolation.map(factor))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum AnimationTrack {
    Translation {
        node: usize,
        track: KeyframeTrack<Vec3>,
    },
    Rotation {
        node: usize,
        track: KeyframeTrack<Quat>,
    },
    Scale {
        node: usize,
        track: KeyframeTrack<Vec3>,
    },
}

impl AnimationTrack {
    fn node(&self) -> usize {
        match self {
            Self::Translation { node, .. }
            | Self::Rotation { node, .. }
            | Self::Scale { node, .. } => *node,
        }
    }

    fn end_time(&self) -> f32 {
        match self {
            Self::Translation { track, .. } | Self::Scale { track, .. } => track.end_time(),
            Self::Rotation { track, .. } => track.end_time(),
        }
    }

    fn sample_into(&self, time: f32, transform: &mut Transform) {
        match self {
            Self::Translation { track, .. } => transform.translation = track.sample(time),
            Self::Rotation { track, .. } => transform.rotation = track.sample(time),
            Self::Scale { track, .. } => transform.scale = track.sample(time),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClipError {
    EmptyTracks,
    NodeOutOfBounds { node: usize, node_count: usize },
}

impl fmt::Display for ClipError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyTracks => {
                formatter.write_str("an animation clip must contain at least one track")
            }
            Self::NodeOutOfBounds { node, node_count } => write!(
                formatter,
                "animation track targets node {node}, but pose has only {node_count} nodes"
            ),
        }
    }
}

impl std::error::Error for ClipError {}

#[derive(Debug, Clone, PartialEq)]
pub struct AnimationClip {
    name: String,
    duration: f32,
    tracks: Vec<AnimationTrack>,
}

impl AnimationClip {
    pub fn new(name: impl Into<String>, tracks: Vec<AnimationTrack>) -> Result<Self, ClipError> {
        if tracks.is_empty() {
            return Err(ClipError::EmptyTracks);
        }
        let duration = tracks
            .iter()
            .map(AnimationTrack::end_time)
            .fold(0.0_f32, f32::max);
        Ok(Self {
            name: name.into(),
            duration,
            tracks,
        })
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn duration(&self) -> f32 {
        self.duration
    }

    pub fn sample(&self, time: f32, pose: &mut [Transform]) -> Result<(), ClipError> {
        let node_count = pose.len();
        for track in &self.tracks {
            let node = track.node();
            let transform = pose
                .get_mut(node)
                .ok_or(ClipError::NodeOutOfBounds { node, node_count })?;
            track.sample_into(time.clamp(0.0, self.duration), transform);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Joint {
    pub parent: Option<usize>,
    pub inverse_bind: Mat4,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SkeletonError {
    ParentMustPrecedeChild { joint: usize, parent: usize },
    MatrixCountMismatch { expected: usize, actual: usize },
    InvalidWeight { slot: usize },
    ZeroTotalWeight,
    JointIndexOutOfBounds { joint: u16, joint_count: usize },
}

impl fmt::Display for SkeletonError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ParentMustPrecedeChild { joint, parent } => write!(
                formatter,
                "joint {joint} references parent {parent}; parents must appear before children"
            ),
            Self::MatrixCountMismatch { expected, actual } => write!(
                formatter,
                "skeleton expects {expected} joint matrices, received {actual}"
            ),
            Self::InvalidWeight { slot } => write!(formatter, "skin weight slot {slot} is invalid"),
            Self::ZeroTotalWeight => formatter.write_str("skin weights must have a positive total"),
            Self::JointIndexOutOfBounds { joint, joint_count } => write!(
                formatter,
                "skin influence references joint {joint}, but skeleton has {joint_count} joints"
            ),
        }
    }
}

impl std::error::Error for SkeletonError {}

#[derive(Debug, Clone, PartialEq)]
pub struct Skeleton {
    joints: Vec<Joint>,
}

impl Skeleton {
    pub fn new(joints: Vec<Joint>) -> Result<Self, SkeletonError> {
        for (joint_index, joint) in joints.iter().enumerate() {
            if let Some(parent) = joint.parent {
                if parent >= joint_index {
                    return Err(SkeletonError::ParentMustPrecedeChild {
                        joint: joint_index,
                        parent,
                    });
                }
            }
        }
        Ok(Self { joints })
    }

    pub fn joints(&self) -> &[Joint] {
        &self.joints
    }

    pub fn skin_matrices(&self, joint_world: &[Mat4]) -> Result<Vec<Mat4>, SkeletonError> {
        if joint_world.len() != self.joints.len() {
            return Err(SkeletonError::MatrixCountMismatch {
                expected: self.joints.len(),
                actual: joint_world.len(),
            });
        }
        Ok(self
            .joints
            .iter()
            .zip(joint_world)
            .map(|(joint, world)| *world * joint.inverse_bind)
            .collect())
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SkinInfluence {
    pub joints: [u16; 4],
    pub weights: [f32; 4],
}

impl SkinInfluence {
    pub fn new(joints: [u16; 4], weights: [f32; 4]) -> Result<Self, SkeletonError> {
        for (slot, weight) in weights.iter().enumerate() {
            if !weight.is_finite() || *weight < 0.0 {
                return Err(SkeletonError::InvalidWeight { slot });
            }
        }
        let total: f32 = weights.iter().sum();
        if total <= EPSILON {
            return Err(SkeletonError::ZeroTotalWeight);
        }
        Ok(Self {
            joints,
            weights: weights.map(|weight| weight / total),
        })
    }

    pub fn validate_joints(self, joint_count: usize) -> Result<Self, SkeletonError> {
        for (&joint, weight) in self.joints.iter().zip(self.weights) {
            if weight > 0.0 && joint as usize >= joint_count {
                return Err(SkeletonError::JointIndexOutOfBounds { joint, joint_count });
            }
        }
        Ok(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::f32::consts::{FRAC_PI_2, PI};

    fn assert_vec3_close(actual: Vec3, expected: Vec3) {
        assert!((actual.x - expected.x).abs() < 1.0e-4, "x: {actual:?}");
        assert!((actual.y - expected.y).abs() < 1.0e-4, "y: {actual:?}");
        assert!((actual.z - expected.z).abs() < 1.0e-4, "z: {actual:?}");
    }

    #[test]
    fn trs_applies_scale_then_rotation_then_translation() {
        let rotation = Quat::from_axis_angle(Vec3::new(0.0, 0.0, 1.0), FRAC_PI_2).unwrap();
        let transform = Transform {
            translation: Vec3::new(2.0, 3.0, 4.0),
            rotation,
            scale: Vec3::new(2.0, 1.0, 1.0),
        };
        assert_vec3_close(
            transform.matrix().transform_point(Vec3::new(1.0, 0.0, 0.0)),
            Vec3::new(2.0, 5.0, 4.0),
        );
    }

    #[test]
    fn hierarchy_multiplies_parent_world_by_child_local() {
        let nodes = [
            TransformNode {
                parent: None,
                local: Transform {
                    translation: Vec3::new(1.0, 0.0, 0.0),
                    ..Transform::IDENTITY
                },
            },
            TransformNode {
                parent: Some(0),
                local: Transform {
                    translation: Vec3::new(0.0, 2.0, 0.0),
                    ..Transform::IDENTITY
                },
            },
        ];
        let world = world_matrices(&nodes).unwrap();
        assert_vec3_close(
            world[1].transform_point(Vec3::ZERO),
            Vec3::new(1.0, 2.0, 0.0),
        );
    }

    #[test]
    fn hierarchy_rejects_forward_parent_references() {
        let nodes = [TransformNode {
            parent: Some(0),
            local: Transform::IDENTITY,
        }];
        assert_eq!(
            world_matrices(&nodes),
            Err(HierarchyError::ParentMustPrecedeChild { node: 0, parent: 0 })
        );
    }

    #[test]
    fn quaternion_slerp_takes_a_smooth_midpoint() {
        let end = Quat::from_axis_angle(Vec3::new(0.0, 0.0, 1.0), FRAC_PI_2).unwrap();
        let rotated = Mat4::rotation(Quat::IDENTITY.slerp(end, 0.5))
            .transform_point(Vec3::new(1.0, 0.0, 0.0));
        let half_sqrt_two = core::f32::consts::FRAC_1_SQRT_2;
        assert_vec3_close(rotated, Vec3::new(half_sqrt_two, half_sqrt_two, 0.0));
    }

    #[test]
    fn smoothstep_changes_keyframe_easing_without_changing_endpoints() {
        let track = KeyframeTrack::new(
            vec![
                Keyframe {
                    time: 0.0,
                    value: 0.0,
                },
                Keyframe {
                    time: 1.0,
                    value: 10.0,
                },
            ],
            Interpolation::SmoothStep,
        )
        .unwrap();
        assert!((track.sample(0.25) - 1.5625).abs() < 1.0e-5);
        assert_eq!(track.sample(-1.0), 0.0);
        assert_eq!(track.sample(2.0), 10.0);
    }

    #[test]
    fn keyframe_tracks_reject_unsorted_times() {
        let track = KeyframeTrack::new(
            vec![
                Keyframe {
                    time: 1.0,
                    value: 1.0,
                },
                Keyframe {
                    time: 1.0,
                    value: 2.0,
                },
            ],
            Interpolation::Linear,
        );
        assert_eq!(
            track,
            Err(TrackError::TimesNotStrictlyIncreasing { index: 1 })
        );
    }

    #[test]
    fn animation_clip_samples_multiple_transform_channels() {
        let translation = KeyframeTrack::new(
            vec![
                Keyframe {
                    time: 0.0,
                    value: Vec3::ZERO,
                },
                Keyframe {
                    time: 2.0,
                    value: Vec3::new(2.0, 0.0, 0.0),
                },
            ],
            Interpolation::Linear,
        )
        .unwrap();
        let rotation = KeyframeTrack::new(
            vec![
                Keyframe {
                    time: 0.0,
                    value: Quat::IDENTITY,
                },
                Keyframe {
                    time: 2.0,
                    value: Quat::from_axis_angle(Vec3::new(0.0, 1.0, 0.0), PI).unwrap(),
                },
            ],
            Interpolation::Linear,
        )
        .unwrap();
        let clip = AnimationClip::new(
            "move-and-turn",
            vec![
                AnimationTrack::Translation {
                    node: 0,
                    track: translation,
                },
                AnimationTrack::Rotation {
                    node: 0,
                    track: rotation,
                },
            ],
        )
        .unwrap();
        let mut pose = [Transform::IDENTITY];
        clip.sample(1.0, &mut pose).unwrap();
        assert_vec3_close(pose[0].translation, Vec3::new(1.0, 0.0, 0.0));
        assert_eq!(clip.name(), "move-and-turn");
        assert_eq!(clip.duration(), 2.0);
    }

    #[test]
    fn skin_influences_validate_every_active_joint() {
        let influence = SkinInfluence::new([0, 1, 0, 0], [3.0, 1.0, 0.0, 0.0]).unwrap();
        assert!((influence.weights[0] - 0.75).abs() < EPSILON);
        assert_eq!(influence.validate_joints(2), Ok(influence));
        assert_eq!(
            SkinInfluence::new([0, 2, 0, 0], [0.5, 0.5, 0.0, 0.0])
                .unwrap()
                .validate_joints(2),
            Err(SkeletonError::JointIndexOutOfBounds {
                joint: 2,
                joint_count: 2
            })
        );
    }

    #[test]
    fn skeleton_builds_skin_matrices_from_world_and_inverse_bind() {
        let skeleton = Skeleton::new(vec![
            Joint {
                parent: None,
                inverse_bind: Mat4::translation(Vec3::new(0.0, 1.0, 0.0)),
            },
            Joint {
                parent: Some(0),
                inverse_bind: Mat4::IDENTITY,
            },
        ])
        .unwrap();
        let matrices = skeleton
            .skin_matrices(&[
                Mat4::translation(Vec3::new(0.0, -1.0, 0.0)),
                Mat4::translation(Vec3::new(2.0, 0.0, 0.0)),
            ])
            .unwrap();
        assert_vec3_close(matrices[0].transform_point(Vec3::ZERO), Vec3::ZERO);
        assert_vec3_close(
            matrices[1].transform_point(Vec3::ZERO),
            Vec3::new(2.0, 0.0, 0.0),
        );
    }
}
