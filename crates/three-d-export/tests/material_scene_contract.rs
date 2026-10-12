//! Independent #116 public seam proposal; equivalent ownership-preserving API
//! translation is allowed separately, never material/geometry expectation weakening.
use three_d_animation::{Quat, Transform};
use three_d_assets::{
    BaseColorFactor, EncodedImage, Material, MaterialTextureBinding, NormalTextureBinding, Texture,
    TextureSampler,
};
use three_d_core::Vec3;
use three_d_export::{export_scene_glb, export_scene_glb_with_observations};
use three_d_formats::load_gltf;
use three_d_scene::{SceneNode, SceneResources, SceneSnapshot};

fn nodes() -> Vec<SceneNode> {
    vec![
        SceneNode::new(
            "parent",
            None,
            None,
            Transform {
                translation: Vec3::new(3., 2., 1.),
                rotation: Quat::new(
                    0.,
                    0.,
                    std::f32::consts::FRAC_1_SQRT_2,
                    std::f32::consts::FRAC_1_SQRT_2,
                ),
                scale: Vec3::new(1., 1., 1.),
            },
        ),
        SceneNode::new(
            "instance-a",
            Some(0),
            Some(0),
            Transform {
                translation: Vec3::new(1., 0., 0.),
                ..Transform::IDENTITY
            },
        ),
        SceneNode::new(
            "instance-b",
            Some(0),
            Some(0),
            Transform {
                translation: Vec3::new(0., 2., 0.),
                ..Transform::IDENTITY
            },
        ),
    ]
}

fn caller_resources() -> SceneResources {
    let oracle = load_gltf(include_bytes!("fixtures/textured.glb")).unwrap();
    SceneResources::new(
        oracle.materials().to_vec(),
        oracle.images().to_vec(),
        oracle.samplers().to_vec(),
        oracle.textures().to_vec(),
    )
    .unwrap()
}

