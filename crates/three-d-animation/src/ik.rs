//! Deterministic procedural animation helpers.
//!
//! World/physics systems own target discovery. This module only consumes explicit
//! targets and applies bounded, allocation-free pose corrections.

use core::fmt;

use three_d_core::Vec3;

use crate::Transform;

const EPSILON: f32 = 1.0e-6;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TwoBoneChain {
    pub upper_length: f32,
    pub lower_length: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TwoBoneTarget {
    pub root: Vec3,
    pub target: Vec3,
    pub pole: Vec3,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TwoBoneSolution {
    pub joint: Vec3,
    pub end: Vec3,
    pub reached_target: bool,
    pub solved_distance: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LookAtLimits {
    pub max_yaw_radians: f32,
    pub max_pitch_radians: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LookAtSolution {
    pub yaw_radians: f32,
    pub pitch_radians: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum IkError {
    InvalidLength,
    NonFiniteTarget,
    CoincidentRootAndTarget,
    InvalidLookLimits,
    PoseLengthMismatch {
        role: &'static str,
        expected: usize,
        actual: usize,
    },
    InvalidLayerWeight {
        node: usize,
    },
}

impl fmt::Display for IkError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidLength => formatter.write_str("two-bone lengths must be finite and positive"),
            Self::NonFiniteTarget => formatter.write_str("IK target vectors must be finite"),
            Self::CoincidentRootAndTarget => {
                formatter.write_str("two-bone root and target must not coincide")
            }
            Self::InvalidLookLimits => {
                formatter.write_str("look-at limits must be finite and non-negative")
            }
            Self::PoseLengthMismatch {
                role,
                expected,
                actual,
            } => write!(
                formatter,
                "{role} length mismatch: expected {expected}, got {actual}"
            ),
            Self::InvalidLayerWeight { node } => {
                write!(formatter, "pose layer weight for node {node} must be between 0 and 1")
            }
        }
    }
}

impl std::error::Error for IkError {}

fn finite(value: Vec3) -> bool {
    value.x.is_finite() && value.y.is_finite() && value.z.is_finite()
}

fn fallback_bend_direction(direction: Vec3) -> Vec3 {
    let axis = if direction.x.abs() <= direction.y.abs() && direction.x.abs() <= direction.z.abs() {
        Vec3::new(1.0, 0.0, 0.0)
    } else if direction.y.abs() <= direction.z.abs() {
        Vec3::new(0.0, 1.0, 0.0)
    } else {
        Vec3::new(0.0, 0.0, 1.0)
    };
    direction
        .cross(axis)
        .cross(direction)
        .normalized()
        .unwrap_or(Vec3::new(0.0, 1.0, 0.0))
}

/// Closed-form two-bone solve. Work is constant and contains no iterative loop.
pub fn solve_two_bone(
    chain: TwoBoneChain,
    target: TwoBoneTarget,
) -> Result<TwoBoneSolution, IkError> {
    if !chain.upper_length.is_finite()
        || !chain.lower_length.is_finite()
        || chain.upper_length <= EPSILON
        || chain.lower_length <= EPSILON
    {
        return Err(IkError::InvalidLength);
    }
    if !finite(target.root) || !finite(target.target) || !finite(target.pole) {
        return Err(IkError::NonFiniteTarget);
    }

    let target_delta = target.target - target.root;
    let target_distance = target_delta.length();
    let Some(direction) = target_delta.normalized() else {
        return Err(IkError::CoincidentRootAndTarget);
    };

    let minimum = (chain.upper_length - chain.lower_length).abs() + EPSILON;
    let maximum = (chain.upper_length + chain.lower_length - EPSILON).max(minimum);
    let solved_distance = target_distance.clamp(minimum, maximum);
    let reached_target = (solved_distance - target_distance).abs() <= EPSILON;

    let pole_delta = target.pole - target.root;
    let bend = direction
        .cross(pole_delta)
        .normalized()
        .and_then(|normal| normal.cross(direction).normalized())
        .unwrap_or_else(|| fallback_bend_direction(direction));

    let upper = chain.upper_length;
    let lower = chain.lower_length;
    let along = (upper * upper - lower * lower + solved_distance * solved_distance)
        / (2.0 * solved_distance);
    let height = (upper * upper - along * along).max(0.0).sqrt();
    let joint = target.root + direction * along + bend * height;
    let end = target.root + direction * solved_distance;

    Ok(TwoBoneSolution {
        joint,
        end,
        reached_target,
        solved_distance,
    })
}

/// Forward is +Z, yaw turns around +Y, pitch raises toward +Y.
pub fn solve_look_at(
    origin: Vec3,
    target: Vec3,
    limits: LookAtLimits,
) -> Result<LookAtSolution, IkError> {
    if !finite(origin) || !finite(target) {
        return Err(IkError::NonFiniteTarget);
    }
    if !limits.max_yaw_radians.is_finite()
        || !limits.max_pitch_radians.is_finite()
        || limits.max_yaw_radians < 0.0
        || limits.max_pitch_radians < 0.0
    {
        return Err(IkError::InvalidLookLimits);
    }
    let delta = target - origin;
    if delta.length() <= EPSILON {
        return Err(IkError::CoincidentRootAndTarget);
    }
    let horizontal = (delta.x * delta.x + delta.z * delta.z).sqrt();
    Ok(LookAtSolution {
        yaw_radians: delta
            .x
            .atan2(delta.z)
            .clamp(-limits.max_yaw_radians, limits.max_yaw_radians),
        pitch_radians: delta
            .y
            .atan2(horizontal)
            .clamp(-limits.max_pitch_radians, limits.max_pitch_radians),
    })
}

/// Blend one complete procedural layer over a base pose using one weight per node.
///
/// Inputs are borrowed and never mutated. Output is caller-owned and may be reused.
pub fn apply_pose_layer(
    base: &[Transform],
    layer: &[Transform],
    weights: &[f32],
    output: &mut [Transform],
) -> Result<(), IkError> {
    let expected = base.len();
    for (role, actual) in [
        ("layer pose", layer.len()),
        ("layer weights", weights.len()),
        ("layer output", output.len()),
    ] {
        if actual != expected {
            return Err(IkError::PoseLengthMismatch {
                role,
                expected,
                actual,
            });
        }
    }

    for (node, (((base, layer), weight), output)) in base
        .iter()
        .zip(layer)
        .zip(weights)
        .zip(output.iter_mut())
        .enumerate()
    {
        if !weight.is_finite() || !(0.0..=1.0).contains(weight) {
            return Err(IkError::InvalidLayerWeight { node });
        }
        *output = base.blended(*layer, *weight);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_vec_close(actual: Vec3, expected: Vec3) {
        assert!((actual.x - expected.x).abs() < 1.0e-4, "{actual:?}");
        assert!((actual.y - expected.y).abs() < 1.0e-4, "{actual:?}");
        assert!((actual.z - expected.z).abs() < 1.0e-4, "{actual:?}");
    }

    #[test]
    fn reachable_target_is_hit_with_both_segment_lengths_preserved() {
        let root = Vec3::ZERO;
        let solution = solve_two_bone(
            TwoBoneChain {
                upper_length: 1.0,
                lower_length: 0.8,
            },
            TwoBoneTarget {
                root,
                target: Vec3::new(1.2, 0.4, 0.0),
                pole: Vec3::new(0.0, 0.0, 1.0),
            },
        )
        .unwrap();
        assert!(solution.reached_target);
        assert_vec_close(solution.end, Vec3::new(1.2, 0.4, 0.0));
        assert!(((solution.joint - root).length() - 1.0).abs() < 1.0e-4);
        assert!(((solution.end - solution.joint).length() - 0.8).abs() < 1.0e-4);
    }

    #[test]
    fn unreachable_target_clamps_to_maximum_reach_without_iteration() {
        let solution = solve_two_bone(
            TwoBoneChain {
                upper_length: 1.0,
                lower_length: 0.5,
            },
            TwoBoneTarget {
                root: Vec3::ZERO,
                target: Vec3::new(10.0, 0.0, 0.0),
                pole: Vec3::new(0.0, 1.0, 0.0),
            },
        )
        .unwrap();
        assert!(!solution.reached_target);
        assert!((solution.solved_distance - 1.5).abs() < 2.0e-6);
        assert!((solution.end.length() - 1.5).abs() < 2.0e-6);
    }

    #[test]
    fn degenerate_pole_uses_a_deterministic_fallback_plane() {
        let target = TwoBoneTarget {
            root: Vec3::ZERO,
            target: Vec3::new(1.0, 0.0, 0.0),
            pole: Vec3::new(2.0, 0.0, 0.0),
        };
        let first = solve_two_bone(
            TwoBoneChain {
                upper_length: 0.8,
                lower_length: 0.8,
            },
            target,
        )
        .unwrap();
        let second = solve_two_bone(
            TwoBoneChain {
                upper_length: 0.8,
                lower_length: 0.8,
            },
            target,
        )
        .unwrap();
        assert_eq!(first, second);
        assert!(finite(first.joint));
    }

    #[test]
    fn look_at_respects_yaw_and_pitch_limits() {
        let solved = solve_look_at(
            Vec3::ZERO,
            Vec3::new(10.0, 10.0, 0.1),
            LookAtLimits {
                max_yaw_radians: 0.5,
                max_pitch_radians: 0.25,
            },
        )
        .unwrap();
        assert_eq!(solved.yaw_radians, 0.5);
        assert_eq!(solved.pitch_radians, 0.25);
    }

    #[test]
    fn layered_pose_respects_masks_without_mutating_inputs() {
        let base = [
            Transform::IDENTITY,
            Transform {
                translation: Vec3::new(1.0, 0.0, 0.0),
                ..Transform::IDENTITY
            },
        ];
        let layer = [
            Transform {
                translation: Vec3::new(4.0, 0.0, 0.0),
                ..Transform::IDENTITY
            },
            Transform {
                translation: Vec3::new(3.0, 0.0, 0.0),
                ..Transform::IDENTITY
            },
        ];
        let original_base = base;
        let original_layer = layer;
        let mut output = [Transform::IDENTITY; 2];

        apply_pose_layer(&base, &layer, &[0.0, 0.5], &mut output).unwrap();

        assert_eq!(output[0], base[0]);
        assert_eq!(output[1].translation, Vec3::new(2.0, 0.0, 0.0));
        assert_eq!(base, original_base);
        assert_eq!(layer, original_layer);
    }
}
