//! Renderer-independent screen-space LOD selection.
//!
//! Each level carries an object-space geometric error (`0` for the source
//! mesh). A perspective view converts that error into projected pixels, and a
//! policy chooses the coarsest level whose projected error fits a pixel budget.
//! Hysteresis widens the budget into a band so a camera hovering near a
//! threshold does not flip levels every frame.

use core::fmt;

use three_d_core::Mesh;

/// Perspective view facts needed to project an object-space error to pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LodView {
    /// Distance from the camera to the mesh bounds centre, in object units.
    pub distance: f32,
    pub viewport_height_pixels: f32,
    pub vertical_fov_radians: f32,
}

impl LodView {
    pub const fn new(
        distance: f32,
        viewport_height_pixels: f32,
        vertical_fov_radians: f32,
    ) -> Self {
        Self {
            distance,
            viewport_height_pixels,
            vertical_fov_radians,
        }
    }

    /// Pixels covered by one object unit at `distance`.
    pub fn pixels_per_unit(self) -> f32 {
        self.viewport_height_pixels
            / (2.0 * self.distance * (self.vertical_fov_radians * 0.5).tan())
    }

    fn validate(self) -> Result<(), SelectionError> {
        if !self.distance.is_finite() || self.distance <= 0.0 {
            return Err(SelectionError::InvalidDistance);
        }
        if !self.viewport_height_pixels.is_finite() || self.viewport_height_pixels <= 0.0 {
            return Err(SelectionError::InvalidViewportHeight);
        }
        if !self.vertical_fov_radians.is_finite()
            || self.vertical_fov_radians <= 0.0
            || self.vertical_fov_radians >= core::f32::consts::PI
        {
            return Err(SelectionError::InvalidVerticalFov);
        }
        Ok(())
    }
}

/// Projects an object-space geometric error into screen pixels.
pub fn projected_error_pixels(geometric_error: f32, view: LodView) -> f32 {
    geometric_error * view.pixels_per_unit()
}

/// Largest bounding-box axis length: the scale meshopt uses for relative error.
pub fn mesh_extent(mesh: &Mesh) -> Option<f32> {
    let bounds = mesh.bounds()?;
    Some(
        (bounds.max.x - bounds.min.x)
            .max(bounds.max.y - bounds.min.y)
            .max(bounds.max.z - bounds.min.z),
    )
}

/// Pixel budget plus a symmetric hysteresis band around it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScreenSpaceLodPolicy {
    pub max_pixel_error: f32,
    /// Fraction of the budget used as a dead band, in `0..1`. A coarser level is
    /// adopted only below `budget * (1 - h)`; the current level is abandoned
    /// for a finer one only above `budget * (1 + h)`.
    pub hysteresis_fraction: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SelectionReason {
    /// The current level stays inside the hysteresis band.
    Kept,
    /// A coarser level fits below the lower band edge.
    Coarsened,
    /// The current level exceeds the upper band edge.
    Refined,
}

#[derive(Debug, Clone, PartialEq)]
pub struct LodSelection {
    pub level: usize,
    /// Coarsest level that fits the bare budget, ignoring hysteresis.
    pub ideal_level: usize,
    pub reason: SelectionReason,
    pub projected_error_pixels: Vec<f32>,
}

impl ScreenSpaceLodPolicy {
    pub const fn new(max_pixel_error: f32, hysteresis_fraction: f32) -> Self {
        Self {
            max_pixel_error,
            hysteresis_fraction,
        }
    }

    /// Selects a level given the level shown in the previous frame.
    ///
    /// `geometric_errors[0]` is the finest level; errors must be finite,
    /// non-negative, and nondecreasing toward coarser levels.
    pub fn select_level(
        self,
        geometric_errors: &[f32],
        current_level: usize,
        view: LodView,
    ) -> Result<LodSelection, SelectionError> {
        self.validate()?;
        view.validate()?;
        validate_errors(geometric_errors)?;
        if current_level >= geometric_errors.len() {
            return Err(SelectionError::CurrentLevelOutOfBounds {
                current_level,
                level_count: geometric_errors.len(),
            });
        }

        let projected = geometric_errors
            .iter()
            .map(|error| projected_error_pixels(*error, view))
            .collect::<Vec<_>>();
        let coarsest_within = |limit: f32| {
            projected
                .iter()
                .rposition(|pixels| *pixels <= limit)
                .unwrap_or(0)
        };
        let ideal_level = coarsest_within(self.max_pixel_error);
        let upper = self.max_pixel_error * (1.0 + self.hysteresis_fraction);
        let lower = self.max_pixel_error * (1.0 - self.hysteresis_fraction);

        let (level, reason) = if projected[current_level] > upper {
            (ideal_level, SelectionReason::Refined)
        } else {
            let candidate = coarsest_within(lower);
            if candidate > current_level {
                (candidate, SelectionReason::Coarsened)
            } else {
                (current_level, SelectionReason::Kept)
            }
        };

        Ok(LodSelection {
            level,
            ideal_level,
            reason,
            projected_error_pixels: projected,
        })
    }

