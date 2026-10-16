//! Bounded presentation queries over the same transformed triangles a renderer draws.
use core::fmt;
use three_d_animation::Mat4;
use three_d_core::Mesh;

use crate::{ProjectiveError, inverse_rows_f64, matrix_rows_f64, transform_rows_projective};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PickError {
    InvalidViewport,
    InvalidViewportPoint,
    InvalidRay,
    InvalidModelTransform,
    Projective(ProjectiveError),
}

impl fmt::Display for PickError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidViewport => formatter.write_str("viewport dimensions must be positive"),
            Self::InvalidViewportPoint => {
                formatter.write_str("viewport point must be finite and inside the viewport")
            }
            Self::InvalidRay => formatter.write_str("near and far points must define a finite ray"),
            Self::InvalidModelTransform => {
                formatter.write_str("model transform must be finite, affine and nonsingular")
            }
            Self::Projective(error) => error.fmt(formatter),
        }
    }
}

impl std::error::Error for PickError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Projective(error) => Some(error),
            _ => None,
        }
    }
}

impl From<ProjectiveError> for PickError {
    fn from(error: ProjectiveError) -> Self {
        Self::Projective(error)
    }
}

/// Cull according to transformed world winding, including reflected models.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CullMode {
    None,
    Back,
    Front,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PickHit {
    /// World distance measured from the ray's near-plane origin.
    pub distance: f64,
    pub position: [f64; 3],
    pub triangle_index: usize,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PickRay {
    origin: [f64; 3],
    direction: [f64; 3],
    max_distance: f64,
}

impl PickRay {
    /// Unproject a continuous physical viewport point, with a top-left origin,
    /// through a WebGPU-depth (0..1) view-projection matrix.
    pub fn from_viewport(
        view_projection: Mat4,
        viewport: [u32; 2],
        pixel: [f64; 2],
    ) -> Result<Self, PickError> {
        if viewport.contains(&0) {
            return Err(PickError::InvalidViewport);
        }
        if pixel.iter().enumerate().any(|(axis, &value)| {
            !value.is_finite() || value < 0.0 || value > f64::from(viewport[axis])
        }) {
            return Err(PickError::InvalidViewportPoint);
        }
        let x = 2.0 * pixel[0] / f64::from(viewport[0]) - 1.0;
        let y = 1.0 - 2.0 * pixel[1] / f64::from(viewport[1]);
        // Invert once and retain f64 results through the intersection query.
        let inverse = inverse_rows_f64(view_projection)?;
        let origin = transform_rows_projective(inverse, [x, y, 0.0])?;
        let far = transform_rows_projective(inverse, [x, y, 1.0])?;
        let delta = subtract(far, origin);
        let max_distance = delta[0].hypot(delta[1]).hypot(delta[2]);
        if !max_distance.is_finite() || max_distance == 0.0 {
            return Err(PickError::InvalidRay);
        }
        Ok(Self {
            origin,
            direction: delta.map(|component| component / max_distance),
            max_distance,
        })
    }

    #[must_use]
    pub fn origin(&self) -> [f64; 3] {
        self.origin
    }

    #[must_use]
    pub fn direction(&self) -> [f64; 3] {
        self.direction
    }

    #[must_use]
    pub fn max_distance(&self) -> f64 {
        self.max_distance
    }

    /// Query indexed surfaces in world space. Each vertex is transformed once;
    /// work is linear in the supplied vertex and triangle counts. Equal-depth
    /// triangle ties retain the first index. Object identity stays with callers.
    pub fn intersect_mesh(
        &self,
        mesh: &Mesh,
        model: Mat4,
        cull: CullMode,
    ) -> Result<Option<PickHit>, PickError> {
        if model.elements[3] != 0.0
            || model.elements[7] != 0.0
            || model.elements[11] != 0.0
            || model.elements[15] != 1.0
        {
            return Err(PickError::InvalidModelTransform);
        }
        // Validate through the existing inversion boundary, including singular
        // and nonfinite transforms. No inverse or local-space distance semantics
        // are duplicated here.
        inverse_rows_f64(model).map_err(|_| PickError::InvalidModelTransform)?;
        let rows = matrix_rows_f64(model);
        let vertices = mesh
            .vertices()
            .iter()
            .map(|point| {
                transform_rows_projective(
                    rows,
                    [f64::from(point.x), f64::from(point.y), f64::from(point.z)],
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        let mut nearest: Option<PickHit> = None;
        for (triangle_index, indices) in mesh.indices().as_chunks::<3>().0.iter().enumerate() {
            let [a, b, c] = indices.map(|index| vertices[index as usize]);
            if let Some(distance) = self.intersect_triangle(a, b, c, cull)
                && nearest.is_none_or(|hit| distance < hit.distance)
            {
                nearest = Some(PickHit {
                    distance,
                    position: std::array::from_fn(|axis| {
                        self.origin[axis] + self.direction[axis] * distance
                    }),
                    triangle_index,
                });
            }
        }
        Ok(nearest)
    }

    fn intersect_triangle(
        &self,
        a: [f64; 3],
        b: [f64; 3],
        c: [f64; 3],
        cull: CullMode,
    ) -> Option<f64> {
        let edge1 = subtract(b, a);
        let edge2 = subtract(c, a);
        let normal = cross(edge1, edge2);
        let area = normal[0].hypot(normal[1]).hypot(normal[2]);
        if area == 0.0 {
            return None;
        }
        let p = cross(self.direction, edge2);
        let determinant = dot(edge1, p);
        // Scale the parallel tolerance with triangle area rather than using a
        // world-size cutoff that discards small but otherwise valid geometry.
        let tolerance = area * f64::EPSILON * 32.0;
        let rejected = match cull {
            CullMode::None => determinant.abs() <= tolerance,
            CullMode::Back => determinant <= tolerance,
            CullMode::Front => determinant >= -tolerance,
        };
        if rejected {
            return None;
        }
        let offset = subtract(self.origin, a);
        let u = dot(offset, p) / determinant;
        let q = cross(offset, edge1);
        let v = dot(self.direction, q) / determinant;
        if u < 0.0 || v < 0.0 || u + v > 1.0 {
            return None;
        }
        let distance = dot(edge2, q) / determinant;
        if !distance.is_finite() || distance < 0.0 || distance > self.max_distance {
            return None;
        }
        Some(distance)
    }
}

fn subtract(left: [f64; 3], right: [f64; 3]) -> [f64; 3] {
    std::array::from_fn(|axis| left[axis] - right[axis])
}

fn dot(left: [f64; 3], right: [f64; 3]) -> f64 {
    left.into_iter().zip(right).map(|(a, b)| a * b).sum()
}

fn cross(left: [f64; 3], right: [f64; 3]) -> [f64; 3] {
    [
        left[1] * right[2] - left[2] * right[1],
        left[2] * right[0] - left[0] * right[2],
        left[0] * right[1] - left[1] * right[0],
    ]
}
