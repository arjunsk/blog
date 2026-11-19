/* locking.js — ⑭ Row Locks: record / gap / next-key / insert-intention */
(function () {
  const section = document.getElementById('locking');
  section.innerHTML = `
    <h2><span class="no">⑮</span>Row Locks</h2>
    <p style="color:var(--ink-2);font-weight:500"><b>Primer — three kinds of "lock" in InnoDB:</b></p>
    <ul style="list-style:none;padding:0;margin:6px 0 14px;color:var(--ink-2)">
      <li style="margin:6px 0;line-height:1.6"><b style="color:var(--accent)">Row lock</b> — logical, long-lived. Placed on an (index, heap_no) record by the lock manager (<code>lock/lock0lock.cc</code>). Held until COMMIT/ROLLBACK. Survives across page I/O and multiple MTRs. Modes <code>S, X</code>, with flags <code>LOCK_GAP, LOCK_REC_NOT_GAP, LOCK_ORDINARY, LOCK_INSERT_INTENTION</code>. <em>This is what ⑭ below explores in detail.</em></li>
      <li style="margin:6px 0;line-height:1.6"><b style="color:var(--accent)">Page latch</b> — physical, short-lived. A mutex on a buffer-pool page frame. Taken by a mini-transaction to prevent torn in-memory reads while modifying. Released at <code>mtr_commit()</code> — never held across I/O. Invisible to users. Covered in ⑮ MTR.</li>
      <li style="margin:6px 0;line-height:1.6"><b style="color:var(--accent)">MDL (metadata lock)</b> — SQL-layer, above InnoDB. Lives in <code>sql/mdl.cc</code>. Protects table definitions, not rows. A SELECT holds <code>MDL_SHARED_READ</code>; an ALTER TABLE needs <code>MDL_EXCLUSIVE</code>. A long-running query blocks DDL until it commits.</li>
    </ul>
    <p style="color:var(--ink-dim);font-style:italic">Row locks and page latches occasionally cooperate: separate subsystems — one trx can hold a row lock on a record for thousands of MTRs apart and release the page covering that record. MDL is a third layer that sits above both.</p>

    <h3 style="margin-top:32px">Row Locks</h3>
    <p>A row lock is placed on a single (index, heap_no) entry, optionally with flag bits that shape what the lock covers. InnoDB combines these bit flags to express record-only, gap-only, next-key, and insert-intention locks.</p>
    <p>Pick a query below and watch the locks light up on the leaf page.</p>
    <div class="controls">
      <button class="btn primary" data-act="q1">SELECT … WHERE id = 20 FOR UPDATE</button>
      <button class="btn"          data-act="q2">SELECT … WHERE id BETWEEN 15 AND 30 FOR UPDATE</button>
      <button class="btn"          data-act="q3">INSERT INTO t VALUES (25, …) <span class="kbd">concurrent trx</span></button>
      <button class="btn"          data-act="q4">SELECT … WHERE id = 40 FOR UPDATE</button>
      <button class="btn"          data-act="reset">↺ Reset</button>
    </div>
    <div class="viz-container" style="padding:24px">
      <svg id="lk-svg" viewBox="0 0 1200 320" style="width:100%;height:auto"></svg>
    </div>
    <div class="chips">
      <span class="chip"><span class="sw" style="background:var(--orange)"></span>X lock on RECORD (filled box)</span>
      <span class="chip"><span class="sw" style="background:var(--blue)"></span>X lock on GAP before record</span>
      <span class="chip"><span class="sw" style="background:var(--purple)"></span>LOCK_INSERT_INTENTION (II) on gap</span>
    </div>
    <div class="inspector" id="lk-log">Pick a query above.</div>
    <p class="ref"><code>lock_rec_set_nth_bit (record-only)</code> — a unique-key equality search under READ-COMMITTED takes just the record lock as <code>X</code>, not the gap around it. Another trx can still INSERT just ahead or just behind it without blocking.</p>
  `;

  const PAGE = ['INFIMUM', '10', '15', '20', '25', '30', '35', '40', 'SUPREMUM'];
  let locks = [];

  function render() {
    const svg = d3.select('#lk-svg'); svg.selectAll('*').remove(); installArrowDefs(svg);
    svg.append('rect').attr('x', 16).attr('y', 16).attr('width', 1168).attr('height', 280).attr('rx', 8)
       .attr('fill', 'none').attr('stroke', 'var(--border)').attr('stroke-width', 1.5);
    svg.append('text').attr('x', 28).attr('y', 38).attr('class', 'lbl-mono-dim').text('LEAF PAGE · CLUSTER INDEX ON ID');

    const cellW = 120, cellH = 80, x0 = 28, y = 130;
    PAGE.forEach((k, i) => {
      const x = x0 + i * cellW;
      const gapLock = locks.find(l => l.idx === i && (l.kind === 'X-gap' || l.kind === 'II'));
      if (gapLock) {
        const c = gapLock.kind === 'II' ? 'var(--purple)' : 'var(--blue)';
        svg.append('rect').attr('x', x - 6).attr('y', y).attr('width', 12).attr('height', cellH).attr('rx', 2)
           .attr('fill', c).attr('opacity', 0.45).attr('stroke', c);
        if (gapLock.kind === 'II') {
          svg.append('text').attr('x', x).attr('y', y - 6).attr('text-anchor', 'middle')
             .attr('class', 'lbl-mono').attr('fill', c).text('II');
        }
      }
      const recLock = locks.find(l => l.idx === i && l.kind === 'X-rec');
      const fill   = recLock ? 'rgba(255,154,74,.55)' : 'var(--panel-2)';
      const stroke = recLock ? 'var(--orange)'        : 'var(--border-2)';
      svg.append('rect').attr('x', x + 8).attr('y', y).attr('width', cellW - 16).attr('height', cellH).attr('rx', 5)
         .attr('fill', fill).attr('stroke', stroke).attr('stroke-width', recLock ? 2 : 1);
      svg.append('text').attr('x', x + cellW / 2).attr('y', y + cellH / 2 + 6).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('fill', recLock ? 'var(--bg)' : 'var(--ink)').attr('font-weight', 600).text(k);
    });
  }

  function clearLocks() { locks = []; }
  section.querySelector('[data-act="q1"]').addEventListener('click', () => {
    clearLocks();
    locks.push({ idx: PAGE.indexOf('20'), kind: 'X-rec' });
    d3.select('#lk-log').html('SELECT … WHERE id=20 FOR UPDATE under READ-COMMITTED on a unique index → just a record-only X lock on the row.');
    render();
  });
  section.querySelector('[data-act="q2"]').addEventListener('click', () => {
    clearLocks();
    [PAGE.indexOf('15'), PAGE.indexOf('20'), PAGE.indexOf('25'), PAGE.indexOf('30')].forEach(i => {
      locks.push({ idx: i, kind: 'X-rec' });
      locks.push({ idx: i, kind: 'X-gap' });
    });
    locks.push({ idx: PAGE.indexOf('35'), kind: 'X-gap' });
    d3.select('#lk-log').html('BETWEEN 15 AND 30 FOR UPDATE → next-key locks (record + gap before) for every record in the range, plus the trailing gap to prevent inserts at the boundary.');
    render();
  });
  section.querySelector('[data-act="q3"]').addEventListener('click', () => {
    clearLocks();
    locks.push({ idx: PAGE.indexOf('25'), kind: 'II' });
    d3.select('#lk-log').html('INSERT (25, …) takes a <code>LOCK_INSERT_INTENTION</code> on the gap before the next existing record. If a concurrent gap lock already covers this gap, this II waits.');
    render();
  });
  section.querySelector('[data-act="q4"]').addEventListener('click', () => {
    clearLocks();
    locks.push({ idx: PAGE.indexOf('40'), kind: 'X-rec' });
    locks.push({ idx: PAGE.indexOf('40'), kind: 'X-gap' });
    d3.select('#lk-log').html('SELECT … WHERE id=40 FOR UPDATE under REPEATABLE READ → next-key lock (record + gap-before).');
    render();
  });
  section.querySelector('[data-act="reset"]').addEventListener('click', () => { clearLocks(); d3.select('#lk-log').html('— reset —'); render(); });

  render();
})();
