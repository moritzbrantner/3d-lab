use three_d_assets::{MagnificationFilter, MinificationFilter, TextureWrap};
use three_d_formats::{FormatError, load_gltf};

const GLTF_NORMAL_TEXTURE: &[u8] = br#"{
  "asset": { "version": "2.0" },
  "meshes": [{
    "name": "NormalMappedTriangle",
    "primitives": [{
      "attributes": { "POSITION": 0, "NORMAL": 1, "TANGENT": 3, "TEXCOORD_0": 4 },
      "indices": 2,
      "material": 0,
      "mode": 4
    }]
  }],
  "materials": [{
    "name": "Normal mapped PBR",
    "pbrMetallicRoughness": {
      "baseColorFactor": [0.18, 0.55, 0.95, 1.0],
      "metallicFactor": 0.1,
      "roughnessFactor": 0.55
    },
    "normalTexture": { "index": 0, "texCoord": 0, "scale": 0.75 }
  }],
  "images": [{
    "name": "Flat normal",
    "uri": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNoaPj/HwAGggL/s75RMwAAAABJRU5ErkJggg=="
  }],
  "samplers": [{
    "name": "Normal sampler",
    "magFilter": 9729,
    "minFilter": 9987,
    "wrapS": 10497,
    "wrapT": 33648
  }],
  "textures": [{ "name": "Normal texture", "sampler": 0, "source": 0 }],
  "buffers": [{
    "byteLength": 152,
    "uri": "data:application/octet-stream;base64,ZmZmv2ZmJr8AAAAAZmZmP2ZmJr8AAAAAAAAAAGZmZj8AAAAAAAAAAAAAAAAAAIA/AAAAAAAAAAAAAIA/AAAAAAAAAAAAAIA/AAABAAIAAAAAAIA/AAAAAAAAAAAAAIA/AACAPwAAAAAAAAAAAACAPwAAgD8AAAAAAAAAAAAAgD8AAAAAAAAAAAAAgD8AAAAAAAAAPwAAgD8="
  }],
  "bufferViews": [
    { "buffer": 0, "byteOffset": 0, "byteLength": 36, "target": 34962 },
    { "buffer": 0, "byteOffset": 36, "byteLength": 36, "target": 34962 },
    { "buffer": 0, "byteOffset": 72, "byteLength": 6, "target": 34963 },
    { "buffer": 0, "byteOffset": 80, "byteLength": 48, "target": 34962 },
    { "buffer": 0, "byteOffset": 128, "byteLength": 24, "target": 34962 }
  ],
  "accessors": [
    { "bufferView": 0, "componentType": 5126, "count": 3, "type": "VEC3", "min": [-0.9, -0.65, 0.0], "max": [0.9, 0.9, 0.0] },
    { "bufferView": 1, "componentType": 5126, "count": 3, "type": "VEC3" },
    { "bufferView": 2, "componentType": 5123, "count": 3, "type": "SCALAR" },
    { "bufferView": 3, "componentType": 5126, "count": 3, "type": "VEC4" },
    { "bufferView": 4, "componentType": 5126, "count": 3, "type": "VEC2" }
  ]
}"#;

#[test]
fn gltf_preserves_normal_texture_resource_graph() {
    let asset = load_gltf(GLTF_NORMAL_TEXTURE).expect("normal-textured glTF fixture loads");
    let binding = asset.materials()[0]
        .normal_texture()
        .expect("normal texture binding is preserved");

    assert_eq!(binding.texture(), 0);
    assert_eq!(binding.tex_coord(), 0);
    assert_eq!(binding.scale(), 0.75);
    assert_eq!(asset.images()[0].name(), Some("Flat normal"));
    assert_eq!(asset.images()[0].mime_type(), "image/png");
    assert_eq!(asset.images()[0].bytes().len(), 70);
    assert_eq!(asset.textures()[0].name(), Some("Normal texture"));
    assert_eq!(asset.textures()[0].image(), 0);
    assert_eq!(asset.textures()[0].sampler(), Some(0));
    assert_eq!(asset.samplers()[0].name(), Some("Normal sampler"));
    assert_eq!(
        asset.samplers()[0].mag_filter(),
        Some(MagnificationFilter::Linear)
    );
    assert_eq!(
        asset.samplers()[0].min_filter(),
        Some(MinificationFilter::LinearMipmapLinear)
    );
    assert_eq!(asset.samplers()[0].wrap_s(), TextureWrap::Repeat);
    assert_eq!(asset.samplers()[0].wrap_t(), TextureWrap::MirroredRepeat);
}

#[test]
fn gltf_byte_loader_rejects_external_image_uris() {
    let source = br#"{
      "asset": { "version": "2.0" },
      "images": [{ "uri": "normal.png" }],
      "textures": [{ "source": 0 }],
      "materials": [{ "normalTexture": { "index": 0 } }],
      "meshes": [{ "primitives": [{ "attributes": { "POSITION": 0 } }] }],
      "buffers": [{
        "byteLength": 36,
        "uri": "data:application/octet-stream;base64,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
      }],
      "bufferViews": [{ "buffer": 0, "byteLength": 36 }],
      "accessors": [{
        "bufferView": 0,
        "componentType": 5126,
        "count": 3,
        "type": "VEC3",
        "min": [0.0, 0.0, 0.0],
        "max": [0.0, 0.0, 0.0]
      }]
    }"#;

    assert!(matches!(
        load_gltf(source),
        Err(FormatError::UnsupportedGltfImageUri(uri)) if uri == "normal.png"
    ));
}
