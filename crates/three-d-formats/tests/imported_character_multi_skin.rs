//! Characters built from several skinned meshes (outfit pieces, head, eyes), each with its
//! own skin, as real asset-tooling humanoid bundles are (#132).
use serde_json::{Value, json};
use three_d_formats::{ImportedPrimitive, load_gltf_imported_character};

const FOX: &[u8] = include_bytes!("../../../fixtures/imported-character/fox.glb");

fn split(glb: &[u8]) -> (Value, Vec<u8>) {
    let json_len = u32::from_le_bytes(glb[12..16].try_into().unwrap()) as usize;
    let json = serde_json::from_slice(&glb[20..20 + json_len]).unwrap();
    (json, glb[28 + json_len..].to_vec())
}

fn join(json: &Value, bin: &[u8]) -> Vec<u8> {
    let mut text = serde_json::to_vec(json).unwrap();
    while !text.len().is_multiple_of(4) {
        text.push(b' ');
    }
    let total = 28 + text.len() + bin.len();
    let mut out = Vec::with_capacity(total);
    out.extend(0x4654_6c67u32.to_le_bytes());
    out.extend(2u32.to_le_bytes());
    out.extend((total as u32).to_le_bytes());
    out.extend((text.len() as u32).to_le_bytes());
    out.extend(0x4e4f_534au32.to_le_bytes());
    out.extend(&text);
    out.extend((bin.len() as u32).to_le_bytes());
    out.extend(0x004e_4942u32.to_le_bytes());
    out.extend(bin);
    out
}

/// The Fox with a second skinned mesh node: the same mesh bound through a second skin whose
/// inverse binds are scaled, so the two skins disagree, like a head bound separately.
fn two_skin_fox() -> Vec<u8> {
    let (mut json, mut bin) = split(FOX);
    let skin = json["skins"][0].clone();
    let ibm = json["accessors"][skin["inverseBindMatrices"].as_u64().unwrap() as usize].clone();
    let view = json["bufferViews"][ibm["bufferView"].as_u64().unwrap() as usize].clone();
    let start = (view["byteOffset"].as_u64().unwrap_or(0) + ibm["byteOffset"].as_u64().unwrap_or(0))
        as usize;
    let count = ibm["count"].as_u64().unwrap() as usize;
    let mut scaled = bin[start..start + count * 64].to_vec();
    for chunk in scaled.as_chunks_mut::<4>().0 {
        *chunk = (f32::from_le_bytes(*chunk) * 1.5).to_le_bytes();
    }
    while !bin.len().is_multiple_of(4) {
        bin.push(0);
    }
    let offset = bin.len();
    bin.extend(&scaled);
    json["buffers"][0]["byteLength"] = json!(bin.len());
    let views = json["bufferViews"].as_array_mut().unwrap();
    views.push(json!({"buffer": 0, "byteOffset": offset, "byteLength": scaled.len()}));
    let view_index = views.len() - 1;
    let accessors = json["accessors"].as_array_mut().unwrap();
    let mut accessor = ibm;
    accessor["bufferView"] = json!(view_index);
    accessor.as_object_mut().unwrap().remove("byteOffset");
    accessors.push(accessor);
    let accessor_index = accessors.len() - 1;
    let mut second = skin;
    second["inverseBindMatrices"] = json!(accessor_index);
    json["skins"].as_array_mut().unwrap().push(second);
    let mesh_node = json["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .position(|n| n.get("skin").is_some())
        .unwrap();
    let mut node = json["nodes"][mesh_node].clone();
    node["skin"] = json!(1);
    node["name"] = json!("second-skinned-piece");
    let nodes = json["nodes"].as_array_mut().unwrap();
    nodes.push(node);
    let new_node = nodes.len() - 1;
    let scene = json["scene"].as_u64().unwrap_or(0) as usize;
    json["scenes"][scene]["nodes"]
        .as_array_mut()
        .unwrap()
        .push(json!(new_node));
    join(&json, &bin)
}

#[test]
fn every_skinned_mesh_node_contributes_its_primitives_with_source_identity() {
    let single = load_gltf_imported_character(FOX).unwrap();
    let asset = load_gltf_imported_character(&two_skin_fox()).unwrap();
    assert_eq!(asset.mesh_nodes.len(), 2);
    assert_eq!(asset.primitives.len(), 2 * single.primitives.len());
    assert_eq!(asset.primitive_indices.len(), asset.primitives.len());
    assert_eq!(asset.gpu_skin_indices.len(), asset.primitives.len());
    let mesh = single.primitives[0].mesh;
    assert_eq!(
        asset
            .primitives
            .iter()
            .map(|p| (p.mesh, p.primitive))
            .collect::<Vec<_>>(),
        vec![(mesh, 0), (mesh, 0)]
    );
    assert!(
        asset
            .primitives
            .iter()
            .all(|p: &ImportedPrimitive| asset.mesh_nodes.contains(&p.node))
    );
    // Both skins name the same joints: the canonical palette lists each node once and keeps
    // the first skin's binds, so the single-skin pose authority is unchanged.
    assert_eq!(asset.skin_nodes, single.skin_nodes);
    assert_eq!(asset.inverse_binds, single.inverse_binds);
    assert_eq!(asset.rig.animations().len(), single.rig.animations().len());
}

#[test]
fn unsampled_extra_colour_and_uv_sets_are_skipped_but_a_sampled_second_uv_set_is_refused() {
    let (mut json, bin) = split(FOX);
    let attributes = json["meshes"][0]["primitives"][0]["attributes"].clone();
    let uv = attributes["TEXCOORD_0"].clone();
    let extra = json["meshes"][0]["primitives"][0]["attributes"]
        .as_object_mut()
        .unwrap();
    extra.insert("TEXCOORD_1".into(), uv.clone());
    extra.insert("TEXCOORD_2".into(), uv);
    let accepted = load_gltf_imported_character(&join(&json, &bin)).unwrap();
    assert_eq!(accepted.primitives.len(), 1);

    let material = json["meshes"][0]["primitives"][0]["material"]
        .as_u64()
        .unwrap() as usize;
    json["materials"][material]["pbrMetallicRoughness"]["baseColorTexture"]["texCoord"] = json!(1);
    let error = load_gltf_imported_character(&join(&json, &bin))
        .unwrap_err()
        .to_string();
    assert!(error.contains("TexCoords(1)"), "{error}");
}
