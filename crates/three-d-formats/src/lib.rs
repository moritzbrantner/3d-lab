//! Loss-aware asset-format adapters for `3d-lab`.
//!
//! This crate owns file-format decoding, not asset semantics. Successful loads terminate in
//! `three-d-assets::Asset`; unsupported source semantics fail explicitly instead of being
//! silently discarded.

mod gltf_resources;

use std::fmt;
use std::io::Cursor;

use base64::{Engine as _, engine::general_purpose::STANDARD};
use gltf::mesh::{Mode, Semantic};
use three_d_assets::{Asset, AssetError, AssetMesh, BaseColorFactor, Material, MeshPrimitive};
use three_d_core::{Color3, Mesh, MeshError, Tangent4, Vec2, Vec3, VertexAttributes};

#[derive(Debug)]
pub enum FormatError {
    InvalidGltf(String),
    InvalidObj(String),
    UnsupportedGltfBufferUri(String),
    UnsupportedGltfImageUri(String),
    MissingGltfBinaryBuffer,
    InvalidGltfDataUri,
    InvalidGltfImageDataUri,
    GltfBufferTooShort {
        buffer_index: usize,
        expected: usize,
        actual: usize,
    },
    GltfImageViewOutOfBounds {
        image_index: usize,
        buffer_index: usize,
        offset: usize,
        length: usize,
        buffer_length: usize,
    },
    NoMeshes,
    MissingPositions {
        mesh_index: usize,
        primitive_index: usize,
    },
    UnsupportedPrimitiveMode {
        mesh_index: usize,
        primitive_index: usize,
        mode: String,
    },
    UnsupportedVertexAttribute {
        mesh_index: usize,
        primitive_index: usize,
        semantic: String,
    },
    UnsupportedMorphTargets {
        mesh_index: usize,
        primitive_index: usize,
    },
    UnsupportedMaterialFeature {
        material_index: usize,
    },
    TooManyVertices {
        mesh_index: usize,
        primitive_index: usize,
        vertex_count: usize,
    },
    UnsupportedObjMaterial {
        model_index: usize,
    },
    InvalidObjAttributeLayout {
        model_index: usize,
        attribute: &'static str,
    },
    Mesh(MeshError),
    Asset(AssetError),
}

