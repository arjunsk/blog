/* mtr.js — ⑮ Mini-transaction (MTR) step trace */
(function () {
  const section = document.getElementById('mtr');
  section.innerHTML = `
    <h2><span class="no">⑯</span>Mini-transaction (MTR)</h2>
    <p class="lead">A mini-transaction is the atomic unit of page modification inside InnoDB. It binds together page latches, row locks (the lock manager), undo records, and redo records for one user-visible operation. Recovery replays only complete MTRs — never a partial one.</p>
    <p>Trace a single <code>UPDATE users SET name='dave' WHERE id=42</code> through one MTR. Click <em>Next step</em> to walk through the real call stack from <code>row0upd.cc → btr0cur.cc</code>. Watch how latches vs. locks vs. undo vs. redo accumulate — and when each is released.</p>
    <div class="controls">
      <button class="btn primary" data-act="step">Step ▶</button>
      <button class="btn"          data-act="play">▶ Auto play</button>
      <button class="btn"          data-act="reset">↺ Reset</button>
      <span style="margin-left:auto;color:var(--ink-dim);font-size:12px">Click any step on the left to jump to it.</span>
    </div>
    <div class="viz-container" style="padding:24px">
      <svg id="mtr-svg" viewBox="0 0 1300 720" style="width:100%;height:auto"></svg>
    </div>
    <div class="inspector" id="mtr-log"></div>
  `;

  // IMPORTANT: keep resource names stable across steps so the delta-detection
  // (acquired/released) doesn't false-positive on rename. Sub-state transitions
  // (e.g., "REDO #1/#2/#3 BUFFERED" → just "REDO BUF") are conveyed by the call
  // and file fields, not by mutating the chip label.
  const STEPS = [
    { call:'mtr_start()',                            file:'mtr/mtr0mtr.cc · mtr_t::start()',                                          held:[] },
    { call:'X-latch the leaf page',                  file:'btr/btr0cur.cc · btr_cur_search_to_nth_level',                             held:['PAGE X-LATCH'] },
    { call:'Acquire row X-lock',                     file:'lock/lock0lock.cc · lock_clust_rec_modify_check_and_lock',                 held:['PAGE X-LATCH','ROW X-LOCK'] },
    { call:'Write UNDO record (nested mtr)',         file:'trx/trx0undo.cc · trx_undo_report_row_operation/upd_exist_rec',           held:['PAGE X-LATCH','ROW X-LOCK','UNDO RECORD'] },
    { call:'Update system fields on the record',     file:'row/row0upd.cc · row_upd_rec_sys_fields',                                  held:['PAGE X-LATCH','ROW X-LOCK','UNDO RECORD','REDO BUF'] },
    { call:'Modify the record on the page in-place', file:'row/row0upd.cc · row_upd_rec_in_place',                                    held:['PAGE X-LATCH','ROW X-LOCK','UNDO RECORD','REDO BUF'] },
    { call:'Emit redo record',                       file:'mtr/mtr0log.cc · MLOG_REC_UPDATE_IN_PLACE',                                held:['PAGE X-LATCH','ROW X-LOCK','UNDO RECORD','REDO BUF'] },
    { call:'mtr_commit()',                           file:'mtr/mtr0mtr.cc · mtr_commit  (page X-latch + redo buf released)',          held:['ROW X-LOCK','UNDO RECORD'] },
    { call:'Transaction COMMIT (much later)',        file:'trx/trx0trx.cc · trx_commit  (row X-lock + undo released)',                held:[] }
  ];
  let i = 0;
  let timer = null;

  section.querySelector('[data-act="step"]').addEventListener('click', () => { if (i < STEPS.length - 1) i++; render(); });
  section.querySelector('[data-act="play"]').addEventListener('click', () => {
    if (timer) { clearInterval(timer); timer = null; return; }
    timer = setInterval(() => {
      if (i >= STEPS.length - 1) { clearInterval(timer); timer = null; return; }
      i++; render();
    }, 1000);
  });
  section.querySelector('[data-act="reset"]').addEventListener('click', () => {
    if (timer) { clearInterval(timer); timer = null; }
    i = 0; render();
  });

  function render() {
    const svg = d3.select('#mtr-svg'); svg.selectAll('*').remove(); installArrowDefs(svg);

    svg.append('rect').attr('x', 16).attr('y', 16).attr('width', 1268).attr('height', 60).attr('rx', 8)
       .attr('fill', 'none').attr('stroke', 'var(--border)').attr('stroke-width', 1.5);
    svg.append('text').attr('x', 28).attr('y', 38).attr('class', 'lbl-mono-dim').text('STATEMENT');
    svg.append('text').attr('x', 28).attr('y', 60).attr('class', 'lbl-mono').text("UPDATE users SET name='dave' WHERE id=42;");

    svg.append('rect').attr('x', 16).attr('y', 92).attr('width', 880).attr('height', 600).attr('rx', 8)
       .attr('fill', 'none').attr('stroke', 'var(--border)').attr('stroke-width', 1.5);

    // Active-step background bar so the current step pops, plus per-step
    // delta visualisation so it's obvious WHAT changed at each row:
    //   continuing chip → cyan
    //   newly acquired  → green outline + "+ NAME"  (stands out as "new this step")
    //   newly released  → red strikethrough chip + "− NAME" (visible only on the row that releases it)
    STEPS.forEach((s, k) => {
      const y = 116 + k * 64;
      const isCur = k === i, isPast = k < i;
      const c = isCur ? 'var(--accent)' : (isPast ? 'var(--ok)' : 'var(--ink-dim)');

      // active-row tint
      if (isCur) {
        svg.append('rect').attr('x', 22).attr('y', y - 8).attr('width', 854).attr('height', 56).attr('rx', 6)
           .style('fill', 'rgba(74,229,229,0.06)').attr('stroke', 'var(--accent)').attr('stroke-width', 1)
           .style('cursor', 'pointer')
           .on('click', () => { if (timer) { clearInterval(timer); timer = null; } i = k; render(); });
      } else {
        svg.append('rect').attr('x', 22).attr('y', y - 8).attr('width', 854).attr('height', 56).attr('rx', 6)
           .attr('fill', 'transparent').style('cursor', 'pointer')
           .on('click', () => { if (timer) { clearInterval(timer); timer = null; } i = k; render(); });
      }

      svg.append('circle').attr('cx', 42).attr('cy', y + 12).attr('r', 10)
         .attr('fill', isCur ? 'rgba(74,229,229,0.18)' : 'var(--panel-2)')
         .attr('stroke', c).attr('stroke-width', 1.5);
      svg.append('text').attr('x', 42).attr('y', y + 16).attr('text-anchor', 'middle').attr('class', 'lbl-mono').attr('fill', c).text(k);
      svg.append('text').attr('x', 64).attr('y', y + 12).attr('class', 'lbl-mono')
         .attr('fill', isCur ? 'var(--accent)' : 'var(--ink)').attr('font-weight', isCur ? 700 : 400).text(s.call);
      svg.append('text').attr('x', 64).attr('y', y + 30).attr('class', 'lbl-mono-dim').attr('font-size', 10).text(s.file);

      // ---- Compute deltas relative to previous step ----
      const prevHeld = k > 0 ? STEPS[k - 1].held : [];
      const acquired = new Set(s.held.filter(h => !prevHeld.includes(h)));
      const released = prevHeld.filter(h => !s.held.includes(h));

      // Build a chip list right→left: continuing chips, newly acquired chips,
      // and ghost-strikethrough chips for resources released THIS step.
      let cx = 880 - 12;
      // released ghost chips first (rightmost) so they read as "what just left"
      [...released].reverse().forEach(h => {
        const txt = '− ' + h;
        const w = txt.length * 6.5 + 14; cx -= w + 6;
        svg.append('rect').attr('x', cx).attr('y', y).attr('width', w).attr('height', 22).attr('rx', 4)
           .style('fill', 'rgba(242,92,92,0.08)').style('stroke', 'var(--err)').attr('stroke-dasharray', '3 2');
        const t = svg.append('text').attr('x', cx + w / 2).attr('y', y + 15).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 9.5).style('fill', 'var(--err)').text(txt);
        // strikethrough line through the chip
        svg.append('line').attr('x1', cx + 4).attr('y1', y + 11).attr('x2', cx + w - 4).attr('y2', y + 11)
           .attr('stroke', 'var(--err)').attr('stroke-width', 1).attr('opacity', 0.7);
      });
      // currently-held chips (in their natural order, drawn right→left)
      [...s.held].reverse().forEach(h => {
        const isNew = acquired.has(h);
        const txt   = isNew ? '+ ' + h : h;
        const color = isNew ? 'var(--ok)' : 'var(--accent)';
        const fill  = isNew ? 'rgba(74,242,118,0.10)' : 'var(--panel-2)';
        const w = txt.length * 6.5 + 16; cx -= w + 6;
        svg.append('rect').attr('x', cx).attr('y', y).attr('width', w).attr('height', 22).attr('rx', 4)
           .style('fill', fill).style('stroke', color).attr('stroke-width', isNew ? 1.5 : 1);
        svg.append('text').attr('x', cx + w / 2).attr('y', y + 15).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 9.5).style('fill', color).attr('font-weight', isNew ? 600 : 400).text(txt);
      });
      // tiny "no change" hint on rows that don't acquire/release anything
      if (acquired.size === 0 && released.length === 0 && k > 0) {
        svg.append('text').attr('x', 880 - 12).attr('y', y + 35).attr('text-anchor', 'end')
           .attr('class', 'lbl-mono-dim').attr('font-size', 9).text('· no change ·');
      }
    });

    svg.append('rect').attr('x', 912).attr('y', 92).attr('width', 372).attr('height', 600).attr('rx', 8)
       .attr('fill', 'none').attr('stroke', 'var(--border)').attr('stroke-width', 1.5);
    svg.append('text').attr('x', 924).attr('y', 116).attr('class', 'lbl-mono-dim').text('RESOURCE STATE');

    // Each resource has a fixed lifetime [acquireStep, releaseStep] across the 9 steps.
    // We draw a horizontal bar showing when it's held; current step gets a marker.
    const N = STEPS.length;                              // 9 steps total (0..8)
    const items = [
      { name: 'PAGE X-LATCH',         scope: 'SHORT · RELEASED AT MTR_COMMIT',    color: 'var(--accent)', acquire: 1, release: 7 },
      { name: 'ROW X-LOCK (LOCK MGR)',scope: 'LONG · RELEASED AT TRX COMMIT',     color: 'var(--err)',    acquire: 2, release: 8 },
      { name: 'UNDO RECORD',          scope: 'DURABLE · FREED AT PURGE',          color: 'var(--orange)', acquire: 3, release: N - 1 },
      { name: 'REDO RECORD IN MTR BUF',scope: 'FLUSHED AT MTR_COMMIT',            color: 'var(--ok)',     acquire: 4, release: 7 }
    ];
    items.forEach((it, k) => {
      const y = 144 + k * 100;
      const isHeld = (i >= it.acquire && i < it.release);
      // outer card
      svg.append('rect').attr('x', 924).attr('y', y).attr('width', 350).attr('height', 86).attr('rx', 6)
         .attr('fill', 'var(--panel-2)').attr('stroke', isHeld ? it.color : 'var(--border-2)');
      // title
      svg.append('text').attr('x', 936).attr('y', y + 20).attr('class', 'lbl-mono')
         .attr('fill', isHeld ? it.color : 'var(--ink-dim)').text(it.name);
      const status = isHeld ? 'HELD' : (i < it.acquire ? '—' : 'released');
      svg.append('text').attr('x', 1264).attr('y', y + 20).attr('text-anchor', 'end')
         .attr('class', 'lbl-mono').attr('font-size', 11)
         .attr('fill', isHeld ? it.color : 'var(--ink-dim)').text(status);
      // scope subtitle
      svg.append('text').attr('x', 936).attr('y', y + 38).attr('class', 'lbl-mono-dim').attr('font-size', 10).text(it.scope);

      // lifetime bar
      const barX = 936, barY = y + 50, barW = 328, barH = 14;
      const slotW = barW / N;
      // background track
      svg.append('rect').attr('x', barX).attr('y', barY).attr('width', barW).attr('height', barH).attr('rx', 3)
         .attr('fill', 'var(--bg)').attr('stroke', 'var(--border-2)');
      // held region
      svg.append('rect').attr('x', barX + it.acquire * slotW).attr('y', barY)
         .attr('width', (it.release - it.acquire) * slotW).attr('height', barH).attr('rx', 3)
         .attr('fill', it.color).attr('opacity', 0.4);
      // current-step marker
      svg.append('rect').attr('x', barX + i * slotW + 1).attr('y', barY - 2)
         .attr('width', slotW - 2).attr('height', barH + 4).attr('rx', 2)
         .attr('fill', 'none').attr('stroke', isHeld ? it.color : 'var(--ink-dim)').attr('stroke-width', 1.5);
      // step axis labels
      svg.append('text').attr('x', barX).attr('y', barY + barH + 14).attr('class', 'lbl-mono-dim').attr('font-size', 9).text(`STEP ${it.acquire}`);
      svg.append('text').attr('x', barX + barW).attr('y', barY + barH + 14).attr('text-anchor', 'end').attr('class', 'lbl-mono-dim').attr('font-size', 9).text(`STEP ${it.release}`);
    });

    d3.select('#mtr-log').html(`Step ${i}/${STEPS.length - 1}: <code>${STEPS[i].call}</code> — ${STEPS[i].file}. ` +
      (STEPS[i].held.length ? 'Held: ' + STEPS[i].held.map(h => `<code>${h}</code>`).join(', ') + '.' : 'Nothing held.'));
  }

  render();
})();