fn assert_resources(bytes: &[u8]) {
    let glb = gltf::Gltf::from_slice(bytes).unwrap();
    let binary = glb.blob.as_ref().unwrap();
    assert_eq!(glb.buffers().count(), 1);
    assert!(
        matches!(
            glb.buffers().next().unwrap().source(),
            gltf::buffer::Source::Bin
        ),
        "portable output must not resolve any original source buffer URI"
    );
    assert_eq!(
        glb.meshes().count(),
        1,
        "two instances share one authored mesh group"
    );
    let primitives = glb
        .meshes()
        .next()
        .unwrap()
        .primitives()
        .collect::<Vec<_>>();
    assert_eq!(primitives.len(), 2);
    for (i, primitive) in primitives.iter().enumerate() {
        assert_eq!(primitive.material().index(), Some(i));
        let reader = primitive.reader(|_| Some(binary));
        assert_eq!(
            reader.read_positions().unwrap().collect::<Vec<_>>(),
            vec![[0., 0., 0.], [1., 0., 0.], [0., 1., 0.]]
        );
        assert_eq!(
            reader.read_normals().unwrap().collect::<Vec<_>>(),
            vec![[0., 0., 1.]; 3]
        );
        assert_eq!(
            reader
                .read_tex_coords(0)
                .unwrap()
                .into_f32()
                .collect::<Vec<_>>(),
            vec![[0., 0.], [1., 0.], [0., 1.]]
        );
        assert_eq!(
            reader
                .read_indices()
                .unwrap()
                .into_u32()
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
    }
    let materials = glb.materials().collect::<Vec<_>>();
    assert_eq!(materials.len(), 2);
    for (i, m) in materials.iter().enumerate() {
        let pbr = m.pbr_metallic_roughness();
        assert!(m.double_sided());
        assert_eq!(
            m.name(),
            Some(if i == 0 { "checker-a" } else { "checker-b" })
        );
        assert_eq!(
            pbr.base_color_factor(),
            if i == 0 {
                [1., 0.5, 0.25, 1.]
            } else {
                [0.25, 1., 0.5, 1.]
            }
        );
        assert_eq!(
            (pbr.metallic_factor(), pbr.roughness_factor()),
            if i == 0 { (0.25, 0.75) } else { (0.5, 0.25) }
        );
        let texture = pbr.base_color_texture().unwrap();
        assert_eq!(texture.tex_coord(), 0);
        assert_eq!(texture.texture().index(), 0);
    }
    assert_eq!(glb.images().count(), 1);
    assert_eq!(glb.textures().count(), 1);
    assert_eq!(glb.samplers().count(), 1);
    let image = glb.images().next().unwrap();
    match image.source() {
        gltf::image::Source::View { view, mime_type } => {
            assert_eq!(mime_type, "image/png");
            assert_eq!(
                &binary[view.offset()..view.offset() + view.length()],
                include_bytes!("fixtures/checker.png")
            );
        }
        _ => panic!("portable image must be embedded, not external workspace URI"),
    }
    let sampler = glb.samplers().next().unwrap();
    assert_eq!(
        sampler.mag_filter(),
        Some(gltf::texture::MagFilter::Nearest)
    );
    assert_eq!(
        sampler.min_filter(),
        Some(gltf::texture::MinFilter::Nearest)
    );
    assert_eq!(sampler.wrap_s(), gltf::texture::WrappingMode::ClampToEdge);
    assert_eq!(
        sampler.wrap_t(),
        gltf::texture::WrappingMode::MirroredRepeat
    );
    let nodes = glb.nodes().collect::<Vec<_>>();
    assert_eq!(nodes.len(), 3);
    assert_eq!(nodes[0].name(), Some("parent"));
    assert_eq!(
        nodes[0].children().map(|n| n.index()).collect::<Vec<_>>(),
        vec![1, 2]
    );
    assert_eq!(
        nodes[1].mesh().unwrap().index(),
        nodes[2].mesh().unwrap().index()
    );
    assert_eq!(nodes[1].name(), Some("instance-a"));
    assert_eq!(nodes[2].name(), Some("instance-b"));
    assert_eq!(nodes[0].transform().decomposed().0, [3., 2., 1.]);
    assert_eq!(nodes[1].transform().decomposed().0, [1., 0., 0.]);
    assert_eq!(nodes[2].transform().decomposed().0, [0., 2., 0.]);
    // Actual downstream Blender validates the composed world matrices independently.
}

fn check_scene(scene: SceneSnapshot, name: &str) {
    let first = export_scene_glb(&scene).unwrap();
    assert_resources(&first);
    let retained = scene.normalized().unwrap();
    let before = retained.clone();
    let (second, facts) = export_scene_glb_with_observations(&retained).unwrap();
    assert_eq!(
        facts.normalization_pass_count, 0,
        "only already normalized retained scenes have zero normalization"
    );
    assert_eq!(first, second);
    assert_eq!(
        retained, before,
        "export cannot mutate authored resources or geometry"
    );
    assert_eq!(second, export_scene_glb(&retained).unwrap());
    if let Ok(directory) = std::env::var("THREE_D_EXPORT_ACCEPTANCE_OUTPUT") {
        std::fs::create_dir_all(&directory).unwrap();
        std::fs::write(
            std::path::Path::new(&directory).join(format!("{name}.glb")),
            second,
        )
        .unwrap();
    }
}

#[test]
fn authored_multi_primitive_materials_and_two_instances_survive_existing_exporter() {
    let asset = load_gltf(include_bytes!("fixtures/textured.glb")).unwrap();
    check_scene(
        SceneSnapshot::from_asset(asset, nodes()).unwrap(),
        "authored",
    );
}

#[test]
fn geometry_only_import_accepts_caller_canonical_typed_shared_resources() {
    let asset = load_gltf(include_bytes!("fixtures/geometry-only.glb")).unwrap();
    let scene = SceneSnapshot::from_asset(asset, nodes())
        .unwrap()
        .with_material_resources(caller_resources(), vec![vec![Some(0), Some(1)]])
        .unwrap();
    check_scene(scene, "caller-bound");
}

#[test]
fn caller_primitive_dangling_material_rejects_without_silent_fallback() {
    let scene = SceneSnapshot::from_asset(
        load_gltf(include_bytes!("fixtures/geometry-only.glb")).unwrap(),
        nodes(),
    )
    .unwrap();
    let error = scene
        .with_material_resources(caller_resources(), vec![vec![Some(99), Some(1)]])
        .unwrap_err()
        .to_string();
    assert!(error.to_lowercase().contains("material"));
}

#[test]
fn caller_resource_references_and_unsupported_uv_set_fail_usefully() {
    let oracle = load_gltf(include_bytes!("fixtures/textured.glb")).unwrap();
    let invalid = Texture::new(Some("bad-image".into()), 99, Some(0));
    let error = SceneResources::new(
        oracle.materials().to_vec(),
        oracle.images().to_vec(),
        oracle.samplers().to_vec(),
        vec![invalid],
    )
    .unwrap_err()
    .to_string();
    assert!(error.to_lowercase().contains("image"));
    let mut materials = oracle.materials().to_vec();
    materials[0] = materials[0]
        .clone()
        .with_base_color_texture(MaterialTextureBinding::new(0, 1));
    let result = SceneResources::new(
        materials,
        oracle.images().to_vec(),
        oracle.samplers().to_vec(),
        oracle.textures().to_vec(),
    )
    .map_err(|e| e.to_string())
    .and_then(|resources| {
        SceneSnapshot::from_asset(
            load_gltf(include_bytes!("fixtures/geometry-only.glb")).unwrap(),
            nodes(),
        )
        .map_err(|e| e.to_string())
        .and_then(|scene| {
            scene
                .with_material_resources(resources, vec![vec![Some(0), Some(1)]])
                .map_err(|e| e.to_string())
        })
    })
    .and_then(|scene| export_scene_glb(&scene).map_err(|e| e.to_string()));
    let error = result.unwrap_err().to_lowercase();
    assert!(
        error.contains("uv") || error.contains("texcoord") || error.contains("tex_coord"),
        "specific unsupported UV-set error: {error}"
    );
}

#[test]
fn supported_normal_and_metallic_roughness_channels_are_not_dropped() {
    let oracle = load_gltf(include_bytes!("fixtures/textured.glb")).unwrap();
    let materials: Vec<Material> = oracle
        .materials()
        .iter()
        .cloned()
        .map(|m| {
            m.with_normal_texture(NormalTextureBinding::new(0, 0, 0.75).unwrap())
                .with_metallic_roughness_texture(MaterialTextureBinding::new(0, 0))
        })
        .collect();
    let images: Vec<EncodedImage> = oracle.images().to_vec();
    let samplers: Vec<TextureSampler> = oracle.samplers().to_vec();
    let resources =
        SceneResources::new(materials, images, samplers, oracle.textures().to_vec()).unwrap();
    let scene = SceneSnapshot::from_asset(
        load_gltf(include_bytes!("fixtures/geometry-only.glb")).unwrap(),
        nodes(),
    )
    .unwrap()
    .with_material_resources(resources, vec![vec![Some(0), Some(1)]])
    .unwrap();
    let bytes = export_scene_glb(&scene).unwrap();
    let glb = gltf::Gltf::from_slice(&bytes).unwrap();
    for m in glb.materials() {
        assert_eq!(m.normal_texture().unwrap().scale(), 0.75);
        assert_eq!(m.normal_texture().unwrap().texture().index(), 0);
        assert_eq!(
            m.pbr_metallic_roughness()
                .metallic_roughness_texture()
                .unwrap()
                .texture()
                .index(),
            0
        );
    }
}

#[test]
fn asset_backed_static_scene_rejects_validated_skin_instead_of_dropping_it() {
    let asset = load_gltf(include_bytes!(
        "../../../fixtures/catalog/khronos-simpleskin-embedded.gltf"
    ))
    .unwrap();
    assert!(
        asset.meshes()[0].primitives()[0]
            .skin_influences()
            .is_some()
    );
    let error = SceneSnapshot::from_asset(asset, nodes())
        .unwrap_err()
        .to_string()
        .to_lowercase();
    assert!(
        error.contains("skin"),
        "must expose static/skin boundary specifically: {error}"
    );
}

#[test]
fn caller_sampler_texture_and_binding_shape_references_fail_closed() {
    let oracle = load_gltf(include_bytes!("fixtures/textured.glb")).unwrap();
    for texture in [
        Texture::new(None, 0, Some(99)),
        Texture::new(None, 99, None),
    ] {
        assert!(
            SceneResources::new(
                oracle.materials().to_vec(),
                oracle.images().to_vec(),
                oracle.samplers().to_vec(),
                vec![texture]
            )
            .is_err()
        );
    }
    let scene = SceneSnapshot::from_asset(
        load_gltf(include_bytes!("fixtures/geometry-only.glb")).unwrap(),
        nodes(),
    )
    .unwrap();
    assert!(
        scene
            .with_material_resources(caller_resources(), vec![vec![Some(0)]])
            .is_err(),
        "one binding cannot silently apply to two primitives"
    );
}

#[test]
fn non_gltf_image_mime_fails_instead_of_claiming_portable_embedding() {
    let oracle = load_gltf(include_bytes!("fixtures/textured.glb")).unwrap();
    let image = EncodedImage::new(
        Some("unsupported".into()),
        "application/octet-stream".into(),
        include_bytes!("fixtures/checker.png").to_vec(),
    )
    .unwrap();
    let result = SceneResources::new(
        oracle.materials().to_vec(),
        vec![image],
        oracle.samplers().to_vec(),
        oracle.textures().to_vec(),
    )
    .map_err(|e| e.to_string())
    .and_then(|resources| {
        SceneSnapshot::from_asset(
            load_gltf(include_bytes!("fixtures/geometry-only.glb")).unwrap(),
            nodes(),
        )
        .map_err(|e| e.to_string())
        .and_then(|scene| {
            scene
                .with_material_resources(resources, vec![vec![Some(0), Some(1)]])
                .map_err(|e| e.to_string())
        })
    })
    .and_then(|scene| export_scene_glb(&scene).map_err(|e| e.to_string()));
    let error = result.unwrap_err().to_lowercase();
    assert!(
        error.contains("mime") || error.contains("image"),
        "specific unsupported image contract: {error}"
    );
}

#[test]
fn invalid_public_field_factor_rejects_before_caller_resources_become_trusted() {
    for component in 0..4 {
        for value in [-0.25, 1.25, f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut rgba = [1.0; 4];
            rgba[component] = value;
            let result = Material::pbr_metallic_roughness(
                Some("caller-invalid".into()),
                BaseColorFactor {
                    r: rgba[0],
                    g: rgba[1],
                    b: rgba[2],
                    a: rgba[3],
                },
                0.25,
                0.75,
                false,
            )
            .map_err(|error| error.to_string())
            .and_then(|material| {
                SceneResources::new(vec![material], Vec::new(), Vec::new(), Vec::new())
                    .map_err(|error| error.to_string())
            });
            let error = result.unwrap_err().to_lowercase();
            assert!(
                error.contains("color") || error.contains("factor") || error.contains("rgba"),
                "useful caller base-color rejection before trusted table: {error}"
            );
        }
    }
}
