/* record.js — ③ Row: 5-byte record header bit layout + full-record forward layout */
(function () {
  const section = document.getElementById('record');
  section.innerHTML = `
    <h2><span class="no">③</span>Row</h2>
    <p class="lead">When you <code>INSERT</code> a row, InnoDB lays out the bytes exactly like this in the page's <em>user records</em> region. There's no separate "insert record" — the inserted row IS a user record. Every one has a 5-byte header at <em>negative</em> offsets before the record origin <code>N</code>, then the payload (PK, hidden system columns, non-key cols) starting at <code>N</code>. The same layout is used by the whole B+Tree.</p>

    <h3>Record header · 5 bytes · 40 bits</h3>
    <div class="viz-container" style="padding:24px">
      <svg id="row-svg" viewBox="0 0 1100 220" style="width:100%;height:auto"></svg>
    </div>
    <ul class="acclist" id="row-fields" style="list-style:none;padding:0;margin:14px 0"></ul>

    <h3 style="margin-top:36px">Full record layout (forward from origin N)</h3>
    <div class="viz-container" style="padding:24px">
      <svg id="row-full" viewBox="0 0 1100 220" style="width:100%;height:auto"></svg>
    </div>

    <div class="two-col">
      <div class="inspector">
        <b>Per-row overhead</b><br><br>
        Clustered-index leaf row minimum:
        <ul style="margin:6px 0;padding-left:18px">
          <li>Record header: <b>5 bytes</b></li>
          <li>DB_TRX_ID: <b>6 bytes</b></li>
          <li>DB_ROLL_PTR: <b>7 bytes</b></li>
          <li><b>Total fixed overhead: 18 bytes</b></li>
        </ul>
        <span class="dim">storage/innobase/rem/rec.h · include/rem0rec.h</span>
      </div>
      <div class="inspector">
        <b>rec_status values</b>
        <table style="width:100%;font-size:12px;margin-top:8px;border-collapse:collapse">
          <tr><td><code>0</code></td><td>conventional</td><td class="dim">user row</td></tr>
          <tr><td><code>1</code></td><td>node_ptr</td><td class="dim">non-leaf</td></tr>
          <tr><td><code>2</code></td><td>INFIMUM</td><td class="dim">sentinel</td></tr>
          <tr><td><code>3</code></td><td>SUPREMUM</td><td class="dim">sentinel</td></tr>
        </table>
      </div>
    </div>
  `;

  // Bit-width is the source of truth; pixel widths are derived to keep the
  // strip proportional. Long labels get rendered ABOVE the cells (with a tiny
  // tick) instead of inside them, so nothing overflows.
  const FIELDS = [
    { id:'info_flags',         bits:4,  fill:'var(--err)',     label:'info_flags',         sub:'4 bits · per-record status',
      body:`Only two flags are defined; the other 2 bits are reserved.<br><br>
            <code>REC_INFO_MIN_REC_FLAG (0x10)</code> — set on the smallest record in a non-leaf B+Tree page. Used during tree descent as "everything ≤ this goes to this child".<br>
            <code>REC_INFO_DELETED_FLAG (0x20)</code> — the row is delete-marked. The record stays on the page (MVCC readers may still need it); purge later actually removes it.` },
    { id:'n_owned',            bits:4,  fill:'var(--orange)',  label:'n_owned',            sub:'4 bits · page-directory ownership',
      body:`How many records in the key-order linked list this record "owns" — i.e. how many records lie between this slot and the previous one. Used to keep the page directory sparse but balanced. Range 0–8 typically.` },
    { id:'heap_no',            bits:13, fill:'var(--green)',   label:'heap_no',            sub:'13 bits · physical position',
      body:`Each record's slot in the page heap (insertion order). 0 = INFIMUM, 1 = SUPREMUM, 2..N = user records. Used by the lock manager — a row lock is keyed by (index_id, page_no, heap_no).` },
    { id:'rec_status',         bits:3,  fill:'var(--purple)',  label:'rec_status',         sub:'3 bits · record type',
      body:`<code>0</code> conventional · <code>1</code> node_ptr (non-leaf) · <code>2</code> infimum · <code>3</code> supremum.` },
    { id:'next_record_offset', bits:16, fill:'var(--blue)',    label:'next_record_offset', sub:'16 bits · key-order linked list',
      body:`Signed 16-bit offset relative to <em>this</em> record's origin to the next record's origin in <em>key</em> order — not heap order. Together with INFIMUM/SUPREMUM forms the in-page singly-linked list that page directory slots index into.` }
  ];

  function renderHeader() {
    const svg = d3.select('#row-svg');
    svg.selectAll('*').remove();
    installArrowDefs(svg);

    // Pixel widths are PROPORTIONAL to bit-widths (40 bits total → 880 px wide).
    // Labels render ABOVE each cell with a leader-tick down into the cell, so
    // nothing has to fit inside narrow cells like info_flags / n_owned (4 bits).
    const x0 = 60, stripW = 880;
    const totalBits = FIELDS.reduce((a, f) => a + f.bits, 0);   // 40
    const pxPerBit = stripW / totalBits;

    svg.append('text').attr('x', x0).attr('y', 24).attr('class', 'lbl-mono-dim')
       .text('BIT LAYOUT (MSB ON LEFT, 40 BITS TOTAL)');

    // Byte ticks (5 bytes)
    for (let b = 0; b < 5; b++) {
      const xx = x0 + (b + 0.5) * (stripW / 5);
      svg.append('text').attr('x', xx).attr('y', 44).attr('class', 'lbl-mono-dim')
         .attr('text-anchor', 'middle').attr('font-size', 10).text(`BYTE -${5 - b}`);
    }

    // Field cells
    let cx = x0;
    const cellY = 60, cellH = 64;
    FIELDS.forEach(f => {
      const w = f.bits * pxPerBit;
      // colored cell
      svg.append('rect').attr('x', cx).attr('y', cellY).attr('width', w).attr('height', cellH).attr('rx', 4)
         .attr('fill', f.fill).attr('opacity', 0.55).attr('stroke', f.fill);
      // bit count INSIDE the cell — short, fits even narrow ones
      svg.append('text').attr('x', cx + w / 2).attr('y', cellY + cellH / 2 + 4).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('fill', 'var(--bg)').attr('font-weight', 700).attr('font-size', 12).text(`${f.bits}b`);
      f._cx = cx + w / 2;
      f._w  = w;
      cx += w;
    });

    // Labels OUTSIDE the cells with leader ticks. Stagger between two rows below
    // so adjacent narrow fields don't collide.
    const labelRowY = cellY + cellH + 24;
    FIELDS.forEach((f, i) => {
      const row = (i % 2 === 0) ? 0 : 1;
      const ly  = labelRowY + row * 22;
      // tick from cell bottom down to the label row
      svg.append('line').attr('x1', f._cx).attr('y1', cellY + cellH).attr('x2', f._cx).attr('y2', ly - 12)
         .attr('stroke', f.fill).attr('stroke-width', 1).attr('opacity', 0.7);
      svg.append('text').attr('x', f._cx).attr('y', ly).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('fill', f.fill).attr('font-size', 12).text(f.label);
    });

    // origin marker
    svg.append('line').attr('x1', x0 + stripW).attr('y1', 44).attr('x2', x0 + stripW).attr('y2', cellY + cellH + 6)
       .attr('stroke', 'var(--border-2)').attr('stroke-dasharray', '3 3');
    svg.append('text').attr('x', x0 + stripW + 8).attr('y', 56).attr('class', 'lbl-mono')
       .attr('fill', 'var(--accent)').text('N');
    svg.append('text').attr('x', x0 + stripW + 8).attr('y', 70).attr('class', 'lbl-mono-dim').text('origin');

    // accordion
    const ul = section.querySelector('#row-fields');
    ul.innerHTML = '';
    FIELDS.forEach(f => {
      const li = document.createElement('li');
      li.style.background  = 'var(--panel)';
      li.style.border      = '1px solid var(--border)';
      li.style.borderRadius = '6px';
      li.style.marginBottom = '6px';
      li.innerHTML = `
        <div class="head" style="padding:9px 14px;color:var(--ink);cursor:pointer;display:flex;align-items:center;gap:10px;font-family:'JetBrains Mono',monospace;font-size:12px">
          <span style="color:var(--ink-dim);transition:.15s" class="caret">▸</span>
          <span style="color:var(--accent)">${f.label}</span>
          <span style="color:var(--ink-dim)">· ${f.sub}</span>
        </div>
        <div class="body" style="display:none;padding:0 14px 12px 32px;color:var(--ink-2);line-height:1.6;font-size:13px">${f.body}</div>
      `;
      const head = li.querySelector('.head');
      head.addEventListener('click', () => {
        const body = li.querySelector('.body');
        const open = body.style.display === 'block';
        body.style.display = open ? 'none' : 'block';
        li.querySelector('.caret').textContent = open ? '▸' : '▾';
        li.querySelector('.caret').style.color = open ? 'var(--ink-dim)' : 'var(--accent)';
      });
      ul.appendChild(li);
    });
  }

  function renderFull() {
    const svg = d3.select('#row-full');
    svg.selectAll('*').remove();
    installArrowDefs(svg);
    svg.append('text').attr('x', 24).attr('y', 24).attr('class', 'lbl-mono-dim')
       .text('RECORD BYTES · GROWS → · ORIGIN N IS ON THE LEFT (JUST AFTER HEADER)');

    const fields = [
      { label:'RECORD HEADER', val:'5 bytes',      c:'var(--err)',     w:160 },
      { label:'ID (PK)',       val:'user col',     c:'var(--orange)',  w:120 },
      { label:'DB_TRX_ID',     val:'6 B · hidden', c:'var(--purple)',  w:140 },
      { label:'DB_ROLL_PTR',   val:'7 B · hidden', c:'var(--err)',     w:140 },
      { label:'NAME',          val:'user col',     c:'var(--green)',   w:200 }
    ];
    const startX = 32, gap = 8, y = 60, h = 80;
    let x = startX;
    fields.forEach(f => {
      f._x = x;
      svg.append('rect').attr('x', x).attr('y', y).attr('width', f.w).attr('height', h).attr('rx', 5)
         .attr('fill', 'var(--panel-2)').attr('stroke', f.c).attr('stroke-width', 1.5);
      svg.append('text').attr('x', x + f.w / 2).attr('y', y + 32).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('fill', f.c).attr('font-size', 11).text(f.label);
      svg.append('text').attr('x', x + f.w / 2).attr('y', y + 56).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').text(f.val);
      x += f.w + gap;
    });
    // The origin N is the boundary between RECORD HEADER (negative offsets) and
    // the first user column ID (PK) (positive offsets) — i.e., it sits in the
    // gap between fields[0] and fields[1]. Compute its x from the field layout
    // so it can never drift out of place.
    const originX = fields[1]._x - gap / 2;
    svg.append('line').attr('x1', originX).attr('y1', 44).attr('x2', originX).attr('y2', y + h + 6)
       .attr('stroke', 'var(--accent)').attr('stroke-width', 1.5).attr('stroke-dasharray', '4 3');
    svg.append('text').attr('x', originX + 6).attr('y', 54).attr('class', 'lbl-mono')
       .attr('fill', 'var(--accent)').attr('font-size', 13).text('N = origin');

    // Legend split into two pieces — one for each side of the origin line —
    // so they actually align with where the boundary really is.
    svg.append('text').attr('x', originX - 6).attr('y', y + h + 22).attr('text-anchor', 'end')
       .attr('class', 'lbl-mono-dim').attr('font-size', 11)
       .text('← HEADER  (negative offsets)');
    svg.append('text').attr('x', originX + 6).attr('y', y + h + 22)
       .attr('class', 'lbl-mono-dim').attr('font-size', 11)
       .text('PAYLOAD  (positive offsets) →');
  }

  renderHeader();
  renderFull();
})();
