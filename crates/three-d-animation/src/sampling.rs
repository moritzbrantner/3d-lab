//! Pre-resolved, allocation-free clip sampling for many characters.
//!
//! [`AnimationClip::sample`] stays the readable reference sampler. The types in
//! this module compile a clip once into flat typed storage (one contiguous time
//! array plus one contiguous value array, with pre-resolved node/channel
//! descriptors) and then sample it into caller-owned pose slices without
//! allocating:
//!
//! - [`CompiledClip`] keeps exact `f32` values and is bit-for-bit identical to
//!   the reference sampler for every finite sample time.
//! - [`SampleCursor`] is per-instance key-lookup state. Sampling first checks the
//!   cursor's previous segment and its successor, then falls back to a binary
//!   search, so monotonic playback is O(1) per track and random seeks are
//!   O(log keys). The chosen segment never depends on the cursor, only the
//!   lookup cost does.
//! - [`QuantizedClip`] stores key values as 16-bit integers with an explicit
//!   [`QuantizationBudget`]. Compression fails closed when any decoded key would
//!   exceed the budget.

use core::fmt;

use super::{
    AnimationClip, AnimationTrack, ClipError, EPSILON, Interpolate, Interpolation, LoopMode, Quat,
    Transform,
};
use three_d_core::Vec3;

/// The transform component a compiled track writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Channel {
    Translation,
    Rotation,
    Scale,
}

impl Channel {
    const fn stride(self) -> usize {
        match self {
            Self::Rotation => 4,
            Self::Translation | Self::Scale => 3,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum SamplerError {
    Clip(ClipError),
    PoseLengthMismatch { expected: usize, actual: usize },
    CursorMismatch { expected: usize, actual: usize },
}

impl fmt::Display for SamplerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Clip(error) => error.fmt(formatter),
            Self::PoseLengthMismatch { expected, actual } => write!(
                formatter,
                "compiled clip expects a pose of {expected} nodes, got {actual}"
            ),
            Self::CursorMismatch { expected, actual } => write!(
                formatter,
                "sample cursor tracks {actual} tracks, but the clip has {expected}"
            ),
        }
    }
}

impl std::error::Error for SamplerError {}

impl From<ClipError> for SamplerError {
    fn from(error: ClipError) -> Self {
        Self::Clip(error)
    }
}

/// Pre-resolved track descriptor: target node, channel, and slices into the
/// clip's flat time/value arrays.
#[derive(Debug, Clone, Copy, PartialEq)]
struct TrackDesc {
    node: usize,
    channel: Channel,
    interpolation: Interpolation,
    key_start: usize,
    key_count: usize,
    value_start: usize,
}

/// Clip-wide timing and key layout shared by exact and quantized storage.
#[derive(Debug, Clone, PartialEq)]
struct ClipLayout {
    duration: f32,
    loop_mode: LoopMode,
    node_count: usize,
    tracks: Vec<TrackDesc>,
    times: Vec<f32>,
}

/// Where a sample time falls inside one track.
enum KeyLocation {
    Key(usize),
    Segment { start: usize, factor: f32 },
}

impl ClipLayout {
    fn new(clip: &AnimationClip, node_count: usize) -> Result<Self, ClipError> {
        let mut tracks = Vec::with_capacity(clip.tracks().len());
        let mut times = Vec::new();
        let mut value_start = 0;
        for track in clip.tracks() {
            let node = track.node();
            if node >= node_count {
                return Err(ClipError::NodeOutOfBounds { node, node_count });
            }
            let (channel, interpolation, key_times): (Channel, Interpolation, Vec<f32>) =
                match track {
                    AnimationTrack::Translation { track, .. } => (
                        Channel::Translation,
                        track.interpolation,
                        track.frames().iter().map(|frame| frame.time).collect(),
                    ),
                    AnimationTrack::Scale { track, .. } => (
                        Channel::Scale,
                        track.interpolation,
                        track.frames().iter().map(|frame| frame.time).collect(),
                    ),
                    AnimationTrack::Rotation { track, .. } => (
                        Channel::Rotation,
                        track.interpolation,
                        track.frames().iter().map(|frame| frame.time).collect(),
                    ),
                };
            tracks.push(TrackDesc {
                node,
                channel,
                interpolation,
                key_start: times.len(),
                key_count: key_times.len(),
                value_start,
            });
            value_start += key_times.len() * channel.stride();
            times.extend_from_slice(&key_times);
        }
        Ok(Self {
            duration: clip.duration(),
            loop_mode: clip.loop_mode(),
            node_count,
            tracks,
            times,
        })
    }

