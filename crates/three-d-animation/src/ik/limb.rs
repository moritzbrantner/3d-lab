use crate::retarget::{finite_vec3, quat_conjugate, quat_mul};
use crate::{Quat, Transform};

use super::goal::{EndEffector, LimbGoal, TwoBoneChain};
use super::math::{
    angle_between, any_perpendicular, axis_angle, from_to, law_of_cosines, reject, rotate,
    signed_angle,
};
use super::rig::IkRig;
use super::solve::{IkSolveStats, IkStatus, IkWorkspace};
use super::{EPSILON, IkError, MIN_REACH_FRACTION_TOLERANCE};

const REACH_TOLERANCE: f32 = 1.0e-4;

impl IkWorkspace {
    pub(super) fn solve_limb(
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
        // Finite inputs can still compose to overflowing world positions.
        if !(finite_vec3(a) && finite_vec3(b) && finite_vec3(c) && (upper + lower).is_finite()) {
            return Err(IkError::NonFiniteWorldPose { layer });
        }
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

        let current_mid = angle_between(a - b, c - b);
        let desired_root = law_of_cosines(upper, reach, lower);
        let desired_mid = law_of_cosines(upper, lower, reach);
        // A limb folded exactly back onto its root (equal bones, tip at the
        // root) has no defined root angle. Opening the mid joint alone already
        // yields the desired root-to-tip length; the aim step below then
        // points it at the target and the pole twist sets the bend plane.
        let root_bend = if ac.normalized().is_some() {
            axis_angle(axis, desired_root - angle_between(ac, ab))
        } else {
            Quat::IDENTITY
        };
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
}
