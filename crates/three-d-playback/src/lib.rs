//! Frame-rate-independent playback clocks and cross-fade transition policy.
//!
//! `three-d-animation` stays the authority for clip, keyframe, and quaternion
//! meaning. This crate only owns the *runtime clock*: how measured wall-clock
//! frame deltas become clip time (clamp/loop, forward/reverse, speed) and how a
//! cross-fade's wall-clock duration becomes a blend weight.
//!
//! Every clock accumulates elapsed seconds in `f64` and derives clip time from
//! the accumulated total instead of stepping a wrapped `f32` per frame. Splitting
//! the same wall time into different frame deltas therefore resolves to the same
//! clip time, transition progress, and sampled pose (partition invariance).

use core::fmt;

use three_d_animation::{
    AnimationClip, BlendError, ClipBlendWorkspace, ClipSample, LoopMode, Transform,
};

/// Positions within this many cycles of a cycle boundary resolve to the
/// boundary. Durations are authored as `f32` (about 7 significant digits), so
/// 36 frames of 1/60 s must complete a 0.6 s transition even though `0.6_f32`
/// is slightly above 0.6; the same snap stops float summation noise from
/// landing different frame partitions on opposite sides of a loop wrap.
pub const BOUNDARY_EPSILON_CYCLES: f64 = 1.0e-6;

/// What happens when the playhead passes the clip duration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybackMode {
    /// Hold the final pose (the first pose when reversed).
    Clamp,
    /// Wrap back to the start (the end when reversed).
    Loop,
}

impl From<LoopMode> for PlaybackMode {
    fn from(mode: LoopMode) -> Self {
        match mode {
            LoopMode::Clamp => Self::Clamp,
            LoopMode::Repeat => Self::Loop,
        }
    }
}

/// Which way clip time runs. Elapsed wall time is never negative; reversing is
/// a playback policy, not a negative frame delta.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybackDirection {
    Forward,
    Reverse,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PlaybackError {
    /// Clip or transition duration was not finite and positive.
    InvalidDuration,
    /// Playback speed was not finite and non-negative.
    InvalidSpeed,
    /// A frame delta was not finite and non-negative.
    InvalidDelta,
    /// Accepting the delta would overflow the accumulated time; the clock is
    /// left unchanged.
    TimeOverflow,
}

impl fmt::Display for PlaybackError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidDuration => {
                "playback and transition durations must be finite and positive"
            }
            Self::InvalidSpeed => "playback speed must be finite and non-negative",
            Self::InvalidDelta => "frame delta must be finite and non-negative seconds",
            Self::TimeOverflow => "frame delta would overflow the accumulated playback time",
        })
    }
}

impl std::error::Error for PlaybackError {}

fn validate_delta(delta_seconds: f64) -> Result<(), PlaybackError> {
    if delta_seconds.is_finite() && delta_seconds >= 0.0 {
        Ok(())
    } else {
        Err(PlaybackError::InvalidDelta)
    }
}

/// The accumulated total after adding `step`, or [`PlaybackError::TimeOverflow`]
/// when the total (or its cycle count over `duration_seconds`) is no longer
/// finite. Callers commit the result only on success.
fn accumulate(total: f64, step: f64, duration_seconds: f64) -> Result<f64, PlaybackError> {
    let next = total + step;
    if step.is_finite() && next.is_finite() && (next / duration_seconds).is_finite() {
        Ok(next)
    } else {
        Err(PlaybackError::TimeOverflow)
    }
}

fn validate_duration(duration_seconds: f64) -> Result<f64, PlaybackError> {
    if duration_seconds.is_finite() && duration_seconds > 0.0 {
        Ok(duration_seconds)
    } else {
        Err(PlaybackError::InvalidDuration)
    }
}

/// Snaps `cycles` onto the nearest whole number when it is within
/// [`BOUNDARY_EPSILON_CYCLES`] of it.
fn snap_cycles(cycles: f64) -> f64 {
    let nearest = cycles.round();
    if (cycles - nearest).abs() <= BOUNDARY_EPSILON_CYCLES {
        nearest
    } else {
        cycles
    }
}

/// Elapsed-time playback clock for one clip.
///
/// The clock stores how many clip seconds the playhead has travelled since the
/// start (`speed × elapsed wall seconds`) and resolves clip time from that total.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PlaybackClock {
    duration_seconds: f64,
    mode: PlaybackMode,
    direction: PlaybackDirection,
    speed: f64,
    travelled_seconds: f64,
}

