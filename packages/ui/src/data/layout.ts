import type { ElkNode } from 'elkjs/lib/elk-api.js';
import type { CallGraphData } from './types';

export const NODE_H = 72;

/** The slice of ELK the layout needs. Hosts inject an implementation (worker-backed or in-process). */
export interface ElkLike {
  layout(graph: ElkNode): Promise<ElkNode>;
}

export type ElkProvider = () => ElkLike;

export interface PlacedNode {
  fn: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GraphLayout {
  width: number;
  height: number;
  nodes: PlacedNode[];
}

function nodeWidth(selfUs: number, maxSelfUs: number): number {
  return Math.round(200 + 80 * Math.sqrt(selfUs / Math.max(1, maxSelfUs)));
}

/**
 * Layered top-down layout (callers above callees). Depends only on the visible set of nodes
 * and edges, never on the selection, so positions stay put while the selection changes.
 */
export async function layoutGraph(graph: CallGraphData, elk: ElkLike): Promise<GraphLayout> {
  const sizes = new Map(graph.nodes.map((n) => [n.fn, nodeWidth(n.selfUs, graph.maxSelfUs)]));
  const result = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': '56',
      'elk.layered.cycleBreaking.strategy': 'DEPTH_FIRST',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.padding': '[top=16,left=16,bottom=40,right=16]',
    },
    children: graph.nodes.map((n) => ({
      id: String(n.fn),
      width: sizes.get(n.fn) ?? 200,
      height: NODE_H,
    })),
    edges: graph.edges.map((e, i) => ({
      id: `e${i}`,
      sources: [String(e.from)],
      targets: [String(e.to)],
    })),
  });
  const nodes: PlacedNode[] = (result.children ?? []).map((c) => ({
    fn: Number(c.id),
    x: Math.round(c.x ?? 0),
    y: Math.round(c.y ?? 0),
    w: c.width ?? 200,
    h: c.height ?? NODE_H,
  }));
  const width = nodes.reduce((m, n) => Math.max(m, n.x + n.w), 0) + 16;
  const height = nodes.reduce((m, n) => Math.max(m, n.y + n.h), 0) + 40;
  return { width: Math.ceil(width), height: Math.ceil(height), nodes };
}
