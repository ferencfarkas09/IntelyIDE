/** Default colours offered for repos. The CSS tokens --repo-1..8 are theme-tuned twins of these (dark values). */
export const REPO_PALETTE = ["#4caf7d", "#8b6cf0", "#f0a23a", "#3b9ae8", "#e8669a", "#26b5b0", "#ef7b5b", "#9bc34a"] as const;

/** A palette colour not yet used by `taken`, cycling when all are in use. */
export function pickRepoColor(taken: readonly string[]): string {
  const used = new Set(taken.map((c) => c.toLowerCase()));
  return REPO_PALETTE.find((c) => !used.has(c)) ?? REPO_PALETTE[taken.length % REPO_PALETTE.length];
}
