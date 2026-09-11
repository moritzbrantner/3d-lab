use serde::{Deserialize, Serialize};

use crate::{Result, invalid};

const ORTHONORMAL_EPSILON: f64 = 1.0e-9;

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Vector3d {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Vector3d {
    pub const ZERO: Self = Self::new(0.0, 0.0, 0.0);
    pub const X: Self = Self::new(1.0, 0.0, 0.0);
    pub const Y: Self = Self::new(0.0, 1.0, 0.0);
    pub const Z: Self = Self::new(0.0, 0.0, 1.0);

    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    pub fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.z.is_finite()
    }

    pub fn dot(self, rhs: Self) -> f64 {
        self.x.mul_add(rhs.x, self.y.mul_add(rhs.y, self.z * rhs.z))
    }

    pub fn cross(self, rhs: Self) -> Self {
        Self::new(
            self.y.mul_add(rhs.z, -(self.z * rhs.y)),
            self.z.mul_add(rhs.x, -(self.x * rhs.z)),
            self.x.mul_add(rhs.y, -(self.y * rhs.x)),
        )
    }

    pub fn length(self) -> f64 {
        self.dot(self).sqrt()
    }

    pub fn normalize(self) -> Result<Self> {
        if !self.is_finite() {
            return Err(invalid("vector components must be finite"));
        }
        let length = self.length();
        if length <= f64::EPSILON {
            return Err(invalid("vector length must be greater than zero"));
        }
        Ok(self / length)
    }

    pub const fn to_array(self) -> [f64; 3] {
        [self.x, self.y, self.z]
    }
}

impl std::ops::Add for Vector3d {
    type Output = Self;

    fn add(self, rhs: Self) -> Self::Output {
        Self::new(self.x + rhs.x, self.y + rhs.y, self.z + rhs.z)
    }
}

impl std::ops::Sub for Vector3d {
    type Output = Self;

    fn sub(self, rhs: Self) -> Self::Output {
        Self::new(self.x - rhs.x, self.y - rhs.y, self.z - rhs.z)
    }
}

impl std::ops::Mul<f64> for Vector3d {
    type Output = Self;

    fn mul(self, rhs: f64) -> Self::Output {
        Self::new(self.x * rhs, self.y * rhs, self.z * rhs)
    }
}

impl std::ops::Div<f64> for Vector3d {
    type Output = Self;