impl PlaybackClock {
    pub fn new(duration_seconds: f32, mode: PlaybackMode) -> Result<Self, PlaybackError> {
        Ok(Self {
            duration_seconds: validate_duration(f64::from(duration_seconds))?,
            mode,
            direction: PlaybackDirection::Forward,
            speed: 1.0,
            travelled_seconds: 0.0,
        })
    }

    /// A clock over the clip's duration that adopts the clip's own loop mode, so
    /// the clip and the clock never disagree about wrapping.
    pub fn from_clip(clip: &AnimationClip) -> Result<Self, PlaybackError> {
        Self::new(clip.duration(), clip.loop_mode().into())
    }

    pub fn with_direction(mut self, direction: PlaybackDirection) -> Self {
        self.direction = direction;
        self
    }

    pub fn with_speed(mut self, speed: f64) -> Result<Self, PlaybackError> {
        self.set_speed(speed)?;
        Ok(self)
    }

    /// Changes the rate for future deltas; time already travelled is kept.
    pub fn set_speed(&mut self, speed: f64) -> Result<(), PlaybackError> {
        if !speed.is_finite() || speed < 0.0 {
            return Err(PlaybackError::InvalidSpeed);
        }
        self.speed = speed;
        Ok(())
    }

    pub fn duration_seconds(&self) -> f64 {
        self.duration_seconds
    }

    pub fn mode(&self) -> PlaybackMode {
        self.mode
    }

    pub fn direction(&self) -> PlaybackDirection {
        self.direction
    }

    pub fn speed(&self) -> f64 {
        self.speed
    }

    /// Clip seconds travelled since the start, before clamping or wrapping.
    pub fn travelled_seconds(&self) -> f64 {
        self.travelled_seconds
    }

    /// Advances by one measured frame delta and returns the resolved clip time.
    pub fn advance(&mut self, delta_seconds: f64) -> Result<f32, PlaybackError> {
        validate_delta(delta_seconds)?;
        self.travelled_seconds = accumulate(
            self.travelled_seconds,
            self.speed * delta_seconds,
            self.duration_seconds,
        )?;
        Ok(self.clip_time())
    }

    fn cycles(&self) -> f64 {
        snap_cycles(self.travelled_seconds / self.duration_seconds)
    }

    /// Whole clip cycles completed so far (always 0 or 1 when clamping).
    pub fn completed_cycles(&self) -> u64 {
        let cycles = self.cycles().floor();
        match self.mode {
            PlaybackMode::Clamp => cycles.min(1.0) as u64,
            PlaybackMode::Loop => cycles as u64,
        }
    }

    /// True once a clamped clock has reached its final pose.
    pub fn is_finished(&self) -> bool {
        self.mode == PlaybackMode::Clamp && self.cycles() >= 1.0
    }

    /// Clip time in `0..=duration` to sample the clip at.
    pub fn clip_time(&self) -> f32 {
        let cycles = self.cycles();
        let fraction = match self.mode {
            PlaybackMode::Clamp => cycles.min(1.0),
            PlaybackMode::Loop => cycles - cycles.floor(),
        };
        let fraction = match self.direction {
            PlaybackDirection::Forward => fraction,
            PlaybackDirection::Reverse => 1.0 - fraction,
        };
        (fraction * self.duration_seconds) as f32
    }

    pub fn reset(&mut self) {
        self.travelled_seconds = 0.0;
    }

    /// Samples `clip` at this clock's time into `pose`.
    ///
    /// The clock has already resolved clamping and wrapping, so the clip's own
    /// loop mode is not applied again: a reverse loop that reports `duration`
    /// presents the final pose, not the wrapped first pose.
    pub fn sample(
        &self,
        clip: &AnimationClip,
        pose: &mut [Transform],
    ) -> Result<(), three_d_animation::ClipError> {
        clip.sample_resolved(self.clip_time(), pose)
    }
}

/// Maps linear transition progress to a blend weight.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransitionCurve {
    Linear,
    SmoothStep,
}

impl TransitionCurve {
    pub fn weight(self, progress: f32) -> f32 {
        let progress = progress.clamp(0.0, 1.0);
        match self {
            Self::Linear => progress,
            Self::SmoothStep => progress * progress * (3.0 - 2.0 * progress),
        }
    }
}

