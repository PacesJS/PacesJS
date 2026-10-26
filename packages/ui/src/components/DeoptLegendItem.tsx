const TEXT = {
  mark: "V8 threw away this function's optimized code (profiled with --v8)",
} as const;

/** The legend entry for the triangle on deoptimized bars; shown only when the run has any. */
export function DeoptLegendItem() {
  return (
    <span className="wf-legend-item">
      <span className="deopt-swatch" aria-hidden="true" />
      {TEXT.mark}
    </span>
  );
}
