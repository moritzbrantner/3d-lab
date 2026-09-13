use super::Mat4;

const INVERSE_RELATIVE_EPSILON: f64 = f32::EPSILON as f64 * 8.0;

impl Mat4 {
    /// Transforms one homogeneous four-component vector without performing a
    /// perspective divide. This is the primitive camera consumers need for
    /// clip-space projection and inverse projection.
    pub fn transform_homogeneous(self, value: [f32; 4]) -> [f32; 4] {
        let m = self.elements;
        [
            m[0] * value[0] + m[4] * value[1] + m[8] * value[2] + m[12] * value[3],
            m[1] * value[0] + m[5] * value[1] + m[9] * value[2] + m[13] * value[3],
            m[2] * value[0] + m[6] * value[1] + m[10] * value[2] + m[14] * value[3],
            m[3] * value[0] + m[7] * value[1] + m[11] * value[2] + m[15] * value[3],
        ]
    }

    /// Returns the inverse of a finite, nonsingular matrix.
    ///
    /// Elimination is evaluated in `f64` even though the durable renderer-facing
    /// matrix contract is `f32`. Scaled partial pivoting rejects matrices whose
    /// remaining rank is below useful `f32` precision instead of accepting tiny
    /// roundoff pivots from singular inputs. The conversion then fails closed if
    /// the inverse cannot be represented as finite `f32` values.
    #[allow(clippy::needless_range_loop)]
    pub fn inverse(self) -> Option<Self> {
        if self.elements.iter().any(|value| !value.is_finite()) {
            return None;
        }

        let mut augmented = [[0.0_f64; 8]; 4];
        let mut row_scales = [0.0_f64; 4];
        for row in 0..4 {
            for column in 0..4 {
                let value = f64::from(self.elements[column * 4 + row]);
                augmented[row][column] = value;
                row_scales[row] = row_scales[row].max(value.abs());
            }
            if row_scales[row] == 0.0 {
                return None;
            }
            augmented[row][4 + row] = 1.0;
        }

        for column in 0..4 {
            let mut pivot_row = column;
            let mut pivot_ratio = augmented[column][column].abs() / row_scales[column];
            for row in column + 1..4 {
                let ratio = augmented[row][column].abs() / row_scales[row];
                if ratio > pivot_ratio {
                    pivot_row = row;
                    pivot_ratio = ratio;
                }
            }
            if !pivot_ratio.is_finite() || pivot_ratio <= INVERSE_RELATIVE_EPSILON {
                return None;
            }
            if pivot_row != column {
                augmented.swap(column, pivot_row);
                row_scales.swap(column, pivot_row);
            }

            let pivot = augmented[column][column];
            if pivot.abs() <= row_scales[column] * INVERSE_RELATIVE_EPSILON {
                return None;
            }
            for entry in &mut augmented[column] {
                *entry /= pivot;
            }

            for row in 0..4 {
                if row == column {
                    continue;
                }
                let factor = augmented[row][column];
                if factor == 0.0 {
                    continue;
                }
                for entry in 0..8 {
                    augmented[row][entry] -= factor * augmented[column][entry];
                }
            }
        }

        let mut elements = [0.0_f32; 16];
        for row in 0..4 {
            for column in 0..4 {
                let value = augmented[row][4 + column];
                if !value.is_finite() || value.abs() > f64::from(f32::MAX) {
                    return None;
                }
                elements[column * 4 + row] = value as f32;
            }
        }
        Some(Self { elements })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Quat, Transform};
    use core::f32::consts::FRAC_PI_4;
    use three_d_core::Vec3;

    fn assert_matrix_close(actual: Mat4, expected: Mat4) {
        for (actual, expected) in actual.elements.into_iter().zip(expected.elements) {
            assert!((actual - expected).abs() < 1.0e-4, "{actual} != {expected}");
        }
    }

    fn assert_homogeneous_close(actual: [f32; 4], expected: [f32; 4]) {
        for (actual, expected) in actual.into_iter().zip(expected) {
            assert!((actual - expected).abs() < 1.0e-4, "{actual} != {expected}");
        }
    }

    #[test]
    fn inverse_round_trips_nontrivial_transform() {
        let matrix = Transform {
            translation: Vec3::new(4.0, -2.0, 7.0),
            rotation: Quat::from_axis_angle(Vec3::new(0.0, 1.0, 0.0), FRAC_PI_4).unwrap(),
            scale: Vec3::new(2.0, 0.5, 3.0),
        }
        .matrix();
        let inverse = matrix.inverse().expect("TRS matrix is invertible");

        assert_matrix_close(matrix * inverse, Mat4::IDENTITY);
        assert_matrix_close(inverse * matrix, Mat4::IDENTITY);
    }

    #[test]
    fn inverse_rejects_singular_and_non_finite_matrices() {
        assert!(Mat4::scale(Vec3::new(1.0, 0.0, 1.0)).inverse().is_none());
        let duplicate_rows = Mat4 {
            elements: [
                1.0, -2.0, -1.0, 1.0, // column 0
                -1.0, -2.0, 2.0, -1.0, // column 1
                -1.0, 0.0, -2.0, -1.0, // column 2
                0.0, -2.0, 0.0, 0.0, // column 3
            ],
        };
        assert!(duplicate_rows.inverse().is_none());

        let mut invalid = Mat4::IDENTITY;
        invalid.elements[0] = f32::NAN;
        assert!(invalid.inverse().is_none());
    }

    #[test]
    fn homogeneous_transform_preserves_projective_w_and_round_trips() {
        let matrix = Mat4 {
            elements: [
                1.0, 0.0, 0.0, 0.0, // column 0
                0.0, 1.0, 0.0, 0.0, // column 1
                0.0, 0.0, 1.0, 0.5, // column 2
                0.0, 0.0, 0.0, 1.0, // column 3
            ],
        };
        let point = [2.0, 3.0, 4.0, 1.0];
        let projected = matrix.transform_homogeneous(point);
        assert_homogeneous_close(projected, [2.0, 3.0, 4.0, 3.0]);

        let inverse = matrix.inverse().expect("projective fixture is invertible");
        assert_homogeneous_close(inverse.transform_homogeneous(projected), point);
    }
}