impl fmt::Display for FormatError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidGltf(error) => write!(formatter, "invalid glTF: {error}"),
            Self::InvalidObj(error) => write!(formatter, "invalid OBJ: {error}"),
            Self::UnsupportedGltfBufferUri(uri) => {
                write!(formatter, "unsupported glTF buffer URI: {uri}")
            }
            Self::UnsupportedGltfImageUri(uri) => {
                write!(formatter, "unsupported glTF image URI: {uri}")
            }
            Self::MissingGltfBinaryBuffer => {
                formatter.write_str("glTF references a binary buffer but has no GLB BIN chunk")
            }
            Self::InvalidGltfDataUri => formatter.write_str("invalid base64 glTF data URI"),
            Self::InvalidGltfImageDataUri => {
                formatter.write_str("invalid base64 glTF image data URI")
            }
            Self::GltfBufferTooShort {
                buffer_index,
                expected,
                actual,
            } => write!(
                formatter,
                "glTF buffer {buffer_index} declares {expected} bytes but only {actual} were loaded"
            ),
            Self::GltfImageViewOutOfBounds {
                image_index,
                buffer_index,
                offset,
                length,
                buffer_length,
            } => write!(
                formatter,
                "glTF image {image_index} references buffer {buffer_index} bytes {offset}..{}, but the loaded buffer has {buffer_length} bytes",
                offset.saturating_add(*length)
            ),
            Self::NoMeshes => formatter.write_str("asset contains no mesh geometry"),
            Self::MissingPositions {
                mesh_index,
                primitive_index,
            } => write!(
                formatter,
                "glTF mesh {mesh_index} primitive {primitive_index} has no POSITION attribute"
            ),
            Self::UnsupportedPrimitiveMode {
                mesh_index,
                primitive_index,
                mode,
            } => write!(
                formatter,
                "glTF mesh {mesh_index} primitive {primitive_index} uses unsupported mode {mode}"
            ),
            Self::UnsupportedVertexAttribute {
                mesh_index,
                primitive_index,
                semantic,
            } => write!(
                formatter,
                "glTF mesh {mesh_index} primitive {primitive_index} uses unsupported attribute {semantic}"
            ),
            Self::UnsupportedMorphTargets {
                mesh_index,
                primitive_index,
            } => write!(
                formatter,
                "glTF mesh {mesh_index} primitive {primitive_index} uses morph targets, which are not yet represented by three-d-assets"
            ),
            Self::UnsupportedMaterialFeature { material_index } => write!(
                formatter,
                "glTF material {material_index} uses base-color/metallic-roughness textures, occlusion, emissive, or alpha semantics that three-d-assets does not yet preserve"
            ),
            Self::TooManyVertices {
                mesh_index,
                primitive_index,
                vertex_count,
            } => write!(
                formatter,
                "glTF mesh {mesh_index} primitive {primitive_index} has {vertex_count} vertices, exceeding u32 indexing"
            ),
            Self::UnsupportedObjMaterial { model_index } => write!(
                formatter,
                "OBJ model {model_index} references MTL material data; this loader requires geometry-only OBJ input until material conversion is defined"
            ),
            Self::InvalidObjAttributeLayout {
                model_index,
                attribute,
            } => write!(
                formatter,
                "OBJ model {model_index} has a malformed packed {attribute} attribute buffer"
            ),
            Self::Mesh(error) => write!(formatter, "decoded mesh is invalid: {error}"),
            Self::Asset(error) => write!(formatter, "decoded asset is invalid: {error}"),
        }
    }
}

impl std::error::Error for FormatError {}

impl From<MeshError> for FormatError {
    fn from(error: MeshError) -> Self {
        Self::Mesh(error)
    }
}

impl From<AssetError> for FormatError {
    fn from(error: AssetError) -> Self {
        Self::Asset(error)
    }
}

pub fn load_gltf(bytes: &[u8]) -> Result<Asset, FormatError> {
    let gltf = gltf::Gltf::from_slice(bytes)
        .map_err(|error| FormatError::InvalidGltf(error.to_string()))?;
    let buffers = load_gltf_buffers(&gltf)?;
    let images = gltf_resources::load_images(&gltf, &buffers)?;
    let samplers = gltf_resources::load_samplers(&gltf);
    let textures = gltf_resources::load_textures(&gltf);
    let materials = gltf
        .materials()
        .map(convert_gltf_material)
        .collect::<Result<Vec<_>, _>>()?;
    let meshes = gltf
        .meshes()
        .map(|mesh| convert_gltf_mesh(mesh, &buffers))
        .collect::<Result<Vec<_>, _>>()?;

    if meshes.is_empty() {
        return Err(FormatError::NoMeshes);
    }

    Asset::with_resources(meshes, materials, images, samplers, textures).map_err(Into::into)
}

pub fn load_obj(bytes: &[u8]) -> Result<Asset, FormatError> {
    let mut reader = Cursor::new(bytes);
    let options = tobj::LoadOptions {
        triangulate: true,
        single_index: true,
        ignore_points: true,
        ignore_lines: true,
    };
    let (models, materials) = tobj::load_obj_buf(&mut reader, &options, |_| {
        Ok((Vec::new(), Default::default()))
    })
    .map_err(|error| FormatError::InvalidObj(error.to_string()))?;
    materials.map_err(|error| FormatError::InvalidObj(error.to_string()))?;

    if models.is_empty() {
        return Err(FormatError::NoMeshes);
    }

    let meshes = models
        .into_iter()
        .enumerate()
        .map(|(model_index, model)| convert_obj_model(model_index, model))
        .collect::<Result<Vec<_>, _>>()?;
    Asset::new(meshes, Vec::new()).map_err(Into::into)
}