    fn validate(self) -> Result<(), SelectionError> {
        if !self.max_pixel_error.is_finite() || self.max_pixel_error <= 0.0 {
            return Err(SelectionError::InvalidPixelBudget);
        }
        if !self.hysteresis_fraction.is_finite() || !(0.0..1.0).contains(&self.hysteresis_fraction)
        {
            return Err(SelectionError::InvalidHysteresis);
        }
        Ok(())
    }
}

fn validate_errors(geometric_errors: &[f32]) -> Result<(), SelectionError> {
    if geometric_errors.is_empty() {
        return Err(SelectionError::EmptyLevels);
    }
    for (level, error) in geometric_errors.iter().copied().enumerate() {
        if !error.is_finite() || error < 0.0 {
            return Err(SelectionError::InvalidGeometricError { level });
        }
        if level > 0 && error < geometric_errors[level - 1] {
            return Err(SelectionError::ErrorsNotNondecreasing { level });
        }
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelectionError {
    EmptyLevels,
    CurrentLevelOutOfBounds {
        current_level: usize,
        level_count: usize,
    },
    InvalidGeometricError {
        level: usize,
    },
    ErrorsNotNondecreasing {
        level: usize,
    },
    InvalidDistance,
    InvalidViewportHeight,
    InvalidVerticalFov,
    InvalidPixelBudget,
    InvalidHysteresis,
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
            Self::InvalidGeometricError { level } => write!(
                formatter,
                "LOD level {level} must have a finite non-negative geometric error"
            ),
            Self::ErrorsNotNondecreasing { level } => write!(
                formatter,
                "LOD level {level} has less geometric error than the preceding finer level"
            ),
            Self::InvalidDistance => {
                formatter.write_str("view distance must be finite and positive")
            }
            Self::InvalidViewportHeight => {
                formatter.write_str("viewport height must be finite and positive")
            }
            Self::InvalidVerticalFov => formatter
                .write_str("vertical FOV must be finite and strictly between 0 and PI radians"),
            Self::InvalidPixelBudget => {
                formatter.write_str("pixel error budget must be finite and positive")
            }
            Self::InvalidHysteresis => {
                formatter.write_str("hysteresis fraction must be finite and within 0..1")
            }
        }
    }
}

impl std::error::Error for SelectionError {}

#[cfg(test)]
mod tests {
    use super::*;

    const FOV: f32 = core::f32::consts::FRAC_PI_2;
    // With a 90 degree FOV and a 200 px viewport, one unit at distance d covers 100 / d px.
    const ERRORS: [f32; 3] = [0.0, 0.02, 0.08];

    fn view(distance: f32) -> LodView {
        LodView::new(distance, 200.0, FOV)
    }

    fn select(policy: ScreenSpaceLodPolicy, current: usize, distance: f32) -> LodSelection {
        policy
            .select_level(&ERRORS, current, view(distance))
            .unwrap()
    }

    #[test]
    fn projection_scales_inversely_with_distance() {
        assert!((projected_error_pixels(0.02, view(1.0)) - 2.0).abs() < 1e-5);
        assert!((projected_error_pixels(0.02, view(4.0)) - 0.5).abs() < 1e-5);
    }

