export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Ordered weakest → strongest. Index is the effort's rank. */
export const EFFORT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (EFFORT_LEVELS as readonly string[]).includes(value);
}

export function rank(effort: Effort): number {
  return EFFORT_LEVELS.indexOf(effort);
}

export function fromRank(r: number): Effort {
  const i = Math.min(EFFORT_LEVELS.length - 1, Math.max(0, Math.round(r)));
  return EFFORT_LEVELS[i]!;
}

export function shift(effort: Effort, delta: number): Effort {
  return fromRank(rank(effort) + delta);
}

export function clampEffort(effort: Effort, min: Effort, max: Effort): Effort {
  return fromRank(Math.min(rank(max), Math.max(rank(min), rank(effort))));
}

export function maxEffort(a: Effort, b: Effort): Effort {
  return rank(a) >= rank(b) ? a : b;
}

export function minEffort(a: Effort, b: Effort): Effort {
  return rank(a) <= rank(b) ? a : b;
}

/** A prompt's own effort range: `[effort xhigh..max]`, `[effort >=xhigh]` (max stays configured), `[effort max]` (one level). */
export interface EffortTag {
  min?: Effort;
  max?: Effort;
}

const LEVEL = EFFORT_LEVELS.join('|');
const EFFORT_TAG = new RegExp(`\\[\\s*effort\\s+(?:(>=)\\s*)?(${LEVEL})(?:\\s*\\.\\.\\s*(${LEVEL}))?\\s*\\]`, 'i');

/** The first `[effort …]` tag anywhere in the text; null without one. */
export function effortTag(text: string): EffortTag | null {
  const m = EFFORT_TAG.exec(text);
  if (!m) return null;
  const a = m[2]!.toLowerCase() as Effort;
  if (m[1]) return { min: a };
  if (m[3]) return { min: a, max: m[3].toLowerCase() as Effort };
  return { min: a, max: a };
}

export function describeBounds(b: { min: Effort; max: Effort }): string {
  return b.min === b.max ? b.min : `${b.min}..${b.max}`;
}
