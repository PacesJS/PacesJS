// A call tree in creation order (node 0 is the root), with children deduplicated by (parent, function).

export interface TreeBuilder {
  parent: number[];
  fn: number[];
  /** The child of `parent` running `fn`, created on first use. */
  child: (parent: number, fn: number) => number;
}

/** `K` exceeds every function id, so `parent * K + fn` identifies a child. */
export function createTreeBuilder(rootFn: number, K: number): TreeBuilder {
  const parent: number[] = [-1];
  const fn: number[] = [rootFn];
  const index = new Map<number, number>();
  const child = (p: number, f: number): number => {
    const key = p * K + f;
    let id = index.get(key);
    if (id === undefined) {
      id = parent.length;
      parent.push(p);
      fn.push(f);
      index.set(key, id);
    }
    return id;
  };
  return { parent, fn, child };
}
