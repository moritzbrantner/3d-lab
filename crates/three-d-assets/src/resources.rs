use crate::{AssetError, Material};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedImage {
    name: Option<String>,
    mime_type: String,
    bytes: Vec<u8>,
}

impl EncodedImage {
    pub fn new(
        name: Option<String>,
        mime_type: String,
        bytes: Vec<u8>,
    ) -> Result<Self, AssetError> {
        if mime_type.trim().is_empty() {
            return Err(AssetError::InvalidImageMimeType);
        }
        if bytes.is_empty() {
            return Err(AssetError::EmptyEncodedImage);
        }

        Ok(Self {
            name,
            mime_type,
            bytes,
        })
    }

    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    pub fn mime_type(&self) -> &str {
        &self.mime_type
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MagnificationFilter {
    Nearest,
    Linear,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MinificationFilter {
    Nearest,
    Linear,
    NearestMipmapNearest,
    LinearMipmapNearest,
    NearestMipmapLinear,
    LinearMipmapLinear,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextureWrap {
    ClampToEdge,
    MirroredRepeat,
    Repeat,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextureSampler {
    name: Option<String>,
    mag_filter: Option<MagnificationFilter>,
    min_filter: Option<MinificationFilter>,
    wrap_s: TextureWrap,
    wrap_t: TextureWrap,
}

impl TextureSampler {
    pub fn new(
        name: Option<String>,
        mag_filter: Option<MagnificationFilter>,
        min_filter: Option<MinificationFilter>,
        wrap_s: TextureWrap,
        wrap_t: TextureWrap,
    ) -> Self {
        Self {
            name,
            mag_filter,
            min_filter,
            wrap_s,
            wrap_t,
        }
    }

    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    pub const fn mag_filter(&self) -> Option<MagnificationFilter> {
        self.mag_filter
    }

    pub const fn min_filter(&self) -> Option<MinificationFilter> {
        self.min_filter
    }

    pub const fn wrap_s(&self) -> TextureWrap {
        self.wrap_s
    }

    pub const fn wrap_t(&self) -> TextureWrap {
        self.wrap_t
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Texture {
    name: Option<String>,
    image: usize,
    sampler: Option<usize>,
}

impl Texture {
    pub fn new(name: Option<String>, image: usize, sampler: Option<usize>) -> Self {
        Self {
            name,
            image,
            sampler,
        }
    }

    pub fn name(&self) -> Option<&str> {
        self.name.as_deref()
    }

    pub const fn image(&self) -> usize {
        self.image
    }

    pub const fn sampler(&self) -> Option<usize> {
        self.sampler
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TextureTransform {
    offset: [f32; 2],
    scale: [f32; 2],
    rotation_radians: f32,
}

impl TextureTransform {
    pub const IDENTITY: Self = Self {
        offset: [0.0, 0.0],
        scale: [1.0, 1.0],
        rotation_radians: 0.0,
    };

    pub fn new(
        offset: [f32; 2],
        scale: [f32; 2],
        rotation_radians: f32,
    ) -> Result<Self, AssetError> {
        if !offset
            .into_iter()
            .chain(scale)
            .chain([rotation_radians])
            .all(f32::is_finite)
        {
            return Err(AssetError::InvalidTextureTransform);
        }

        Ok(Self {
            offset,
            scale,
            rotation_radians,
        })
    }

    pub const fn offset(&self) -> [f32; 2] {
        self.offset
    }

    pub const fn scale(&self) -> [f32; 2] {
        self.scale
    }

    pub const fn rotation_radians(&self) -> f32 {
        self.rotation_radians
    }
}

impl Default for TextureTransform {
    fn default() -> Self {
        Self::IDENTITY
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MaterialTextureBinding {
    texture: usize,
    tex_coord: u32,
    transform: TextureTransform,
}

impl MaterialTextureBinding {
    pub const fn new(texture: usize, tex_coord: u32) -> Self {
        Self {
            texture,
            tex_coord,
            transform: TextureTransform::IDENTITY,
        }
    }

    pub const fn with_transform(mut self, transform: TextureTransform) -> Self {
        self.transform = transform;
        self
    }

    pub const fn texture(&self) -> usize {
        self.texture
    }

    pub const fn tex_coord(&self) -> u32 {
        self.tex_coord
    }

    pub const fn transform(&self) -> TextureTransform {
        self.transform
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NormalTextureBinding {
    texture: usize,
    tex_coord: u32,
    scale: f32,
    transform: TextureTransform,
}

impl NormalTextureBinding {
    pub fn new(texture: usize, tex_coord: u32, scale: f32) -> Result<Self, AssetError> {
        if !scale.is_finite() {
            return Err(AssetError::InvalidNormalTextureScale);
        }
        Ok(Self {
            texture,
            tex_coord,
            scale,
            transform: TextureTransform::IDENTITY,
        })
    }

    pub const fn with_transform(mut self, transform: TextureTransform) -> Self {
        self.transform = transform;
        self
    }

    pub const fn texture(&self) -> usize {
        self.texture
    }

    pub const fn tex_coord(&self) -> u32 {
        self.tex_coord
    }

    pub const fn scale(&self) -> f32 {
        self.scale
    }

    pub const fn transform(&self) -> TextureTransform {
        self.transform
    }
}

pub(crate) fn validate_resource_references(
    materials: &[Material],
    images: &[EncodedImage],
    samplers: &[TextureSampler],
    textures: &[Texture],
) -> Result<(), AssetError> {
    for (texture_index, texture) in textures.iter().enumerate() {
        if texture.image() >= images.len() {
            return Err(AssetError::TextureImageIndexOutOfBounds {
                texture_index,
                image_index: texture.image(),
                image_count: images.len(),
            });
        }
        if let Some(sampler_index) = texture.sampler()
            && sampler_index >= samplers.len()
        {
            return Err(AssetError::TextureSamplerIndexOutOfBounds {
                texture_index,
                sampler_index,
                sampler_count: samplers.len(),
            });
        }
    }

    for (material_index, material) in materials.iter().enumerate() {
        for binding in [
            material.base_color_texture(),
            material.metallic_roughness_texture(),
        ]
        .into_iter()
        .flatten()
        {
            if binding.texture() >= textures.len() {
                return Err(AssetError::MaterialTextureIndexOutOfBounds {
                    material_index,
                    texture_index: binding.texture(),
                    texture_count: textures.len(),
                });
            }
        }
        if let Some(normal_texture) = material.normal_texture()
            && normal_texture.texture() >= textures.len()
        {
            return Err(AssetError::MaterialTextureIndexOutOfBounds {
                material_index,
                texture_index: normal_texture.texture(),
                texture_count: textures.len(),
            });
        }
    }

    Ok(())
}
