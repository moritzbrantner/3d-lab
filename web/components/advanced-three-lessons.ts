import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  KEYFRAME_POSITIONS,
  KEYFRAME_TIMES,
  MINIMAL_ANIMATED_GLTF,
  type AdvancedLessonState,
} from "@/lib/animation-data";
import type { LessonId } from "@/lib/lessons";

export type AdvancedSceneRuntime = {
  root: THREE.Group;
  setState: (state: AdvancedLessonState) => void;
  tick: (delta: number) => void;
  dispose: () => void;
};

const ADVANCED_IDS = new Set<LessonId>([
  "matrix-composition",
  "hierarchy",
  "keyframes",
  "quaternions",
  "skinning",
  "gltf-animation",
]);

function disposeObject(root: THREE.Object3D) {
  root.traverse((object) => {
    if (object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Points) {
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    }
  });
}

function markerGeometry() {
  return new THREE.BoxGeometry(0.7, 0.7, 0.7);
}

function markerMaterial() {
  return new THREE.MeshNormalMaterial();
}

function buildMatrixComposition(initial: AdvancedLessonState): AdvancedSceneRuntime {
  const root = new THREE.Group();
  root.add(new THREE.AxesHelper(1.8));

  const source = new THREE.LineSegments(
    new THREE.EdgesGeometry(markerGeometry()),
    new THREE.LineBasicMaterial({ transparent: true, opacity: 0.45 }),
  );
  source.position.x = -1.3;
  root.add(source);

  const transformed = new THREE.Mesh(markerGeometry(), markerMaterial());
  transformed.matrixAutoUpdate = false;
  root.add(transformed);

  const apply = (state: AdvancedLessonState) => {
    const translation = new THREE.Matrix4().makeTranslation(0.9, 0.45, 0.25);
    const rotation = new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(state.matrixAngle));
    const scale = new THREE.Matrix4().makeScale(1.35, 0.72, 0.95);
    transformed.matrix.copy(translation).multiply(rotation).multiply(scale);
    transformed.matrixWorldNeedsUpdate = true;
  };

  apply(initial);
  return { root, setState: apply, tick: () => {}, dispose: () => {} };
}

function buildHierarchy(initial: AdvancedLessonState): AdvancedSceneRuntime {
  const root = new THREE.Group();
  const parent = new THREE.Group();
  const child = new THREE.Group();
  const grandchild = new THREE.Group();

  const parentMesh = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.22, 0.22), markerMaterial());
  parentMesh.position.x = 0.58;
  parent.add(parentMesh, new THREE.AxesHelper(0.7));

  child.position.x = 1.15;
  const childMesh = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.18, 0.18), markerMaterial());
  childMesh.position.x = 0.43;
  child.add(childMesh, new THREE.AxesHelper(0.55));

  grandchild.position.x = 0.85;
  grandchild.add(new THREE.Mesh(new THREE.SphereGeometry(0.18, 20, 14), markerMaterial()));
  child.add(grandchild);
  parent.add(child);
  root.add(parent);

  const apply = (state: AdvancedLessonState) => {
    const radians = THREE.MathUtils.degToRad(state.hierarchyAngle);
    parent.rotation.z = radians;
    child.rotation.z = -radians * 0.62;
    grandchild.rotation.y = radians * 1.4;
  };

  apply(initial);
  return { root, setState: apply, tick: () => {}, dispose: () => {} };
}

