//! Deterministic level-of-detail generation and selection for renderer-independent meshes.
//!
//! `three-d-core` remains the authority for mesh validity and vertex attributes.
//! This crate derives alternate index buffers from that source mesh and owns the
//! renderer-independent policy for deciding which level is acceptable on screen.

use core::fmt;

use meshopt::simplify::{SimplifyOptions, simplify_decoder};
use three_d_core::Mesh;

pub const SIMPLIFIER_ID: &str = "meshopt-0.6.2";

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SimplificationSettings {
    pub target_triangle_count: usize,
    pub target_error: f32,
    pub lock_border: bool,
}

impl SimplificationSettings {
    pub const fn new(target_triangle_count: usize, target_error: f32) -> Self {
        Self {
            target_triangle_count,
            target_error,
            lock_border: false,
        }
    }

    pub const fn with_locked_border(mut self, lock_border: bool) -> Self {
        self.lock_border = lock_border;
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SimplificationError {
    EmptyMesh,
    SourceCannotBeReduced,
    ZeroTarget,
    TargetExceedsSource {
        target_triangle_count: usize,
        source_triangle_count: usize,
    },
    InvalidTargetError,
    InvalidLodRatio {
        level: usize,
    },
    LodRatiosNotStrictlyDecreasing {
        level: usize,
    },
}

impl fmt::Display for SimplificationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyMesh => {
                formatter.write_str("mesh simplification requires at least one triangle")
            }
            Self::SourceCannotBeReduced => formatter
                .write_str("LOD generation requires a source mesh with at least two triangles"),
            Self::ZeroTarget => formatter.write_str("target triangle count must be positive"),
            Self::TargetExceedsSource {
                target_triangle_count,
                source_triangle_count,
            } => write!(
                formatter,
                "target triangle count {target_triangle_count} exceeds source triangle count {source_triangle_count}"
            ),
            Self::InvalidTargetError => formatter
                .write_str("target error must be finite and within the inclusive range 0..=1"),
            Self::InvalidLodRatio { level } => write!(
                formatter,
                "LOD level {level} must use a finite triangle ratio strictly between 0 and 1"
            ),
            Self::LodRatiosNotStrictlyDecreasing { level } => write!(
                formatter,
                "LOD level {level} must request fewer source triangles than the previous level"
            ),
        }
    }
}

impl std::error::Error for SimplificationError {}

#[derive(Debug, Clone, PartialEq)]
pub struct SimplificationResult {
    pub mesh: Mesh,
    pub source_triangle_count: usize,
    pub requested_triangle_count: usize,
    pub result_triangle_count: usize,
    pub relative_error: f32,
    pub simplifier_id: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LodSpec {
    pub triangle_ratio: f32,
    pub target_error: f32,
    pub lock_border: bool,
}

impl LodSpec {
    pub const fn new(triangle_ratio: f32, target_error: f32) -> Self {
        Self {
            triangle_ratio,
            target_error,
            lock_border: false,
        }
    }

