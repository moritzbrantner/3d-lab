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
    assert!(
        !asset.meshes().is_empty(),
        "canonical Avocado should contain at least one mesh"
    );

    let primitive_count: usize = asset.meshes().iter().map(|mesh| mesh.primitives().len()).sum();
    assert!(
        primitive_count > 0,
        "canonical Avocado should contain at least one mesh primitive"
    );

    let vertex_count: usize = asset
        .meshes()
        .iter()
        .flat_map(|mesh| mesh.primitives())
        .map(|primitive| primitive.mesh().vertices().len())
        .sum();
    assert!(
        vertex_count > 0,
        "canonical Avocado should decode non-empty geometry"
    );
}