    fn div(self, rhs: f64) -> Self::Output {
        Self::new(self.x / rhs, self.y / rhs, self.z / rhs)
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct Point3d {
    pub x: f64,
    pub y: f64,
    pub z: f64,
}

impl Point3d {
    pub const fn new(x: f64, y: f64, z: f64) -> Self {
        Self { x, y, z }
    }

    pub fn is_finite(self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.z.is_finite()
    }

    pub const fn to_array(self) -> [f64; 3] {
        [self.x, self.y, self.z]
    }
}

impl std::ops::Add<Vector3d> for Point3d {
    type Output = Self;

    fn add(self, rhs: Vector3d) -> Self::Output {
        Self::new(self.x + rhs.x, self.y + rhs.y, self.z + rhs.z)
    }
}

impl std::ops::Sub<Point3d> for Point3d {
    type Output = Vector3d;

    fn sub(self, rhs: Point3d) -> Self::Output {
        Vector3d::new(self.x - rhs.x, self.y - rhs.y, self.z - rhs.z)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Quaterniond {
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub w: f64,
}

impl Quaterniond {
    pub const IDENTITY: Self = Self::new(0.0, 0.0, 0.0, 1.0);

    pub const fn new(x: f64, y: f64, z: f64, w: f64) -> Self {
        Self { x, y, z, w }
    }

    pub fn normalize(self) -> Result<Self> {
        if ![self.x, self.y, self.z, self.w]
            .into_iter()
            .all(f64::is_finite)
        {
            return Err(invalid("quaternion components must be finite"));
        }
        let norm = self
            .x
            .mul_add(
                self.x,
                self.y
                    .mul_add(self.y, self.z.mul_add(self.z, self.w * self.w)),
            )
            .sqrt();
        if norm <= f64::EPSILON {
            return Err(invalid("quaternion norm must be greater than zero"));
        }
        Ok(Self::new(
            self.x / norm,
            self.y / norm,
            self.z / norm,
            self.w / norm,
        ))
    }

    pub fn rotate_vector(self, vector: Vector3d) -> Result<Vector3d> {
        let q = self.normalize()?;
        if !vector.is_finite() {
            return Err(invalid("vector components must be finite"));
        }
        let u = Vector3d::new(q.x, q.y, q.z);
        let uv = u.cross(vector);
        let uuv = u.cross(uv);
        Ok(vector + uv * (2.0 * q.w) + uuv * 2.0)
    }

    fn rotation_rows(self) -> Result<[[f64; 3]; 3]> {
        let q = self.normalize()?;
        let xx = q.x * q.x;
        let yy = q.y * q.y;
        let zz = q.z * q.z;
        let xy = q.x * q.y;
        let xz = q.x * q.z;
        let yz = q.y * q.z;
        let wx = q.w * q.x;
        let wy = q.w * q.y;
        let wz = q.w * q.z;
        Ok([
            [1.0 - 2.0 * (yy + zz), 2.0 * (xy - wz), 2.0 * (xz + wy)],
            [2.0 * (xy + wz), 1.0 - 2.0 * (xx + zz), 2.0 * (yz - wx)],
            [2.0 * (xz - wy), 2.0 * (yz + wx), 1.0 - 2.0 * (xx + yy)],
        ])
    }
}

impl Default for Quaterniond {
    fn default() -> Self {
        Self::IDENTITY
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RigidTransform3d {
    pub rotation: Quaterniond,
    pub translation: Vector3d,
}

impl RigidTransform3d {
    pub const IDENTITY: Self = Self {
        rotation: Quaterniond::IDENTITY,
        translation: Vector3d::ZERO,
    };

    pub fn new(rotation: Quaterniond, translation: Vector3d) -> Result<Self> {
        if !translation.is_finite() {
            return Err(invalid("translation components must be finite"));
        }
        Ok(Self {
            rotation: rotation.normalize()?,
            translation,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SimilarityTransform3d {
    pub translation: Vector3d,
    pub rotation: Quaterniond,
    pub scale: f64,
}

impl SimilarityTransform3d {
    pub const IDENTITY: Self = Self {
        translation: Vector3d::ZERO,
        rotation: Quaterniond::IDENTITY,
        scale: 1.0,
    };

    pub fn new(translation: Vector3d, rotation: Quaterniond, scale: f64) -> Result<Self> {
        if !translation.is_finite() {
            return Err(invalid("translation components must be finite"));
        }
        if !scale.is_finite() || scale == 0.0 {
            return Err(invalid("scale must be finite and non-zero"));
        }
        Ok(Self {
            translation,
            rotation: rotation.normalize()?,
            scale,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PinholeIntrinsicsd {
    pub width: u32,
    pub height: u32,
    pub fx: f64,
    pub fy: f64,
    pub cx: f64,
    pub cy: f64,
}

impl PinholeIntrinsicsd {
    pub fn new(width: u32, height: u32, fx: f64, fy: f64, cx: f64, cy: f64) -> Result<Self> {
        let value = Self {
            width,
            height,
            fx,
            fy,
            cx,
            cy,
        };
        value.validate()?;
        Ok(value)
    }

    pub fn validate(self) -> Result<()> {
        if self.width == 0 || self.height == 0 {
            return Err(invalid("camera dimensions must be positive"));
        }
        if ![self.fx, self.fy, self.cx, self.cy]
            .into_iter()
            .all(f64::is_finite)
        {
            return Err(invalid("camera intrinsics must be finite"));
        }
        if self.fx <= 0.0 || self.fy <= 0.0 {
            return Err(invalid("camera focal lengths must be positive"));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CameraPose3d {
    pub position: Point3d,
    pub right: Vector3d,
    pub up: Vector3d,
    pub forward: Vector3d,
}

impl CameraPose3d {
    pub fn new(
        position: Point3d,
        right: Vector3d,
        up: Vector3d,
        forward: Vector3d,
    ) -> Result<Self> {
        let value = Self {
            position,
            right: right.normalize()?,
            up: up.normalize()?,
            forward: forward.normalize()?,
        };
        value.validate()?;
        Ok(value)
    }

    pub fn from_colmap_world_to_camera(
        qw: f64,
        qx: f64,
        qy: f64,
        qz: f64,
        tx: f64,
        ty: f64,
        tz: f64,
    ) -> Result<Self> {
        if ![qw, qx, qy, qz, tx, ty, tz]
            .into_iter()
            .all(f64::is_finite)
        {
            return Err(invalid("COLMAP pose values must be finite"));
        }
        let matrix = Quaterniond::new(qx, qy, qz, qw).rotation_rows()?;
        let translation = Vector3d::new(tx, ty, tz);
        let position = Point3d::new(
            -(matrix[0][0] * translation.x
                + matrix[1][0] * translation.y
                + matrix[2][0] * translation.z),
            -(matrix[0][1] * translation.x
                + matrix[1][1] * translation.y
                + matrix[2][1] * translation.z),
            -(matrix[0][2] * translation.x
                + matrix[1][2] * translation.y
                + matrix[2][2] * translation.z),
        );
        Self::new(
            position,
            Vector3d::new(matrix[0][0], matrix[0][1], matrix[0][2]),
            Vector3d::new(matrix[1][0], matrix[1][1], matrix[1][2]),
            Vector3d::new(matrix[2][0], matrix[2][1], matrix[2][2]),
        )
    }

    pub fn validate(self) -> Result<()> {
        if !self.position.is_finite() {
            return Err(invalid("camera position must be finite"));
        }
        validate_orthonormal(self.right, self.up, self.forward)
    }
}

fn validate_orthonormal(right: Vector3d, up: Vector3d, forward: Vector3d) -> Result<()> {
    for (name, axis) in [("right", right), ("up", up), ("forward", forward)] {
        if !axis.is_finite() {
            return Err(invalid(format!("axis {name} must be finite")));
        }
        if (axis.length() - 1.0).abs() > ORTHONORMAL_EPSILON {
            return Err(invalid(format!("axis {name} must be normalized")));
        }
    }
    if right.dot(up).abs() > ORTHONORMAL_EPSILON
        || right.dot(forward).abs() > ORTHONORMAL_EPSILON
        || up.dot(forward).abs() > ORTHONORMAL_EPSILON
    {
        return Err(invalid("axes must be orthogonal"));
    }
    Ok(())
}
