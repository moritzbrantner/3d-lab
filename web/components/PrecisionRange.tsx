"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  finishNumericDraft,
  formatNumericValue,
  nudgeNumericValue,
  parseNumericValue,
  quantizeCoarseValue,
  rebaseNumericDraft,
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
  coarseCommit?: "live" | "release";
  onEditStart?: () => void;
  onChange: (value: number) => void;
};

export function PrecisionRange({
  label, value, min, max, step = 1, unit = "", integer = false,
  disabled = false, className = "control range-control", coarseCommit = "live",
  onEditStart, onChange,
}: PrecisionRangeProps) {
  const id = useId();
  const [draft, setDraft] = useState<NumericDraft | null>(null);
  const pending = useRef<NumericDraft | null>(null);
  const editingText = useRef(false);
  const [coarseDraft, setCoarseDraft] = useState<number | null>(null);
  const coarsePending = useRef<number | null>(null);
  const [invalid, setInvalid] = useState(false);
  const bounds = { min, max, integer };
  const coarseStep = integer
    ? Math.max(1, Math.round(Number.isFinite(step) && step > 0 ? step : 1))
    : Number.isFinite(step) && step > 0 ? step : 1;
  const fineStep = integer ? 1 : Math.min(coarseStep, 1) / 10;
  const displayValue = formatNumericValue(value);
  const visibleDraft = draft?.text ?? displayValue;
  const visibleCoarse = coarseDraft ?? value;

  const clearText = () => {
    pending.current = null;
    setDraft(null);
    setInvalid(false);
  };
  const clearCoarse = () => {
    coarsePending.current = null;
    setCoarseDraft(null);
  };
  const clear = () => {
    clearText();
    clearCoarse();
  };

  useEffect(() => {
    coarsePending.current = null;
    setCoarseDraft(null);
    if (!editingText.current) {
      pending.current = null;
      setDraft(null);
      setInvalid(false);
      return;
    }
    const rebased = rebaseNumericDraft(pending.current, value);
    pending.current = rebased;
    setDraft(rebased);
  }, [value]);

  useEffect(() => {
    editingText.current = false;
    pending.current = null;
    coarsePending.current = null;
    setDraft(null);
    setCoarseDraft(null);
    setInvalid(false);
  }, [min, max, integer, disabled]);

  const endTextEdit = () => {
    editingText.current = false;
    clearText();
  };

  const commitText = (reportInvalid: boolean) => {
    if (disabled) return endTextEdit();
    const result = finishNumericDraft(pending.current, value, bounds);
    if (result.kind === "invalid" && reportInvalid) {
      setInvalid(true);
      return;
    }
    editingText.current = false;
    clear();
    if (result.kind === "commit") onChange(result.value);
  };

  const publish = (next: number) => {
    clear();
    if (!disabled && !Object.is(next, value)) onChange(next);
  };

  const previewCoarse = (next: number) => {
    clearText();
    if (coarseCommit === "live") return publish(next);
    coarsePending.current = next;
    setCoarseDraft(next);
  };

  const commitCoarse = () => {
    if (coarseCommit !== "release") return;
    const next = coarsePending.current;
    clearCoarse();
    if (next !== null && !disabled && !Object.is(next, value)) onChange(next);
  };

  return (
    <div className={className} data-slot="precision-range" role="group" aria-labelledby={`${id}-label`}
      style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(5rem, 7rem)", gap: "0.5rem", alignItems: "center" }}>
      <label id={`${id}-label`} htmlFor={id} style={{ gridColumn: "1" }}>
        {label}{unit ? ` (${unit})` : ""}
      </label>
      <input id={id} type="text" role="spinbutton" inputMode={integer ? "numeric" : "decimal"}
        value={visibleDraft} disabled={disabled} aria-valuemin={min} aria-valuemax={max}
        aria-valuenow={value} aria-valuetext={unit ? `${displayValue} ${unit}` : displayValue}
        aria-invalid={invalid || undefined} aria-describedby={invalid ? `${id}-error` : undefined}
        title={`Enter an exact ${integer ? "whole " : ""}number from ${min} to ${max}. Enter applies; Escape cancels. Arrow keys adjust; Shift adjusts faster.`}
        style={{ gridColumn: "2", width: "100%", minWidth: 0, boxSizing: "border-box", minHeight: "2.25rem", padding: "0.35rem",
          color: "inherit", background: "transparent", border: "1px solid currentColor", borderRadius: "0.25rem",
          font: "inherit", fontVariantNumeric: "tabular-nums" }}
        onFocus={() => {
          editingText.current = true;
          const next = { baseline: value, text: displayValue, dirty: false };
          pending.current = next;
          setDraft(next);
          setInvalid(false);
          onEditStart?.();
        }}
        onChange={(event) => {
          editingText.current = true;
          const next = { baseline: value, text: event.currentTarget.value, dirty: true };
          pending.current = next;
          setDraft(next);
          setInvalid(false);
        }}
        onBlur={() => commitText(false)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || !["Enter", "Escape", "ArrowUp", "ArrowDown"].includes(event.key)) return;
          event.preventDefault();
          event.stopPropagation();
          if (disabled) return;
          if (event.key === "Escape") return endTextEdit();
          if (event.key === "Enter") return commitText(true);
          const current = parseNumericValue(visibleDraft, bounds);
          if (current === null) {
            setInvalid(true);
            return;
          }
          const delta = fineStep * (event.shiftKey ? 10 : 1) * (event.key === "ArrowUp" ? 1 : -1);
          publish(nudgeNumericValue(current, delta, bounds));
        }} />
      <input type="range" aria-label={`${label} coarse adjustment${unit ? ` (${unit})` : ""}`}
        min={min} max={max} step="any" value={visibleCoarse} disabled={disabled}
        style={{ gridColumn: "1 / -1", width: "100%", minWidth: 0 }}
        onKeyDown={(event) => {
          if (!["ArrowLeft", "ArrowDown", "ArrowRight", "ArrowUp"].includes(event.key)) return;
          event.preventDefault();
          const direction = event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 1;
          previewCoarse(nudgeNumericValue(visibleCoarse, coarseStep * direction, bounds));
        }}
        onKeyUp={commitCoarse}
        onPointerUp={commitCoarse}
        onTouchEnd={commitCoarse}
        onBlur={commitCoarse}
        onChange={(event) => {
          const raw = Number(event.currentTarget.value);
          if (Number.isFinite(raw)) previewCoarse(quantizeCoarseValue(raw, coarseStep, bounds));
        }} />
      {invalid && <span id={`${id}-error`} role="status" style={{ gridColumn: "1 / -1" }}>
        Enter a finite {integer ? "whole " : ""}number from {min} to {max}.
      </span>}
    </div>
  );
}
