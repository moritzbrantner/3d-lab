//! Generates the committed screen-space LOD evidence consumed by the web lab.
//!
//! `cargo run -p three-d-lod --example screen_space_lod_evidence` rewrites
//! `fixtures/lod/screen-space-lod.json`; `-- --check` fails on drift.
//!
//! The browser only looks decisions up in this document. Simplification and
//! selection both run here, through `three-d-lod`.

use std::path::PathBuf;

use serde_json::{Value, json};
use three_d_core::{Mesh, Vec3, VertexAttributes};
use three_d_lod::{
    LodSpec, LodView, SIMPLIFIER_ID, ScreenSpaceLodPolicy, SelectionReason, build_lod_chain,
    mesh_extent, projected_error_pixels,
};

pub const SCHEMA: &str = "3d-lab.screen-space-lod-evidence.v1";
const RINGS: u32 = 24;
const SEGMENTS: u32 = 48;
const LOD_SPECS: [LodSpec; 3] = [
    LodSpec::new(0.4, 1.0),
    LodSpec::new(0.15, 1.0),
    LodSpec::new(0.05, 1.0),
];
const VIEWPORT_HEIGHT_PIXELS: f32 = 720.0;
const VERTICAL_FOV_DEGREES: f32 = 45.0;
/// Distances are sampled at `DISTANCE_MIN_TENTHS / 10 + i * 0.1`.
const DISTANCE_MIN_TENTHS: u32 = 20;
const DISTANCE_MAX_TENTHS: u32 = 400;
const PIXEL_BUDGETS: [f32; 5] = [0.5, 1.0, 2.0, 4.0, 8.0];
const HYSTERESIS_PERCENTS: [u32; 3] = [0, 10, 25];

/// A closed, displaced lat-long sphere: smooth regions simplify cheaply while
/// the bumps keep a visible silhouette cost.
pub fn teaching_mesh() -> Mesh {
    let mut vertices = vec![Vec3::new(0.0, 1.0, 0.0)];
    for ring in 1..RINGS {
        let polar = core::f32::consts::PI * ring as f32 / RINGS as f32;
        for segment in 0..SEGMENTS {
            let azimuth = core::f32::consts::TAU * segment as f32 / SEGMENTS as f32;
            let radius = 1.0 + 0.09 * (5.0 * azimuth).sin() * (4.0 * polar).sin();
            vertices.push(Vec3::new(
                radius * polar.sin() * azimuth.cos(),
                radius * polar.cos(),
                radius * polar.sin() * azimuth.sin(),
            ));
        }
    }
    let south = vertices.len() as u32;
    vertices.push(Vec3::new(0.0, -1.0, 0.0));

    let ring_start = |ring: u32| 1 + (ring - 1) * SEGMENTS;
    let mut indices = Vec::new();
    for segment in 0..SEGMENTS {
        let next = (segment + 1) % SEGMENTS;
        indices.extend_from_slice(&[0, ring_start(1) + next, ring_start(1) + segment]);
        let last = ring_start(RINGS - 1);
        indices.extend_from_slice(&[south, last + segment, last + next]);
    }
    for ring in 1..RINGS - 1 {
        let (upper, lower) = (ring_start(ring), ring_start(ring + 1));
        for segment in 0..SEGMENTS {
            let next = (segment + 1) % SEGMENTS;
            indices.extend_from_slice(&[upper + segment, upper + next, lower + segment]);
            indices.extend_from_slice(&[upper + next, lower + next, lower + segment]);
        }
    }

    let topology = Mesh::new(vertices.clone(), indices.clone()).expect("sphere topology is valid");
    let normals = topology.smooth_vertex_normals();
    Mesh::with_attributes(
        vertices,
        indices,
        VertexAttributes {
            normals: Some(normals),
            ..VertexAttributes::default()
        },
    )
    .expect("sphere normals align with vertices")
}

fn distance_at(index: u32) -> f32 {
    (DISTANCE_MIN_TENTHS + index) as f32 / 10.0
}

fn view(distance: f32) -> LodView {
    LodView::new(
        distance,
        VIEWPORT_HEIGHT_PIXELS,
        VERTICAL_FOV_DEGREES.to_radians(),
    )
}

fn flatten(points: &[Vec3]) -> Vec<f32> {
    points.iter().flat_map(|p| [p.x, p.y, p.z]).collect()
}

fn reason_code(reason: SelectionReason) -> char {
    match reason {
        SelectionReason::Kept => 'k',
        SelectionReason::Coarsened => 'c',
        SelectionReason::Refined => 'r',
    }
}

/// Sweeps the sampled distances in order, recording each level switch.
fn sweep(
    policy: ScreenSpaceLodPolicy,
    errors: &[f32],
    start_level: usize,
    order: impl Iterator<Item = u32>,
) -> (usize, Vec<Value>) {
    let mut level = start_level;
    let mut switches = Vec::new();
    for index in order {
        let distance = distance_at(index);
        let selection = policy
            .select_level(errors, level, view(distance))
            .expect("evidence inputs are valid");
        if selection.level != level {
            switches.push(json!({
                "distanceIndex": index,
                "from": level,
                "to": selection.level,
            }));
        }
        level = selection.level;
    }
    (level, switches)
}

