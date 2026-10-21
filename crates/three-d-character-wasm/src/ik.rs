//! Parses caller IK layers (joint names, character-space targets) into the
//! `three_d_animation::ik` contract. The solver itself stays in Rust; this only
//! resolves names and numbers.
use serde_json::Value;
use three_d_animation::Quat;
use three_d_animation::ik::{
    EndEffector, IkGoal, IkLayer, IkRig, IkStatus, IkWorkspace, LimbGoal, LookAtChain, LookAtGoal,
    MAX_IK_LAYERS, TwoBoneChain,
};
use three_d_core::Vec3;

/// Parsed caller layers, kept so every later sample is corrected the same way.
#[derive(Debug, Clone, Default)]
pub struct IkLayers {
    layers: Vec<(IkGoal, f32)>,
}

fn joint(names: &[String], value: &Value) -> Result<usize, String> {
    let name = value
        .as_str()
        .ok_or("IK joint must be a joint name string")?;
    let index = names
        .iter()
        .position(|n| n == name)
        .ok_or_else(|| format!("character has no joint {name}"))?;
    if names.iter().rposition(|n| n == name) != Some(index) {
        return Err(format!("joint name {name} is not unique"));
    }
    Ok(index)
}

fn number(value: &Value, what: &str) -> Result<f32, String> {
    let n = value
        .as_f64()
        .ok_or_else(|| format!("{what} must be a number"))? as f32;
    if !n.is_finite() {
        return Err(format!("{what} must be finite"));
    }
    Ok(n)
}

fn numbers<const N: usize>(value: &Value, what: &str) -> Result<[f32; N], String> {
    let items = value
        .as_array()
        .filter(|items| items.len() == N)
        .ok_or_else(|| format!("{what} must be an array of {N} numbers"))?;
    let mut out = [0.0; N];
    for (slot, item) in out.iter_mut().zip(items) {
        *slot = number(item, what)?;
    }
    Ok(out)
}

fn vec3(value: &Value, what: &str) -> Result<Vec3, String> {
    let [x, y, z] = numbers::<3>(value, what)?;
    Ok(Vec3::new(x, y, z))
}

fn optional<'a>(layer: &'a Value, key: &str) -> Option<&'a Value> {
    layer.get(key).filter(|value| !value.is_null())
}

fn limb(names: &[String], rig: &IkRig, layer: &Value) -> Result<IkGoal, String> {
    let joints = layer
        .get("joints")
        .and_then(Value::as_array)
        .filter(|joints| joints.len() == 3)
        .ok_or("limb joints must be [root, mid, tip] joint names")?;
    let chain = TwoBoneChain::new(
        rig,
        joint(names, &joints[0])?,
        joint(names, &joints[1])?,
        joint(names, &joints[2])?,
    )
    .map_err(|e| e.to_string())?;
    let target = vec3(layer.get("target").unwrap_or(&Value::Null), "limb target")?;
    let mut goal = LimbGoal::new(chain, target);
    if let Some(pole) = optional(layer, "pole") {
        goal = goal.with_pole(vec3(pole, "limb pole")?);
    }
    if let Some(reach) = optional(layer, "maxReach") {
        goal = goal.with_max_reach(number(reach, "limb maxReach")?);
    }
    match (optional(layer, "orientation"), optional(layer, "align")) {
        (Some(_), Some(_)) => return Err("limb takes orientation or align, not both".into()),
        (Some(orientation), None) => {
            let [x, y, z, w] = numbers::<4>(orientation, "limb orientation")?;
            goal.end = EndEffector::Orientation(Quat::new(x, y, z, w));
        }
        (None, Some(align)) => {
            goal.end = EndEffector::AlignAxis {
                local_axis: vec3(
                    align.get("localAxis").unwrap_or(&Value::Null),
                    "limb align.localAxis",
                )?,
                direction: vec3(
                    align.get("direction").unwrap_or(&Value::Null),
                    "limb align.direction",
                )?,
            };
        }
        (None, None) => {}
    }
    Ok(IkGoal::Limb(goal))
}

