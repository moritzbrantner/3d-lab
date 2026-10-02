//! Layered post-sampling inverse kinematics.
//!
//! IK corrects an already sampled base pose: callers sample clips (or blends)
//! into a pose, then [`IkWorkspace::solve`] copies that pose into a separate
//! output and applies weighted, masked layers in the exact order given. The
//! base pose and every source clip stay untouched.
//!
//! All targets are explicit inputs in the pose's model/character space (the
//! space produced by evaluating root nodes without an external parent). This
//! module never queries physics, ground, or gameplay state: consumers convert
//! world contacts, aim points, and grip frames into character space first.
//!
//! Work is bounded: every layer is analytical (two-bone limbs) or a single pass
//! over at most [`MAX_LOOK_AT_JOINTS`] joints, at most [`MAX_IK_LAYERS`] layers
//! are accepted per solve, and world transforms are refreshed only from the
//! first joint a step changed. Rotations are applied as world-space deltas, so
//! ancestors of a solved chain are expected to carry uniform scale.

use core::f32::consts::PI;
use core::fmt;

use three_d_core::Vec3;

use crate::retarget::{finite_quat, finite_vec3, quat_conjugate, quat_mul};
use crate::{Mat4, Quat, Skeleton, Transform};

/// Maximum number of layers one solve accepts.
pub const MAX_IK_LAYERS: usize = 16;
/// Maximum number of joints in one look-at chain.
pub const MAX_LOOK_AT_JOINTS: usize = 4;
/// Upper bound on hierarchy refresh passes per applied layer. Each pass visits
/// at most every node once, so one solve visits at most
/// `node_count * (1 + layers * MAX_WORLD_PASSES_PER_LAYER)` nodes.
pub const MAX_WORLD_PASSES_PER_LAYER: usize = MAX_LOOK_AT_JOINTS + 2;

const EPSILON: f32 = 1.0e-6;
const REACH_TOLERANCE: f32 = 1.0e-4;
/// Remaining aim angle (radians) below which a look-at layer counts as reached.
const LOOK_AT_ANGLE_TOLERANCE: f32 = 1.0e-3;
/// Fixed bisection steps used to scale a blended look-at layer back inside
/// its angle cap. Each step composes only the chain's local rotations (no
/// hierarchy refresh), so the work stays bounded and allocation-free.
const LOOK_AT_BLEND_SCALE_STEPS: usize = 20;
/// Slack applied to the inclusive minimum reach fraction so a fraction
/// computed exactly as `|upper - lower| / (upper + lower)` still solves despite
/// `f32` rounding.
pub const MIN_REACH_FRACTION_TOLERANCE: f32 = 1.0e-5;

#[derive(Debug, Clone, PartialEq)]
pub enum IkError {
    ParentMustPrecedeChild {
        node: usize,
        parent: usize,
    },
    JointOutOfBounds {
        joint: usize,
        node_count: usize,
    },
    NotDescendant {
        ancestor: usize,
        joint: usize,
    },
    EmptyLookAtChain,
    LookAtChainTooLong {
        len: usize,
        max: usize,
    },
    InvalidChainParameter,
    InvalidMaskWeight {
        joint: usize,
    },
    PoseLengthMismatch {
        expected: usize,
        actual: usize,
    },
    MaskLengthMismatch {
        layer: usize,
        expected: usize,
        actual: usize,
    },
    TooManyLayers {
        count: usize,
        max: usize,
    },
    InvalidLayerWeight {
        layer: usize,
    },
    InvalidTarget {
        layer: usize,
    },
    DegenerateLimb {
        layer: usize,
    },
    /// `max_reach` leaves less reach than the limb's minimum `|upper - lower|`
    /// in the current pose, so no reach interval exists.
    ReachBelowMinimum {
        layer: usize,
    },
}

impl fmt::Display for IkError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ParentMustPrecedeChild { node, parent } => write!(
                formatter,
                "IK node {node} references parent {parent}; parents must appear before children"
            ),
            Self::JointOutOfBounds { joint, node_count } => write!(
                formatter,
                "IK joint {joint} is outside a rig with {node_count} nodes"
            ),
            Self::NotDescendant { ancestor, joint } => write!(
                formatter,
                "IK joint {joint} must be a descendant of joint {ancestor}"
            ),
            Self::EmptyLookAtChain => formatter.write_str("look-at chain needs at least one joint"),
            Self::LookAtChainTooLong { len, max } => write!(
                formatter,
                "look-at chain has {len} joints; at most {max} are supported"
            ),
            Self::InvalidChainParameter => formatter.write_str(
                "IK chain axes must be finite non-zero vectors and weights/angles finite and in range",
            ),
            Self::InvalidMaskWeight { joint } => write!(
                formatter,
                "IK mask weight for joint {joint} must be finite and between 0 and 1"
            ),
            Self::PoseLengthMismatch { expected, actual } => write!(
                formatter,
                "IK pose length mismatch: expected {expected}, got {actual}"
            ),
            Self::MaskLengthMismatch {
                layer,
                expected,
                actual,
            } => write!(
                formatter,
                "IK layer {layer} mask covers {actual} joints; rig has {expected}"
            ),
            Self::TooManyLayers { count, max } => {
                write!(formatter, "IK solve received {count} layers; at most {max} are supported")
            }
            Self::InvalidLayerWeight { layer } => write!(
                formatter,
                "IK layer {layer} weight must be finite and between 0 and 1"
            ),
            Self::InvalidTarget { layer } => write!(
                formatter,
                "IK layer {layer} target, pole, or orientation must be finite"
            ),
            Self::DegenerateLimb { layer } => write!(
                formatter,
                "IK layer {layer} limb has a zero-length bone in the current pose"
            ),
            Self::ReachBelowMinimum { layer } => write!(
                formatter,
                "IK layer {layer} max_reach is below the limb's minimum reach |upper - lower| in the current pose"
            ),
        }
    }
}

impl std::error::Error for IkError {}

/// Parent topology the solver uses to refresh world transforms.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IkRig {
    parents: Vec<Option<usize>>,
}

impl IkRig {
    pub fn new(parents: Vec<Option<usize>>) -> Result<Self, IkError> {
        for (node, parent) in parents.iter().enumerate() {
            if let Some(parent) = *parent
                && parent >= node
            {
                return Err(IkError::ParentMustPrecedeChild { node, parent });
            }
        }
        Ok(Self { parents })
    }

    /// Reuses the already validated joint topology of a [`Skeleton`].
    pub fn from_skeleton(skeleton: &Skeleton) -> Self {
        Self {
            parents: skeleton.joints().iter().map(|joint| joint.parent).collect(),
        }
    }

    pub fn node_count(&self) -> usize {
        self.parents.len()
    }

    pub fn parent(&self, node: usize) -> Option<usize> {
        self.parents.get(node).copied().flatten()
    }

    fn check(&self, joint: usize) -> Result<(), IkError> {
        if joint < self.parents.len() {
            Ok(())
        } else {
            Err(IkError::JointOutOfBounds {
                joint,
                node_count: self.parents.len(),
            })
        }
    }

    fn require_descendant(&self, ancestor: usize, joint: usize) -> Result<(), IkError> {
        let mut current = self.parent(joint);
        while let Some(node) = current {
            if node == ancestor {
                return Ok(());
            }
            current = self.parent(node);
        }
        Err(IkError::NotDescendant { ancestor, joint })
    }
}

/// A root → mid → tip chain such as upper leg → lower leg → foot. Helper or
/// twist joints may sit between the three; they stay rigid relative to their
/// semantic parent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TwoBoneChain {
    root: usize,
    mid: usize,
    tip: usize,
}

impl TwoBoneChain {
    pub fn new(rig: &IkRig, root: usize, mid: usize, tip: usize) -> Result<Self, IkError> {
        rig.check(root)?;
        rig.check(mid)?;
        rig.check(tip)?;
        rig.require_descendant(root, mid)?;
        rig.require_descendant(mid, tip)?;
        Ok(Self { root, mid, tip })
    }