    /// Same clip-time policy as the reference sampler.
    fn clip_time(&self, time: f32) -> Result<f32, ClipError> {
        if !time.is_finite() {
            return Err(ClipError::NonFiniteTime);
        }
        if self.duration <= EPSILON {
            return Ok(0.0);
        }
        Ok(match self.loop_mode {
            LoopMode::Clamp => time.clamp(0.0, self.duration),
            LoopMode::Repeat => time.rem_euclid(self.duration),
        })
    }

    fn check_pose(&self, pose: &[Transform]) -> Result<(), SamplerError> {
        if pose.len() != self.node_count {
            return Err(SamplerError::PoseLengthMismatch {
                expected: self.node_count,
                actual: pose.len(),
            });
        }
        Ok(())
    }

    fn check_cursor(&self, cursor: &SampleCursor) -> Result<(), SamplerError> {
        if cursor.segments.len() != self.tracks.len() {
            return Err(SamplerError::CursorMismatch {
                expected: self.tracks.len(),
                actual: cursor.segments.len(),
            });
        }
        Ok(())
    }

    /// Resolves the reference sampler's segment: before/at the first key and
    /// at/after the last key clamp; otherwise the segment `s` satisfies
    /// `times[s] < time <= times[s + 1]`.
    fn locate(&self, desc: &TrackDesc, time: f32, hint: &mut usize) -> KeyLocation {
        let times = &self.times[desc.key_start..desc.key_start + desc.key_count];
        let last = times.len() - 1;
        if time <= times[0] {
            return KeyLocation::Key(0);
        }
        if time >= times[last] {
            return KeyLocation::Key(last);
        }
        let contains =
            |segment: usize| segment < last && times[segment] < time && time <= times[segment + 1];
        let segment = if contains(*hint) {
            *hint
        } else if contains(*hint + 1) {
            *hint + 1
        } else {
            times.partition_point(|&key_time| key_time < time) - 1
        };
        *hint = segment;
        let start = times[segment];
        let end = times[segment + 1];
        KeyLocation::Segment {
            start: segment,
            factor: (time - start) / (end - start),
        }
    }

    fn sample<D: ValueDecoder>(
        &self,
        decoder: &D,
        time: f32,
        mut hints: Option<&mut [usize]>,
        pose: &mut [Transform],
    ) {
        for (index, desc) in self.tracks.iter().enumerate() {
            let mut scratch = 0;
            let hint = match hints.as_deref_mut() {
                Some(hints) => &mut hints[index],
                None => &mut scratch,
            };
            let location = self.locate(desc, time, hint);
            let transform = &mut pose[desc.node];
            match desc.channel {
                Channel::Translation => {
                    transform.translation =
                        interpolate_location(location, desc.interpolation, |key| {
                            decoder.vec3(index, desc, key)
                        });
                }
                Channel::Scale => {
                    transform.scale = interpolate_location(location, desc.interpolation, |key| {
                        decoder.vec3(index, desc, key)
                    });
                }
                Channel::Rotation => {
                    transform.rotation =
                        interpolate_location(location, desc.interpolation, |key| {
                            decoder.quat(index, desc, key)
                        });
                }
            }
        }
    }
}

fn interpolate_location<T: Interpolate>(
    location: KeyLocation,
    interpolation: Interpolation,
    value: impl Fn(usize) -> T,
) -> T {
    match location {
        KeyLocation::Key(key) => value(key),
        KeyLocation::Segment { start, factor } => {
            value(start).interpolate(value(start + 1), interpolation.map(factor))
        }
    }
}

trait ValueDecoder {
    fn vec3(&self, track: usize, desc: &TrackDesc, key: usize) -> Vec3;
    fn quat(&self, track: usize, desc: &TrackDesc, key: usize) -> Quat;
}

/// Per-instance key-lookup state for one compiled or quantized clip.
///
/// A cursor only accelerates lookup; it never changes the sampled result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SampleCursor {
    segments: Vec<usize>,
}

impl SampleCursor {
    /// Forgets the cached segments, e.g. after a large seek.
    pub fn reset(&mut self) {
        self.segments.fill(0);
    }
}

/// An [`AnimationClip`] resolved against a pose of `node_count` nodes with
/// exact `f32` key storage.
#[derive(Debug, Clone, PartialEq)]
pub struct CompiledClip {
    layout: ClipLayout,
    values: Vec<f32>,
}

impl CompiledClip {
    /// Pre-resolves every track against `node_count` pose nodes. Fails with
    /// [`ClipError::NodeOutOfBounds`] for the first track outside the pose.
    pub fn compile(clip: &AnimationClip, node_count: usize) -> Result<Self, ClipError> {
        let layout = ClipLayout::new(clip, node_count)?;
        let mut values = Vec::new();
        for track in clip.tracks() {
            match track {
                AnimationTrack::Translation { track, .. } | AnimationTrack::Scale { track, .. } => {
                    for frame in track.frames() {
                        values.extend_from_slice(&[frame.value.x, frame.value.y, frame.value.z]);
                    }
                }
                AnimationTrack::Rotation { track, .. } => {
                    for frame in track.frames() {
                        let q = frame.value;
                        values.extend_from_slice(&[q.x, q.y, q.z, q.w]);
                    }
                }
            }
        }
        Ok(Self { layout, values })
    }