fn load_gltf_buffers(gltf: &gltf::Gltf) -> Result<Vec<Vec<u8>>, FormatError> {
    gltf.buffers()
        .map(|buffer| {
            let data = match buffer.source() {
                gltf::buffer::Source::Bin => gltf
                    .blob
                    .clone()
                    .ok_or(FormatError::MissingGltfBinaryBuffer)?,
                gltf::buffer::Source::Uri(uri) => decode_gltf_data_uri(uri)?,
            };

            if data.len() < buffer.length() {
                return Err(FormatError::GltfBufferTooShort {
                    buffer_index: buffer.index(),
                    expected: buffer.length(),
                    actual: data.len(),
                });
            }
            Ok(data)
        })
        .collect()
}

fn decode_gltf_data_uri(uri: &str) -> Result<Vec<u8>, FormatError> {
    let encoded = uri
        .strip_prefix("data:application/octet-stream;base64,")
        .or_else(|| uri.strip_prefix("data:application/gltf-buffer;base64,"))
        .ok_or_else(|| FormatError::UnsupportedGltfBufferUri(uri.to_owned()))?;
    STANDARD
        .decode(encoded)
        .map_err(|_| FormatError::InvalidGltfDataUri)
}

fn convert_gltf_material(material: gltf::Material<'_>) -> Result<Material, FormatError> {
    let material_index = material.index().unwrap_or(usize::MAX);
    let pbr = material.pbr_metallic_roughness();
    let has_unsupported_feature = pbr.base_color_texture().is_some()
        || pbr.metallic_roughness_texture().is_some()
        || material.occlusion_texture().is_some()
        || material.emissive_texture().is_some()
        || material.emissive_factor() != [0.0, 0.0, 0.0]
        || material.alpha_mode() != gltf::material::AlphaMode::Opaque;
    if has_unsupported_feature {
        return Err(FormatError::UnsupportedMaterialFeature { material_index });
    }

    let [r, g, b, a] = pbr.base_color_factor();
    let mut converted = Material::pbr_metallic_roughness(
        material.name().map(str::to_owned),
        BaseColorFactor::new(r, g, b, a)?,
        pbr.metallic_factor(),
        pbr.roughness_factor(),
        material.double_sided(),
    )?;
    if let Some(normal_texture) = material.normal_texture() {
        converted =
            converted.with_normal_texture(gltf_resources::convert_normal_texture(normal_texture)?);
    }
    Ok(converted)
}

fn convert_gltf_mesh(mesh: gltf::Mesh<'_>, buffers: &[Vec<u8>]) -> Result<AssetMesh, FormatError> {
    let mesh_index = mesh.index();
    let name = mesh.name().map(str::to_owned);
    let primitives = mesh
        .primitives()
        .map(|primitive| convert_gltf_primitive(mesh_index, primitive, buffers))
        .collect::<Result<Vec<_>, _>>()?;
    AssetMesh::new(name, primitives).map_err(Into::into)
}

