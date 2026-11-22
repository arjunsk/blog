import { select } from 'd3-selection';
import { installArrowDefs } from './arrow-defs.js';

export function mountBtree(section) {
  const figure = select(section);

  // ---- B+Tree state ----
  let pageCounter = 0;
  let tree;
  const LEAF_MAX = 3;
  const INT_MAX  = 4;

  function newNode(leaf) { return { id: ++pageCounter, leaf, keys: [], children: [], next: null, prev: null }; }
  function reset() { pageCounter = 0; tree = { root: newNode(true) }; }
  reset();

  function findLeaf(k, path) {
    let cur = tree.root;
    while (!cur.leaf) {
      path.push(cur);
      let idx = cur.keys.findIndex(kk => k < kk);
      if (idx === -1) idx = cur.children.length - 1;
      cur = cur.children[idx];
    }
    return cur;
  }

  function rawInsert(k) {
    const path = [];
    const leaf = findLeaf(k, path);
    if (leaf.keys.includes(k)) return 'dup';
    let i = leaf.keys.findIndex(x => x > k);
    if (i === -1) i = leaf.keys.length;
    leaf.keys.splice(i, 0, k);
    if (leaf.keys.length > LEAF_MAX) return splitLeaf(leaf, path);
    return 'ok';
  }

  function splitLeaf(leaf, path) {
    const right = newNode(true);
    const mid = Math.ceil(leaf.keys.length / 2);
    right.keys = leaf.keys.splice(mid);
    // Relink siblings
    right.next = leaf.next;
    right.prev = leaf;
    if (leaf.next) leaf.next.prev = right;
    leaf.next = right;
    const promote = right.keys[0];
    const r = insertIntoParent(leaf, right, promote, path);
    return r === 'ok' ? 'split' : r;
  }

  function splitInternal(node, path) {
    const right = newNode(false);
    const mid = Math.floor(node.keys.length / 2);
    const promote = node.keys[mid];
    right.keys     = node.keys.splice(mid + 1);
    right.children = node.children.splice(mid + 1);
    node.keys.pop();   // remove the promoted key from the left
    return insertIntoParent(node, right, promote, path);
  }

  function insertIntoParent(left, right, promote, path) {
    if (path.length === 0) {
      // new root
      const root = newNode(false);
      root.keys = [promote];
      root.children = [left, right];
      tree.root = root;
      return 'new-root';
    }
    const parent = path[path.length - 1];
    const idx = parent.children.indexOf(left);
    parent.keys.splice(idx, 0, promote);
    parent.children.splice(idx + 1, 0, right);
    if (parent.keys.length > INT_MAX) {
      return splitInternal(parent, path.slice(0, -1));
    }
    return 'ok';
  }

  // ---- handlers ----
  function log(html) { figure.select('[data-status]').html(html); }
  function handleInsert(k) {
    if (!Number.isFinite(k)) { log('Enter a numeric key.'); return; }
    const r = rawInsert(k);
    if (r === 'dup')        log(`Key <b>${k}</b> already exists.`);
    else if (r === 'ok')    log(`Inserted <b>${k}</b> via <b style="color:var(--ok)">optimistic</b> path — leaf had space.`);
    else if (r === 'split') log(`Inserted <b>${k}</b>, leaf full — <b style="color:var(--warn)">pessimistic split</b>, promoted separator to parent.`);
    else if (r === 'new-root') log(`Inserted <b>${k}</b>, root split — tree depth grew.`);
    render();
  }

  // ---- render ----
  // Auto-fit layout: shrinks node widths and tightens gaps when the tree grows
  // wide; grows the SVG vertically when the tree gets deeper. Leaf-linked-list
  // arrows route through a dedicated band BELOW the leaves so they never cross
  // the parent-child connectors above.
  function render() {
    const svg = figure.select('[data-diagram]');
    svg.selectAll('*').remove();
    const arrows = installArrowDefs(svg);

    // ===== Build levels =====
    const levels = [];
    (function walk(n, d) {
      (levels[d] ||= []).push(n);
      if (!n.leaf) n.children.forEach(c => walk(c, d + 1));
    })(tree.root, 0);

    // ===== Layout constants =====
    // Tuned smaller so deep / wide trees don't crowd. Nodes are compact
    // (84×34 by default), with smaller fonts that scale further down for tight rows.
    const PAD_X          = 32;
    const PAD_TOP        = 44;
    const PAD_BOTTOM     = 24;
    const LEVEL_GAP      = 64;     // vertical distance between node centers
    const LEAF_LINK_DIP  = 22;     // band below leaves reserved for the linked-list arcs
    const NATURAL_W      = 84;     // preferred leaf width (was 110)
    const MIN_W          = 46;
    const MIN_GAP        = 10;
    const NODE_H         = 34;     // smaller cell (was 44)

    const leaves    = levels[levels.length - 1];
    const numLeaves = leaves.length;
    const VB_W      = Math.max(640, 2 * PAD_X + numLeaves * MIN_W + (numLeaves - 1) * MIN_GAP);
    const usable    = VB_W - 2 * PAD_X;

    // Pick leaf width / gap so they fit horizontally
    let leafW, leafGap;
    const totalNatural = numLeaves * NATURAL_W + (numLeaves - 1) * 18;
    if (totalNatural <= usable) {
      leafW   = NATURAL_W;
      leafGap = numLeaves > 1 ? (usable - numLeaves * leafW) / (numLeaves - 1) : 0;
      if (leafGap > 48) leafGap = 48;     // don't spread too thin
    } else {
      // Shrink width to fit: (numLeaves * leafW) + (numLeaves-1) * MIN_GAP <= usable
      leafW   = Math.max(MIN_W, (usable - (numLeaves - 1) * MIN_GAP) / numLeaves);
      leafGap = MIN_GAP;
    }
    const fontScale = Math.max(0.65, Math.min(1, leafW / NATURAL_W));

    // ===== Adapt the viewBox height to the depth + linked-list band =====
    const VB_H = PAD_TOP + (levels.length - 1) * LEVEL_GAP + NODE_H + LEAF_LINK_DIP + PAD_BOTTOM;
    svg.attr('viewBox', `0 0 ${VB_W} ${VB_H}`);

    // ===== Position nodes (centers in _cx,_cy) =====
    const leafTotalW = numLeaves * leafW + (numLeaves - 1) * leafGap;
    const leafStartX = (VB_W - leafTotalW) / 2;
    const leafCenterY = PAD_TOP + (levels.length - 1) * LEVEL_GAP + NODE_H / 2;
    leaves.forEach((leaf, i) => {
      leaf._cx = leafStartX + i * (leafW + leafGap) + leafW / 2;
      leaf._cy = leafCenterY;
      leaf._w  = leafW;
      leaf._h  = NODE_H;
    });
    for (let d = levels.length - 2; d >= 0; d--) {
      levels[d].forEach(n => {
        const xs = n.children.map(c => c._cx);
        n._cx = (Math.min(...xs) + Math.max(...xs)) / 2;
        n._cy = PAD_TOP + d * LEVEL_GAP + NODE_H / 2;
        n._w  = Math.max(MIN_W, n.keys.length * 24 * fontScale + 18);
        n._h  = NODE_H;
      });
    }

    // Header
    svg.append('text').attr('x', 16).attr('y', 22).attr('class', 'lbl-mono-dim')
       .text(`DEPTH: ${levels.length} · PAGES: ${pageCounter} · LEAF LINKED-LIST: ${numLeaves} PAGE${numLeaves > 1 ? 'S' : ''}`);

    // ===== Parent-child connectors — smooth bezier curves =====
    // S-curve from parent-bottom to child-top, with control points at the
    // midpoint y. Strokes are purple (--accent-2) to distinguish hierarchy
    // lines from the cyan leaf-linked-list arrows drawn below.
    levels.forEach(arr => arr.forEach(n => {
      if (n.leaf) return;
      n.children.forEach(c => {
        const x1 = n._cx, y1 = n._cy + n._h / 2;
        const x2 = c._cx, y2 = c._cy - c._h / 2;
        const midY = (y1 + y2) / 2;
        svg.append('path')
           .attr('d', `M${x1},${y1} C${x1},${midY} ${x2},${midY} ${x2},${y2}`)
           .attr('stroke', 'var(--accent-2)').attr('stroke-width', 1.5)
           .attr('fill', 'none').attr('opacity', 0.75);
      });
    }));

    // ===== Leaf linked-list — smooth bezier "dip" arcs below the leaves =====
    // From the right-side of leaf N, a single cubic bezier swings down through
    // a shared dip-y, then back up into the left-side of leaf N+1. Cyan color
    // marks this as a data-flow link, distinct from the purple hierarchy curves.
    const dipY = leafCenterY + NODE_H / 2 + LEAF_LINK_DIP * 0.55;
    for (let i = 0; i < leaves.length - 1; i++) {
      const a = leaves[i], b = leaves[i + 1];
      const ax = a._cx + a._w / 2, ay = a._cy;
      const bx = b._cx - b._w / 2, by = b._cy;
      svg.append('path')
         .attr('d', `M${ax},${ay} C${ax + 14},${dipY} ${bx - 14},${dipY} ${bx},${by}`)
         .attr('stroke', 'var(--accent)').attr('stroke-width', 1.5)
         .attr('fill', 'none').attr('opacity', 0.9)
         .attr('marker-end', arrows.flow);
    }

    // ===== Nodes (drawn on top) =====
    // Smaller fonts that scale further down on tight rows. Tag is shown only
    // for the root and the leaves to reduce clutter; internal nodes go untagged.
    const tagFontSize = Math.max(7.5, 9 * fontScale);
    const keyFontSize = Math.max(8.5, 11 * fontScale);
    levels.forEach((arr, d) => arr.forEach(n => {
      const x = n._cx - n._w / 2, y = n._cy - n._h / 2;
      svg.append('rect').attr('x', x).attr('y', y).attr('width', n._w).attr('height', n._h).attr('rx', 5)
         .attr('fill', 'var(--panel-2)')
         .attr('stroke', n.leaf ? 'var(--orange)' : 'var(--accent)').attr('stroke-width', 1.2);
      // Show tag only for ROOT and LEAF (internals go unlabelled to keep things clean)
      const showTag = n.leaf || n === tree.root;
      if (showTag) {
        svg.append('text').attr('x', n._cx).attr('y', y - 4).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono-dim').attr('font-size', tagFontSize)
           .text(n.leaf ? `LEAF ${leaves.indexOf(n) + 1}` : 'ROOT');
      }
      const cellW = (n._w - 6) / Math.max(n.keys.length, 1);
      n.keys.forEach((k, i) => {
        svg.append('text').attr('x', x + 3 + (i + 0.5) * cellW).attr('y', n._cy + 4).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', keyFontSize).text(k);
        if (i < n.keys.length - 1) {
          svg.append('line').attr('x1', x + 3 + (i + 1) * cellW).attr('y1', y + 5)
             .attr('x2', x + 3 + (i + 1) * cellW).attr('y2', y + n._h - 5)
             .attr('stroke', 'var(--border-2)').attr('stroke-dasharray', '2 3');
        }
      });
    }));
  }

  // ---- bindings ----
  section.querySelector('[data-act="insert"]').addEventListener('click', () => {
    const v = parseInt(section.querySelector('[data-key]').value, 10);
    handleInsert(v); section.querySelector('[data-key]').value = '';
  });
  section.querySelector('[data-act="insert5"]').addEventListener('click',  () => { for (let i=0;i<5;i++)  rawInsert(1 + Math.floor(Math.random()*99)); render(); log('Inserted 5 random keys.'); });
  section.querySelector('[data-act="insert20"]').addEventListener('click', () => { for (let i=0;i<20;i++) rawInsert(1 + Math.floor(Math.random()*999)); render(); log('Inserted 20 random keys.'); });
  section.querySelector('[data-act="reset"]').addEventListener('click',    () => { reset(); log('Tree reset.'); render(); });
  section.querySelector('[data-key]').addEventListener('keydown', (e) => { if (e.key === 'Enter') section.querySelector('[data-act="insert"]').click(); });

  // seed
  [20, 35, 50].forEach(k => rawInsert(k));
  render();
}
