"use client";

import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { PrecisionRange } from "./PrecisionRange";
import type { TeachingPose } from "@/lib/skeletal-animation";
import { TEACHING_CLIP_DURATION } from "@/lib/skeletal-animation";
import {
  EDITABLE_WEIGHT_ROW,
  filterJointTree,
  formatVec,
  frameToTime,
  jointCssColor,
  jointTransforms,
  keyframeSegment,
  navigateJointTree,
  playbackRangeBounds,
  setRangeEnd,
  setRangeStart,
  summarizeJointInfluence,
  TEACHING_CLIP_FPS,
  TEACHING_CLIP_INFO,
  TEACHING_JOINTS,
  teachingVertices,
  timeToFrame,
  weightForJoint,
  WEIGHT_MODES,
  type PlaybackRangeState,
  type TreeKey,
  type WeightMode,
} from "@/lib/skeletal-animation-inspection";
import styles from "./skeletal-animation-lab.module.css";

const TREE_KEYS: readonly string[] = ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"];
const CLIP_FRAMES = Math.round(TEACHING_CLIP_DURATION * TEACHING_CLIP_FPS);

export type InspectorSelection = {
  selectedJoint: number;
  selectedVertex: number;
  weightMode: WeightMode;
  middleWeight: number;
};

export type PlaybackControlsProps = {
  time: number;
  playing: boolean;
  loop: boolean;
  range: PlaybackRangeState;
  onToggle: () => void;
  onScrub: (time: number) => void;
  onLoop: (loop: boolean) => void;
  onRange: (range: PlaybackRangeState) => void;
};

/** Exact clip time, frame, playback range and loop controls shown under the viewport. */
export function InspectPlaybackControls({ time, playing, loop, range, onToggle, onScrub, onLoop, onRange }: PlaybackControlsProps) {
  const bounds = playbackRangeBounds(range);
  return (
    <div className={styles.inspectPlayback} role="group" aria-label="Clip playback">
      <div className={styles.inspectPlaybackActions}>
        <button type="button" onClick={onToggle} aria-pressed={playing}>{playing ? "Pause clip" : "Play clip"}</button>
        <label className={styles.checkRow}>
          <input type="checkbox" checked={loop} onChange={(event) => onLoop(event.currentTarget.checked)} />
          Loop
        </label>
      </div>
      <PrecisionRange label="Clip time" value={time} min={0} max={TEACHING_CLIP_DURATION} step={0.01} unit="s"
        disabled={playing} onChange={onScrub} />
      <PrecisionRange label="Frame" value={timeToFrame(time)} min={0} max={CLIP_FRAMES} step={1} integer
        disabled={playing} onChange={(frame) => onScrub(frameToTime(frame))} />
      <PrecisionRange label="Range start" value={range.start} min={bounds.start.min} max={bounds.start.max} step={0.01} unit="s"
        onChange={(start) => onRange(setRangeStart(range, start))} />
      <PrecisionRange label="Range end" value={range.end} min={bounds.end.min} max={bounds.end.max} step={0.01} unit="s"
        onChange={(end) => onRange(setRangeEnd(range, end))} />
    </div>
  );
}

type InspectorProps = InspectorSelection & {
  pose: TeachingPose;
  time: number;
  loop: boolean;
  range: PlaybackRangeState;
  onSelectJoint: (joint: number) => void;
  onSelectVertex: (vertex: number) => void;
  onWeightMode: (mode: WeightMode) => void;
  onMiddleWeight: (weight: number) => void;
};

function Readout({ label, value, name }: { label: string; value: string; name: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd data-readout={name}>{value}</dd>
    </div>
  );
}

