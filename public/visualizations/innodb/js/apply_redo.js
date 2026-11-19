/* redo.js — ⑩ Apply Redo: page_cur_parse_insert_rec()
   Reference: storage/innobase/page/page0cur.cc, page_cur_parse_insert_rec()
   The redo record stores only the trailing differences from cursor_rec; the parser
   rebuilds the full new record by copying mismatch_index bytes from cursor_rec into
   a scratch buffer, then appending end_seg_len bytes from the redo body. Finally
   page_cur_rec_insert() links the new record into the in-page key-order list. */
(function () {
  const section = document.getElementById('redo');
  section.innerHTML = `
    <h2><span class="no">⑪</span>Apply Redo — MLOG_REC_INSERT</h2>
    <p class="lead">A redo record does <em>not</em> carry a full row. It encodes the difference from an existing record on the page using a prefix-sharing trick. The parser rebuilds the new record by copying <code>mismatch_index</code> bytes from <code>cursor_rec</code> into a scratch buffer, then appending the trailing body bytes from the redo log. Step through the real logic below.</p>

    <div class="controls">
      <button class="btn primary" data-act="step">Step ▶</button>
      <button class="btn"          data-act="play">▶ Auto play</button>
      <button class="btn"          data-act="reset">↺ Reset</button>
    </div>
    <div id="ar-steps" style="display:flex;border:1px solid var(--border);border-radius:6px;overflow:hidden;margin:6px 0 14px"></div>

    <div class="viz-container" style="padding:24px">
      <svg id="ar-svg" viewBox="0 0 1200 540" style="width:100%;height:auto"></svg>
    </div>
    <div class="inspector" id="ar-log"></div>
    <p class="ref"><code>page/page0cur.cc::page_cur_parse_insert_rec</code> · <code>page_cur_insert_rec_low</code> · <code>log/log0recv.cc::recv_parse_or_apply_log_rec_body</code></p>
  `;

  const STEPS = [
    { name:'start',
      msg:'Recovery sees an MLOG_REC_INSERT record. The parser positions on <code>cursor_rec</code> — the existing record on the page that the new one will land after. Nothing has been decoded from the redo body yet.' },
    { name:'step 1',
      msg:'Read the header: type=<code>MLOG_REC_INSERT</code>, space_id=5, page_no=42. We now know <em>which</em> page this redo applies to.' },
    { name:'step 2',
      msg:'Parse <code>end_seg_len</code>, <code>info_and_status_bits</code>, <code>origin_offset</code>, <code>mismatch_index</code>. <code>mismatch_index = 12</code> says "the first 12 bytes of the new record are identical to <code>cursor_rec</code>" — that prefix is shared.' },
    { name:'step 3',
      msg:'Allocate the scratch buffer of size <code>mismatch_index + end_seg_len</code> and copy the shared prefix (12 bytes) from <code>cursor_rec</code> into it at <code>origin_offset = 5</code>.' },
    { name:'step 4',
      msg:'Append the body bytes carried in the redo record (<code>end_seg_len = 40</code>, of which the first byte being odd means extra info bits follow). The scratch buffer now holds the FULL new record.' },
    { name:'step 5',
      msg:'<code>page_cur_rec_insert(cursor, buf + origin_offset, …)</code>: insert the new record into the page heap and link it into the key-ordered list. <code>cursor_rec.next_record_offset</code> is rewritten to point at the new row.' }
  ];
  let active = 0, timer = null;

  // synthetic hex bytes — first 12 are the shared prefix
  const CURSOR_BYTES = ['00','00','01','00','00','40','12','7e','73','61','c5','b9', '3e','30','51','27','f7','81','5c','62','62','17','61','62','27','f7','81','5c'];
  const NEW_BYTES    = ['00','00','01','00','00','40','12','7e','73','61','c5','b9', '00','00','00','2a','27','62','61','27','00','00','00','00','00','00','00','00'];

  function renderTabs() {
    const box = section.querySelector('#ar-steps'); box.innerHTML = '';
    STEPS.forEach((s, i) => {
      const d = document.createElement('div');
      const reached = i <= active;
      d.style.cssText = 'flex:1;padding:8px 14px;font-family:\'JetBrains Mono\',monospace;font-size:11.5px;text-align:center;border-right:1px solid var(--border);cursor:pointer;transition:.15s;' +
        (i === active ? 'background:rgba(74,229,229,0.18);color:var(--accent);font-weight:600' :
         reached      ? 'background:var(--panel);color:var(--ink-2)' :
                        'background:var(--panel);color:var(--ink-dim)');
      d.textContent = s.name;
      d.addEventListener('click', () => { active = i; renderTabs(); render(); });
      box.appendChild(d);
    });
  }

  function render() {
    const svg = d3.select('#ar-svg'); svg.selectAll('*').remove(); installArrowDefs(svg);
    d3.select('#ar-log').html(STEPS[active].msg);

    // ===== LEFT: B+TREE PAGE — cursor_rec strip + landing-zone placeholder =====
    const lpX = 16, lpY = 16, lpW = 700, lpH = 240;
    svg.append('rect').attr('x', lpX).attr('y', lpY).attr('width', lpW).attr('height', lpH).attr('rx', 8)
       .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--border)').attr('stroke-width', 1.5);
    svg.append('text').attr('x', lpX + 14).attr('y', lpY + 22).attr('class', 'lbl-mono-dim').text('B+TREE PAGE · SPACE=5 · PAGE_NO=42');

    // strip
    const stripX = lpX + 14;
    const stripY = lpY + 56;
    const cellW = 22, n = 28;
    // labels above the strip
    svg.append('text').attr('x', stripX).attr('y', stripY - 16)
       .attr('class', 'lbl-mono-dim').attr('font-size', 10).text('CURSOR_REC');
    // mismatch_index tick (vertical orange line at byte 12)
    if (active >= 2) {
      const tickX = stripX + 12 * cellW;
      svg.append('line').attr('x1', tickX).attr('y1', stripY - 14).attr('x2', tickX).attr('y2', stripY + 30)
         .attr('stroke', 'var(--orange)').attr('stroke-width', 1.5).attr('opacity', 0)
         .transition().duration(300).attr('opacity', 1);
      svg.append('text').attr('x', tickX + 4).attr('y', stripY - 4)
         .attr('class', 'lbl-mono-dim').attr('font-size', 10).attr('fill', 'var(--orange)')
         .attr('opacity', 0).transition().duration(300).attr('opacity', 1)
         .selection().text('mismatch_index');
    }
    // cursor_rec_offset label on the right
    svg.append('text').attr('x', stripX + n * cellW - 4).attr('y', stripY - 4).attr('text-anchor', 'end')
       .attr('class', 'lbl-mono-dim').attr('font-size', 10)
       .attr('fill', active >= 1 ? 'var(--accent)' : 'var(--ink-dim)')
       .text('cursor_rec_offset');

    // hex bytes
    for (let i = 0; i < n; i++) {
      const isPrefix = i < 12;
      const stroke = active >= 3 && isPrefix ? 'var(--accent)' : 'var(--border-2)';
      const fill   = active >= 3 && isPrefix ? 'rgba(74,229,229,.18)' : 'var(--panel)';
      svg.append('rect').attr('x', stripX + i * cellW).attr('y', stripY).attr('width', cellW - 2).attr('height', 26).attr('rx', 2)
         .attr('fill', fill).attr('stroke', stroke);
      svg.append('text').attr('x', stripX + i * cellW + (cellW - 2) / 2).attr('y', stripY + 18).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 9).text(CURSOR_BYTES[i] || '00');
    }

    // landing-zone placeholder (visible before step 5; replaced by NEW RECORD at step 5)
    const lzY = stripY + 60;
    const lzH = 70;
    if (active < 5) {
      svg.append('rect').attr('x', stripX).attr('y', lzY).attr('width', n * cellW - 2).attr('height', lzH).attr('rx', 4)
         .attr('fill', 'none').attr('stroke', 'var(--border-2)').attr('stroke-dasharray', '4 4');
      svg.append('text').attr('x', stripX + (n * cellW) / 2).attr('y', lzY + lzH / 2 + 4).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono-dim').attr('font-size', 11)
         .text('(inserted row will land here after step 5)');
    } else {
      // NEW RECORD strip (shown after step 5)
      svg.append('text').attr('x', stripX).attr('y', lzY - 4)
         .attr('class', 'lbl-mono').attr('font-size', 10).attr('fill', 'var(--ok)').text('NEW RECORD (INSERTED)');
      const newG = svg.append('g').attr('opacity', 0);
      newG.transition().duration(280).attr('opacity', 1);
      for (let i = 0; i < n; i++) {
        const fromPrefix = i < 12;
        const fill = fromPrefix ? 'rgba(74,229,229,.18)' : 'rgba(74,242,118,.18)';
        const stroke = fromPrefix ? 'var(--accent)' : 'var(--ok)';
        newG.append('rect').attr('x', stripX + i * cellW).attr('y', lzY + 14).attr('width', cellW - 2).attr('height', 26).attr('rx', 2)
           .attr('fill', fill).attr('stroke', stroke);
        newG.append('text').attr('x', stripX + i * cellW + (cellW - 2) / 2).attr('y', lzY + 32).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 9).text(NEW_BYTES[i] || '00');
      }
      // (the cursor_rec.next_record_offset linked-list update is mentioned in
      // the step 5 narration; drawing it as a squiggly arrow back into the new
      // record was visually confusing and added little — left out on purpose.)
    }

    // ===== RIGHT: REDO RECORD fields =====
    const rpX = 736, rpY = 16, rpW = 448, rpH = 240;
    svg.append('rect').attr('x', rpX).attr('y', rpY).attr('width', rpW).attr('height', rpH).attr('rx', 8)
       .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--orange)').attr('stroke-width', 1.5);
    svg.append('text').attr('x', rpX + 14).attr('y', rpY + 22).attr('class', 'lbl-mono')
       .attr('fill', 'var(--orange)').text('REDO RECORD · MLOG_REC_INSERT');

    const fields = [
      { k:'type',                 v:'MLOG_REC_INSERT · type 9',     hi: active >= 1 },
      { k:'space_id, page_no',    v:'space=5 · page=42',            hi: active >= 1 },
      { k:'cursor_rec_offset',    v:'120 (points into page)',       hi: active >= 1 },
      { k:'end_seg_len',          v:'40 (odd → extra info follows)',hi: active >= 2 },
      { k:'info_and_status_bits', v:'0x00',                         hi: active >= 2 },
      { k:'origin_offset',        v:'5 (5-byte header)',            hi: active >= 2 },
      { k:'mismatch_index',       v:'12',                           hi: active >= 2 },
      { k:'body (20 B)',          v:'trailing bytes of new record', hi: active >= 4 }
    ];
    fields.forEach((f, i) => {
      const fy = rpY + 56 + i * 22;
      // background row when highlighted
      if (f.hi) {
        svg.append('rect').attr('x', rpX + 8).attr('y', fy - 14).attr('width', rpW - 16).attr('height', 18).attr('rx', 3)
           .attr('fill', 'rgba(255,154,74,.10)').attr('opacity', 0)
           .transition().duration(280).attr('opacity', 1);
      }
      svg.append('text').attr('x', rpX + 14).attr('y', fy).attr('class', 'lbl-mono-dim').text(f.k);
      svg.append('text').attr('x', rpX + rpW - 14).attr('y', fy).attr('text-anchor', 'end')
         .attr('class', 'lbl-mono').attr('fill', f.hi ? 'var(--orange)' : 'var(--ink-2)').text(f.v);
    });

    // dotted connector: cursor_rec_offset (right panel) → cursor_rec strip end (left panel)
    if (active >= 1) {
      const fy = rpY + 56 + 2 * 22;        // y of cursor_rec_offset row
      const stripEnd = stripX + n * cellW;
      svg.append('path')
         .attr('d', `M${rpX + 8},${fy - 5} L${stripEnd + 28},${fy - 5} L${stripEnd + 28},${stripY + 13} L${stripEnd + 4},${stripY + 13}`)
         .attr('fill', 'none').attr('stroke', 'var(--accent)').attr('stroke-width', 1)
         .attr('stroke-dasharray', '3 3').attr('opacity', 0)
         .transition().duration(280).attr('opacity', 0.7);
    }

    // ===== BOTTOM: SCRATCH BUFFER =====
    const sbX = 16, sbY = 280, sbW = 1168, sbH = 130;
    if (active < 3) {
      // placeholder — buffer not yet allocated
      svg.append('rect').attr('x', sbX).attr('y', sbY).attr('width', sbW).attr('height', sbH).attr('rx', 8)
         .attr('fill', 'none').attr('stroke', 'var(--border-2)').attr('stroke-dasharray', '4 4');
      svg.append('text').attr('x', sbX + 14).attr('y', sbY + 22).attr('class', 'lbl-mono-dim')
         .text('byte buf[mismatch_index + end_seg_len]   /* Build the inserted record to buf */');
      svg.append('text').attr('x', sbX + sbW / 2).attr('y', sbY + sbH / 2 + 4).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono-dim').attr('font-size', 12)
         .text('(buffer allocated later — steps 3-4)');
    } else {
      const sbg = svg.append('g').attr('opacity', 0);
      sbg.transition().duration(300).attr('opacity', 1);
      sbg.append('rect').attr('x', sbX).attr('y', sbY).attr('width', sbW).attr('height', sbH).attr('rx', 8)
         .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--border)').attr('stroke-width', 1.5);
      sbg.append('text').attr('x', sbX + 14).attr('y', sbY + 22).attr('class', 'lbl-mono-dim')
         .text('byte buf[mismatch_index + end_seg_len]   /* Build the inserted record to buf */');
      sbg.append('text').attr('x', sbX + 14).attr('y', sbY + 38).attr('class', 'lbl-mono-dim').attr('font-size', 10)
         .attr('fill', 'var(--accent)').text('origin_offset = 5 (N)');

      const bw = 26, by = sbY + 50;
      const totalCells = 36;
      for (let i = 0; i < totalCells; i++) {
        let stroke = 'var(--border-2)', fill = 'var(--panel)';
        if (active >= 3 && i < 12)              { stroke = 'var(--accent)'; fill = 'rgba(74,229,229,.18)'; }
        if (active >= 4 && i >= 12 && i < 32)   { stroke = 'var(--ok)';     fill = 'rgba(74,242,118,.16)'; }
        sbg.append('rect').attr('x', sbX + 14 + i * bw).attr('y', by).attr('width', bw - 2).attr('height', 28).attr('rx', 2)
           .attr('fill', fill).attr('stroke', stroke);
        const byte = i < 12 ? CURSOR_BYTES[i] : (i < 32 ? NEW_BYTES[i] : '');
        if (byte) sbg.append('text').attr('x', sbX + 14 + i * bw + (bw - 2) / 2).attr('y', by + 19).attr('text-anchor', 'middle')
                    .attr('class', 'lbl-mono').attr('font-size', 9).text(byte);
      }

      // page_cur_rec_insert(...) caption
      sbg.append('text').attr('x', sbX + sbW / 2).attr('y', sbY + sbH - 20).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 11).attr('fill', active >= 5 ? 'var(--ok)' : 'var(--accent)')
         .text('page_cur_rec_insert(cursor, buf + origin_offset, …)');
    }

    // ===== legend (bottom) =====
    svg.append('rect').attr('x', 16).attr('y', 470).attr('width', 14).attr('height', 14).attr('rx', 2)
       .attr('fill', 'rgba(74,229,229,.4)').attr('stroke', 'var(--accent)');
    svg.append('text').attr('x', 36).attr('y', 482).attr('class', 'lbl-mono-dim').attr('font-size', 11).text('PREFIX COPIED FROM CURSOR_REC (mismatch_index bytes)');
    svg.append('rect').attr('x', 460).attr('y', 470).attr('width', 14).attr('height', 14).attr('rx', 2)
       .attr('fill', 'rgba(74,242,118,.4)').attr('stroke', 'var(--ok)');
    svg.append('text').attr('x', 480).attr('y', 482).attr('class', 'lbl-mono-dim').attr('font-size', 11).text('BODY BYTES COPIED FROM REDO RECORD (end_seg_len bytes)');
  }

  section.querySelector('[data-act="step"]').addEventListener('click', () => {
    if (active < STEPS.length - 1) active++;
    renderTabs(); render();
  });
  section.querySelector('[data-act="play"]').addEventListener('click', () => {
    if (timer) { clearInterval(timer); timer = null; return; }
    timer = setInterval(() => {
      if (active >= STEPS.length - 1) { clearInterval(timer); timer = null; return; }
      active++; renderTabs(); render();
    }, 1100);
  });
  section.querySelector('[data-act="reset"]').addEventListener('click', () => {
    if (timer) { clearInterval(timer); timer = null; }
    active = 0; renderTabs(); render();
  });

  renderTabs(); render();
})();
