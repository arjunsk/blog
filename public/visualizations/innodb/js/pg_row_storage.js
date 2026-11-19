/* pg_row_storage.js — ⑲ Row Storage · Postgres vs InnoDB
   The single most important MVCC difference: how each engine stores an UPDATE.
     · InnoDB: in-place — overwrite the row, write a tiny undo record holding
       the OLD value. The PK index never moves; secondary indexes touch only
       if their key changed. Reads walk the undo chain back in time.
     · Postgres: append-only — write a NEW heap tuple, mark the old one DEAD
       via xmax, and re-insert the index entry pointing at the new TID. Reads
       scan the heap and pick the one whose (xmin,xmax) brackets their snapshot.
*/
(function () {
  const section = document.getElementById('pg-row');
  if (!section) return;

  section.innerHTML = `
    <h2><span class="no">⑲</span>Row Storage · the central MVCC difference</h2>
    <p class="lead">When you UPDATE a row, what does each engine actually <em>write</em>? InnoDB updates in place and stashes the old value in undo. Postgres writes a brand-new tuple to the heap and leaves the old one as a tombstone. This single decision cascades through every other MVCC behavior — read cost, vacuum, indexes, even table bloat.</p>

    <div class="controls">
      <button class="btn primary" data-act="pgrs-next">▶ Next UPDATE</button>
      <button class="btn"          data-act="pgrs-reset">↺ Reset</button>
    </div>

    <div class="viz-container" style="padding:24px">
      <svg id="pgrs-svg" viewBox="0 0 1400 560" style="width:100%;height:auto"></svg>
    </div>

    <div class="inspector" id="pgrs-log">Initial state: row PK=42, name='alice', written by tx_100. Click <b>▶ Next UPDATE</b> to mutate it and watch each engine react differently.</div>
  `;

  // ===== State =====
  // We track the ordered sequence of values: [{trx_id, name}]. Index 0 is the
  // INSERT, subsequent entries are UPDATEs. The "live" version is the last.
  const NAMES = ['alice', 'bob', 'carol', 'dave', 'eve', 'frank', 'grace'];
  let st;
  function reset() {
    st = { history: [{ trx_id: 100, name: 'alice' }] };
  }
  reset();

  function nextUpdate() {
    if (st.history.length >= 4) return;       // cap so the viz stays readable
    const i = st.history.length;
    st.history.push({ trx_id: 100 + i, name: NAMES[i] });
  }

  // ===== Render =====
  // Connection-point registry — populated as panels draw. Used after layout
  // to draw clean inter-element arrows.
  let pts = {};
  function setPt(k, x, y) { pts[k] = { x, y }; }

  function render() {
    const svg = d3.select('#pgrs-svg');
    svg.selectAll('*').remove();
    if (typeof installArrowDefs === 'function') installArrowDefs(svg);
    pts = {};
    drawInnoDB(svg, 24, 24, 660, 510);
    drawPostgres(svg, 716, 24, 660, 510);
    drawArrows(svg);
    updateLog();
  }

  // A "chain link" arc that rises above two anchors and drops back down.
  // Used for the prev_roll_ptr arrows between undo cards so they don't get
  // sandwiched in the tiny gap between cards.
  function arcAbove(svg, fromKey, toKey, color, label) {
    const p = pts[fromKey], q = pts[toKey];
    if (!p || !q) return;
    const peakY = Math.min(p.y, q.y) - 26;            // arc peak height
    // Cubic bezier with control points pulled directly upward — vertical
    // tangent at both endpoints, smooth dome shape.
    const c1x = p.x, c1y = peakY;
    const c2x = q.x, c2y = peakY;
    svg.append('path')
       .attr('d', `M${p.x},${p.y} C${c1x},${c1y} ${c2x},${c2y} ${q.x},${q.y}`)
       .attr('fill', 'none').attr('stroke', color).attr('stroke-width', 2).attr('opacity', 0.92);
    // Arrowhead at q — tangent comes from straight above (down-pointing).
    svg.append('path').attr('d', `M${q.x - 5},${q.y - 8} L${q.x},${q.y} L${q.x + 5},${q.y - 8} Z`)
       .attr('fill', color);
    if (label) {
      svg.append('text').attr('x', (p.x + q.x) / 2).attr('y', peakY - 6).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 10).style('fill', color).text(label);
    }
  }

  // Curvy bezier between two registered points.
  function curveArrow(svg, fromKey, toKey, color, label) {
    const p = pts[fromKey], q = pts[toKey];
    if (!p || !q) return;
    const dx = q.x - p.x, dy = q.y - p.y;
    const dist = Math.hypot(dx, dy) || 1;
    const nx = -dy / dist, ny = dx / dist;
    const bow = Math.min(dist * 0.28, 70);
    const c1x = p.x + dx * 0.25 + nx * bow;
    const c1y = p.y + dy * 0.25 + ny * bow;
    const c2x = p.x + dx * 0.75 + nx * bow;
    const c2y = p.y + dy * 0.75 + ny * bow;
    svg.append('path').attr('d', `M${p.x},${p.y} C${c1x},${c1y} ${c2x},${c2y} ${q.x},${q.y}`)
       .attr('fill', 'none').attr('stroke', color).attr('stroke-width', 2).attr('opacity', 0.9);
    // arrowhead at q oriented to tangent
    const tx = q.x - c2x, ty = q.y - c2y;
    const tl = Math.hypot(tx, ty) || 1;
    const ux = tx / tl, uy = ty / tl;
    const bx = q.x - ux * 9, by = q.y - uy * 9;
    const wx = -uy * 5, wy = ux * 5;
    svg.append('path').attr('d', `M${bx + wx},${by + wy} L${q.x},${q.y} L${bx - wx},${by - wy} Z`)
       .attr('fill', color);
    if (label) {
      svg.append('text').attr('x', (p.x + q.x) / 2 + nx * (bow + 12))
         .attr('y', (p.y + q.y) / 2 + ny * (bow + 12)).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 9).style('fill', color).text(label);
    }
  }

  function drawArrows(svg) {
    // InnoDB: row's DB_ROLL_PTR cell → newest undo card
    if (st.history.length > 1) {
      curveArrow(svg, 'i-rollptr', 'i-undo-newest', 'var(--orange)', 'DB_ROLL_PTR');
    }
    // InnoDB: prev_roll_ptr chain — drawn as ARCS ABOVE the undo cards so each
    // link is visually distinct from the cards themselves.
    const undoCount = Math.max(0, st.history.length - 1);
    for (let i = 0; i < undoCount - 1; i++) {
      arcAbove(svg, `i-undo-${i}-tr`, `i-undo-${i + 1}-tl`, 'var(--accent-2)', i === 0 ? 'prev_roll_ptr' : null);
    }
    // Postgres: primary index entry → live tuple
    curveArrow(svg, 'p-index', 'p-live', '#5b9cff', 'TID points here');
    // Postgres: ctid → next chain. Drawn as short straight vertical lines on
    // the right inner edge of each tuple so they STAY INSIDE the heap box.
    for (let i = 0; i < st.history.length - 1; i++) {
      const yA = pts[`p-tuple-${i}-right`];
      const yB = pts[`p-tuple-${i + 1}-right`];
      if (!yA || !yB) continue;
      const xLine = yA.x;
      svg.append('line').attr('x1', xLine).attr('y1', yA.y + 4)
         .attr('x2', xLine).attr('y2', yB.y - 6)
         .attr('stroke', 'var(--ink-dim)').attr('stroke-width', 1.2).attr('opacity', 0.7);
      // tiny arrowhead at the bottom end
      svg.append('path').attr('d', `M${xLine - 3},${yB.y - 10} L${xLine},${yB.y - 6} L${xLine + 3},${yB.y - 10}`)
         .attr('fill', 'var(--ink-dim)').attr('opacity', 0.7);
      if (i === 0) {
        svg.append('text').attr('x', xLine + 6).attr('y', (yA.y + yB.y) / 2 + 4)
           .attr('class', 'lbl-mono').attr('font-size', 9).style('fill', 'var(--ink-dim)').text('ctid →');
      }
    }
  }

  function panelBox(svg, x, y, w, h, color, title) {
    svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', h).attr('rx', 8)
       .attr('fill', 'var(--panel-2)').attr('stroke', color).attr('stroke-width', 1.4);
    svg.append('text').attr('x', x + 14).attr('y', y + 22).attr('class', 'lbl-mono')
       .attr('font-size', 13).attr('font-weight', 600).style('fill', color).text(title);
  }

  // ---------- LEFT: InnoDB ----------
  function drawInnoDB(svg, x, y, w, h) {
    panelBox(svg, x, y, w, h, 'var(--accent)', 'InnoDB · in-place update + undo chain');

    // Primary index banner
    const banY = y + 50, banH = 38;
    svg.append('rect').attr('x', x + 16).attr('y', banY).attr('width', w - 32).attr('height', banH).attr('rx', 5)
       .attr('fill', 'var(--panel)').attr('stroke', 'var(--orange)').attr('stroke-width', 1.2);
    svg.append('text').attr('x', x + 28).attr('y', banY + 16).attr('class', 'lbl-mono')
       .attr('font-size', 11).style('fill', 'var(--orange)').text('PRIMARY (CLUSTERED) INDEX · id');
    svg.append('text').attr('x', x + 28).attr('y', banY + 30).attr('class', 'lbl-mono-dim')
       .attr('font-size', 10).text('B+TREE LEAF LITERALLY STORES THE ROW — NO POINTER, NO REWRITE ACROSS UPDATES');
    svg.append('text').attr('x', x + w - 28).attr('y', banY + 22).attr('text-anchor', 'end')
       .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', 'var(--orange)').text('index = data');

    // Live row card
    const live = st.history[st.history.length - 1];
    const rowY = banY + banH + 18, rowH = 78;
    svg.append('rect').attr('x', x + 16).attr('y', rowY).attr('width', w - 32).attr('height', rowH).attr('rx', 6)
       .attr('fill', 'var(--panel)').attr('stroke', 'var(--orange)').attr('stroke-width', 1.6);
    svg.append('text').attr('x', x + 28).attr('y', rowY + 18).attr('class', 'lbl-mono')
       .attr('font-size', 10).style('fill', 'var(--orange)').text('LEAF ENTRY FOR ID=42  ·  UPDATED IN PLACE');

    const fields = [
      ['ID',          '42'],
      ['NAME',        `'${live.name}'`],
      ['DB_TRX_ID',   `tx_${live.trx_id}`],
      ['DB_ROLL_PTR', st.history.length === 1 ? 'NULL' : `→ undo #${st.history.length - 1}`]
    ];
    // Card content area: x+28 .. x+w-28 (12px inset from card edges).
    // Distribute 4 cells of width cellW with gap=8 between them so the row of
    // cells exactly spans the content area — no overflow.
    const cellInset = 12, cellGap = 8;
    const contentL  = x + 16 + cellInset;        // = x + 28
    const contentR  = x + w - 16 - cellInset;    // = x + w - 28
    const cellW     = (contentR - contentL - 3 * cellGap) / 4;   // = (w - 80) / 4
    fields.forEach((f, i) => {
      const cx = contentL + i * (cellW + cellGap);
      svg.append('rect').attr('x', cx).attr('y', rowY + 28).attr('width', cellW).attr('height', 38).attr('rx', 4)
         .attr('fill', 'var(--bg-2)').attr('stroke', 'var(--border-2)');
      svg.append('text').attr('x', cx + 8).attr('y', rowY + 42).attr('class', 'lbl-mono-dim').attr('font-size', 9).text(f[0]);
      svg.append('text').attr('x', cx + cellW / 2).attr('y', rowY + 60).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 12).style('fill', 'var(--ink)').text(f[1]);
      if (f[0] === 'DB_ROLL_PTR') {
        setPt('i-rollptr', cx + cellW / 2, rowY + 28 + 38);
      }
    });

    // Undo log section — pushed down extra to leave headroom for the
    // prev_roll_ptr chain arcs that hover above the cards.
    const undoY = rowY + rowH + 24;
    svg.append('text').attr('x', x + 16).attr('y', undoY).attr('class', 'lbl-mono-dim').attr('font-size', 11)
       .text('UNDO LOG · ROLLBACK SEGMENT');
    svg.append('text').attr('x', x + w - 16).attr('y', undoY).attr('text-anchor', 'end')
       .attr('class', 'lbl-mono-dim').attr('font-size', 11).text('NEWEST FIRST →');

    const undoBoxY = undoY + 38, undoBoxH = 110;   // 38px gap so the arc has air
    if (st.history.length === 1) {
      svg.append('rect').attr('x', x + 16).attr('y', undoBoxY).attr('width', w - 32).attr('height', undoBoxH).attr('rx', 6)
         .attr('fill', 'transparent').attr('stroke', 'var(--border-2)').attr('stroke-dasharray', '4 4');
      svg.append('text').attr('x', x + w / 2).attr('y', undoBoxY + undoBoxH / 2 + 4).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono-dim').attr('font-size', 11).text('(empty — no updates yet)');
    } else {
      // Undo records ordered NEWEST FIRST (left). Cards stretch to fill the
      // panel width so they don't sit awkwardly left-aligned with empty space.
      const records = [];
      for (let i = st.history.length - 1; i >= 1; i--) {
        const cur = st.history[i], prev = st.history[i - 1];
        records.push({ idx: i, prevName: prev.name, prevRoll: i === 1 ? 'NULL' : `#${i - 1}`, isNewest: i === st.history.length - 1, isOldest: i === 1 });
      }
      const cardL = x + 16, cardR = x + w - 16;
      const cardGap = 14;
      const cardW = (cardR - cardL - (records.length - 1) * cardGap) / records.length;
      records.forEach((r, i) => {
        const cx = cardL + i * (cardW + cardGap);
        svg.append('rect').attr('x', cx).attr('y', undoBoxY).attr('width', cardW).attr('height', undoBoxH).attr('rx', 5)
           .attr('fill', 'var(--panel)').attr('stroke', 'var(--orange)').attr('stroke-width', 1.2);
        // Newest undo card is the leftmost (i=0) — anchor for the ROLL_PTR arrow
        if (r.isNewest) setPt('i-undo-newest', cx + cardW / 2, undoBoxY);
        // Top-corner anchors for the prev_roll_ptr chain arc (drawn ABOVE cards)
        setPt(`i-undo-${i}-tr`, cx + cardW - 8, undoBoxY);
        setPt(`i-undo-${i}-tl`, cx + 8,         undoBoxY);
        svg.append('text').attr('x', cx + 10).attr('y', undoBoxY + 16).attr('class', 'lbl-mono')
           .attr('font-size', 11).style('fill', 'var(--orange)').text(`undo #${r.idx}`);
        svg.append('text').attr('x', cx + cardW - 10).attr('y', undoBoxY + 16).attr('text-anchor', 'end')
           .attr('class', 'lbl-mono-dim').attr('font-size', 9).style('fill', 'var(--ink-dim)')
           .text(r.isNewest ? 'NEWEST' : (r.isOldest ? 'OLDEST' : ''));
        const lines = [
          ['PREV NAME',   `'${r.prevName}'`],
          ['PREV_ROLL',   r.prevRoll]
        ];
        lines.forEach((ln, j) => {
          svg.append('text').attr('x', cx + 10).attr('y', undoBoxY + 42 + j * 22).attr('class', 'lbl-mono-dim')
             .attr('font-size', 10).text(ln[0]);
          svg.append('text').attr('x', cx + cardW - 10).attr('y', undoBoxY + 42 + j * 22).attr('text-anchor', 'end')
             .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', 'var(--ink)').text(ln[1]);
        });
      });
    }

    // Cost summary
    const costY = y + h - 92;
    drawCost(svg, x + 16, costY, w - 32, 'WRITE COST', [
      `HEAP: 1 ROW (always — same row, in place)  ·  UNDO: ${st.history.length - 1} RECORD${st.history.length - 1 === 1 ? '' : 'S'}`,
      'PRIMARY INDEX ENTRY UNCHANGED  ·  MVCC READ WALKS UNDO N→O'
    ]);
  }

  // ---------- RIGHT: Postgres ----------
  function drawPostgres(svg, x, y, w, h) {
    panelBox(svg, x, y, w, h, '#5b9cff', 'Postgres · append new tuple to heap');

    // Primary index banner — separate B-Tree pointing at TIDs
    const banY = y + 50, banH = 38;
    svg.append('rect').attr('x', x + 16).attr('y', banY).attr('width', w - 32).attr('height', banH).attr('rx', 5)
       .attr('fill', 'var(--panel)').attr('stroke', '#5b9cff').attr('stroke-width', 1.2);
    svg.append('text').attr('x', x + 28).attr('y', banY + 16).attr('class', 'lbl-mono')
       .attr('font-size', 11).style('fill', '#5b9cff').text('PRIMARY INDEX · id  ·  separate B-Tree');
    svg.append('text').attr('x', x + 28).attr('y', banY + 30).attr('class', 'lbl-mono-dim')
       .attr('font-size', 10).text('LEAF ENTRIES POINT TO HEAP TUPLES BY (BLOCK, SLOT)');
    const liveTID = `(0, ${st.history.length})`;
    svg.append('text').attr('x', x + w - 28).attr('y', banY + 22).attr('text-anchor', 'end')
       .attr('class', 'lbl-mono').attr('font-size', 12).style('fill', '#5b9cff').text(`id=42 → ${liveTID}`);
    // anchor: bottom-mid of the index banner (so the arrow drops down to the live tuple)
    setPt('p-index', x + w - 80, banY + banH);

    // Heap page
    const heapY = banY + banH + 18, heapH = 196;
    svg.append('rect').attr('x', x + 16).attr('y', heapY).attr('width', w - 32).attr('height', heapH).attr('rx', 6)
       .attr('fill', 'var(--panel)').attr('stroke', 'var(--ink-dim)').attr('stroke-width', 1.2);
    svg.append('text').attr('x', x + 28).attr('y', heapY + 16).attr('class', 'lbl-mono-dim')
       .attr('font-size', 10).text('HEAP · USERS · PAGE (BLOCK 0)  ·  SLOTS GROW DOWN');

    // Tuples — one per UPDATE. Live = last. Dead = others.
    // Each tuple row is laid out as a clean grid:
    //   [STATUS PILL] [TID]   |   [name]   [xmin]   [xmax]
    //   left zone (160 wide)  |   right zone — 3 equal cols
    const tupY0  = heapY + 30;
    const tupL   = x + 28;                    // tuple card left edge (12px inset)
    const tupR   = x + w - 28;                // tuple card right edge
    const tupWPx = tupR - tupL;
    const liveIdx = st.history.length - 1;
    st.history.forEach((v, i) => {
      const isLive = i === liveIdx;
      const xmax = isLive ? '0' : String(st.history[i + 1].trx_id);
      const tid = `(0, ${i + 1})`;
      const tupY = tupY0 + i * 38;
      const stroke  = isLive ? '#5b9cff' : 'var(--ink-dim)';
      const strokeW = isLive ? 1.6 : 1;

      svg.append('rect').attr('x', tupL).attr('y', tupY).attr('width', tupWPx).attr('height', 32).attr('rx', 4)
         .attr('fill', 'var(--bg-2)').attr('stroke', stroke).attr('stroke-width', strokeW)
         .attr('stroke-dasharray', isLive ? null : '5 4');
      setPt(`p-tuple-${i}`, tupL, tupY + 16);
      // Right-inner-edge anchor for the ctid chain arrow (kept INSIDE the heap card)
      setPt(`p-tuple-${i}-right`, tupR - 14, tupY + 16);
      if (isLive) setPt('p-live', tupL + 8, tupY);

      // Left zone: status pill + TID
      const pillX = tupL + 8, pillW = 60;
      svg.append('rect').attr('x', pillX).attr('y', tupY + 7).attr('width', pillW).attr('height', 18).attr('rx', 3)
         .attr('fill', isLive ? '#5b9cff' : 'var(--ink-dim)').attr('opacity', isLive ? 0.95 : 0.45);
      svg.append('text').attr('x', pillX + pillW / 2).attr('y', tupY + 20).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 10).attr('font-weight', 700)
         .style('fill', isLive ? '#0a0a0a' : 'var(--bg-2)').text(isLive ? 'LIVE' : 'DEAD');
      const tidX = pillX + pillW + 8;
      svg.append('text').attr('x', tidX).attr('y', tupY + 20).attr('class', 'lbl-mono')
         .attr('font-size', 11).style('fill', isLive ? 'var(--ink)' : 'var(--ink-dim)').text(tid);

      // Right zone: 3 equal columns for name / xmin / xmax
      const cols = [
        ['name', `'${v.name}'`],
        ['xmin', String(v.trx_id)],
        ['xmax', xmax]
      ];
      const rightL = tupL + 160;                                // start of right zone
      const colsW  = tupR - rightL - 8;                          // available width
      const colW   = colsW / cols.length;
      cols.forEach((c, j) => {
        const cx = rightL + j * colW;
        svg.append('text').attr('x', cx + 4).attr('y', tupY + 12).attr('class', 'lbl-mono-dim').attr('font-size', 8).text(c[0]);
        svg.append('text').attr('x', cx + colW - 6).attr('y', tupY + 26).attr('text-anchor', 'end')
           .attr('class', 'lbl-mono').attr('font-size', 11)
           .style('fill', isLive ? 'var(--ink)' : 'var(--ink-dim)').text(c[1]);
      });
    });

    // Cost summary
    const costY = y + h - 92;
    const dead = liveIdx;  // number of dead tuples
    drawCost(svg, x + 16, costY, w - 32, 'WRITE COST', [
      `HEAP: ${st.history.length} TUPLE${st.history.length === 1 ? '' : 'S'} (1 LIVE, ${dead} DEAD)  ·  NO UNDO`,
      'PRIMARY INDEX ENTRY RE-INSERTED PER UPDATE (UNLESS HOT)'
    ]);
  }

  function drawCost(svg, x, y, w, title, lines) {
    svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', 76).attr('rx', 6)
       .attr('fill', 'var(--bg-2)').attr('stroke', 'var(--border-2)');
    svg.append('text').attr('x', x + 14).attr('y', y + 18).attr('class', 'lbl-mono')
       .attr('font-size', 11).attr('font-weight', 600).style('fill', 'var(--ink-2)').text(title);
    lines.forEach((ln, i) => {
      svg.append('text').attr('x', x + 14).attr('y', y + 38 + i * 16).attr('class', 'lbl-mono-dim')
         .attr('font-size', 10).text(`·  ${ln}`);
    });
  }

  function updateLog() {
    const el = document.getElementById('pgrs-log');
    if (!el) return;
    const n = st.history.length;
    if (n === 1) {
      el.innerHTML = '<b>Initial state.</b> Row PK=42, name=\'alice\', written by tx_100. <em>InnoDB</em>: leaf entry holds the row directly. <em>Postgres</em>: heap tuple (0,1) is alive, primary index points at it. Click <b>▶ Next UPDATE</b>.';
    } else {
      const cur = st.history[n - 1];
      const prev = st.history[n - 2];
      el.innerHTML = `<b>Step ${n - 1} · UPDATE</b> by tx_${cur.trx_id}: name '${prev.name}' → '${cur.name}'.<br>` +
        `<b>InnoDB</b>: same leaf entry overwritten in place. Wrote 1 undo record holding the old name; chained backwards via PREV_ROLL. ` +
        `<b>Postgres</b>: appended a fresh tuple at slot ${n}, marked the previous tuple DEAD via xmax=tx_${cur.trx_id}, re-inserted the primary index entry to point at the new TID (0,${n}). ` +
        `Notice the heap is now ${n} tuples; the index is touched on every UPDATE (unless the row stays on the same page, a.k.a. HOT update).`;
    }
  }

  // ===== Wire up =====
  section.querySelector('[data-act="pgrs-next"]').addEventListener('click', () => { nextUpdate(); render(); });
  section.querySelector('[data-act="pgrs-reset"]').addEventListener('click', () => { reset(); render(); });

  render();
})();
