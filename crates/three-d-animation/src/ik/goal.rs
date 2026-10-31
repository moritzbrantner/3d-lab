use three_d_core::Vec3;

use crate::Quat;
use crate::retarget::finite_vec3;

use super::rig::IkRig;
use super::{IkError, MAX_LOOK_AT_JOINTS};

/// A root → mid → tip chain such as upper leg → lower leg → foot. Helper or
/// twist joints may sit between the three; they stay rigid relative to their
/// semantic parent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TwoBoneChain {
    pub(super) root: usize,
    pub(super) mid: usize,
    pub(super) tip: usize,
}

impl TwoBoneChain {
    pub fn new(rig: &IkRig, root: usize, mid: usize, tip: usize) -> Result<Self, IkError> {
        rig.check(root)?;
        rig.check(mid)?;
        rig.check(tip)?;
        rig.require_descendant(root, mid)?;
        rig.require_descendant(mid, tip)?;
        Ok(Self { root, mid, tip })
    }

    pub fn root(self) -> usize {
        self.root
    }

    pub fn mid(self) -> usize {
        self.mid
    }

    pub fn tip(self) -> usize {
        self.tip
    }
}

/// How the tip joint is oriented after its position is solved.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum EndEffector {
    /// Keep the tip's local rotation from the incoming pose.
    KeepLocal,
    /// Set the tip's character-space rotation (hand grips).
    Orientation(Quat),
    /// Rotate the tip minimally so `local_axis` points along
    /// `direction` in character space (foot up axis to a ground normal).
    AlignAxis { local_axis: Vec3, direction: Vec3 },
}

/// Two-bone limb goal with explicit character-space target and pole.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LimbGoal {
    pub chain: TwoBoneChain,
    pub target: Vec3,
    /// Point the mid joint (knee/elbow) bends toward. `None` keeps the
    /// incoming bend plane.
    pub pole: Option<Vec3>,
    /// Fraction of the full chain length usable as reach, in `(0, 1]`.
    /// Values slightly below one avoid snapping into a locked limb. The minimum
    /// `|upper - lower| / (upper + lower)` for the current pose is inclusive:
    /// fractions within [`MIN_REACH_FRACTION_TOLERANCE`](super::MIN_REACH_FRACTION_TOLERANCE)
    /// below it solve at the
    /// minimum reach, and smaller fractions are rejected with
    /// `IkError::ReachBelowMinimum`.
    pub max_reach: f32,
    pub end: EndEffector,
}

impl LimbGoal {
    pub fn new(chain: TwoBoneChain, target: Vec3) -> Self {
        Self {
            chain,
            target,
            pole: None,
            max_reach: 1.0,
            end: EndEffector::KeepLocal,
        }
    }

    /// Foot placement: the ankle reaches `contact` and `foot_up` (foot-local)
    /// aligns with the supplied ground `normal`.
    pub fn foot(chain: TwoBoneChain, contact: Vec3, normal: Vec3, foot_up: Vec3) -> Self {
        Self {
            end: EndEffector::AlignAxis {
                local_axis: foot_up,
                direction: normal,
            },
            ..Self::new(chain, contact)
        }
    }

    /// Hand placement: the wrist reaches `position` with the given
    /// character-space grip `orientation` when one is supplied.
    pub fn hand(chain: TwoBoneChain, position: Vec3, orientation: Option<Quat>) -> Self {
        Self {
            end: orientation.map_or(EndEffector::KeepLocal, EndEffector::Orientation),
            ..Self::new(chain, position)
        }
    }

    pub fn with_pole(mut self, pole: Vec3) -> Self {
        self.pole = Some(pole);
        self
    }

    pub fn with_max_reach(mut self, max_reach: f32) -> Self {
        self.max_reach = max_reach;
        self
    }
}