function buildKeyframes(initial: AdvancedLessonState): AdvancedSceneRuntime {
  const root = new THREE.Group();
  const target = new THREE.Mesh(markerGeometry(), markerMaterial());
  root.add(target);

  const path = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(KEYFRAME_POSITIONS.map(([x, y, z]) => new THREE.Vector3(x, y, z))),
    new THREE.LineBasicMaterial(),
  );
  root.add(path);

  const keyframePoints = new THREE.Points(
    new THREE.BufferGeometry().setFromPoints(KEYFRAME_POSITIONS.map(([x, y, z]) => new THREE.Vector3(x, y, z))),
    new THREE.PointsMaterial({ size: 0.14, sizeAttenuation: true }),
  );
  root.add(keyframePoints);

  const makeClip = (name: string, interpolation: THREE.InterpolationModes) => {
    const track = new THREE.VectorKeyframeTrack(
      ".position",
      [...KEYFRAME_TIMES],
      KEYFRAME_POSITIONS.flatMap((position) => [...position]),
    );
    track.setInterpolation(interpolation);
    return new THREE.AnimationClip(name, 2, [track]);
  };

  const clips = {
    linear: makeClip("three-keyframe-arc-linear", THREE.InterpolateLinear),
    smooth: makeClip("three-keyframe-arc-smooth", THREE.InterpolateSmooth),
  } as const;
  const mixer = new THREE.AnimationMixer(target);
  let state = initial;
  let mode = initial.keyframeInterpolation;
  let action = mixer.clipAction(clips[mode]);
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.play();

  const apply = (next: AdvancedLessonState) => {
    state = next;
    if (mode !== next.keyframeInterpolation) {
      const currentTime = mixer.time % 2;
      action.stop();
      mode = next.keyframeInterpolation;
      action = mixer.clipAction(clips[mode]);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.play();
      mixer.setTime(currentTime);
    }
    action.paused = !next.keyframePlaying;
    if (!next.keyframePlaying) {
      mixer.setTime(next.keyframeTime);
    }
  };

  apply(initial);
  return {
    root,
    setState: apply,
    tick: (delta) => {
      if (state.keyframePlaying) mixer.update(delta);
    },
    dispose: () => mixer.stopAllAction(),
  };
}

function buildQuaternionComparison(initial: AdvancedLessonState): AdvancedSceneRuntime {
  const root = new THREE.Group();
  const eulerRoot = new THREE.Group();
  const quaternionRoot = new THREE.Group();
  eulerRoot.position.x = -1.15;
  quaternionRoot.position.x = 1.15;

  const eulerMesh = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1.25, 0.34), markerMaterial());
  const quaternionMesh = new THREE.Mesh(new THREE.BoxGeometry(0.34, 1.25, 0.34), markerMaterial());
  eulerRoot.add(eulerMesh, new THREE.AxesHelper(0.85));
  quaternionRoot.add(quaternionMesh, new THREE.AxesHelper(0.85));
  root.add(eulerRoot, quaternionRoot);

  const startEuler = new THREE.Euler(0, 0, 0, "XYZ");
  const endEuler = new THREE.Euler(Math.PI / 2, Math.PI / 2, 0, "XYZ");
  const startQuaternion = new THREE.Quaternion().setFromEuler(startEuler);
  const endQuaternion = new THREE.Quaternion().setFromEuler(endEuler);

  const apply = (state: AdvancedLessonState) => {
    const t = THREE.MathUtils.clamp(state.rotationT, 0, 1);
    eulerRoot.rotation.set(
      THREE.MathUtils.lerp(startEuler.x, endEuler.x, t),
      THREE.MathUtils.lerp(startEuler.y, endEuler.y, t),
      THREE.MathUtils.lerp(startEuler.z, endEuler.z, t),
      "XYZ",
    );
    quaternionRoot.quaternion.slerpQuaternions(startQuaternion, endQuaternion, t);
  };

  apply(initial);
  return { root, setState: apply, tick: () => {}, dispose: () => {} };
}

