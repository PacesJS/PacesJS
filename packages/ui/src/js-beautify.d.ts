declare module 'js-beautify/js/lib/beautify.js' {
  export function js_beautify(source: string, options?: Record<string, unknown>): string;
  const lib: { js_beautify: typeof js_beautify };
  export default lib;
}
