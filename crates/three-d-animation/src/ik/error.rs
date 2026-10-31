use core::fmt;

#[derive(Debug, Clone, PartialEq)]
pub enum IkError {
    ParentMustPrecedeChild {
        node: usize,
        parent: usize,
    },
    JointOutOfBounds {
        joint: usize,
        node_count: usize,
    },
    NotDescendant {
        ancestor: usize,
        joint: usize,
    },
    EmptyLookAtChain,
    LookAtChainTooLong {
        len: usize,
        max: usize,
    },
    InvalidChainParameter,
    InvalidMaskWeight {
        joint: usize,
    },
    PoseLengthMismatch {
        expected: usize,
        actual: usize,
    },
    MaskLengthMismatch {
        layer: usize,
        expected: usize,
        actual: usize,
    },
    TooManyLayers {
        count: usize,
        max: usize,
    },
    InvalidLayerWeight {
        layer: usize,
    },
    InvalidTarget {
        layer: usize,
    },
    DegenerateLimb {
        layer: usize,
    },
    /// `max_reach` leaves less reach than the limb's minimum `|upper - lower|`
    /// in the current pose, so no reach interval exists.
    ReachBelowMinimum {
        layer: usize,
    },
    /// A base-pose transform has a non-finite translation, rotation, or scale.
    NonFiniteBasePose {
        node: usize,
    },
    /// Finite local transforms composed to a non-finite world position for a
    /// joint this layer solves (for example an overflowing scale chain).
    NonFiniteWorldPose {
        layer: usize,
    },
}

impl fmt::Display for IkError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::ParentMustPrecedeChild { node, parent } => write!(
                formatter,
                "IK node {node} references parent {parent}; parents must appear before children"
            ),
            Self::JointOutOfBounds { joint, node_count } => write!(
                formatter,
                "IK joint {joint} is outside a rig with {node_count} nodes"
            ),
            Self::NotDescendant { ancestor, joint } => write!(
                formatter,
                "IK joint {joint} must be a descendant of joint {ancestor}"
            ),
            Self::EmptyLookAtChain => formatter.write_str("look-at chain needs at least one joint"),
            Self::LookAtChainTooLong { len, max } => write!(
                formatter,
                "look-at chain has {len} joints; at most {max} are supported"
            ),
            Self::InvalidChainParameter => formatter.write_str(
                "IK chain axes must be finite non-zero vectors and weights/angles finite and in range",
            ),
            Self::InvalidMaskWeight { joint } => write!(
                formatter,
                "IK mask weight for joint {joint} must be finite and between 0 and 1"
            ),
            Self::PoseLengthMismatch { expected, actual } => write!(
                formatter,
                "IK pose length mismatch: expected {expected}, got {actual}"
            ),
            Self::MaskLengthMismatch {
                layer,
                expected,
                actual,
            } => write!(
                formatter,
                "IK layer {layer} mask covers {actual} joints; rig has {expected}"
            ),
            Self::TooManyLayers { count, max } => {
                write!(formatter, "IK solve received {count} layers; at most {max} are supported")
            }
            Self::InvalidLayerWeight { layer } => write!(
                formatter,
                "IK layer {layer} weight must be finite and between 0 and 1"
            ),
            Self::InvalidTarget { layer } => write!(
                formatter,
                "IK layer {layer} target, pole, or orientation must be finite"
            ),
            Self::DegenerateLimb { layer } => write!(
                formatter,
                "IK layer {layer} limb has a zero-length bone in the current pose"
            ),
            Self::ReachBelowMinimum { layer } => write!(
                formatter,
                "IK layer {layer} max_reach is below the limb's minimum reach |upper - lower| in the current pose"
            ),
            Self::NonFiniteBasePose { node } => write!(
                formatter,
                "IK base pose transform for node {node} must be finite"
            ),
            Self::NonFiniteWorldPose { layer } => write!(
                formatter,
                "IK layer {layer} joints compose to a non-finite world position"
            ),
        }
    }
}

impl std::error::Error for IkError {}
