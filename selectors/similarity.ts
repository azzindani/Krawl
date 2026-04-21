// selectors/similarity.ts
// Scores how similar two DOM element fingerprints are.
// Used by the adaptive selector tracker to relocate elements after a
// site redesign changes its CSS classes or DOM structure.
//
// All weights are calibrated so a perfect match returns 1.0 and a
// completely unrelated element returns ~0.0.

export interface ElementFingerprint {
  tag      : string;             // lowercase tag name, e.g. "span"
  textSample: string;            // first 100 chars of inner text
  classes  : string[];           // classList array
  id       : string;
  depth    : number;             // DOM depth from <html>
  parentTag: string;             // direct parent's tag name
  attributes: Record<string, string>;
}

// ── Text similarity (normalised edit-distance proxy) ────────────────────────

function textSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const longer  = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1;
  const dist = editDistance(longer, shorter);
  return (longer.length - dist) / longer.length;
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  // Use one-row DP to keep memory O(n)
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const curr = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr.push(Math.min(
        curr[j - 1] + 1,
        prev[j]     + 1,
        prev[j - 1] + cost,
      ));
    }
    prev = curr;
  }
  return prev[n];
}

// ── Set similarity (Jaccard) ─────────────────────────────────────────────────

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter  = 0;
  for (const v of setA) if (setB.has(v)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 1 : inter / union;
}

// ── Main scoring function ────────────────────────────────────────────────────

export function similarity(a: ElementFingerprint, b: ElementFingerprint): number {
  let score = 0;

  // Tag name (weight 3) — exact match only
  score += a.tag === b.tag ? 3 : 0;

  // Text content similarity (weight 4) — most discriminative signal
  score += 4 * textSimilarity(
    a.textSample.slice(0, 60).toLowerCase(),
    b.textSample.slice(0, 60).toLowerCase(),
  );

  // CSS class overlap (weight 3)
  score += 3 * jaccard(a.classes, b.classes);

  // ID exact match (weight 2)
  if (a.id && b.id) {
    score += a.id === b.id ? 2 : 0;
  }

  // DOM depth proximity (weight 1) — same depth or within ±2
  score += Math.max(0, 1 - Math.abs(a.depth - b.depth) * 0.3);

  // Parent tag (weight 1)
  score += a.parentTag === b.parentTag ? 1 : 0;

  // Attribute overlap — id/class already scored, focus on data-* / aria-*
  const aAttrs = Object.keys(a.attributes).filter(k => k !== "class" && k !== "id");
  const bAttrs = Object.keys(b.attributes).filter(k => k !== "class" && k !== "id");
  score += jaccard(aAttrs, bAttrs) * 1;

  // Normalise: max possible = 3+4+3+2+1+1+1 = 15
  return score / 15;
}