fn look_at(names: &[String], rig: &IkRig, layer: &Value) -> Result<IkGoal, String> {
    let joints = layer
        .get("joints")
        .and_then(Value::as_array)
        .ok_or("lookAt joints must be [[name, weight], ...]")?
        .iter()
        .map(|entry| match entry.as_array().map(Vec::as_slice) {
            Some([name, weight]) => {
                Ok((joint(names, name)?, number(weight, "lookAt joint weight")?))
            }
            _ => Err("lookAt joints must be [[name, weight], ...]".to_string()),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let forward = vec3(
        layer.get("forward").unwrap_or(&Value::Null),
        "lookAt forward",
    )?;
    let chain = LookAtChain::new(rig, &joints, forward).map_err(|e| e.to_string())?;
    Ok(IkGoal::LookAt(LookAtGoal {
        chain,
        target: vec3(layer.get("target").unwrap_or(&Value::Null), "lookAt target")?,
        max_angle: number(
            layer.get("maxAngle").unwrap_or(&Value::Null),
            "lookAt maxAngle",
        )?,
    }))
}

impl IkLayers {
    pub fn parse(json: &str, names: &[String], rig: &IkRig) -> Result<Self, String> {
        let value: Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
        let items = value.as_array().ok_or("IK layers must be an array")?;
        if items.len() > MAX_IK_LAYERS {
            return Err(format!("at most {MAX_IK_LAYERS} IK layers are supported"));
        }
        let layers = items
            .iter()
            .map(|layer| {
                let goal = match layer.get("kind").and_then(Value::as_str) {
                    Some("limb") => limb(names, rig, layer)?,
                    Some("lookAt") => look_at(names, rig, layer)?,
                    _ => return Err("IK layer kind must be \"limb\" or \"lookAt\"".to_string()),
                };
                let weight = optional(layer, "weight")
                    .map(|w| number(w, "IK layer weight"))
                    .transpose()?
                    .unwrap_or(1.0);
                Ok((goal, weight))
            })
            .collect::<Result<_, String>>()?;
        Ok(Self { layers })
    }

    pub fn layers(&self) -> Vec<IkLayer<'static>> {
        self.layers
            .iter()
            .map(|&(goal, weight)| IkLayer::new(goal, weight))
            .collect()
    }
}

/// Per-layer outcomes of the most recent solve as JSON.
pub fn report_json(workspace: &IkWorkspace) -> String {
    let outcomes: Vec<_> = workspace
        .outcomes()
        .iter()
        .map(|outcome| {
            serde_json::json!({
                "status": match outcome.status {
                    IkStatus::Skipped => "skipped",
                    IkStatus::Reached => "reached",
                    IkStatus::Clamped => "clamped",
                },
                "residual": outcome.residual,
            })
        })
        .collect();
    Value::Array(outcomes).to_string()
}

#[cfg(test)]
mod tests {
    use crate::CharacterAsset;

    const FIGURE: &[u8] =
        include_bytes!("../../../fixtures/imported-character/RiggedFigure.source.glb");

    fn distance(a: &[f32], b: &[f32]) -> f32 {
        a.iter()
            .zip(b)
            .map(|(x, y)| (x - y).powi(2))
            .sum::<f32>()
            .sqrt()
    }

    #[test]
    fn named_limb_layer_reaches_target_and_clearing_restores_base() {
        let asset = CharacterAsset::new(FIGURE).unwrap();
        let mut instance = asset.create_instance();
        let ankle = instance.joint_position("leg_joint_L_3").unwrap();
        let hip = instance.joint_position("leg_joint_L_1").unwrap();
        let target: Vec<f32> = ankle
            .iter()
            .zip(&hip)
            .map(|(a, h)| a + 0.3 * (h - a))
            .collect();
        instance
            .set_ik(&format!(
                r#"[{{"kind":"limb","joints":["leg_joint_L_1","leg_joint_L_2","leg_joint_L_3"],"target":{target:?}}},
                    {{"kind":"lookAt","joints":[["neck_joint_1",0.5],["neck_joint_2",1]],"forward":[0,1,0],"target":[0,-2,1.6],"maxAngle":0.5,"weight":0}}]"#
            ))
            .unwrap();
        assert!(distance(&instance.joint_position("leg_joint_L_3").unwrap(), &target) < 1e-4);
        let report: serde_json::Value = serde_json::from_str(&instance.ik_report_json()).unwrap();
        assert_eq!(report[0]["status"], "reached");
        assert_eq!(report[1]["status"], "skipped");
        instance.set_ik("[]").unwrap();
        assert!(distance(&instance.joint_position("leg_joint_L_3").unwrap(), &ankle) < 1e-6);
    }
}