pub fn evidence() -> Value {
    let source = teaching_mesh();
    let extent = mesh_extent(&source).expect("teaching mesh is non-empty");
    let chain = build_lod_chain(&source, &LOD_SPECS).expect("teaching LOD chain simplifies");
    let geometric_errors = std::iter::once(0.0)
        .chain(
            chain
                .iter()
                .map(|level| level.simplification.relative_error * extent),
        )
        .collect::<Vec<_>>();

    let mut levels = vec![json!({
        "level": 0,
        "triangleCount": source.triangle_count(),
        "requestedTriangleCount": source.triangle_count(),
        "relativeError": 0.0,
        "geometricError": 0.0,
        "indices": source.indices(),
    })];
    levels.extend(
        chain
            .iter()
            .zip(&geometric_errors[1..])
            .map(|(level, error)| {
                json!({
                    "level": level.level + 1,
                    "triangleCount": level.simplification.result_triangle_count,
                    "requestedTriangleCount": level.simplification.requested_triangle_count,
                    "relativeError": level.simplification.relative_error,
                    "geometricError": error,
                    "indices": level.simplification.mesh.indices(),
                })
            }),
    );

    let sample_count = DISTANCE_MAX_TENTHS - DISTANCE_MIN_TENTHS + 1;
    let level_count = geometric_errors.len();
    let projected = (0..sample_count)
        .map(|index| {
            let view = view(distance_at(index));
            geometric_errors
                .iter()
                .map(|error| projected_error_pixels(*error, view))
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    let mut policies = Vec::new();
    for budget in PIXEL_BUDGETS {
        for hysteresis_percent in HYSTERESIS_PERCENTS {
            let policy = ScreenSpaceLodPolicy::new(budget, hysteresis_percent as f32 / 100.0);
            let mut by_previous = Vec::with_capacity(level_count);
            let mut reasons_by_previous = Vec::with_capacity(level_count);
            let mut ideal = String::with_capacity(sample_count as usize);
            for previous in 0..level_count {
                let mut selected = String::with_capacity(sample_count as usize);
                let mut reasons = String::with_capacity(sample_count as usize);
                for index in 0..sample_count {
                    let selection = policy
                        .select_level(&geometric_errors, previous, view(distance_at(index)))
                        .expect("evidence inputs are valid");
                    selected.push(char::from_digit(selection.level as u32, 10).expect("< 10"));
                    reasons.push(reason_code(selection.reason));
                    if previous == 0 {
                        ideal.push(
                            char::from_digit(selection.ideal_level as u32, 10).expect("< 10"),
                        );
                    }
                }
                by_previous.push(selected);
                reasons_by_previous.push(reasons);
            }
            let (far_level, outbound) = sweep(policy, &geometric_errors, 0, 0..sample_count);
            let (_, inbound) = sweep(
                policy,
                &geometric_errors,
                far_level,
                (0..sample_count).rev(),
            );
            policies.push(json!({
                "maxPixelError": budget,
                "hysteresisPercent": hysteresis_percent,
                "idealLevel": ideal,
                "selectedLevelByPrevious": by_previous,
                "reasonByPrevious": reasons_by_previous,
                "outboundSwitches": outbound,
                "inboundSwitches": inbound,
            }));
        }
    }

    json!({
        "schema": SCHEMA,
        "generator": "three-d-lod/examples/screen_space_lod_evidence.rs",
        "simplifierId": SIMPLIFIER_ID,
        "meshExtent": extent,
        "positions": flatten(source.vertices()),
        "normals": flatten(source.attributes().normals.as_deref().expect("mesh has normals")),
        "levels": levels,
        "view": {
            "viewportHeightPixels": VIEWPORT_HEIGHT_PIXELS,
            "verticalFovDegrees": VERTICAL_FOV_DEGREES,
            "distanceFrom": "camera to mesh bounds centre",
        },
        "distances": {
            "min": distance_at(0),
            "step": 0.1,
            "count": sample_count,
        },
        "projectedErrorPixels": projected,
        "reasonCodes": { "k": "kept", "c": "coarsened", "r": "refined" },
        "policies": policies,
    })
}

pub fn evidence_text() -> String {
    let mut text = serde_json::to_string(&evidence()).expect("evidence serializes");
    text.push('\n');
    text
}

pub fn fixture_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/lod/screen-space-lod.json")
}

#[allow(dead_code)]
fn main() {
    let path = fixture_path();
    let text = evidence_text();
    if std::env::args().any(|arg| arg == "--check") {
        let committed = std::fs::read_to_string(&path).expect("committed evidence is readable");
        assert!(
            committed == text,
            "{} drifted from three-d-lod; rerun the example without --check",
            path.display()
        );
        return;
    }
    std::fs::create_dir_all(path.parent().expect("fixture has a parent"))
        .expect("fixture directory is writable");
    std::fs::write(&path, text).expect("fixture is writable");
    println!("wrote {}", path.display());
}
