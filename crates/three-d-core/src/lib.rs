//! Renderer-independent geometry fundamentals used by `3d-lab`.
//!
//! This crate deliberately stays small: it models the data that a renderer consumes
//! without owning a renderer, GPU API, scene graph, or asset format.

use core::fmt;
use core::ops::{Add, Mul, Sub};

pub const MAX_SUBDIVISIONS: u32 = 256;
const TANGENT_EPSILON: f32 = 1.0e-8;

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Vec2 {
    pub x: f32,
    pub y: f32,
}

impl Vec2 {
    pub const fn new(x: f32, y: f32) -> Self {
        Self { x, y }
    }

    fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite()
    }
}

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

    fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.z.is_finite()
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

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Tangent4 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

impl Tangent4 {
    pub const fn new(x: f32, y: f32, z: f32, w: f32) -> Self {
        Self { x, y, z, w }
    }

    pub const fn direction(self) -> Vec3 {
        Vec3::new(self.x, self.y, self.z)
    }

    fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.z.is_finite() && self.w.is_finite()
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Color3 {
    pub r: f32,
    pub g: f32,
    pub b: f32,
}

impl Color3 {
    pub const fn new(r: f32, g: f32, b: f32) -> Self {
        Self { r, g, b }
    }

    fn is_finite(self) -> bool {
        self.r.is_finite() && self.g.is_finite() && self.b.is_finite()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Triangle(pub [u32; 3]);

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Bounds3 {
    pub min: Vec3,
    pub max: Vec3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VertexAttributeKind {
    Normal,
    Tangent,
    Uv,
    Color,
}

impl fmt::Display for VertexAttributeKind {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Normal => formatter.write_str("normal"),
            Self::Tangent => formatter.write_str("tangent"),
            Self::Uv => formatter.write_str("uv"),
            Self::Color => formatter.write_str("color"),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct VertexAttributes {
    pub normals: Option<Vec<Vec3>>,
    pub tangents: Option<Vec<Tangent4>>,
    pub uvs: Option<Vec<Vec2>>,
    pub colors: Option<Vec<Color3>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MeshError {
    NonFiniteVertex {
        vertex_index: usize,
    },
    IndexCountNotDivisibleByThree {
        index_count: usize,
    },
    IndexOutOfBounds {
        index: u32,
        vertex_count: usize,
    },
    AttributeCountMismatch {
        attribute: VertexAttributeKind,
        attribute_count: usize,
        vertex_count: usize,
    },
    NonFiniteAttribute {
        attribute: VertexAttributeKind,
        vertex_index: usize,
    },
    InvalidSubdivisionCount {
        segments: u32,
        max: u32,
    },
}

impl fmt::Display for MeshError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NonFiniteVertex { vertex_index } => {
                write!(
                    formatter,
                    "vertex {vertex_index} contains a non-finite coordinate"
                )
            }
            Self::IndexCountNotDivisibleByThree { index_count } => {
                write!(
                    formatter,
                    "index count {index_count} is not divisible by three"
                )
            }
            Self::IndexOutOfBounds {
                index,
                vertex_count,
            } => write!(
                formatter,
                "index {index} references a mesh with only {vertex_count} vertices"
            ),
            Self::AttributeCountMismatch {
                attribute,
                attribute_count,
                vertex_count,
            } => write!(
                formatter,
                "{attribute} attribute count {attribute_count} does not match vertex count {vertex_count}"
            ),
            Self::NonFiniteAttribute {
                attribute,
                vertex_index,
            } => write!(
                formatter,
                "{attribute} attribute {vertex_index} contains a non-finite value"
            ),
            Self::InvalidSubdivisionCount { segments, max } => write!(
                formatter,
                "subdivision count {segments} must be between 1 and {max}"
            ),
        }
    }
}

impl std::error::Error for MeshError {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TangentError {
    MissingNormals,
    MissingUvs,
    DegenerateUv { triangle_index: usize },
    InvalidNormal { vertex_index: usize },
    DegenerateTangent { vertex_index: usize },
}

impl fmt::Display for TangentError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingNormals => formatter.write_str("tangent derivation requires vertex normals"),
            Self::MissingUvs => formatter.write_str("tangent derivation requires UV coordinates"),
            Self::DegenerateUv { triangle_index } => write!(
                formatter,
                "triangle {triangle_index} has a degenerate UV parameterization"
            ),
            Self::InvalidNormal { vertex_index } => {
                write!(formatter, "vertex {vertex_index} has a zero-length normal")
            }
            Self::DegenerateTangent { vertex_index } => write!(
                formatter,
                "vertex {vertex_index} does not produce a stable tangent direction"
            ),
        }
    }
}

impl std::error::Error for TangentError {}

#[derive(Debug, Clone, PartialEq)]
pub struct Mesh {
    vertices: Vec<Vec3>,
    indices: Vec<u32>,
    attributes: VertexAttributes,
}

impl Mesh {
    pub fn new(vertices: Vec<Vec3>, indices: Vec<u32>) -> Result<Self, MeshError> {
        Self::with_attributes(vertices, indices, VertexAttributes::default())
    }

