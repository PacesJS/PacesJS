import type { AgentSummary } from './engine.js';

interface FindingLike {
  severity?: string;
  title?: string;
  summary?: string;
  rule?: string;
}

/** Findings out of an agent summary, whatever else the engine puts next to them. */
export function findingsOf(summary: AgentSummary): FindingLike[] {
  const f = summary.findings;
  return Array.isArray(f) ? (f as FindingLike[]) : [];
}

/** Terminal rendering: one line per finding, severity first. Falls back to JSON for unknown shapes. */
export function formatSummary(summary: AgentSummary, header?: string): string {
  const lines: string[] = [];
  if (header) lines.push(header, '');
  const findings = findingsOf(summary);
  if (!Array.isArray(summary.findings)) {
    lines.push(JSON.stringify(summary, null, 2));
  } else if (findings.length === 0) {
    lines.push('No findings. Nothing in this profile crossed a threshold.');
  } else {
    lines.push(`${findings.length} finding${findings.length === 1 ? '' : 's'}:`);
    for (const f of findings) {
      const sev = (f.severity ?? 'info').toUpperCase().padEnd(6);
      lines.push(`  ${sev} ${f.title ?? 'Finding'}: ${f.summary ?? ''}`.trimEnd());
      if (f.rule) lines.push(`         rule: ${f.rule}`);
    }
  }
  return lines.join('\n');
}
