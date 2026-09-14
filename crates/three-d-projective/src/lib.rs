//! Renderer-independent projective matrix utilities for `3d-lab`.
//!
//! This crate complements `three-d-camera`: camera crates construct view/projection matrices,
//! while this crate provides generic homogeneous point transforms and inversion without owning
//! renderer, scene, geographic, or interaction semantics.

use core::fmt;
use three_d_animation::Mat4;
use three_d_core::Vec3;

const SINGULAR_PIVOT_SCALE_FACTOR: f64 = 64.0;

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
    let transformed = transform_point_projective_f64(
        matrix,
        [f64::from(point.x), f64::from(point.y), f64::from(point.z)],
    )?;

    Ok(Vec3::new(
        checked_f32(transformed[0])?,
        checked_f32(transformed[1])?,
        checked_f32(transformed[2])?,
    ))
}

/// Transforms a finite f64 point through an f32 `Mat4` without truncating the result back to f32.
///
/// This is intended for precision-sensitive adapters that deliberately rebase their domain into
/// a numerically safe local frame before consuming shared renderer-independent matrix math.
pub fn transform_point_projective_f64(
    matrix: Mat4,
    point: [f64; 3],
) -> Result<[f64; 3], ProjectiveError> {
    ensure_finite_matrix(matrix)?;
    ensure_finite_point(point)?;
    transform_rows_projective(matrix_rows_f64(matrix), point)
}

/// Returns the inverse of a finite 4x4 matrix using deterministic Gauss-Jordan elimination.
pub fn inverse(matrix: Mat4) -> Result<Mat4, ProjectiveError> {
    let inverse = inverse_rows_f64(matrix)?;
    let mut elements = [0.0_f32; 16];
    for (row, values) in inverse.iter().enumerate() {
        for (column, value) in values.iter().enumerate() {
            elements[column * 4 + row] = checked_f32(*value)?;
        }
    }
    Ok(Mat4 { elements })
}

/// Applies the inverse of `matrix` to a projective point.
pub fn untransform_point_projective(matrix: Mat4, point: Vec3) -> Result<Vec3, ProjectiveError> {
    let transformed = untransform_point_projective_f64(
        matrix,
        [f64::from(point.x), f64::from(point.y), f64::from(point.z)],
    )?;

    Ok(Vec3::new(
        checked_f32(transformed[0])?,
        checked_f32(transformed[1])?,
        checked_f32(transformed[2])?,
    ))
}

/// Applies the inverse of an f32 `Mat4` while retaining f64 inverse/intersection precision.
///
/// Returning f64 values avoids quantizing inverse-matrix results before a consumer performs a
/// long ray extension or another precision-sensitive local-frame calculation.
pub fn untransform_point_projective_f64(
    matrix: Mat4,
    point: [f64; 3],
) -> Result<[f64; 3], ProjectiveError> {
    ensure_finite_point(point)?;
    transform_rows_projective(inverse_rows_f64(matrix)?, point)
}

