/* pg_reclaim.js — ㉒ Reclamation · Purge vs VACUUM
   The cost model of cleaning up old versions.
     · InnoDB Purge: precise. Each rseg owns a history list of committed
       update-undo headers, sorted by trx_no. Purge pops the smallest
       trx_no first — zero wasted I/O. Blocked only by the oldest open
       ReadView.
     · Postgres VACUUM: full table scan. There\'s no central list of dead
       tuples; vacuum must visit EVERY page in the relation, scanning each
       tuple to find the dead ones. Visibility map can skip all-frozen
       pages, but for any page that had ANY change, vacuum reads the whole
       thing.

   The visualization keeps it concrete: 4 transactions commit in order,
   producing 4 dead tuples spread across 4 heap pages. Watch the InnoDB
   history list grow neatly; watch Postgres pile up dead tuples in random
   slots that vacuum will eventually have to touch every page to find.
*/
(function () {
  const section = document.getElementById('pg-reclaim');
  if (!section) return;

  section.innerHTML = `
    <h2><span class="no">㉒</span>Reclamation · Purge vs VACUUM</h2>
    <p class="lead">Both engines pile up old versions. InnoDB has a <b>precise</b> queue (the rseg history list, oldest first); a tiny purge worker pops the smallest committed trx_no and reaps it. Postgres has <b>no central list</b>: VACUUM must scan every modified page in the relation to discover dead tuples, page by page. This is why Postgres bloat shows up as table-wide work rather than per-trx work.</p>

    <div class="controls">
      <button class="btn primary" data-act="pgrc-commit">▶ Commit a trx</button>
      <button class="btn"          data-act="pgrc-cleanup">▶ Run cleanup</button>
      <button class="btn"          data-act="pgrc-reset">↺ Reset</button>
    </div>

    <div class="viz-container" style="padding:24px">
      <svg id="pgrc-svg" viewBox="0 0 1400 580" style="width:100%;height:auto"></svg>
    </div>

    <div class="inspector" id="pgrc-log">Reset. Nothing committed yet. Click <b>▶ Commit a trx</b> to grow both data structures, then <b>▶ Run cleanup</b> to compare the work each engine does.</div>
  `;

  // ===== State =====
  // Each "trx" commits one UPDATE that lands a dead tuple on a specific heap
  // page (round-robin across 4 pages) and adds an entry to InnoDB\'s history list.
  const NUM_PAGES = 4;
  const SLOTS_PER_PAGE = 4;
  let st;
  function reset() {
    st = {
      historyList: [],          // [{ trx_no, status: 'queued' | 'purged' }]
      pages: Array.from({ length: NUM_PAGES }, () =>
        Array.from({ length: SLOTS_PER_PAGE }, () => ({ status: 'live' }))   // 'live' | 'dead' | 'reclaimed'
      ),
      nextTrxNo: 100
    };
    // Seed: every page has a few LIVE rows already (so it\'s not empty)
  }
  reset();

  function commitTrx() {
    if (st.historyList.length >= 4) return;
    const tn = st.nextTrxNo++;
    st.historyList.push({ trx_no: tn, status: 'queued' });
    // Mark a tuple DEAD on a specific page (round-robin)
    const pageIdx = (tn - 100) % NUM_PAGES;
    // pick the first 'live' slot on that page and turn it into 'dead'
    const slot = st.pages[pageIdx].findIndex(s => s.status === 'live');
    if (slot >= 0) st.pages[pageIdx][slot].status = 'dead';
  }

  function runCleanup() {
    // InnoDB Purge: pop EVERY queued entry (precise — knows exactly what to do)
    st.historyList.forEach(h => { h.status = 'purged'; });
    // Postgres VACUUM: must scan EVERY page to discover dead tuples; reclaim them
    st.pages.forEach(page => {
      page.forEach(slot => { if (slot.status === 'dead') slot.status = 'reclaimed'; });
    });
  }

  // ===== Render =====
  function render() {
    const svg = d3.select('#pgrc-svg');
    svg.selectAll('*').remove();
    drawInnoDB(svg, 24, 24, 660, 530);
    drawPostgres(svg, 716, 24, 660, 530);
    updateLog();
  }

  function panelBox(svg, x, y, w, h, color, title) {
    svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', h).attr('rx', 8)
       .attr('fill', 'var(--panel-2)').attr('stroke', color).attr('stroke-width', 1.4);
    svg.append('text').attr('x', x + 14).attr('y', y + 22).attr('class', 'lbl-mono')
       .attr('font-size', 13).attr('font-weight', 600).style('fill', color).text(title);
  }

  // ---------- LEFT: InnoDB ----------
  function drawInnoDB(svg, x, y, w, h) {
    panelBox(svg, x, y, w, h, 'var(--accent)', 'InnoDB · Purge walks the history list');

    // Inventory of structures purge actually touches:
    //   ✓ ROLLBACK SEGMENT — history list of update_undo headers (target)
    //   ✗ B-TREE LEAF — only delete-marks; no per-index sweep
    // We label both so the user sees what gets touched and what doesn't.
    const tagY = y + 46;
    svg.append('rect').attr('x', x + 16).attr('y', tagY).attr('width', 240).attr('height', 22).attr('rx', 4)
       .attr('fill', 'var(--orange)').attr('opacity', 0.18);
    svg.append('text').attr('x', x + 26).attr('y', tagY + 15).attr('class', 'lbl-mono')
       .attr('font-size', 10).attr('font-weight', 700).style('fill', 'var(--orange)').text('TARGET · ROLLBACK SEGMENT');
    svg.append('rect').attr('x', x + 268).attr('y', tagY).attr('width', 200).attr('height', 22).attr('rx', 4)
       .attr('fill', 'var(--ink-dim)').attr('opacity', 0.15);
    svg.append('text').attr('x', x + 278).attr('y', tagY + 15).attr('class', 'lbl-mono')
       .attr('font-size', 10).attr('font-weight', 700).style('fill', 'var(--ink-dim)').text('SKIP · B-TREE LEAVES');

    // rseg banner
    const banY = y + 80;
    svg.append('rect').attr('x', x + 16).attr('y', banY).attr('width', w - 32).attr('height', 38).attr('rx', 5)
       .attr('fill', 'var(--panel)').attr('stroke', 'var(--orange)').attr('stroke-width', 1.2);
    svg.append('text').attr('x', x + 28).attr('y', banY + 16).attr('class', 'lbl-mono')
       .attr('font-size', 11).style('fill', 'var(--orange)').text('ROLLBACK SEGMENT (rseg)  ·  owner of the history list');
    svg.append('text').attr('x', x + 28).attr('y', banY + 30).attr('class', 'lbl-mono-dim')
       .attr('font-size', 10).text('128 RSEGS PER INSTANCE  ·  PURGE COORDINATOR WALKS HEAD OF EACH');
    svg.append('text').attr('x', x + w - 28).attr('y', banY + 22).attr('text-anchor', 'end')
       .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', 'var(--orange)').text('precise target');

    // History list
    const hlY = banY + 56;
    svg.append('text').attr('x', x + 16).attr('y', hlY).attr('class', 'lbl-mono-dim').attr('font-size', 11)
       .text('HISTORY LIST  ·  SORTED BY TRX_NO  ·  TARGET OF PURGE');

    const cardW = 110, gap = 12;
    if (st.historyList.length === 0) {
      svg.append('text').attr('x', x + 16).attr('y', hlY + 36).attr('class', 'lbl-mono-dim').attr('font-size', 11)
         .text('(no committed trxs yet)');
    } else {
      st.historyList.forEach((h, i) => {
        const cx = x + 16 + i * (cardW + gap);
        const cy = hlY + 14;
        const purged = h.status === 'purged';
        svg.append('rect').attr('x', cx).attr('y', cy).attr('width', cardW).attr('height', 56).attr('rx', 5)
           .attr('fill', purged ? 'var(--bg-2)' : '#ffc07a')
           .attr('stroke', purged ? 'var(--ink-dim)' : '#ff9f4d')
           .attr('stroke-width', 1.2).attr('opacity', purged ? 0.4 : 0.95);
        svg.append('text').attr('x', cx + cardW / 2).attr('y', cy + 24).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 13).attr('font-weight', 600)
           .style('fill', purged ? 'var(--ink-dim)' : '#0a0a0a').text(`tx_${h.trx_no}`);
        svg.append('text').attr('x', cx + cardW / 2).attr('y', cy + 42).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 10)
           .style('fill', purged ? 'var(--ok)' : '#0a0a0a').text(purged ? '✓ purged' : 'queued');
      });
    }

    // Cleanup cost
    const ccY = hlY + 100;
    svg.append('rect').attr('x', x + 16).attr('y', ccY).attr('width', w - 32).attr('height', 96).attr('rx', 6)
       .attr('fill', 'var(--bg-2)').attr('stroke', 'var(--border-2)');
    svg.append('text').attr('x', x + 28).attr('y', ccY + 18).attr('class', 'lbl-mono')
       .attr('font-size', 11).attr('font-weight', 600).style('fill', 'var(--ink-2)').text('CLEANUP COST  ·  precise');
    [
      `· HISTORY LIST LENGTH: ${st.historyList.filter(h => h.status === 'queued').length}`,
      '· PURGE POPS SMALLEST TRX_NO FIRST  ·  ZERO WASTED I/O',
      '· BLOCKED ONLY BY OLDEST OPEN READVIEW'
    ].forEach((ln, i) => {
      svg.append('text').attr('x', x + 28).attr('y', ccY + 38 + i * 16).attr('class', 'lbl-mono-dim')
         .attr('font-size', 10).text(ln);
    });

    // Code path
    const cpY = ccY + 110;
    svg.append('rect').attr('x', x + 16).attr('y', cpY).attr('width', w - 32).attr('height', 100).attr('rx', 6)
       .attr('fill', 'transparent').attr('stroke', 'var(--border-2)').attr('stroke-dasharray', '4 4');
    svg.append('text').attr('x', x + 28).attr('y', cpY + 18).attr('class', 'lbl-mono-dim').attr('font-size', 10).text('CODE PATH');
    [
      '· trx_purge_choose_next_log()',
      '· trx_purge_get_rseg_with_purge()',
      '· row_purge_record() per undo rec',
      '· trx_purge_truncate_rseg_history()'
    ].forEach((ln, i) => {
      svg.append('text').attr('x', x + 28).attr('y', cpY + 38 + i * 14).attr('class', 'lbl-mono')
         .attr('font-size', 10).style('fill', 'var(--ink-2)').text(ln);
    });
  }

  // ---------- RIGHT: Postgres VACUUM ----------
  function drawPostgres(svg, x, y, w, h) {
    panelBox(svg, x, y, w, h, '#5b9cff', 'Postgres · VACUUM scans every modified page');

    // VACUUM has THREE targets, all of which need to be touched:
    //   ✓ HEAP pages — find dead tuples
    //   ✓ B-TREE INDEXES — remove entries that point at dead TIDs
    //   ✓ VISIBILITY MAP / FSM — bookkeeping
    const tagY = y + 46;
    [
      { lbl: 'TARGET · HEAP PAGES',  col: '#5b9cff', x: x + 16,  w: 200 },
      { lbl: 'TARGET · B-TREE INDEXES', col: '#a072f3', x: x + 224, w: 220 },
      { lbl: 'TARGET · FSM/VM',      col: 'var(--ok)', x: x + 452, w: 130 }
    ].forEach(t => {
      svg.append('rect').attr('x', t.x).attr('y', tagY).attr('width', t.w).attr('height', 22).attr('rx', 4)
         .attr('fill', t.col).attr('opacity', 0.18);
      svg.append('text').attr('x', t.x + 10).attr('y', tagY + 15).attr('class', 'lbl-mono')
         .attr('font-size', 10).attr('font-weight', 700).style('fill', t.col).text(t.lbl);
    });

    // pg_class banner
    const banY = y + 80;
    svg.append('rect').attr('x', x + 16).attr('y', banY).attr('width', w - 32).attr('height', 38).attr('rx', 5)
       .attr('fill', 'var(--panel)').attr('stroke', '#5b9cff').attr('stroke-width', 1.2);
    svg.append('text').attr('x', x + 28).attr('y', banY + 16).attr('class', 'lbl-mono')
       .attr('font-size', 11).style('fill', '#5b9cff').text('RELATION = pg_class entry for users');
    svg.append('text').attr('x', x + 28).attr('y', banY + 30).attr('class', 'lbl-mono-dim')
       .attr('font-size', 10).text('TRACKS RELFROZENXID  ·  VACUUM SCANS HEAP + INDEXES + FSM');
    svg.append('text').attr('x', x + w - 28).attr('y', banY + 22).attr('text-anchor', 'end')
       .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', '#5b9cff').text('full scan target');

    // Heap with pages
    const hpY = banY + 56;
    svg.append('text').attr('x', x + 16).attr('y', hpY).attr('class', 'lbl-mono-dim').attr('font-size', 11)
       .text(`HEAP  ·  ${NUM_PAGES} PAGES  ·  VACUUM MUST VISIT EACH`);

    const pageY = hpY + 14;
    const pageW = (w - 32 - 3 * 12) / NUM_PAGES;
    st.pages.forEach((page, i) => {
      const px = x + 16 + i * (pageW + 12);
      svg.append('rect').attr('x', px).attr('y', pageY).attr('width', pageW).attr('height', 130).attr('rx', 5)
         .attr('fill', 'var(--panel)').attr('stroke', '#5b9cff').attr('stroke-width', 1.2);
      svg.append('text').attr('x', px + 8).attr('y', pageY + 16).attr('class', 'lbl-mono-dim').attr('font-size', 9).text(`PAGE ${i}`);
      // Slots
      const slotH = 22, slotPad = 4;
      page.forEach((slot, j) => {
        const sy = pageY + 26 + j * (slotH + slotPad);
        let fill, stroke, label;
        if (slot.status === 'live')        { fill = '#a3e6a3'; stroke = '#5fbf5f'; label = 'LIVE'; }
        else if (slot.status === 'dead')   { fill = '#ff8c8c'; stroke = '#d44';    label = 'DEAD'; }
        else /* reclaimed */               { fill = 'var(--bg-2)'; stroke = 'var(--border-2)'; label = '(free)'; }
        svg.append('rect').attr('x', px + 8).attr('y', sy).attr('width', pageW - 16).attr('height', slotH).attr('rx', 3)
           .attr('fill', fill).attr('stroke', stroke).attr('stroke-width', 1)
           .attr('opacity', slot.status === 'reclaimed' ? 0.5 : 0.95);
        svg.append('text').attr('x', px + pageW / 2).attr('y', sy + 15).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 10).attr('font-weight', 600)
           .style('fill', slot.status === 'reclaimed' ? 'var(--ink-dim)' : '#0a0a0a').text(label);
      });
    });

    // Cleanup cost
    const ccY = pageY + 144;
    const dead = st.pages.flat().filter(s => s.status === 'dead').length;
    const reclaimed = st.pages.flat().filter(s => s.status === 'reclaimed').length;
    svg.append('rect').attr('x', x + 16).attr('y', ccY).attr('width', w - 32).attr('height', 70).attr('rx', 6)
       .attr('fill', 'var(--bg-2)').attr('stroke', 'var(--border-2)');
    svg.append('text').attr('x', x + 28).attr('y', ccY + 18).attr('class', 'lbl-mono')
       .attr('font-size', 11).attr('font-weight', 600).style('fill', 'var(--ink-2)').text('CLEANUP COST  ·  full scan');
    [
      `· DEAD: ${dead}  ·  RECLAIMED: ${reclaimed}  ·  MUST READ ALL ${NUM_PAGES} PAGES REGARDLESS`
    ].forEach((ln, i) => {
      svg.append('text').attr('x', x + 28).attr('y', ccY + 38 + i * 16).attr('class', 'lbl-mono-dim')
         .attr('font-size', 10).text(ln);
    });

    // Code path
    const cpY = ccY + 84;
    svg.append('rect').attr('x', x + 16).attr('y', cpY).attr('width', w - 32).attr('height', 100).attr('rx', 6)
       .attr('fill', 'transparent').attr('stroke', 'var(--border-2)').attr('stroke-dasharray', '4 4');
    svg.append('text').attr('x', x + 28).attr('y', cpY + 18).attr('class', 'lbl-mono-dim').attr('font-size', 10).text('CODE PATH');
    [
      '· table_relation_vacuum()',
      '· lazy_scan_heap() — PAGE-BY-PAGE',
      '· heap_page_prune() per page',
      '· pg_class.relfrozenxid updated'
    ].forEach((ln, i) => {
      svg.append('text').attr('x', x + 28).attr('y', cpY + 38 + i * 14).attr('class', 'lbl-mono')
         .attr('font-size', 10).style('fill', 'var(--ink-2)').text(ln);
    });
  }

  function updateLog() {
    const el = document.getElementById('pgrc-log');
    if (!el) return;
    const queued = st.historyList.filter(h => h.status === 'queued').length;
    const dead = st.pages.flat().filter(s => s.status === 'dead').length;
    if (st.historyList.length === 0) {
      el.innerHTML = 'Reset. Nothing committed yet. Click <b>▶ Commit a trx</b> to grow both data structures, then <b>▶ Run cleanup</b>.';
    } else if (queued > 0 && dead > 0) {
      el.innerHTML = `Committed tx_${st.nextTrxNo - 1}. InnoDB history list: <b>${queued}</b> entr${queued === 1 ? 'y' : 'ies'}. Postgres dead tuples: <b>${dead}</b> spread across ${NUM_PAGES} pages. Click <b>▶ Run cleanup</b> to see how each engine reclaims them.`;
    } else if (queued === 0 && dead === 0 && st.historyList.length > 0) {
      el.innerHTML = `<b>Cleanup done.</b> InnoDB Purge: drained ${st.historyList.length} history entries — touched ${st.historyList.length} undo records, nothing else. Postgres VACUUM: scanned all ${NUM_PAGES} pages to find dead tuples; reclaimed ${st.pages.flat().filter(s => s.status === 'reclaimed').length}. Pages without any garbage were still read (vacuum can\'t know in advance).`;
    } else {
      el.innerHTML = '<em>Mixed state.</em> Some commits, some cleanup done.';
    }
  }

  // ===== Wire =====
  section.querySelector('[data-act="pgrc-commit"]').addEventListener('click', () => { commitTrx(); render(); });
  section.querySelector('[data-act="pgrc-cleanup"]').addEventListener('click', () => { runCleanup(); render(); });
  section.querySelector('[data-act="pgrc-reset"]').addEventListener('click', () => { reset(); render(); });

  render();
})();
