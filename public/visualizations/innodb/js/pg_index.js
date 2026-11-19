/* pg_index.js — ㉓ Index Access · Postgres vs InnoDB
   The decisive contrast:
     · InnoDB primary index IS the data (clustered B-Tree). Secondary index
       leaves store the PRIMARY KEY VALUE — not a row pointer. So a secondary
       lookup is two B-Tree walks: secondary → PK, then primary → row.
     · Postgres primary and secondary indexes are STRUCTURALLY THE SAME — both
       store TIDs (block, slot) into a separate heap. PK and secondary lookups
       cost the same: one B-Tree walk + one heap fetch + visibility check.

   The visualization makes the secondary leaf the focal contrast: in InnoDB
   it boldly displays `→ id=42 (PK!)`; in Postgres it shows `→ (0, 1) (TID)`.
*/
(function () {
  const section = document.getElementById('pg-index');
  if (!section) return;

  section.innerHTML = `
    <h2><span class="no">㉓</span>Index Access · how a SELECT finds the row</h2>
    <p class="lead">Two queries. Two engines. Watch where the data actually lives. <em>InnoDB</em>: the primary index leaf <b>is</b> the row — but secondary index leaves store the <b>PK</b>, so a secondary lookup has to walk the primary tree again. <em>Postgres</em>: indexes only store TIDs (block, slot), and the heap is independent — PK and secondary lookups follow the same path.</p>

    <div class="controls">
      <button class="btn primary" data-act="pgix-pk">SELECT * WHERE id = 42</button>
      <button class="btn"          data-act="pgix-sec">SELECT * WHERE email = 'a…'</button>
      <button class="btn"          data-act="pgix-reset">↺ Reset</button>
    </div>

    <div class="viz-container" style="padding:24px">
      <svg id="pgix-svg" viewBox="0 0 1400 720" style="width:100%;height:auto"></svg>
    </div>

    <div class="inspector" id="pgix-log">Pick a query to see the lookup path on each engine. Both queries return the same row, but the path is very different.</div>
  `;

  // ===== State =====
  let st;
  function reset() { st = { query: null }; }
  reset();
  function pick(q) { st = { query: q }; }

  // ===== Render =====
  let pts = {};
  function setPt(k, x, y) { pts[k] = { x, y }; }

  function render() {
    const svg = d3.select('#pgix-svg');
    svg.selectAll('*').remove();
    pts = {};
    drawInnoDB(svg, 24, 24, 660, 670);
    drawPostgres(svg, 716, 24, 660, 670);
    drawArrows(svg);
    updateLog();
  }

  function panelBox(svg, x, y, w, h, color, title) {
    svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', h).attr('rx', 8)
       .attr('fill', 'var(--panel-2)').attr('stroke', color).attr('stroke-width', 1.4);
    svg.append('text').attr('x', x + 14).attr('y', y + 22).attr('class', 'lbl-mono')
       .attr('font-size', 13).attr('font-weight', 600).style('fill', color).text(title);
  }

  function stepBadge(svg, cx, cy, n, color) {
    svg.append('circle').attr('cx', cx).attr('cy', cy).attr('r', 12)
       .attr('fill', color).attr('opacity', 0.95);
    svg.append('text').attr('x', cx).attr('y', cy + 4).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono').attr('font-size', 13).attr('font-weight', 700)
       .style('fill', '#0a0a0a').text(String(n));
  }

  // Straight-line vertical drop with arrowhead. Used for index → heap.
  function arrowDown(svg, p, q, color, label) {
    if (!p || !q) return;
    svg.append('line').attr('x1', p.x).attr('y1', p.y).attr('x2', q.x).attr('y2', q.y - 8)
       .attr('stroke', color).attr('stroke-width', 2);
    svg.append('path').attr('d', `M${q.x - 6},${q.y - 10} L${q.x},${q.y} L${q.x + 6},${q.y - 10} Z`)
       .attr('fill', color);
    if (label) {
      svg.append('text').attr('x', q.x + 14).attr('y', (p.y + q.y) / 2 + 4)
         .attr('class', 'lbl-mono').attr('font-size', 10).attr('font-weight', 600).style('fill', color).text(label);
    }
  }

  // Curved arrow that goes from one panel area to another (left↔right).
  // Anchors p and q; bezier with control points pulled vertically for a clean
  // S-curve when going horizontally far.
  function arrowAcross(svg, p, q, color, label) {
    if (!p || !q) return;
    const dx = q.x - p.x, dy = q.y - p.y;
    // Cubic bezier with horizontal launch/arrival when dx > dy
    let c1x, c1y, c2x, c2y;
    if (Math.abs(dx) > Math.abs(dy)) {
      c1x = p.x + dx * 0.5; c1y = p.y;
      c2x = p.x + dx * 0.5; c2y = q.y;
    } else {
      c1x = p.x; c1y = p.y + dy * 0.5;
      c2x = q.x; c2y = p.y + dy * 0.5;
    }
    svg.append('path').attr('d', `M${p.x},${p.y} C${c1x},${c1y} ${c2x},${c2y} ${q.x},${q.y}`)
       .attr('fill', 'none').attr('stroke', color).attr('stroke-width', 2).attr('opacity', 0.95);
    // Arrowhead at q oriented to tangent
    const tx = q.x - c2x, ty = q.y - c2y;
    const tl = Math.hypot(tx, ty) || 1;
    const ux = tx / tl, uy = ty / tl;
    const bx = q.x - ux * 10, by = q.y - uy * 10;
    const wx = -uy * 5, wy = ux * 5;
    svg.append('path').attr('d', `M${bx + wx},${by + wy} L${q.x},${q.y} L${bx - wx},${by - wy} Z`)
       .attr('fill', color);
    if (label) {
      svg.append('text').attr('x', (p.x + q.x) / 2).attr('y', Math.min(p.y, q.y) - 8)
         .attr('text-anchor', 'middle').attr('class', 'lbl-mono')
         .attr('font-size', 11).attr('font-weight', 600).style('fill', color).text(label);
    }
  }

  // ========== InnoDB panel ==========
  // Layout:
  //   PRIMARY (CLUSTERED) on the left — full-height, contains tree + LEAF=ROW
  //   SECONDARY on the right — shorter, with a bold callout: leaves hold the PK
  //   Footer note at bottom
  function drawInnoDB(svg, x, y, w, h) {
    panelBox(svg, x, y, w, h, 'var(--accent)', 'InnoDB · primary index IS the data');

    const litPK  = st.query === 'pk';
    const litSec = st.query === 'sec';

    const inL = x + 16, inR = x + w - 16;
    const inW = inR - inL;
    // 60/40 split between primary and secondary
    const piW = Math.floor(inW * 0.60);
    const siW = inW - piW - 18;
    const piX = inL, siX = piX + piW + 18;
    const idxY = y + 50;
    const idxH = h - 50 - 92;     // leave 92px for footer note

    // ---- PRIMARY (CLUSTERED) — tree + leaf-as-row ----
    const piCol = (litPK || litSec) ? 'var(--orange)' : 'var(--ink-dim)';
    svg.append('rect').attr('x', piX).attr('y', idxY).attr('width', piW).attr('height', idxH).attr('rx', 6)
       .attr('fill', 'var(--panel)').attr('stroke', piCol).attr('stroke-width', (litPK || litSec) ? 1.8 : 1);
    svg.append('text').attr('x', piX + 14).attr('y', idxY + 22).attr('class', 'lbl-mono')
       .attr('font-size', 12).attr('font-weight', 600).style('fill', piCol).text('PRIMARY (CLUSTERED) INDEX');
    svg.append('text').attr('x', piX + piW - 14).attr('y', idxY + 22).attr('text-anchor', 'end')
       .attr('class', 'lbl-mono-dim').attr('font-size', 10).text('PK → FULL ROW');

    // Tree: root + 2 internals
    const rootCx = piX + piW / 2;
    const rootY  = idxY + 56;
    svg.append('rect').attr('x', rootCx - 32).attr('y', rootY).attr('width', 64).attr('height', 26).attr('rx', 4)
       .attr('fill', 'var(--bg-2)').attr('stroke', piCol);
    svg.append('text').attr('x', rootCx).attr('y', rootY + 17).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', piCol).text('root');
    const intY = rootY + 56;
    [-1, 1].forEach(d => {
      const ix = rootCx + d * 80;
      svg.append('rect').attr('x', ix - 36).attr('y', intY).attr('width', 72).attr('height', 26).attr('rx', 4)
         .attr('fill', 'var(--bg-2)').attr('stroke', piCol);
      svg.append('text').attr('x', ix).attr('y', intY + 17).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 10).style('fill', piCol).text('internal');
      svg.append('line').attr('x1', rootCx).attr('y1', rootY + 26).attr('x2', ix).attr('y2', intY)
         .attr('stroke', piCol).attr('opacity', 0.5);
    });

    // LEAF = ROW (the big green box that IS the data)
    const leafY = intY + 60;
    const leafH = (idxY + idxH) - leafY - 14;
    svg.append('rect').attr('x', piX + 14).attr('y', leafY).attr('width', piW - 28).attr('height', leafH).attr('rx', 5)
       .attr('fill', '#a3e6a3').attr('stroke', '#5fbf5f').attr('stroke-width', 1.8).attr('opacity', 0.95);
    svg.append('text').attr('x', rootCx).attr('y', leafY + 26).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono').attr('font-size', 13).attr('font-weight', 700).style('fill', '#0a0a0a').text('LEAF = ROW (no extra fetch)');
    [
      ['id:',    '42'],
      ['name:',  `'alice'`],
      ['email:', `'alice@…'`]
    ].forEach((p, i) => {
      svg.append('text').attr('x', piX + 38).attr('y', leafY + 60 + i * 22).attr('class', 'lbl-mono')
         .attr('font-size', 11).style('fill', '#0a0a0a').text(p[0]);
      svg.append('text').attr('x', piX + piW - 38).attr('y', leafY + 60 + i * 22).attr('text-anchor', 'end')
         .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', '#0a0a0a').attr('font-weight', 600).text(p[1]);
    });
    [-1, 1].forEach(d => {
      const ix = rootCx + d * 80;
      svg.append('line').attr('x1', ix).attr('y1', intY + 26).attr('x2', rootCx).attr('y2', leafY)
         .attr('stroke', piCol).attr('opacity', 0.5);
    });

    // Anchors for arrows
    setPt('i-pri-rt-internal', rootCx + 80 + 36, intY + 13);   // right edge of right internal node
    setPt('i-pri-leaf-rt',     piX + piW,        leafY + leafH / 2);  // right edge of leaf
    if (litPK)  stepBadge(svg, piX + piW - 22, idxY + 22, 1, 'var(--orange)');
    if (litSec) stepBadge(svg, piX + piW - 22, idxY + 22, 2, 'var(--orange)');

    // ---- SECONDARY — short, with PK callout ----
    // We make it visibly SHORTER than the primary, to convey "no row data here".
    const siCol = litSec ? 'var(--orange)' : 'var(--ink-dim)';
    const siH = Math.floor(idxH * 0.60);
    svg.append('rect').attr('x', siX).attr('y', idxY).attr('width', siW).attr('height', siH).attr('rx', 6)
       .attr('fill', 'var(--panel)').attr('stroke', siCol).attr('stroke-width', litSec ? 1.8 : 1);
    svg.append('text').attr('x', siX + 12).attr('y', idxY + 22).attr('class', 'lbl-mono')
       .attr('font-size', 12).attr('font-weight', 600).style('fill', siCol).text('SECONDARY INDEX');
    svg.append('text').attr('x', siX + siW - 12).attr('y', idxY + 22).attr('text-anchor', 'end')
       .attr('class', 'lbl-mono-dim').attr('font-size', 10).text('EMAIL → PK');
    // Mini-tree (just root)
    const siRootCx = siX + siW / 2;
    svg.append('rect').attr('x', siRootCx - 28).attr('y', idxY + 50).attr('width', 56).attr('height', 22).attr('rx', 4)
       .attr('fill', 'var(--bg-2)').attr('stroke', siCol);
    svg.append('text').attr('x', siRootCx).attr('y', idxY + 65).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono').attr('font-size', 10).style('fill', siCol).text('root');
    // Leaf — orange-tinted; emphasizes "this is NOT the row"
    const siLeafY = idxY + 88;
    const siLeafH = siH - 88 - 12;
    svg.append('rect').attr('x', siX + 12).attr('y', siLeafY).attr('width', siW - 24).attr('height', siLeafH).attr('rx', 5)
       .attr('fill', '#ffd99e').attr('stroke', '#ffa64d').attr('stroke-width', 1.6).attr('opacity', 0.92);
    svg.append('text').attr('x', siRootCx).attr('y', siLeafY + 22).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono').attr('font-size', 11).attr('font-weight', 700).style('fill', '#0a0a0a').text('LEAF (sec idx)');
    svg.append('text').attr('x', siRootCx).attr('y', siLeafY + 50).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono').attr('font-size', 12).style('fill', '#0a0a0a').text(`'alice@…'`);
    svg.append('text').attr('x', siRootCx).attr('y', siLeafY + 76).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono').attr('font-size', 14).attr('font-weight', 700).style('fill', '#d44').text('→ id=42 (PK!)');
    svg.append('line').attr('x1', siRootCx).attr('y1', idxY + 72).attr('x2', siRootCx).attr('y2', siLeafY)
       .attr('stroke', siCol).attr('opacity', 0.5);

    // Below the secondary: call out the consequence
    const noteY = idxY + siH + 18;
    svg.append('text').attr('x', siX + siW / 2).attr('y', noteY + 14).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono').attr('font-size', 11).attr('font-weight', 700).style('fill', siCol).text('value is the PK,');
    svg.append('text').attr('x', siX + siW / 2).attr('y', noteY + 30).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono').attr('font-size', 11).attr('font-weight', 700).style('fill', siCol).text('not a row pointer');
    svg.append('text').attr('x', siX + siW / 2).attr('y', noteY + 56).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', 'var(--ink-2)').text('→ walk PRIMARY again');

    // Anchor for sec → primary arrow
    setPt('i-sec-leaf-lt', siX + 12, siLeafY + siLeafH / 2);   // left edge of sec leaf
    if (litSec) stepBadge(svg, siX + siW - 22, idxY + 22, 1, 'var(--orange)');

    // Footer note (full-width)
    const footerY = y + h - 78;
    drawNote(svg, inL, footerY, inW, [
      'CLUSTERED LEAF *is* the row — PK lookup arrives directly with no heap fetch.',
      'Secondary leaf holds the *PK* — extra primary walk needed (2 B-Tree walks total).'
    ], 'var(--accent)');
  }

  // ========== Postgres panel ==========
  // Layout:
  //   PRIMARY index  |  SECONDARY index    (top row, equal-sized)
  //                  ↓                 ↓
  //   ────────────── HEAP ──────────────   (bottom, full width)
  //   Footer note
  function drawPostgres(svg, x, y, w, h) {
    panelBox(svg, x, y, w, h, '#5b9cff', 'Postgres · all indexes point at the heap');

    const litPK  = st.query === 'pk';
    const litSec = st.query === 'sec';

    const inL = x + 16, inR = x + w - 16;
    const inW = inR - inL;
    const idxW = (inW - 18) / 2;
    const piX = inL, siX = piX + idxW + 18;
    const idxY = y + 50;
    const idxH = 220;

    // PRIMARY index card (id → TID)
    const piCol = litPK ? '#5b9cff' : 'var(--ink-dim)';
    drawPgIdxCard(svg, piX, idxY, idxW, idxH, piCol,
      'PRIMARY INDEX', 'ID → TID',
      ['42 → (block 0, slot 1)', '43 → (block 0, slot 4)'],
      litPK);
    setPt('p-pi-bot', piX + idxW / 2, idxY + idxH);
    if (litPK) stepBadge(svg, piX + idxW - 22, idxY + 22, 1, '#5b9cff');

    // SECONDARY index card (email → TID — same form as primary)
    const siCol = litSec ? '#5b9cff' : 'var(--ink-dim)';
    drawPgIdxCard(svg, siX, idxY, idxW, idxH, siCol,
      'SECONDARY INDEX', 'EMAIL → TID',
      [`'alice@…' → (0, 1)`, '(same form as PK)'],
      litSec);
    setPt('p-si-bot', siX + idxW / 2, idxY + idxH);
    if (litSec) stepBadge(svg, siX + idxW - 22, idxY + 22, 1, '#5b9cff');

    // HEAP (full-width below, with vertical margin for the arrow drop)
    const heapY = idxY + idxH + 60;
    const heapH = (y + h - 92) - heapY - 8;
    const hpCol = (litPK || litSec) ? '#5b9cff' : 'var(--ink-dim)';
    svg.append('rect').attr('x', inL).attr('y', heapY).attr('width', inW).attr('height', heapH).attr('rx', 6)
       .attr('fill', 'var(--panel)').attr('stroke', hpCol).attr('stroke-width', (litPK || litSec) ? 1.8 : 1);
    svg.append('text').attr('x', inL + 14).attr('y', heapY + 22).attr('class', 'lbl-mono')
       .attr('font-size', 12).attr('font-weight', 600).style('fill', hpCol).text('HEAP  ·  page (block 0)');
    svg.append('text').attr('x', inR - 14).attr('y', heapY + 22).attr('text-anchor', 'end')
       .attr('class', 'lbl-mono-dim').attr('font-size', 10).text('TUPLES AT SLOTS;  TID = (BLOCK, OFFSET)');
    setPt('p-heap-top', inL + inW / 2, heapY);
    if (litPK || litSec) stepBadge(svg, inR - 22, heapY + 22, 2, '#5b9cff');

    // Live tuple
    const tY = heapY + 44;
    const tH = heapH - 56;
    svg.append('rect').attr('x', inL + 16).attr('y', tY).attr('width', inW - 32).attr('height', tH).attr('rx', 5)
       .attr('fill', '#a3e6a3').attr('stroke', '#5fbf5f').attr('stroke-width', 1.8).attr('opacity', 0.95);
    svg.append('text').attr('x', inL + inW / 2).attr('y', tY + 26).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono').attr('font-size', 13).attr('font-weight', 700).style('fill', '#0a0a0a').text('(0,1)  LIVE TUPLE');
    [
      ['id:',        '42'],
      ['name:',      `'alice'`],
      ['email:',     `'alice@…'`],
      ['xmin/xmax:', '100 / 0  → visibility check']
    ].forEach((p, i) => {
      svg.append('text').attr('x', inL + 36).attr('y', tY + 56 + i * 20).attr('class', 'lbl-mono')
         .attr('font-size', 11).style('fill', '#0a0a0a').text(p[0]);
      svg.append('text').attr('x', inR - 36).attr('y', tY + 56 + i * 20).attr('text-anchor', 'end')
         .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', '#0a0a0a').attr('font-weight', 600).text(p[1]);
    });

    // Footer note
    const footerY = y + h - 78;
    drawNote(svg, inL, footerY, inW, [
      'HEAP is independent — both PK and secondary indexes store TIDs (block, slot).',
      'Same lookup path either way: 1 B-Tree walk + 1 heap fetch + visibility check.'
    ], '#5b9cff');
  }

  function drawPgIdxCard(svg, x, y, w, h, color, title, sub, entries, lit) {
    svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', h).attr('rx', 6)
       .attr('fill', 'var(--panel)').attr('stroke', color).attr('stroke-width', lit ? 1.8 : 1);
    svg.append('text').attr('x', x + 14).attr('y', y + 22).attr('class', 'lbl-mono')
       .attr('font-size', 12).attr('font-weight', 600).style('fill', color).text(title);
    svg.append('text').attr('x', x + w - 14).attr('y', y + 22).attr('text-anchor', 'end')
       .attr('class', 'lbl-mono-dim').attr('font-size', 10).text(sub);

    // Mini tree
    const rootCx = x + w / 2;
    svg.append('rect').attr('x', rootCx - 28).attr('y', y + 56).attr('width', 56).attr('height', 24).attr('rx', 4)
       .attr('fill', 'var(--bg-2)').attr('stroke', color);
    svg.append('text').attr('x', rootCx).attr('y', y + 72).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', color).text('root');

    // Leaf
    const leafY = y + 100;
    const leafH = h - 100 - 14;
    svg.append('rect').attr('x', x + 14).attr('y', leafY).attr('width', w - 28).attr('height', leafH).attr('rx', 5)
       .attr('fill', color).attr('opacity', lit ? 0.18 : 0.10).attr('stroke', color).attr('stroke-width', 0.8);
    svg.append('text').attr('x', rootCx).attr('y', leafY + 22).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono').attr('font-size', 11).attr('font-weight', 700)
       .style('fill', lit ? color : 'var(--ink-dim)').text('LEAF (entries)');
    entries.forEach((e, i) => {
      svg.append('text').attr('x', rootCx).attr('y', leafY + 50 + i * 22).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 12)
         .style('fill', lit ? 'var(--ink)' : 'var(--ink-dim)').text(e);
    });
    svg.append('line').attr('x1', rootCx).attr('y1', y + 80).attr('x2', rootCx).attr('y2', leafY)
       .attr('stroke', color).attr('opacity', 0.5);
  }

  function drawNote(svg, x, y, w, lines, accent) {
    svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', 70).attr('rx', 6)
       .attr('fill', 'var(--bg-2)').attr('stroke', 'var(--border-2)');
    svg.append('rect').attr('x', x).attr('y', y).attr('width', 4).attr('height', 70)
       .attr('fill', accent || 'var(--accent)');
    lines.forEach((ln, i) => {
      svg.append('text').attr('x', x + 16).attr('y', y + 26 + i * 22).attr('class', 'lbl-mono')
         .attr('font-size', 11).style('fill', 'var(--ink-2)').text(ln);
    });
  }

  function drawArrows(svg) {
    if (st.query === 'pk') {
      // Postgres only: PK index → heap, straight vertical.
      arrowDown(svg, pts['p-pi-bot'], pts['p-heap-top'], '#5b9cff', 'heap_fetch');
    } else if (st.query === 'sec') {
      // InnoDB: secondary leaf → primary leaf (right-to-left arrow across panel).
      arrowAcross(svg, pts['i-sec-leaf-lt'], pts['i-pri-leaf-rt'], 'var(--orange)', 'walk PRIMARY with PK');
      // Postgres: secondary index → heap, straight vertical.
      arrowDown(svg, pts['p-si-bot'], pts['p-heap-top'], '#5b9cff', 'heap_fetch');
    }
  }

  function updateLog() {
    const el = document.getElementById('pgix-log');
    if (!el) return;
    if (st.query === 'pk') {
      el.innerHTML = '<b>SELECT * FROM users WHERE id = 42</b>. <em>InnoDB</em>: descend the clustered index — leaf <em>is</em> the row, no further fetch (1 walk). <em>Postgres</em>: descend the primary index → get TID → fetch the heap tuple → visibility check (1 walk + 1 heap fetch).';
    } else if (st.query === 'sec') {
      el.innerHTML = '<b>SELECT * FROM users WHERE email = \'alice@…\'</b>. <em>InnoDB</em>: descend the secondary index — leaf holds the <b>PK</b> — descend the clustered index again with that PK to find the row (<b>2 B-Tree walks</b>, no heap fetch). <em>Postgres</em>: descend the secondary index → get <b>TID</b> → fetch the heap tuple. Same cost as the PK lookup — every Postgres index has the same shape.';
    } else {
      el.innerHTML = 'Pick a query to see the lookup path on each engine. Both queries return the same row, but the path is very different.';
    }
  }

  // ===== Wire =====
  section.querySelector('[data-act="pgix-pk"]').addEventListener('click', () => { pick('pk'); render(); });
  section.querySelector('[data-act="pgix-sec"]').addEventListener('click', () => { pick('sec'); render(); });
  section.querySelector('[data-act="pgix-reset"]').addEventListener('click', () => { reset(); render(); });

  render();
})();
