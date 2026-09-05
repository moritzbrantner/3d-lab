use std::{error::Error, mem};

use bytemuck::{Pod, Zeroable};
use three_d_core::{Mesh, Vec3};
use wgpu::util::DeviceExt;

const TARGET_FORMAT: wgpu::TextureFormat = wgpu::TextureFormat::Rgba8UnormSrgb;
const TARGET_SIZE: u32 = 64;
const SHADER: &str = r#"
struct VertexInput {
    @location(0) position: vec3<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> @builtin(position) vec4<f32> {
    return vec4<f32>(input.position, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4<f32> {
    return vec4<f32>(0.2, 0.65, 1.0, 1.0);
}
"#;

#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Pod, Zeroable)]
struct GpuVertex {
    position: [f32; 3],
}

impl GpuVertex {
    const ATTRIBUTES: [wgpu::VertexAttribute; 1] = wgpu::vertex_attr_array![0 => Float32x3];

    fn layout() -> wgpu::VertexBufferLayout<'static> {
        wgpu::VertexBufferLayout {
            array_stride: mem::size_of::<Self>() as wgpu::BufferAddress,
            step_mode: wgpu::VertexStepMode::Vertex,
            attributes: &Self::ATTRIBUTES,
        }
    }
}

impl From<Vec3> for GpuVertex {
    fn from(value: Vec3) -> Self {
        Self {
            position: [value.x, value.y, value.z],
        }
    }
}

#[derive(Debug, PartialEq)]
struct PackedMesh {
    vertices: Vec<GpuVertex>,
    indices: Vec<u32>,
}

impl PackedMesh {
    fn from_mesh(mesh: &Mesh) -> Self {
        Self {
            vertices: mesh.vertices().iter().copied().map(Into::into).collect(),
            indices: mesh.indices().to_vec(),
        }
    }

    fn index_count(&self) -> u32 {
        u32::try_from(self.indices.len()).expect("wgpu indexed draws use u32 index counts")
    }
}

fn main() -> Result<(), Box<dyn Error>> {
    let mesh = Mesh::unit_cube();
    pollster::block_on(render_once(&mesh))
}

async fn render_once(mesh: &Mesh) -> Result<(), Box<dyn Error>> {
    let packed = PackedMesh::from_mesh(mesh);
    if packed.indices.is_empty() {
        return Ok(());
    }

    let instance = wgpu::Instance::default();
    let adapter = instance
        .request_adapter(&wgpu::RequestAdapterOptions::default())
        .await?;
    let adapter_info = adapter.get_info();
    let (device, queue) = adapter
        .request_device(&wgpu::DeviceDescriptor {
            label: Some("3d-lab native comparison device"),
            ..Default::default()
        })
        .await?;

    let vertex_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("3d-lab mesh vertices"),
        contents: bytemuck::cast_slice(&packed.vertices),
        usage: wgpu::BufferUsages::VERTEX,
    });
    let index_buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
        label: Some("3d-lab mesh indices"),
        contents: bytemuck::cast_slice(&packed.indices),
        usage: wgpu::BufferUsages::INDEX,
    });

    let shader = device.create_shader_module(wgpu::ShaderModuleDescriptor {
        label: Some("3d-lab native comparison shader"),
        source: wgpu::ShaderSource::Wgsl(SHADER.into()),
    });
    let vertex_buffers = [Some(GpuVertex::layout())];
    let color_targets = [Some(wgpu::ColorTargetState {
        format: TARGET_FORMAT,
        blend: None,
        write_mask: wgpu::ColorWrites::ALL,
    })];
    let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
        label: Some("3d-lab native comparison pipeline"),
        layout: None,
        vertex: wgpu::VertexState {
            module: &shader,
            entry_point: Some("vs_main"),
            compilation_options: Default::default(),
            buffers: &vertex_buffers,
        },
        primitive: wgpu::PrimitiveState {
            topology: wgpu::PrimitiveTopology::TriangleList,
            ..Default::default()
        },
        depth_stencil: None,
        multisample: wgpu::MultisampleState::default(),
        fragment: Some(wgpu::FragmentState {
            module: &shader,
            entry_point: Some("fs_main"),
            compilation_options: Default::default(),
            targets: &color_targets,
        }),
        multiview_mask: None,
        cache: None,
    });

    let target = device.create_texture(&wgpu::TextureDescriptor {
        label: Some("3d-lab offscreen target"),
        size: wgpu::Extent3d {
            width: TARGET_SIZE,
            height: TARGET_SIZE,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: TARGET_FORMAT,
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT,
        view_formats: &[],
    });
    let target_view = target.create_view(&wgpu::TextureViewDescriptor::default());
    let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
        label: Some("3d-lab native comparison encoder"),
    });

    {
        let color_attachments = [Some(wgpu::RenderPassColorAttachment {
            view: &target_view,
            depth_slice: None,
            resolve_target: None,
            ops: wgpu::Operations {
                load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                store: wgpu::StoreOp::Store,
            },
        })];
        let mut render_pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("3d-lab native comparison pass"),
            color_attachments: &color_attachments,
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        render_pass.set_pipeline(&pipeline);
        render_pass.set_vertex_buffer(0, vertex_buffer.slice(..));
        render_pass.set_index_buffer(index_buffer.slice(..), wgpu::IndexFormat::Uint32);
        render_pass.draw_indexed(0..packed.index_count(), 0, 0..1);
    }

    queue.submit(std::iter::once(encoder.finish()));
    println!(
        "submitted three-d-core cube draw through native wgpu adapter {}",
        adapter_info.name
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn packing_preserves_core_mesh_vertex_and_index_order() {
        let mesh = Mesh::new(
            vec![
                Vec3::new(-0.5, -0.5, 0.0),
                Vec3::new(0.5, -0.5, 0.0),
                Vec3::new(0.0, 0.5, 0.0),
            ],
            vec![2, 0, 1],
        )
        .expect("fixture mesh is valid");

        let packed = PackedMesh::from_mesh(&mesh);

        assert_eq!(
            packed.vertices,
            vec![
                GpuVertex {
                    position: [-0.5, -0.5, 0.0]
                },
                GpuVertex {
                    position: [0.5, -0.5, 0.0]
                },
                GpuVertex {
                    position: [0.0, 0.5, 0.0]
                },
            ]
        );
        assert_eq!(packed.indices, vec![2, 0, 1]);
    }

    #[test]
    fn gpu_vertex_layout_is_one_xyz_attribute() {
        let layout = GpuVertex::layout();

        assert_eq!(layout.array_stride, 12);
        assert_eq!(layout.attributes.len(), 1);
        assert_eq!(layout.attributes[0].offset, 0);
        assert_eq!(layout.attributes[0].shader_location, 0);
        assert_eq!(layout.attributes[0].format, wgpu::VertexFormat::Float32x3);
    }
}