fn convert_gltf_primitive(
    mesh_index: usize,
    primitive: gltf::Primitive<'_>,
    buffers: &[Vec<u8>],
) -> Result<MeshPrimitive, FormatError> {
    let primitive_index = primitive.index();
    if primitive.mode() != Mode::Triangles {
        return Err(FormatError::UnsupportedPrimitiveMode {
            mesh_index,
            primitive_index,
            mode: format!("{:?}", primitive.mode()),
        });
    }
    if primitive.morph_targets().next().is_some() {
        return Err(FormatError::UnsupportedMorphTargets {
            mesh_index,
            primitive_index,
        });
    }
    for (semantic, _) in primitive.attributes() {
        match semantic {
            Semantic::Positions
            | Semantic::Normals
            | Semantic::Tangents
            | Semantic::Colors(0)
            | Semantic::TexCoords(0) => {}
            other => {
                return Err(FormatError::UnsupportedVertexAttribute {
                    mesh_index,
                    primitive_index,
                    semantic: format!("{other:?}"),
                });
            }
        }
    }

    let reader = primitive.reader(|buffer| buffers.get(buffer.index()).map(Vec::as_slice));
    let vertices = reader
        .read_positions()
        .ok_or(FormatError::MissingPositions {
            mesh_index,
            primitive_index,
        })?
        .map(|[x, y, z]| Vec3::new(x, y, z))
        .collect::<Vec<_>>();
    let indices = if let Some(indices) = reader.read_indices() {
        indices.into_u32().collect()
    } else {
        let vertex_count =
            u32::try_from(vertices.len()).map_err(|_| FormatError::TooManyVertices {
                mesh_index,
                primitive_index,
                vertex_count: vertices.len(),
            })?;
        (0..vertex_count).collect()
    };
    let normals = reader
        .read_normals()
        .map(|values| values.map(|[x, y, z]| Vec3::new(x, y, z)).collect());
    let tangents = reader.read_tangents().map(|values| {
        values
            .map(|[x, y, z, w]| Tangent4::new(x, y, z, w))
            .collect()
    });
    let uvs = reader
        .read_tex_coords(0)
        .map(|values| values.into_f32().map(|[u, v]| Vec2::new(u, v)).collect());
    let colors = reader.read_colors(0).map(|values| {
        values
            .into_rgb_f32()
            .map(|[r, g, b]| Color3::new(r, g, b))
            .collect()
    });
    let mesh = Mesh::with_attributes(
        vertices,
        indices,
        VertexAttributes {
            normals,
            tangents,
            uvs,
            colors,
        },
    )?;

    Ok(MeshPrimitive::new(mesh, primitive.material().index()))
}

