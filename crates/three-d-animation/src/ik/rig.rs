use crate::Skeleton;

use super::IkError;

/// Parent topology the solver uses to refresh world transforms.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IkRig {
    pub(super) parents: Vec<Option<usize>>,
}

impl IkRig {
    pub fn new(parents: Vec<Option<usize>>) -> Result<Self, IkError> {
        for (node, parent) in parents.iter().enumerate() {
            if let Some(parent) = *parent
                && parent >= node
            {
                return Err(IkError::ParentMustPrecedeChild { node, parent });
            }
        }
        Ok(Self { parents })
    }

    /// Reuses the already validated joint topology of a [`Skeleton`].
    pub fn from_skeleton(skeleton: &Skeleton) -> Self {
        Self {
            parents: skeleton.joints().iter().map(|joint| joint.parent).collect(),
        }
    }

    pub fn node_count(&self) -> usize {
        self.parents.len()
    }

    pub fn parent(&self, node: usize) -> Option<usize> {
        self.parents.get(node).copied().flatten()
    }

    pub(super) fn check(&self, joint: usize) -> Result<(), IkError> {
        if joint < self.parents.len() {
            Ok(())
        } else {
            Err(IkError::JointOutOfBounds {
                joint,
                node_count: self.parents.len(),
            })
        }
    }

    pub(super) fn require_descendant(&self, ancestor: usize, joint: usize) -> Result<(), IkError> {
        let mut current = self.parent(joint);
        while let Some(node) = current {
            if node == ancestor {
                return Ok(());
            }
            current = self.parent(node);
        }
        Err(IkError::NotDescendant { ancestor, joint })
    }
}
