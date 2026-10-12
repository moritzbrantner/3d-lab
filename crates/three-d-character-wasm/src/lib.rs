//! Thin retained-resource adapter; all clip, hierarchy and playback semantics stay in Rust.
use std::rc::Rc;
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
            "skinNodes": self.data.skin_nodes, "meshNode": self.data.mesh_node, "primitiveIndices": self.data.primitive_indices,
            "inverseBinds": self.data.inverse_binds.iter().map(|m| m.elements).collect::<Vec<_>>(),
            "clips": self.data.rig.animations().iter().map(|c| serde_json::json!({"name":c.name(),"duration":c.duration()})).collect::<Vec<_>>() }).to_string()
    }
    pub fn create_instance(&self) -> CharacterInstance {
        let pose = self.data.nodes.iter().map(|n| n.local).collect();
        CharacterInstance {
            data: Rc::clone(&self.data),
            pose,
            playback: None,
            fade: None,
        }
    }
}
#[wasm_bindgen]
pub struct CharacterInstance {
    data: Rc<ImportedCharacter>,
    pose: Vec<Transform>,
    playback: Option<(usize, PlaybackClock)>,
    fade: Option<(usize, usize, CrossFade)>,
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
}
#[wasm_bindgen]
impl CharacterInstance {
    pub fn seek(&mut self, clip: &str, seconds: f64) -> Result<(), JsValue> {
        let index = self.clip(clip)?;
        let mut clock =
            PlaybackClock::from_clip(&self.data.rig.animations()[index]).map_err(error)?;
        clock.advance(seconds).map_err(error)?;
        let pose = self.sample(Some((index, clock)), None)?;
        self.pose = pose;
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
        self.pose = pose;
        self.playback = playback;
        self.fade = fade;
        Ok(())
    }
    pub fn local_matrices(&self) -> Vec<f32> {
        self.pose.iter().flat_map(|p| p.matrix().elements).collect()
    }
}