/// Ordered look-at chain, for example spine → neck → head. Each joint takes
/// its weight's share of the remaining rotation; the last joint carries the
/// aim axis.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LookAtChain {
    pub(super) joints: [usize; MAX_LOOK_AT_JOINTS],
    pub(super) weights: [f32; MAX_LOOK_AT_JOINTS],
    pub(super) len: usize,
    pub(super) forward: Vec3,
}

impl LookAtChain {
    /// `joints` are ordered from ancestor to aim joint with per-joint weights
    /// in `[0, 1]`. `forward` is the aim axis in the aim joint's local space.
    pub fn new(rig: &IkRig, joints: &[(usize, f32)], forward: Vec3) -> Result<Self, IkError> {
        if joints.is_empty() {
            return Err(IkError::EmptyLookAtChain);
        }
        if joints.len() > MAX_LOOK_AT_JOINTS {
            return Err(IkError::LookAtChainTooLong {
                len: joints.len(),
                max: MAX_LOOK_AT_JOINTS,
            });
        }
        let forward = forward
            .normalized()
            .filter(|value| finite_vec3(*value))
            .ok_or(IkError::InvalidChainParameter)?;
        let mut chain = Self {
            joints: [0; MAX_LOOK_AT_JOINTS],
            weights: [0.0; MAX_LOOK_AT_JOINTS],
            len: joints.len(),
            forward,
        };
        for (index, &(joint, weight)) in joints.iter().enumerate() {
            rig.check(joint)?;
            if !weight.is_finite() || !(0.0..=1.0).contains(&weight) {
                return Err(IkError::InvalidChainParameter);
            }
            if index > 0 {
                rig.require_descendant(chain.joints[index - 1], joint)?;
            }
            chain.joints[index] = joint;
            chain.weights[index] = weight;
        }
        Ok(chain)
    }

    pub fn joints(&self) -> &[usize] {
        &self.joints[..self.len]
    }

    pub(super) fn aim_joint(&self) -> usize {
        self.joints[self.len - 1]
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LookAtGoal {
    pub chain: LookAtChain,
    pub target: Vec3,
    /// Maximum total deviation from the incoming aim direction, in radians.
    /// It bounds every weighted step and the final aim after the layer
    /// weight and joint mask are applied.
    pub max_angle: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum IkGoal {
    Limb(LimbGoal),
    LookAt(LookAtGoal),
}

/// Per-joint layer weights in `[0, 1]`. Joints default to the value supplied
/// at construction.
#[derive(Debug, Clone, PartialEq)]
pub struct JointMask {
    pub(super) weights: Vec<f32>,
}

impl JointMask {
    pub fn new(node_count: usize, default_weight: f32) -> Result<Self, IkError> {
        if !default_weight.is_finite() || !(0.0..=1.0).contains(&default_weight) {
            return Err(IkError::InvalidMaskWeight { joint: 0 });
        }
        Ok(Self {
            weights: vec![default_weight; node_count],
        })
    }

    pub fn set(&mut self, joint: usize, weight: f32) -> Result<(), IkError> {
        if !weight.is_finite() || !(0.0..=1.0).contains(&weight) {
            return Err(IkError::InvalidMaskWeight { joint });
        }
        let node_count = self.weights.len();
        let slot = self
            .weights
            .get_mut(joint)
            .ok_or(IkError::JointOutOfBounds { joint, node_count })?;
        *slot = weight;
        Ok(())
    }

    pub fn weight(&self, joint: usize) -> f32 {
        self.weights.get(joint).copied().unwrap_or(0.0)
    }
}

/// One weighted correction layer. Layers are solved in slice order; each
/// sees the pose produced by the layers before it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct IkLayer<'a> {
    pub goal: IkGoal,
    pub weight: f32,
    pub mask: Option<&'a JointMask>,
}

impl<'a> IkLayer<'a> {
    pub fn new(goal: IkGoal, weight: f32) -> Self {
        Self {
            goal,
            weight,
            mask: None,
        }
    }

    pub fn with_mask(mut self, mask: &'a JointMask) -> Self {
        self.mask = Some(mask);
        self
    }
}
