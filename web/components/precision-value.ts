export type NumericBounds = { min: number; max: number; integer?: boolean };
export type NumericDraft = { baseline: number; text: string };
export type DraftResult =
  | { kind: "idle" | "stale" | "invalid" }
  | { kind: "commit"; value: number };

const decimal = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

export function parseNumericValue(raw: string, { min, max, integer = false }: NumericBounds): number | null {
  const text = raw.trim().replace(",", ".");
  if (!decimal.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value < min || value > max) return null;
  if (integer && !Number.isSafeInteger(value)) return null;
  return value;
}

export function finishNumericDraft(draft: NumericDraft | null, current: number, bounds: NumericBounds): DraftResult {
  if (!draft) return { kind: "idle" };
  if (!Object.is(draft.baseline, current)) return { kind: "stale" };
  const value = parseNumericValue(draft.text, bounds);
  if (value === null) return { kind: "invalid" };
  return Object.is(value, current) ? { kind: "idle" } : { kind: "commit", value };
}

function decimalPlaces(value: number): number {
  const [coefficient, exponent = "0"] = String(value).toLowerCase().split("e");
  return Math.max(0, (coefficient.split(".")[1]?.length ?? 0) - Number(exponent));
}

function normalize(value: number, precision: number): number {
  return precision > 100 ? value : Number(value.toFixed(precision));
}

export function nudgeNumericValue(value: number, delta: number, bounds: NumericBounds): number {
  const precision = Math.max(decimalPlaces(value), decimalPlaces(delta));
  let next = normalize(value + delta, precision);
  next = Math.max(bounds.min, Math.min(bounds.max, next));
  if (bounds.integer) next = Math.round(next);
  return next;
}

export function quantizeCoarseValue(value: number, step: number, bounds: NumericBounds): number {
  const safeStep = Number.isFinite(step) && step > 0 ? step : 1;
  const precision = Math.max(decimalPlaces(bounds.min), decimalPlaces(safeStep));
  const slots = Math.round((value - bounds.min) / safeStep);
  let next = normalize(bounds.min + slots * safeStep, precision);
  next = Math.max(bounds.min, Math.min(bounds.max, next));
  if (bounds.integer) next = Math.round(next);
  return next;
}