fn inverse_rows_f64(matrix: Mat4) -> Result<[[f64; 4]; 4], ProjectiveError> {
    ensure_finite_matrix(matrix)?;

    let rows = matrix_rows_f64(matrix);
    let mut matrix_scale = 0.0_f64;
    for row in rows {
        for value in row {
            matrix_scale = matrix_scale.max(value.abs());
        }
    }
    if matrix_scale == 0.0 {
        return Err(ProjectiveError::SingularMatrix);
    }
    let pivot_tolerance = matrix_scale * f64::EPSILON * SINGULAR_PIVOT_SCALE_FACTOR;

    let mut augmented = [[0.0_f64; 8]; 4];
    for (row_index, values) in augmented.iter_mut().enumerate() {
        values[..4].copy_from_slice(&rows[row_index]);
        values[4 + row_index] = 1.0;
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

        if !pivot_abs.is_finite() || pivot_abs <= pivot_tolerance {
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

    let mut inverse = [[0.0_f64; 4]; 4];
    for (row, values) in augmented.iter().enumerate() {
        inverse[row].copy_from_slice(&values[4..]);
    }
    Ok(inverse)
}

fn matrix_rows_f64(matrix: Mat4) -> [[f64; 4]; 4] {
    let mut rows = [[0.0_f64; 4]; 4];
    for (row, values) in rows.iter_mut().enumerate() {
        for (column, value) in values.iter_mut().enumerate() {
            *value = f64::from(matrix.elements[column * 4 + row]);
        }
    }
    rows
}

fn transform_rows_projective(
    rows: [[f64; 4]; 4],
    point: [f64; 3],
) -> Result<[f64; 3], ProjectiveError> {
    let homogeneous = [point[0], point[1], point[2], 1.0];
    let mut transformed = [0.0_f64; 4];
    for (output, row) in transformed.iter_mut().zip(rows) {
        *output = row
            .into_iter()
            .zip(homogeneous)
            .map(|(left, right)| left * right)
            .sum();
    }

    let w = transformed[3];
    if !w.is_finite() || w == 0.0 {
        return Err(ProjectiveError::InvalidHomogeneousCoordinate);
    }

    let result = [transformed[0] / w, transformed[1] / w, transformed[2] / w];
    if result.into_iter().all(f64::is_finite) {
        Ok(result)
    } else {
        Err(ProjectiveError::UnrepresentableResult)
    }
}

fn ensure_finite_matrix(matrix: Mat4) -> Result<(), ProjectiveError> {
    if matrix.elements.into_iter().all(f32::is_finite) {
        Ok(())
    } else {
        Err(ProjectiveError::NonFiniteMatrix)
    }
}

fn ensure_finite_point(point: [f64; 3]) -> Result<(), ProjectiveError> {
    if point.into_iter().all(f64::is_finite) {
        Ok(())
    } else {
        Err(ProjectiveError::NonFinitePoint)
    }
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
    const PRECISE_EPSILON: f64 = 1.0e-4;

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

    fn mat4_from_rows(rows: [[f32; 4]; 4]) -> Mat4 {
        let mut elements = [0.0_f32; 16];
        for (row, values) in rows.iter().enumerate() {
            for (column, value) in values.iter().enumerate() {
                elements[column * 4 + row] = *value;
            }
        }
        Mat4 { elements }
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
    fn f64_inverse_bridge_preserves_long_ray_precision() {
        let camera = PerspectiveCamera::new(
            Vec3::new(0.0, 0.0, 869.116_94),
            Vec3::ZERO,
            Vec3::new(0.0, 1.0, 0.0),
            core::f32::consts::FRAC_PI_4,
            16.0 / 9.0,
            0.086_911_69,
            8_802_783.0,
        )
        .expect("large depth ratio remains a valid camera");
        let matrix = camera.view_projection_matrix();
        let world = [78.279_11, 53.907_085, 0.0];
        let ndc = transform_point_projective_f64(matrix, world).expect("point projects");
        let ray_start = untransform_point_projective_f64(matrix, [ndc[0], ndc[1], 0.0])
            .expect("near-depth sample is finite");
        let ray_sample = untransform_point_projective_f64(matrix, [ndc[0], ndc[1], 0.5])
            .expect("mid-depth sample is finite");
        let ray_delta = [
            ray_sample[0] - ray_start[0],
            ray_sample[1] - ray_start[1],
            ray_sample[2] - ray_start[2],
        ];
        let factor = -ray_start[2] / ray_delta[2];
        assert!(factor.is_finite() && factor >= 0.0);

        let restored = [
            ray_start[0] + ray_delta[0] * factor,
            ray_start[1] + ray_delta[1] * factor,
            ray_start[2] + ray_delta[2] * factor,
        ];
        assert!((restored[0] - world[0]).abs() <= PRECISE_EPSILON);
        assert!((restored[1] - world[1]).abs() <= PRECISE_EPSILON);
        assert!(restored[2].abs() <= PRECISE_EPSILON);
    }

    #[test]
    fn singular_matrix_fails_closed() {
        let singular = Mat4 {
            elements: [0.0; 16],
        };

        assert_eq!(inverse(singular), Err(ProjectiveError::SingularMatrix));
    }

    #[test]
    fn dependent_rows_with_rounding_residual_fail_closed() {
        let singular = mat4_from_rows([
            [-9.0, -1.0, 18.0, -3.0],
            [-18.0, 12.0, 0.0, 14.0],
            [2.0, 6.0, -4.0, 1.0],
            [8.0, -70.0, 92.0, -59.0],
        ]);

        assert_eq!(inverse(singular), Err(ProjectiveError::SingularMatrix));
    }

    #[test]
    fn homogeneous_transform_preserves_uniform_scale_invariance() {
        let scale = 1.0e-13_f32;
        let scaled_identity = Mat4 {
            elements: [
                scale, 0.0, 0.0, 0.0, 0.0, scale, 0.0, 0.0, 0.0, 0.0, scale, 0.0, 0.0, 0.0,
                0.0, scale,
            ],
        };
        let point = Vec3::new(1.25, -2.5, 3.75);

        assert_vec3_close(
            transform_point_projective(scaled_identity, point)
                .expect("uniform homogeneous scale remains valid"),
            point,
        );
    }

    #[test]
    fn zero_homogeneous_coordinate_fails_closed() {
        let matrix = Mat4 {
            elements: [
                1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0,
            ],
        };

        assert_eq!(
            transform_point_projective(matrix, Vec3::ZERO),
            Err(ProjectiveError::InvalidHomogeneousCoordinate),
        );
    }
}