    pub const fn with_locked_border(mut self, lock_border: bool) -> Self {
        self.lock_border = lock_border;
        self
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct LodLevel {
    pub level: usize,
    pub triangle_ratio: f32,
    pub simplification: SimplificationResult,
}

pub fn simplify_mesh(
    mesh: &Mesh,
    settings: SimplificationSettings,
) -> Result<SimplificationResult, SimplificationError> {
    let source_triangle_count = mesh.triangle_count();
    if source_triangle_count == 0 {
        return Err(SimplificationError::EmptyMesh);
    }
    if settings.target_triangle_count == 0 {
        return Err(SimplificationError::ZeroTarget);
    }
    if settings.target_triangle_count > source_triangle_count {
        return Err(SimplificationError::TargetExceedsSource {
            target_triangle_count: settings.target_triangle_count,
            source_triangle_count,
        });
    }
    if !settings.target_error.is_finite() || !(0.0..=1.0).contains(&settings.target_error) {
        return Err(SimplificationError::InvalidTargetError);
    }

    if settings.target_triangle_count == source_triangle_count {
        return Ok(SimplificationResult {
            mesh: mesh.clone(),
            source_triangle_count,
            requested_triangle_count: settings.target_triangle_count,
            result_triangle_count: source_triangle_count,
            relative_error: 0.0,
            simplifier_id: SIMPLIFIER_ID,
        });
    }

    let positions = mesh
        .vertices()
        .iter()
        .map(|vertex| [vertex.x, vertex.y, vertex.z])
        .collect::<Vec<_>>();
    let options = if settings.lock_border {
        SimplifyOptions::LockBorder
    } else {
        SimplifyOptions::None
    };
    let mut relative_error = 0.0;
    let indices = simplify_decoder(
        mesh.indices(),
        &positions,
        settings.target_triangle_count * 3,
        settings.target_error,
        options,
        Some(&mut relative_error),
    );
    let simplified =
        Mesh::with_attributes(mesh.vertices().to_vec(), indices, mesh.attributes().clone())
            .expect("meshopt returns indices into the validated source vertex buffer");
    let result_triangle_count = simplified.triangle_count();

    Ok(SimplificationResult {
        mesh: simplified,
        source_triangle_count,
        requested_triangle_count: settings.target_triangle_count,
        result_triangle_count,
        relative_error,
        simplifier_id: SIMPLIFIER_ID,
    })
}

pub fn build_lod_chain(
    mesh: &Mesh,
    specs: &[LodSpec],
) -> Result<Vec<LodLevel>, SimplificationError> {
    let source_triangle_count = mesh.triangle_count();
    if source_triangle_count == 0 {
        return Err(SimplificationError::EmptyMesh);
    }
    if source_triangle_count < 2 && !specs.is_empty() {
        return Err(SimplificationError::SourceCannotBeReduced);
    }

    let mut previous_target = source_triangle_count;
    let mut levels = Vec::with_capacity(specs.len());
    for (level, spec) in specs.iter().copied().enumerate() {
        if !spec.triangle_ratio.is_finite() || !(0.0..1.0).contains(&spec.triangle_ratio) {
            return Err(SimplificationError::InvalidLodRatio { level });
        }
        let target_triangle_count = ((source_triangle_count as f32 * spec.triangle_ratio).round()
            as usize)
            .clamp(1, source_triangle_count - 1);
        if target_triangle_count >= previous_target {
            return Err(SimplificationError::LodRatiosNotStrictlyDecreasing { level });
        }

        let simplification = simplify_mesh(
            mesh,
            SimplificationSettings::new(target_triangle_count, spec.target_error)
                .with_locked_border(spec.lock_border),
        )?;
        levels.push(LodLevel {
            level,
            triangle_ratio: spec.triangle_ratio,
            simplification,
        });
        previous_target = target_triangle_count;
    }

    Ok(levels)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LodView {
    pub mesh_extent: f32,
    pub distance: f32,
    pub viewport_height_pixels: f32,
    pub vertical_fov_radians: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenSpaceLodPolicy {
    pub target_pixel_error: f32,
    pub hysteresis_fraction: f32,
}

impl ScreenSpaceLodPolicy {
    pub const fn new(target_pixel_error: f32, hysteresis_fraction: f32) -> Self {
        Self {
            target_pixel_error,
            hysteresis_fraction,
        }
    }

    pub fn select_level(
        self,
        relative_errors: &[f32],
        current_level: usize,
        view: LodView,
    ) -> Result<LodSelection, SelectionError> {
        validate_selection_inputs(self, relative_errors, current_level, view)?;

        let projected_errors = relative_errors
            .iter()
            .copied()
            .map(|relative_error| projected_error_pixels(relative_error, view))
            .collect::<Vec<_>>();
        let ideal_level = projected_errors
            .iter()
            .rposition(|projected_error| *projected_error <= self.target_pixel_error)
            .unwrap_or(0);

        let selected_level = if ideal_level > current_level {
            let coarsen_threshold = self.target_pixel_error * (1.0 - self.hysteresis_fraction);
            projected_errors
                .iter()
                .rposition(|projected_error| *projected_error <= coarsen_threshold)
                .unwrap_or(current_level)
                .max(current_level)
        } else if ideal_level < current_level {
            let refine_threshold = self.target_pixel_error * (1.0 + self.hysteresis_fraction);
            if projected_errors[current_level] > refine_threshold {
                ideal_level
            } else {
                current_level
            }
        } else {
            current_level
        };

        Ok(LodSelection {
            level: selected_level,
            projected_error_pixels: projected_errors[selected_level],
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LodSelection {
    pub level: usize,
    pub projected_error_pixels: f32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectionError {
    EmptyLevels,
    CurrentLevelOutOfBounds {
        current_level: usize,
        level_count: usize,
    },
    InvalidRelativeError {
        level: usize,
    },
    RelativeErrorsNotNondecreasing {
        level: usize,
    },
    InvalidMeshExtent,
    InvalidDistance,
    InvalidViewportHeight,
    InvalidVerticalFov,
    InvalidTargetPixelError,
    InvalidHysteresisFraction,
}

impl fmt::Display for SelectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyLevels => formatter.write_str("LOD selection requires at least one level"),
            Self::CurrentLevelOutOfBounds {
                current_level,
                level_count,
            } => write!(
                formatter,
                "current LOD level {current_level} is outside {level_count} available levels"
            ),
            Self::InvalidRelativeError { level } => write!(
                formatter,
                "LOD level {level} must have a finite non-negative relative error"
            ),
            Self::RelativeErrorsNotNondecreasing { level } => write!(
                formatter,
                "LOD level {level} has less relative error than the preceding finer level"
            ),
            Self::InvalidMeshExtent => {
                formatter.write_str("mesh extent must be finite and positive")
            }
            Self::InvalidDistance => {
                formatter.write_str("camera distance must be finite and positive")
            }
            Self::InvalidViewportHeight => {
                formatter.write_str("viewport height must be finite and positive")
            }
            Self::InvalidVerticalFov => formatter
                .write_str("vertical FOV must be finite and strictly between 0 and PI radians"),
            Self::InvalidTargetPixelError => {
                formatter.write_str("target pixel error must be finite and positive")
            }
            Self::InvalidHysteresisFraction => formatter.write_str(
                "hysteresis fraction must be finite and within the inclusive-exclusive range 0..1",
            ),
        }
    }
}

impl std::error::Error for SelectionError {}

pub fn projected_error_pixels(relative_error: f32, view: LodView) -> f32 {
    let projection_scale =
        view.viewport_height_pixels / (2.0 * (view.vertical_fov_radians * 0.5).tan());
    relative_error * view.mesh_extent * projection_scale / view.distance
}

fn validate_selection_inputs(
    policy: ScreenSpaceLodPolicy,
    relative_errors: &[f32],
    current_level: usize,
    view: LodView,
) -> Result<(), SelectionError> {
    if relative_errors.is_empty() {
        return Err(SelectionError::EmptyLevels);
    }
    if current_level >= relative_errors.len() {
        return Err(SelectionError::CurrentLevelOutOfBounds {
            current_level,
            level_count: relative_errors.len(),
        });
    }
    for (level, relative_error) in relative_errors.iter().copied().enumerate() {
        if !relative_error.is_finite() || relative_error < 0.0 {
            return Err(SelectionError::InvalidRelativeError { level });
        }
        if level > 0 && relative_error < relative_errors[level - 1] {
            return Err(SelectionError::RelativeErrorsNotNondecreasing { level });
        }
    }
    if !view.mesh_extent.is_finite() || view.mesh_extent <= 0.0 {
        return Err(SelectionError::InvalidMeshExtent);
    }
    if !view.distance.is_finite() || view.distance <= 0.0 {
        return Err(SelectionError::InvalidDistance);
    }
    if !view.viewport_height_pixels.is_finite() || view.viewport_height_pixels <= 0.0 {
        return Err(SelectionError::InvalidViewportHeight);
    }
    if !view.vertical_fov_radians.is_finite()
        || view.vertical_fov_radians <= 0.0
        || view.vertical_fov_radians >= core::f32::consts::PI
    {
        return Err(SelectionError::InvalidVerticalFov);
    }
    if !policy.target_pixel_error.is_finite() || policy.target_pixel_error <= 0.0 {
        return Err(SelectionError::InvalidTargetPixelError);
    }
    if !policy.hysteresis_fraction.is_finite() || !(0.0..1.0).contains(&policy.hysteresis_fraction)
    {
        return Err(SelectionError::InvalidHysteresisFraction);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use three_d_core::{Vec2, Vec3, VertexAttributes};

    fn detailed_plane() -> Mesh {
        Mesh::subdivided_plane(8).expect("fixture is valid")
    }

    fn view(distance: f32) -> LodView {
        LodView {
            mesh_extent: 2.0,
            distance,
            viewport_height_pixels: 1080.0,
            vertical_fov_radians: core::f32::consts::FRAC_PI_3,
        }
    }

    #[test]
    fn simplification_is_deterministic_for_identical_inputs() {
        let mesh = detailed_plane();
        let settings = SimplificationSettings::new(32, 1.0);
        let first = simplify_mesh(&mesh, settings).unwrap();
        let second = simplify_mesh(&mesh, settings).unwrap();

        assert_eq!(first.mesh.indices(), second.mesh.indices());
        assert_eq!(first.relative_error, second.relative_error);
        assert_eq!(first.simplifier_id, SIMPLIFIER_ID);
    }

    #[test]
    fn simplification_preserves_source_vertices_and_attributes() {
        let mesh = Mesh::with_attributes(
            vec![
                Vec3::new(-1.0, -1.0, 0.0),
                Vec3::new(0.0, -1.0, 0.0),
                Vec3::new(1.0, -1.0, 0.0),
                Vec3::new(-1.0, 1.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
                Vec3::new(1.0, 1.0, 0.0),
            ],
            vec![0, 1, 3, 1, 4, 3, 1, 2, 4, 2, 5, 4],
            VertexAttributes {
                normals: Some(vec![Vec3::new(0.0, 0.0, 1.0); 6]),
                uvs: Some(vec![
                    Vec2::new(0.0, 0.0),
                    Vec2::new(0.5, 0.0),
                    Vec2::new(1.0, 0.0),
                    Vec2::new(0.0, 1.0),
                    Vec2::new(0.5, 1.0),
                    Vec2::new(1.0, 1.0),
                ]),
                ..VertexAttributes::default()
            },
        )
        .unwrap();
        let result = simplify_mesh(&mesh, SimplificationSettings::new(2, 1.0)).unwrap();

        assert_eq!(result.mesh.vertices(), mesh.vertices());
        assert_eq!(result.mesh.attributes(), mesh.attributes());
        assert!(result.result_triangle_count <= mesh.triangle_count());
    }

    #[test]
    fn source_budget_is_an_exact_identity_operation() {
        let mesh = detailed_plane();
        let result = simplify_mesh(
            &mesh,
            SimplificationSettings::new(mesh.triangle_count(), 0.0),
        )
        .unwrap();

        assert_eq!(result.mesh, mesh);
        assert_eq!(result.relative_error, 0.0);
    }

    #[test]
    fn lod_chain_uses_strictly_decreasing_source_budgets() {
        let mesh = detailed_plane();
        let levels = build_lod_chain(
            &mesh,
            &[
                LodSpec::new(0.75, 1.0),
                LodSpec::new(0.5, 1.0),
                LodSpec::new(0.25, 1.0),
            ],
        )
        .unwrap();

        let requested = levels
            .iter()
            .map(|level| level.simplification.requested_triangle_count)
            .collect::<Vec<_>>();
        assert!(requested.windows(2).all(|pair| pair[0] > pair[1]));
        assert!(
            levels
                .iter()
                .all(|level| level.simplification.source_triangle_count == mesh.triangle_count())
        );
    }

    #[test]
    fn lod_chain_rejects_duplicate_effective_budgets() {
        let mesh = Mesh::unit_cube();
        let result = build_lod_chain(&mesh, &[LodSpec::new(0.51, 1.0), LodSpec::new(0.50, 1.0)]);

        assert_eq!(
            result,
            Err(SimplificationError::LodRatiosNotStrictlyDecreasing { level: 1 })
        );
    }

    #[test]
    fn lod_chain_rejects_single_triangle_sources() {
        let mesh = Mesh::new(
            vec![
                Vec3::new(0.0, 0.0, 0.0),
                Vec3::new(1.0, 0.0, 0.0),
                Vec3::new(0.0, 1.0, 0.0),
            ],
            vec![0, 1, 2],
        )
        .unwrap();

        assert_eq!(
            build_lod_chain(&mesh, &[LodSpec::new(0.5, 1.0)]),
            Err(SimplificationError::SourceCannotBeReduced)
        );
    }

    #[test]
    fn projected_error_decreases_with_camera_distance() {
        let near = projected_error_pixels(0.01, view(5.0));
        let far = projected_error_pixels(0.01, view(10.0));
        assert!(near > far);
        assert!((near - far * 2.0).abs() < 1.0e-4);
    }

    #[test]
    fn selector_chooses_coarsest_level_inside_pixel_budget() {
        let policy = ScreenSpaceLodPolicy::new(2.0, 0.0);
        let selection = policy
            .select_level(&[0.0, 0.01, 0.03], 0, view(10.0))
            .unwrap();
        assert_eq!(selection.level, 1);
        assert!(selection.projected_error_pixels <= 2.0);
    }

    #[test]
    fn hysteresis_prevents_threshold_flicker_in_both_directions() {
        let policy = ScreenSpaceLodPolicy::new(2.0, 0.2);
        let errors = [0.0, 0.01, 0.03];

        assert_eq!(
            policy.select_level(&errors, 0, view(10.0)).unwrap().level,
            0
        );
        assert_eq!(
            policy.select_level(&errors, 0, view(12.0)).unwrap().level,
            1
        );
        assert_eq!(policy.select_level(&errors, 1, view(9.0)).unwrap().level, 1);
        assert_eq!(policy.select_level(&errors, 1, view(7.0)).unwrap().level, 0);
    }

    #[test]
    fn coarsening_uses_the_best_intermediate_level_inside_the_hysteresis_margin() {
        let policy = ScreenSpaceLodPolicy::new(2.0, 0.2);
        let selection = policy
            .select_level(
                &[0.0, 1.0, 1.8],
                0,
                LodView {
                    mesh_extent: 1.0,
                    distance: 1.0,
                    viewport_height_pixels: 2.0,
                    vertical_fov_radians: core::f32::consts::FRAC_PI_2,
                },
            )
            .unwrap();
        assert_eq!(selection.level, 1);
        assert!((selection.projected_error_pixels - 1.0).abs() < 1.0e-6);
    }

    #[test]
    fn selector_rejects_misordered_error_levels() {
        let result =
            ScreenSpaceLodPolicy::new(2.0, 0.1).select_level(&[0.0, 0.02, 0.01], 0, view(10.0));
        assert_eq!(
            result,
            Err(SelectionError::RelativeErrorsNotNondecreasing { level: 2 })
        );
    }
}
