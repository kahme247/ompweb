const RATE_PREFIXES = ["", "k", "M", "G", "T", "P", "E", "Z", "Y", "R", "Q"];

/** A five-character number and at most four-character SI token-rate unit. */
export function formatGenerationSpeed(rate: number | null | undefined): { value: string; unit: string } | null {
  if (rate == null || !Number.isFinite(rate) || rate < 0) return null;
  let prefix = 0;
  while (Math.round(rate * 10) >= 10_000) {
    // No SI prefix beyond quetta can represent this rate within the fixed slots.
    if (++prefix === RATE_PREFIXES.length) return null;
    rate /= 1000;
  }
  return { value: rate.toFixed(1), unit: `${RATE_PREFIXES[prefix]}t/s` };
}
