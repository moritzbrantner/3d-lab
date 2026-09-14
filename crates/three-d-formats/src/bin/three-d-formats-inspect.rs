use std::{env, fs, path::Path};

use three_d_formats::load_obj;

fn escape_json(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '"' => escaped.push_str("\\\""),
            '\\' => escaped.push_str("\\\\"),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            '\t' => escaped.push_str("\\t"),
            character if character.is_control() => {
                use std::fmt::Write as _;
                write!(escaped, "\\u{:04x}", character as u32)
                    .expect("writing to a String cannot fail");
            }
            character => escaped.push(character),
        }
    }
    escaped
}

fn obj_summary(bytes: &[u8]) -> Result<String, String> {
    let asset = load_obj(bytes).map_err(|error| error.to_string())?;
    let mut primitive_count = 0usize;
    let mut vertex_count = 0usize;
    let mut triangle_count = 0usize;
    let mut meshes = Vec::with_capacity(asset.meshes().len());

    for mesh in asset.meshes() {
        let mut mesh_vertices = 0usize;
        let mut mesh_triangles = 0usize;
        for primitive in mesh.primitives() {
            primitive_count += 1;
            mesh_vertices += primitive.mesh().vertices().len();
            mesh_triangles += primitive.mesh().indices().len() / 3;
        }
        vertex_count += mesh_vertices;
        triangle_count += mesh_triangles;
        let name = match mesh.name() {
            Some(name) => format!("\"{}\"", escape_json(name)),
            None => "null".to_owned(),
        };
        meshes.push(format!(
            "{{\"name\":{name},\"primitiveCount\":{},\"vertexCount\":{mesh_vertices},\"triangleCount\":{mesh_triangles}}}",
            mesh.primitives().len()
        ));
    }

    Ok(format!(
        "{{\"schemaVersion\":1,\"format\":\"obj\",\"meshCount\":{},\"primitiveCount\":{primitive_count},\"vertexCount\":{vertex_count},\"triangleCount\":{triangle_count},\"meshes\":[{}]}}",
        asset.meshes().len(),
        meshes.join(",")
    ))
}

fn inspect_obj(path: &Path) -> Result<(), String> {
    let bytes = fs::read(path)
        .map_err(|error| format!("failed to read '{}': {error}", path.display()))?;
    println!("{}", obj_summary(&bytes)?);
    Ok(())
}

fn run() -> Result<(), String> {
    let mut arguments = env::args_os().skip(1);
    let format = arguments.next().and_then(|value| value.into_string().ok());
    let path = arguments.next().map(Into::into);
    if arguments.next().is_some() {
        return Err("usage: three-d-formats-inspect obj PATH".into());
    }
    match (format.as_deref(), path) {
        (Some("obj"), Some(path)) => inspect_obj(&path),
        _ => Err("usage: three-d-formats-inspect obj PATH".into()),
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_stable_obj_geometry_evidence() {
        let summary = obj_summary(
            b"o fixture\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n",
        )
        .expect("fixture OBJ should decode");

        assert!(summary.starts_with("{\"schemaVersion\":1,\"format\":\"obj\""));
        assert!(summary.contains("\"meshCount\":1"));
        assert!(summary.contains("\"primitiveCount\":1"));
        assert!(summary.contains("\"vertexCount\":3"));
        assert!(summary.contains("\"triangleCount\":1"));
    }

    #[test]
    fn escapes_mesh_names_as_json_strings() {
        assert_eq!(escape_json("a\"b\\c\n"), "a\\\"b\\\\c\\n");
    }

    #[test]
    fn rejects_non_obj_input() {
        assert!(obj_summary(b"not an obj").is_err());
    }
}
