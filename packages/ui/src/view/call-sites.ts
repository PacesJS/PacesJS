export interface CallSiteChip {
  /** 0-based index into the lines array. */
  lineIndex: number;
  fn: number | null;
  name: string;
  totalUs: number;
  origin: number;
}

/**
 * Heuristic call-site chips: sampled profiles record time per callee but not the calling line
 * (the engine's `CallSite.line` is 0), so a callee is pinned to the first line that textually
 * calls it. Labelled as such in the UI.
 */
export function matchCallSites(
  lines: string[],
  callees: Array<{ fn: number | null; name: string; totalUs: number; origin: number }>,
): CallSiteChip[] {
  const out: CallSiteChip[] = [];
  const used = new Set<number>();
  for (const c of callees) {
    const bare = (c.name.split('▸').pop() ?? c.name).trim();
    const token = bare.split('.').pop() ?? bare;
    if (!/^[A-Za-z_$][\w$]*$/.test(token)) continue;
    const re = new RegExp(`\\b${token.replace(/\$/g, '\\$')}\\s*\\(`);
    const idx = lines.findIndex(
      (l, i) => !used.has(i) && re.test(l.replace(/^\s*(export\s+)?(async\s+)?function\s+\w+/, '')),
    );
    if (idx >= 0) {
      used.add(idx);
      out.push({ lineIndex: idx, fn: c.fn, name: c.name, totalUs: c.totalUs, origin: c.origin });
    }
  }
  return out;
}
