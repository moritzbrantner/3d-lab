//! Thin retained-resource adapter; all clip, hierarchy and playback semantics stay in Rust.
mod ik;
use ik::IkLayers;
use std::rc::Rc;
use three_d_animation::ik::{IkRig, IkWorkspace};
use three_d_animation::{ClipBlendWorkspace, Transform};
use three_d_formats::{ImportedCharacter, load_gltf_imported_character};
use three_d_playback::{CrossFade, PlaybackClock, TransitionClock, TransitionCurve};
use wasm_bindgen::prelude::*;
fn error(value: impl ToString) -> JsValue {
    JsValue::from_str(&value.to_string())
}

#[wasm_bindgen]
pub struct CharacterAsset {
    data: Rc<ImportedCharacter>,
}
#[wasm_bindgen]
impl CharacterAsset {
    #[wasm_bindgen(constructor)]
    pub fn new(bytes: &[u8]) -> Result<CharacterAsset, JsValue> {
        Ok(Self {
            data: Rc::new(load_gltf_imported_character(bytes).map_err(error)?),
        })
    }
    pub fn metadata_json(&self) -> String {
        serde_json::json!({ "sourceNodes": self.data.source_nodes, "nodeNames": self.data.node_names,
            "skinNodes": self.data.skin_nodes, "meshNodes": self.data.mesh_nodes,
            "primitives": self.data.primitives.iter().map(|p| serde_json::json!({"node": p.node, "mesh": p.mesh, "primitive": p.primitive})).collect::<Vec<_>>(),
            "primitiveIndices": self.data.primitive_indices, "gpuSkinIndices": self.data.gpu_skin_indices,
            "inverseBinds": self.data.inverse_binds.iter().map(|m| m.elements).collect::<Vec<_>>(),
            "clips": self.data.rig.animations().iter().map(|c| serde_json::json!({"name":c.name(),"duration":c.duration()})).collect::<Vec<_>>() }).to_string()
    }
    pub fn create_instance(&self) -> CharacterInstance {
        let pose: Vec<Transform> = self.data.nodes.iter().map(|n| n.local).collect();
        // Canonical nodes are ordered parents-first by the importer.
        let rig = IkRig::new(self.data.nodes.iter().map(|n| n.parent).collect())
            .expect("imported canonical nodes are parent-ordered");
        let mut workspace = IkWorkspace::new(pose.len());
        let mut corrected = pose.clone();
        workspace
            .solve(&rig, &pose, &[], &mut corrected)
            .expect("rest pose is finite");
        CharacterInstance {
            data: Rc::clone(&self.data),
            base: pose,
            pose: corrected,
            playback: None,
            fade: None,
            rig,
            ik: IkLayers::default(),
            workspace,
        }
    }
}
#[wasm_bindgen]
pub struct CharacterInstance {
    data: Rc<ImportedCharacter>,
    /// Sampled clip pose; never modified by IK.
    base: Vec<Transform>,
    /// `base` with the caller's IK layers applied; what the renderer draws.
    pose: Vec<Transform>,
    playback: Option<(usize, PlaybackClock)>,
    fade: Option<(usize, usize, CrossFade)>,
    rig: IkRig,
    ik: IkLayers,
    workspace: IkWorkspace,
}
impl CharacterInstance {
    fn clip(&self, name: &str) -> Result<usize, JsValue> {
        self.data
            .rig
            .animations()
            .iter()
            .position(|c| c.name() == name)
            .ok_or_else(|| error(format!("unknown clip {name}")))
    }
    fn sample(
        &self,
        playback: Option<(usize, PlaybackClock)>,
        fade: Option<(usize, usize, CrossFade)>,
    ) -> Result<Vec<Transform>, JsValue> {
        let base: Vec<_> = self.data.nodes.iter().map(|n| n.local).collect();
        let mut pose = base.clone();
        if let Some((from, to, fade)) = fade {
            fade.sample(
                &self.data.rig.animations()[from],
                &self.data.rig.animations()[to],
                &mut ClipBlendWorkspace::new(base.len()),
                &base,
                &mut pose,
            )
            .map_err(error)?;
        } else if let Some((index, clock)) = playback {
            self.data.rig.animations()[index]
                .sample_resolved(clock.clip_time(), &mut pose)
                .map_err(error)?;
        }
        if pose
            .iter()
            .flat_map(|p| p.matrix().elements)
            .any(|v| !v.is_finite())
        {
            return Err(error("sampled node transform overflow"));
        }
        Ok(pose)
    }
    /// Apply `layers` over `base` into a fresh pose; the instance is unchanged on error.
    fn corrected(
        &mut self,
        base: &[Transform],
        layers: &IkLayers,
    ) -> Result<Vec<Transform>, JsValue> {
        let mut pose = base.to_vec();
        self.workspace
            .solve(&self.rig, base, &layers.layers(), &mut pose)
            .map_err(error)?;
        Ok(pose)
    }
    fn commit(&mut self, base: Vec<Transform>) -> Result<(), JsValue> {
        let ik = std::mem::take(&mut self.ik);
        let pose = self.corrected(&base, &ik);
        self.ik = ik;
        self.pose = pose?;
        self.base = base;
        Ok(())
    }
}
#[wasm_bindgen]
impl CharacterInstance {
    pub fn seek(&mut self, clip: &str, seconds: f64) -> Result<(), JsValue> {
        let index = self.clip(clip)?;
        let mut clock =
            PlaybackClock::from_clip(&self.data.rig.animations()[index]).map_err(error)?;
        clock.advance(seconds).map_err(error)?;
        let pose = self.sample(Some((index, clock)), None)?;
        self.commit(pose)?;
        self.playback = Some((index, clock));
        self.fade = None;
        Ok(())
    }
    pub fn transition(&mut self, clip: &str, seconds: f64) -> Result<(), JsValue> {
        let index = self.clip(clip)?;
        if !seconds.is_finite() || seconds <= 0.0 || !(seconds as f32).is_finite() {
            return Err(error("invalid transition duration"));
        }
        let (from, clock) = self
            .playback
            .ok_or_else(|| error("seek a clip before transitioning"))?;
        let target = PlaybackClock::from_clip(&self.data.rig.animations()[index]).map_err(error)?;
        let transition =
            TransitionClock::new(seconds as f32, TransitionCurve::Linear).map_err(error)?;
        self.fade = Some((from, index, CrossFade::new(clock, target, transition)));
        Ok(())
    }
    pub fn advance(&mut self, seconds: f64) -> Result<(), JsValue> {
        let mut playback = self.playback;
        let mut fade = self.fade;
        if let Some((_, to, ref mut clock)) = fade {
            clock.advance(seconds).map_err(error)?;
            if clock.transition().is_complete() {
                playback = Some((to, clock.into_target()));
                fade = None;
            }
        } else if let Some((_, ref mut clock)) = playback {
            clock.advance(seconds).map_err(error)?;
        } else {
            return Err(error("seek a clip before advancing"));
        }
        let pose = self.sample(playback, fade)?;
        self.commit(pose)?;
        self.playback = playback;
        self.fade = fade;
        Ok(())
    }
    /// Replace the IK layers applied over every sampled pose (JSON array; `[]` clears).
    /// Joints are named; targets are in character (scene root) space. Invalid layers throw
    /// and leave the instance unchanged.
    pub fn set_ik(&mut self, layers_json: &str) -> Result<(), JsValue> {
        let layers =
            IkLayers::parse(layers_json, &self.data.node_names, &self.rig).map_err(error)?;
        let base = std::mem::take(&mut self.base);
        let pose = self.corrected(&base, &layers);
        self.base = base;
        self.pose = pose?;
        self.ik = layers;
        Ok(())
    }
    /// Per-layer `{status, residual}` of the most recent solve.
    pub fn ik_report_json(&self) -> String {
        ik::report_json(&self.workspace)
    }
    /// Character-space position of a named joint in the current corrected pose.
    pub fn joint_position(&self, name: &str) -> Result<Vec<f32>, JsValue> {
        let index = self
            .data
            .node_names
            .iter()
            .position(|n| n == name)
            .ok_or_else(|| error(format!("character has no joint {name}")))?;
        let p = self
            .workspace
            .world_position(index)
            .ok_or_else(|| error("joint has no solved position"))?;
        Ok(vec![p.x, p.y, p.z])
    }
    pub fn local_matrices(&self) -> Vec<f32> {
        self.pose.iter().flat_map(|p| p.matrix().elements).collect()
    }
}