    #[test]
    fn without_hysteresis_selection_is_the_ideal_level() {
        let policy = ScreenSpaceLodPolicy::new(1.0, 0.0);
        for current in 0..ERRORS.len() {
            for distance in [0.5, 1.9, 2.0, 2.1, 7.9, 8.0, 8.1, 50.0] {
                let selection = select(policy, current, distance);
                assert_eq!(selection.level, selection.ideal_level, "d={distance}");
            }
        }
        assert_eq!(select(policy, 0, 1.0).level, 0);
        assert_eq!(select(policy, 0, 3.0).level, 1);
        assert_eq!(select(policy, 0, 9.0).level, 2);
    }

    #[test]
    fn hysteresis_delays_coarsening_and_refining() {
        let policy = ScreenSpaceLodPolicy::new(1.0, 0.25);
        // Level 1 projects to 1 px at d = 2. Coarsening waits for 0.75 px (d = 2.67).
        let near_threshold = select(policy, 0, 2.4);
        assert_eq!((near_threshold.level, near_threshold.ideal_level), (0, 1));
        assert_eq!(near_threshold.reason, SelectionReason::Kept);
        let coarsened = select(policy, 0, 2.8);
        assert_eq!(coarsened.level, 1);
        assert_eq!(coarsened.reason, SelectionReason::Coarsened);
        // Refining waits until level 1 exceeds 1.25 px (d = 1.6).
        let kept = select(policy, 1, 1.7);
        assert_eq!((kept.level, kept.reason), (1, SelectionReason::Kept));
        let refined = select(policy, 1, 1.5);
        assert_eq!(
            (refined.level, refined.reason),
            (0, SelectionReason::Refined)
        );
    }

    #[test]
    fn jitter_around_a_threshold_does_not_flip_levels() {
        let policy = ScreenSpaceLodPolicy::new(1.0, 0.1);
        let mut level = 0;
        let mut switches = 0;
        for frame in 0..200 {
            let distance = 2.0 + if frame % 2 == 0 { 0.05 } else { -0.05 };
            let next = select(policy, level, distance).level;
            switches += usize::from(next != level);
            level = next;
        }
        assert_eq!(switches, 0);
    }

    #[test]
    fn large_jumps_go_directly_to_the_fitting_level() {
        let policy = ScreenSpaceLodPolicy::new(1.0, 0.25);
        assert_eq!(select(policy, 0, 40.0).level, 2);
        let refined = select(policy, 2, 0.5);
        assert_eq!(
            (refined.level, refined.reason),
            (0, SelectionReason::Refined)
        );
    }

    #[test]
    fn selection_is_deterministic() {
        let policy = ScreenSpaceLodPolicy::new(2.0, 0.15);
        assert_eq!(select(policy, 1, 3.3), select(policy, 1, 3.3));
    }

    #[test]
    fn invalid_inputs_are_rejected() {
        let policy = ScreenSpaceLodPolicy::new(1.0, 0.1);
        assert_eq!(
            policy.select_level(&[], 0, view(1.0)),
            Err(SelectionError::EmptyLevels)
        );
        assert_eq!(
            policy.select_level(&ERRORS, 3, view(1.0)),
            Err(SelectionError::CurrentLevelOutOfBounds {
                current_level: 3,
                level_count: 3
            })
        );
        assert_eq!(
            policy.select_level(&[0.0, 0.2, 0.1], 0, view(1.0)),
            Err(SelectionError::ErrorsNotNondecreasing { level: 2 })
        );
        assert_eq!(
            policy.select_level(&[0.0, f32::NAN], 0, view(1.0)),
            Err(SelectionError::InvalidGeometricError { level: 1 })
        );
        assert_eq!(
            policy.select_level(&ERRORS, 0, view(0.0)),
            Err(SelectionError::InvalidDistance)
        );
        assert_eq!(
            policy.select_level(&ERRORS, 0, LodView::new(1.0, 0.0, FOV)),
            Err(SelectionError::InvalidViewportHeight)
        );
        assert_eq!(
            policy.select_level(&ERRORS, 0, LodView::new(1.0, 200.0, core::f32::consts::PI)),
            Err(SelectionError::InvalidVerticalFov)
        );
        assert_eq!(
            ScreenSpaceLodPolicy::new(0.0, 0.1).select_level(&ERRORS, 0, view(1.0)),
            Err(SelectionError::InvalidPixelBudget)
        );
        assert_eq!(
            ScreenSpaceLodPolicy::new(1.0, 1.0).select_level(&ERRORS, 0, view(1.0)),
            Err(SelectionError::InvalidHysteresis)
        );
    }
}