function buildSkinning(initial: AdvancedLessonState): AdvancedSceneRuntime {
  const root = new THREE.Group();
  const geometry = new THREE.BufferGeometry();
  const rows = [-1.5, -0.75, 0, 0.75, 1.5];
  const positions: number[] = [];
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];
  const indices: number[] = [];

  rows.forEach((y, row) => {
    [-0.28, 0.28].forEach((x) => {
      positions.push(x, y, 0);
      if (row === 0) {
        skinIndices.push(0, 1, 0, 0);
        skinWeights.push(1, 0, 0, 0);
      } else if (row === 1) {
        skinIndices.push(0, 1, 0, 0);
        skinWeights.push(0.65, 0.35, 0, 0);
      } else if (row === 2) {
        skinIndices.push(0, 1, 0, 0);
        skinWeights.push(0.15, 0.85, 0, 0);
      } else if (row === 3) {
        skinIndices.push(1, 2, 0, 0);
        skinWeights.push(0.65, 0.35, 0, 0);
      } else {
        skinIndices.push(1, 2, 0, 0);
        skinWeights.push(0, 1, 0, 0);
      }
    });
  });

  for (let row = 0; row < rows.length - 1; row += 1) {
    const lowerLeft = row * 2;
    const lowerRight = lowerLeft + 1;
    const upperLeft = lowerLeft + 2;
    const upperRight = lowerLeft + 3;
    indices.push(lowerLeft, lowerRight, upperLeft, lowerRight, upperRight, upperLeft);
  }

  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute("skinWeight", new THREE.Float32BufferAttribute(skinWeights, 4));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();

  const rootBone = new THREE.Bone();
  rootBone.position.y = -1.5;
  const middleBone = new THREE.Bone();
  middleBone.position.y = 1.5;
  const tipBone = new THREE.Bone();
  tipBone.position.y = 1.5;
  rootBone.add(middleBone);
  middleBone.add(tipBone);

  const mesh = new THREE.SkinnedMesh(
    geometry,
    new THREE.MeshStandardMaterial({ roughness: 0.65, metalness: 0, side: THREE.DoubleSide }),
  );
  mesh.add(rootBone);
  mesh.bind(new THREE.Skeleton([rootBone, middleBone, tipBone]));
  root.add(mesh, new THREE.SkeletonHelper(mesh));

  const apply = (state: AdvancedLessonState) => {
    const radians = THREE.MathUtils.degToRad(state.skeletonBend);
    middleBone.rotation.z = radians;
    tipBone.rotation.z = -radians * 0.55;
  };

  apply(initial);
  return { root, setState: apply, tick: () => {}, dispose: () => {} };
}

function buildGltfAnimation(initial: AdvancedLessonState): AdvancedSceneRuntime {
  const root = new THREE.Group();
  root.add(new THREE.AxesHelper(1.5));
  const placeholder = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.32, 1),
    new THREE.MeshNormalMaterial({ wireframe: true }),
  );
  root.add(placeholder);

  let state = initial;
  let mixer: THREE.AnimationMixer | null = null;
  let disposed = false;

  new GLTFLoader().parse(
    MINIMAL_ANIMATED_GLTF,
    "",
    (gltf) => {
      if (disposed) {
        disposeObject(gltf.scene);
        return;
      }

      root.remove(placeholder);
      disposeObject(placeholder);
      const animatedNode = gltf.scene.getObjectByName("AnimatedNode") ?? gltf.scene;
      animatedNode.add(new THREE.Mesh(markerGeometry(), markerMaterial()));
      gltf.scene.position.y = -0.45;
      root.add(gltf.scene);

      mixer = new THREE.AnimationMixer(gltf.scene);
      const clip = gltf.animations[0];
      if (clip) {
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.play();
      }
    },
    () => {
      placeholder.rotation.z = Math.PI / 4;
    },
  );

  return {
    root,
    setState: (next) => {
      state = next;
    },
    tick: (delta) => {
      if (state.gltfPlaying) mixer?.update(delta);
    },
    dispose: () => {
      disposed = true;
      mixer?.stopAllAction();
    },
  };
}

export function buildAdvancedLessonScene(
  id: LessonId,
  initial: AdvancedLessonState,
): AdvancedSceneRuntime | null {
  if (!ADVANCED_IDS.has(id)) return null;

  switch (id) {
    case "matrix-composition":
      return buildMatrixComposition(initial);
    case "hierarchy":
      return buildHierarchy(initial);
    case "keyframes":
      return buildKeyframes(initial);
    case "quaternions":
      return buildQuaternionComparison(initial);
    case "skinning":
      return buildSkinning(initial);
    case "gltf-animation":
      return buildGltfAnimation(initial);
    default:
      return null;
  }
}
