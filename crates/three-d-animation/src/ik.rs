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

mod error;
mod goal;
mod limb;
mod look_at;
mod math;
mod rig;
mod solve;
#[cfg(test)]
mod tests;

pub use error::IkError;
pub use goal::{
    EndEffector, IkGoal, IkLayer, JointMask, LimbGoal, LookAtChain, LookAtGoal, TwoBoneChain,
};
pub use rig::IkRig;
pub use solve::{IkLayerOutcome, IkSolveStats, IkStatus, IkWorkspace};

/// Maximum number of layers one solve accepts.
pub const MAX_IK_LAYERS: usize = 16;
/// Maximum number of joints in one look-at chain.
pub const MAX_LOOK_AT_JOINTS: usize = 4;
/// Upper bound on hierarchy refresh passes per applied layer. Each pass visits
/// at most every node once, so one solve visits at most
/// `node_count * (1 + layers * MAX_WORLD_PASSES_PER_LAYER)` nodes.
pub const MAX_WORLD_PASSES_PER_LAYER: usize = MAX_LOOK_AT_JOINTS + 2;

const EPSILON: f32 = 1.0e-6;
/// Slack applied to the inclusive minimum reach fraction so a fraction
/// computed exactly as `|upper - lower| / (upper + lower)` still solves despite
/// `f32` rounding.
pub const MIN_REACH_FRACTION_TOLERANCE: f32 = 1.0e-5;
