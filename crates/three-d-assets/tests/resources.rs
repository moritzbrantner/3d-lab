use three_d_assets::{
    Asset, AssetError, BaseColorFactor, EncodedImage, MagnificationFilter, Material,
    MinificationFilter, NormalTextureBinding, Texture, TextureSampler, TextureWrap,
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
fn asset_preserves_normal_texture_resource_graph() {
    let binding = NormalTextureBinding::new(0, 0, 0.75).expect("binding is valid");
    let sampler = TextureSampler::new(
        Some("Linear repeat".into()),
        Some(MagnificationFilter::Linear),
        Some(MinificationFilter::LinearMipmapLinear),
        TextureWrap::Repeat,
        TextureWrap::MirroredRepeat,
    );
    let texture = Texture::new(Some("Normal texture".into()), 0, Some(0));
    let asset = Asset::with_resources(
        Vec::new(),
        vec![material().with_normal_texture(binding)],
        vec![encoded_image()],
        vec![sampler],
        vec![texture],
    )
    .expect("resource references are valid");

    let binding = asset.materials()[0]
        .normal_texture()
        .expect("normal texture is preserved");
    assert_eq!(binding.texture(), 0);
    assert_eq!(binding.tex_coord(), 0);
    assert_eq!(binding.scale(), 0.75);
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
    let binding = NormalTextureBinding::new(1, 0, 1.0).expect("binding is valid");

    assert_eq!(
        Asset::with_resources(
            Vec::new(),
            vec![material().with_normal_texture(binding)],
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
