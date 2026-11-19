/* change.js — ④ Multi Version: where undo lives + undo log header + undo log records */
(function () {
  const section = document.getElementById('change');
  section.innerHTML = `
    <h2><span class="no">④</span>Multi Version</h2>
    <p class="lead">MVCC lets readers see older versions of a row while writers modify newer ones. The mechanism is the <b>undo log</b>: before a row changes, its old values get copied into an undo record. Readers walk the version chain until they find one they're allowed to see.</p>
    <p style="color:var(--ink-2); max-width:760px">An undo log is a chain of undo pages owned by one transaction. The first page begins with an <b>undo log header</b> (per-trx metadata) followed by undo log records (one per row modification).</p>

    <h3>Where undo lives</h3>
    <div class="viz-container" style="padding:24px">
      <svg id="ct-where" viewBox="0 0 900 220" style="width:100%;height:auto"></svg>
    </div>

    <h3 style="margin-top:36px">Undo log <b>header</b> <span style="color:var(--ink-dim);font-weight:400;font-size:14px">— once per transaction (recovery reads this)</span></h3>
    <div class="viz-container" style="padding:24px">
      <svg id="ct-header" viewBox="0 0 900 220" style="width:100%;height:auto"></svg>
    </div>

    <h3 style="margin-top:36px">Undo log <b>record</b> <span style="color:var(--ink-dim);font-weight:400;font-size:14px">— one per row modification (MVCC walks these)</span></h3>
    <div class="viz-container" style="padding:24px">
      <svg id="ct-undo" viewBox="0 0 900 260" style="width:100%;height:auto"></svg>
    </div>

    <details class="explain">
      <summary>Other undo record types (besides UPD_EXIST)</summary>
      <div class="body" style="font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.9">
        <div><span style="color:var(--pink)">TRX_UNDO_INSERT_REC</span> — for INSERT. No prior version — <em>discarded at commit</em>.</div>
        <div><span style="color:var(--pink)">TRX_UNDO_UPD_EXIST_REC</span> — for UPDATE on an existing row (the usual case).</div>
        <div><span style="color:var(--pink)">TRX_UNDO_UPD_DEL_REC</span> — for UPDATE that also delete-marks the row.</div>
        <div><span style="color:var(--pink)">TRX_UNDO_DEL_MARK_REC</span> — for DELETE (which is just a delete-mark, purged later).</div>
        <p style="color:var(--ink-dim);font-size:13px;margin-top:14px">UNDO is <b>logical</b> — it says "the old name was X, the old trx_id was Y" so MVCC can reconstruct a prior version, and ROLLBACK can reverse the change column-by-column.</p>
      </div>
    </details>

    <h3 style="margin-top:36px">Why undo is small <span style="color:var(--ink-dim);font-weight:400;font-size:14px">— only what changed</span></h3>
    <p>An undo record does <em>not</em> snapshot the whole row. For an UPDATE it stores only the PK + the columns that actually changed (with their <em>old</em> values), plus a tiny header. For a 1-byte change in a fat row that's an order-of-magnitude saving in space and write amplification.</p>
    <div class="viz-container" style="padding:24px">
      <svg id="ct-compare" viewBox="0 0 900 380" style="width:100%;height:auto"></svg>
    </div>

    <p class="ref"><code>trx/trx0undo.cc</code> · <code>trx/trx0rec.cc:trx_undo_page_report_modify</code></p>
  `;

  // === Where undo lives — nested boxes (rseg → undo log → undo pages) ===
  (function renderWhere() {
    const svg = d3.select('#ct-where');
    installArrowDefs(svg);
    // Outer: Rollback segment
    svg.append('rect').attr('x', 20).attr('y', 20).attr('width', 860).attr('height', 180).attr('rx', 8)
       .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--purple)').attr('stroke-width', 1.2);
    svg.append('text').attr('x', 36).attr('y', 42).attr('class', 'lbl-mono')
       .attr('font-size', 12).attr('fill', 'var(--orange)').text('Rollback segment (1 of 128)');

    // Inner: Undo log = chain of pages
    svg.append('rect').attr('x', 50).attr('y', 64).attr('width', 800).attr('height', 120).attr('rx', 6)
       .attr('fill', 'var(--panel-2)').attr('opacity', 0.5).attr('stroke', 'var(--blue)').attr('stroke-dasharray', '5 3');
    svg.append('text').attr('x', 64).attr('y', 82).attr('class', 'lbl-mono')
       .attr('font-size', 11).attr('fill', 'var(--blue)').text('Undo log — chain of undo pages, owned by tx_100');

    // Three undo pages
    [0, 1, 2].forEach(i => {
      const px = 80 + i * 250, py = 96, pw = 220, ph = 76;
      svg.append('rect').attr('x', px).attr('y', py).attr('width', pw).attr('height', ph).attr('rx', 5)
         .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--purple)').attr('stroke-width', 1).attr('opacity', 0.85);
      svg.append('text').attr('x', px + 10).attr('y', py + 14).attr('class', 'lbl-mono-dim')
         .attr('font-size', 9).attr('fill', 'var(--purple)').text(`undo page ${i + 1}`);
      // First page: header + records ; later pages: records only
      if (i === 0) {
        svg.append('rect').attr('x', px + 8).attr('y', py + 22).attr('width', 90).attr('height', 28).attr('rx', 3)
           .attr('fill', 'var(--blue)').attr('opacity', 0.35).attr('stroke', 'var(--blue)');
        svg.append('text').attr('x', px + 53).attr('y', py + 40).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 10).attr('fill', 'var(--blue)').text('HEADER');
        for (let r = 0; r < 3; r++) {
          svg.append('rect').attr('x', px + 106 + r * 32).attr('y', py + 22).attr('width', 28).attr('height', 28).attr('rx', 3)
             .attr('fill', 'var(--pink)').attr('opacity', 0.35).attr('stroke', 'var(--pink)');
          svg.append('text').attr('x', px + 120 + r * 32).attr('y', py + 40).attr('text-anchor', 'middle')
             .attr('class', 'lbl-mono').attr('font-size', 9).attr('fill', 'var(--pink)').text('#' + (r + 1));
        }
      } else {
        for (let r = 0; r < 5; r++) {
          svg.append('rect').attr('x', px + 8 + r * 42).attr('y', py + 22).attr('width', 38).attr('height', 28).attr('rx', 3)
             .attr('fill', 'var(--pink)').attr('opacity', 0.35).attr('stroke', 'var(--pink)');
          svg.append('text').attr('x', px + 27 + r * 42).attr('y', py + 40).attr('text-anchor', 'middle')
             .attr('class', 'lbl-mono').attr('font-size', 9).attr('fill', 'var(--pink)').text('#' + (i === 1 ? r + 4 : r + 9));
        }
      }
      svg.append('text').attr('x', px + 10).attr('y', py + 68).attr('class', 'lbl-mono-dim')
         .attr('font-size', 9).text(i === 0 ? 'first page · header + records' : 'later page · records only');
      // Link arrow between pages
      if (i < 2) {
        svg.append('line').attr('x1', px + pw).attr('x2', px + pw + 30).attr('y1', py + ph / 2).attr('y2', py + ph / 2)
           .attr('stroke', 'var(--blue)').attr('stroke-width', 1.5).attr('stroke-dasharray', '5 3');
      }
    });
  })();

  // === Undo log HEADER table ===
  (function renderHeader() {
    const svg = d3.select('#ct-header');
    const startX = 20, startY = 20;
    const cardW = 860;
    svg.append('rect').attr('x', startX).attr('y', startY).attr('width', cardW).attr('height', 180).attr('rx', 8)
       .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--blue)').attr('stroke-width', 1.5);
    svg.append('text').attr('x', startX + 16).attr('y', startY + 22).attr('class', 'lbl')
       .attr('fill', 'var(--blue)').attr('font-size', 13).attr('font-weight', 600)
       .text('Undo log header · first bytes of each trx\'s undo log');
    svg.append('line').attr('x1', startX + 16).attr('x2', startX + cardW - 16).attr('y1', startY + 32).attr('y2', startY + 32)
       .attr('stroke', 'var(--border-2)');

    const fields = [
      ['TRX_UNDO_STATE',         'ACTIVE / PREPARED / CACHED / TO_PURGE / TO_FREE'],
      ['TRX_UNDO_TRX_ID',        'the trx_id that owns this undo log'],
      ['TRX_UNDO_TRX_NO',        'commit serialization number (set at COMMIT)'],
      ['TRX_UNDO_XID',           'full XA transaction id (only if PREPARED)'],
      ['TRX_UNDO_DICT_TRANS',    'set if this trx modifies the data-dictionary (DDL)'],
      ['TRX_UNDO_LAST_LOG',      'offset of the newest log on this page'],
      ['TRX_UNDO_HISTORY_NODE',  'linked-list node — rseg history list after commit']
    ];
    const labelX = startX + 20, valX = startX + 240, rowY0 = startY + 56, rowGap = 20;
    fields.forEach((r, i) => {
      const ry = rowY0 + i * rowGap;
      svg.append('text').attr('x', labelX).attr('y', ry).attr('class', 'lbl-mono')
         .attr('font-size', 12).attr('fill', 'var(--blue)').text(r[0]);
      svg.append('text').attr('x', valX).attr('y', ry).attr('class', 'lbl-mono-dim')
         .attr('font-size', 12).text(r[1]);
    });
  })();

  // === Undo log RECORD table ===
  (function renderRec() {
    const svg = d3.select('#ct-undo');
    const cardW = 860, cardH = 230;
    const x = (900 - cardW) / 2, y = 20;
    svg.append('rect').attr('x', x).attr('y', y).attr('width', cardW).attr('height', cardH).attr('rx', 8)
       .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--pink)').attr('stroke-width', 1.5);
    svg.append('text').attr('x', x + 20).attr('y', y + 26).attr('class', 'lbl')
       .attr('fill', 'var(--pink)').attr('font-size', 14).attr('font-weight', 600)
       .text('Undo log record · one per row modification · type = TRX_UNDO_UPD_EXIST_REC');
    svg.append('text').attr('x', x + 20).attr('y', y + 44).attr('class', 'lbl-dim').attr('font-size', 11)
       .text('Carries the OLD values so MVCC can reconstruct and ROLLBACK can revert.');
    svg.append('line').attr('x1', x + 20).attr('x2', x + cardW - 20).attr('y1', y + 54).attr('y2', y + 54)
       .attr('stroke', 'var(--border-2)');

    const rows = [
      ['type',           'INSERT / UPD_EXIST / UPD_DEL / DEL_MARK'],
      ['PK fields',      'primary key — re-find the row on rollback'],
      ['trx_id (old)',   'the trx that was on the row BEFORE this change'],
      ['roll_ptr (old)', 'link to the PREVIOUS version\'s undo record'],
      ['updated fields', 'for each CHANGED column: col#, old value']
    ];
    const labelX = x + 20, valX = x + 200, rowY0 = y + 84, rowGap = 28;
    rows.forEach((r, i) => {
      const ry = rowY0 + i * rowGap;
      svg.append('text').attr('x', labelX).attr('y', ry).attr('class', 'lbl-mono')
         .attr('font-size', 12).attr('fill', 'var(--pink)').text(r[0]);
      svg.append('text').attr('x', valX).attr('y', ry).attr('class', 'lbl-mono-dim')
         .attr('font-size', 12).text(r[1]);
    });
  })();

  // === Full row copy vs undo copy — size comparison ===
  // Two horizontal strips drawn to the SAME byte→pixel scale, so the second
  // (undo) is visibly a small fraction of the first (full row).
  // Layout uses generous vertical bands so no labels collide.
  (function renderCompare() {
    const svg = d3.select('#ct-compare');
    if (svg.empty()) return;
    svg.selectAll('*').remove();

    const COLS = [
      { name: 'id (PK)',    b:  8, role: 'pk' },
      { name: 'email',      b: 48, role: 'data' },
      { name: 'address',    b: 96, role: 'data' },
      { name: 'name',       b: 32, role: 'data', changed: true },
      { name: 'timestamps', b: 16, role: 'data' }
    ];
    const FULL_BYTES    = COLS.reduce((a, c) => a + c.b, 0);    // 200
    const UNDO_HEADER_B = 8;
    const PK_BYTES      = COLS.find(c => c.role === 'pk').b;    // 8
    const NAME_BYTES    = COLS.find(c => c.changed).b;          // 32
    const UNDO_BYTES    = UNDO_HEADER_B + PK_BYTES + NAME_BYTES;// 48

    // Geometry (viewBox 900 × 380):
    //   FULL strip:  title 24 · upper labels 56 · lower labels 76 · cells 92..134
    //   UNDO strip:  title 168 · upper labels 200 · lower labels 220 · cells 236..278
    //   LEGEND:      starts at y=312
    const X0 = 24, MAX_W = 852, ROW_H = 42;
    const PX_PER_BYTE = MAX_W / FULL_BYTES;
    const LBL_UP = 0;       // upper-row label y-offset (above cell-top)
    const LBL_LO = 20;      // lower-row label y-offset (further above cell-top — wait, smaller y = higher)

    function colColor(c) {
      if (c.role === 'pk') return 'var(--orange)';
      if (c.changed)       return 'var(--pink)';
      return 'var(--ink-dim)';
    }
    function colFill(c) {
      if (c.role === 'pk') return 'rgba(255,154,74,0.18)';
      if (c.changed)       return 'rgba(255,94,154,0.18)';
      return 'rgba(126,126,126,0.10)';
    }

    // Draw one strip with TWO label rows above the cells (alternating),
    // so adjacent narrow cells never collide horizontally.
    function drawStrip(titleY, title, totalLabel, cellY, cells, hasGhost) {
      // Title row (well above the labels — own band)
      svg.append('text').attr('x', X0).attr('y', titleY).attr('class', 'lbl-mono-dim')
         .attr('font-size', 12).text(title);
      svg.append('text').attr('x', X0 + MAX_W).attr('y', titleY).attr('text-anchor', 'end')
         .attr('class', 'lbl-mono').attr('font-size', 14).attr('font-weight', 600)
         .style('fill', 'var(--accent)').text(totalLabel);

      // Two label-row baselines above the cell band
      const labelYUpper = cellY - 36;   // top row
      const labelYLower = cellY - 16;   // bottom row (closer to cells)

      // Frame the strip background
      svg.append('rect').attr('x', X0).attr('y', cellY).attr('width', MAX_W).attr('height', ROW_H).attr('rx', 4)
         .style('fill', 'transparent').style('stroke', 'var(--border)');

      let cx = X0;
      cells.forEach((c, i) => {
        const w        = c.b * PX_PER_BYTE;
        const cellMidX = cx + w / 2;
        const color    = c.color || colColor(c);
        const fill     = c.fill  || colFill(c);
        // Even-indexed cells go on UPPER row, odd on LOWER row → no horizontal overlap
        const labelY   = (i % 2 === 0) ? labelYUpper : labelYLower;

        // Tick from label baseline down to cell-top
        svg.append('line').attr('x1', cellMidX).attr('y1', labelY + 3)
           .attr('x2', cellMidX).attr('y2', cellY)
           .style('stroke', color).attr('stroke-width', 1).attr('opacity', 0.55);

        // Column name label (above)
        svg.append('text').attr('x', cellMidX).attr('y', labelY).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', color).text(c.name);

        // Cell rectangle
        svg.append('rect').attr('x', cx).attr('y', cellY).attr('width', w).attr('height', ROW_H).attr('rx', 3)
           .style('fill', fill).style('stroke', color).attr('stroke-width', 1);

        // Byte count inside the cell when there's room
        if (w >= 26) {
          svg.append('text').attr('x', cellMidX).attr('y', cellY + ROW_H / 2 + 4).attr('text-anchor', 'middle')
             .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', color).text(`${c.b} B`);
        }
        cx += w;
      });

      // Dashed "saved space" ghost on the undo strip
      if (hasGhost) {
        const used   = cells.reduce((a, c) => a + c.b, 0) * PX_PER_BYTE;
        const ghostX = X0 + used;
        const ghostW = MAX_W - used;
        svg.append('rect').attr('x', ghostX).attr('y', cellY).attr('width', ghostW).attr('height', ROW_H).attr('rx', 3)
           .style('fill', 'transparent').style('stroke', 'var(--ok)')
           .attr('stroke-dasharray', '5 4').attr('opacity', 0.7);
        svg.append('text').attr('x', ghostX + ghostW / 2).attr('y', cellY + ROW_H / 2 + 5).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 12).attr('font-weight', 600).style('fill', 'var(--ok)')
           .text(`${FULL_BYTES - UNDO_BYTES} B saved · ~${(FULL_BYTES / UNDO_BYTES).toFixed(1)}× smaller`);
      }
    }

    // ---- FULL ROW strip ----
    drawStrip(24,  'FULL ROW COPY · users(...)',           `${FULL_BYTES} B`,  92, COLS, false);

    // ---- UNDO RECORD strip ----
    const undoCells = [
      { name: 'header',  b: UNDO_HEADER_B, color: 'var(--accent-2)', fill: 'rgba(160,114,243,0.22)' },
      { name: 'id (PK)', b: PK_BYTES,      color: 'var(--orange)',   fill: 'rgba(255,154,74,0.22)'  },
      { name: 'old name',b: NAME_BYTES,    color: 'var(--pink)',     fill: 'rgba(255,94,154,0.22)'  }
    ];
    drawStrip(168, 'UNDO RECORD · TRX_UNDO_UPD_EXIST_REC', `${UNDO_BYTES} B`, 236, undoCells, true);

    // ---- Legend + takeaway (own band, no overlap with strips) ----
    const legendY = 312;
    svg.append('text').attr('x', X0).attr('y', legendY).attr('class', 'lbl-mono-dim')
       .attr('font-size', 10).attr('letter-spacing', '0.08em').text('LEGEND');

    const legend = [
      { c: 'var(--orange)',   t: 'PK · always present (needed to re-find the row)' },
      { c: 'var(--pink)',     t: 'changed column · stores the OLD value' },
      { c: 'var(--ink-dim)',  t: 'unchanged column · NOT copied to undo' },
      { c: 'var(--accent-2)', t: 'undo header · per-row metadata' }
    ];
    legend.forEach((l, i) => {
      const col = i % 2, row = Math.floor(i / 2);
      const lx  = X0 + col * 320;
      const ly  = legendY + 20 + row * 18;
      svg.append('rect').attr('x', lx).attr('y', ly - 9).attr('width', 14).attr('height', 12).attr('rx', 2)
         .style('fill', l.c).style('opacity', 0.55).style('stroke', l.c);
      svg.append('text').attr('x', lx + 22).attr('y', ly).attr('class', 'lbl-mono')
         .attr('font-size', 11).style('fill', 'var(--ink-2)').text(l.t);
    });

    // Takeaway, right-aligned in the legend band
    const ratio = (FULL_BYTES / UNDO_BYTES).toFixed(1);
    svg.append('text').attr('x', X0 + MAX_W).attr('y', legendY + 20).attr('text-anchor', 'end')
       .attr('class', 'lbl-mono').attr('font-size', 14).style('fill', 'var(--ok)').attr('font-weight', 600)
       .text(`UNDO is ~${ratio}× smaller`);
    svg.append('text').attr('x', X0 + MAX_W).attr('y', legendY + 38).attr('text-anchor', 'end')
       .attr('class', 'lbl-mono-dim').attr('font-size', 10)
       .text('cheap MVCC on update-heavy workloads with wide rows');
  })();
})();
