export type AdvancedInterpolation = "linear" | "smooth";

export type AdvancedLessonState = {
  matrixAngle: number;
  hierarchyAngle: number;
  keyframeTime: number;
  keyframeInterpolation: AdvancedInterpolation;
  keyframePlaying: boolean;
  rotationT: number;
  skeletonBend: number;
  gltfPlaying: boolean;
};

export const DEFAULT_ADVANCED_STATE: AdvancedLessonState = {
  matrixAngle: 35,
  hierarchyAngle: 35,
  keyframeTime: 0.8,
  keyframeInterpolation: "linear",
  keyframePlaying: false,
  rotationT: 0.55,
  skeletonBend: 32,
  gltfPlaying: true,
};

export const KEYFRAME_TIMES = [0, 1, 2] as const;
export const KEYFRAME_POSITIONS = [
  [-1.25, -0.45, 0],
  [0, 0.95, 0],
  [1.25, -0.45, 0],
] as const;

const ANIMATION_BUFFER = "AAAAAAAAgD8AAABAAAAAAAAAAAAAAAAAAAAAAAAAgD8AAAAAAAAAAAAAAAAAAAAA";

export const MINIMAL_ANIMATED_GLTF = JSON.stringify({
  asset: { version: "2.0", generator: "3d-lab" },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: "AnimatedNode" }],
  buffers: [
    {
      byteLength: 48,
      uri: `data:application/octet-stream;base64,${ANIMATION_BUFFER}`,
    },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: 12 },
    { buffer: 0, byteOffset: 12, byteLength: 36 },
  ],
  accessors: [
    {
      bufferView: 0,
      componentType: 5126,
      count: 3,
      type: "SCALAR",
      min: [0],
      max: [2],
    },
    {
      bufferView: 1,
      componentType: 5126,
      count: 3,
      type: "VEC3",
    },
  ],
  animations: [
    {
      name: "Bounce",
      samplers: [{ input: 0, output: 1, interpolation: "LINEAR" }],
      channels: [{ sampler: 0, target: { node: 0, path: "translation" } }],
    },
  ],
});