    pub fn node_count(&self) -> usize {
        self.layout.node_count
    }

    pub fn track_count(&self) -> usize {
        self.layout.tracks.len()
    }

    pub fn duration(&self) -> f32 {
        self.layout.duration
    }

    /// Bytes held by key times and values (descriptors excluded).
    pub fn key_storage_bytes(&self) -> usize {
        self.layout.times.len() * size_of::<f32>() + self.values.len() * size_of::<f32>()
    }

    pub fn cursor(&self) -> SampleCursor {
        SampleCursor {
            segments: vec![0; self.layout.tracks.len()],
        }
    }

    /// Stateless sampling: binary-search key lookup per track.
    pub fn sample(&self, time: f32, pose: &mut [Transform]) -> Result<(), SamplerError> {
        self.layout.check_pose(pose)?;
        let time = self.layout.clip_time(time)?;
        self.layout.sample(self, time, None, pose);
        Ok(())
    }

    /// Cursor-accelerated sampling for monotonic or near-monotonic playback.
    pub fn sample_with_cursor(
        &self,
        time: f32,
        cursor: &mut SampleCursor,
        pose: &mut [Transform],
    ) -> Result<(), SamplerError> {
        self.layout.check_pose(pose)?;
        self.layout.check_cursor(cursor)?;
        let time = self.layout.clip_time(time)?;
        self.layout
            .sample(self, time, Some(&mut cursor.segments), pose);
        Ok(())
    }
}

impl ValueDecoder for CompiledClip {
    #[inline]
    fn vec3(&self, _track: usize, desc: &TrackDesc, key: usize) -> Vec3 {
        let offset = desc.value_start + key * 3;
        let v = &self.values[offset..offset + 3];
        Vec3::new(v[0], v[1], v[2])
    }

    #[inline]
    fn quat(&self, _track: usize, desc: &TrackDesc, key: usize) -> Quat {
        let offset = desc.value_start + key * 4;
        let v = &self.values[offset..offset + 4];
        Quat::new(v[0], v[1], v[2], v[3])
    }
}

/// Maximum decoded per-key error accepted by [`QuantizedClip::compress`].
///
/// Translation and scale errors are Euclidean distances in clip units;
/// rotation error is the angle in radians between the normalized source key
/// and its normalized decoded key.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct QuantizationBudget {
    pub translation: f32,
    pub rotation_radians: f32,
    pub scale: f32,
}

impl QuantizationBudget {
    pub const fn new(translation: f32, rotation_radians: f32, scale: f32) -> Self {
        Self {
            translation,
            rotation_radians,
            scale,
        }
    }

    fn is_valid(self) -> bool {
        [self.translation, self.rotation_radians, self.scale]
            .iter()
            .all(|value| value.is_finite() && *value > 0.0)
    }
}

/// Largest per-key error actually introduced by quantization.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct QuantizationError {
    pub translation: f32,
    pub rotation_radians: f32,
    pub scale: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum CompressionError {
    Clip(ClipError),
    InvalidBudget,
    NonFiniteValue {
        track: usize,
        key: usize,
    },
    DegenerateRotation {
        track: usize,
        key: usize,
    },
    /// Quantization flipped which hemisphere SLERP would pick between two keys.
    AmbiguousRotationHemisphere {
        track: usize,
        key: usize,
    },
    BudgetExceeded {
        track: usize,
        key: usize,
        channel: Channel,
        error: f32,
        budget: f32,
    },
}

impl fmt::Display for CompressionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Clip(error) => error.fmt(formatter),
            Self::InvalidBudget => {
                formatter.write_str("quantization budgets must be finite and positive")
            }
            Self::NonFiniteValue { track, key } => {
                write!(formatter, "track {track} key {key} has a non-finite value")
            }
            Self::DegenerateRotation { track, key } => {
                write!(
                    formatter,
                    "track {track} key {key} has a zero-length rotation"
                )
            }
            Self::AmbiguousRotationHemisphere { track, key } => write!(
                formatter,
                "quantizing track {track} changes the interpolation hemisphere after key {key}"
            ),
            Self::BudgetExceeded {
                track,
                key,
                channel,
                error,
                budget,
            } => write!(
                formatter,
                "track {track} key {key} {channel:?} error {error} exceeds budget {budget}"
            ),
        }
    }
}

impl std::error::Error for CompressionError {}

impl From<ClipError> for CompressionError {
    fn from(error: ClipError) -> Self {
        Self::Clip(error)
    }
}

