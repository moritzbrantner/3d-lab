use std::env;
use std::fs;
use std::path::Path;

use serde_json::json;
use three_d_core::{Mesh, Vec2, Vec3, VertexAttributes};
use three_d_lod::{LodSpec, LodView, ScreenSpaceLodPolicy, SIMPLIFIER_ID, build_lod_chain};

const SEGMENTS: u32 = 28;
const TARGET_PIXEL_ERROR: f32 = 2.0;
const HYSTERESIS_FRACTION: f32 = 0.15;
const VIEWPORT_HEIGHT: f32 = 720.0;
const VERTICAL_FOV: f32 = core::f32::consts::FRAC_PI_3;

fn teaching_surface() -> Mesh {
    let row_size = SEGMENTS + 1;
    let mut vertices = Vec::with_capacity((row_size * row_size) as usize);
    let mut uvs = Vec::with_capacity(vertices.capacity());
    let mut indices = Vec::with_capacity((SEGMENTS * SEGMENTS * 6) as usize);

    for row in 0..=SEGMENTS {
        let v = row as f32 / SEGMENTS as f32;
        let z = -1.0 + v * 2.0;
        for column in 0..=SEGMENTS {
            let u = column as f32 / SEGMENTS as f32;
            let x = -1.0 + u * 2.0;
            let y = 0.28 * (x * 2.8).sin() * (z * 2.2).cos()
                + 0.08 * ((x + z) * 7.0).sin();
            vertices.push(Vec3::new(x, y, z));
            uvs.push(Vec2::new(u, v));
        }
    }

    for row in 0..SEGMENTS {
        for column in 0..SEGMENTS {
            let a = row * row_size + column;
            let b = a + 1;
            let c = a + row_size;
            let d = c + 1;
            indices.extend_from_slice(&[a, c, b, b, c, d]);
        }
    }

    let topology = Mesh::new(vertices.clone(), indices.clone()).expect("fixture topology is valid");
    let normals = topology.smooth_vertex_normals();
    Mesh::with_attributes(
        vertices,
        indices,
        VertexAttributes {
            normals: Some(normals),
            uvs: Some(uvs),
            ..VertexAttributes::default()
        },
    )
    .expect("fixture attributes are aligned")
}

fn mesh_extent(mesh: &Mesh) -> f32 {
    let bounds = mesh.bounds().expect("fixture is non-empty");
    (bounds.max.x - bounds.min.x)
        .max(bounds.max.y - bounds.min.y)
        .max(bounds.max.z - bounds.min.z)
}

fn main() {
    let output = env::args()
        .nth(1)
        .unwrap_or_else(|| "web/public/generated/lod-fixture.json".to_owned());
    let output_path = Path::new(&output);
    if let Some(parent) = output_path.parent() {
        fs::create_dir_all(parent).expect("could not create fixture output directory");
    }

    let source = teaching_surface();
    let specs = [
        LodSpec::new(0.65, 0.01),
        LodSpec::new(0.35, 0.025),
        LodSpec::new(0.15, 0.05),
    ];
    let levels = build_lod_chain(&source, &specs).expect("fixture LOD chain must simplify");
    let extent = mesh_extent(&source);
    let relative_errors = std::iter::once(0.0)
        .chain(
            levels
                .iter()
                .map(|level| level.simplification.relative_error),
        )
        .collect::<Vec<_>>();
    assert!(
        relative_errors.windows(2).all(|pair| pair[0] <= pair[1]),
        "fixture simplification errors must be nondecreasing"
    );

    let policy = ScreenSpaceLodPolicy::new(TARGET_PIXEL_ERROR, HYSTERESIS_FRACTION);
    let mut current_level = 0;
    let selector_samples = [4.0_f32, 6.0, 8.0, 10.0, 12.0, 10.0, 8.0, 6.0, 4.0]
        .into_iter()
        .map(|distance| {
            let selection = policy
                .select_level(
                    &relative_errors,
                    current_level,
                    LodView {
                        mesh_extent: extent,
                        distance,
                        viewport_height_pixels: VIEWPORT_HEIGHT,
                        vertical_fov_radians: VERTICAL_FOV,
                    },
                )
                .expect("fixture selection inputs are valid");
            let previous_level = current_level;
            current_level = selection.level;
            json!({
                "distance": distance,
                "previousLevel": previous_level,
                "selectedLevel": selection.level,
                "projectedErrorPixels": selection.projected_error_pixels,
            })
        })
        .collect::<Vec<_>>();

    let positions = source
        .vertices()
        .iter()
        .map(|vertex| [vertex.x, vertex.y, vertex.z])
        .collect::<Vec<_>>();
    let normals = source
        .attributes()
        .normals
        .as_ref()
        .expect("fixture has normals")
        .iter()
        .map(|normal| [normal.x, normal.y, normal.z])
        .collect::<Vec<_>>();

    let document = json!({
        "schemaVersion": 1,
        "simplifierId": SIMPLIFIER_ID,
        "meshExtent": extent,
        "positions": positions,
        "normals": normals,
        "source": {
            "level": 0,
            "triangleCount": source.triangle_count(),
            "relativeError": 0.0,
            "indices": source.indices(),
        },
        "levels": levels.iter().map(|level| json!({
            "level": level.level + 1,
            "triangleRatio": level.triangle_ratio,
            "requestedTriangleCount": level.simplification.requested_triangle_count,
            "triangleCount": level.simplification.result_triangle_count,
            "relativeError": level.simplification.relative_error,
            "indices": level.simplification.mesh.indices(),
        })).collect::<Vec<_>>(),
        "selector": {
            "targetPixelError": TARGET_PIXEL_ERROR,
            "hysteresisFraction": HYSTERESIS_FRACTION,
            "viewportHeightPixels": VIEWPORT_HEIGHT,
            "verticalFovRadians": VERTICAL_FOV,
            "samples": selector_samples,
        },
    });

    let encoded = serde_json::to_string_pretty(&document).expect("fixture JSON is serializable");
    fs::write(output_path, format!("{encoded}\n")).expect("could not write fixture JSON");
}
