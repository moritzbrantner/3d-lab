//! Renderer-independent camera semantics for `3d-lab`.
//!
//! This crate owns view and projection matrix construction. It deliberately does not own
//! GPU buffers, bind groups, render passes, browser APIs, or windowing.

use core::fmt;
use three_d_animation::Mat4;
use three_d_core::Vec3;

const DIRECTION_EPSILON: f64 = 1.0e-6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CameraError {
    InvalidFieldOfView,
    InvalidAspect,
    InvalidDepthRange,
    InvalidOrthographicBounds,
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
            Self::InvalidOrthographicBounds => formatter.write_str(
                "orthographic bounds must be finite, representable, and satisfy left < right and bottom < top",
            ),
            Self::InvalidViewDirection => formatter.write_str(
                "camera eye and target must define a finite, representable view transform",
            ),
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
        validate_depth_range(near, far)?;
        checked_camera_view_matrix(eye, target, up)?;

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
        checked_camera_view_matrix(self.eye, self.target, self.up)
            .expect("validated perspective camera view remains representable")
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

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OrthographicCamera {
    pub eye: Vec3,
    pub target: Vec3,
    pub up: Vec3,
    pub left: f32,
    pub right: f32,
    pub bottom: f32,
    pub top: f32,
    pub near: f32,
    pub far: f32,
}

impl OrthographicCamera {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        eye: Vec3,
        target: Vec3,
        up: Vec3,
        left: f32,
        right: f32,
        bottom: f32,
        top: f32,
        near: f32,
        far: f32,
    ) -> Result<Self, CameraError> {
        validate_depth_range(near, far)?;
        checked_camera_view_matrix(eye, target, up)?;
        checked_orthographic_projection_matrix(left, right, bottom, top, near, far)?;

        Ok(Self {
            eye,
            target,
            up,
            left,
            right,
            bottom,
            top,
            near,
            far,
        })
    }

    pub fn view_matrix(self) -> Mat4 {
        checked_camera_view_matrix(self.eye, self.target, self.up)
            .expect("validated orthographic camera view remains representable")
    }

    pub fn projection_matrix(self) -> Mat4 {
        checked_orthographic_projection_matrix(
            self.left,
            self.right,
            self.bottom,
            self.top,
            self.near,
            self.far,
        )
        .expect("validated orthographic projection remains representable")
    }

    pub fn view_projection_matrix(self) -> Mat4 {
        self.projection_matrix() * self.view_matrix()
    }
}

fn validate_depth_range(near: f32, far: f32) -> Result<(), CameraError> {
    if !near.is_finite() || !far.is_finite() || near <= 0.0 || far <= near {
        return Err(CameraError::InvalidDepthRange);
    }
    Ok(())
}

fn checked_orthographic_projection_matrix(
    left: f32,
    right: f32,
    bottom: f32,
    top: f32,
    near: f32,
    far: f32,
) -> Result<Mat4, CameraError> {
    if !left.is_finite()
        || !right.is_finite()
        || !bottom.is_finite()
        || !top.is_finite()
        || left >= right
        || bottom >= top
    {
        return Err(CameraError::InvalidOrthographicBounds);
    }

    let left = f64::from(left);
    let right = f64::from(right);
    let bottom = f64::from(bottom);
    let top = f64::from(top);
    let near = f64::from(near);
    let far = f64::from(far);
    let width = right - left;
    let height = top - bottom;
    let depth = near - far;
    let error = CameraError::InvalidOrthographicBounds;

    Ok(Mat4 {
        elements: [
            checked_f32(2.0 / width, error)?,
            0.0,
            0.0,
            0.0,
            0.0,
            checked_f32(2.0 / height, error)?,
            0.0,
            0.0,
            0.0,
            0.0,
            checked_f32(1.0 / depth, error)?,
            0.0,
            checked_f32(-(right + left) / width, error)?,
            checked_f32(-(top + bottom) / height, error)?,
            checked_f32(near / depth, error)?,
            1.0,
        ],
    })
}

#[derive(Debug, Clone, Copy)]
struct Vec3d {
    x: f64,
    y: f64,
    z: f64,
}

impl Vec3d {
    fn from_f32(value: Vec3) -> Self {
        Self {
            x: f64::from(value.x),
            y: f64::from(value.y),
            z: f64::from(value.z),
        }
    }

    fn subtract(self, rhs: Self) -> Self {
        Self {
            x: self.x - rhs.x,
            y: self.y - rhs.y,
            z: self.z - rhs.z,
        }
    }

    fn dot(self, rhs: Self) -> f64 {
        self.x * rhs.x + self.y * rhs.y + self.z * rhs.z
    }

    fn cross(self, rhs: Self) -> Self {
        Self {
            x: self.y * rhs.z - self.z * rhs.y,
            y: self.z * rhs.x - self.x * rhs.z,
            z: self.x * rhs.y - self.y * rhs.x,
        }
    }

    fn length(self) -> f64 {
        self.dot(self).sqrt()
    }

