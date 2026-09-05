//! Renderer-independent camera semantics for `3d-lab`.
//!
//! This crate owns view and projection matrix construction. It deliberately does not own
//! GPU buffers, bind groups, render passes, browser APIs, or windowing.

use core::fmt;
use three_d_animation::Mat4;
use three_d_core::Vec3;

const DIRECTION_EPSILON: f32 = 1.0e-6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CameraError {
    InvalidFieldOfView,
    InvalidAspect,
    InvalidDepthRange,
    InvalidViewDirection,
    InvalidUpVector,
}

impl fmt::Display for CameraError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidFieldOfView => {
                formatter.write_str("field of view must be finite and between 0 and pi")
            }
            Self::InvalidAspect => formatter.write_str("aspect ratio must be finite and positive"),
            Self::InvalidDepthRange => {
                formatter.write_str("near/far planes must be finite with 0 < near < far")
            }
            Self::InvalidViewDirection => {
                formatter.write_str("camera eye and target must define a finite direction")
            }
            Self::InvalidUpVector => formatter.write_str(
                "camera up vector must be finite and not parallel to the view direction",
            ),
        }
    }
}

impl std::error::Error for CameraError {}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PerspectiveCamera {
    pub eye: Vec3,
    pub target: Vec3,
    pub up: Vec3,
    pub fov_y_radians: f32,
    pub aspect: f32,
    pub near: f32,
    pub far: f32,
}

impl PerspectiveCamera {
    pub fn new(
        eye: Vec3,
        target: Vec3,
        up: Vec3,
        fov_y_radians: f32,
        aspect: f32,
        near: f32,
        far: f32,
    ) -> Result<Self, CameraError> {
        if !fov_y_radians.is_finite()
            || fov_y_radians <= 0.0
            || fov_y_radians >= core::f32::consts::PI
        {
            return Err(CameraError::InvalidFieldOfView);
        }
        if !aspect.is_finite() || aspect <= 0.0 {
            return Err(CameraError::InvalidAspect);
        }
        if !near.is_finite() || !far.is_finite() || near <= 0.0 || far <= near {
            return Err(CameraError::InvalidDepthRange);
        }
        if !finite_vec3(eye) || !finite_vec3(target) {
            return Err(CameraError::InvalidViewDirection);
        }
        if !finite_vec3(up) {
            return Err(CameraError::InvalidUpVector);
        }

        let forward = (target - eye)
            .normalized()
            .ok_or(CameraError::InvalidViewDirection)?;
        let up = up.normalized().ok_or(CameraError::InvalidUpVector)?;
        if forward.cross(up).length() <= DIRECTION_EPSILON {
            return Err(CameraError::InvalidUpVector);
        }

        Ok(Self {
            eye,
            target,
            up,
            fov_y_radians,
            aspect,
            near,
            far,
        })
    }

    pub fn view_matrix(self) -> Mat4 {
        let forward = (self.target - self.eye)
            .normalized()
            .expect("validated camera view direction remains non-zero");
        let right = forward
            .cross(self.up)
            .normalized()
            .expect("validated camera up remains independent from view direction");
        let up = right.cross(forward);

        Mat4 {
            elements: [
                right.x,
                up.x,
                -forward.x,
                0.0,
                right.y,
                up.y,
                -forward.y,
                0.0,
                right.z,
                up.z,
                -forward.z,
                0.0,
                -right.dot(self.eye),
                -up.dot(self.eye),
                forward.dot(self.eye),
                1.0,
            ],
        }
    }

    pub fn projection_matrix(self) -> Mat4 {
        let focal = 1.0 / (self.fov_y_radians * 0.5).tan();
        let depth_scale = self.far / (self.near - self.far);
        let depth_translation = self.far * self.near / (self.near - self.far);

        Mat4 {
            elements: [
                focal / self.aspect,
                0.0,
                0.0,
                0.0,
                0.0,
                focal,
                0.0,
                0.0,
                0.0,
                0.0,
                depth_scale,
                -1.0,
                0.0,
                0.0,
                depth_translation,
                0.0,
            ],
        }
    }

    pub fn view_projection_matrix(self) -> Mat4 {
        self.projection_matrix() * self.view_matrix()
    }
}

fn finite_vec3(value: Vec3) -> bool {
    value.x.is_finite() && value.y.is_finite() && value.z.is_finite()
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPSILON: f32 = 1.0e-5;

    fn camera() -> PerspectiveCamera {
        PerspectiveCamera::new(
            Vec3::new(2.4, 1.8, 3.2),
            Vec3::ZERO,
            Vec3::new(0.0, 1.0, 0.0),
            core::f32::consts::FRAC_PI_3,
            1.5,
            0.1,
            100.0,
        )
        .expect("test camera is valid")
    }

    #[test]
    fn view_matrix_maps_eye_to_origin() {
        let camera = camera();
        let mapped_eye = camera.view_matrix().transform_point(camera.eye);

        assert!(mapped_eye.x.abs() <= EPSILON);
        assert!(mapped_eye.y.abs() <= EPSILON);
        assert!(mapped_eye.z.abs() <= EPSILON);
    }

    #[test]
    fn webgpu_projection_maps_near_and_far_depth_to_zero_and_one() {
        let camera = camera();
        let matrix = camera.projection_matrix().elements;

        let project_depth = |view_z: f32| {
            let clip_z = matrix[10] * view_z + matrix[14];
            let clip_w = matrix[11] * view_z + matrix[15];
            clip_z / clip_w
        };

        assert!(project_depth(-camera.near).abs() <= EPSILON);
        assert!((project_depth(-camera.far) - 1.0).abs() <= EPSILON);
    }

    #[test]
    fn rejects_parallel_up_and_view_vectors() {
        let result = PerspectiveCamera::new(
            Vec3::new(0.0, 0.0, 1.0),
            Vec3::ZERO,
            Vec3::new(0.0, 0.0, 1.0),
            core::f32::consts::FRAC_PI_3,
            1.0,
            0.1,
            10.0,
        );

        assert_eq!(result, Err(CameraError::InvalidUpVector));
    }
}
