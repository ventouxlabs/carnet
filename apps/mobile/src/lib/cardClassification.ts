/** The only outcomes the card classifier may authorize downstream to handle. */
export type CardClassification = "card" | "not-card" | "uncertain";

/**
 * Model output is untrusted. Accept an exact token only; prose and structured
 * variants are deliberately uncertain so they never authorize OCR or a write.
 */
export function parseCardClassification(output: string): CardClassification {
  const normalized = output.trim().toLowerCase();
  return normalized === "card" || normalized === "not-card" || normalized === "uncertain"
    ? normalized
    : "uncertain";
}