    fn normalized(self, error: CameraError) -> Result<Self, CameraError> {
        let length = self.length();
        if !length.is_finite() || length <= f64::EPSILON {
            return Err(error);
        }
        Ok(Self {
            x: self.x / length,
            y: self.y / length,
            z: self.z / length,
        })
    }
}

fn checked_camera_view_matrix(eye: Vec3, target: Vec3, up: Vec3) -> Result<Mat4, CameraError> {
    if !finite_vec3(eye) || !finite_vec3(target) {
        return Err(CameraError::InvalidViewDirection);
    }
    if !finite_vec3(up) {
        return Err(CameraError::InvalidUpVector);
    }

    let eye = Vec3d::from_f32(eye);
    let target = Vec3d::from_f32(target);
    let up_input = Vec3d::from_f32(up).normalized(CameraError::InvalidUpVector)?;
    let forward = target
        .subtract(eye)
        .normalized(CameraError::InvalidViewDirection)?;
    let right_unnormalized = forward.cross(up_input);
    if right_unnormalized.length() <= DIRECTION_EPSILON {
        return Err(CameraError::InvalidUpVector);
    }
    let right = right_unnormalized.normalized(CameraError::InvalidUpVector)?;
    let up = right.cross(forward);
    let error = CameraError::InvalidViewDirection;

    Ok(Mat4 {
        elements: [
            checked_f32(right.x, error)?,
            checked_f32(up.x, error)?,
            checked_f32(-forward.x, error)?,
            0.0,
            checked_f32(right.y, error)?,
            checked_f32(up.y, error)?,
            checked_f32(-forward.y, error)?,
            0.0,
            checked_f32(right.z, error)?,
            checked_f32(up.z, error)?,
            checked_f32(-forward.z, error)?,
            0.0,
            checked_f32(-right.dot(eye), error)?,
            checked_f32(-up.dot(eye), error)?,
            checked_f32(forward.dot(eye), error)?,
            1.0,
        ],
    })
}

fn checked_f32(value: f64, error: CameraError) -> Result<f32, CameraError> {
    if !value.is_finite() || value.abs() > f64::from(f32::MAX) {
        return Err(error);
    }
    Ok(value as f32)
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

    fn orthographic_camera() -> OrthographicCamera {
        OrthographicCamera::new(
            Vec3::new(4.0, 5.0, 4.0),
            Vec3::ZERO,
            Vec3::new(0.0, 1.0, 0.0),
            -4.0,
            4.0,
            -3.0,
            3.0,
            0.1,
            100.0,
        )
        .expect("test orthographic camera is valid")
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
    fn orthographic_view_matrix_maps_eye_to_origin() {
        let camera = orthographic_camera();
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
    fn orthographic_projection_maps_view_volume_to_webgpu_clip_space() {
        let camera = orthographic_camera();
        let matrix = camera.projection_matrix().elements;

        let project_x = |view_x: f32| matrix[0] * view_x + matrix[12];
        let project_y = |view_y: f32| matrix[5] * view_y + matrix[13];
        let project_z = |view_z: f32| matrix[10] * view_z + matrix[14];

        assert!((project_x(camera.left) + 1.0).abs() <= EPSILON);
        assert!((project_x(camera.right) - 1.0).abs() <= EPSILON);
        assert!((project_y(camera.bottom) + 1.0).abs() <= EPSILON);
        assert!((project_y(camera.top) - 1.0).abs() <= EPSILON);
        assert!(project_z(-camera.near).abs() <= EPSILON);
        assert!((project_z(-camera.far) - 1.0).abs() <= EPSILON);
    }

    #[test]
    fn finite_extreme_orthographic_bounds_produce_finite_projection() {
        let camera = OrthographicCamera::new(
            Vec3::new(4.0, 5.0, 4.0),
            Vec3::ZERO,
            Vec3::new(0.0, 1.0, 0.0),
            2.0e38,
            3.0e38,
            -3.0,
            3.0,
            0.1,
            100.0,
        )
        .expect("finite representable bounds remain valid");

        assert!(
            camera
                .projection_matrix()
                .elements
                .into_iter()
                .all(f32::is_finite)
        );
    }

    #[test]
    fn extreme_opposite_view_coordinates_remain_finite() {
        let camera = PerspectiveCamera::new(
            Vec3::new(-f32::MAX, 0.0, 0.0),
            Vec3::new(f32::MAX, 0.0, 0.0),
            Vec3::new(0.0, 1.0, 0.0),
            core::f32::consts::FRAC_PI_3,
            1.0,
            0.1,
            100.0,
        )
        .expect("wide finite view direction remains representable");

        assert!(camera.view_matrix().elements.into_iter().all(f32::is_finite));
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

    #[test]
    fn rejects_degenerate_orthographic_bounds() {
        let result = OrthographicCamera::new(
            Vec3::new(4.0, 5.0, 4.0),
            Vec3::ZERO,
            Vec3::new(0.0, 1.0, 0.0),
            2.0,
            2.0,
            -3.0,
            3.0,
            0.1,
            100.0,
        );

        assert_eq!(result, Err(CameraError::InvalidOrthographicBounds));
    }
}
