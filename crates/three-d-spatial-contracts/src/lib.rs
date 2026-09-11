//! Versioned renderer-independent spatial interchange contracts.
//!
//! This crate deliberately owns serialized spatial bindings, not rendering, reconstruction,
//! collision detection, point-cloud processing, or mesh algorithms.

mod math;

use std::fmt;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use math::{
    CameraPose3d, PinholeIntrinsicsd, Point3d, Quaterniond, RigidTransform3d,
    SimilarityTransform3d, Vector3d,
};

pub const SPATIAL_ANNOTATION_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpatialContractError(String);

impl fmt::Display for SpatialContractError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for SpatialContractError {}

pub type Result<T> = std::result::Result<T, SpatialContractError>;

pub(crate) fn invalid(message: impl Into<String>) -> SpatialContractError {
    SpatialContractError(message.into())
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
    pub const fn metric_meters_per_unit(self) -> Option<f64> {
        match self {
            Self::Meter => Some(1.0),
            Self::Centimeter => Some(0.01),
            Self::Millimeter => Some(0.001),
            Self::Pixel | Self::Degree | Self::Unitless | Self::Arbitrary => None,
        }
    }

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
            return Err(invalid(
                "geographic frames cannot be used as Cartesian 3D coordinate frames",
            ));
        }
        if matches!(self.kind, CoordinateFrameKind::Image) {
            return Err(invalid(
                "image frames cannot be used as Cartesian 3D coordinate frames",
            ));
        }
        if self.unit.is_some_and(|unit| !unit.supports_cartesian_3d()) {
            return Err(invalid(
                "pixel and degree units cannot be used for Cartesian 3D coordinate frames",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoordinateFrameTransform3d {
    pub from: CoordinateFrameRef,
    pub to: CoordinateFrameRef,
    pub transform: SimilarityTransform3d,
}

impl CoordinateFrameTransform3d {
    pub fn new(
        from: CoordinateFrameRef,
        to: CoordinateFrameRef,
        transform: SimilarityTransform3d,
    ) -> Result<Self> {
        let transform = SimilarityTransform3d::new(
            transform.translation,
            transform.rotation,
            transform.scale,
        )?;
        let value = Self {
            from,
            to,
            transform,
        };
        value.validate()?;
        Ok(value)
    }

    pub fn validate(&self) -> Result<()> {
        self.from.validate_cartesian_3d()?;
        self.to.validate_cartesian_3d()?;
        if self.from.id == self.to.id {
            return Err(invalid(
                "coordinate frame transform must reference two different frame ids",
            ));
        }
        SimilarityTransform3d::new(
            self.transform.translation,
            self.transform.rotation,
            self.transform.scale,
        )?;
        if let (Some(from_meters), Some(to_meters)) = (
            self.from
                .unit
                .and_then(CoordinateUnit::metric_meters_per_unit),
            self.to
                .unit
                .and_then(CoordinateUnit::metric_meters_per_unit),
        ) {
            let expected_scale = from_meters / to_meters;
            if !approximately_equal(self.transform.scale.abs(), expected_scale) {
                return Err(invalid(format!(
                    "transform scale magnitude {} contradicts metric frame units, expected {expected_scale}",
                    self.transform.scale.abs()
                )));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeographicPosition {
    pub longitude_degrees: f64,
    pub latitude_degrees: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub altitude_meters: Option<f64>,
}

impl GeographicPosition {
    pub fn new(
        longitude_degrees: f64,
        latitude_degrees: f64,
        altitude_meters: Option<f64>,
    ) -> Result<Self> {
        let value = Self {
            longitude_degrees,
            latitude_degrees,
            altitude_meters,
        };
        value.validate()?;
        Ok(value)
    }

    pub fn validate(self) -> Result<()> {
        if !self.longitude_degrees.is_finite()
            || !(-180.0..=180.0).contains(&self.longitude_degrees)
        {
            return Err(invalid(
                "longitude_degrees must be finite and in [-180, 180]",
            ));
        }
        if !self.latitude_degrees.is_finite()
            || !(-90.0..=90.0).contains(&self.latitude_degrees)
        {
            return Err(invalid(
                "latitude_degrees must be finite and in [-90, 90]",
            ));
        }
        if self.altitude_meters.is_some_and(|value| !value.is_finite()) {
            return Err(invalid(
                "altitude_meters must be finite when present",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GeographicTangentFrame {
    EastNorthUp,
    NorthEastDown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeographicFrameAnchor {
    pub frame: CoordinateFrameRef,
    pub origin: GeographicPosition,
    pub tangent_frame: GeographicTangentFrame,
    pub orientation: Quaterniond,
    pub meters_per_unit: f64,
}

impl GeographicFrameAnchor {
    pub fn new(
        frame: CoordinateFrameRef,
        origin: GeographicPosition,
        tangent_frame: GeographicTangentFrame,
        orientation: Quaterniond,
        meters_per_unit: f64,
    ) -> Result<Self> {
        let value = Self {
            frame,
            origin,
            tangent_frame,
            orientation: orientation.normalize()?,
            meters_per_unit,
        };
        value.validate()?;
        Ok(value)
    }

    pub fn validate(&self) -> Result<()> {
        self.frame.validate_cartesian_3d()?;
        self.origin.validate()?;
        self.orientation.normalize()?;
        if !self.meters_per_unit.is_finite() || self.meters_per_unit <= 0.0 {
            return Err(invalid(
                "meters_per_unit must be finite and greater than zero",
            ));
        }
        if let Some(expected) = self
            .frame
            .unit
            .and_then(CoordinateUnit::metric_meters_per_unit)
            && !approximately_equal(self.meters_per_unit, expected)
        {
            return Err(invalid(format!(
                "meters_per_unit {} contradicts declared frame unit {:?}, expected {expected}",
                self.meters_per_unit, self.frame.unit
            )));
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
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SpatialSelector {
    Point3 {
        frame: CoordinateFrameRef,
        point: Point3d,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        uncertainty: Option<SpatialUncertainty>,
    },
    Box3 {
        frame: CoordinateFrameRef,
        min: Point3d,
        max: Point3d,
    },
    Sphere3 {
        frame: CoordinateFrameRef,
        center: Point3d,
        radius: f64,
    },
    Pose3 {
        frame: CoordinateFrameRef,
        pose: RigidTransform3d,
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
    GeographicPoint {
        position: GeographicPosition,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        horizontal_accuracy_meters: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        vertical_accuracy_meters: Option<f64>,
    },
    Entity {
        entity: SpatialEntityRef,
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
                    return Err(invalid("spatial point coordinates must be finite"));
                }
                if let Some(uncertainty) = uncertainty {
                    uncertainty.validate()?;
                }
            }
            Self::Box3 { frame, min, max } => {
                frame.validate_cartesian_3d()?;
                if !min.is_finite() || !max.is_finite() {
                    return Err(invalid("spatial box coordinates must be finite"));
                }
                if min.x > max.x || min.y > max.y || min.z > max.z {
                    return Err(invalid(
                        "spatial box min coordinates must not exceed max coordinates",
                    ));
                }
            }
            Self::Sphere3 {
                frame,
                center,
                radius,
            } => {
                frame.validate_cartesian_3d()?;
                if !center.is_finite() {
                    return Err(invalid("spatial sphere center must be finite"));
                }
                if !radius.is_finite() || *radius <= 0.0 {
                    return Err(invalid(
                        "spatial sphere radius must be finite and greater than zero",
                    ));
                }
            }
            Self::Pose3 {
                frame,
                pose,
                uncertainty,
            } => {
                frame.validate_cartesian_3d()?;
                RigidTransform3d::new(pose.rotation, pose.translation)?;
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
                if let Some(calibration_ref) = calibration_ref {
                    calibration_ref.validate()?;
                }
                if let Some(uncertainty) = uncertainty {
                    uncertainty.validate()?;
                }
            }
            Self::GeographicPoint {
                position,
                horizontal_accuracy_meters,
                vertical_accuracy_meters,
            } => {
                position.validate()?;
                validate_optional_non_negative(
                    *horizontal_accuracy_meters,
                    "horizontal_accuracy_meters",
                )?;
                validate_optional_non_negative(
                    *vertical_accuracy_meters,
                    "vertical_accuracy_meters",
                )?;
            }
            Self::Entity { entity } => entity.validate()?,
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
        let selector = serde_json::to_value(selector)
            .map_err(|error| invalid(format!("could not serialize spatial source selector: {error}")))?;
        if selector.is_null() {
            return Err(invalid("spatial source selector must not serialize to null"));
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
                    invalid(format!(
                        "could not deserialize spatial source selector: {error}"
                    ))
                })
            })
            .transpose()
    }

    pub fn validate(&self) -> Result<()> {
        if self.schema_version != SPATIAL_ANNOTATION_SCHEMA_VERSION {
            return Err(invalid(format!(
                "unsupported spatial annotation schema version {}",
                self.schema_version
            )));
        }
        self.spatial.validate()?;
        if self.source_selector.as_ref().is_some_and(Value::is_null) {
            return Err(invalid(
                "spatial source selector must not be null when present",
            ));
        }
        Ok(())
    }
}

fn validate_non_empty(value: &str, field: &str) -> Result<()> {
    if value.trim().is_empty() {
        Err(invalid(format!("{field} must not be empty")))
    } else {
        Ok(())
    }
}

fn validate_optional_non_negative(value: Option<f64>, field: &str) -> Result<()> {
    if value.is_some_and(|value| !value.is_finite() || value < 0.0) {
        Err(invalid(format!(
            "{field} must be finite and non-negative when present"
        )))
    } else {
        Ok(())
    }
}

fn approximately_equal(left: f64, right: f64) -> bool {
    let scale = left.abs().max(right.abs()).max(1.0);
    (left - right).abs() <= 1e-12 * scale
}

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};
    use serde_json::json;

    use super::*;

    fn frame() -> CoordinateFrameRef {
        CoordinateFrameRef::local("colmap-world")
            .expect("frame")
            .unit(CoordinateUnit::Arbitrary)
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(tag = "kind", rename_all = "snake_case")]
    enum SourceSelector {
        Frame {
            #[serde(rename = "frameIndex")]
            frame_index: u64,
        },
    }

    #[test]
    fn point_binding_preserves_schema_v1_wire_shape() {
        let binding = SpatialBinding::new(SpatialSelector::Point3 {
            frame: frame(),
            point: Point3d::new(1.0, 2.0, 3.0),
            uncertainty: None,
        })
        .expect("binding")
        .with_source_selector(SourceSelector::Frame { frame_index: 42 })
        .expect("source selector");

        assert_eq!(
            serde_json::to_value(&binding).expect("serialize"),
            json!({
                "schemaVersion": 1,
                "spatial": {
                    "kind": "point3",
                    "frame": {
                        "id": "colmap-world",
                        "kind": "local",
                        "unit": "arbitrary"
                    },
                    "point": { "x": 1.0, "y": 2.0, "z": 3.0 }
                },
                "sourceSelector": { "kind": "frame", "frameIndex": 42 }
            })
        );
        assert_eq!(
            binding
                .source_selector_as::<SourceSelector>()
                .expect("decode source selector"),
            Some(SourceSelector::Frame { frame_index: 42 })
        );
    }

    #[test]
    fn colmap_camera_binding_round_trips() {
        let pose = CameraPose3d::from_colmap_world_to_camera(
            1.0, 0.0, 0.0, 0.0, 1.25, -2.5, 3.75,
        )
        .expect("pose");
        assert_eq!(pose.position.to_array(), [-1.25, 2.5, -3.75]);
        assert_eq!(pose.right.to_array(), [1.0, 0.0, 0.0]);
        assert_eq!(pose.up.to_array(), [0.0, 1.0, 0.0]);
        assert_eq!(pose.forward.to_array(), [0.0, 0.0, 1.0]);

        let binding = SpatialBinding::new(SpatialSelector::CameraPose {
            frame: frame(),
            pose,
            intrinsics: Some(
                PinholeIntrinsicsd::new(1920, 1080, 1200.0, 1200.0, 960.0, 540.0)
                    .expect("intrinsics"),
            ),
            calibration_ref: Some(
                SpatialEntityRef::new("colmap", "camera", "17").expect("entity ref"),
            ),
            uncertainty: None,
        })
        .expect("camera binding");

        let encoded = serde_json::to_vec(&binding).expect("encode");
        let decoded: SpatialBinding = serde_json::from_slice(&encoded).expect("decode");
        decoded.validate().expect("validate");
        assert_eq!(decoded, binding);
    }

    #[test]
    fn selector_vocabulary_round_trips() {
        let selectors = [
            SpatialSelector::Box3 {
                frame: frame(),
                min: Point3d::new(-1.0, -2.0, -3.0),
                max: Point3d::new(1.0, 2.0, 3.0),
            },
            SpatialSelector::Sphere3 {
                frame: frame(),
                center: Point3d::new(1.0, 2.0, 3.0),
                radius: 4.0,
            },
            SpatialSelector::Pose3 {
                frame: frame(),
                pose: RigidTransform3d::IDENTITY,
                uncertainty: Some(SpatialUncertainty {
                    linear_radius: Some(0.1),
                    angular_radians: Some(0.01),
                }),
            },
            SpatialSelector::GeographicPoint {
                position: GeographicPosition::new(8.68, 50.11, Some(112.5)).expect("position"),
                horizontal_accuracy_meters: Some(3.0),
                vertical_accuracy_meters: None,
            },
            SpatialSelector::Entity {
                entity: SpatialEntityRef::new("scene", "object", "a").expect("entity"),
            },
        ];

        for selector in selectors {
            selector.validate().expect("selector valid");
            let encoded = serde_json::to_vec(&selector).expect("encode");
            let decoded: SpatialSelector = serde_json::from_slice(&encoded).expect("decode");
            assert_eq!(decoded, selector);
        }
    }

    #[test]
    fn binding_rejects_wrong_schema_version() {
        let binding = SpatialBinding {
            schema_version: 2,
            spatial: SpatialSelector::Point3 {
                frame: frame(),
                point: Point3d::new(0.0, 0.0, 0.0),
                uncertainty: None,
            },
            source_selector: None,
        };
        assert!(binding.validate().is_err());
    }

    #[test]
    fn metric_frame_transform_checks_scale() {
        let meters = CoordinateFrameRef::local("meters")
            .expect("frame")
            .unit(CoordinateUnit::Meter);
        let centimeters = CoordinateFrameRef::local("centimeters")
            .expect("frame")
            .unit(CoordinateUnit::Centimeter);
        let transform = SimilarityTransform3d::new(
            Vector3d::ZERO,
            Quaterniond::IDENTITY,
            100.0,
        )
        .expect("transform");
        CoordinateFrameTransform3d::new(meters, centimeters, transform)
            .expect("metric scale must match");
    }
}
