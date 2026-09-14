//! Renderer-independent projective matrix utilities for `3d-lab`.
//!
//! This crate complements `three-d-camera`: camera crates construct view/projection matrices,
//! while this crate provides generic homogeneous point transforms and inversion without owning
//! renderer, scene, geographic, or interaction semantics.

use core::fmt;
use three_d_animation::Mat4;
use three_d_core::Vec3;

const HOMOGENEOUS_EPSILON: f64 = 1.0e-12;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectiveError {
    NonFiniteMatrix,
    NonFinitePoint,
    SingularMatrix,
    InvalidHomogeneousCoordinate,
    UnrepresentableResult,
}

impl fmt::Display for ProjectiveError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NonFiniteMatrix => formatter.write_str("matrix elements must be finite"),
            Self::NonFinitePoint => formatter.write_str("point coordinates must be finite"),
            Self::SingularMatrix => {
                formatter.write_str("matrix is singular and cannot be inverted")
            }
            Self::InvalidHomogeneousCoordinate => formatter
                .write_str("projective transform produced an invalid homogeneous coordinate"),
            Self::UnrepresentableResult => formatter.write_str(
                "projective transform result cannot be represented as finite f32 values",
            ),
        }
    }
}

impl std::error::Error for ProjectiveError {}

/// Transforms a 3D point as `(x, y, z, 1)` and performs the homogeneous divide.
pub fn transform_point_projective(matrix: Mat4, point: Vec3) -> Result<Vec3, ProjectiveError> {
    ensure_finite_matrix(matrix)?;
    if !finite_vec3(point) {
        return Err(ProjectiveError::NonFinitePoint);
    }

    let m = matrix.elements;
    let x = f64::from(point.x);
    let y = f64::from(point.y);
    let z = f64::from(point.z);

    let transformed_x =
        f64::from(m[0]) * x + f64::from(m[4]) * y + f64::from(m[8]) * z + f64::from(m[12]);
    let transformed_y =
        f64::from(m[1]) * x + f64::from(m[5]) * y + f64::from(m[9]) * z + f64::from(m[13]);
    let transformed_z =
        f64::from(m[2]) * x + f64::from(m[6]) * y + f64::from(m[10]) * z + f64::from(m[14]);
    let transformed_w =
        f64::from(m[3]) * x + f64::from(m[7]) * y + f64::from(m[11]) * z + f64::from(m[15]);

    if !transformed_w.is_finite() || transformed_w.abs() <= HOMOGENEOUS_EPSILON {
        return Err(ProjectiveError::InvalidHomogeneousCoordinate);
    }

    Ok(Vec3::new(
        checked_f32(transformed_x / transformed_w)?,
        checked_f32(transformed_y / transformed_w)?,
        checked_f32(transformed_z / transformed_w)?,
    ))
}

/// Returns the inverse of a finite 4x4 matrix using deterministic Gauss-Jordan elimination.
pub fn inverse(matrix: Mat4) -> Result<Mat4, ProjectiveError> {
    ensure_finite_matrix(matrix)?;

    let mut augmented = [[0.0_f64; 8]; 4];
    for (row, values) in augmented.iter_mut().enumerate() {
        for (column, value) in values.iter_mut().take(4).enumerate() {
            *value = f64::from(matrix.elements[column * 4 + row]);
        }
        values[4 + row] = 1.0;
    }

    for column in 0..4 {
        let mut pivot_row = column;
        let mut pivot_abs = augmented[column][column].abs();
        for (row, values) in augmented.iter().enumerate().skip(column + 1) {
            let candidate = values[column].abs();
            if candidate > pivot_abs {
                pivot_abs = candidate;
                pivot_row = row;
            }
        }

        if !pivot_abs.is_finite() || pivot_abs == 0.0 {
            return Err(ProjectiveError::SingularMatrix);
        }

        if pivot_row != column {
            augmented.swap(column, pivot_row);
        }

        let pivot = augmented[column][column];
        for value in &mut augmented[column] {
            *value /= pivot;
        }

        let pivot_values = augmented[column];
        for (row, values) in augmented.iter_mut().enumerate() {
            if row == column {
                continue;
            }
            let factor = values[column];
            if factor == 0.0 {
                continue;
            }
            for (value, pivot_value) in values.iter_mut().zip(pivot_values) {
                *value -= factor * pivot_value;
            }
        }
    }

    let mut elements = [0.0_f32; 16];
    for (row, values) in augmented.iter().enumerate() {
        for (column, value) in values[4..].iter().enumerate() {
            elements[column * 4 + row] = checked_f32(*value)?;
        }
    }

    Ok(Mat4 { elements })
}

