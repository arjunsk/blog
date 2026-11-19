/* redolog.js — ⑨ Redo Log: log buffer / fsync at COMMIT, doublewrite */
(function () {
  const section = document.getElementById('redolog');
  section.innerHTML = `
    <h2><span class="no">⑩</span>Redo Log</h2>
    <p class="lead">The redo log is how InnoDB survives crashes. Every page change becomes a small <em>physiological</em> record: "at page P, offset O, write these bytes". Writes are buffered in memory and fsynced to disk at <code>COMMIT</code>. On crash, recovery replays redo from the last checkpoint forward to rebuild the post-crash state.</p>

    <h3>What a redo log record stores</h3>
    <div class="inspector" style="font-family:'JetBrains Mono',monospace">
      <b>REDO log record</b> · <span class="dim">Crash recovery (replay page changes)</span>
      <table style="width:100%;margin-top:8px;font-size:12px;border-collapse:collapse">
        <tr><td><code>type</code></td><td class="dim">MLOG_REC_INSERT / UPDATE_IN_PLACE / …</td></tr>
        <tr><td><code>space + page</code></td><td class="dim">which page the change targets</td></tr>
        <tr><td><code>page offset</code></td><td class="dim">where on the page to apply</td></tr>
        <tr><td><code>info bits</code></td><td class="dim">flag whether extra info follows</td></tr>
        <tr><td><code>changed bytes</code></td><td class="dim">the new bytes (not the old)</td></tr>
      </table>
      <p style="margin-top:14px;color:var(--ink-dim)">REDO is physiological — the record identifies a page and the bytes to reapply at a specific offset. Replay is idempotent (guarded by each page's <code>page_lsn</code>). Redo is append-only and circular: once a checkpoint advances past it, the space can be reused.</p>
    </div>

    <h3 style="margin-top:36px">How we log redo</h3>
    <p>Walk through a small transaction and watch each statement append its own redo record to the buffer. The transaction's state (<code>TRX_UNDO_ACTIVE → PREPARED → TO_PURGE</code>) lives in the undo log header, and each state change is itself a redo-logged page write. At XA <code>PREPARE</code> and <code>COMMIT</code> the buffer is fsynced — so after a crash, redo replay rebuilds the undo header, and recovery reads the final state byte to decide: resurrect &amp; roll back, resurrect &amp; wait for XA, or clean up a committed trx.</p>
    <div class="controls">
      <button class="btn primary" data-act="rl-begin">BEGIN</button>
      <button class="btn" data-act="rl-insert">INSERT</button>
      <button class="btn" data-act="rl-update">UPDATE</button>
      <button class="btn" data-act="rl-prepare">XA PREPARE</button>
      <button class="btn" data-act="rl-commit">COMMIT</button>
      <button class="btn" data-act="rl-reset">↺ Reset</button>
    </div>
    <div class="viz-container" style="padding:24px">
      <svg id="rl-svg" viewBox="0 0 1300 460" style="width:100%;height:auto"></svg>
    </div>
    <div class="inspector" id="rl-log">Press BEGIN to start a transaction.</div>
  `;

  // ===== Redo buffer trace =====
  // Strict phase progression so buttons can't run away after one trx is done.
  // Phase ladder: idle → begun → inserted → (updated*) → (prepared) → committed
  let s;
  function reset() { s = { records: [], lsn: 100, undoState: null, timeline: [], phase: 'idle' }; }
  reset();

  function addRec(type, payload) { s.records.push({ lsn: s.lsn, type, payload, onDisk: false }); s.lsn += 10; }
  function evt(stage, body) { s.timeline.push({ stage, body }); }
  function canDo(action) {
    const p = s.phase;
    switch (action) {
      case 'begin':   return p === 'idle';
      case 'insert':  return p === 'begun';
      case 'update':  return p === 'inserted' || p === 'updated';
      case 'prepare': return p === 'inserted' || p === 'updated';
      case 'commit':  return p === 'inserted' || p === 'updated' || p === 'prepared';
    }
    return false;
  }
  function updateBtns() {
    [['rl-begin','begin'],['rl-insert','insert'],['rl-update','update'],['rl-prepare','prepare'],['rl-commit','commit']].forEach(([act, kind]) => {
      const b = section.querySelector(`[data-act="${act}"]`);
      if (b) b.disabled = !canDo(kind);
    });
  }

  section.querySelector('[data-act="rl-begin"]').addEventListener('click', () => {
    if (!canDo('begin')) return;
    s.undoState = 'TRX_UNDO_ACTIVE';
    addRec('MLOG_UNDO_HDR_CREATE', 'TRX=tx_100');
    evt('BEGIN', '—'); s.phase = 'begun';
    d3.select('#rl-log').html('BEGIN: undo header redo-logged. State = <code>TRX_UNDO_ACTIVE</code>. Now click <b>INSERT</b>.');
    renderRl(); updateBtns();
  });
  section.querySelector('[data-act="rl-insert"]').addEventListener('click', () => {
    if (!canDo('insert')) return;
    addRec('MLOG_REC_INSERT', 'page+offset · new bytes');
    evt('INSERT', 'MLOG_REC_INSERT'); s.phase = 'inserted';
    d3.select('#rl-log').html('INSERT: row written. Redo record appended to the buffer (still in RAM). Now you can <b>UPDATE</b> (one or more times) or jump straight to <b>XA PREPARE</b> / <b>COMMIT</b>.');
    renderRl(); updateBtns();
  });
  section.querySelector('[data-act="rl-update"]').addEventListener('click', () => {
    if (!canDo('update')) return;
    addRec('MLOG_REC_UPDATE_IN_PLACE', 'name_offset · new bytes');
    evt('UPDATE', 'MLOG_REC_UPD_IN_PLACE'); s.phase = 'updated';
    d3.select('#rl-log').html('UPDATE: in-place page rewrite. Another redo record appended. Click again to add more, or proceed to <b>XA PREPARE</b> / <b>COMMIT</b>.');
    renderRl(); updateBtns();
  });
  section.querySelector('[data-act="rl-prepare"]').addEventListener('click', () => {
    if (!canDo('prepare')) return;
    s.undoState = 'TRX_UNDO_PREPARED';
    addRec('MLOG_REC_UPDATE_BYTES', 'undo header → PREPARED');
    s.records.forEach(r => r.onDisk = true);
    evt('XA PREPARE', 'header → PREPARED'); s.phase = 'prepared';
    d3.select('#rl-log').html('XA PREPARE: undo header byte rewritten to <code>TRX_UNDO_PREPARED</code>. Buffer fsynced. After a crash this trx is resurrected and waits for XA.');
    renderRl(); updateBtns();
  });
  section.querySelector('[data-act="rl-commit"]').addEventListener('click', () => {
    if (!canDo('commit')) return;
    s.undoState = 'TRX_UNDO_TO_PURGE';
    addRec('MLOG_REC_UPDATE_BYTES', 'undo header → TO_PURGE');
    s.records.forEach(r => r.onDisk = true);
    evt('COMMIT', 'header → TO_PURGE'); s.phase = 'committed';
    d3.select('#rl-log').html('COMMIT: state byte flipped to <code>TRX_UNDO_TO_PURGE</code>; entire buffer fsynced. The trx is now durable. <b>Click ↺ Reset to start over</b>.');
    renderRl(); updateBtns();
  });
  section.querySelector('[data-act="rl-reset"]').addEventListener('click', () => { reset(); d3.select('#rl-log').html('— reset —'); renderRl(); updateBtns(); });

  function renderRl() {
    const svg = d3.select('#rl-svg'); svg.selectAll('*').remove(); installArrowDefs(svg);

    // log buffer
    svg.append('rect').attr('x', 16).attr('y', 16).attr('width', 1268).attr('height', 130).attr('rx', 8)
       .attr('fill', 'none').attr('stroke', 'var(--border)').attr('stroke-width', 1.5);
    svg.append('text').attr('x', 28).attr('y', 38).attr('class', 'lbl-mono-dim').text('REDO LOG BUFFER (RAM) · APPENDED BY EACH PAGE MUTATION, FSYNCED AT COMMIT');
    svg.append('text').attr('x', 1264).attr('y', 38).attr('text-anchor', 'end').attr('class', 'lbl-mono-dim')
       .text(`current LSN: ${s.lsn} · buffered: ${s.records.filter(r => !r.onDisk).length} · on disk: ${s.records.filter(r => r.onDisk).length}`);
    s.records.slice(-5).forEach((r, i) => {
      const x = 28 + i * 250, y = 60;
      const c = r.onDisk ? 'var(--ok)' : 'var(--orange)';
      svg.append('rect').attr('x', x).attr('y', y).attr('width', 240).attr('height', 70).attr('rx', 5)
         .attr('fill', 'var(--panel-2)').attr('stroke', c);
      svg.append('text').attr('x', x + 10).attr('y', y + 18).attr('class', 'lbl-mono-dim').text(`#${s.records.indexOf(r) + 1} · LSN ${r.lsn}`);
      svg.append('text').attr('x', x + 10).attr('y', y + 38).attr('class', 'lbl-mono').attr('fill', 'var(--orange)').text(r.type);
      svg.append('text').attr('x', x + 10).attr('y', y + 56).attr('class', 'lbl-mono-dim').attr('fill', c).text(`· ${r.onDisk ? 'on disk' : 'in buffer'}`);
    });

    // trx timeline
    svg.append('text').attr('x', 28).attr('y', 178).attr('class', 'lbl-mono-dim').text('TRX TIMELINE');
    const stages = ['BEGIN', 'INSERT', 'UPDATE', 'XA PREPARE', 'COMMIT'];
    stages.forEach((st, i) => {
      const x = 28 + i * 240, y = 200;
      const done = s.timeline.some(t => t.stage === st);
      svg.append('rect').attr('x', x).attr('y', y).attr('width', 220).attr('height', 80).attr('rx', 6)
         .attr('fill', 'var(--panel-2)').attr('stroke', done ? 'var(--accent)' : 'var(--border-2)');
      svg.append('text').attr('x', x + 12).attr('y', y + 24).attr('class', 'lbl-mono-dim').attr('fill', done ? 'var(--accent)' : 'var(--ink-dim)').text(st);
      const t = s.timeline.find(t => t.stage === st);
      if (t) svg.append('text').attr('x', x + 12).attr('y', y + 50).attr('class', 'lbl-mono-dim').text(t.body);
    });

    svg.append('text').attr('x', 28).attr('y', 318).attr('class', 'lbl-mono-dim').text('IF WE CRASH NOW · RECOVERY READS TRX_UNDO_STATE FROM THE UNDO HEADER:');
    svg.append('rect').attr('x', 690).attr('y', 300).attr('width', 220).attr('height', 32).attr('rx', 4)
       .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--accent)');
    svg.append('text').attr('x', 800).attr('y', 320).attr('text-anchor', 'middle').attr('class', 'lbl-mono').attr('fill', 'var(--accent)').text(s.undoState || '— ');
    const hint = s.undoState === 'TRX_UNDO_TO_PURGE' ? '— tx_100 is committed · clean up only'
              : s.undoState === 'TRX_UNDO_PREPARED'  ? '— resurrect & wait for XA'
              : s.undoState === 'TRX_UNDO_ACTIVE'    ? '— resurrect & rollback' : '—';
    svg.append('text').attr('x', 920).attr('y', 320).attr('class', 'lbl-mono-dim').text(hint);

    // disk panel
    svg.append('rect').attr('x', 16).attr('y', 360).attr('width', 1268).attr('height', 56).attr('rx', 6)
       .attr('fill', 'none').attr('stroke', 'var(--ok)');
    svg.append('text').attr('x', 28).attr('y', 384).attr('class', 'lbl-mono-dim').text('REDO LOG FILE (DISK · FSYNCED)');
    svg.append('text').attr('x', 28).attr('y', 402).attr('class', 'lbl-mono').attr('fill', 'var(--ok)')
       .text(s.records.filter(r => r.onDisk).map(r => `LSN ${r.lsn}`).join('  ') || '(empty)');
  }
  renderRl();

})();
