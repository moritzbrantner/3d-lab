"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  finishNumericDraft,
  nudgeNumericValue,
  parseNumericValue,
  quantizeCoarseValue,
  type NumericDraft,
} from "./precision-value";

export type PrecisionRangeProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  integer?: boolean;
  disabled?: boolean;
  className?: string;
  onChange: (value: number) => void;
};

export function PrecisionRange({
  label, value, min, max, step = 1, unit = "", integer = false,
  disabled = false, className = "control range-control", onChange,
}: PrecisionRangeProps) {
  const id = useId();
  const [draft, setDraft] = useState<NumericDraft | null>(null);
  const pending = useRef<NumericDraft | null>(null);
  const [invalid, setInvalid] = useState(false);
  const bounds = { min, max, integer };
  const coarseStep = integer
    ? Math.max(1, Math.round(Number.isFinite(step) && step > 0 ? step : 1))
    : Number.isFinite(step) && step > 0 ? step : 1;
  const fineStep = integer ? 1 : Math.min(coarseStep, 1) / 10;
  const visibleDraft = draft && Object.is(draft.baseline, value) ? draft.text : String(value);

  const clear = () => {
    pending.current = null;
    setDraft(null);
    setInvalid(false);
  };

  useEffect(() => {
    pending.current = null;
    setDraft(null);
    setInvalid(false);
  }, [value, min, max, integer, disabled]);

  const commit = (reportInvalid: boolean) => {
    if (disabled) return clear();
    const result = finishNumericDraft(pending.current, value, bounds);
    if (result.kind === "invalid" && reportInvalid) {
      setInvalid(true);
      return;
    }
    clear();
    if (result.kind === "commit") onChange(result.value);
  };

  const publish = (next: number) => {
    clear();
    if (!disabled && !Object.is(next, value)) onChange(next);
  };

  return (
    <div className={className} data-slot="precision-range" role="group" aria-labelledby={`${id}-label`}
      style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(5rem, 7rem)", gap: "0.5rem", alignItems: "center" }}>
      <label id={`${id}-label`} htmlFor={id} style={{ gridColumn: "1" }}>
        {label}{unit ? ` (${unit})` : ""}
      </label>
      <input id={id} type="text" role="spinbutton" inputMode={integer ? "numeric" : "decimal"}
        value={visibleDraft} disabled={disabled} aria-valuemin={min} aria-valuemax={max}
        aria-valuenow={value} aria-valuetext={`${value}${unit}`} aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-error` : undefined}
        title={`Enter an exact ${integer ? "whole " : ""}number from ${min} to ${max}. Enter applies; Escape cancels. Arrow keys adjust; Shift adjusts faster.`}
        style={{ gridColumn: "2", width: "100%", minWidth: 0, boxSizing: "border-box", minHeight: "2.25rem", padding: "0.35rem",
          color: "inherit", background: "transparent", border: "1px solid currentColor", borderRadius: "0.25rem",
          font: "inherit", fontVariantNumeric: "tabular-nums" }}
        onChange={(event) => {
          const next = { baseline: value, text: event.currentTarget.value };
          pending.current = next;
          setDraft(next);
          setInvalid(false);
        }}
        onBlur={() => commit(false)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || !["Enter", "Escape", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          if (disabled) return;
          if (event.key === "Escape") return clear();
          if (event.key === "Enter") return commit(true);
          const current = parseNumericValue(visibleDraft, bounds);
          if (current === null) {
            setInvalid(true);
            return;
          }
          const delta = fineStep * (event.shiftKey ? 10 : 1) * (event.key === "ArrowUp" ? 1 : -1);
          publish(nudgeNumericValue(current, delta, bounds));
        }} />
      <input type="range" aria-label={`${label} coarse adjustment${unit ? ` (${unit})` : ""}`}
        min={min} max={max} step="any" value={value} disabled={disabled}
        style={{ gridColumn: "1 / -1", width: "100%", minWidth: 0 }}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp"].includes(event.key)) return;
          event.preventDefault();
          const direction = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 1;
          publish(nudgeNumericValue(value, coarseStep * direction, bounds));
        }}
        onChange={(event) => {
          const raw = Number(event.currentTarget.value);
          if (Number.isFinite(raw)) publish(quantizeCoarseValue(raw, coarseStep, bounds));
        }} />
      {invalid && <span id={`${id}-error`} role="status" style={{ gridColumn: "1 / -1" }}>
        Enter a finite {integer ? "whole " : ""}number from {min} to {max}.
      </span>}
    </div>
  );
}
