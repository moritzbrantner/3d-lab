//! Renderer-independent spatial interoperability contracts.
//!
//! This crate owns the small, reusable 3D contract needed to bind media selectors to
//! reconstruction-space points and camera poses. It deliberately does not own COLMAP parsing,
//! reconstruction, rendering, media annotations, GIS, or application state.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

pub const SPATIAL_ANNOTATION_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpatialError(String);

impl SpatialError {
    fn invalid(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for SpatialError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for SpatialError {}

pub type Result<T> = std::result::Result<T, SpatialError>;

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
            return Err(SpatialError::invalid("vector components must be finite"));
        }
        let length = self.length();
        if !length.is_finite() || length <= f64::EPSILON {
            return Err(SpatialError::invalid(
                "vector length must be finite and greater than zero",
            ));
        }
        Ok(Self::new(self.x / length, self.y / length, self.z / length))
    }

    pub const fn to_array(self) -> [f64; 3] {
        [self.x, self.y, self.z]
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

    /// Converts COLMAP's world-to-camera quaternion/translation into the canonical
    /// workspace camera pose used by the spatial contract.
    pub fn from_colmap_world_to_camera(
        qw: f64,
        qx: f64,
        qy: f64,
        qz: f64,
        tx: f64,
        ty: f64,
        tz: f64,
    ) -> Result<Self> {
        for (name, value) in [
            ("qw", qw),
            ("qx", qx),
            ("qy", qy),
            ("qz", qz),
            ("tx", tx),
            ("ty", ty),
            ("tz", tz),
        ] {
            if !value.is_finite() {
                return Err(SpatialError::invalid(format!("{name} must be finite")));
            }
        }

        let norm = qw
            .mul_add(qw, qx.mul_add(qx, qy.mul_add(qy, qz * qz)))
            .sqrt();
        if !norm.is_finite() || norm <= f64::EPSILON {
            return Err(SpatialError::invalid(
                "COLMAP quaternion norm must be greater than zero",
            ));
        }
        let qw = qw / norm;
        let qx = qx / norm;
        let qy = qy / norm;
        let qz = qz / norm;

        let rows = [
            [
                1.0 - 2.0 * (qy * qy + qz * qz),
                2.0 * (qx * qy - qz * qw),
                2.0 * (qx * qz + qy * qw),
            ],
            [
                2.0 * (qx * qy + qz * qw),
                1.0 - 2.0 * (qx * qx + qz * qz),
                2.0 * (qy * qz - qx * qw),
            ],
            [
                2.0 * (qx * qz - qy * qw),
                2.0 * (qy * qz + qx * qw),
                1.0 - 2.0 * (qx * qx + qy * qy),
            ],
        ];
        let translation = [tx, ty, tz];

        // Camera center C = -R^T t.
        let position = Point3d::new(
            -(rows[0][0] * translation[0]
                + rows[1][0] * translation[1]
                + rows[2][0] * translation[2]),
            -(rows[0][1] * translation[0]
                + rows[1][1] * translation[1]
                + rows[2][1] * translation[2]),
            -(rows[0][2] * translation[0]
                + rows[1][2] * translation[1]
                + rows[2][2] * translation[2]),
        );

        Self::new(
            position,
            Vector3d::new(rows[0][0], rows[0][1], rows[0][2]),
            Vector3d::new(rows[1][0], rows[1][1], rows[1][2]),
            Vector3d::new(rows[2][0], rows[2][1], rows[2][2]),
        )
    }

    pub fn validate(self) -> Result<()> {
        if !self.position.is_finite()
            || !self.right.is_finite()
            || !self.up.is_finite()
            || !self.forward.is_finite()
        {
            return Err(SpatialError::invalid(
                "camera pose values must all be finite",
            ));
        }
        const EPSILON: f64 = 1.0e-9;
        for (name, axis) in [
            ("right", self.right),
            ("up", self.up),
            ("forward", self.forward),
        ] {
            if (axis.length() - 1.0).abs() > EPSILON {
                return Err(SpatialError::invalid(format!(
                    "camera {name} axis must be unit length"
                )));
            }
        }
        if self.right.dot(self.up).abs() > EPSILON
            || self.right.dot(self.forward).abs() > EPSILON
            || self.up.dot(self.forward).abs() > EPSILON
        {
            return Err(SpatialError::invalid(
                "camera basis axes must be mutually orthogonal",
            ));
        }
        let handedness = self.right.cross(self.up).dot(self.forward);
        if (handedness - 1.0).abs() > EPSILON {
            return Err(SpatialError::invalid("camera basis must be right-handed"));
        }
        Ok(())
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
            return Err(SpatialError::invalid(
                "pinhole image dimensions must be greater than zero",
            ));
        }
        if !self.fx.is_finite()
            || !self.fy.is_finite()
            || !self.cx.is_finite()
            || !self.cy.is_finite()
        {
            return Err(SpatialError::invalid("pinhole intrinsics must be finite"));
        }
        if self.fx <= 0.0 || self.fy <= 0.0 {
            return Err(SpatialError::invalid(
                "pinhole focal lengths must be greater than zero",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinateFrameKind {
    Local,
    Geographic,
    Camera,
    Image,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CoordinateUnit {
    Meter,
    Centimeter,
    Millimeter,
    Pixel,
    Degree,
    Unitless,
    Arbitrary,
}

impl CoordinateUnit {
    pub const fn supports_cartesian_3d(self) -> bool {
        !matches!(self, Self::Pixel | Self::Degree)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinateFrameRef {
    pub id: String,
    pub kind: CoordinateFrameKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unit: Option<CoordinateUnit>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub axis_convention: Option<String>,
}

impl CoordinateFrameRef {
    pub fn new(id: impl Into<String>, kind: CoordinateFrameKind) -> Result<Self> {
        let value = Self {
            id: id.into(),
            kind,
            unit: None,
            axis_convention: None,
        };
        value.validate()?;
        Ok(value)
    }

    pub fn local(id: impl Into<String>) -> Result<Self> {
        Self::new(id, CoordinateFrameKind::Local)
    }

    pub fn unit(mut self, unit: CoordinateUnit) -> Self {
        self.unit = Some(unit);
        self
    }

    pub fn axis_convention(mut self, convention: impl Into<String>) -> Result<Self> {
        let convention = convention.into();
        validate_non_empty(&convention, "axis convention")?;
        self.axis_convention = Some(convention);
        Ok(self)
    }

    pub fn validate(&self) -> Result<()> {
        validate_non_empty(&self.id, "coordinate frame id")?;
        if let Some(convention) = &self.axis_convention {
            validate_non_empty(convention, "axis convention")?;
        }
        Ok(())
    }

    pub fn validate_cartesian_3d(&self) -> Result<()> {
        self.validate()?;
        if matches!(self.kind, CoordinateFrameKind::Geographic) {
            return Err(SpatialError::invalid(
                "geographic frames cannot be used as Cartesian 3D coordinate frames",
            ));
        }
        if matches!(self.kind, CoordinateFrameKind::Image) {
            return Err(SpatialError::invalid(
                "image frames cannot be used as Cartesian 3D coordinate frames",
            ));
        }
        if self.unit.is_some_and(|unit| !unit.supports_cartesian_3d()) {
            return Err(SpatialError::invalid(
                "pixel and degree units cannot be used for Cartesian 3D coordinate frames",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpatialUncertainty {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linear_radius: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub angular_radians: Option<f64>,
}

impl SpatialUncertainty {
    pub fn validate(self) -> Result<()> {
        validate_optional_non_negative(self.linear_radius, "linear_radius")?;
        validate_optional_non_negative(self.angular_radians, "angular_radians")
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpatialEntityRef {
    pub namespace: String,
    pub entity_kind: String,
    pub entity_id: String,
}

impl SpatialEntityRef {
    pub fn new(
        namespace: impl Into<String>,
        entity_kind: impl Into<String>,
        entity_id: impl Into<String>,
    ) -> Result<Self> {
        let value = Self {
            namespace: namespace.into(),
            entity_kind: entity_kind.into(),
            entity_id: entity_id.into(),
        };
        value.validate()?;
        Ok(value)
    }

    pub fn validate(&self) -> Result<()> {
        validate_non_empty(&self.namespace, "spatial entity namespace")?;
        validate_non_empty(&self.entity_kind, "spatial entity kind")?;
        validate_non_empty(&self.entity_id, "spatial entity id")
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum SpatialSelector {
    Point3 {
        frame: CoordinateFrameRef,
        point: Point3d,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        uncertainty: Option<SpatialUncertainty>,
    },
    CameraPose {
        frame: CoordinateFrameRef,
        pose: CameraPose3d,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        intrinsics: Option<PinholeIntrinsicsd>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        calibration_ref: Option<SpatialEntityRef>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        uncertainty: Option<SpatialUncertainty>,
    },
}

impl SpatialSelector {
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::Point3 {
                frame,
                point,
                uncertainty,
            } => {
                frame.validate_cartesian_3d()?;
                if !point.is_finite() {
                    return Err(SpatialError::invalid(
                        "spatial point coordinates must be finite",
                    ));
                }
                if let Some(uncertainty) = uncertainty {
                    uncertainty.validate()?;
                }
            }
            Self::CameraPose {
                frame,
                pose,
                intrinsics,
                calibration_ref,
                uncertainty,
            } => {
                frame.validate_cartesian_3d()?;
                pose.validate()?;
                if let Some(intrinsics) = intrinsics {
                    intrinsics.validate()?;
                }
                if let Some(reference) = calibration_ref {
                    reference.validate()?;
                }
                if let Some(uncertainty) = uncertainty {
                    uncertainty.validate()?;
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpatialBinding {
    pub schema_version: u32,
    pub spatial: SpatialSelector,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_selector: Option<Value>,
}

impl SpatialBinding {
    pub fn new(spatial: SpatialSelector) -> Result<Self> {
        let value = Self {
            schema_version: SPATIAL_ANNOTATION_SCHEMA_VERSION,
            spatial,
            source_selector: None,
        };
        value.validate()?;
        Ok(value)
    }

    pub fn with_source_selector<T: Serialize>(mut self, selector: T) -> Result<Self> {
        let selector = serde_json::to_value(selector).map_err(|error| {
            SpatialError::invalid(format!(
                "could not serialize spatial source selector: {error}"
            ))
        })?;
        if selector.is_null() {
            return Err(SpatialError::invalid(
                "spatial source selector must not serialize to null",
            ));
        }
        self.source_selector = Some(selector);
        self.validate()?;
        Ok(self)
    }

    pub fn source_selector_as<T: DeserializeOwned>(&self) -> Result<Option<T>> {
        self.source_selector
            .as_ref()
            .map(|selector| {
                serde_json::from_value(selector.clone()).map_err(|error| {
                    SpatialError::invalid(format!(
                        "could not deserialize spatial source selector: {error}"
                    ))
                })
            })
            .transpose()
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != SPATIAL_ANNOTATION_SCHEMA_VERSION {
            return Err(SpatialError::invalid(format!(
                "unsupported spatial annotation schema version {}",
                self.schema_version
            )));
        }
        self.spatial.validate()?;
        if self.source_selector.as_ref().is_some_and(Value::is_null) {
            return Err(SpatialError::invalid(
                "spatial source selector must not be null when present",
            ));
        }
        Ok(())
    }
}

fn validate_non_empty(value: &str, field: &str) -> Result<()> {
    if value.trim().is_empty() {
        Err(SpatialError::invalid(format!("{field} must not be empty")))
    } else {
        Ok(())
    }
}

fn validate_optional_non_negative(value: Option<f64>, field: &str) -> Result<()> {
    if value.is_some_and(|value| !value.is_finite() || value < 0.0) {
        Err(SpatialError::invalid(format!(
            "{field} must be finite and non-negative when present"
        )))
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "kind", rename_all = "snake_case")]
    enum ExampleSelector {
        Frame {
            #[serde(rename = "frameIndex")]
            frame_index: u64,
        },
    }

    fn scene_frame() -> CoordinateFrameRef {
        CoordinateFrameRef::local("colmap-world")
            .unwrap()
            .unit(CoordinateUnit::Arbitrary)
    }

    #[test]
    fn preserves_colmap_camera_convention() {
        let pose = CameraPose3d::from_colmap_world_to_camera(1.0, 0.0, 0.0, 0.0, 1.25, -2.5, 3.75)
            .unwrap();
        assert_eq!(pose.position, Point3d::new(-1.25, 2.5, -3.75));
        assert_eq!(pose.right, Vector3d::X);
        assert_eq!(pose.up, Vector3d::Y);
        assert_eq!(pose.forward, Vector3d::Z);
    }

    #[test]
    fn spatial_binding_keeps_v1_wire_shape_and_typed_selector_round_trip() {
        let pose = CameraPose3d::from_colmap_world_to_camera(
            0.9238795325112867,
            0.0,
            0.3826834323650898,
            0.0,
            0.0,
            0.0,
            2.0,
        )
        .unwrap();
        let binding = SpatialBinding::new(SpatialSelector::CameraPose {
            frame: scene_frame(),
            pose,
            intrinsics: Some(
                PinholeIntrinsicsd::new(1920, 1080, 1400.5, 1401.25, 959.75, 539.25).unwrap(),
            ),
            calibration_ref: Some(SpatialEntityRef::new("colmap", "camera", "7").unwrap()),
            uncertainty: None,
        })
        .unwrap()
        .with_source_selector(ExampleSelector::Frame { frame_index: 42 })
        .unwrap();

        assert_eq!(
            binding.source_selector_as::<ExampleSelector>().unwrap(),
            Some(ExampleSelector::Frame { frame_index: 42 })
        );

        let encoded = serde_json::to_value(&binding).unwrap();
        assert_eq!(encoded["schemaVersion"], 1);
        assert_eq!(encoded["spatial"]["kind"], "camera_pose");
        assert_eq!(encoded["spatial"]["frame"]["unit"], "arbitrary");
        assert_eq!(encoded["spatial"]["calibrationRef"]["entityId"], "7");
        assert!(encoded["spatial"].get("calibration_ref").is_none());
        let decoded: SpatialBinding = serde_json::from_value(encoded).unwrap();
        assert_eq!(decoded, binding);
    }

    #[test]
    fn point_binding_rejects_non_cartesian_frames_and_non_finite_points() {
        let image = CoordinateFrameRef::new("image", CoordinateFrameKind::Image)
            .unwrap()
            .unit(CoordinateUnit::Pixel);
        assert!(
            SpatialBinding::new(SpatialSelector::Point3 {
                frame: image,
                point: Point3d::new(0.0, 0.0, 0.0),
                uncertainty: None,
            })
            .is_err()
        );
        assert!(
            SpatialBinding::new(SpatialSelector::Point3 {
                frame: scene_frame(),
                point: Point3d::new(f64::NAN, 0.0, 0.0),
                uncertainty: None,
            })
            .is_err()
        );
    }
}