    pub fn root(self) -> usize {
        self.root
    }

    pub fn mid(self) -> usize {
        self.mid
    }

    pub fn tip(self) -> usize {
        self.tip
    }
}

/// How the tip joint is oriented after its position is solved.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum EndEffector {
    /// Keep the tip's local rotation from the incoming pose.
    KeepLocal,
    /// Set the tip's character-space rotation (hand grips).
    Orientation(Quat),
    /// Rotate the tip minimally so `local_axis` points along
    /// `direction` in character space (foot up axis to a ground normal).
    AlignAxis { local_axis: Vec3, direction: Vec3 },
}

/// Two-bone limb goal with explicit character-space target and pole.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LimbGoal {
    pub chain: TwoBoneChain,
    pub target: Vec3,
    /// Point the mid joint (knee/elbow) bends toward. `None` keeps the
    /// incoming bend plane.
    pub pole: Option<Vec3>,
    /// Fraction of the full chain length usable as reach, in `(0, 1]`.
    /// Values slightly below one avoid snapping into a locked limb. The minimum
    /// `|upper - lower| / (upper + lower)` for the current pose is inclusive:
    /// fractions within [`MIN_REACH_FRACTION_TOLERANCE`] below it solve at the
    /// minimum reach, and smaller fractions are rejected with
    /// `IkError::ReachBelowMinimum`.
    pub max_reach: f32,
    pub end: EndEffector,
}

impl LimbGoal {
    pub fn new(chain: TwoBoneChain, target: Vec3) -> Self {
        Self {
            chain,
            target,
            pole: None,
            max_reach: 1.0,
            end: EndEffector::KeepLocal,
        }
    }

    /// Foot placement: the ankle reaches `contact` and `foot_up` (foot-local)
    /// aligns with the supplied ground `normal`.
    pub fn foot(chain: TwoBoneChain, contact: Vec3, normal: Vec3, foot_up: Vec3) -> Self {
        Self {
            end: EndEffector::AlignAxis {
                local_axis: foot_up,
                direction: normal,
            },
            ..Self::new(chain, contact)
        }
    }

    /// Hand placement: the wrist reaches `position` with the given
    /// character-space grip `orientation` when one is supplied.
    pub fn hand(chain: TwoBoneChain, position: Vec3, orientation: Option<Quat>) -> Self {
        Self {
            end: orientation.map_or(EndEffector::KeepLocal, EndEffector::Orientation),
            ..Self::new(chain, position)
        }
    }

    pub fn with_pole(mut self, pole: Vec3) -> Self {
        self.pole = Some(pole);
        self
    }

    pub fn with_max_reach(mut self, max_reach: f32) -> Self {
        self.max_reach = max_reach;
        self
    }
}

/// Ordered look-at chain, for example spine → neck → head. Each joint takes
/// its weight's share of the remaining rotation; the last joint carries the
/// aim axis.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LookAtChain {
    joints: [usize; MAX_LOOK_AT_JOINTS],
    weights: [f32; MAX_LOOK_AT_JOINTS],
    len: usize,
    forward: Vec3,
}

impl LookAtChain {
    /// `joints` are ordered from ancestor to aim joint with per-joint weights
    /// in `[0, 1]`. `forward` is the aim axis in the aim joint's local space.
    pub fn new(rig: &IkRig, joints: &[(usize, f32)], forward: Vec3) -> Result<Self, IkError> {
        if joints.is_empty() {
            return Err(IkError::EmptyLookAtChain);
        }
        if joints.len() > MAX_LOOK_AT_JOINTS {
            return Err(IkError::LookAtChainTooLong {
                len: joints.len(),
                max: MAX_LOOK_AT_JOINTS,
            });
        }
        let forward = forward
            .normalized()
            .filter(|value| finite_vec3(*value))
            .ok_or(IkError::InvalidChainParameter)?;
        let mut chain = Self {
            joints: [0; MAX_LOOK_AT_JOINTS],
            weights: [0.0; MAX_LOOK_AT_JOINTS],
            len: joints.len(),
            forward,
        };
        for (index, &(joint, weight)) in joints.iter().enumerate() {
            rig.check(joint)?;
            if !weight.is_finite() || !(0.0..=1.0).contains(&weight) {
                return Err(IkError::InvalidChainParameter);
            }
            if index > 0 {
                rig.require_descendant(chain.joints[index - 1], joint)?;
            }
            chain.joints[index] = joint;
            chain.weights[index] = weight;
        }
        Ok(chain)
    }

    pub fn joints(&self) -> &[usize] {
        &self.joints[..self.len]
    }

