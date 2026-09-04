//! Renderer-independent geometry fundamentals used by `3d-lab`.
//!
//! This crate deliberately stays small: it models the data that a renderer consumes
//! without owning a renderer, GPU API, scene graph, or asset format.

use core::fmt;
use core::ops::{Add, Mul, Sub};

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Vec3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

impl Vec3 {
    pub const ZERO: Self = Self::new(0.0, 0.0, 0.0);

    pub const fn new(x: f32, y: f32, z: f32) -> Self {
        Self { x, y, z }
    }

    pub fn dot(self, rhs: Self) -> f32 {
        self.x * rhs.x + self.y * rhs.y + self.z * rhs.z
    }

    pub fn cross(self, rhs: Self) -> Self {
        Self::new(
            self.y * rhs.z - self.z * rhs.y,
            self.z * rhs.x - self.x * rhs.z,
            self.x * rhs.y - self.y * rhs.x,
        )
    }

    pub fn length(self) -> f32 {
        self.dot(self).sqrt()
    }

    pub fn normalized(self) -> Option<Self> {
        let length = self.length();
        (length > f32::EPSILON).then(|| self * (1.0 / length))
    }
}

impl Add for Vec3 {
    type Output = Self;

    fn add(self, rhs: Self) -> Self::Output {
        Self::new(self.x + rhs.x, self.y + rhs.y, self.z + rhs.z)
    }
}

impl Sub for Vec3 {
    type Output = Self;

    fn sub(self, rhs: Self) -> Self::Output {
        Self::new(self.x - rhs.x, self.y - rhs.y, self.z - rhs.z)
    }
}

impl Mul<f32> for Vec3 {
    type Output = Self;

    fn mul(self, rhs: f32) -> Self::Output {
        Self::new(self.x * rhs, self.y * rhs, self.z * rhs)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Triangle(pub [u32; 3]);

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bounds3 {
    pub min: Vec3,
    pub max: Vec3,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MeshError {
    NonFiniteVertex { vertex_index: usize },
    IndexCountNotDivisibleByThree { index_count: usize },
    IndexOutOfBounds { index: u32, vertex_count: usize },
}

impl fmt::Display for MeshError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NonFiniteVertex { vertex_index } => {
                write!(formatter, "vertex {vertex_index} contains a non-finite coordinate")
            }
            Self::IndexCountNotDivisibleByThree { index_count } => {
                write!(formatter, "index count {index_count} is not divisible by three")
            }
            Self::IndexOutOfBounds {
                index,
                vertex_count,
            } => write!(
                formatter,
                "index {index} references a mesh with only {vertex_count} vertices"
            ),
        }
    }
}

impl std::error::Error for MeshError {}

#[derive(Debug, Clone, PartialEq)]
pub struct Mesh {
    vertices: Vec<Vec3>,
    indices: Vec<u32>,
}

impl Mesh {
    pub fn new(vertices: Vec<Vec3>, indices: Vec<u32>) -> Result<Self, MeshError> {
        if let Some((vertex_index, _)) = vertices.iter().enumerate().find(|(_, vertex)| {
            !vertex.x.is_finite() || !vertex.y.is_finite() || !vertex.z.is_finite()
        }) {
            return Err(MeshError::NonFiniteVertex { vertex_index });
        }

        if !indices.len().is_multiple_of(3) {
            return Err(MeshError::IndexCountNotDivisibleByThree {
                index_count: indices.len(),
            });
        }

        if let Some(&index) = indices
            .iter()
            .find(|&&index| index as usize >= vertices.len())
        {
            return Err(MeshError::IndexOutOfBounds {
                index,
                vertex_count: vertices.len(),
            });
        }

        Ok(Self { vertices, indices })
    }

    pub fn vertices(&self) -> &[Vec3] {
        &self.vertices
    }

    pub fn indices(&self) -> &[u32] {
        &self.indices
    }

    pub fn triangle_count(&self) -> usize {
        self.indices.len() / 3
    }

    pub fn triangle(&self, triangle_index: usize) -> Option<Triangle> {
        let start = triangle_index.checked_mul(3)?;
        let indices = self.indices.get(start..start + 3)?;
        Some(Triangle([indices[0], indices[1], indices[2]]))
    }

    pub fn triangle_normal(&self, triangle_index: usize) -> Option<Vec3> {
        let Triangle([a, b, c]) = self.triangle(triangle_index)?;
        let a = *self.vertices.get(a as usize)?;
        let b = *self.vertices.get(b as usize)?;
        let c = *self.vertices.get(c as usize)?;
        (b - a).cross(c - a).normalized()
    }

    pub fn bounds(&self) -> Option<Bounds3> {
        let first = *self.vertices.first()?;
        let mut min = first;
        let mut max = first;

        for vertex in &self.vertices[1..] {
            min.x = min.x.min(vertex.x);
            min.y = min.y.min(vertex.y);
            min.z = min.z.min(vertex.z);
            max.x = max.x.max(vertex.x);
            max.y = max.y.max(vertex.y);
            max.z = max.z.max(vertex.z);
        }

        Some(Bounds3 { min, max })
    }

    pub fn unit_cube() -> Self {
        let vertices = vec![
            Vec3::new(-0.5, -0.5, -0.5),
            Vec3::new(0.5, -0.5, -0.5),
            Vec3::new(0.5, 0.5, -0.5),
            Vec3::new(-0.5, 0.5, -0.5),
            Vec3::new(-0.5, -0.5, 0.5),
            Vec3::new(0.5, -0.5, 0.5),
            Vec3::new(0.5, 0.5, 0.5),
            Vec3::new(-0.5, 0.5, 0.5),
        ];
        let indices = vec![
            0, 2, 1, 0, 3, 2,
            4, 5, 6, 4, 6, 7,
            0, 1, 5, 0, 5, 4,
            3, 7, 6, 3, 6, 2,
            1, 2, 6, 1, 6, 5,
            0, 4, 7, 0, 7, 3,
        ];

        Self::new(vertices, indices).expect("hard-coded cube indices are valid")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_finite_vertices() {
        let result = Mesh::new(vec![Vec3::new(f32::NAN, 0.0, 0.0)], vec![]);
        assert_eq!(result, Err(MeshError::NonFiniteVertex { vertex_index: 0 }));
    }

    #[test]
    fn rejects_partial_triangles() {
        let result = Mesh::new(vec![Vec3::ZERO], vec![0, 0]);
        assert_eq!(
            result,
            Err(MeshError::IndexCountNotDivisibleByThree { index_count: 2 })
        );
    }

    #[test]
    fn rejects_indices_outside_vertex_buffer() {
        let result = Mesh::new(vec![Vec3::ZERO], vec![0, 0, 1]);
        assert_eq!(
            result,
            Err(MeshError::IndexOutOfBounds {
                index: 1,
                vertex_count: 1
            })
        );
    }

    #[test]
    fn computes_triangle_normal_from_winding_order() {
        let mesh = Mesh::new(
            vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(1.0, 0.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
            ],
            vec![0, 1, 2],
        )
        .unwrap();

        assert_eq!(mesh.triangle_normal(0), Some(Vec3::new(0.0, 0.0, 1.0)));
    }

    #[test]
    fn unit_cube_is_eight_vertices_and_twelve_triangles() {
        let cube = Mesh::unit_cube();
        assert_eq!(cube.vertices().len(), 8);
        assert_eq!(cube.triangle_count(), 12);
        assert_eq!(
            cube.bounds(),
            Some(Bounds3 {
                min: Vec3::new(-0.5, -0.5, -0.5),
                max: Vec3::new(0.5, 0.5, 0.5),
            })
        );
    }
}
