/* pg_mvcc.js — ⑳ MVCC Visibility · Postgres vs InnoDB
   Same row, same snapshot, two completely different read paths.

   Setup: tx_100 INSERT, then tx_101..103 each UPDATE the row. A fifth trx,
   tx_104, opens a snapshot whose cutoff is xmax ≤ 102 — i.e. it can see
   tx_100/101/102 but NOT tx_103 (the newest update).

     · InnoDB: starts at the live row, walks the undo chain Newest → Oldest
       until it finds a version whose trx_id is visible. Cost = 1 row read
       + N undo records walked.
     · Postgres: scans every tuple in the heap (or follows index → TIDs) and
       picks the one whose [xmin, xmax) contains the snapshot. Cost = O(N)
       tuple inspections — including DEAD ones — until vacuum reclaims them.
*/
(function () {
  const section = document.getElementById('pg-mvcc');
  if (!section) return;

  section.innerHTML = `
    <h2><span class="no">⑳</span>MVCC Visibility · how each engine reads a snapshot</h2>
    <p class="lead">A reader\'s snapshot says <code>visible iff trx_id ≤ 102</code>. The chain has tx_100, tx_101, tx_102 (visible) and tx_103 (invisible — too new). InnoDB starts at the live row and walks the undo chain newest→oldest. Postgres scans every tuple in the heap and checks each one\'s (xmin, xmax). Watch how the cost differs as you advance the reader step by step.</p>

    <div class="controls">
      <button class="btn primary" data-act="pgmv-next">▶ Advance reader</button>
      <button class="btn"          data-act="pgmv-reset">↺ Reset</button>
    </div>

    <div class="viz-container" style="padding:24px">
      <svg id="pgmv-svg" viewBox="0 0 1400 600" style="width:100%;height:auto"></svg>
    </div>

    <div class="inspector" id="pgmv-log">Snapshot ready. Cutoff is xmax ≤ 102, so the reader must skip tx_103. Press <b>▶ Advance reader</b> to step both engines through the walk.</div>
  `;

  // ===== Fixed dataset =====
  // 4 versions: tx_100 INSERT then tx_101/102/103 UPDATE.
  const VERSIONS = [
    { trx_id: 100, name: 'alice' },
    { trx_id: 101, name: 'bob'   },
    { trx_id: 102, name: 'carol' },
    { trx_id: 103, name: 'dave'  }
  ];
  const SNAPSHOT_CUTOFF = 102;   // visible iff trx_id ≤ this

  // ===== State =====
  // We track each engine's progress independently so InnoDB can FREEZE the
  // moment it lands on a visible version (step 2) while Postgres keeps
  // scanning the rest of the page (steps 1..4). Each click advances both
  // engines by one — but InnoDB's counter clamps at I_STOP_AT.
  const I_STOP_AT = 2;   // InnoDB stops after 2 items: live row + undo #3 (visible)
  const P_MAX     = 4;   // Postgres scans all 4 tuples
  let st;
  function reset() { st = { step: 0 }; }
  reset();

  function advance() {
    if (st.step < P_MAX) st.step++;
  }
  // Effective step counts used by the renderers
  function iStep() { return Math.min(st.step, I_STOP_AT); }
  function pStep() { return Math.min(st.step, P_MAX); }
  function foundI() { return iStep() >= I_STOP_AT; }
  function foundP() { return pStep() >= 3; }

  // ===== Render =====
  function render() {
    const svg = d3.select('#pgmv-svg');
    svg.selectAll('*').remove();

    // Header — snapshot pill (taller for breathing room)
    svg.append('rect').attr('x', 24).attr('y', 16).attr('width', 1352).attr('height', 44).attr('rx', 6)
       .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--accent)').attr('stroke-width', 1.2);
    svg.append('text').attr('x', 24 + 1352 / 2).attr('y', 35).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono').attr('font-size', 13).attr('font-weight', 600).style('fill', 'var(--accent)')
       .text(`SNAPSHOT  ·  visible iff  trx_id ≤ ${SNAPSHOT_CUTOFF}`);
    svg.append('text').attr('x', 24 + 1352 / 2).attr('y', 52).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono-dim').attr('font-size', 10)
       .text('tx_100, tx_101, tx_102 committed before snapshot  ·  tx_103 NOT in snapshot');

    // Panels — taller (520 vs 470) so undo cards and heap tuples have margin
    drawInnoDB(svg, 24, 76, 660, 520);
    drawPostgres(svg, 716, 76, 660, 520);

    updateLog();
  }

  function panelBox(svg, x, y, w, h, color, title) {
    svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', h).attr('rx', 8)
       .attr('fill', 'var(--panel-2)').attr('stroke', color).attr('stroke-width', 1.4);
    svg.append('text').attr('x', x + 14).attr('y', y + 22).attr('class', 'lbl-mono')
       .attr('font-size', 13).attr('font-weight', 600).style('fill', color).text(title);
  }

  function isVisible(trx_id) { return trx_id <= SNAPSHOT_CUTOFF; }

  // ---------- LEFT: InnoDB walk ----------
  function drawInnoDB(svg, x, y, w, h) {
    panelBox(svg, x, y, w, h, 'var(--accent)', 'InnoDB · walk undo chain Newest → Oldest (N→O)');

    // Primary index banner
    const banY = y + 50;
    svg.append('rect').attr('x', x + 16).attr('y', banY).attr('width', w - 32).attr('height', 32).attr('rx', 5)
       .attr('fill', 'var(--panel)').attr('stroke', 'var(--orange)').attr('stroke-width', 1.2);
    svg.append('text').attr('x', x + 28).attr('y', banY + 14).attr('class', 'lbl-mono')
       .attr('font-size', 11).style('fill', 'var(--orange)').text('PRIMARY (CLUSTERED) INDEX · id');
    svg.append('text').attr('x', x + 28).attr('y', banY + 27).attr('class', 'lbl-mono-dim')
       .attr('font-size', 10).text('LEAF = LIVE ROW · READER STARTS HERE');
    svg.append('text').attr('x', x + w - 28).attr('y', banY + 22).attr('text-anchor', 'end')
       .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', 'var(--orange)').text('index = data');

    // Live row card
    const live = VERSIONS[VERSIONS.length - 1];
    const rowY = banY + 46;
    const rowFocused = iStep() >= 1;
    const rowVisible = isVisible(live.trx_id);
    const rowColor = !rowFocused ? 'var(--ink-dim)' : (rowVisible ? 'var(--ok)' : 'var(--err)');
    svg.append('rect').attr('x', x + 16).attr('y', rowY).attr('width', w - 32).attr('height', 56).attr('rx', 6)
       .attr('fill', 'var(--panel)').attr('stroke', rowColor).attr('stroke-width', rowFocused ? 1.8 : 1.2);
    svg.append('text').attr('x', x + 28).attr('y', rowY + 22).attr('class', 'lbl-mono')
       .attr('font-size', 11).style('fill', rowColor).text('LIVE ROW (btree leaf)');
    svg.append('text').attr('x', x + 28).attr('y', rowY + 42).attr('class', 'lbl-mono')
       .attr('font-size', 12).style('fill', 'var(--ink)').text(`name='${live.name}'`);
    svg.append('text').attr('x', x + w - 28).attr('y', rowY + 22).attr('text-anchor', 'end')
       .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', rowColor)
       .text(rowFocused ? (rowVisible ? '✓ visible' : '✗ not visible — walk undo') : '');
    svg.append('text').attr('x', x + w - 28).attr('y', rowY + 42).attr('text-anchor', 'end')
       .attr('class', 'lbl-mono').attr('font-size', 12).style('fill', 'var(--orange)').text(`tx_${live.trx_id}`);

    // Walk direction label
    svg.append('text').attr('x', x + 16).attr('y', rowY + 92).attr('class', 'lbl-mono-dim').attr('font-size', 11).text('DB_ROLL_PTR CHAIN');
    svg.append('text').attr('x', x + w - 16).attr('y', rowY + 92).attr('text-anchor', 'end')
       .attr('class', 'lbl-mono-dim').attr('font-size', 11).text('WALK DIRECTION →');

    // Undo cards: index 3 → 2 → 1 (newest first). Taller cards w/ extra
    // vertical breathing room so each PREV field has its own clean line.
    const undoY = rowY + 116;
    const cardW = (w - 32 - 28) / 3;
    const undoCardH = 144;
    for (let i = 0; i < 3; i++) {
      const undoIdx = 3 - i;                              // 3, 2, 1
      const cur = VERSIONS[undoIdx];
      const prev = VERSIONS[undoIdx - 1];
      const inspectedAtStep = i + 2;
      const focused = iStep() >= inspectedAtStep;
      const visible = isVisible(prev.trx_id);
      const col = !focused ? 'var(--ink-dim)' : (visible ? 'var(--ok)' : 'var(--err)');
      const cx = x + 16 + i * (cardW + 14);
      svg.append('rect').attr('x', cx).attr('y', undoY).attr('width', cardW).attr('height', undoCardH).attr('rx', 5)
         .attr('fill', 'var(--panel)').attr('stroke', col).attr('stroke-width', focused ? 1.6 : 1.1);
      svg.append('text').attr('x', cx + 10).attr('y', undoY + 16).attr('class', 'lbl-mono').attr('font-size', 11)
         .style('fill', col).text(`undo #${undoIdx}`);
      svg.append('text').attr('x', cx + cardW - 10).attr('y', undoY + 16).attr('text-anchor', 'end')
         .attr('class', 'lbl-mono-dim').attr('font-size', 9).text(i === 0 ? 'NEWEST' : (i === 2 ? 'OLDEST' : ''));
      const pairs = [
        ['PREV NAME', `'${prev.name}'`],
        ['PREV trx_id', `${prev.trx_id}`],
        ['PREV_ROLL',  undoIdx === 1 ? 'NULL' : `#${undoIdx - 1}`]
      ];
      pairs.forEach((p, j) => {
        svg.append('text').attr('x', cx + 12).attr('y', undoY + 46 + j * 24).attr('class', 'lbl-mono-dim').attr('font-size', 10).text(p[0]);
        svg.append('text').attr('x', cx + cardW - 12).attr('y', undoY + 46 + j * 24).attr('text-anchor', 'end')
           .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', focused ? 'var(--ink)' : 'var(--ink-dim)').text(p[1]);
      });
      if (focused && visible) {
        svg.append('text').attr('x', cx + cardW / 2).attr('y', undoY + undoCardH - 10).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 10).attr('font-weight', 700).style('fill', 'var(--ok)').text('✓ visible — STOP');
      } else if (focused) {
        svg.append('text').attr('x', cx + cardW / 2).attr('y', undoY + undoCardH - 10).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 10).style('fill', 'var(--err)').text('✗ skip');
      }
    }

    // Cost — clamped to InnoDB's effective step
    const items = iStep();                                   // total reads (live row + N undo)
    drawCost(svg, x + 16, y + h - 60, w - 32, [
      `READ COST  ·  walked ${items} item${items === 1 ? '' : 's'}${foundI() ? ' — STOPPED at first visible' : ' so far'}`
    ]);
  }

  // ---------- RIGHT: Postgres scan ----------
  function drawPostgres(svg, x, y, w, h) {
    panelBox(svg, x, y, w, h, '#5b9cff', 'Postgres · scan heap Old → New (O→N)');

    // Index banner
    const banY = y + 50;
    svg.append('rect').attr('x', x + 16).attr('y', banY).attr('width', w - 32).attr('height', 32).attr('rx', 5)
       .attr('fill', 'var(--panel)').attr('stroke', '#5b9cff').attr('stroke-width', 1.2);
    svg.append('text').attr('x', x + 28).attr('y', banY + 14).attr('class', 'lbl-mono')
       .attr('font-size', 11).style('fill', '#5b9cff').text('PRIMARY INDEX · id  ·  separate B-Tree');
    svg.append('text').attr('x', x + 28).attr('y', banY + 27).attr('class', 'lbl-mono-dim')
       .attr('font-size', 10).text('POINTS TO HEAP — READER FOLLOWS TID, THEN VISIBILITY-CHECKS EACH TUPLE');
    svg.append('text').attr('x', x + w - 28).attr('y', banY + 22).attr('text-anchor', 'end')
       .attr('class', 'lbl-mono').attr('font-size', 12).style('fill', '#5b9cff').text(`id=42 → (0, 4)`);

    // Heap page header
    const heapY = banY + 46;
    svg.append('text').attr('x', x + 16).attr('y', heapY).attr('class', 'lbl-mono-dim').attr('font-size', 11)
       .text('HEAP PAGE  ·  SCAN DIRECTION →');

    // Heap tuples: 4 cards left-to-right, slots (0,1)..(0,4) — taller for clarity
    const tupY = heapY + 24, tupH = 124;
    const cardW = (w - 32 - 42) / 4;
    VERSIONS.forEach((v, i) => {
      const cx = x + 16 + i * (cardW + 14);
      const tid = `(0, ${i + 1})`;
      const xmin = v.trx_id;
      const xmax = i < VERSIONS.length - 1 ? VERSIONS[i + 1].trx_id : 0;
      const isLive = i === VERSIONS.length - 1;
      const focused = pStep() >= (i + 1);                     // tuples scanned in slot order
      // visibility test: xmin ≤ cutoff < xmax (or xmax = 0)
      const visible = (xmin <= SNAPSHOT_CUTOFF) && (xmax === 0 || SNAPSHOT_CUTOFF < xmax);
      const col = !focused ? 'var(--ink-dim)' : (visible ? 'var(--ok)' : 'var(--err)');
      svg.append('rect').attr('x', cx).attr('y', tupY).attr('width', cardW).attr('height', tupH).attr('rx', 5)
         .attr('fill', 'var(--panel)').attr('stroke', col).attr('stroke-width', focused ? 1.6 : 1.1)
         .attr('stroke-dasharray', !isLive ? '5 4' : null);
      // header: TID + status pill
      svg.append('text').attr('x', cx + 10).attr('y', tupY + 16).attr('class', 'lbl-mono')
         .attr('font-size', 11).style('fill', col).text(tid);
      const pillX = cx + cardW - 60;
      const pillFill = focused ? (visible ? 'var(--ok)' : 'var(--err)') : 'var(--ink-dim)';
      svg.append('rect').attr('x', pillX).attr('y', tupY + 5).attr('width', 50).attr('height', 16).attr('rx', 3)
         .attr('fill', pillFill).attr('opacity', focused ? 0.95 : 0.4);
      svg.append('text').attr('x', pillX + 25).attr('y', tupY + 17).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 9).attr('font-weight', 700).style('fill', '#0a0a0a')
         .text(focused ? (visible ? 'VISIBLE' : 'SKIP') : (isLive ? 'LIVE' : 'DEAD'));
      // body fields with breathing room
      svg.append('text').attr('x', cx + cardW / 2).attr('y', tupY + 50).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 13).attr('font-weight', 600).style('fill', focused ? 'var(--ink)' : 'var(--ink-dim)').text(`'${v.name}'`);
      svg.append('text').attr('x', cx + 12).attr('y', tupY + 78).attr('class', 'lbl-mono-dim').attr('font-size', 9).text('xmin');
      svg.append('text').attr('x', cx + cardW - 12).attr('y', tupY + 78).attr('text-anchor', 'end')
         .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', focused ? 'var(--ink)' : 'var(--ink-dim)').text(String(xmin));
      svg.append('text').attr('x', cx + 12).attr('y', tupY + 100).attr('class', 'lbl-mono-dim').attr('font-size', 9).text('xmax');
      svg.append('text').attr('x', cx + cardW - 12).attr('y', tupY + 100).attr('text-anchor', 'end')
         .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', focused ? 'var(--ink)' : 'var(--ink-dim)')
         .text(xmax === 0 ? '∞ (live)' : String(xmax));
    });

    // Cost
    drawCost(svg, x + 16, y + h - 60, w - 32, [
      `READ COST  ·  inspected ${pStep()}/4 tuples${foundP() ? ' — visibility match found' : ''}  ·  must scan/check every one (incl. DEAD)`
    ]);
  }

  function drawCost(svg, x, y, w, lines) {
    svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', 44).attr('rx', 6)
       .attr('fill', 'var(--bg-2)').attr('stroke', 'var(--border-2)');
    lines.forEach((ln, i) => {
      svg.append('text').attr('x', x + 14).attr('y', y + 26 + i * 14).attr('class', 'lbl-mono')
         .attr('font-size', 11).style('fill', 'var(--ink-2)').text(ln);
    });
  }

  function updateLog() {
    const el = document.getElementById('pgmv-log');
    if (!el) return;
    if (st.step === 0) {
      el.innerHTML = `Snapshot ready. Cutoff is xmax ≤ ${SNAPSHOT_CUTOFF}, so the reader must ignore tx_103 (the newest update). Press <b>▶ Advance reader</b> to step both sides in sync.`;
    } else if (st.step === 1) {
      el.innerHTML = `<b>Step 1.</b> InnoDB: read live row (tx_103) → ✗ not visible (103 &gt; 102). Postgres: inspect slot (0,1) ('alice', xmin=100, xmax=101) → ✗ not visible (xmax=101 ≤ 102 means another version supersedes it for this snapshot).`;
    } else if (st.step === 2) {
      el.innerHTML = `<b>Step 2.</b> InnoDB: walk to undo #3 (prev_trx_id=102) → ✓ visible. Total reads: 1 row + 1 undo rec(s). <em>STOP</em>. Postgres: inspect slot (0,2) ('bob', xmin=101, xmax=102) → ✗ not visible.`;
    } else if (st.step === 3) {
      el.innerHTML = `<b>Step 3.</b> InnoDB already done. Postgres: inspect slot (0,3) ('carol', xmin=102, xmax=103) → ✓ visible (102 ≤ 102 &lt; 103). Could STOP here, but Postgres in practice keeps scanning the page — visibility is checked against every slot.`;
    } else {
      el.innerHTML = `<b>Step 4.</b> InnoDB walked 1 undo record. Postgres scanned all 4 tuples. <b>That\'s the cost difference</b>: InnoDB stops at the first visible version; Postgres pays for every dead tuple it encounters until vacuum reclaims them. This is exactly why long-running transactions hurt Postgres — they prevent vacuum from advancing the dead-tuple horizon.`;
    }
  }

  // ===== Wire =====
  section.querySelector('[data-act="pgmv-next"]').addEventListener('click', () => { advance(); render(); });
  section.querySelector('[data-act="pgmv-reset"]').addEventListener('click', () => { reset(); render(); });

  render();
})();
