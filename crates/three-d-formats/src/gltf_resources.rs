use base64::{Engine as _, engine::general_purpose::STANDARD};
use three_d_assets::{
    EncodedImage, MagnificationFilter, MinificationFilter, NormalTextureBinding, Texture,
    TextureSampler, TextureWrap,
};

use crate::FormatError;

pub(crate) fn load_images(
    gltf: &gltf::Gltf,
    buffers: &[Vec<u8>],
) -> Result<Vec<EncodedImage>, FormatError> {
    gltf.images()
        .map(|image| convert_image(image, buffers))
        .collect()
}

pub(crate) fn load_samplers(gltf: &gltf::Gltf) -> Vec<TextureSampler> {
    gltf.samplers().map(convert_sampler).collect()
}

pub(crate) fn load_textures(gltf: &gltf::Gltf) -> Vec<Texture> {
    gltf.textures().map(convert_texture).collect()
}

pub(crate) fn convert_normal_texture(
    normal_texture: gltf::material::NormalTexture<'_>,
) -> Result<NormalTextureBinding, FormatError> {
    NormalTextureBinding::new(
        normal_texture.texture().index(),
        normal_texture.tex_coord(),
        normal_texture.scale(),
    )
    .map_err(Into::into)
}

fn convert_image(image: gltf::Image<'_>, buffers: &[Vec<u8>]) -> Result<EncodedImage, FormatError> {
    let image_index = image.index();
    let name = image.name().map(str::to_owned);
    let (mime_type, bytes) = match image.source() {
        gltf::image::Source::View { view, mime_type } => {
            let buffer_index = view.buffer().index();
            let offset = view.offset();
            let length = view.length();
            let buffer =
                buffers
                    .get(buffer_index)
                    .ok_or(FormatError::GltfImageViewOutOfBounds {
                        image_index,
                        buffer_index,
                        offset,
                        length,
                        buffer_length: 0,
                    })?;
            let end = offset
                .checked_add(length)
                .ok_or(FormatError::GltfImageViewOutOfBounds {
                    image_index,
                    buffer_index,
                    offset,
                    length,
                    buffer_length: buffer.len(),
                })?;
            let bytes = buffer
                .get(offset..end)
                .ok_or(FormatError::GltfImageViewOutOfBounds {
                    image_index,
                    buffer_index,
                    offset,
                    length,
                    buffer_length: buffer.len(),
                })?;
            (mime_type.to_owned(), bytes.to_vec())
        }
        gltf::image::Source::Uri { uri, mime_type } => {
            let (embedded_mime_type, bytes) = decode_image_data_uri(uri)?;
            if let Some(declared_mime_type) = mime_type
                && declared_mime_type != embedded_mime_type.as_str()
            {
                return Err(FormatError::InvalidGltfImageDataUri);
            }
            (embedded_mime_type, bytes)
        }
    };

    EncodedImage::new(name, mime_type, bytes).map_err(Into::into)
}

fn decode_image_data_uri(uri: &str) -> Result<(String, Vec<u8>), FormatError> {
    let data = uri
        .strip_prefix("data:")
        .ok_or_else(|| FormatError::UnsupportedGltfImageUri(uri.to_owned()))?;
    let (metadata, encoded) = data
        .split_once(',')
        .ok_or(FormatError::InvalidGltfImageDataUri)?;
    let mime_type = metadata
        .strip_suffix(";base64")
        .filter(|mime_type| !mime_type.is_empty())
        .ok_or(FormatError::InvalidGltfImageDataUri)?;
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| FormatError::InvalidGltfImageDataUri)?;
    Ok((mime_type.to_owned(), bytes))
}

fn convert_sampler(sampler: gltf::texture::Sampler<'_>) -> TextureSampler {
    TextureSampler::new(
        sampler.name().map(str::to_owned),
        sampler.mag_filter().map(convert_mag_filter),
        sampler.min_filter().map(convert_min_filter),
        convert_wrap(sampler.wrap_s()),
        convert_wrap(sampler.wrap_t()),
    )
}

fn convert_mag_filter(filter: gltf::texture::MagFilter) -> MagnificationFilter {
    match filter {
        gltf::texture::MagFilter::Nearest => MagnificationFilter::Nearest,
        gltf::texture::MagFilter::Linear => MagnificationFilter::Linear,
    }
}

fn convert_min_filter(filter: gltf::texture::MinFilter) -> MinificationFilter {
    match filter {
        gltf::texture::MinFilter::Nearest => MinificationFilter::Nearest,
        gltf::texture::MinFilter::Linear => MinificationFilter::Linear,
        gltf::texture::MinFilter::NearestMipmapNearest => MinificationFilter::NearestMipmapNearest,
        gltf::texture::MinFilter::LinearMipmapNearest => MinificationFilter::LinearMipmapNearest,
        gltf::texture::MinFilter::NearestMipmapLinear => MinificationFilter::NearestMipmapLinear,
        gltf::texture::MinFilter::LinearMipmapLinear => MinificationFilter::LinearMipmapLinear,
    }
}

fn convert_wrap(wrap: gltf::texture::WrappingMode) -> TextureWrap {
    match wrap {
        gltf::texture::WrappingMode::ClampToEdge => TextureWrap::ClampToEdge,
        gltf::texture::WrappingMode::MirroredRepeat => TextureWrap::MirroredRepeat,
        gltf::texture::WrappingMode::Repeat => TextureWrap::Repeat,
    }
}

fn convert_texture(texture: gltf::Texture<'_>) -> Texture {
    Texture::new(
        texture.name().map(str::to_owned),
        texture.source().index(),
        texture.sampler().index(),
    )
}
