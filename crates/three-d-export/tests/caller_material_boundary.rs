//! Independent #116 caller-table trust boundary supplement, before production.
//! Existing public BaseColorFactor fields must not bypass its documented domain.
use three_d_assets::{Asset, BaseColorFactor, Material};

fn admit(color: BaseColorFactor) -> Result<Asset, String> {
    Material::pbr_metallic_roughness(Some("caller".into()), color, 0.25, 0.75, false)
        .map_err(|error| error.to_string())
        .and_then(|material| {
            Asset::new(Vec::new(), vec![material]).map_err(|error| error.to_string())
        })
}

#[test]
fn valid_public_field_base_colors_include_exact_channel_boundaries() {
    for color in [
        BaseColorFactor {
            r: 0.0,
            g: 1.0,
            b: 0.5,
            a: 1.0,
        },
        BaseColorFactor {
            r: 1.0,
            g: 0.0,
            b: 1.0,
            a: 0.0,
        },
    ] {
        let asset = admit(color).expect("valid caller factor must remain accepted");
        assert_eq!(asset.materials()[0].base_color_factor(), color);
    }
}

#[test]
fn public_field_invalid_rgba_cannot_enter_validated_caller_material_table() {
    let mut admitted = Vec::new();
    for component in 0..4 {
        for value in [-0.25, 1.25, f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let mut rgba = [1.0; 4];
            rgba[component] = value;
            let color = BaseColorFactor {
                r: rgba[0],
                g: rgba[1],
                b: rgba[2],
                a: rgba[3],
            };
            // Verify every supplied shape violates the existing factor authority,
            // without fabricating malformed JSON or an alternative validator.
            assert!(BaseColorFactor::new(color.r, color.g, color.b, color.a).is_err());
            match admit(color) {
                Ok(_) => admitted.push(format!("component={component}, value={value}")),
                Err(error) => {
                    let error = error.to_lowercase();
                    assert!(
                        error.contains("color")
                            || error.contains("factor")
                            || error.contains("rgba"),
                        "invalid base color must have a useful specific failure: {error}"
                    );
                }
            }
        }
    }
    assert!(
        admitted.is_empty(),
        "existing typed caller boundary admitted invalid public-field factors: {admitted:?}"
    );
}
