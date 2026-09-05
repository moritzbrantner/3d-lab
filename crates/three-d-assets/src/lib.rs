//! Renderer-independent asset and material semantics for `3d-lab`.
//!
//! File formats are deliberately downstream. This crate models the durable result of
//! loading an asset without owning glTF/OBJ parsing, byte buffers, renderer APIs, or images.

use core::fmt;
use three_d_core::Mesh;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct BaseColorFactor {
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
}

impl BaseColorFactor {
    pub const WHITE: Self = Self {
        r: 1.0,
        g: 1.0,
        b: 1.0,
        a: 1.0,
    };

    pub fn new(r: f32, g: f32, b: f32, a: f32) -> Result<Self, AssetError> {
        let values = [r, g, b, a];
        if !values
            .into_iter()
            .all(|value| value.is_finite() && (0.0..=1.0).contains(&value))
        {
            return Err(AssetError::InvalidBaseColorFactor);
        }

        Ok(Self { r, g, b, a })
    }
}

impl Default for BaseColorFactor {
    fn default() -> Self {
        Self::WHITE
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Material {
    name: Option<String>,
    base_color_factor: BaseColorFactor,
    metallic_factor: f32,
    roughness_factor: f32,
    double_sided: bool,
}

impl Material {
    pub fn pbr_metallic_roughness(
        name: Option<String>,
        base_color_factor: BaseColorFactor,
        metallic_factor: f32,
        roughness_factor: f32,
        double_sided: bool,
    ) -> Result<Self, AssetError> {
        if !metallic_factor.is_finite() || !(0.0..=1.0).contains(&metallic_factor) {
            return Err(AssetError::InvalidMetallicFactor);
        }
        if !roughness_factor.is_finite() || !(0.0..=1.0).contains(&roughness_factor) {
            return Err(AssetError::InvalidRoughnessFactor);
        }

        Ok(Self {
            name,
            base_color_factor,
            metallic_factor,
            roughness_factor,
            double_sided,
        })
    }

    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    pub const fn base_color_factor(&self) -> BaseColorFactor {
        self.base_color_factor
    }

    pub const fn metallic_factor(&self) -> f32 {
        self.metallic_factor
    }

    pub const fn roughness_factor(&self) -> f32 {
        self.roughness_factor
    }

    pub const fn double_sided(&self) -> bool {
        self.double_sided
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct MeshPrimitive {
    mesh: Mesh,
    material: Option<usize>,
}

impl MeshPrimitive {
    pub const fn new(mesh: Mesh, material: Option<usize>) -> Self {
        Self { mesh, material }
    }

    pub const fn mesh(&self) -> &Mesh {
        &self.mesh
    }

    pub const fn material(&self) -> Option<usize> {
        self.material
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct AssetMesh {
    name: Option<String>,
    primitives: Vec<MeshPrimitive>,
}

impl AssetMesh {
    pub fn new(
        name: Option<String>,
        primitives: Vec<MeshPrimitive>,
    ) -> Result<Self, AssetError> {
        if primitives.is_empty() {
            return Err(AssetError::EmptyAssetMesh);
        }
        Ok(Self { name, primitives })
    }

    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    pub fn primitives(&self) -> &[MeshPrimitive] {
        &self.primitives
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Asset {
    meshes: Vec<AssetMesh>,
    materials: Vec<Material>,
}

impl Asset {
    pub fn new(meshes: Vec<AssetMesh>, materials: Vec<Material>) -> Result<Self, AssetError> {
        for (mesh_index, mesh) in meshes.iter().enumerate() {
            for (primitive_index, primitive) in mesh.primitives().iter().enumerate() {
                if let Some(material_index) = primitive.material()
                    && material_index >= materials.len()
                {
                    return Err(AssetError::MaterialIndexOutOfBounds {
                        mesh_index,
                        primitive_index,
                        material_index,
                        material_count: materials.len(),
                    });
                }
            }
        }

        Ok(Self { meshes, materials })
    }

    pub fn meshes(&self) -> &[AssetMesh] {
        &self.meshes
    }

    pub fn materials(&self) -> &[Material] {
        &self.materials
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AssetError {
    InvalidBaseColorFactor,
    InvalidMetallicFactor,
    InvalidRoughnessFactor,
    EmptyAssetMesh,
    MaterialIndexOutOfBounds {
        mesh_index: usize,
        primitive_index: usize,
        material_index: usize,
        material_count: usize,
    },
}

impl fmt::Display for AssetError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidBaseColorFactor => {
                formatter.write_str("base color factor components must be finite values from 0 to 1")
            }
            Self::InvalidMetallicFactor => {
                formatter.write_str("metallic factor must be a finite value from 0 to 1")
            }
            Self::InvalidRoughnessFactor => {
                formatter.write_str("roughness factor must be a finite value from 0 to 1")
            }
            Self::EmptyAssetMesh => formatter.write_str("an asset mesh must contain at least one primitive"),
            Self::MaterialIndexOutOfBounds {
                mesh_index,
                primitive_index,
                material_index,
                material_count,
            } => write!(
                formatter,
                "mesh {mesh_index} primitive {primitive_index} references material {material_index}, but the asset has {material_count} materials"
            ),
        }
    }
}

impl std::error::Error for AssetError {}

#[cfg(test)]
mod tests {
    use super::*;
    use three_d_core::Vec3;

    fn triangle() -> Mesh {
        Mesh::new(
            vec![
                Vec3::new(-1.0, -1.0, 0.0),
                Vec3::new(1.0, -1.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
            ],
            vec![0, 1, 2],
        )
        .expect("fixture triangle is valid")
    }

    fn material() -> Material {
        Material::pbr_metallic_roughness(
            Some("Blue PBR".into()),
            BaseColorFactor::new(0.18, 0.55, 0.95, 1.0).expect("fixture color is valid"),
            0.1,
            0.55,
            false,
        )
        .expect("fixture material is valid")
    }

    #[test]
    fn asset_resolves_primitive_material_reference() {
        let mesh = AssetMesh::new(
            Some("Triangle".into()),
            vec![MeshPrimitive::new(triangle(), Some(0))],
        )
        .expect("fixture asset mesh is valid");
        let asset = Asset::new(vec![mesh], vec![material()]).expect("asset references are valid");

        assert_eq!(asset.meshes()[0].primitives()[0].material(), Some(0));
        assert_eq!(asset.materials()[0].name(), Some("Blue PBR"));
    }

    #[test]
    fn asset_rejects_missing_material_reference() {
        let mesh = AssetMesh::new(None, vec![MeshPrimitive::new(triangle(), Some(1))])
            .expect("fixture asset mesh is valid");

        assert_eq!(
            Asset::new(vec![mesh], vec![material()]),
            Err(AssetError::MaterialIndexOutOfBounds {
                mesh_index: 0,
                primitive_index: 0,
                material_index: 1,
                material_count: 1,
            })
        );
    }

    #[test]
    fn asset_mesh_rejects_empty_primitive_list() {
        assert_eq!(AssetMesh::new(None, vec![]), Err(AssetError::EmptyAssetMesh));
    }

    #[test]
    fn pbr_material_rejects_out_of_range_factors() {
        assert_eq!(
            Material::pbr_metallic_roughness(None, BaseColorFactor::WHITE, 1.2, 0.5, false),
            Err(AssetError::InvalidMetallicFactor)
        );
    }
}
