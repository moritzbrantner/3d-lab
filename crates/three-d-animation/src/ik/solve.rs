use core::f32::consts::PI;

use three_d_core::Vec3;

use crate::retarget::{finite_quat, finite_vec3, quat_conjugate, quat_mul};
use crate::{Mat4, Quat, Transform};

use super::goal::{EndEffector, IkGoal, IkLayer, TwoBoneChain};
use super::math::{angle_between, position, rotate};
use super::rig::IkRig;
use super::{EPSILON, IkError, MAX_IK_LAYERS, MAX_LOOK_AT_JOINTS};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IkStatus {
    /// Weight was zero; the pose was not touched.
    Skipped,
    /// The full-strength solution reaches the target.
    Reached,
    /// The target was out of reach or beyond the angle limit, or the chain's
    /// joint weights left part of the aim unapplied; the solution was clamped
    /// to the closest permitted pose.
    Clamped,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IkLayerOutcome {
    pub status: IkStatus,
    /// Distance from tip to target (limbs) or remaining aim angle in radians
    /// (look-at) after weighting.
    pub residual: f32,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IkSolveStats {
    pub layers_applied: usize,
    pub layers_skipped: usize,
    pub layers_clamped: usize,
    pub joints_written: usize,
    pub world_nodes_updated: usize,
}

/// Reusable scratch storage; a solve performs no heap allocation. Clones keep
/// room for [`MAX_IK_LAYERS`] outcomes so they uphold the same contract.
#[derive(Debug, PartialEq)]
pub struct IkWorkspace {
    pub(super) world: Vec<Mat4>,
    pub(super) world_rotation: Vec<Quat>,
    pub(super) outcomes: Vec<IkLayerOutcome>,
}

impl Clone for IkWorkspace {
    fn clone(&self) -> Self {
        let mut outcomes = Vec::with_capacity(MAX_IK_LAYERS.max(self.outcomes.len()));
        outcomes.extend_from_slice(&self.outcomes);
        Self {
            world: self.world.clone(),
            world_rotation: self.world_rotation.clone(),
            outcomes,
        }
    }
}

impl IkWorkspace {
    pub fn new(node_count: usize) -> Self {
        Self {
            world: vec![Mat4::IDENTITY; node_count],
            world_rotation: vec![Quat::IDENTITY; node_count],
            outcomes: Vec::with_capacity(MAX_IK_LAYERS),
        }
    }

    /// Outcomes of the most recent solve, one per layer in order.
    pub fn outcomes(&self) -> &[IkLayerOutcome] {
        &self.outcomes
    }

    /// Character-space position of `joint` in the most recent solved pose.
    pub fn world_position(&self, joint: usize) -> Option<Vec3> {
        self.world.get(joint).map(|matrix| position(*matrix))
    }

    /// Character-space rotation of `joint` in the most recent solved pose.
    pub fn world_rotation(&self, joint: usize) -> Option<Quat> {
        self.world_rotation.get(joint).copied()
    }

    /// Copies `base_pose` into `output` and applies `layers` in order.
    /// `base_pose` is only read, so sampled clips and cached poses remain the
    /// authoritative base animation.
    pub fn solve(
        &mut self,
        rig: &IkRig,
        base_pose: &[Transform],
        layers: &[IkLayer<'_>],
        output: &mut [Transform],
    ) -> Result<IkSolveStats, IkError> {
        let node_count = rig.node_count();
        for actual in [base_pose.len(), output.len(), self.world.len()] {
            if actual != node_count {
                return Err(IkError::PoseLengthMismatch {
                    expected: node_count,
                    actual,
                });
            }
        }
        if layers.len() > MAX_IK_LAYERS {
            return Err(IkError::TooManyLayers {
                count: layers.len(),
                max: MAX_IK_LAYERS,
            });
        }
        for (index, layer) in layers.iter().enumerate() {
            validate_layer(rig, index, layer)?;
        }
        // Sampled clips and public transforms do not forbid NaN/infinity; reject
        // them here instead of letting limb math produce NaN reach bounds.
        if let Some(node) = base_pose.iter().position(|transform| {
            !finite_vec3(transform.translation)
                || !finite_quat(transform.rotation)
                || !finite_vec3(transform.scale)
        }) {
            return Err(IkError::NonFiniteBasePose { node });
        }

        output.copy_from_slice(base_pose);
        self.outcomes.clear();
        let mut stats = IkSolveStats {
            world_nodes_updated: self.refresh(rig, output, 0),
            ..IkSolveStats::default()
        };

        for (index, layer) in layers.iter().enumerate() {
            if layer.weight <= 0.0 {
                stats.layers_skipped += 1;
                self.outcomes.push(IkLayerOutcome {
                    status: IkStatus::Skipped,
                    residual: self.residual(&layer.goal),
                });
                continue;
            }
            let mut snapshot = Snapshot::default();
            for &joint in affected_joints(&layer.goal).as_slice() {
                snapshot.push(joint, output[joint].rotation);
            }
            // The look-at limit is measured against the aim before this layer.
            let mut look_at = None;
            let status = match layer.goal {
                IkGoal::Limb(goal) => self.solve_limb(rig, output, &goal, index, &mut stats)?,
                IkGoal::LookAt(goal) => {
                    // Overflowed positions would make every aim direction
                    // unnormalizable and silently read as zero angle.
                    if goal
                        .chain
                        .joints()
                        .iter()
                        .any(|&joint| !finite_vec3(self.position(joint)))
                    {
                        return Err(IkError::NonFiniteWorldPose { layer: index });
                    }
                    let initial = self.aim_direction(&goal.chain);
                    look_at = Some((goal, initial));
                    self.solve_look_at(rig, output, &goal, initial, &mut stats)
                }
            };

            let mut solved = Snapshot::default();
            let mut first_blended = usize::MAX;
            for &(joint, original) in snapshot.as_slice() {
                let factor = layer_factor(layer, joint);
                let rotation = output[joint].rotation;
                solved.push(joint, rotation);
                output[joint].rotation = blend_rotation(original, rotation, factor);
                if output[joint].rotation != rotation {
                    first_blended = first_blended.min(joint);
                }
                stats.joints_written += 1;
            }
            if first_blended != usize::MAX {
                // Scaling the blend can also move joints that were fully
                // applied, so the refresh then starts at the first chain joint.
                if let Some((goal, initial)) = look_at
                    && self.limit_blended_look_at(
                        rig, output, &goal, initial, layer, &snapshot, &solved,
                    )
                {
                    first_blended = first_blended.min(goal.chain.joints()[0]);
                }
                stats.world_nodes_updated += self.refresh(rig, output, first_blended);
            }

            if status == IkStatus::Clamped {
                stats.layers_clamped += 1;
            }
            stats.layers_applied += 1;
            self.outcomes.push(IkLayerOutcome {
                status,
                residual: self.residual(&layer.goal),
            });
        }
        Ok(stats)
    }

    pub(super) fn refresh(&mut self, rig: &IkRig, pose: &[Transform], from: usize) -> usize {
        for (node, transform) in pose.iter().enumerate().skip(from) {
            // Same matrix as `transform.matrix()`, without normalizing twice.
            let rotation = transform.rotation.normalized().unwrap_or(Quat::IDENTITY);
            let local = Mat4::translation(transform.translation)
                * Mat4::rotation_unit(rotation)
                * Mat4::scale(transform.scale);
            match rig.parents[node] {
                Some(parent) => {
                    self.world[node] = self.world[parent] * local;
                    self.world_rotation[node] = quat_mul(self.world_rotation[parent], rotation);
                }
                None => {
                    self.world[node] = local;
                    self.world_rotation[node] = rotation;
                }
            }
        }
        pose.len().saturating_sub(from)
    }

    pub(super) fn position(&self, joint: usize) -> Vec3 {
        position(self.world[joint])
    }

    /// Applies a character-space rotation delta to `joint`'s local rotation.
    pub(super) fn rotate_world(
        &self,
        rig: &IkRig,
        pose: &mut [Transform],
        joint: usize,
        delta: Quat,
    ) {
        let parent = rig
            .parent(joint)
            .map_or(Quat::IDENTITY, |parent| self.world_rotation[parent]);
        let local_delta = quat_mul(quat_mul(quat_conjugate(parent), delta), parent);
        // An unnormalizable base rotation is identity, as in `refresh`, `Mat4::rotation` and
        // `Quat::slerp`; multiplying a zero quaternion would leave the joint unable to rotate.
        let base = pose[joint].rotation.normalized().unwrap_or(Quat::IDENTITY);
        pose[joint].rotation = quat_mul(local_delta, base);
    }

    fn residual(&self, goal: &IkGoal) -> f32 {
        match goal {
            IkGoal::Limb(goal) => (self.position(goal.chain.tip) - goal.target).length(),
            IkGoal::LookAt(goal) => {
                let aim = goal.chain.aim_joint();
                let forward = rotate(self.world_rotation[aim], goal.chain.forward);
                (goal.target - self.position(aim))
                    .normalized()
                    .map_or(0.0, |desired| angle_between(forward, desired))
            }
        }
    }
}

fn validate_layer(rig: &IkRig, index: usize, layer: &IkLayer<'_>) -> Result<(), IkError> {
    if !layer.weight.is_finite() || !(0.0..=1.0).contains(&layer.weight) {
        return Err(IkError::InvalidLayerWeight { layer: index });
    }
    if let Some(mask) = layer.mask
        && mask.weights.len() != rig.node_count()
    {
        return Err(IkError::MaskLengthMismatch {
            layer: index,
            expected: rig.node_count(),
            actual: mask.weights.len(),
        });
    }
    for &joint in affected_joints(&layer.goal).as_slice() {
        rig.check(joint)?;
    }
    // Chains only carry indices, so recheck their ancestry against the rig
    // used for this solve; a chain built for another topology must not rotate
    // unrelated joints.
    match &layer.goal {
        IkGoal::Limb(goal) => {
            let TwoBoneChain { root, mid, tip } = goal.chain;
            rig.require_descendant(root, mid)?;
            rig.require_descendant(mid, tip)?;
        }
        IkGoal::LookAt(goal) => {
            for pair in goal.chain.joints().windows(2) {
                rig.require_descendant(pair[0], pair[1])?;
            }
        }
    }
    let invalid = IkError::InvalidTarget { layer: index };
    match layer.goal {
        IkGoal::Limb(goal) => {
            if !finite_vec3(goal.target) || goal.pole.is_some_and(|pole| !finite_vec3(pole)) {
                return Err(invalid);
            }
            if !goal.max_reach.is_finite() || goal.max_reach <= 0.0 || goal.max_reach > 1.0 {
                return Err(IkError::InvalidChainParameter);
            }
            match goal.end {
                EndEffector::KeepLocal => {}
                EndEffector::Orientation(orientation) => {
                    if !finite_quat(orientation) || orientation.length() <= EPSILON {
                        return Err(invalid);
                    }
                }
                EndEffector::AlignAxis {
                    local_axis,
                    direction,
                } => {
                    let usable = |value: Vec3| finite_vec3(value) && value.length() > EPSILON;
                    if !usable(local_axis) || !usable(direction) {
                        return Err(invalid);
                    }
                }
            }
        }
        IkGoal::LookAt(goal) => {
            if !finite_vec3(goal.target) {
                return Err(invalid);
            }
            if !goal.max_angle.is_finite() || !(0.0..=PI).contains(&goal.max_angle) {
                return Err(IkError::InvalidChainParameter);
            }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, Default)]
pub(super) struct Snapshot {
    entries: [(usize, Quat); MAX_LOOK_AT_JOINTS],
    len: usize,
}

impl Snapshot {
    pub(super) fn push(&mut self, joint: usize, rotation: Quat) {
        self.entries[self.len] = (joint, rotation);
        self.len += 1;
    }

    pub(super) fn as_slice(&self) -> &[(usize, Quat)] {
        &self.entries[..self.len]
    }
}

#[derive(Debug, Clone, Copy)]
struct JointList {
    joints: [usize; MAX_LOOK_AT_JOINTS],
    len: usize,
}

impl JointList {
    pub(super) fn as_slice(&self) -> &[usize] {
        &self.joints[..self.len]
    }
}

pub(super) fn layer_factor(layer: &IkLayer<'_>, joint: usize) -> f32 {
    layer.weight * layer.mask.map_or(1.0, |mask| mask.weight(joint))
}

pub(super) fn blend_rotation(original: Quat, solved: Quat, factor: f32) -> Quat {
    if factor >= 1.0 {
        solved
    } else if factor <= 0.0 {
        original
    } else {
        original.slerp(solved, factor)
    }
}

fn affected_joints(goal: &IkGoal) -> JointList {
    match goal {
        IkGoal::Limb(goal) => JointList {
            joints: [goal.chain.root, goal.chain.mid, goal.chain.tip, 0],
            len: 3,
        },
        IkGoal::LookAt(goal) => JointList {
            joints: goal.chain.joints,
            len: goal.chain.len,
        },
    }
}