/// Wall-clock progress of one cross-fade.
///
/// It advances by real elapsed seconds only. Playback speed and direction of
/// the participating clips never change how long the transition takes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct TransitionClock {
    duration_seconds: f64,
    elapsed_seconds: f64,
    curve: TransitionCurve,
}

impl TransitionClock {
    pub fn new(duration_seconds: f32, curve: TransitionCurve) -> Result<Self, PlaybackError> {
        Ok(Self {
            duration_seconds: validate_duration(f64::from(duration_seconds))?,
            elapsed_seconds: 0.0,
            curve,
        })
    }

    pub fn advance(&mut self, delta_seconds: f64) -> Result<f32, PlaybackError> {
        validate_delta(delta_seconds)?;
        self.elapsed_seconds =
            accumulate(self.elapsed_seconds, delta_seconds, self.duration_seconds)?;
        Ok(self.weight())
    }

    pub fn duration_seconds(&self) -> f64 {
        self.duration_seconds
    }

    pub fn elapsed_seconds(&self) -> f64 {
        self.elapsed_seconds
    }

    pub fn curve(&self) -> TransitionCurve {
        self.curve
    }

    /// Linear progress in `0..=1`.
    pub fn progress(&self) -> f32 {
        snap_cycles(self.elapsed_seconds / self.duration_seconds).min(1.0) as f32
    }

    /// Curve-mapped blend weight toward the target clip.
    pub fn weight(&self) -> f32 {
        self.curve.weight(self.progress())
    }

    pub fn is_complete(&self) -> bool {
        self.progress() >= 1.0
    }

    pub fn reset(&mut self) {
        self.elapsed_seconds = 0.0;
    }
}

/// One frame of cross-fade state after advancing by a wall-clock delta.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CrossFadeFrame {
    pub from_time: f32,
    pub to_time: f32,
    pub progress: f32,
    pub weight: f32,
    pub complete: bool,
}

/// A cross-fade between two independently clocked clips.
///
/// Each frame advances three separate clocks by the same wall delta: the
/// outgoing clip clock, the incoming clip clock, and the transition clock.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CrossFade {
    from: PlaybackClock,
    to: PlaybackClock,
    transition: TransitionClock,
}

impl CrossFade {
    pub fn new(from: PlaybackClock, to: PlaybackClock, transition: TransitionClock) -> Self {
        Self {
            from,
            to,
            transition,
        }
    }

    pub fn from_clock(&self) -> &PlaybackClock {
        &self.from
    }

    pub fn to_clock(&self) -> &PlaybackClock {
        &self.to
    }

    pub fn transition(&self) -> &TransitionClock {
        &self.transition
    }

    pub fn frame(&self) -> CrossFadeFrame {
        CrossFadeFrame {
            from_time: self.from.clip_time(),
            to_time: self.to.clip_time(),
            progress: self.transition.progress(),
            weight: self.transition.weight(),
            complete: self.transition.is_complete(),
        }
    }

    pub fn advance(&mut self, delta_seconds: f64) -> Result<CrossFadeFrame, PlaybackError> {
        // Advance copies and commit only if all three clocks accept the delta,
        // so a rejected frame leaves the whole cross-fade untouched.
        let mut next = *self;
        next.from.advance(delta_seconds)?;
        next.to.advance(delta_seconds)?;
        next.transition.advance(delta_seconds)?;
        *self = next;
        Ok(self.frame())
    }

    /// Samples both clips from `base_pose` and blends them by the transition
    /// weight through `three-d-animation`'s cross-fade. Like
    /// [`PlaybackClock::sample`], each clip is sampled at its clock-resolved
    /// time without re-applying the clip's loop mode.
    pub fn sample(
        &self,
        from_clip: &AnimationClip,
        to_clip: &AnimationClip,
        workspace: &mut ClipBlendWorkspace,
        base_pose: &[Transform],
        output: &mut [Transform],
    ) -> Result<(), BlendError> {
        workspace.sample_resolved_crossfade(
            ClipSample {
                clip: from_clip,
                time: self.from.clip_time(),
            },
            ClipSample {
                clip: to_clip,
                time: self.to.clip_time(),
            },
            self.transition.weight(),
            base_pose,
            output,
        )
    }

    /// The incoming clip clock, to keep playing once the fade is complete.
    pub fn into_target(self) -> PlaybackClock {
        self.to
    }
}

#[cfg(test)]
mod tests;
