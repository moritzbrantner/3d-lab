use three_d_assets::{
    Asset, AssetError, BaseColorFactor, EncodedImage, MagnificationFilter, Material,
    MaterialTextureBinding, MinificationFilter, NormalTextureBinding, Texture, TextureSampler,
    TextureWrap,
};

fn material() -> Material {
    Material::pbr_metallic_roughness(None, BaseColorFactor::WHITE, 0.1, 0.55, false)
        .expect("fixture material is valid")
}

fn encoded_image() -> EncodedImage {
    EncodedImage::new(
        Some("Normal map".into()),
        "image/png".into(),
        vec![0x89, b'P', b'N', b'G'],
    )
    .expect("fixture image is valid")
}

#[test]
fn asset_preserves_pbr_texture_resource_graph() {
    let base_color = MaterialTextureBinding::new(0, 0);
    let metallic_roughness = MaterialTextureBinding::new(1, 0);
    let normal = NormalTextureBinding::new(2, 0, 0.75).expect("binding is valid");
    let sampler = TextureSampler::new(
        Some("Linear repeat".into()),
        Some(MagnificationFilter::Linear),
        Some(MinificationFilter::LinearMipmapLinear),
        TextureWrap::Repeat,
        TextureWrap::MirroredRepeat,
    );
    let material = material()
        .with_base_color_texture(base_color)
        .with_metallic_roughness_texture(metallic_roughness)
        .with_normal_texture(normal);
    let asset = Asset::with_resources(
        Vec::new(),
        vec![material],
        vec![encoded_image(), encoded_image(), encoded_image()],
        vec![sampler],
        vec![
            Texture::new(Some("Base color".into()), 0, Some(0)),
            Texture::new(Some("Metallic roughness".into()), 1, Some(0)),
            Texture::new(Some("Normal texture".into()), 2, Some(0)),
        ],
    )
    .expect("resource references are valid");

    let material = &asset.materials()[0];
    assert_eq!(
        material
            .base_color_texture()
            .expect("base color texture is preserved")
            .texture(),
        0
    );
    assert_eq!(
        material
            .metallic_roughness_texture()
            .expect("metallic roughness texture is preserved")
            .texture(),
        1
    );
    let normal = material
        .normal_texture()
        .expect("normal texture is preserved");
    assert_eq!(normal.texture(), 2);
    assert_eq!(normal.tex_coord(), 0);
    assert_eq!(normal.scale(), 0.75);
    assert_eq!(asset.textures()[0].image(), 0);
    assert_eq!(asset.textures()[0].sampler(), Some(0));
    assert_eq!(asset.images()[0].mime_type(), "image/png");
    assert_eq!(asset.samplers()[0].wrap_t(), TextureWrap::MirroredRepeat);
}

#[test]
fn asset_rejects_missing_texture_image_reference() {
    let texture = Texture::new(None, 1, None);

    assert_eq!(
        Asset::with_resources(
            Vec::new(),
            Vec::new(),
            vec![encoded_image()],
            Vec::new(),
            vec![texture],
        ),
        Err(AssetError::TextureImageIndexOutOfBounds {
            texture_index: 0,
            image_index: 1,
            image_count: 1,
        })
    );
}

#[test]
fn asset_rejects_missing_texture_sampler_reference() {
    let texture = Texture::new(None, 0, Some(1));

    assert_eq!(
        Asset::with_resources(
            Vec::new(),
            Vec::new(),
            vec![encoded_image()],
            vec![TextureSampler::new(
                None,
                None,
                None,
                TextureWrap::Repeat,
                TextureWrap::Repeat,
            )],
            vec![texture],
        ),
        Err(AssetError::TextureSamplerIndexOutOfBounds {
            texture_index: 0,
            sampler_index: 1,
            sampler_count: 1,
        })
    );
}

#[test]
fn asset_rejects_missing_material_texture_reference() {
    let binding = MaterialTextureBinding::new(1, 0);

    assert_eq!(
        Asset::with_resources(
            Vec::new(),
            vec![material().with_base_color_texture(binding)],
            vec![encoded_image()],
            Vec::new(),
            vec![Texture::new(None, 0, None)],
        ),
        Err(AssetError::MaterialTextureIndexOutOfBounds {
            material_index: 0,
            texture_index: 1,
            texture_count: 1,
        })
    );
}

#[test]
fn resource_values_reject_invalid_encoded_data_and_scale() {
    assert_eq!(
        EncodedImage::new(None, String::new(), vec![1]),
        Err(AssetError::InvalidImageMimeType)
    );
    assert_eq!(
        EncodedImage::new(None, "image/png".into(), Vec::new()),
        Err(AssetError::EmptyEncodedImage)
    );
    assert_eq!(
        NormalTextureBinding::new(0, 0, f32::NAN),
        Err(AssetError::InvalidNormalTextureScale)
    );
}
