// Derived columns of a preorder call tree (every parent precedes its children, node 0 is the root).

/** Depth of each node. */
export function depthsOf(parent: Int32Array): Uint16Array {
  const depth = new Uint16Array(parent.length);
  for (let i = 0; i < parent.length; i++) {
    const p = parent[i] ?? -1;
    depth[i] = p < 0 ? 0 : (depth[p] ?? 0) + 1;
  }
  return depth;
}

/** Exclusive end index of each node's subtree: its descendants are the nodes `i + 1 .. end - 1`. */
export function subtreeEnds(parent: Int32Array): Uint32Array {
  const end = new Uint32Array(parent.length);
  for (let i = parent.length - 1; i >= 0; i--) {
    if ((end[i] ?? 0) < i + 1) end[i] = i + 1;
    const p = parent[i] ?? -1;
    if (p >= 0 && (end[p] ?? 0) < (end[i] ?? 0)) end[p] = end[i] ?? 0;
  }
  return end;
}

/** Each node's value plus all its descendants'. */
export function totalsOf(parent: Int32Array, self: Float64Array): Float64Array {
  const total = Float64Array.from(self);
  for (let i = parent.length - 1; i >= 0; i--) {
    const p = parent[i] ?? -1;
    if (p >= 0) total[p] = (total[p] ?? 0) + (total[i] ?? 0);
  }
  return total;
}

/** Node order of a depth-first walk from node 0, visiting each node's children in list order. */
export function preorder(kids: ArrayLike<number[]>): number[] {
  const order: number[] = [];
  const stack = [0];
  while (stack.length > 0) {
    const cur = stack.pop() ?? 0;
    order.push(cur);
    const list = kids[cur] ?? [];
    for (let k = list.length - 1; k >= 0; k--) stack.push(list[k] ?? 0);
  }
  return order;
}
