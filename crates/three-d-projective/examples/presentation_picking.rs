//! A native public-API demonstration, with no window, renderer or gameplay authority.
use three_d_animation::Mat4;
use three_d_camera::PerspectiveCamera;
use three_d_core::{Mesh, Vec3};
use three_d_projective::picking::{CullMode, PickRay};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let camera = PerspectiveCamera::new(
        Vec3::new(0.0, 0.0, 5.0),
        Vec3::ZERO,
        Vec3::new(0.0, 1.0, 0.0),
        50_f32.to_radians(),
        2.0,
        0.1,
        100.0,
    )?;
    let ray = PickRay::from_viewport(camera.view_projection_matrix(), [800, 400], [400.0, 200.0])?;
    let cube = Mesh::unit_cube();
    let farther = ray
        .intersect_mesh(&cube, Mat4::IDENTITY, CullMode::Back)?
        .ok_or("missing farther surface")?;
    let nearer = ray
        .intersect_mesh(
            &cube,
            Mat4::translation(Vec3::new(0.0, 0.0, 2.0)),
            CullMode::Back,
        )?
        .ok_or("missing nearer surface")?;
    assert!(nearer.distance < farther.distance);
    println!(
        "nearer_distance={:.3} farther_distance={:.3}; nearer surface occludes farther",
        nearer.distance, farther.distance
    );
    Ok(())
}