/// Per-track dequantization: `value[i] = offset[i] + q as f32 * step[i]`.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Dequant {
    offset: [f32; 4],
    step: [f32; 4],
}

const QUANT_MAX: f32 = u16::MAX as f32;
const ROTATION_DEQUANT: Dequant = Dequant {
    offset: [-1.0; 4],
    step: [2.0 / QUANT_MAX; 4],
};

/// A compiled clip whose key values are stored as 16-bit integers.
///
/// Key times stay exact `f32`, so segment selection and interpolation factors
/// match the reference sampler. Translation and scale components are quantized
/// over each track's per-component range; rotation components over `[-1, 1]`
/// and decoded as unit quaternions.
#[derive(Debug, Clone, PartialEq)]
pub struct QuantizedClip {
    layout: ClipLayout,
    ranges: Vec<Dequant>,
    values: Vec<u16>,
    budget: QuantizationBudget,
    measured: QuantizationError,
}

impl QuantizedClip {
    pub fn compress(
        clip: &AnimationClip,
        node_count: usize,
        budget: QuantizationBudget,
    ) -> Result<Self, CompressionError> {
        if !budget.is_valid() {
            return Err(CompressionError::InvalidBudget);
        }
        let layout = ClipLayout::new(clip, node_count)?;
        let mut ranges = Vec::with_capacity(clip.tracks().len());
        let mut values = Vec::new();
        let mut measured = QuantizationError::default();
        for (track_index, track) in clip.tracks().iter().enumerate() {
            match track {
                AnimationTrack::Translation { track, .. } | AnimationTrack::Scale { track, .. } => {
                    let (channel, limit, slot) =
                        if matches!(track_kind(clip, track_index), Channel::Translation) {
                            (
                                Channel::Translation,
                                budget.translation,
                                &mut measured.translation,
                            )
                        } else {
                            (Channel::Scale, budget.scale, &mut measured.scale)
                        };
                    let keys: Vec<[f32; 3]> = track
                        .frames()
                        .iter()
                        .map(|frame| [frame.value.x, frame.value.y, frame.value.z])
                        .collect();
                    let range = vec3_range(&keys).ok_or_else(|| {
                        let key = keys
                            .iter()
                            .position(|key| key.iter().any(|c| !c.is_finite()))
                            .unwrap_or(0);
                        CompressionError::NonFiniteValue {
                            track: track_index,
                            key,
                        }
                    })?;
                    for (key_index, key) in keys.iter().enumerate() {
                        let mut squared = 0.0_f64;
                        for (component, &value) in key.iter().enumerate() {
                            let offset = range.offset[component];
                            let step = range.step[component];
                            let q = quantize(value, offset, step);
                            values.push(q);
                            let decoded = offset + f32::from(q) * step;
                            let delta = f64::from(decoded) - f64::from(value);
                            squared += delta * delta;
                        }
                        let error = squared.sqrt() as f32;
                        if error > limit {
                            return Err(CompressionError::BudgetExceeded {
                                track: track_index,
                                key: key_index,
                                channel,
                                error,
                                budget: limit,
                            });
                        }
                        *slot = slot.max(error);
                    }
                    ranges.push(range);
                }
                AnimationTrack::Rotation { track, .. } => {
                    let mut previous: Option<(Quat, Quat)> = None;
                    for (key_index, frame) in track.frames().iter().enumerate() {
                        let source = frame.value;
                        if ![source.x, source.y, source.z, source.w]
                            .iter()
                            .all(|c| c.is_finite())
                        {
                            return Err(CompressionError::NonFiniteValue {
                                track: track_index,
                                key: key_index,
                            });
                        }
                        let source =
                            source
                                .normalized()
                                .ok_or(CompressionError::DegenerateRotation {
                                    track: track_index,
                                    key: key_index,
                                })?;
                        let encoded = [source.x, source.y, source.z, source.w].map(|c| {
                            quantize(c, ROTATION_DEQUANT.offset[0], ROTATION_DEQUANT.step[0])
                        });
                        let decoded = decode_rotation(&encoded);
                        let error = rotation_angle(source, decoded);
                        if error > budget.rotation_radians {
                            return Err(CompressionError::BudgetExceeded {
                                track: track_index,
                                key: key_index,
                                channel: Channel::Rotation,
                                error,
                                budget: budget.rotation_radians,
                            });
                        }
                        if let Some((previous_source, previous_decoded)) = previous
                            && (previous_source.dot(source) < 0.0)
                                != (previous_decoded.dot(decoded) < 0.0)
                        {
                            return Err(CompressionError::AmbiguousRotationHemisphere {
                                track: track_index,
                                key: key_index - 1,
                            });
                        }
                        previous = Some((source, decoded));
                        measured.rotation_radians = measured.rotation_radians.max(error);
                        values.extend_from_slice(&encoded);
                    }
                    ranges.push(ROTATION_DEQUANT);
                }
            }
        }
        Ok(Self {
            layout,
            ranges,
            values,
            budget,
            measured,
        })
    }