/// Applies the inverse of `matrix` to a projective point.
pub fn untransform_point_projective(matrix: Mat4, point: Vec3) -> Result<Vec3, ProjectiveError> {
    transform_point_projective(inverse(matrix)?, point)
}

fn ensure_finite_matrix(matrix: Mat4) -> Result<(), ProjectiveError> {
    if matrix.elements.into_iter().all(f32::is_finite) {
        Ok(())
    } else {
        Err(ProjectiveError::NonFiniteMatrix)
    }
}

fn finite_vec3(value: Vec3) -> bool {
    value.x.is_finite() && value.y.is_finite() && value.z.is_finite()
}

fn checked_f32(value: f64) -> Result<f32, ProjectiveError> {
    if !value.is_finite() || value.abs() > f64::from(f32::MAX) {
        return Err(ProjectiveError::UnrepresentableResult);
    }
    Ok(value as f32)
}

#[cfg(test)]
mod tests {
    use super::*;
    use three_d_animation::{Quat, Transform};
    use three_d_camera::PerspectiveCamera;

    const EPSILON: f32 = 1.0e-4;

    fn assert_vec3_close(left: Vec3, right: Vec3) {
        assert!(
            (left.x - right.x).abs() <= EPSILON,
            "x: {left:?} != {right:?}"
        );
        assert!(
            (left.y - right.y).abs() <= EPSILON,
            "y: {left:?} != {right:?}"
        );
        assert!(
            (left.z - right.z).abs() <= EPSILON,
            "z: {left:?} != {right:?}"
        );
    }

    #[test]
    fn affine_projective_transform_matches_affine_transform_point() {
        let transform = Transform {
            translation: Vec3::new(3.0, -2.0, 5.0),
            rotation: Quat::from_euler_xyz(0.2, -0.4, 0.1),
            scale: Vec3::new(2.0, 0.5, 1.5),
        }
        .matrix();
        let point = Vec3::new(1.25, -4.0, 0.75);

        assert_vec3_close(
            transform_point_projective(transform, point).expect("affine transform is valid"),
            transform.transform_point(point),
        );
    }

    #[test]
    fn inverse_round_trips_affine_transform() {
        let transform = Transform {
            translation: Vec3::new(2.0, 3.0, -4.0),
            rotation: Quat::from_euler_xyz(0.35, -0.2, 0.6),
            scale: Vec3::new(1.5, 0.75, 2.0),
        }
        .matrix();
        let point = Vec3::new(-0.5, 1.25, 3.0);
        let transformed = transform_point_projective(transform, point).expect("transform succeeds");

        assert_vec3_close(
            untransform_point_projective(transform, transformed).expect("inverse succeeds"),
            point,
        );
    }

    #[test]
    fn perspective_view_projection_round_trips_ndc_point() {
        let camera = PerspectiveCamera::new(
            Vec3::new(2.0, 3.0, 4.0),
            Vec3::ZERO,
            Vec3::new(0.0, 1.0, 0.0),
            core::f32::consts::FRAC_PI_3,
            16.0 / 9.0,
            0.1,
            100.0,
        )
        .expect("camera is valid");
        let world = Vec3::new(0.25, -0.15, 0.5);
        let view_projection = camera.view_projection_matrix();
        let ndc = transform_point_projective(view_projection, world).expect("projection succeeds");
        let restored =
            untransform_point_projective(view_projection, ndc).expect("unprojection succeeds");

        assert_vec3_close(restored, world);
    }

    #[test]
    fn singular_matrix_fails_closed() {
        let singular = Mat4 {
            elements: [0.0; 16],
        };

        assert_eq!(inverse(singular), Err(ProjectiveError::SingularMatrix));
    }

    #[test]
    fn zero_homogeneous_coordinate_fails_closed() {
        let matrix = Mat4 {
            elements: [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            ],
        };

        assert_eq!(
            transform_point_projective(matrix, Vec3::ZERO),
            Err(ProjectiveError::InvalidHomogeneousCoordinate),
        );
    }
}
