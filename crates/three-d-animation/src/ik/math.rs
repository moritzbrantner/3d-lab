use core::f32::consts::PI;

use three_d_core::Vec3;

use crate::{Mat4, Quat};

use super::EPSILON;

pub(super) fn position(matrix: Mat4) -> Vec3 {
    Vec3::new(
        matrix.elements[12],
        matrix.elements[13],
        matrix.elements[14],
    )
}

pub(super) fn rotate(rotation: Quat, value: Vec3) -> Vec3 {
    let axis = Vec3::new(rotation.x, rotation.y, rotation.z);
    let twice = axis.cross(value) * 2.0;
    value + twice * rotation.w + axis.cross(twice)
}

pub(super) fn axis_angle(axis: Vec3, angle: f32) -> Quat {
    Quat::from_axis_angle(axis, angle).unwrap_or(Quat::IDENTITY)
}

pub(super) fn angle_between(left: Vec3, right: Vec3) -> f32 {
    match (left.normalized(), right.normalized()) {
        (Some(left), Some(right)) => left.dot(right).clamp(-1.0, 1.0).acos(),
        _ => 0.0,
    }
}

/// Interior angle opposite `opposite` in a triangle with the other two sides.
pub(super) fn law_of_cosines(adjacent_a: f32, adjacent_b: f32, opposite: f32) -> f32 {
    let cosine = (adjacent_a * adjacent_a + adjacent_b * adjacent_b - opposite * opposite)
        / (2.0 * adjacent_a * adjacent_b);
    cosine.clamp(-1.0, 1.0).acos()
}

pub(super) fn any_perpendicular(value: Vec3) -> Vec3 {
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
pub(super) fn from_to(from: Vec3, to: Vec3) -> Quat {
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

pub(super) fn reject(value: Vec3, unit_axis: Vec3) -> Vec3 {
    value - unit_axis * value.dot(unit_axis)
}

pub(super) fn signed_angle(from: Vec3, to: Vec3, unit_axis: Vec3) -> f32 {
    let sine = from.cross(to).dot(unit_axis);
    let cosine = from.dot(to);
    sine.atan2(cosine)
}

pub(super) fn clamp_direction(reference: Vec3, desired: Vec3, max_angle: f32) -> (Vec3, bool) {
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