    pub fn node_count(&self) -> usize {
        self.layout.node_count
    }

    pub fn track_count(&self) -> usize {
        self.layout.tracks.len()
    }

    pub fn duration(&self) -> f32 {
        self.layout.duration
    }

    pub fn budget(&self) -> QuantizationBudget {
        self.budget
    }

    /// Largest per-key error measured during compression (always within budget).
    pub fn measured_error(&self) -> QuantizationError {
        self.measured
    }

    /// Bytes held by key times, quantized values, and per-track ranges.
    pub fn key_storage_bytes(&self) -> usize {
        self.layout.times.len() * size_of::<f32>()
            + self.values.len() * size_of::<u16>()
            + self.ranges.len() * size_of::<Dequant>()
    }

    pub fn cursor(&self) -> SampleCursor {
        SampleCursor {
            segments: vec![0; self.layout.tracks.len()],
        }
    }

    pub fn sample(&self, time: f32, pose: &mut [Transform]) -> Result<(), SamplerError> {
        self.layout.check_pose(pose)?;
        let time = self.layout.clip_time(time)?;
        self.layout.sample(self, time, None, pose);
        Ok(())
    }

    pub fn sample_with_cursor(
        &self,
        time: f32,
        cursor: &mut SampleCursor,
        pose: &mut [Transform],
    ) -> Result<(), SamplerError> {
        self.layout.check_pose(pose)?;
        self.layout.check_cursor(cursor)?;
        let time = self.layout.clip_time(time)?;
        self.layout
            .sample(self, time, Some(&mut cursor.segments), pose);
        Ok(())
    }
}

impl ValueDecoder for QuantizedClip {
    #[inline]
    fn vec3(&self, track: usize, desc: &TrackDesc, key: usize) -> Vec3 {
        let offset = desc.value_start + key * 3;
        let q = &self.values[offset..offset + 3];
        let range = &self.ranges[track];
        Vec3::new(
            range.offset[0] + f32::from(q[0]) * range.step[0],
            range.offset[1] + f32::from(q[1]) * range.step[1],
            range.offset[2] + f32::from(q[2]) * range.step[2],
        )
    }

    #[inline]
    fn quat(&self, _track: usize, desc: &TrackDesc, key: usize) -> Quat {
        let offset = desc.value_start + key * 4;
        let q = &self.values[offset..offset + 4];
        decode_rotation(&[q[0], q[1], q[2], q[3]])
    }
}

fn vec3_range(keys: &[[f32; 3]]) -> Option<Dequant> {
    let mut offset = [0.0; 4];
    let mut step = [0.0; 4];
    for component in 0..3 {
        let mut min = f32::INFINITY;
        let mut max = f32::NEG_INFINITY;
        for key in keys {
            let value = key[component];
            if !value.is_finite() {
                return None;
            }
            min = min.min(value);
            max = max.max(value);
        }
        let span = max - min;
        if !span.is_finite() {
            return None;
        }
        offset[component] = min;
        step[component] = span / QUANT_MAX;
    }
    Some(Dequant { offset, step })
}

fn quantize(value: f32, offset: f32, step: f32) -> u16 {
    if step <= 0.0 {
        return 0;
    }
    ((value - offset) / step).round().clamp(0.0, QUANT_MAX) as u16
}

fn decode_rotation(q: &[u16; 4]) -> Quat {
    let c = |index: usize| {
        ROTATION_DEQUANT.offset[index] + f32::from(q[index]) * ROTATION_DEQUANT.step[index]
    };
    Quat::new(c(0), c(1), c(2), c(3))
        .normalized()
        .unwrap_or(Quat::IDENTITY)
}

fn track_kind(clip: &AnimationClip, track: usize) -> Channel {
    match clip.tracks()[track] {
        AnimationTrack::Translation { .. } => Channel::Translation,
        AnimationTrack::Rotation { .. } => Channel::Rotation,
        AnimationTrack::Scale { .. } => Channel::Scale,
    }
}