    pub fn with_attributes(
        vertices: Vec<Vec3>,
        indices: Vec<u32>,
        attributes: VertexAttributes,
    ) -> Result<Self, MeshError> {
        if let Some((vertex_index, _)) = vertices
            .iter()
            .enumerate()
            .find(|(_, vertex)| !vertex.is_finite())
        {
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

        Self::validate_attribute(
            VertexAttributeKind::Normal,
            attributes.normals.as_deref(),
            vertices.len(),
            |value| value.is_finite(),
        )?;
        Self::validate_attribute(
            VertexAttributeKind::Tangent,
            attributes.tangents.as_deref(),
            vertices.len(),
            |value| value.is_finite(),
        )?;
        Self::validate_attribute(
            VertexAttributeKind::Uv,
            attributes.uvs.as_deref(),
            vertices.len(),
            |value| value.is_finite(),
        )?;
        Self::validate_attribute(
            VertexAttributeKind::Color,
            attributes.colors.as_deref(),
            vertices.len(),
            |value| value.is_finite(),
        )?;

        Ok(Self {
            vertices,
            indices,
            attributes,
        })
    }

    fn validate_attribute<T>(
        attribute: VertexAttributeKind,
        values: Option<&[T]>,
        vertex_count: usize,
        is_finite: impl Fn(&T) -> bool,
    ) -> Result<(), MeshError> {
        let Some(values) = values else {
            return Ok(());
        };

        if values.len() != vertex_count {
            return Err(MeshError::AttributeCountMismatch {
                attribute,
                attribute_count: values.len(),
                vertex_count,
            });
        }

        if let Some((vertex_index, _)) = values
            .iter()
            .enumerate()
            .find(|(_, value)| !is_finite(value))
        {
            return Err(MeshError::NonFiniteAttribute {
                attribute,
                vertex_index,
            });
        }

        Ok(())
    }

    pub fn vertices(&self) -> &[Vec3] {
        &self.vertices
    }

    pub fn indices(&self) -> &[u32] {
        &self.indices
    }

    pub fn attributes(&self) -> &VertexAttributes {
        &self.attributes
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

    pub fn smooth_vertex_normals(&self) -> Vec<Vec3> {
        let mut sums = vec![Vec3::ZERO; self.vertices.len()];

        for &[a_index, b_index, c_index] in self.indices.as_chunks::<3>().0 {
            let a_index = a_index as usize;
            let b_index = b_index as usize;
            let c_index = c_index as usize;
            let a = self.vertices[a_index];
            let b = self.vertices[b_index];
            let c = self.vertices[c_index];
            let area_weighted_normal = (b - a).cross(c - a);

            sums[a_index] = sums[a_index] + area_weighted_normal;
            sums[b_index] = sums[b_index] + area_weighted_normal;
            sums[c_index] = sums[c_index] + area_weighted_normal;
        }

        sums.into_iter()
            .map(|normal| normal.normalized().unwrap_or(Vec3::ZERO))
            .collect()
    }

    pub fn derived_tangents(&self) -> Result<Vec<Tangent4>, TangentError> {
        let normals = self
            .attributes
            .normals
            .as_deref()
            .ok_or(TangentError::MissingNormals)?;
        let uvs = self
            .attributes
            .uvs
            .as_deref()
            .ok_or(TangentError::MissingUvs)?;
        let mut tangent_sums = vec![Vec3::ZERO; self.vertices.len()];
        let mut bitangent_sums = vec![Vec3::ZERO; self.vertices.len()];

        for (triangle_index, &[a_index, b_index, c_index]) in
            self.indices.as_chunks::<3>().0.iter().enumerate()
        {
            let a_index = a_index as usize;
            let b_index = b_index as usize;
            let c_index = c_index as usize;
            let a = self.vertices[a_index];
            let b = self.vertices[b_index];
            let c = self.vertices[c_index];
            let uv_a = uvs[a_index];
            let uv_b = uvs[b_index];
            let uv_c = uvs[c_index];
            let edge_ab = b - a;
            let edge_ac = c - a;
            let du_ab = uv_b.x - uv_a.x;
            let dv_ab = uv_b.y - uv_a.y;
            let du_ac = uv_c.x - uv_a.x;
            let dv_ac = uv_c.y - uv_a.y;
            let determinant = du_ab * dv_ac - dv_ab * du_ac;
            if determinant.abs() <= TANGENT_EPSILON {
                return Err(TangentError::DegenerateUv { triangle_index });
            }

            let reciprocal = 1.0 / determinant;
            let tangent = (edge_ab * dv_ac - edge_ac * dv_ab) * reciprocal;
            let bitangent = (edge_ac * du_ab - edge_ab * du_ac) * reciprocal;
            for vertex_index in [a_index, b_index, c_index] {
                tangent_sums[vertex_index] = tangent_sums[vertex_index] + tangent;
                bitangent_sums[vertex_index] = bitangent_sums[vertex_index] + bitangent;
            }
        }

        normals
            .iter()
            .copied()
            .enumerate()
            .map(|(vertex_index, normal)| {
                let normal = normal
                    .normalized()
                    .ok_or(TangentError::InvalidNormal { vertex_index })?;
                let tangent_sum = tangent_sums[vertex_index];
                let tangent = (tangent_sum - normal * normal.dot(tangent_sum))
                    .normalized()
                    .ok_or(TangentError::DegenerateTangent { vertex_index })?;
                let handedness = if normal
                    .cross(tangent)
                    .dot(bitangent_sums[vertex_index])
                    < 0.0
                {
                    -1.0
                } else {
                    1.0
                };
                Ok(Tangent4::new(
                    tangent.x,
                    tangent.y,
                    tangent.z,
                    handedness,
                ))
            })
            .collect()
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

    pub fn subdivided_plane(segments: u32) -> Result<Self, MeshError> {
        if !(1..=MAX_SUBDIVISIONS).contains(&segments) {
            return Err(MeshError::InvalidSubdivisionCount {
                segments,
                max: MAX_SUBDIVISIONS,
            });
        }

        let row_size = segments + 1;
        let vertex_count = (row_size * row_size) as usize;
        let mut vertices = Vec::with_capacity(vertex_count);
        let mut normals = Vec::with_capacity(vertex_count);
        let mut uvs = Vec::with_capacity(vertex_count);
        let mut indices = Vec::with_capacity((segments * segments * 6) as usize);

        for row in 0..=segments {
            let v = row as f32 / segments as f32;
            for column in 0..=segments {
                let u = column as f32 / segments as f32;
                vertices.push(Vec3::new(-1.0 + u * 2.0, 0.0, -1.0 + v * 2.0));
                normals.push(Vec3::new(0.0, 1.0, 0.0));
                uvs.push(Vec2::new(u, v));
            }
        }

        for row in 0..segments {
            for column in 0..segments {
                let a = row * row_size + column;
                let b = a + 1;
                let c = a + row_size;
                let d = c + 1;
                indices.extend_from_slice(&[a, c, b, b, c, d]);
            }
        }

        Self::with_attributes(
            vertices,
            indices,
            VertexAttributes {
                normals: Some(normals),
                tangents: None,
                uvs: Some(uvs),
                colors: None,
            },
        )
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
            0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 1, 2, 6, 1, 6,
            5, 0, 4, 7, 0, 7, 3,
        ];

        Self::new(vertices, indices).expect("hard-coded cube indices are valid")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn uv_quad() -> Mesh {
        Mesh::with_attributes(
            vec![
                Vec3::new(-1.0, -1.0, 0.0),
                Vec3::new(1.0, -1.0, 0.0),
                Vec3::new(1.0, 1.0, 0.0),
                Vec3::new(-1.0, 1.0, 0.0),
            ],
            vec![0, 1, 2, 0, 2, 3],
            VertexAttributes {
                normals: Some(vec![Vec3::new(0.0, 0.0, 1.0); 4]),
                uvs: Some(vec![
                    Vec2::new(0.0, 0.0),
                    Vec2::new(1.0, 0.0),
                    Vec2::new(1.0, 1.0),
                    Vec2::new(0.0, 1.0),
                ]),
                ..VertexAttributes::default()
            },
        )
        .expect("UV quad fixture is valid")
    }

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
    fn rejects_misaligned_vertex_attributes() {
        let result = Mesh::with_attributes(
            vec![Vec3::ZERO; 3],
            vec![0, 1, 2],
            VertexAttributes {
                uvs: Some(vec![Vec2::new(0.0, 0.0)]),
                ..VertexAttributes::default()
            },
        );
        assert_eq!(
            result,
            Err(MeshError::AttributeCountMismatch {
                attribute: VertexAttributeKind::Uv,
                attribute_count: 1,
                vertex_count: 3,
            })
        );
    }

    #[test]
    fn rejects_non_finite_vertex_attributes() {
        let result = Mesh::with_attributes(
            vec![Vec3::ZERO],
            vec![],
            VertexAttributes {
                colors: Some(vec![Color3::new(f32::INFINITY, 0.0, 0.0)]),
                ..VertexAttributes::default()
            },
        );
        assert_eq!(
            result,
            Err(MeshError::NonFiniteAttribute {
                attribute: VertexAttributeKind::Color,
                vertex_index: 0,
            })
        );
    }

    #[test]
    fn rejects_non_finite_tangent_attributes() {
        let result = Mesh::with_attributes(
            vec![Vec3::ZERO],
            vec![],
            VertexAttributes {
                tangents: Some(vec![Tangent4::new(1.0, 0.0, 0.0, f32::NAN)]),
                ..VertexAttributes::default()
            },
        );
        assert_eq!(
            result,
            Err(MeshError::NonFiniteAttribute {
                attribute: VertexAttributeKind::Tangent,
                vertex_index: 0,
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
    fn smooth_normals_accumulate_adjacent_faces() {
        let mesh = Mesh::new(
            vec![
                Vec3::new(-1.0, -1.0, 0.0),
                Vec3::new(1.0, -1.0, 0.0),
                Vec3::new(1.0, 1.0, 0.0),
                Vec3::new(-1.0, 1.0, 0.0),
            ],
            vec![0, 1, 2, 0, 2, 3],
        )
        .unwrap();

        assert_eq!(
            mesh.smooth_vertex_normals(),
            vec![Vec3::new(0.0, 0.0, 1.0); 4]
        );
    }

    #[test]
    fn derives_tangent_basis_from_normals_and_uvs() {
        let tangents = uv_quad().derived_tangents().unwrap();
        assert_eq!(tangents, vec![Tangent4::new(1.0, 0.0, 0.0, 1.0); 4]);
    }

    #[test]
    fn tangent_derivation_rejects_degenerate_uvs() {
        let mesh = Mesh::with_attributes(
            vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(1.0, 0.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
            ],
            vec![0, 1, 2],
            VertexAttributes {
                normals: Some(vec![Vec3::new(0.0, 0.0, 1.0); 3]),
                uvs: Some(vec![Vec2::new(0.0, 0.0); 3]),
                ..VertexAttributes::default()
            },
        )
        .unwrap();

        assert_eq!(
            mesh.derived_tangents(),
            Err(TangentError::DegenerateUv { triangle_index: 0 })
        );
    }

    #[test]
    fn subdivided_plane_has_predictable_topology_and_attributes() {
        let mesh = Mesh::subdivided_plane(2).unwrap();
        assert_eq!(mesh.vertices().len(), 9);
        assert_eq!(mesh.triangle_count(), 8);
        assert_eq!(mesh.attributes().normals.as_ref().unwrap().len(), 9);
        assert_eq!(mesh.attributes().uvs.as_ref().unwrap().len(), 9);
        assert_eq!(mesh.triangle_normal(0), Some(Vec3::new(0.0, 1.0, 0.0)));
    }

    #[test]
    fn subdivided_plane_rejects_zero_segments() {
        assert_eq!(
            Mesh::subdivided_plane(0),
            Err(MeshError::InvalidSubdivisionCount {
                segments: 0,
                max: MAX_SUBDIVISIONS,
            })
        );
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