/** Compact inspector: hierarchy, exact transforms, clip info and skin weights for the picked joint/vertex. */
export function SkeletalInspector(props: InspectorProps) {
  const { pose, time, loop, range, selectedJoint, selectedVertex, weightMode, middleWeight } = props;
  const searchId = useId();
  const [query, setQuery] = useState("");
  const itemRefs = useRef(new Map<number, HTMLLIElement | null>());
  const rows = useMemo(() => filterJointTree(TEACHING_JOINTS, query), [query]);
  const transforms = useMemo(() => jointTransforms(pose), [pose]);
  const vertices = useMemo(() => teachingVertices(middleWeight), [middleWeight]);
  const joint = transforms[selectedJoint];
  const vertex = vertices[selectedVertex];
  const influence = useMemo(() => summarizeJointInfluence(vertices, selectedJoint), [vertices, selectedJoint]);
  const tabStop = rows.some((row) => row.index === selectedJoint) ? selectedJoint : rows[0]?.index;

  const focusJoint = (index: number) => {
    props.onSelectJoint(index);
    itemRefs.current.get(index)?.focus();
  };
  const onTreeKey = (event: KeyboardEvent<HTMLLIElement>, index: number) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      props.onSelectJoint(index);
      return;
    }
    if (!TREE_KEYS.includes(event.key)) return;
    event.preventDefault();
    focusJoint(navigateJointTree(rows, index, event.key as TreeKey));
  };

  return (
    <div className={styles.inspector}>
      <section aria-labelledby={`${searchId}-hierarchy`}>
        <h3 id={`${searchId}-hierarchy`}>Joint hierarchy</h3>
        <input id={searchId} type="search" value={query} placeholder="Search joints" aria-label="Search joints"
          aria-controls={`${searchId}-tree`}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && rows[0]) {
              event.preventDefault();
              props.onSelectJoint((rows.find((row) => row.matches) ?? rows[0]).index);
            } else if (event.key === "ArrowDown" && rows.length > 0) {
              event.preventDefault();
              itemRefs.current.get(tabStop ?? rows[0].index)?.focus();
            } else if (event.key === "Escape") {
              setQuery("");
            }
          }} />
        <ul id={`${searchId}-tree`} role="tree" aria-label="Joint hierarchy" className={styles.tree}>
          {rows.map((row) => (
            <li key={row.index} role="treeitem" aria-level={row.depth + 1} aria-selected={row.index === selectedJoint}
              aria-expanded={row.hasChildren ? true : undefined}
              ref={(element) => { itemRefs.current.set(row.index, element); }}
              tabIndex={row.index === tabStop ? 0 : -1}
              className={row.index === selectedJoint ? styles.treeSelected : styles.treeItem}
              style={{ paddingLeft: `${0.5 + row.depth * 1.1}rem`, opacity: row.matches ? 1 : 0.6 }}
              onClick={() => props.onSelectJoint(row.index)}
              onKeyDown={(event) => onTreeKey(event, row.index)}>
              <i style={{ background: jointCssColor(row.index) }} aria-hidden="true" />
              {row.name}
              <span>#{row.index}</span>
            </li>
          ))}
        </ul>
        {rows.length === 0 && <p role="status" className={styles.secondaryCopy}>No joints match “{query}”.</p>}
      </section>

      <section aria-label={`${joint.name} transforms`}>
        <h3>{joint.name} transform</h3>
        <dl className={styles.stats} data-testid="joint-readouts">
          <Readout name="local-position" label="local position" value={formatVec(joint.local.position, 3)} />
          <Readout name="local-rotation" label="local rotation XYZ°" value={formatVec(joint.local.rotationDegrees, 2)} />
          <Readout name="model-position" label="model position" value={formatVec(joint.model.position, 3)} />
          <Readout name="model-rotation" label="model rotation XYZ°" value={formatVec(joint.model.rotationDegrees, 2)} />
        </dl>
      </section>

      <section aria-label="Clip information">
        <h3>Clip</h3>
        <dl className={styles.stats} data-testid="clip-info">
          <Readout name="clip" label="clip" value={TEACHING_CLIP_INFO.name} />
          <Readout name="source" label="source" value={TEACHING_CLIP_INFO.source} />
          <Readout name="duration" label="duration" value={`${TEACHING_CLIP_INFO.duration.toFixed(2)} s · ${CLIP_FRAMES} frames @ ${TEACHING_CLIP_INFO.fps} fps`} />
          <Readout name="keyframes" label="keyframes" value={`${TEACHING_CLIP_INFO.keyframeTimes.join(", ")} s · segment ${keyframeSegment(time)}`} />
          <Readout name="interpolation" label="interpolation" value={TEACHING_CLIP_INFO.interpolation} />
          <Readout name="loop" label="loop" value={loop ? "loop" : "play once"} />
          <Readout name="range" label="playback range" value={`${range.start.toFixed(3)} – ${range.end.toFixed(3)} s`} />
          <Readout name="time" label="time" value={`${time.toFixed(3)} s · frame ${timeToFrame(time)} / ${CLIP_FRAMES}`} />
        </dl>
      </section>

      <section aria-label="Skin weights">
        <h3>Skin weights</h3>
        <div role="radiogroup" aria-label="Weight visualization" className={styles.radioRow}>
          {WEIGHT_MODES.map((mode) => (
            <label key={mode.id} className={mode.id === weightMode ? styles.radioActive : styles.radio}>
              <input type="radio" name={`${searchId}-weights`} checked={mode.id === weightMode}
                onChange={() => props.onWeightMode(mode.id)} />
              {mode.label}
            </label>
          ))}
        </div>
        {weightMode === "selected" && (
          <div className={styles.heatLegend} aria-label={`${joint.name} weight, 0 to 100 percent`}>
            <span>0%</span><i /><span>100%</span>
          </div>
        )}
        <p className={styles.secondaryCopy} data-readout="joint-influence">
          {joint.name} influences {influence.vertexCount} of {vertices.length} vertices
          (max {(influence.maxWeight * 100).toFixed(0)}%, {influence.fullyWeighted} at 100%).
        </p>
        <div className={styles.vertexPicker}>
          <label htmlFor={`${searchId}-vertex`}>Inspected vertex</label>
          <select id={`${searchId}-vertex`} value={selectedVertex}
            onChange={(event) => props.onSelectVertex(Number(event.currentTarget.value))}>
            {vertices.map((entry) => (
              <option key={entry.index} value={entry.index}>v{entry.index} · y {entry.position[1].toFixed(2)}</option>
            ))}
          </select>
        </div>
        <dl className={styles.stats} data-testid="vertex-weights">
          <Readout name="vertex-bind" label="bind position" value={formatVec(vertex.position, 3)} />
          {TEACHING_JOINTS.map((entry) => (
            <Readout key={entry.index} name={`weight-${entry.index}`} label={`${entry.name} weight`}
              value={`${(weightForJoint(vertex, entry.index) * 100).toFixed(1)}%`} />
          ))}
          <Readout name="weight-sum" label="weight sum"
            value={`${(vertex.weights.reduce((sum, weight) => sum + weight, 0) * 100).toFixed(1)}%`} />
        </dl>
        {vertex.row === EDITABLE_WEIGHT_ROW && (
          <PrecisionRange label="Elbow weight (authored vertex)" value={middleWeight * 100} min={0} max={100} step={1} unit="%"
            onChange={(percent) => props.onMiddleWeight(percent / 100)} />
        )}
      </section>
    </div>
  );
}
