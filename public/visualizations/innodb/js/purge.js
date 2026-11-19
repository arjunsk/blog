/* purge.js — ⑧ Purge: coordinator + workers, history boundary, three phases */
(function () {
  const section = document.getElementById('purge');
  section.innerHTML = `
    <h2><span class="no">⑧</span>Purge</h2>
    <p class="lead">Purge is the background cleanup for committed update/delete undo records. It walks the history list across all rollback segments in <code>trx_no</code> order, removes delete-marked rows and old row versions from the B+Tree, and finally truncates the undo segments themselves.</p>
    <p>Purge is <em>best-effort</em> — it cannot cause space leaks, only delays. A long-running ReadView pins history: until the oldest open ReadView's <code>m_up_limit_id</code> advances past a trx's undo, that undo stays on the list. This is why a forgotten <code>BEGIN;</code> on a reporting replica can cause history-list growth on the writer.</p>

    <h3>7A · Coordinator + workers</h3>
    <p>One coordinator thread picks the next undo records to process (PLAN phase) and dispatches them to N worker threads (PURGE phase). After workers drain their batch, the coordinator truncates the undo segments whose records have all been consumed (TRUNCATE phase).</p>
    <div class="viz-container" style="padding:24px">
      <svg id="purge-arch" viewBox="0 0 1200 320" style="width:100%;height:auto"></svg>
    </div>

    <h3 style="margin-top:36px">7B · Purge boundary vs. ReadView</h3>
    <p>Click the buttons to add committed txns to the history list and see how an open ReadView freezes the purge boundary.</p>
    <div class="controls">
      <button class="btn primary" data-act="commit">✓ Commit trx</button>
      <button class="btn" data-act="openrv">▾ Open ReadView</button>
      <button class="btn" data-act="closerv">× Close oldest ReadView</button>
      <button class="btn" data-act="cycle">↻ Purge cycle</button>
      <button class="btn" data-act="reset">↺ Reset</button>
    </div>
    <div class="viz-container" style="padding:24px">
      <svg id="purge-bnd" viewBox="0 0 1200 360" style="width:100%;height:auto"></svg>
    </div>
    <div class="inspector" id="pg-log">Click <b>✓ Commit trx</b> a few times.</div>

    <h3 style="margin-top:36px">7C · Three phases per cycle</h3>
    <div class="viz-container" style="padding:24px">
      <svg id="purge-phases" viewBox="0 0 1200 200" style="width:100%;height:auto"></svg>
    </div>
    <details class="explain">
      <summary>Which undo records actually need purge?</summary>
      <div class="body">
        <ul>
          <li><b>INSERT</b> undo: discarded at commit — purge never sees them (rollback only).</li>
          <li><b>UPDATE</b> undo: kept until no ReadView could possibly need them — this is the history list.</li>
          <li><b>DELETE-MARK</b>: row is left in place at commit, purge later removes it from secondary indexes and the cluster.</li>
        </ul>
      </div>
    </details>
  `;

  // ===== 7A · Architecture =====
  (function renderArch() {
    const svg = d3.select('#purge-arch');
    installArrowDefs(svg);
    svg.append('rect').attr('x', 16).attr('y', 16).attr('width', 1168).attr('height', 280).attr('rx', 8)
       .attr('fill', 'none').attr('stroke', 'var(--orange)').attr('stroke-width', 1.5);
    svg.append('text').attr('x', 28).attr('y', 38).attr('class', 'lbl-mono-dim').text('PURGE SUBSYSTEM · DEFAULT 4 WORKERS (innodb_purge_threads)');

    // coordinator
    svg.append('rect').attr('x', 40).attr('y', 70).attr('width', 280).attr('height', 200).attr('rx', 6)
       .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--accent)');
    svg.append('text').attr('x', 56).attr('y', 92).attr('class', 'lbl-mono-dim').text('purge coordinator');
    svg.append('text').attr('x', 56).attr('y', 110).attr('class', 'lbl-mono-dim').attr('font-size', 10).text('trx/trx0purge.cc');
    ['1. PLAN next undo batch', '2. dispatch to workers', '3. wait → TRUNCATE'].forEach((s, i) =>
      svg.append('text').attr('x', 56).attr('y', 144 + i * 22).attr('class', 'lbl-mono').text(s));
    svg.append('text').attr('x', 56).attr('y', 240).attr('class', 'lbl-mono-dim').attr('font-size', 10).text('ADVANCES PURGE_SYS->ITER');

    // workers
    for (let i = 0; i < 4; i++) {
      const y = 80 + i * 46;
      svg.append('rect').attr('x', 488).attr('y', y).attr('width', 280).attr('height', 36).attr('rx', 5)
         .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--orange)');
      svg.append('text').attr('x', 504).attr('y', y + 22).attr('class', 'lbl-mono').text(`worker ${i + 1}`);
      svg.append('text').attr('x', 760).attr('y', y + 22).attr('text-anchor', 'end').attr('class', 'lbl-mono-dim').attr('fill', 'var(--orange)').text('row_purge_record()');
      svg.append('path').attr('d', `M320,170 C400,170 400,${y + 18} 488,${y + 18}`).attr('class', 'arrow');
    }

    // rseg history
    svg.append('rect').attr('x', 880).attr('y', 80).attr('width', 280).attr('height', 200).attr('rx', 6)
       .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--orange)');
    svg.append('text').attr('x', 896).attr('y', 102).attr('class', 'lbl-mono-dim').text('rseg history list');
    svg.append('text').attr('x', 896).attr('y', 120).attr('class', 'lbl-mono-dim').attr('font-size', 10).text('TRX_RSEG_HISTORY · sorted by TRX_NO');
    ['u1', 'u2', 'u3', 'u4', 'u5'].forEach((u, i) => {
      svg.append('rect').attr('x', 904 + i * 48).attr('y', 150).attr('width', 38).attr('height', 30).attr('rx', 4)
         .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--orange)');
      svg.append('text').attr('x', 904 + i * 48 + 19).attr('y', 170).attr('text-anchor', 'middle').attr('class', 'lbl-mono').text(u);
    });
    svg.append('text').attr('x', 896).attr('y', 220).attr('class', 'lbl-mono-dim').attr('font-size', 10).text('OLDEST TRX_NO  →  NEWEST');
  })();

  // ===== 7B · Boundary =====
  // Multiple ReadViews can be open at once. The OLDEST active one pins the
  // purge boundary at its m_up_limit_id. Each readview is positioned on the
  // timeline at the x-coordinate corresponding to its upLimit value.
  let bnd;
  function resetBnd() {
    bnd = {
      nextTrxNo: 200,        // next trx_no to assign on commit
      rvSeq: 0,              // RV name counter
      committed: [],         // [{ tx, trx_no, marked }]
      readviews: [],         // [{ name, upLimit }]
      purgeCutoff: null
    };
  }
  resetBnd();

  function recompute() {
    if (bnd.readviews.length) {
      bnd.purgeCutoff = Math.min(...bnd.readviews.map(r => r.upLimit));
      bnd.committed.forEach(c => { c.marked = c.trx_no < bnd.purgeCutoff ? 'will purge' : 'pinned'; });
    } else {
      bnd.purgeCutoff = null;
      bnd.committed.forEach(c => c.marked = 'will purge');
    }
  }

  // Map a trx_no → x coordinate on the timeline
  function trxX(n, x0, x1) {
    if (!bnd.committed.length) return x0;
    const minN = bnd.committed[0].trx_no;
    const maxN = Math.max(bnd.committed[bnd.committed.length - 1].trx_no, ...bnd.readviews.map(r => r.upLimit), bnd.nextTrxNo);
    if (maxN === minN) return (x0 + x1) / 2;
    return x0 + ((n - minN) / (maxN - minN)) * (x1 - x0);
  }

  function renderBnd() {
    const svg = d3.select('#purge-bnd'); svg.selectAll('*').remove(); installArrowDefs(svg);

    // Outer panel — orange border to match the photo
    svg.append('rect').attr('x', 16).attr('y', 16).attr('width', 1168).attr('height', 320).attr('rx', 8)
       .attr('fill', 'none').attr('stroke', 'var(--orange)').attr('stroke-width', 1.5);
    svg.append('text').attr('x', 28).attr('y', 38).attr('class', 'lbl-mono-dim').text('HISTORY LIST');
    svg.append('text').attr('x', 28).attr('y', 56).attr('class', 'lbl-mono-dim').attr('font-size', 10).text('COMMITTED UPDATE-UNDO LOGS, SORTED BY TRX_NO');

    // Timeline geometry
    const tlX0 = 60, tlX1 = 1140;
    const baselineY = 200;
    const txBoxW = 130, txBoxH = 80, txBoxY = 86;

    // Baseline + axis labels
    svg.append('line').attr('x1', tlX0).attr('y1', baselineY).attr('x2', tlX1).attr('y2', baselineY)
       .attr('stroke', 'var(--border-2)').attr('stroke-dasharray', '4 4');
    svg.append('text').attr('x', tlX0).attr('y', baselineY + 18).attr('class', 'lbl-mono-dim').attr('font-size', 11).text('OLDER');
    svg.append('text').attr('x', tlX1).attr('y', baselineY + 18).attr('text-anchor', 'end').attr('class', 'lbl-mono-dim').attr('font-size', 11).text('NEWER TRX_NO →');

    // Committed transaction boxes — positioned by trx_no
    bnd.committed.forEach(c => {
      const cx = trxX(c.trx_no, tlX0 + txBoxW / 2, tlX1 - txBoxW / 2);
      const x = cx - txBoxW / 2;
      const isPurge = c.marked === 'pinned';
      const color   = isPurge ? 'var(--err)' : 'var(--orange)';
      const status  = isPurge ? 'pinned by RV' : 'waiting';
      svg.append('rect').attr('x', x).attr('y', txBoxY).attr('width', txBoxW).attr('height', txBoxH).attr('rx', 6)
         .attr('fill', 'var(--panel-2)').attr('stroke', color).attr('stroke-width', 1.5);
      svg.append('text').attr('x', cx).attr('y', txBoxY + 22).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('fill', color).text(c.tx);
      svg.append('text').attr('x', cx).attr('y', txBoxY + 42).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono-dim').attr('font-size', 10).text(`TRX_NO=${c.trx_no}`);
      svg.append('text').attr('x', cx).attr('y', txBoxY + 64).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('fill', color).attr('font-size', 11).text(status);
      // dotted line down to baseline
      svg.append('line').attr('x1', cx).attr('y1', txBoxY + txBoxH).attr('x2', cx).attr('y2', baselineY)
         .attr('stroke', 'var(--border-2)').attr('stroke-dasharray', '3 3').attr('opacity', 0.6);
    });

    // ReadView chips — staircased below the baseline (each on its own row to avoid overlap)
    const oldest = bnd.readviews.length ? bnd.readviews.reduce((a, b) => a.upLimit < b.upLimit ? a : b) : null;
    bnd.readviews.forEach((rv, i) => {
      const cx = trxX(rv.upLimit, tlX0 + 60, tlX1 - 60);
      const y = baselineY + 28 + i * 22;            // staircase
      const isOldest = (rv === oldest);
      const c = isOldest ? 'var(--accent)' : 'var(--blue)';
      // small dot at the timeline crossing
      if (isOldest) {
        svg.append('circle').attr('cx', cx).attr('cy', baselineY).attr('r', 4)
           .attr('fill', 'var(--accent)');
      }
      // vertical drop from baseline to the chip
      svg.append('line').attr('x1', cx).attr('y1', baselineY).attr('x2', cx).attr('y2', y - 6)
         .attr('stroke', c).attr('stroke-dasharray', '3 3').attr('opacity', 0.55);
      // chip
      const label = `${rv.name} up_limit=${rv.upLimit}`;
      const w = label.length * 7 + 16;
      const x = cx - w / 2;
      svg.append('rect').attr('x', x).attr('y', y - 6).attr('width', w).attr('height', 18).attr('rx', 4)
         .attr('fill', 'var(--panel-2)').attr('stroke', c).attr('stroke-width', isOldest ? 2 : 1);
      svg.append('text').attr('x', cx).attr('y', y + 7).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 11).attr('fill', c).text(label);
    });

    // Purge cutoff vertical guide — drawn from the OLDEST ReadView's up_limit
    if (oldest) {
      const cx = trxX(oldest.upLimit, tlX0 + 60, tlX1 - 60);
      svg.append('line').attr('x1', cx).attr('y1', txBoxY - 10).attr('x2', cx).attr('y2', baselineY)
         .attr('stroke', 'var(--accent)').attr('stroke-width', 2).attr('stroke-dasharray', '4 3');
    }
  }

  section.querySelector('[data-act="commit"]').addEventListener('click', () => {
    bnd.nextTrxNo++;
    bnd.committed.push({ tx: `tx_${bnd.nextTrxNo}`, trx_no: bnd.nextTrxNo, marked: 'will purge' });
    recompute();
    d3.select('#pg-log').html(`<code>tx_${bnd.nextTrxNo}</code> committed. Its update-undo joined the history list with <code>trx_no=${bnd.nextTrxNo}</code>.`);
    renderBnd();
  });
  section.querySelector('[data-act="openrv"]').addEventListener('click', () => {
    // Snapshot taken BEFORE the next commit: the RV pins the most recent
    // committed trx_no (its m_up_limit_id == the most recent commit's trx_no,
    // so undo for that trx is needed to reconstruct the prior version).
    bnd.rvSeq++;
    const upLimit = bnd.committed.length ? bnd.committed[bnd.committed.length - 1].trx_no : (bnd.nextTrxNo + 1);
    const rv = { name: `RV${bnd.rvSeq}`, upLimit };
    bnd.readviews.push(rv);
    recompute();
    d3.select('#pg-log').html(`ReadView <code>${rv.name}</code> opened with <code>m_up_limit_id=${rv.upLimit}</code>. Purge cutoff is pinned by the OLDEST active ReadView; entries with <code>trx_no &gt;= ${bnd.purgeCutoff}</code> are kept.`);
    renderBnd();
  });
  section.querySelector('[data-act="closerv"]').addEventListener('click', () => {
    if (!bnd.readviews.length) { d3.select('#pg-log').html('No ReadView open.'); return; }
    // close OLDEST (smallest upLimit)
    const oldest = bnd.readviews.reduce((a, b) => a.upLimit < b.upLimit ? a : b);
    bnd.readviews = bnd.readviews.filter(r => r !== oldest);
    recompute();
    d3.select('#pg-log').html(`Closed <code>${oldest.name}</code> (oldest). Purge cutoff is now <code>${bnd.purgeCutoff != null ? 'trx_no &lt; ' + bnd.purgeCutoff : 'UNBOUNDED'}</code>.`);
    renderBnd();
  });
  section.querySelector('[data-act="cycle"]').addEventListener('click', () => {
    const before = bnd.committed.length;
    bnd.committed = bnd.committed.filter(c => c.marked !== 'will purge');
    recompute();
    const cutoff = bnd.purgeCutoff != null ? `trx_no &lt; ${bnd.purgeCutoff}` : '∞';
    d3.select('#pg-log').html(`Purge cycle: cutoff <code>${cutoff}</code>. Reclaimed <b>${before - bnd.committed.length}</b> history entries.`);
    renderBnd();
  });
  section.querySelector('[data-act="reset"]').addEventListener('click', () => { resetBnd(); d3.select('#pg-log').html('— reset —'); renderBnd(); });

  // ===== 7C · Three phases =====
  (function renderPhases() {
    const svg = d3.select('#purge-phases'); installArrowDefs(svg);
    svg.append('text').attr('x', 24).attr('y', 24).attr('class', 'lbl-mono-dim').text('ONE PURGE CYCLE');
    const boxes = [
      { t:'1. PLAN',     body:'COORDINATOR: pop lowest TRX_NO\nfrom min-heap of rseg histories;\ncollect batch', src:'trx_purge_attach_undo_recs', c:'var(--accent)' },
      { t:'2. PURGE',    body:'N WORKERS: for each undo rec →\nrow_purge_record() — remove sec\nindexes, then cluster', src:'row_purge_step / row_vers_old_has_index_entry', c:'var(--orange)' },
      { t:'3. TRUNCATE', body:'COORDINATOR: advance\npurge_sys->iter,\ntrx_purge_truncate_rseg_history\nfrees fully-drained undo segments', src:'trx_purge_truncate_rseg_history', c:'var(--ok)' }
    ];
    boxes.forEach((b, i) => {
      const x = 24 + i * 400;
      svg.append('rect').attr('x', x).attr('y', 40).attr('width', 360).attr('height', 140).attr('rx', 8)
         .attr('fill', 'none').attr('stroke', b.c).attr('stroke-width', 1.5);
      svg.append('text').attr('x', x + 12).attr('y', 64).attr('class', 'lbl-mono').attr('fill', b.c).text(b.t);
      b.body.split('\n').forEach((s, j) => svg.append('text').attr('x', x + 12).attr('y', 90 + j * 18).attr('class', 'lbl-mono-dim').text(s));
      svg.append('text').attr('x', x + 12).attr('y', 168).attr('class', 'lbl-mono-dim').attr('font-size', 10).text('↳ ' + b.src);
      if (i < 2) svg.append('path').attr('d', `M${x + 360},110 L${x + 400},110`).attr('class', 'arrow');
    });
  })();

  renderBnd();
})();
