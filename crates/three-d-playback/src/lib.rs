//! Frame-rate-independent playback and clip blending for `three-d-animation`.
//!
//! `three-d-animation` remains the authority for clips, keyframes, interpolation,
//! hierarchy math, and skinning semantics. This crate owns only runtime playback policy.

use core::fmt;

use three_d_animation::{AnimationClip, ClipError, Transform};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybackMode {
    Clamp,
    Loop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransitionCurve {
    Linear,
    SmoothStep,
}

impl TransitionCurve {
    fn map(self, factor: f32) -> f32 {
        let factor = factor.clamp(0.0, 1.0);
        match self {
            Self::Linear => factor,
            Self::SmoothStep => factor * factor * (3.0 - 2.0 * factor),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlaybackError {
    InvalidDuration,
    InvalidSpeed,
    InvalidDelta,
    InvalidSeekTime,
    InvalidBlendFactor,
    InvalidSampleTime,
    PoseLengthMismatch { base: usize, output: usize },
    SourceClip(ClipError),
    TargetClip(ClipError),
}

impl fmt::Display for PlaybackError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidDuration => {
                formatter.write_str("playback or transition duration must be finite and positive")
            }
            Self::InvalidSpeed => formatter.write_str("playback speed must be finite"),
            Self::InvalidDelta => {
                formatter.write_str("elapsed playback time must be finite and non-negative")
            }
            Self::InvalidSeekTime => formatter.write_str("seek time must be finite"),
            Self::InvalidBlendFactor => formatter
                .write_str("blend factor must be finite and within the inclusive range 0..=1"),
            Self::InvalidSampleTime => {
                formatter.write_str("cross-fade sample times must be finite")
            }
            Self::PoseLengthMismatch { base, output } => write!(
                formatter,
                "base pose contains {base} nodes but output pose contains {output} nodes"
            ),
            Self::SourceClip(error) => write!(formatter, "source clip sampling failed: {error}"),
            Self::TargetClip(error) => write!(formatter, "target clip sampling failed: {error}"),
        }
    }
}

impl std::error::Error for PlaybackError {}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlaybackClock {
    duration_seconds: f64,
    position_seconds: f64,
    speed: f64,
    mode: PlaybackMode,
}

impl PlaybackClock {
    pub fn new(duration_seconds: f32, mode: PlaybackMode) -> Result<Self, PlaybackError> {
        if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
            return Err(PlaybackError::InvalidDuration);
        }
        Ok(Self {
            duration_seconds: f64::from(duration_seconds),
            position_seconds: 0.0,
            speed: 1.0,
            mode,
        })
    }

    pub fn from_clip(clip: &AnimationClip, mode: PlaybackMode) -> Result<Self, PlaybackError> {
        Self::new(clip.duration(), mode)
    }

    pub fn sample_time(&self) -> f32 {
        self.position_seconds as f32
    }

    pub fn speed(&self) -> f32 {
        self.speed as f32
    }

    pub fn set_speed(&mut self, speed: f32) -> Result<(), PlaybackError> {
        if !speed.is_finite() {
            return Err(PlaybackError::InvalidSpeed);
        }
        self.speed = f64::from(speed);
        Ok(())
    }

    pub fn seek(&mut self, time_seconds: f32) -> Result<f32, PlaybackError> {
        if !time_seconds.is_finite() {
            return Err(PlaybackError::InvalidSeekTime);
        }
        self.position_seconds = self.normalize_position(f64::from(time_seconds));
        Ok(self.sample_time())
    }

    pub fn advance(&mut self, elapsed_seconds: f32) -> Result<f32, PlaybackError> {
        if !elapsed_seconds.is_finite() || elapsed_seconds < 0.0 {
            return Err(PlaybackError::InvalidDelta);
        }
        let next = self.position_seconds + f64::from(elapsed_seconds) * self.speed;
        self.position_seconds = self.normalize_position(next);
        Ok(self.sample_time())
    }

    fn normalize_position(&self, position: f64) -> f64 {
        match self.mode {
            PlaybackMode::Clamp => position.clamp(0.0, self.duration_seconds),
            PlaybackMode::Loop => position.rem_euclid(self.duration_seconds),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TransitionClock {
    duration_seconds: f64,
    elapsed_seconds: f64,
    curve: TransitionCurve,
}

impl TransitionClock {
    pub fn new(duration_seconds: f32, curve: TransitionCurve) -> Result<Self, PlaybackError> {
        if !duration_seconds.is_finite() || duration_seconds <= 0.0 {
            return Err(PlaybackError::InvalidDuration);
        }
        Ok(Self {
            duration_seconds: f64::from(duration_seconds),
            elapsed_seconds: 0.0,
            curve,
        })
    }

    pub fn linear_progress(&self) -> f32 {
        (self.elapsed_seconds / self.duration_seconds) as f32
    }

    pub fn blend_factor(&self) -> f32 {
        self.curve.map(self.linear_progress())
    }

    pub fn is_complete(&self) -> bool {
        self.elapsed_seconds >= self.duration_seconds
    }

    pub fn advance(&mut self, elapsed_seconds: f32) -> Result<f32, PlaybackError> {
        if !elapsed_seconds.is_finite() || elapsed_seconds < 0.0 {
            return Err(PlaybackError::InvalidDelta);
        }
        self.elapsed_seconds =
            (self.elapsed_seconds + f64::from(elapsed_seconds)).min(self.duration_seconds);
        Ok(self.blend_factor())
    }

    pub fn reset(&mut self) {
        self.elapsed_seconds = 0.0;
    }
}

pub fn blend_transform(
    source: Transform,
    target: Transform,
    factor: f32,
) -> Result<Transform, PlaybackError> {
    if !factor.is_finite() || !(0.0..=1.0).contains(&factor) {
        return Err(PlaybackError::InvalidBlendFactor);
    }

    Ok(Transform {
        translation: source.translation * (1.0 - factor) + target.translation * factor,
        rotation: source.rotation.slerp(target.rotation, factor),
        scale: source.scale * (1.0 - factor) + target.scale * factor,
    })
}

pub fn sample_cross_fade(
    source_clip: &AnimationClip,
    source_time: f32,
    target_clip: &AnimationClip,
    target_time: f32,
    factor: f32,
    base_pose: &[Transform],
    output_pose: &mut [Transform],
) -> Result<(), PlaybackError> {
    if !source_time.is_finite() || !target_time.is_finite() {
        return Err(PlaybackError::InvalidSampleTime);
    }
    if !factor.is_finite() || !(0.0..=1.0).contains(&factor) {
        return Err(PlaybackError::InvalidBlendFactor);
    }
    if base_pose.len() != output_pose.len() {
        return Err(PlaybackError::PoseLengthMismatch {
            base: base_pose.len(),
            output: output_pose.len(),
        });
    }

    let mut source_pose = base_pose.to_vec();
    let mut target_pose = base_pose.to_vec();
    source_clip
        .sample(source_time, &mut source_pose)
        .map_err(PlaybackError::SourceClip)?;
    target_clip
        .sample(target_time, &mut target_pose)
        .map_err(PlaybackError::TargetClip)?;

    for ((output, source), target) in output_pose.iter_mut().zip(source_pose).zip(target_pose) {
        *output = blend_transform(source, target, factor)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use core::f32::consts::PI;
    use three_d_animation::{AnimationTrack, Interpolation, Keyframe, KeyframeTrack, Quat};
    use three_d_core::Vec3;

    fn translation_clip(name: &str, end: Vec3) -> AnimationClip {
        let track = KeyframeTrack::new(
            vec![
                Keyframe {
                    time: 0.0,
                    value: Vec3::ZERO,
                },
                Keyframe {
                    time: 1.0,
                    value: end,
                },
            ],
            Interpolation::Linear,
        )
        .unwrap();
        AnimationClip::new(name, vec![AnimationTrack::Translation { node: 0, track }]).unwrap()
    }

    #[test]
    fn elapsed_time_is_independent_of_frame_partitioning() {
        let mut many_frames = PlaybackClock::new(2.0, PlaybackMode::Clamp).unwrap();
        for _ in 0..120 {
            many_frames.advance(1.0 / 120.0).unwrap();
        }

        let mut uneven_frames = PlaybackClock::new(2.0, PlaybackMode::Clamp).unwrap();
        for elapsed in [0.2, 0.3, 0.5] {
            uneven_frames.advance(elapsed).unwrap();
        }

        assert!((many_frames.sample_time() - uneven_frames.sample_time()).abs() < 1.0e-5);
        assert!((many_frames.sample_time() - 1.0).abs() < 1.0e-5);
    }

    #[test]
    fn looping_wraps_forward_and_reverse_playback() {
        let mut clock = PlaybackClock::new(2.0, PlaybackMode::Loop).unwrap();
        assert!((clock.advance(2.5).unwrap() - 0.5).abs() < 1.0e-6);
        clock.set_speed(-1.0).unwrap();
        assert!((clock.advance(1.0).unwrap() - 1.5).abs() < 1.0e-6);
    }

    #[test]
    fn transition_clock_is_independent_of_frame_partitioning() {
        let mut fine = TransitionClock::new(1.0, TransitionCurve::Linear).unwrap();
        for _ in 0..100 {
            fine.advance(0.01).unwrap();
        }

        let mut uneven = TransitionClock::new(1.0, TransitionCurve::Linear).unwrap();
        for elapsed in [0.15, 0.05, 0.3, 0.5] {
            uneven.advance(elapsed).unwrap();
        }

        assert!((fine.linear_progress() - uneven.linear_progress()).abs() < 1.0e-5);
        assert_eq!(fine.blend_factor(), 1.0);
        assert_eq!(uneven.blend_factor(), 1.0);
        assert!(fine.is_complete());
        assert!(uneven.is_complete());
    }

    #[test]
    fn transition_clock_applies_curve_without_changing_elapsed_time() {
        let mut linear = TransitionClock::new(1.0, TransitionCurve::Linear).unwrap();
        let mut smooth = TransitionClock::new(1.0, TransitionCurve::SmoothStep).unwrap();
        linear.advance(0.25).unwrap();
        smooth.advance(0.25).unwrap();

        assert!((linear.linear_progress() - 0.25).abs() < 1.0e-6);
        assert!((smooth.linear_progress() - 0.25).abs() < 1.0e-6);
        assert!((linear.blend_factor() - 0.25).abs() < 1.0e-6);
        assert!((smooth.blend_factor() - 0.15625).abs() < 1.0e-6);
    }

    #[test]
    fn transition_clock_clamps_and_resets() {
        let mut clock = TransitionClock::new(0.5, TransitionCurve::SmoothStep).unwrap();
        assert_eq!(clock.advance(1.0).unwrap(), 1.0);
        assert!(clock.is_complete());
        clock.reset();
        assert_eq!(clock.linear_progress(), 0.0);
        assert_eq!(clock.blend_factor(), 0.0);
        assert!(!clock.is_complete());
    }

    #[test]
    fn transform_blending_uses_slerp_for_rotation() {
        let target_rotation = Quat::from_axis_angle(Vec3::new(0.0, 1.0, 0.0), PI).unwrap();
        let blended = blend_transform(
            Transform::IDENTITY,
            Transform {
                rotation: target_rotation,
                ..Transform::IDENTITY
            },
            0.5,
        )
        .unwrap();

        assert!((blended.rotation.length() - 1.0).abs() < 1.0e-5);
        let transformed = blended.matrix().transform_point(Vec3::new(1.0, 0.0, 0.0));
        assert!(transformed.x.abs() < 1.0e-4);
        assert!((transformed.z.abs() - 1.0).abs() < 1.0e-4);
    }

    #[test]
    fn cross_fade_blends_sampled_clip_poses() {
        let source = translation_clip("left", Vec3::new(-2.0, 0.0, 0.0));
        let target = translation_clip("right", Vec3::new(2.0, 0.0, 0.0));
        let base = [Transform::IDENTITY];
        let mut output = [Transform::IDENTITY];

        sample_cross_fade(&source, 1.0, &target, 1.0, 0.25, &base, &mut output).unwrap();
        assert!((output[0].translation.x + 1.0).abs() < 1.0e-6);
    }

    #[test]
    fn cross_fade_rejects_non_finite_sample_times() {
        let clip = translation_clip("move", Vec3::new(1.0, 0.0, 0.0));
        let base = [Transform::IDENTITY];
        let mut output = [Transform::IDENTITY];

        assert_eq!(
            sample_cross_fade(&clip, f32::NAN, &clip, 0.0, 0.5, &base, &mut output),
            Err(PlaybackError::InvalidSampleTime)
        );
        assert_eq!(
            sample_cross_fade(&clip, 0.0, &clip, f32::INFINITY, 0.5, &base, &mut output,),
            Err(PlaybackError::InvalidSampleTime)
        );
    }

    #[test]
    fn playback_rejects_non_finite_runtime_inputs() {
        let mut playback = PlaybackClock::new(1.0, PlaybackMode::Loop).unwrap();
        let mut transition = TransitionClock::new(1.0, TransitionCurve::Linear).unwrap();
        assert_eq!(playback.advance(f32::NAN), Err(PlaybackError::InvalidDelta));
        assert_eq!(
            transition.advance(f32::NAN),
            Err(PlaybackError::InvalidDelta)
        );
        assert_eq!(
            playback.set_speed(f32::INFINITY),
            Err(PlaybackError::InvalidSpeed)
        );
        assert_eq!(playback.seek(f32::NAN), Err(PlaybackError::InvalidSeekTime));
    }
}
