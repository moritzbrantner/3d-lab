use three_d_core::Vec3;

use crate::retarget::quat_mul;
use crate::{Quat, Transform};

use super::goal::{IkLayer, LookAtChain, LookAtGoal};
use super::math::{angle_between, clamp_direction, from_to, rotate};
use super::rig::IkRig;
use super::solve::{IkSolveStats, IkStatus, IkWorkspace, Snapshot, blend_rotation, layer_factor};

/// Remaining aim angle (radians) below which a look-at layer counts as reached.
const LOOK_AT_ANGLE_TOLERANCE: f32 = 1.0e-3;
/// Fixed bisection steps used to scale a blended look-at layer back inside
/// its angle cap. Each step composes only the chain's local rotations (no
/// hierarchy refresh), so the work stays bounded and allocation-free.
const LOOK_AT_BLEND_SCALE_STEPS: usize = 20;

impl IkWorkspace {
    pub(super) fn solve_look_at(
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

    pub(super) fn aim_direction(&self, chain: &LookAtChain) -> Vec3 {
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
    pub(super) fn limit_blended_look_at(
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
}