fn convert_obj_model(model_index: usize, model: tobj::Model) -> Result<AssetMesh, FormatError> {
    let source = model.mesh;
    if source.material_id.is_some() {
        return Err(FormatError::UnsupportedObjMaterial { model_index });
    }
    if !source.positions.len().is_multiple_of(3) {
        return Err(FormatError::InvalidObjAttributeLayout {
            model_index,
            attribute: "position",
        });
    }
    if !source.normals.is_empty() && !source.normals.len().is_multiple_of(3) {
        return Err(FormatError::InvalidObjAttributeLayout {
            model_index,
            attribute: "normal",
        });
    }
    if !source.texcoords.is_empty() && !source.texcoords.len().is_multiple_of(2) {
        return Err(FormatError::InvalidObjAttributeLayout {
            model_index,
            attribute: "UV",
        });
    }
    if !source.vertex_color.is_empty() && !source.vertex_color.len().is_multiple_of(3) {
        return Err(FormatError::InvalidObjAttributeLayout {
            model_index,
            attribute: "color",
        });
    }

    let vertices = source
        .positions
        .as_chunks::<3>()
        .0
        .iter()
        .map(|&[x, y, z]| Vec3::new(x, y, z))
        .collect();
    let normals = (!source.normals.is_empty()).then(|| {
        source
            .normals
            .as_chunks::<3>()
            .0
            .iter()
            .map(|&[x, y, z]| Vec3::new(x, y, z))
            .collect()
    });
    let uvs = (!source.texcoords.is_empty()).then(|| {
        source
            .texcoords
            .as_chunks::<2>()
            .0
            .iter()
            .map(|&[u, v]| Vec2::new(u, v))
            .collect()
    });
    let colors = (!source.vertex_color.is_empty()).then(|| {
        source
            .vertex_color
            .as_chunks::<3>()
            .0
            .iter()
            .map(|&[r, g, b]| Color3::new(r, g, b))
            .collect()
    });
    let mesh = Mesh::with_attributes(
        vertices,
        source.indices,
        VertexAttributes {
            normals,
            tangents: None,
            uvs,
            colors,
        },
    )?;
    let name = (!model.name.is_empty()).then_some(model.name);
    AssetMesh::new(name, vec![MeshPrimitive::new(mesh, None)]).map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;

    const OBJ_TRIANGLE: &[u8] = br#"
o Triangle
v -0.9 -0.65 0.0
v 0.9 -0.65 0.0
v 0.0 0.9 0.0
vn 0.0 0.0 1.0
f 1//1 2//1 3//1
"#;

    const GLTF_TRIANGLE: &[u8] = br#"{
  "asset": { "version": "2.0" },
  "meshes": [{
    "name": "Triangle",
    "primitives": [{
      "attributes": { "POSITION": 0, "NORMAL": 1, "TANGENT": 3 },
      "indices": 2,
      "material": 0,
      "mode": 4
    }]
  }],
  "materials": [{
    "name": "Blue PBR",
    "pbrMetallicRoughness": {
      "baseColorFactor": [0.18, 0.55, 0.95, 1.0],
      "metallicFactor": 0.1,
      "roughnessFactor": 0.55
    }
  }],
  "buffers": [{
    "byteLength": 128,
    "uri": "data:application/octet-stream;base64,ZmZmv2ZmJr8AAAAAZmZmP2ZmJr8AAAAAAAAAAGZmZj8AAAAAAAAAAAAAAAAAAIA/AAAAAAAAAAAAAIA/AAAAAAAAAAAAAIA/AAABAAIAAAAAAIA/AAAAAAAAAAAAAIA/AACAPwAAAAAAAAAAAACAPwAAgD8AAAAAAAAAAAAAgD8="
  }],
  "bufferViews": [
    { "buffer": 0, "byteOffset": 0, "byteLength": 36, "target": 34962 },
    { "buffer": 0, "byteOffset": 36, "byteLength": 36, "target": 34962 },
    { "buffer": 0, "byteOffset": 72, "byteLength": 6, "target": 34963 },
    { "buffer": 0, "byteOffset": 80, "byteLength": 48, "target": 34962 }
  ],
  "accessors": [
    { "bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [-0.9, -0.65, 0.0], "max": [0.9, 0.9, 0.0] },
    { "bufferView": 1, "componentType": 5126, "count": 3, "type": "VEC3" },
    { "bufferView": 2, "componentType": 5123, "count": 3, "type": "SCALAR" },
    { "bufferView": 3, "componentType": 5126, "count": 3, "type": "VEC4" }
  ]
}"#;

    #[test]
    fn obj_and_gltf_normalize_to_the_same_triangle_geometry() {
        let obj = load_obj(OBJ_TRIANGLE).expect("OBJ fixture loads");
        let gltf = load_gltf(GLTF_TRIANGLE).expect("glTF fixture loads");
        let obj_mesh = obj.meshes()[0].primitives()[0].mesh();
        let gltf_mesh = gltf.meshes()[0].primitives()[0].mesh();

        assert_eq!(obj_mesh.vertices(), gltf_mesh.vertices());
        assert_eq!(obj_mesh.indices(), gltf_mesh.indices());
        assert_eq!(
            obj_mesh.attributes().normals,
            gltf_mesh.attributes().normals
        );
        assert_eq!(
            gltf_mesh.attributes().tangents,
            Some(vec![Tangent4::new(1.0, 0.0, 0.0, 1.0); 3])
        );
        assert_eq!(gltf.materials()[0].name(), Some("Blue PBR"));
    }

    #[test]
    fn gltf_rejects_external_buffer_uri_in_byte_loader() {
        let source = br#"{
          "asset": { "version": "2.0" },
          "buffers": [{ "byteLength": 12, "uri": "triangle.bin" }],
          "meshes": []
        }"#;

        assert!(matches!(
            load_gltf(source),
            Err(FormatError::UnsupportedGltfBufferUri(uri)) if uri == "triangle.bin"
        ));
    }

    #[test]
    fn obj_rejects_malformed_face_data() {
        let source = b"v 0 0 0\nf 1 2 3\n";
        assert!(matches!(load_obj(source), Err(FormatError::InvalidObj(_))));
    }
}