/// Rotation angle in radians between two orientations, insensitive to
/// quaternion sign. Evaluated in `f64` with the numerically robust
/// `4 * atan2(|a - b|, |a + b|)` form so small errors are not swamped by
/// `acos` rounding near 1.
pub fn rotation_angle(left: Quat, right: Quat) -> f32 {
    let unit = |q: Quat| {
        let v = [q.x, q.y, q.z, q.w].map(f64::from);
        let length = v.iter().map(|c| c * c).sum::<f64>().sqrt();
        if length > f64::from(EPSILON) {
            v.map(|c| c / length)
        } else {
            [0.0, 0.0, 0.0, 1.0]
        }
    };
    let a = unit(left);
    let mut b = unit(right);
    if a.iter().zip(&b).map(|(x, y)| x * y).sum::<f64>() < 0.0 {
        b = b.map(|c| -c);
    }
    let norm = |sign: f64| {
        a.iter()
            .zip(&b)
            .map(|(x, y)| (x + sign * y) * (x + sign * y))
            .sum::<f64>()
            .sqrt()
    };
    (4.0 * norm(-1.0).atan2(norm(1.0))) as f32
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Keyframe, KeyframeTrack};

    const NODES: usize = 6;

    fn vec3_track(keys: &[(f32, Vec3)], interpolation: Interpolation) -> KeyframeTrack<Vec3> {
        KeyframeTrack::new(
            keys.iter()
                .map(|&(time, value)| Keyframe { time, value })
                .collect(),
            interpolation,
        )
        .unwrap()
    }

    fn quat_track(keys: &[(f32, Quat)], interpolation: Interpolation) -> KeyframeTrack<Quat> {
        KeyframeTrack::new(
            keys.iter()
                .map(|&(time, value)| Keyframe { time, value })
                .collect(),
            interpolation,
        )
        .unwrap()
    }

    /// Mixed channels, interpolation modes, key counts, uneven key spacing,
    /// a single-key track, a non-unit rotation key, and a hemisphere flip.
    fn fixture_clip(loop_mode: LoopMode) -> AnimationClip {
        let mut tracks = vec![
            AnimationTrack::Translation {
                node: 0,
                track: vec3_track(
                    &[
                        (0.0, Vec3::new(0.0, 0.0, 0.0)),
                        (0.13, Vec3::new(1.5, -0.25, 3.0)),
                        (0.4, Vec3::new(-2.0, 0.75, 0.5)),
                        (1.1, Vec3::new(0.3, 4.0, -1.0)),
                        (2.0, Vec3::new(0.0, 0.0, 0.0)),
                    ],
                    Interpolation::Linear,
                ),
            },
            AnimationTrack::Rotation {
                node: 1,
                track: quat_track(
                    &[
                        (0.0, Quat::IDENTITY),
                        (0.5, Quat::from_euler_xyz(0.7, -0.2, 0.1)),
                        (0.9, Quat::from_euler_xyz(0.7, -0.2, 0.1).scaled(-1.0)),
                        (1.6, Quat::from_euler_xyz(-1.2, 2.1, 0.4)),
                        (1.8, Quat::new(0.0, 0.0, 0.5, 0.5)),
                    ],
                    Interpolation::Linear,
                ),
            },
            AnimationTrack::Scale {
                node: 2,
                track: vec3_track(
                    &[
                        (0.25, Vec3::new(1.0, 1.0, 1.0)),
                        (1.0, Vec3::new(2.0, 0.5, 1.25)),
                    ],
                    Interpolation::SmoothStep,
                ),
            },
            AnimationTrack::Translation {
                node: 3,
                track: vec3_track(
                    &[
                        (0.0, Vec3::new(0.0, 1.0, 0.0)),
                        (0.3, Vec3::new(0.0, 2.0, 0.0)),
                        (0.6, Vec3::new(0.0, 3.0, 0.0)),
                    ],
                    Interpolation::Step,
                ),
            },
            AnimationTrack::Rotation {
                node: 3,
                track: quat_track(
                    &[(0.7, Quat::from_euler_xyz(0.0, 0.3, 0.0))],
                    Interpolation::Linear,
                ),
            },
        ];
        // Many uneven keys exercise binary search and cursor jumps.
        let many: Vec<(f32, Quat)> = (0..40)
            .map(|index| {
                let time = index as f32 * 0.05 + (index % 3) as f32 * 0.01;
                (time, Quat::from_euler_xyz(index as f32 * 0.21, 0.4, -0.1))
            })
            .collect();
        tracks.push(AnimationTrack::Rotation {
            node: 4,
            track: quat_track(&many, Interpolation::SmoothStep),
        });
        AnimationClip::new("fixture", tracks)
            .unwrap()
            .with_loop_mode(loop_mode)
    }

    fn base_pose() -> Vec<Transform> {
        (0..NODES)
            .map(|node| Transform {
                translation: Vec3::new(node as f32, 0.5, -1.0),
                rotation: Quat::from_euler_xyz(0.1 * node as f32, 0.0, 0.0),
                scale: Vec3::new(1.0, 2.0, 3.0),
            })
            .collect()
    }

    fn bits(pose: &[Transform]) -> Vec<u32> {
        pose.iter()
            .flat_map(|t| {
                [
                    t.translation.x,
                    t.translation.y,
                    t.translation.z,
                    t.rotation.x,
                    t.rotation.y,
                    t.rotation.z,
                    t.rotation.w,
                    t.scale.x,
                    t.scale.y,
                    t.scale.z,
                ]
            })
            .map(f32::to_bits)
            .collect()
    }

    fn sample_times() -> Vec<f32> {
        let mut times: Vec<f32> = (-50..=500).map(|step| step as f32 * 0.0071).collect();
        // Exact key times, the loop boundary, and large/negative wraps.
        times.extend([
            0.0, 0.13, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 1.0, 1.1, 1.6, 1.8, 2.0, 2.0001, -2.0,
            37.25, -13.9,
        ]);
        times
    }

    fn pseudo_random_times(count: usize) -> Vec<f32> {
        let mut state = 0x2545_f491_u32;
        (0..count)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (state >> 8) as f32 / (1u32 << 24) as f32 * 5.0 - 1.5
            })
            .collect()
    }

    #[test]
    fn compiled_sampler_matches_reference_bit_for_bit() {
        for loop_mode in [LoopMode::Clamp, LoopMode::Repeat] {
            let clip = fixture_clip(loop_mode);
            let compiled = CompiledClip::compile(&clip, NODES).unwrap();
            let mut cursor = compiled.cursor();
            let forward = sample_times();
            let mut backward = forward.clone();
            backward.reverse();
            let random = pseudo_random_times(2_000);
            for times in [&forward, &backward, &random] {
                for &time in times.iter() {
                    let mut expected = base_pose();
                    clip.sample(time, &mut expected).unwrap();

                    let mut stateless = base_pose();
                    compiled.sample(time, &mut stateless).unwrap();
                    assert_eq!(bits(&stateless), bits(&expected), "time {time}");

                    let mut cursored = base_pose();
                    compiled
                        .sample_with_cursor(time, &mut cursor, &mut cursored)
                        .unwrap();
                    assert_eq!(bits(&cursored), bits(&expected), "time {time}");
                }
            }
        }
    }

    #[test]
    fn compiled_sampler_reuses_caller_pose_storage() {
        let clip = fixture_clip(LoopMode::Repeat);
        let compiled = CompiledClip::compile(&clip, NODES).unwrap();
        let mut cursor = compiled.cursor();
        let mut pose = base_pose();
        let pointer = pose.as_ptr();
        for time in sample_times() {
            compiled
                .sample_with_cursor(time, &mut cursor, &mut pose)
                .unwrap();
        }
        assert_eq!(pose.as_ptr(), pointer);
        assert_eq!(pose.len(), NODES);
    }

    #[test]
    fn compiled_sampler_fails_closed() {
        let clip = fixture_clip(LoopMode::Clamp);
        assert_eq!(
            CompiledClip::compile(&clip, 4),
            Err(ClipError::NodeOutOfBounds {
                node: 4,
                node_count: 4
            })
        );
        let compiled = CompiledClip::compile(&clip, NODES).unwrap();
        let mut short = vec![Transform::IDENTITY; NODES - 1];
        assert_eq!(
            compiled.sample(0.5, &mut short),
            Err(SamplerError::PoseLengthMismatch {
                expected: NODES,
                actual: NODES - 1
            })
        );
        let mut pose = base_pose();
        assert_eq!(
            compiled.sample(f32::NAN, &mut pose),
            Err(SamplerError::Clip(ClipError::NonFiniteTime))
        );
        let other = CompiledClip::compile(
            &AnimationClip::new(
                "one",
                vec![AnimationTrack::Scale {
                    node: 0,
                    track: vec3_track(&[(0.0, Vec3::ZERO)], Interpolation::Step),
                }],
            )
            .unwrap(),
            NODES,
        )
        .unwrap();
        let mut foreign = other.cursor();
        assert_eq!(
            compiled.sample_with_cursor(0.5, &mut foreign, &mut pose),
            Err(SamplerError::CursorMismatch {
                expected: compiled.track_count(),
                actual: 1
            })
        );
    }

    const BUDGET: QuantizationBudget = QuantizationBudget::new(1.0e-3, 1.0e-3, 1.0e-4);

    #[test]
    fn quantized_keys_stay_within_explicit_budget() {
        let clip = fixture_clip(LoopMode::Repeat);
        let quantized = QuantizedClip::compress(&clip, NODES, BUDGET).unwrap();
        let measured = quantized.measured_error();
        assert!(measured.translation <= BUDGET.translation);
        assert!(measured.rotation_radians <= BUDGET.rotation_radians);
        assert!(measured.scale <= BUDGET.scale);
        // 16-bit storage actually quantizes: errors are non-zero but tiny.
        assert!(measured.translation > 0.0);
        assert!(measured.rotation_radians > 0.0);
        assert!(
            quantized.key_storage_bytes()
                < CompiledClip::compile(&clip, NODES)
                    .unwrap()
                    .key_storage_bytes()
        );
    }

    #[test]
    fn quantized_sampling_error_is_bounded_by_budget() {
        // Sampled values are convex (vector) or geodesic (rotation)
        // interpolations of decoded keys, so the key budget bounds the sampled
        // error up to float rounding.
        const VECTOR_SLACK: f32 = 1.0e-5;
        const ROTATION_SLACK: f32 = 1.0e-4;
        for loop_mode in [LoopMode::Clamp, LoopMode::Repeat] {
            let clip = fixture_clip(loop_mode);
            let quantized = QuantizedClip::compress(&clip, NODES, BUDGET).unwrap();
            let mut cursor = quantized.cursor();
            let mut times = sample_times();
            times.extend(pseudo_random_times(2_000));
            for time in times {
                let mut expected = base_pose();
                clip.sample(time, &mut expected).unwrap();
                let mut stateless = base_pose();
                quantized.sample(time, &mut stateless).unwrap();
                let mut cursored = base_pose();
                quantized
                    .sample_with_cursor(time, &mut cursor, &mut cursored)
                    .unwrap();
                assert_eq!(bits(&stateless), bits(&cursored), "time {time}");
                for (node, (actual, reference)) in stateless.iter().zip(&expected).enumerate() {
                    let translation = (actual.translation - reference.translation).length();
                    let scale = (actual.scale - reference.scale).length();
                    let rotation = rotation_angle(actual.rotation, reference.rotation);
                    assert!(
                        translation <= BUDGET.translation + VECTOR_SLACK,
                        "node {node} time {time} translation error {translation}"
                    );
                    assert!(
                        scale <= BUDGET.scale + VECTOR_SLACK,
                        "node {node} time {time} scale error {scale}"
                    );
                    assert!(
                        rotation <= BUDGET.rotation_radians + ROTATION_SLACK,
                        "node {node} time {time} rotation error {rotation}"
                    );
                }
            }
        }
    }

    #[test]
    fn compression_fails_closed() {
        let clip = fixture_clip(LoopMode::Clamp);
        assert_eq!(
            QuantizedClip::compress(&clip, NODES, QuantizationBudget::new(0.0, 1.0, 1.0)),
            Err(CompressionError::InvalidBudget)
        );
        assert_eq!(
            QuantizedClip::compress(&clip, NODES, QuantizationBudget::new(f32::NAN, 1.0, 1.0)),
            Err(CompressionError::InvalidBudget)
        );
        assert!(matches!(
            QuantizedClip::compress(&clip, NODES, QuantizationBudget::new(1.0e-7, 1.0, 1.0)),
            Err(CompressionError::BudgetExceeded {
                track: 0,
                channel: Channel::Translation,
                ..
            })
        ));
        assert!(matches!(
            QuantizedClip::compress(&clip, NODES, QuantizationBudget::new(1.0, 1.0e-7, 1.0)),
            Err(CompressionError::BudgetExceeded {
                channel: Channel::Rotation,
                ..
            })
        ));
        assert_eq!(
            QuantizedClip::compress(&clip, 2, BUDGET),
            Err(CompressionError::Clip(ClipError::NodeOutOfBounds {
                node: 2,
                node_count: 2
            }))
        );

        let non_finite = AnimationClip::new(
            "nan",
            vec![AnimationTrack::Translation {
                node: 0,
                track: vec3_track(
                    &[(0.0, Vec3::ZERO), (1.0, Vec3::new(f32::INFINITY, 0.0, 0.0))],
                    Interpolation::Linear,
                ),
            }],
        )
        .unwrap();
        assert_eq!(
            QuantizedClip::compress(&non_finite, 1, BUDGET),
            Err(CompressionError::NonFiniteValue { track: 0, key: 1 })
        );

        let degenerate = AnimationClip::new(
            "zero",
            vec![AnimationTrack::Rotation {
                node: 0,
                track: quat_track(
                    &[(0.0, Quat::new(0.0, 0.0, 0.0, 0.0))],
                    Interpolation::Linear,
                ),
            }],
        )
        .unwrap();
        assert_eq!(
            QuantizedClip::compress(&degenerate, 1, BUDGET),
            Err(CompressionError::DegenerateRotation { track: 0, key: 0 })
        );
    }

    #[test]
    fn rotation_angle_resolves_small_angles_and_ignores_sign() {
        let small = Quat::from_axis_angle(Vec3::new(0.0, 1.0, 0.0), 1.0e-5).unwrap();
        let angle = rotation_angle(Quat::IDENTITY, small);
        assert!((angle - 1.0e-5).abs() < 1.0e-7, "{angle}");
        let half = Quat::from_axis_angle(Vec3::new(1.0, 0.0, 0.0), 1.0).unwrap();
        assert!((rotation_angle(half, half.scaled(-1.0))).abs() < 1.0e-7);
        assert!((rotation_angle(Quat::IDENTITY, half) - 1.0).abs() < 1.0e-6);
    }
}
