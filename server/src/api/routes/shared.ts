/** Parse a query/body param as a positive integer, clamped to [min, max]. */
export function parseIntParam(
  value: unknown,
  defaultVal: number,
  min = 1,
  max = 1000,
): number {
  const n = parseInt(String(value ?? ''), 10);
  if (Number.isNaN(n)) return defaultVal;
  const clampedValue = Math.max(min, Math.min(n, max));
  return clampedValue;
}
