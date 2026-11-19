/* history.js — ⑦ Undo · Rollback Segment · History */
(function () {
  const section = document.getElementById('history');
  section.innerHTML = `
    <h2><span class="no">⑦</span>Undo · Rollback Segment · History</h2>
    <p class="lead">One unified view of how an undo record lives. Run through the lifecycle: start a transaction, write rows (undo appears in a specific rollback segment slot), commit (update-undo joins the global history list), open a ReadView, close it, and watch purge drain.</p>

    <h3>Interactive lifecycle</h3>
    <p style="font-size:13px;max-width:760px">Click the buttons below to drive the flow. The diagram shows exactly where each undo record lands, when the history list grows, and what purge can reclaim.</p>

    <div class="controls">
      <button class="btn primary" data-act="begin">BEGIN trx</button>
      <button class="btn" data-act="insert">INSERT row</button>
      <button class="btn" data-act="update">UPDATE row</button>
      <button class="btn" data-act="commit">COMMIT</button>
      <button class="btn" data-act="rv">▾ Open ReadView</button>
      <button class="btn" data-act="closerv">× Close oldest ReadView</button>
      <button class="btn" data-act="purge">↻ Purge cycle</button>
      <button class="btn" data-act="reset">↺ Reset</button>
    </div>

    <div class="viz-container" style="padding:24px">
      <svg id="hist-svg" viewBox="0 0 1200 540" style="width:100%;height:auto"></svg>
    </div>
    <div class="inspector" id="hist-log">Press BEGIN to start a transaction.</div>
    <p class="ref"><code>storage/innobase/trx/trx0rec.cc:trx_assign_rseg_durable</code> · <code>trx/trx0undo.cc:trx_undo_assign_undo</code> · <code>trx/trx0purge.cc</code></p>
  `;

  let s;
  function reset() {
    s = {
      currentTrx: null,
      txCounter: 99,
      rseg0Active: [],
      rseg0History: [],
      readviews: [],
      purgeCutoff: null,
      undoSeq: 1,
      rvSeq: 1
    };
  }
  reset();

  function log(html) { d3.select('#hist-log').html(html); }

  section.querySelector('[data-act="begin"]').addEventListener('click', () => {
    if (s.currentTrx) { log('Already in a trx — COMMIT first.'); return; }
    s.txCounter++;
    s.currentTrx = `tx_${s.txCounter}`;
    log(`BEGIN <code>${s.currentTrx}</code>: trx_id assigned. Rollback segment 0 picked (round-robin). No undo allocated yet — lazy.`);
    render();
  });
  section.querySelector('[data-act="insert"]').addEventListener('click', () => {
    if (!s.currentTrx) { log('BEGIN first.'); return; }
    s.rseg0Active.push({ kind: 'INSERT_UNDO', id: s.undoSeq++ });
    log(`INSERT into rseg 0: a fresh insert_undo segment is assigned. Records appended (re-find PK on rollback only). <code>discardAtCommit:true</code>.`);
    render();
  });
  section.querySelector('[data-act="update"]').addEventListener('click', () => {
    if (!s.currentTrx) { log('BEGIN first.'); return; }
    s.rseg0Active.push({ kind: 'UPDATE_UNDO', id: s.undoSeq++ });
    log(`UPDATE: appended <code>TRX_UNDO_UPD_EXIST_REC</code> #${s.undoSeq - 1} to ${s.currentTrx}'s update_undo log (rseg 0). This serves MVCC + rollback — kept until no ReadView needs it.`);
    render();
  });
  section.querySelector('[data-act="commit"]').addEventListener('click', () => {
    if (!s.currentTrx) { log('No trx to commit.'); return; }
    const ins = s.rseg0Active.filter(u => u.kind === 'INSERT_UNDO').length;
    const ups = s.rseg0Active.filter(u => u.kind === 'UPDATE_UNDO');
    if (ups.length) {
      s.rseg0History.unshift({ trx: s.currentTrx, trx_no: s.txCounter, undos: ups.map(u => u.id) });
    }
    log(`COMMIT <code>${s.currentTrx}</code>: trx_no=${s.txCounter}. insert_undo (${ins}) discarded. update_undo (${ups.length}) joined rseg 0 history list.`);
    s.rseg0Active = [];
    s.currentTrx = null;
    recomputeMarks();
    render();
  });
  section.querySelector('[data-act="rv"]').addEventListener('click', () => {
    // m_up_limit_id = smallest currently-active trx_id (real InnoDB rule):
    //   - in-flight trx → upLimit = its trx_id        (PINS that trx)
    //   - no trx active → upLimit = txCounter + 1     (sees everything committed → pins NOTHING)
    const upLimit = s.currentTrx ? s.txCounter : (s.txCounter + 1);
    const r = { name: `RV${s.rvSeq++}`, upLimit };
    s.readviews.push(r);
    s.purgeCutoff = Math.min(...s.readviews.map(x => x.upLimit));
    const pinsAny = s.rseg0History.some(h => h.trx_no >= s.purgeCutoff);
    log(`<code>${r.name}</code> opened with <code>m_up_limit_id = ${r.upLimit}</code>. ` +
        (pinsAny
          ? `Pins <code>trx_no &gt;= ${s.purgeCutoff}</code> on the history list — purge can't reclaim those.`
          : `Sees every committed trx (none have <code>trx_no &gt;= ${r.upLimit}</code>) → does NOT pin anything; purge can still run.`));
    recomputeMarks();
    render();
  });
  section.querySelector('[data-act="closerv"]').addEventListener('click', () => {
    if (!s.readviews.length) { log('No ReadView open.'); return; }
    const closed = s.readviews.shift();
    s.purgeCutoff = s.readviews.length ? Math.min(...s.readviews.map(x => x.upLimit)) : null;
    log(`<code>${closed.name}</code> closed. Purge cutoff is now ${s.readviews.length ? s.purgeCutoff : 'UNBOUNDED'}.`);
    recomputeMarks();
    render();
  });
  section.querySelector('[data-act="purge"]').addEventListener('click', () => {
    const before = s.rseg0History.length;
    s.rseg0History = s.rseg0History.filter(h => s.purgeCutoff != null && h.trx_no >= s.purgeCutoff);
    log(`Purge cycle: cutoff <code>trx_no &lt; ${s.purgeCutoff || '∞'}</code>. Reclaimed <b>${before - s.rseg0History.length}</b> history entries.`);
    recomputeMarks();
    render();
  });
  section.querySelector('[data-act="reset"]').addEventListener('click', () => { reset(); log('— reset —'); render(); });

  function recomputeMarks() {
    s.rseg0History.forEach(h => {
      h.willPurge = (s.purgeCutoff == null) || (h.trx_no < s.purgeCutoff);
    });
  }

  function panel(svg, x, y, w, h, title, sub) {
    svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', h).attr('rx', 8)
       .attr('fill', 'none').attr('stroke', 'var(--border)').attr('stroke-width', 1.5);
    svg.append('text').attr('x', x + 12).attr('y', y + 22).attr('class', 'lbl-mono-dim').text(title);
    if (sub) svg.append('text').attr('x', x + w - 12).attr('y', y + 22).attr('text-anchor', 'end').attr('class', 'lbl-mono-dim').text(sub);
  }

  function rsegPanel(svg, x, y, title, undos) {
    panel(svg, x, y, 386, 200, title, `ACTIVE SLOTS: ${undos.length ? 1 : 0}`);
    if (!undos.length) {
      svg.append('text').attr('x', x + 12).attr('y', y + 60).attr('class', 'lbl-mono-dim').text('(no active slots — waiting for BEGIN)');
      return;
    }
    svg.append('rect').attr('x', x + 12).attr('y', y + 44).attr('width', 360).attr('height', 140).attr('rx', 5)
       .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--accent)');
    svg.append('text').attr('x', x + 24).attr('y', y + 66).attr('class', 'lbl-mono-dim').text(`slot · ${s.currentTrx || 'tx_???'}`);
    let cy = y + 90;
    const ins = undos.filter(u => u.kind === 'INSERT_UNDO');
    const ups = undos.filter(u => u.kind === 'UPDATE_UNDO');
    // Color-code the two undo kinds so they're easy to tell apart at a glance:
    //   INSERT_UNDO → green  (short-lived; discarded at COMMIT)
    //   UPDATE_UNDO → blue   (lives on the history list for MVCC + rollback)
    const INS_COLOR = 'var(--green)';
    const UPD_COLOR = 'var(--blue)';
    if (ins.length) {
      svg.append('text').attr('x', x + 24).attr('y', cy).attr('class', 'lbl-mono').attr('fill', INS_COLOR).text('INSERT_UNDO');
      ins.forEach((u, i) => {
        svg.append('rect').attr('x', x + 150 + i * 38).attr('y', cy - 14).attr('width', 32).attr('height', 22).attr('rx', 4)
           .attr('fill', 'rgba(74,242,118,0.10)').attr('stroke', INS_COLOR);
        svg.append('text').attr('x', x + 166 + i * 38).attr('y', cy + 1).attr('text-anchor', 'middle').attr('class', 'lbl-mono').attr('fill', INS_COLOR).text(`#${u.id}`);
      });
      cy += 36;
    }
    if (ups.length) {
      svg.append('text').attr('x', x + 24).attr('y', cy).attr('class', 'lbl-mono').attr('fill', UPD_COLOR).text('UPDATE_UNDO');
      ups.forEach((u, i) => {
        svg.append('rect').attr('x', x + 150 + i * 38).attr('y', cy - 14).attr('width', 32).attr('height', 22).attr('rx', 4)
           .attr('fill', 'rgba(74,229,229,0.10)').attr('stroke', UPD_COLOR);
        svg.append('text').attr('x', x + 166 + i * 38).attr('y', cy + 1).attr('text-anchor', 'middle').attr('class', 'lbl-mono').attr('fill', UPD_COLOR).text(`#${u.id}`);
      });
    }
  }

  function historyPanel(svg, x, y, title, hist) {
    panel(svg, x, y, 564, 200, title, `ENTRIES: ${hist.length} · BY TRX_NO`);
    if (!hist.length) {
      svg.append('text').attr('x', x + 264).attr('y', y + 110).attr('class', 'lbl-mono-dim').text('(empty)');
      return;
    }
    hist.slice(0, 5).forEach((h, i) => {
      const cy = y + 50 + i * 30;
      svg.append('rect').attr('x', x + 14).attr('y', cy - 18).attr('width', 540).attr('height', 26).attr('rx', 4)
         .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--orange)');
      svg.append('text').attr('x', x + 22).attr('y', cy).attr('class', 'lbl-mono-dim').text(h.trx);
      svg.append('text').attr('x', x + 90).attr('y', cy).attr('class', 'lbl-mono').text('· #' + h.undos.join(', #'));
      if (h.willPurge) {
        svg.append('text').attr('x', x + 540).attr('y', cy).attr('text-anchor', 'end').attr('class', 'lbl-mono-dim').attr('fill', 'var(--err)').text('→ will purge');
      }
    });
  }

  function render() {
    const svg = d3.select('#hist-svg');
    svg.selectAll('*').remove();
    installArrowDefs(svg);

    // top bar
    panel(svg, 16, 16, 1168, 60, 'CURRENT TRANSACTION', null);
    svg.append('text').attr('x', 28).attr('y', 60).attr('class', 'lbl-mono')
       .text(s.currentTrx ? `${s.currentTrx} (RSEG 0 · ROUND-ROBIN)` : '(none — press BEGIN)');
    svg.append('text').attr('x', 480).attr('y', 38).attr('class', 'lbl-mono-dim').text('OPEN READVIEWS');
    svg.append('text').attr('x', 480).attr('y', 60).attr('class', 'lbl-mono')
       .text(s.readviews.length ? s.readviews.map(r => `${r.name} < ${r.upLimit}`).join('  ') : 'none');
    svg.append('text').attr('x', 880).attr('y', 38).attr('class', 'lbl-mono-dim').text('PURGE CUTOFF');
    svg.append('text').attr('x', 880).attr('y', 60).attr('class', 'lbl-mono')
       .text(s.readviews.length ? `trx_no < ${s.purgeCutoff} · BOUNDED BY OLDEST READVIEW` : 'NO READVIEW · UNBOUNDED');

    rsegPanel(svg, 16, 100, 'Rollback segment 0', s.rseg0Active);
    historyPanel(svg, 620, 100, 'History list — rseg 0', s.rseg0History);
    rsegPanel(svg, 16, 320, 'Rollback segment 1', []);
    historyPanel(svg, 620, 320, 'History list — rseg 1', []);

    // arrow rseg 0 → history
    svg.append('path').attr('d', 'M414,180 L620,180').attr('class', 'arrow active');
    svg.append('text').attr('x', 510).attr('y', 168).attr('text-anchor', 'middle').attr('class', 'lbl-mono-dim').text('COMMIT');
    svg.append('text').attr('x', 510).attr('y', 196).attr('text-anchor', 'middle').attr('class', 'lbl-mono-dim').text('UPDATE_UNDO →');
  }

  render();
})();
