import type { AgentSummary } from './engine.js';

interface Loc {
  name?: string;
  file?: string;
  line?: number;
}

interface FindingLike {
  severity?: string;
  title?: string;
  summary?: string;
  rule?: string;
  evidence?: Loc[];
  showMe?: Loc;
}

/** Findings out of an agent summary, whatever else the engine puts next to them. */
export function findingsOf(summary: AgentSummary): FindingLike[] {
  const f = (summary as unknown as Record<string, unknown>).findings;
  return Array.isArray(f) ? (f as FindingLike[]) : [];
}

export function where(loc: Loc | undefined): string {
  if (!loc || (!loc.name && !loc.file)) return '';
  const place = loc.file ? `${loc.file}${loc.line ? `:${loc.line}` : ''}` : '';
  return `${loc.name || '(anonymous)'}${place ? ` (${place})` : ''}`;
}

const text = (v: unknown): string | undefined => {
  if (typeof v === 'string' && v) return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const k of ['label', 'name', 'entry', 'file', 'id']) {
      if (typeof o[k] === 'string' && o[k]) return o[k] as string;
    }
  }
  return undefined;
};

/** Terminal rendering: what ran, then one block per finding with function names and file:line. */
export function formatSummary(
  input: AgentSummary | Record<string, unknown>,
  header?: string,
): string {
  const summary = input as unknown as Record<string, unknown>;
  const lines: string[] = [];
  if (header) lines.push(header);
  const facts: string[] = [];
  const runKind = text(summary.runKind);
  const target = text(summary.target);
  const primary = text(summary.primaryTrack);
  if (runKind) facts.push(`run: ${runKind}`);
  if (target) facts.push(`target: ${target}`);
  if (primary) facts.push(`primary track: ${primary}`);
  if (facts.length > 0) lines.push(facts.join('   '));
  if (lines.length > 0) lines.push('');

  const findings = findingsOf(summary as unknown as AgentSummary);
  if (!Array.isArray(summary.findings)) {
    lines.push(JSON.stringify(summary, null, 2));
  } else if (findings.length === 0) {
    lines.push('No findings. Nothing in this profile crossed a threshold.');
  } else {
    lines.push(`${findings.length} finding${findings.length === 1 ? '' : 's'}:`);
    for (const f of findings) {
      const sev = (f.severity ?? 'info').toUpperCase().padEnd(6);
      lines.push(`  ${sev} ${f.title ?? 'Finding'}: ${f.summary ?? ''}`.trimEnd());
      for (const e of (f.evidence ?? []).slice(0, 4)) lines.push(`           at ${where(e)}`);
      if (f.rule) lines.push(`           rule: ${f.rule}`);
    }
  }

  const top = Array.isArray(summary.topSelf) ? summary.topSelf : summary.topFunctions;
  if (Array.isArray(top) && top.length > 0) {
    lines.push('', 'Top functions by self time:');
    for (const fn of top.slice(0, 8) as Array<Loc & { selfMs?: number; share?: number }>) {
      const pct = typeof fn.share === 'number' ? ` ${(fn.share * 100).toFixed(1)}%` : '';
      lines.push(`  ~${fn.selfMs ?? '?'} ms${pct}  ${where(fn)}`);
    }
  }
  const caveats = summary.caveats;
  if (Array.isArray(caveats) && caveats.length > 0) {
    lines.push('', 'Caveats:');
    for (const c of caveats.slice(0, 5)) lines.push(`  - ${text(c) ?? JSON.stringify(c)}`);
  }
  return lines.join('\n');
}
