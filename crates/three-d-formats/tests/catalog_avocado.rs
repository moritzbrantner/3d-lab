use std::{env, fs};

use three_d_formats::load_gltf;

const EXPECTED_BYTE_LENGTH: usize = 8_110_040;

#[test]
#[ignore = "requires the pinned asset-tooling Git LFS catalog checkout"]
fn canonical_asset_tooling_avocado_decodes() {
    let path = env::var("AVOCADO_GLTF_PATH")
        .expect("AVOCADO_GLTF_PATH must point to the verified canonical Avocado GLB");
    let bytes = fs::read(path).expect("verified canonical Avocado GLB is readable");
    assert_eq!(
        bytes.len(),
        EXPECTED_BYTE_LENGTH,
        "canonical Avocado byte length drifted after catalog verification"
    );

    let asset = load_gltf(&bytes).expect("canonical asset-tooling Avocado GLB loads");
    assert_eq!(asset.meshes().len(), 1);
    assert_eq!(asset.meshes()[0].primitives().len(), 1);
    let mesh = asset.meshes()[0].primitives()[0].mesh();
    assert_eq!(mesh.vertices().len(), 406);
    assert_eq!(mesh.indices().len(), 2046);
    assert!(mesh.attributes().normals.is_some());
    assert!(mesh.attributes().tangents.is_some());
    assert!(mesh.attributes().uvs.is_some());

    assert_eq!(asset.images().len(), 3);
    assert_eq!(asset.textures().len(), 3);
    assert_eq!(asset.materials().len(), 1);
    let material = &asset.materials()[0];
    assert_eq!(material.name(), Some("2256_Avocado_d"));
    assert_eq!(
        material
            .base_color_texture()
            .expect("base-color texture is preserved")
            .texture(),
        0
    );
    assert_eq!(
        material
            .metallic_roughness_texture()
            .expect("metallic-roughness texture is preserved")
            .texture(),
        1
    );
    assert_eq!(
        material
            .normal_texture()
            .expect("normal texture is preserved")
            .texture(),
        2
    );
}