    fn aim_joint(&self) -> usize {
        self.joints[self.len - 1]
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LookAtGoal {
    pub chain: LookAtChain,
    pub target: Vec3,
    /// Maximum total deviation from the incoming aim direction, in radians.
    /// It bounds every weighted step and the final aim after the layer
    /// weight and joint mask are applied.
    pub max_angle: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum IkGoal {
    Limb(LimbGoal),
    LookAt(LookAtGoal),
}

/// Per-joint layer weights in `[0, 1]`. Joints default to the value supplied
/// at construction.
#[derive(Debug, Clone, PartialEq)]
pub struct JointMask {
    weights: Vec<f32>,
}

impl JointMask {
    pub fn new(node_count: usize, default_weight: f32) -> Result<Self, IkError> {
        if !default_weight.is_finite() || !(0.0..=1.0).contains(&default_weight) {
            return Err(IkError::InvalidMaskWeight { joint: 0 });
        }
        Ok(Self {
            weights: vec![default_weight; node_count],
        })
    }

    pub fn set(&mut self, joint: usize, weight: f32) -> Result<(), IkError> {
        if !weight.is_finite() || !(0.0..=1.0).contains(&weight) {
            return Err(IkError::InvalidMaskWeight { joint });
        }
        let node_count = self.weights.len();
        let slot = self
            .weights
            .get_mut(joint)
            .ok_or(IkError::JointOutOfBounds { joint, node_count })?;
        *slot = weight;
        Ok(())
    }

    pub fn weight(&self, joint: usize) -> f32 {
        self.weights.get(joint).copied().unwrap_or(0.0)
    }
}

/// One weighted correction layer. Layers are solved in slice order; each
/// sees the pose produced by the layers before it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IkLayer<'a> {
    pub goal: IkGoal,
    pub weight: f32,
    pub mask: Option<&'a JointMask>,
}

impl<'a> IkLayer<'a> {
    pub fn new(goal: IkGoal, weight: f32) -> Self {
        Self {
            goal,
            weight,
            mask: None,
        }
    }

    pub fn with_mask(mut self, mask: &'a JointMask) -> Self {
        self.mask = Some(mask);
        self
    }
}

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
    world: Vec<Mat4>,
    world_rotation: Vec<Quat>,
    outcomes: Vec<IkLayerOutcome>,
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

    fn refresh(&mut self, rig: &IkRig, pose: &[Transform], from: usize) -> usize {
        for (node, transform) in pose.iter().enumerate().skip(from) {
            let local = transform.matrix();
            let rotation = transform.rotation.normalized().unwrap_or(Quat::IDENTITY);
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

    fn position(&self, joint: usize) -> Vec3 {
        position(self.world[joint])
    }

    /// Applies a character-space rotation delta to `joint`'s local rotation.
    fn rotate_world(&self, rig: &IkRig, pose: &mut [Transform], joint: usize, delta: Quat) {
        let parent = rig
            .parent(joint)
            .map_or(Quat::IDENTITY, |parent| self.world_rotation[parent]);
        let local_delta = quat_mul(quat_mul(quat_conjugate(parent), delta), parent);
        // An unnormalizable base rotation is identity, as in `refresh`, `Mat4::rotation` and
        // `Quat::slerp`; multiplying a zero quaternion would leave the joint unable to rotate.
        let base = pose[joint].rotation.normalized().unwrap_or(Quat::IDENTITY);
        pose[joint].rotation = quat_mul(local_delta, base);
    }

    fn solve_limb(
        &mut self,
        rig: &IkRig,
        pose: &mut [Transform],
        goal: &LimbGoal,
        layer: usize,
        stats: &mut IkSolveStats,
    ) -> Result<IkStatus, IkError> {
        let TwoBoneChain { root, mid, tip } = goal.chain;
        let a = self.position(root);
        let b = self.position(mid);
        let c = self.position(tip);
        let t = goal.target;
        let upper = (b - a).length();
        let lower = (c - b).length();
        if upper <= EPSILON || lower <= EPSILON {
            return Err(IkError::DegenerateLimb { layer });
        }

        let full_reach = upper + lower;
        let min_reach = (upper - lower).abs();
        if goal.max_reach + MIN_REACH_FRACTION_TOLERANCE < min_reach / full_reach {
            return Err(IkError::ReachBelowMinimum { layer });
        }
        // Inside the tolerance the reach interval collapses onto the minimum;
        // this also keeps the clamp below well-ordered.
        let max_reach = (full_reach * goal.max_reach).max(min_reach);
        let distance = (t - a).length();
        let reachable = distance <= max_reach + REACH_TOLERANCE
            && distance + REACH_TOLERANCE >= min_reach
            && distance > EPSILON;
        let reach = distance.clamp(min_reach.max(EPSILON), max_reach.max(EPSILON));

        let ac = c - a;
        let ab = b - a;
        let axis = ac
            .cross(ab)
            .normalized()
            .or_else(|| goal.pole.and_then(|pole| ac.cross(pole - a).normalized()))
            .unwrap_or_else(|| any_perpendicular(ab));

        let current_root = angle_between(ac, ab);
        let current_mid = angle_between(a - b, c - b);
        let desired_root = law_of_cosines(upper, reach, lower);
        let desired_mid = law_of_cosines(upper, lower, reach);
        let root_bend = axis_angle(axis, desired_root - current_root);
        let mid_bend = axis_angle(axis, desired_mid - current_mid);

        let bent_mid = a + rotate(root_bend, ab);
        let bent_tip = bent_mid + rotate(quat_mul(root_bend, mid_bend), c - b);
        let aim = if distance > EPSILON {
            from_to(bent_tip - a, t - a)
        } else {
            Quat::IDENTITY
        };
        let mut root_delta = quat_mul(aim, root_bend);

        if let Some(pole) = goal.pole
            && let Some(limb_axis) = (t - a).normalized().or_else(|| (bent_tip - a).normalized())
        {
            let solved_mid = rotate(root_delta, ab);
            let from = reject(solved_mid, limb_axis);
            let to = reject(pole - a, limb_axis);
            if let (Some(from), Some(to)) = (from.normalized(), to.normalized()) {
                let twist = signed_angle(from, to, limb_axis);
                root_delta = quat_mul(axis_angle(limb_axis, twist), root_delta);
            }
        }

        // Mid first: its parent rotation is still the pre-solve world state.
        self.rotate_world(rig, pose, mid, mid_bend);
        self.rotate_world(rig, pose, root, root_delta);
        stats.world_nodes_updated += self.refresh(rig, pose, root);

        match goal.end {
            EndEffector::KeepLocal => {}
            EndEffector::Orientation(orientation) => {
                let parent = rig
                    .parent(tip)
                    .map_or(Quat::IDENTITY, |parent| self.world_rotation[parent]);
                pose[tip].rotation = quat_mul(quat_conjugate(parent), orientation);
                stats.world_nodes_updated += self.refresh(rig, pose, tip);
            }
            EndEffector::AlignAxis {
                local_axis,
                direction,
            } => {
                let current = rotate(self.world_rotation[tip], local_axis);
                self.rotate_world(rig, pose, tip, from_to(current, direction));
                stats.world_nodes_updated += self.refresh(rig, pose, tip);
            }
        }

        Ok(if reachable {
            IkStatus::Reached
        } else {
            IkStatus::Clamped
        })
    }

    fn solve_look_at(
        &mut self,
        rig: &IkRig,
        pose: &mut [Transform],
        goal: &LookAtGoal,
        initial: Vec3,
        stats: &mut IkSolveStats,
    ) -> IkStatus {
        let chain = &goal.chain;
        let aim = chain.aim_joint();
        for (&joint, &weight) in chain.joints().iter().zip(&chain.weights[..chain.len]) {
            let Some(desired) = (goal.target - self.position(aim)).normalized() else {
                return IkStatus::Clamped;
            };
            let (desired, _) = clamp_direction(initial, desired, goal.max_angle);
            let current = self.aim_direction(chain);
            // A partial step follows the great circle from `current` to
            // `desired`. Both lie inside the permitted cap, but for limits
            // above pi/2 that arc can leave the cap, so the step's end is
            // clamped again before it is applied.
            let partial = Quat::IDENTITY.slerp(from_to(current, desired), weight);
            let (stepped, _) = clamp_direction(initial, rotate(partial, current), goal.max_angle);
            self.rotate_world(rig, pose, joint, from_to(current, stepped));
            stats.world_nodes_updated += self.refresh(rig, pose, joint);
        }
        // The status comes from the final state only: an earlier joint may have
        // hit the angle limit while moving the aim joint to a position from
        // which the target is within the limit, and a later joint may then
        // reach it. Joint weights below one can leave part of the permitted aim
        // unapplied (e.g. a single joint with weight 0); only a full, unlimited
        // aim from the final aim position counts as reached.
        let Some(desired) = (goal.target - self.position(aim)).normalized() else {
            return IkStatus::Clamped;
        };
        let (desired, limited) = clamp_direction(initial, desired, goal.max_angle);
        let forward = rotate(self.world_rotation[aim], chain.forward);
        if limited || angle_between(forward, desired) > LOOK_AT_ANGLE_TOLERANCE {
            IkStatus::Clamped
        } else {
            IkStatus::Reached
        }
    }

    fn aim_direction(&self, chain: &LookAtChain) -> Vec3 {
        rotate(self.world_rotation[chain.aim_joint()], chain.forward)
    }

    /// Re-enforces `max_angle` after the layer weight and joint mask blended
    /// each chain joint toward its solved rotation independently. Only the
    /// fully solved pose is guaranteed to lie inside the permitted cap; a
    /// per-joint blend of it is not. If the blend leaves the cap, every
    /// joint's blend fraction is scaled by one common factor `s` in `[0, 1)`
    /// (found by a fixed-count bisection; `s = 0` is the pre-layer aim, which
    /// is inside the cap), so each joint still lies on its pre-layer → solved
    /// SLERP, relative weights are kept, and zero-weight joints never move.
    /// Only rotations are composed here; the caller refreshes the hierarchy.
    #[allow(clippy::too_many_arguments)]
    fn limit_blended_look_at(
        &self,
        rig: &IkRig,
        pose: &mut [Transform],
        goal: &LookAtGoal,
        initial: Vec3,
        layer: &IkLayer<'_>,
        original: &Snapshot,
        solved: &Snapshot,
    ) -> bool {
        let chain = &goal.chain;
        let exceeds = |pose: &[Transform]| {
            let forward = rotate(self.chain_aim_rotation(rig, pose, chain), chain.forward);
            clamp_direction(initial, forward, goal.max_angle).1
        };
        if !exceeds(pose) {
            return false;
        }
        let apply = |pose: &mut [Transform], scale: f32| {
            for (&(joint, from), &(_, to)) in original.as_slice().iter().zip(solved.as_slice()) {
                pose[joint].rotation = blend_rotation(from, to, layer_factor(layer, joint) * scale);
            }
        };
        let (mut inside, mut outside) = (0.0_f32, 1.0_f32);
        for _ in 0..LOOK_AT_BLEND_SCALE_STEPS {
            let scale = 0.5 * (inside + outside);
            apply(pose, scale);
            if exceeds(pose) {
                outside = scale;
            } else {
                inside = scale;
            }
        }
        apply(pose, inside);
        true
    }

    /// World rotation of the chain's aim joint for `pose`, composed from the
    /// first chain joint's (unchanged) parent world rotation.
    fn chain_aim_rotation(&self, rig: &IkRig, pose: &[Transform], chain: &LookAtChain) -> Quat {
        let first = chain.joints()[0];
        let mut node = chain.aim_joint();
        let mut rotation = Quat::IDENTITY;
        loop {
            let local = pose[node].rotation.normalized().unwrap_or(Quat::IDENTITY);
            rotation = quat_mul(local, rotation);
            if node == first {
                break;
            }
            match rig.parent(node) {
                Some(parent) => node = parent,
                None => break,
            }
        }
        let base = rig
            .parent(first)
            .map_or(Quat::IDENTITY, |parent| self.world_rotation[parent]);
        quat_mul(base, rotation)
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
struct Snapshot {
    entries: [(usize, Quat); MAX_LOOK_AT_JOINTS],
    len: usize,
}

impl Snapshot {
    fn push(&mut self, joint: usize, rotation: Quat) {
        self.entries[self.len] = (joint, rotation);
        self.len += 1;
    }

    fn as_slice(&self) -> &[(usize, Quat)] {
        &self.entries[..self.len]
    }
}

#[derive(Debug, Clone, Copy)]
struct JointList {
    joints: [usize; MAX_LOOK_AT_JOINTS],
    len: usize,
}

impl JointList {
    fn as_slice(&self) -> &[usize] {
        &self.joints[..self.len]
    }
}

fn layer_factor(layer: &IkLayer<'_>, joint: usize) -> f32 {
    layer.weight * layer.mask.map_or(1.0, |mask| mask.weight(joint))
}

fn blend_rotation(original: Quat, solved: Quat, factor: f32) -> Quat {
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

fn position(matrix: Mat4) -> Vec3 {
    Vec3::new(
        matrix.elements[12],
        matrix.elements[13],
        matrix.elements[14],
    )
}

fn rotate(rotation: Quat, value: Vec3) -> Vec3 {
    let axis = Vec3::new(rotation.x, rotation.y, rotation.z);
    let twice = axis.cross(value) * 2.0;
    value + twice * rotation.w + axis.cross(twice)
}

fn axis_angle(axis: Vec3, angle: f32) -> Quat {
    Quat::from_axis_angle(axis, angle).unwrap_or(Quat::IDENTITY)
}

fn angle_between(left: Vec3, right: Vec3) -> f32 {
    match (left.normalized(), right.normalized()) {
        (Some(left), Some(right)) => left.dot(right).clamp(-1.0, 1.0).acos(),
        _ => 0.0,
    }
}

/// Interior angle opposite `opposite` in a triangle with the other two sides.
fn law_of_cosines(adjacent_a: f32, adjacent_b: f32, opposite: f32) -> f32 {
    let cosine = (adjacent_a * adjacent_a + adjacent_b * adjacent_b - opposite * opposite)
        / (2.0 * adjacent_a * adjacent_b);
    cosine.clamp(-1.0, 1.0).acos()
}

fn any_perpendicular(value: Vec3) -> Vec3 {
    let helper = if value.x.abs() < 0.9 {
        Vec3::new(1.0, 0.0, 0.0)
    } else {
        Vec3::new(0.0, 1.0, 0.0)
    };
    value
        .cross(helper)
        .normalized()
        .unwrap_or(Vec3::new(0.0, 0.0, 1.0))
}

/// Shortest rotation taking direction `from` onto direction `to`.
fn from_to(from: Vec3, to: Vec3) -> Quat {
    let (Some(from), Some(to)) = (from.normalized(), to.normalized()) else {
        return Quat::IDENTITY;
    };
    let cosine = from.dot(to);
    if cosine >= 1.0 - EPSILON {
        return Quat::IDENTITY;
    }
    if cosine <= -1.0 + EPSILON {
        return axis_angle(any_perpendicular(from), PI);
    }
    let axis = from.cross(to);
    Quat::new(axis.x, axis.y, axis.z, 1.0 + cosine)
        .normalized()
        .unwrap_or(Quat::IDENTITY)
}

fn reject(value: Vec3, unit_axis: Vec3) -> Vec3 {
    value - unit_axis * value.dot(unit_axis)
}

fn signed_angle(from: Vec3, to: Vec3, unit_axis: Vec3) -> f32 {
    let sine = from.cross(to).dot(unit_axis);
    let cosine = from.dot(to);
    sine.atan2(cosine)
}

fn clamp_direction(reference: Vec3, desired: Vec3, max_angle: f32) -> (Vec3, bool) {
    let angle = angle_between(reference, desired);
    if angle <= max_angle + EPSILON {
        return (desired, false);
    }
    let axis = reference
        .cross(desired)
        .normalized()
        .unwrap_or_else(|| any_perpendicular(reference));
    let limited = rotate(axis_angle(axis, max_angle), reference)
        .normalized()
        .unwrap_or(reference);
    (limited, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{AnimationClip, AnimationTrack, Interpolation, Keyframe, KeyframeTrack};
    use core::f32::consts::FRAC_PI_2;

    const TOLERANCE: f32 = 1.0e-3;

    fn quat_angle(a: Quat, b: Quat) -> f32 {
        let a = a.normalized().unwrap();
        let b = b.normalized().unwrap();
        2.0 * a.dot(b).abs().min(1.0).acos()
    }

    /// hips(0) → upper leg(1) → lower leg(2) → foot(3); spine(4) → head(5);
    /// upper arm(6) → lower arm(7) → hand(8) under the spine.
    fn rig() -> IkRig {
        IkRig::new(vec![
            None,
            Some(0),
            Some(1),
            Some(2),
            Some(0),
            Some(4),
            Some(4),
            Some(6),
            Some(7),
        ])
        .unwrap()
    }

    fn translated(x: f32, y: f32, z: f32) -> Transform {
        Transform {
            translation: Vec3::new(x, y, z),
            ..Transform::IDENTITY
        }
    }

    /// Leg hangs down from y = 1 with a slight forward knee bend; arm points
    /// along +x from the spine.
    fn base_pose() -> Vec<Transform> {
        vec![
            translated(0.0, 1.0, 0.0),
            translated(0.1, 0.0, 0.0),
            translated(0.0, -0.5, 0.02),
            translated(0.0, -0.5, -0.02),
            translated(0.0, 0.3, 0.0),
            translated(0.0, 0.3, 0.0),
            translated(0.2, 0.2, 0.0),
            translated(0.3, 0.0, -0.01),
            translated(0.3, 0.0, 0.01),
        ]
    }

    fn leg(rig: &IkRig) -> TwoBoneChain {
        TwoBoneChain::new(rig, 1, 2, 3).unwrap()
    }

    fn arm(rig: &IkRig) -> TwoBoneChain {
        TwoBoneChain::new(rig, 6, 7, 8).unwrap()
    }

    fn assert_close(actual: Vec3, expected: Vec3) {
        assert!(
            (actual - expected).length() < TOLERANCE,
            "{actual:?} != {expected:?}"
        );
    }

    fn solve(layers: &[IkLayer<'_>]) -> (IkWorkspace, Vec<Transform>, IkSolveStats) {
        let rig = rig();
        let base = base_pose();
        let mut workspace = IkWorkspace::new(rig.node_count());
        let mut output = vec![Transform::IDENTITY; rig.node_count()];
        let stats = workspace.solve(&rig, &base, layers, &mut output).unwrap();
        (workspace, output, stats)
    }

    fn bone_lengths(workspace: &IkWorkspace, chain: TwoBoneChain) -> (f32, f32) {
        let a = workspace.world_position(chain.root).unwrap();
        let b = workspace.world_position(chain.mid).unwrap();
        let c = workspace.world_position(chain.tip).unwrap();
        ((b - a).length(), (c - b).length())
    }

    #[test]
    fn reachable_foot_target_is_reached_with_bone_lengths_preserved() {
        let rig = rig();
        let target = Vec3::new(0.25, 0.3, 0.2);
        let goal = LimbGoal::new(leg(&rig), target);
        let (workspace, _, stats) = solve(&[IkLayer::new(IkGoal::Limb(goal), 1.0)]);

        assert_close(workspace.world_position(3).unwrap(), target);
        let (upper, lower) = bone_lengths(&workspace, leg(&rig));
        assert!((upper - 0.5004).abs() < TOLERANCE);
        assert!((lower - 0.5004).abs() < TOLERANCE);
        assert_eq!(workspace.outcomes()[0].status, IkStatus::Reached);
        assert!(workspace.outcomes()[0].residual < TOLERANCE);
        assert_eq!(stats.layers_applied, 1);
    }

    #[test]
    fn unreachable_target_extends_toward_target_and_reports_clamped() {
        let rig = rig();
        let target = Vec3::new(0.1, -2.0, 0.0);
        let goal = LimbGoal::new(leg(&rig), target);
        let (workspace, _, stats) = solve(&[IkLayer::new(IkGoal::Limb(goal), 1.0)]);

        let hip = workspace.world_position(1).unwrap();
        let foot = workspace.world_position(3).unwrap();
        let (upper, lower) = bone_lengths(&workspace, leg(&rig));
        assert!(((foot - hip).length() - (upper + lower)).abs() < TOLERANCE);
        let toward = (target - hip).normalized().unwrap();
        assert_close((foot - hip).normalized().unwrap(), toward);
        assert_eq!(workspace.outcomes()[0].status, IkStatus::Clamped);
        assert!((workspace.outcomes()[0].residual - (2.0 + 1.0 - upper - lower)).abs() < 1.0e-2);
        assert_eq!(stats.layers_clamped, 1);
    }

    #[test]
    fn target_inside_minimum_reach_is_clamped() {
        let rig = rig();
        let chain = TwoBoneChain::new(&rig, 6, 7, 8).unwrap();
        // Upper and lower arm are equal, so the only unreachable inner target
        // is the shoulder itself.
        let shoulder = Vec3::new(0.2, 1.5, 0.0);
        let goal = LimbGoal::new(chain, shoulder);
        let (workspace, _, _) = solve(&[IkLayer::new(IkGoal::Limb(goal), 1.0)]);
        assert_eq!(workspace.outcomes()[0].status, IkStatus::Clamped);
    }

    #[test]
    fn max_reach_softens_full_extension() {
        let rig = rig();
        let target = Vec3::new(0.1, -2.0, 0.0);
        let goal = LimbGoal::new(leg(&rig), target).with_max_reach(0.9);
        let (workspace, _, _) = solve(&[IkLayer::new(IkGoal::Limb(goal), 1.0)]);
        let hip = workspace.world_position(1).unwrap();
        let foot = workspace.world_position(3).unwrap();
        let (upper, lower) = bone_lengths(&workspace, leg(&rig));
        assert!(((foot - hip).length() - 0.9 * (upper + lower)).abs() < TOLERANCE);
    }

    #[test]
    fn max_reach_below_unequal_limb_minimum_is_rejected() {
        let rig = rig();
        let mut base = base_pose();
        // Upper leg ~0.5, lower leg 0.25: minimum reach fraction is ~1/3.
        base[3] = translated(0.0, -0.25, 0.0);
        let mut workspace = IkWorkspace::new(rig.node_count());
        let mut output = base.clone();
        let target = Vec3::new(0.1, 0.5, 0.0);

        let goal = LimbGoal::new(leg(&rig), target).with_max_reach(0.2);
        assert_eq!(
            workspace.solve(
                &rig,
                &base,
                &[IkLayer::new(IkGoal::Limb(goal), 1.0)],
                &mut output
            ),
            Err(IkError::ReachBelowMinimum { layer: 0 })
        );

        // A fraction above the minimum still solves within the reach interval.
        let goal = LimbGoal::new(leg(&rig), target).with_max_reach(0.5);
        workspace
            .solve(
                &rig,
                &base,
                &[IkLayer::new(IkGoal::Limb(goal), 1.0)],
                &mut output,
            )
            .unwrap();
        let (upper, lower) = bone_lengths(&workspace, leg(&rig));
        let reach =
            (workspace.world_position(3).unwrap() - workspace.world_position(1).unwrap()).length();
        assert!(reach + TOLERANCE >= (upper - lower).abs());
        assert!(reach <= 0.5 * (upper + lower) + TOLERANCE);
    }

    #[test]
    fn pole_vector_selects_knee_bend_plane() {
        let rig = rig();
        let target = Vec3::new(0.1, 0.4, 0.0);
        for pole_z in [1.0, -1.0] {
            let goal = LimbGoal::new(leg(&rig), target).with_pole(Vec3::new(0.1, 0.7, pole_z));
            let (workspace, _, _) = solve(&[IkLayer::new(IkGoal::Limb(goal), 1.0)]);
            assert_close(workspace.world_position(3).unwrap(), target);
            let knee = workspace.world_position(2).unwrap();
            assert!(knee.z * pole_z > 0.1, "knee {knee:?} pole {pole_z}");
            assert!((knee.x - 0.1).abs() < TOLERANCE, "knee {knee:?}");
        }
    }

    #[test]
    fn straight_rest_limb_bends_toward_pole() {
        let rig = rig();
        let mut base = base_pose();
        base[2] = translated(0.0, -0.5, 0.0);
        base[3] = translated(0.0, -0.5, 0.0);
        let target = Vec3::new(0.1, 0.4, 0.0);
        let goal = LimbGoal::new(leg(&rig), target).with_pole(Vec3::new(0.1, 0.7, 1.0));
        let mut workspace = IkWorkspace::new(rig.node_count());
        let mut output = base.clone();
        workspace
            .solve(
                &rig,
                &base,
                &[IkLayer::new(IkGoal::Limb(goal), 1.0)],
                &mut output,
            )
            .unwrap();
        assert_close(workspace.world_position(3).unwrap(), target);
        assert!(workspace.world_position(2).unwrap().z > 0.1);
    }

    #[test]
    fn foot_aligns_up_axis_to_ground_normal() {
        let rig = rig();
        let normal = Vec3::new(0.3, 1.0, 0.0).normalized().unwrap();
        let contact = Vec3::new(0.1, 0.2, 0.1);
        let goal = LimbGoal::foot(leg(&rig), contact, normal, Vec3::new(0.0, 1.0, 0.0));
        let (workspace, _, _) = solve(&[IkLayer::new(IkGoal::Limb(goal), 1.0)]);
        assert_close(workspace.world_position(3).unwrap(), contact);
        let up = rotate(
            workspace.world_rotation(3).unwrap(),
            Vec3::new(0.0, 1.0, 0.0),
        );
        assert_close(up, normal);
    }

    #[test]
    fn hand_reaches_target_with_exact_grip_orientation() {
        let rig = rig();
        let grip = Quat::from_euler_xyz(0.3, -0.4, 1.1);
        let target = Vec3::new(0.5, 1.9, 0.3);
        let goal = LimbGoal::hand(arm(&rig), target, Some(grip));
        let (workspace, _, _) = solve(&[IkLayer::new(IkGoal::Limb(goal), 1.0)]);
        assert_close(workspace.world_position(8).unwrap(), target);
        let actual = workspace.world_rotation(8).unwrap();
        assert!(actual.dot(grip).abs() > 1.0 - 1.0e-5, "{actual:?}");
    }

    #[test]
    fn look_at_distributes_rotation_and_aims_head() {
        let rig = rig();
        let chain =
            LookAtChain::new(&rig, &[(4, 0.4), (5, 1.0)], Vec3::new(0.0, 0.0, 1.0)).unwrap();
        let target = Vec3::new(2.0, 1.6, 2.0);
        let goal = LookAtGoal {
            chain,
            target,
            max_angle: FRAC_PI_2,
        };
        let (workspace, output, _) = solve(&[IkLayer::new(IkGoal::LookAt(goal), 1.0)]);
        assert_eq!(workspace.outcomes()[0].status, IkStatus::Reached);
        assert!(workspace.outcomes()[0].residual < TOLERANCE);
        assert_ne!(output[4].rotation, Quat::IDENTITY);
        assert_ne!(output[5].rotation, Quat::IDENTITY);
    }

    #[test]
    fn partially_weighted_look_at_within_max_angle_reports_clamped() {
        let rig = rig();
        let target = Vec3::new(2.0, 1.6, 2.0);
        for weights in [&[(5, 0.0)][..], &[(5, 0.5)][..], &[(4, 0.5), (5, 0.5)][..]] {
            let chain = LookAtChain::new(&rig, weights, Vec3::new(0.0, 0.0, 1.0)).unwrap();
            let goal = LookAtGoal {
                chain,
                target,
                max_angle: FRAC_PI_2,
            };
            let (workspace, _, stats) = solve(&[IkLayer::new(IkGoal::LookAt(goal), 1.0)]);
            let outcome = workspace.outcomes()[0];
            assert_eq!(outcome.status, IkStatus::Clamped, "{weights:?}");
            assert!(outcome.residual > TOLERANCE, "{weights:?}");
            assert_eq!(stats.layers_clamped, 1, "{weights:?}");
        }
    }

    #[test]
    fn look_at_reports_reached_when_final_aim_is_within_limit_after_early_clamp() {
        // The target is 45 degrees above the head's initial forward, beyond the
        // 0.65 rad limit, so the spine step is clamped. Pitching the spine up
        // moves the head back and down relative to the target, which leaves it
        // within the limit from the head's final position; the head then aims
        // fully, so the solve must report Reached rather than a sticky Clamped.
        let rig = rig();
        let chain =
            LookAtChain::new(&rig, &[(4, 1.0), (5, 1.0)], Vec3::new(0.0, 0.0, 1.0)).unwrap();
        let goal = LookAtGoal {
            chain,
            target: Vec3::new(0.0, 1.75, 0.15),
            max_angle: 0.65,
        };
        let initial_head = Vec3::new(0.0, 1.6, 0.0);
        let initial_angle = angle_between(
            Vec3::new(0.0, 0.0, 1.0),
            (goal.target - initial_head).normalized().unwrap(),
        );
        assert!(initial_angle > goal.max_angle);

        let (workspace, _, stats) = solve(&[IkLayer::new(IkGoal::LookAt(goal), 1.0)]);
        let outcome = workspace.outcomes()[0];
        assert_eq!(outcome.status, IkStatus::Reached);
        assert!(outcome.residual < TOLERANCE, "{}", outcome.residual);
        assert_eq!(stats.layers_clamped, 0);
        let forward = rotate(
            workspace.world_rotation(5).unwrap(),
            Vec3::new(0.0, 0.0, 1.0),
        );
        assert!(angle_between(forward, Vec3::new(0.0, 0.0, 1.0)) <= goal.max_angle + TOLERANCE);
    }

    #[test]
    fn look_at_respects_max_angle() {
        let rig = rig();
        let chain = LookAtChain::new(&rig, &[(5, 1.0)], Vec3::new(0.0, 0.0, 1.0)).unwrap();
        let goal = LookAtGoal {
            chain,
            target: Vec3::new(5.0, 1.6, 0.0),
            max_angle: 0.5,
        };
        let (workspace, _, _) = solve(&[IkLayer::new(IkGoal::LookAt(goal), 1.0)]);
        let forward = rotate(
            workspace.world_rotation(5).unwrap(),
            Vec3::new(0.0, 0.0, 1.0),
        );
        assert!((angle_between(forward, Vec3::new(0.0, 0.0, 1.0)) - 0.5).abs() < TOLERANCE);
        assert_eq!(workspace.outcomes()[0].status, IkStatus::Clamped);
    }

    #[test]
    fn zero_weight_layer_leaves_base_pose_bit_identical() {
        let rig = rig();
        let goal = LimbGoal::new(leg(&rig), Vec3::new(0.3, 0.3, 0.3));
        let (workspace, output, stats) = solve(&[IkLayer::new(IkGoal::Limb(goal), 0.0)]);
        assert_eq!(output, base_pose());
        assert_eq!(workspace.outcomes()[0].status, IkStatus::Skipped);
        assert_eq!(stats.layers_skipped, 1);
        assert_eq!(stats.joints_written, 0);
    }

    #[test]
    fn layer_weight_blends_between_base_and_solved_rotations() {
        let rig = rig();
        let goal = IkGoal::Limb(LimbGoal::new(leg(&rig), Vec3::new(0.3, 0.3, 0.2)));
        let (_, full, _) = solve(&[IkLayer::new(goal, 1.0)]);
        let (_, half, _) = solve(&[IkLayer::new(goal, 0.5)]);
        let base = base_pose();
        for joint in [1, 2] {
            let expected = base[joint].rotation.slerp(full[joint].rotation, 0.5);
            assert!(half[joint].rotation.dot(expected).abs() > 1.0 - 1.0e-6);
        }
        assert_eq!(half[0], base[0]);
        assert_eq!(half[4..], base[4..]);
    }

    #[test]
    fn mask_scales_layer_weight_per_joint() {
        let rig = rig();
        let goal = IkGoal::Limb(LimbGoal::new(leg(&rig), Vec3::new(0.3, 0.3, 0.2)));
        let (_, full, _) = solve(&[IkLayer::new(goal, 1.0)]);
        let mut mask = JointMask::new(rig.node_count(), 1.0).unwrap();
        mask.set(1, 0.0).unwrap();
        mask.set(2, 0.25).unwrap();
        let (_, masked, _) = solve(&[IkLayer::new(goal, 0.8).with_mask(&mask)]);
        let base = base_pose();
        assert_eq!(masked[1].rotation, base[1].rotation);
        let expected = base[2].rotation.slerp(full[2].rotation, 0.2);
        assert!(masked[2].rotation.dot(expected).abs() > 1.0 - 1.0e-6);
    }

    #[test]
    fn layers_solve_in_order_and_later_layers_see_earlier_results() {
        let rig = rig();
        let first = IkGoal::Limb(LimbGoal::new(leg(&rig), Vec3::new(0.3, 0.3, 0.2)));
        let second = IkGoal::Limb(LimbGoal::new(leg(&rig), Vec3::new(-0.1, 0.25, -0.1)));
        let (workspace, ordered, _) = solve(&[IkLayer::new(first, 1.0), IkLayer::new(second, 1.0)]);
        assert_close(
            workspace.world_position(3).unwrap(),
            Vec3::new(-0.1, 0.25, -0.1),
        );
        let (_, repeated, _) = solve(&[IkLayer::new(first, 1.0), IkLayer::new(second, 1.0)]);
        assert_eq!(ordered, repeated);
        let (swapped, _, _) = solve(&[IkLayer::new(second, 1.0), IkLayer::new(first, 1.0)]);
        assert_close(swapped.world_position(3).unwrap(), Vec3::new(0.3, 0.3, 0.2));
    }

    #[test]
    fn solve_never_mutates_sampled_clip_or_base_pose() {
        let rig = rig();
        let track = KeyframeTrack::new(
            vec![
                Keyframe {
                    time: 0.0,
                    value: Quat::IDENTITY,
                },
                Keyframe {
                    time: 1.0,
                    value: Quat::from_euler_xyz(0.4, 0.0, 0.0),
                },
            ],
            Interpolation::Linear,
        )
        .unwrap();
        let clip =
            AnimationClip::new("walk", vec![AnimationTrack::Rotation { node: 1, track }]).unwrap();
        let clip_before = clip.clone();
        let mut base = base_pose();
        clip.sample(0.5, &mut base).unwrap();
        let base_before = base.clone();

        let mut workspace = IkWorkspace::new(rig.node_count());
        let mut output = vec![Transform::IDENTITY; rig.node_count()];
        let goal = IkGoal::Limb(LimbGoal::new(leg(&rig), Vec3::new(0.3, 0.3, 0.2)));
        workspace
            .solve(&rig, &base, &[IkLayer::new(goal, 1.0)], &mut output)
            .unwrap();

        assert_eq!(clip, clip_before);
        assert_eq!(base, base_before);
        assert_ne!(output, base);
        let mut resampled = base_pose();
        clip.sample(0.5, &mut resampled).unwrap();
        assert_eq!(resampled, base_before);
    }

    #[test]
    fn work_is_bounded_by_layer_count() {
        let rig = rig();
        let chain =
            LookAtChain::new(&rig, &[(4, 0.5), (5, 1.0)], Vec3::new(0.0, 0.0, 1.0)).unwrap();
        let layers = [
            IkLayer::new(
                IkGoal::Limb(LimbGoal::foot(
                    leg(&rig),
                    Vec3::new(0.1, 0.2, 0.1),
                    Vec3::new(0.0, 1.0, 0.0),
                    Vec3::new(0.0, 1.0, 0.0),
                )),
                0.7,
            ),
            IkLayer::new(
                IkGoal::LookAt(LookAtGoal {
                    chain,
                    target: Vec3::new(1.0, 1.5, 1.0),
                    max_angle: 1.0,
                }),
                0.5,
            ),
            IkLayer::new(
                IkGoal::Limb(LimbGoal::hand(arm(&rig), Vec3::new(0.6, 1.4, 0.2), None)),
                1.0,
            ),
        ];
        let (_, _, stats) = solve(&layers);
        let nodes = rig.node_count();
        assert_eq!(stats.layers_applied, 3);
        assert!(
            stats.world_nodes_updated <= nodes * (1 + layers.len() * MAX_WORLD_PASSES_PER_LAYER)
        );
        assert!(stats.joints_written <= layers.len() * MAX_LOOK_AT_JOINTS);
    }

    #[test]
    fn rejects_invalid_inputs() {
        let rig = rig();
        assert_eq!(
            IkRig::new(vec![Some(0)]),
            Err(IkError::ParentMustPrecedeChild { node: 0, parent: 0 })
        );
        assert_eq!(
            TwoBoneChain::new(&rig, 1, 5, 3),
            Err(IkError::NotDescendant {
                ancestor: 1,
                joint: 5
            })
        );
        assert_eq!(
            LookAtChain::new(&rig, &[(0, 1.0); 5], Vec3::new(0.0, 0.0, 1.0)),
            Err(IkError::LookAtChainTooLong { len: 5, max: 4 })
        );

        let base = base_pose();
        let mut workspace = IkWorkspace::new(rig.node_count());
        let mut output = base.clone();
        let goal = LimbGoal::new(leg(&rig), Vec3::new(f32::NAN, 0.0, 0.0));
        assert_eq!(
            workspace.solve(
                &rig,
                &base,
                &[IkLayer::new(IkGoal::Limb(goal), 1.0)],
                &mut output
            ),
            Err(IkError::InvalidTarget { layer: 0 })
        );
        let goal = IkGoal::Limb(LimbGoal::new(leg(&rig), Vec3::ZERO));
        assert_eq!(
            workspace.solve(&rig, &base, &[IkLayer::new(goal, 1.5)], &mut output),
            Err(IkError::InvalidLayerWeight { layer: 0 })
        );
        let layers = [IkLayer::new(goal, 1.0); MAX_IK_LAYERS + 1];
        assert_eq!(
            workspace.solve(&rig, &base, &layers, &mut output),
            Err(IkError::TooManyLayers {
                count: MAX_IK_LAYERS + 1,
                max: MAX_IK_LAYERS
            })
        );
        assert_eq!(
            workspace.solve(&rig, &base[..3], &[], &mut output),
            Err(IkError::PoseLengthMismatch {
                expected: rig.node_count(),
                actual: 3
            })
        );
    }

    #[test]
    fn chains_are_revalidated_against_the_solve_rig() {
        let rig = rig();
        let leg = leg(&rig);
        let look = LookAtChain::new(&rig, &[(4, 0.5), (5, 1.0)], Vec3::new(0.0, 0.0, 1.0)).unwrap();
        // Same node count, but the leg joints and head are re-parented to the
        // hips, so neither chain's ancestry holds.
        let other = IkRig::new(vec![
            None,
            Some(0),
            Some(0),
            Some(0),
            Some(0),
            Some(0),
            Some(4),
            Some(6),
            Some(7),
        ])
        .unwrap();
        let base = base_pose();
        let mut workspace = IkWorkspace::new(other.node_count());
        let mut output = base.clone();

        let limb = IkGoal::Limb(LimbGoal::new(leg, Vec3::new(0.25, 0.3, 0.2)));
        assert_eq!(
            workspace.solve(&other, &base, &[IkLayer::new(limb, 1.0)], &mut output),
            Err(IkError::NotDescendant {
                ancestor: 1,
                joint: 2
            })
        );
        let look_at = IkGoal::LookAt(LookAtGoal {
            chain: look,
            target: Vec3::new(1.0, 1.6, 1.0),
            max_angle: PI,
        });
        assert_eq!(
            workspace.solve(&other, &base, &[IkLayer::new(look_at, 1.0)], &mut output),
            Err(IkError::NotDescendant {
                ancestor: 4,
                joint: 5
            })
        );
        // Rejected solves leave the output untouched.
        assert_eq!(output, base);

        // The originating rig still accepts both chains.
        workspace
            .solve(
                &rig,
                &base,
                &[IkLayer::new(limb, 1.0), IkLayer::new(look_at, 1.0)],
                &mut output,
            )
            .unwrap();
    }

    #[test]
    fn cloned_workspaces_keep_outcome_capacity() {
        let fresh = IkWorkspace::new(rig().node_count());
        assert!(fresh.clone().outcomes.capacity() >= MAX_IK_LAYERS);

        let goal = IkGoal::Limb(LimbGoal::new(leg(&rig()), Vec3::new(0.25, 0.3, 0.2)));
        let (used, _, _) = solve(&[IkLayer::new(goal, 1.0)]);
        let clone = used.clone();
        assert!(clone.outcomes.capacity() >= MAX_IK_LAYERS);
        assert_eq!(clone, used);
    }

    #[test]
    fn exact_minimum_reach_fraction_solves_at_minimum_reach() {
        let rig = rig();
        let target = Vec3::new(0.1, 0.5, 0.0);
        let mut boundary_cases = 0;
        for step in 1..200 {
            // Straight leg: upper 0.5, lower varies so the f32 boundary
            // fraction rounds both up and down across the sweep.
            let lower_length = 0.013 * step as f32 + 0.0007;
            if (lower_length - 0.5).abs() < 0.01 {
                continue;
            }
            let mut base = base_pose();
            base[2] = translated(0.0, -0.5, 0.0);
            base[3] = translated(0.0, -lower_length, 0.0);
            let mut workspace = IkWorkspace::new(rig.node_count());
            let mut output = base.clone();
            let probe = IkGoal::Limb(LimbGoal::new(leg(&rig), target));
            workspace
                .solve(&rig, &base, &[IkLayer::new(probe, 0.0)], &mut output)
                .unwrap();
            let (upper, lower) = bone_lengths(&workspace, leg(&rig));
            let fraction = (upper - lower).abs() / (upper + lower);
            if (upper + lower) * fraction < (upper - lower).abs() {
                boundary_cases += 1;
            }

            let goal = LimbGoal::new(leg(&rig), target).with_max_reach(fraction);
            workspace
                .solve(
                    &rig,
                    &base,
                    &[IkLayer::new(IkGoal::Limb(goal), 1.0)],
                    &mut output,
                )
                .unwrap_or_else(|error| panic!("lower {lower_length}: {error}"));
            let reach = (workspace.world_position(3).unwrap()
                - workspace.world_position(1).unwrap())
            .length();
            assert!((reach - (upper - lower).abs()).abs() < TOLERANCE);

            // Clearly below the documented minimum is still rejected.
            let below = LimbGoal::new(leg(&rig), target)
                .with_max_reach(fraction - 10.0 * MIN_REACH_FRACTION_TOLERANCE);
            if below.max_reach > 0.0 {
                assert_eq!(
                    workspace.solve(
                        &rig,
                        &base,
                        &[IkLayer::new(IkGoal::Limb(below), 1.0)],
                        &mut output
                    ),
                    Err(IkError::ReachBelowMinimum { layer: 0 })
                );
            }
        }
        // The sweep must exercise the rounding case the tolerance exists for.
        assert!(boundary_cases > 0);
    }

    /// Deterministic generator for the look-at limit sweep.
    struct Lcg(u64);

    impl Lcg {
        fn next(&mut self) -> f32 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (self.0 >> 40) as f32 / (1u64 << 24) as f32
        }

        fn signed(&mut self) -> f32 {
            self.next() * 2.0 - 1.0
        }

        fn unit_quat(&mut self) -> Quat {
            Quat::new(self.signed(), self.signed(), self.signed(), self.signed())
                .normalized()
                .unwrap_or(Quat::IDENTITY)
        }
    }

    #[test]
    fn look_at_never_exceeds_max_angle_for_any_weights_or_masks() {
        // root(0) → a(1) → b(2) → c(3): the three-joint look-at chain. Wide
        // limits (above pi/2) make the permitted cap non-convex along great
        // circles, so neither a weighted step between two in-cap directions
        // nor a per-joint layer/mask blend is automatically inside it.
        let rig = IkRig::new(vec![None, Some(0), Some(1), Some(2)]).unwrap();
        let forward = Vec3::new(0.0, 0.0, 1.0);
        let mut rng = Lcg(0x5eed_1234_abcd_0001);
        let mut workspace = IkWorkspace::new(rig.node_count());
        let mut output = vec![Transform::IDENTITY; rig.node_count()];
        let mut wide_limits = 0;
        let mut unblended_cases = 0;
        let mut scaled_cases = 0;
        for case in 0..4000 {
            let mut base = vec![Transform::IDENTITY; rig.node_count()];
            for transform in base.iter_mut().skip(1) {
                transform.translation = Vec3::new(rng.signed(), rng.signed(), rng.signed());
                transform.rotation = rng.unit_quat();
            }
            let weights = [rng.next(), rng.next(), rng.next()];
            let chain = LookAtChain::new(
                &rig,
                &[(1, weights[0]), (2, weights[1]), (3, weights[2])],
                forward,
            )
            .unwrap();
            let max_angle = rng.next() * PI;
            if max_angle > FRAC_PI_2 {
                wide_limits += 1;
            }
            let goal = LookAtGoal {
                chain,
                target: Vec3::new(rng.signed(), rng.signed(), rng.signed()) * 3.0,
                max_angle,
            };
            let mut mask = JointMask::new(rig.node_count(), 1.0).unwrap();
            for joint in 1..4 {
                // Mix fully masked, fully applied, and partial joints.
                let pick = rng.next();
                let weight = if pick < 0.3 {
                    0.0
                } else if pick < 0.6 {
                    1.0
                } else {
                    rng.next()
                };
                mask.set(joint, weight).unwrap();
            }
            let layer_weight = if rng.next() < 0.5 { 1.0 } else { rng.next() };
            let masked = rng.next() < 0.5;

            workspace
                .solve(
                    &rig,
                    &base,
                    &[IkLayer::new(IkGoal::LookAt(goal), 0.0)],
                    &mut output,
                )
                .unwrap();
            let initial = rotate(workspace.world_rotation(3).unwrap(), forward);

            let mut layer = IkLayer::new(IkGoal::LookAt(goal), layer_weight);
            if masked {
                layer = layer.with_mask(&mask);
            }
            let mut full = vec![Transform::IDENTITY; rig.node_count()];
            workspace
                .solve(
                    &rig,
                    &base,
                    &[IkLayer::new(IkGoal::LookAt(goal), 1.0)],
                    &mut full,
                )
                .unwrap();
            workspace.solve(&rig, &base, &[layer], &mut output).unwrap();
            let aimed = rotate(workspace.world_rotation(3).unwrap(), forward);
            // The cap is enforced without bypassing weights: every joint stays
            // on its pre-layer → solved SLERP at no more than its effective
            // weight, all scaled by one common factor, and a joint with zero
            // effective weight keeps its base rotation exactly.
            let mut common_scale: Option<f32> = None;
            for joint in 1..4 {
                let factor = layer_weight * if masked { mask.weight(joint) } else { 1.0 };
                if factor <= 0.0 {
                    assert_eq!(output[joint].rotation, base[joint].rotation, "case {case}");
                    continue;
                }
                let solved_angle = quat_angle(base[joint].rotation, full[joint].rotation);
                // f32 `acos` near one is too coarse to compare tiny arcs.
                if solved_angle * factor < 0.2 {
                    continue;
                }
                let traveled = quat_angle(base[joint].rotation, output[joint].rotation);
                let scale = traveled / (solved_angle * factor);
                assert!(
                    scale <= 1.0 + 1.0e-2,
                    "case {case}: joint {joint} scale {scale}"
                );
                let off_path = quat_angle(
                    base[joint]
                        .rotation
                        .slerp(full[joint].rotation, (traveled / solved_angle).min(1.0)),
                    output[joint].rotation,
                );
                assert!(
                    off_path < 1.0e-2,
                    "case {case}: joint {joint} left its SLERP by {off_path}"
                );
                if let Some(common) = common_scale {
                    assert!(
                        (common - scale).abs() < 2.0e-2,
                        "case {case}: scales {common} vs {scale}"
                    );
                } else {
                    common_scale = Some(scale);
                }
            }
            if common_scale.is_some_and(|scale| scale < 0.98) {
                scaled_cases += 1;
            }
            let deviation = angle_between(initial, aimed);
            assert!(
                deviation <= max_angle + TOLERANCE,
                "case {case}: deviation {deviation} > limit {max_angle} \
                 (weights {weights:?}, layer {layer_weight}, masked {masked})"
            );
            if layer_weight >= 1.0 && !masked {
                // Nothing is blended here, so the post-blend correction never
                // runs and the solved weighted steps alone must respect the cap.
                unblended_cases += 1;
            }
        }
        assert!(wide_limits > 1000);
        assert!(unblended_cases > 500);
        assert!(scaled_cases > 5, "only {scaled_cases} cap-scaled blends");
    }

    #[test]
    fn zero_length_base_rotation_is_identity_for_ik_deltas() {
        // An unnormalizable base rotation means identity elsewhere in the
        // crate; the solver must still rotate the joint, not keep it zero.
        let rig = rig();
        let mut base = vec![Transform::IDENTITY; rig.node_count()];
        let mut identity_base = base.clone();
        base[5].rotation = Quat::new(0.0, 0.0, 0.0, 0.0);
        identity_base[5].rotation = Quat::IDENTITY;
        let chain = LookAtChain::new(&rig, &[(5, 1.0)], Vec3::new(0.0, 0.0, 1.0)).unwrap();
        let goal = IkGoal::LookAt(LookAtGoal {
            chain,
            target: Vec3::new(2.0, 2.0, 2.0),
            max_angle: PI,
        });
        let mut workspace = IkWorkspace::new(rig.node_count());
        let mut output = vec![Transform::IDENTITY; rig.node_count()];
        workspace
            .solve(&rig, &base, &[IkLayer::new(goal, 1.0)], &mut output)
            .unwrap();
        assert_eq!(workspace.outcomes()[0].status, IkStatus::Reached);
        assert!(workspace.outcomes()[0].residual < TOLERANCE);
        let mut expected = vec![Transform::IDENTITY; rig.node_count()];
        workspace
            .solve(
                &rig,
                &identity_base,
                &[IkLayer::new(goal, 1.0)],
                &mut expected,
            )
            .unwrap();
        assert!(quat_angle(output[5].rotation, expected[5].rotation) < TOLERANCE);
    }
}
