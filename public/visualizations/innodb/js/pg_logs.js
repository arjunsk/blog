/* pg_logs.js — ㉕ Redo Log vs WAL + CLOG · two engines, two log strategies
   The decisive contrast:
     · InnoDB has ONE log: REDO. It carries physical page changes AND commit
       markers. Per-trx state ("is tx_500 still active?") lives inside the
       UNDO LOG HEADER (TRX_UNDO_STATE: ACTIVE / TO_PURGE / etc.). Visibility
       checks at read time are PURE numeric comparisons — no extra I/O to ask
       "did this trx commit?"
     · Postgres has TWO logs: WAL (physical change records) and CLOG
       (pg_xact, a 2-bit-per-xid commit-status bitmap). At commit time, WAL
       gets the COMMIT record AND the CLOG bit flips. Every visibility check
       on a row reads CLOG[xmin] to ask "did this xid commit?" — that's an
       extra structure to maintain, and an extra lookup per tuple.

   The 5-step walk: BEGIN T1 → INSERT → COMMIT → Reader opens → Reader checks.
*/
(function () {
  const section = document.getElementById('pg-logs');
  if (!section) return;

  section.innerHTML = `
    <h2><span class="no">㉕</span>Redo Log vs WAL + CLOG · two engines, two log strategies</h2>
    <p class="lead"><em>InnoDB</em> has <b>one</b> log: redo. The same log carries page changes and commit markers, and per-trx state ("is tx_500 still running?") lives inside the undo log header. Visibility checks are pure numeric comparisons. <em>Postgres</em> has <b>two</b> logs: WAL (the redo log) <em>plus</em> CLOG, a separate per-xid commit-status bitmap. Every visibility check reads CLOG to ask "did this xid commit?" Walk through 5 steps and watch the difference.</p>

    <div class="controls">
      <button class="btn primary" data-act="pglg-next">▶ Next step</button>
      <button class="btn"          data-act="pglg-reset">↺ Reset</button>
    </div>

    <div class="viz-container" style="padding:24px">
      <svg id="pglg-svg" viewBox="0 0 1400 820" style="width:100%;height:auto"></svg>
    </div>

    <div class="inspector" id="pglg-log">Click <b>▶ Next step</b> to begin the walk.</div>
  `;

  // ===== State =====
  // Each step accumulates state on both sides. The render functions read
  // these fields and highlight what changed at the current step.
  const STEP_LABELS = [
    'idle',
    'BEGIN T1 · trx_id / xid = 500',
    'T1 INSERT row',
    'T1 COMMIT',
    'Reader T2 opens snapshot · id 510',
    'T2 reads T1\'s row → visibility check'
  ];
  let st;
  function reset() {
    st = {
      step: 0,
      // InnoDB
      iUndoState:    null,    // null | 'ACTIVE' | 'TO_PURGE'
      iRedoBuf:      [],
      iRedoFile:     [],
      iReader:       null,    // { id, m_up, m_low, m_ids }
      iReaderProbe:  false,
      // Postgres
      pProcArray:    [],
      pClog:         {},      // xid -> '00' (running) | '01' (committed)
      pWalBuf:       [],
      pWalFile:      [],
      pReader:       null,    // { id, xmin, xmax, xip }
      pReaderProbe:  false,
      pClogProbe:    null     // xid being looked up by reader
    };
  }
  reset();

  function nextStep() {
    if (st.step >= 5) return;
    st.step++;
    apply(st.step);
  }

  function apply(s) {
    if (s === 1) {
      // BEGIN T1 (id=500). InnoDB allocates an undo header in ACTIVE state.
      // Postgres adds the xid to procarray; CLOG bits default to 00.
      st.iUndoState = 'ACTIVE';
      st.pProcArray = [500];
      st.pClog = { 500: '00' };
    } else if (s === 2) {
      // T1 INSERT — both engines append a change record to their write buffer.
      st.iRedoBuf  = [{ lsn: 1000, type: 'MLOG_REC_INSERT' }];
      st.pWalBuf   = [{ lsn: 1000, type: 'HEAP_INSERT'    }];
    } else if (s === 3) {
      // T1 COMMIT — append commit record, fsync, update trx state structure.
      st.iRedoBuf = [
        { lsn: 1000, type: 'MLOG_REC_INSERT' },
        { lsn: 1010, type: 'MLOG_TRX_COMMIT' }
      ];
      st.iRedoFile = [...st.iRedoBuf];
      st.iUndoState = 'TO_PURGE';
      st.pWalBuf = [
        { lsn: 1000, type: 'HEAP_INSERT' },
        { lsn: 1010, type: 'XACT_COMMIT' }
      ];
      st.pWalFile = [...st.pWalBuf];
      st.pClog[500] = '01';
      st.pProcArray = [];
    } else if (s === 4) {
      // Reader T2 opens a snapshot. InnoDB constructs a ReadView; Postgres a
      // GetSnapshotData snapshot. Both record the active-trx set.
      st.iReader = { id: 510, m_up: 511, m_low: 511, m_ids: [] };
      st.pProcArray = [510];
      st.pClog[510] = '00';
      st.pReader = { id: 510, xmin: 510, xmax: 511, xip: [] };
    } else if (s === 5) {
      // Reader probes T1's row. Show the visibility-check path differing.
      st.iReaderProbe = true;
      st.pReaderProbe = true;
      st.pClogProbe   = 500;
    }
  }

  // ===== Render =====
  function render() {
    const svg = d3.select('#pglg-svg');
    svg.selectAll('*').remove();
    drawStepRibbon(svg);
    drawInnoDB(svg, 24, 76, 660, 720);
    drawPostgres(svg, 716, 76, 660, 720);
    updateLog();
  }

  // ----- Step ribbon at the top -----
  function drawStepRibbon(svg) {
    svg.append('rect').attr('x', 24).attr('y', 16).attr('width', 1352).attr('height', 44).attr('rx', 6)
       .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--accent)').attr('stroke-width', 1.2);
    // Numbered dots
    const dotR = 14, gap = 100;
    const totalW = 5 * (2 * dotR) + 4 * gap;
    const startX = 24 + (1352 - totalW) / 2 + dotR;
    for (let i = 1; i <= 5; i++) {
      const cx = startX + (i - 1) * (2 * dotR + gap);
      const reached = st.step >= i;
      const cur = st.step === i;
      svg.append('circle').attr('cx', cx).attr('cy', 38).attr('r', dotR)
         .attr('fill', reached ? 'var(--accent)' : 'var(--bg-2)')
         .attr('stroke', cur ? 'var(--ok)' : 'var(--border-2)').attr('stroke-width', cur ? 2 : 1);
      svg.append('text').attr('x', cx).attr('y', 43).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 12).attr('font-weight', 700)
         .style('fill', reached ? '#0a0a0a' : 'var(--ink-dim)').text(String(i));
      if (i < 5) {
        svg.append('line').attr('x1', cx + dotR).attr('y1', 38)
           .attr('x2', cx + dotR + gap).attr('y2', 38)
           .attr('stroke', reached && st.step >= i + 1 ? 'var(--accent)' : 'var(--border-2)').attr('stroke-width', 2);
      }
    }
  }

  function panelBox(svg, x, y, w, h, color, title) {
    svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', h).attr('rx', 8)
       .attr('fill', 'var(--panel-2)').attr('stroke', color).attr('stroke-width', 1.4);
    svg.append('text').attr('x', x + 14).attr('y', y + 22).attr('class', 'lbl-mono')
       .attr('font-size', 13).attr('font-weight', 600).style('fill', color).text(title);
  }

  // Section header inside a panel
  function sectionHeader(svg, x, y, w, label, sub, color) {
    svg.append('rect').attr('x', x).attr('y', y).attr('width', 4).attr('height', 24)
       .attr('fill', color);
    svg.append('text').attr('x', x + 14).attr('y', y + 16).attr('class', 'lbl-mono')
       .attr('font-size', 12).attr('font-weight', 700).style('fill', color).text(label);
    if (sub) {
      svg.append('text').attr('x', x + w).attr('y', y + 16).attr('text-anchor', 'end')
         .attr('class', 'lbl-mono-dim').attr('font-size', 10).text(sub);
    }
  }

  // A small "card" for a log record (LSN + type)
  function logRecCard(svg, x, y, w, h, rec, isLive) {
    const stroke = isLive ? 'var(--orange)' : 'var(--ink-dim)';
    svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', h).attr('rx', 4)
       .attr('fill', 'var(--panel)').attr('stroke', stroke).attr('stroke-width', 1.2);
    svg.append('text').attr('x', x + 8).attr('y', y + 16).attr('class', 'lbl-mono-dim').attr('font-size', 9).text('LSN');
    svg.append('text').attr('x', x + w - 8).attr('y', y + 16).attr('text-anchor', 'end')
       .attr('class', 'lbl-mono').attr('font-size', 11).attr('font-weight', 600)
       .style('fill', isLive ? 'var(--ink)' : 'var(--ink-dim)').text(String(rec.lsn));
    svg.append('text').attr('x', x + w / 2).attr('y', y + h - 10).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono').attr('font-size', 10)
       .style('fill', isLive ? stroke : 'var(--ink-dim)').text(rec.type);
  }

  // Drop-shadow callout banner for "no CLOG needed" / "extra structure"
  function callout(svg, x, y, w, h, color, lines) {
    svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', h).attr('rx', 6)
       .attr('fill', 'var(--bg-2)').attr('stroke', 'var(--border-2)');
    svg.append('rect').attr('x', x).attr('y', y).attr('width', 4).attr('height', h).attr('fill', color);
    lines.forEach((ln, i) => {
      svg.append('text').attr('x', x + 16).attr('y', y + 22 + i * 18).attr('class', 'lbl-mono')
         .attr('font-size', 11).style('fill', 'var(--ink-2)').text(ln);
    });
  }

  // ========== InnoDB ==========
  function drawInnoDB(svg, x, y, w, h) {
    panelBox(svg, x, y, w, h, 'var(--accent)', 'InnoDB · ONE log: redo (changes + commit markers)');

    const inL = x + 16, inR = x + w - 16, inW = inR - inL;

    // ----- Section 1: REDO LOG -----
    let curY = y + 50;
    sectionHeader(svg, inL, curY, inW, 'REDO LOG  ·  buffer → fsync → file', 'physical changes + commit markers', 'var(--orange)');
    curY += 32;
    drawWriteAheadLog(svg, inL, curY, inW, 'redo', st.iRedoBuf, st.iRedoFile);
    curY += 110;

    // ----- Section 2: TRX STATE in undo header -----
    curY += 14;
    sectionHeader(svg, inL, curY, inW, 'TRX STATE  ·  inside undo log header', 'no separate bitmap', 'var(--orange)');
    curY += 32;
    drawUndoHeader(svg, inL, curY, inW);
    curY += 100;

    // ----- Section 3: Reader visibility -----
    curY += 16;
    sectionHeader(svg, inL, curY, inW, 'READER VISIBILITY  ·  numeric compare with ReadView', 'no commit lookup', 'var(--orange)');
    curY += 32;
    drawIReader(svg, inL, curY, inW);
    curY += 130;

    // ----- Footer summary -----
    curY += 14;
    callout(svg, inL, curY, inW, 56, 'var(--accent)', [
      '✓ ONE log to fsync at commit  ·  ✓ trx state co-located with undo records',
      '✓ Visibility check is numeric — no extra I/O to ask "did it commit?"'
    ]);
  }

  // ========== Postgres ==========
  function drawPostgres(svg, x, y, w, h) {
    panelBox(svg, x, y, w, h, '#5b9cff', 'Postgres · TWO logs: WAL (changes) + CLOG (status)');

    const inL = x + 16, inR = x + w - 16, inW = inR - inL;

    // ----- Section 1: WAL -----
    let curY = y + 50;
    sectionHeader(svg, inL, curY, inW, 'WAL  ·  buffer → fsync → file', 'physical+logical changes (incl. XACT_COMMIT)', '#5b9cff');
    curY += 32;
    drawWriteAheadLog(svg, inL, curY, inW, 'wal', st.pWalBuf, st.pWalFile);
    curY += 110;

    // ----- Section 2: CLOG -----
    curY += 14;
    sectionHeader(svg, inL, curY, inW, 'CLOG  ·  pg_xact  ·  2-bit commit status per xid', 'separate persistent bitmap', '#a072f3');
    curY += 32;
    drawClog(svg, inL, curY, inW);
    curY += 100;

    // ----- Section 3: Reader visibility -----
    curY += 16;
    sectionHeader(svg, inL, curY, inW, 'READER VISIBILITY  ·  CLOG lookup + snapshot check', 'extra I/O per tuple', '#5b9cff');
    curY += 32;
    drawPReader(svg, inL, curY, inW);
    curY += 130;

    // ----- Footer summary -----
    curY += 14;
    callout(svg, inL, curY, inW, 56, '#5b9cff', [
      '✗ TWO structures to keep coherent  ·  ✗ extra CLOG lookup per visibility check',
      '✓ CLOG is tiny (2 bits/xid) and SLRU-cached  ·  ✓ allows simple xid → status mapping'
    ]);
  }

  // ----- Shared: write-ahead log (buffer + file) with arrow when fsynced -----
  function drawWriteAheadLog(svg, x, y, w, kind, buf, file) {
    const halfW = (w - 60) / 2;
    const bufX  = x;
    const fileX = x + halfW + 60;
    const blockH = 80;
    const color = kind === 'redo' ? 'var(--orange)' : '#5b9cff';

    // Buffer (RAM)
    svg.append('rect').attr('x', bufX).attr('y', y).attr('width', halfW).attr('height', blockH).attr('rx', 6)
       .attr('fill', 'var(--panel)').attr('stroke', color).attr('stroke-width', 1.2);
    svg.append('text').attr('x', bufX + 12).attr('y', y + 16).attr('class', 'lbl-mono')
       .attr('font-size', 11).attr('font-weight', 600).style('fill', color).text('BUFFER (RAM)');
    drawRecordRow(svg, bufX + 12, y + 26, halfW - 24, blockH - 36, buf, true);

    // Arrow buffer → file (only when fsynced)
    if (file.length > 0) {
      const ax1 = bufX + halfW + 6, ax2 = fileX - 6;
      svg.append('line').attr('x1', ax1).attr('y1', y + blockH / 2).attr('x2', ax2 - 8).attr('y2', y + blockH / 2)
         .attr('stroke', 'var(--ok)').attr('stroke-width', 2);
      svg.append('path').attr('d', `M${ax2 - 10},${y + blockH / 2 - 6} L${ax2},${y + blockH / 2} L${ax2 - 10},${y + blockH / 2 + 6} Z`)
         .attr('fill', 'var(--ok)');
      svg.append('text').attr('x', (ax1 + ax2) / 2).attr('y', y + blockH / 2 - 6).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 9).attr('font-weight', 700).style('fill', 'var(--ok)').text('fsync');
    } else {
      // dim placeholder line
      const ax1 = bufX + halfW + 6, ax2 = fileX - 6;
      svg.append('line').attr('x1', ax1).attr('y1', y + blockH / 2).attr('x2', ax2).attr('y2', y + blockH / 2)
         .attr('stroke', 'var(--border-2)').attr('stroke-width', 1).attr('stroke-dasharray', '4 4');
    }

    // File (DISK)
    svg.append('rect').attr('x', fileX).attr('y', y).attr('width', halfW).attr('height', blockH).attr('rx', 6)
       .attr('fill', 'var(--panel)').attr('stroke', file.length ? 'var(--ok)' : 'var(--ink-dim)')
       .attr('stroke-width', 1.2).attr('stroke-dasharray', file.length ? null : '4 4');
    svg.append('text').attr('x', fileX + 12).attr('y', y + 16).attr('class', 'lbl-mono')
       .attr('font-size', 11).attr('font-weight', 600).style('fill', file.length ? 'var(--ok)' : 'var(--ink-dim)').text('FILE (DISK · fsynced)');
    drawRecordRow(svg, fileX + 12, y + 26, halfW - 24, blockH - 36, file, false);
  }

  function drawRecordRow(svg, x, y, w, h, recs, isLive) {
    if (recs.length === 0) {
      svg.append('text').attr('x', x + w / 2).attr('y', y + h / 2 + 4).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono-dim').attr('font-size', 10).text('— empty —');
      return;
    }
    const cardW = (w - (recs.length - 1) * 8) / recs.length;
    recs.forEach((r, i) => {
      const cx = x + i * (cardW + 8);
      logRecCard(svg, cx, y, cardW, h, r, isLive);
    });
  }

  // ----- InnoDB undo log header (TRX_UNDO_STATE) -----
  function drawUndoHeader(svg, x, y, w) {
    if (st.iUndoState === null) {
      svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', 80).attr('rx', 6)
         .attr('fill', 'transparent').attr('stroke', 'var(--border-2)').attr('stroke-dasharray', '4 4');
      svg.append('text').attr('x', x + w / 2).attr('y', y + 44).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono-dim').attr('font-size', 11).text('— no transaction yet —');
      return;
    }
    const stateColor = st.iUndoState === 'ACTIVE' ? 'var(--warn)' : 'var(--ok)';
    svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', 80).attr('rx', 6)
       .attr('fill', 'var(--panel)').attr('stroke', stateColor).attr('stroke-width', 1.4);
    svg.append('text').attr('x', x + 14).attr('y', y + 18).attr('class', 'lbl-mono')
       .attr('font-size', 11).attr('font-weight', 700).style('fill', stateColor).text('UNDO LOG HEADER · tx_500');
    // Three fields
    const fields = [
      ['TRX_UNDO_TRX_ID',  '500'],
      ['TRX_UNDO_TRX_NO',  st.iUndoState === 'TO_PURGE' ? '500' : '—'],
      ['TRX_UNDO_STATE',    st.iUndoState]
    ];
    const colW = (w - 28) / 3;
    fields.forEach((f, i) => {
      const cx = x + 14 + i * colW;
      svg.append('text').attr('x', cx).attr('y', y + 38).attr('class', 'lbl-mono-dim').attr('font-size', 9).text(f[0]);
      svg.append('text').attr('x', cx).attr('y', y + 60).attr('class', 'lbl-mono').attr('font-size', 14).attr('font-weight', 700)
         .style('fill', f[0] === 'TRX_UNDO_STATE' ? stateColor : 'var(--ink)').text(f[1]);
    });
  }

  // ----- Postgres CLOG bitmap -----
  function drawClog(svg, x, y, w) {
    // Row of cells, one per xid
    const xids = [498, 499, 500, 501, 502, 503];
    const cellW = (w - (xids.length - 1) * 6) / xids.length;
    const cellH = 80;
    xids.forEach((xid, i) => {
      const cx = x + i * (cellW + 6);
      const bits = (st.pClog[xid] !== undefined) ? st.pClog[xid] : (xid < 500 ? '01' : '00');
      const isOurs = xid === 500;
      const isProbed = st.pClogProbe === xid;
      const status = bits === '01' ? 'COMMITTED' : (bits === '10' ? 'ABORTED' : 'IN_PROGRESS');
      const fill   = bits === '01' ? '#a3e6a3' : (bits === '10' ? '#ff8c8c' : '#c4c4c4');
      const stroke = bits === '01' ? '#5fbf5f' : (bits === '10' ? '#d44'    : 'var(--ink-dim)');
      svg.append('rect').attr('x', cx).attr('y', y).attr('width', cellW).attr('height', cellH).attr('rx', 4)
         .attr('fill', fill).attr('stroke', isProbed ? '#a072f3' : stroke).attr('stroke-width', isProbed ? 2.5 : 1.2)
         .attr('opacity', 0.95);
      svg.append('text').attr('x', cx + cellW / 2).attr('y', y + 18).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono-dim').attr('font-size', 9).text('xid');
      svg.append('text').attr('x', cx + cellW / 2).attr('y', y + 36).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 13).attr('font-weight', 700).style('fill', '#0a0a0a').text(String(xid));
      svg.append('text').attr('x', cx + cellW / 2).attr('y', y + 54).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 13).attr('font-weight', 700).style('fill', '#0a0a0a').text(bits);
      svg.append('text').attr('x', cx + cellW / 2).attr('y', y + 70).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 9).style('fill', '#0a0a0a').text(status);
      if (isOurs && st.step >= 3 && st.step < 5) {
        svg.append('text').attr('x', cx + cellW / 2).attr('y', y - 6).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 10).attr('font-weight', 700).style('fill', '#a072f3').text('↑ flipped at COMMIT');
      }
      if (isProbed) {
        svg.append('text').attr('x', cx + cellW / 2).attr('y', y - 6).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 10).attr('font-weight', 700).style('fill', '#a072f3').text('↑ reader probes here');
      }
    });
  }

  // ----- InnoDB Reader (ReadView) panel -----
  function drawIReader(svg, x, y, w) {
    if (!st.iReader) {
      svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', 110).attr('rx', 6)
         .attr('fill', 'transparent').attr('stroke', 'var(--border-2)').attr('stroke-dasharray', '4 4');
      svg.append('text').attr('x', x + w / 2).attr('y', y + 60).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono-dim').attr('font-size', 11).text('— no reader yet —');
      return;
    }
    const r = st.iReader;
    svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', 110).attr('rx', 6)
       .attr('fill', 'var(--panel)').attr('stroke', 'var(--green)').attr('stroke-width', 1.4);
    svg.append('text').attr('x', x + 14).attr('y', y + 18).attr('class', 'lbl-mono')
       .attr('font-size', 11).attr('font-weight', 700).style('fill', 'var(--green)').text(`READVIEW · tx_${r.id}`);
    const fields = [
      ['m_creator', String(r.id)],
      ['m_up_limit_id', String(r.m_up)],
      ['m_low_limit_id', String(r.m_low)],
      ['m_ids', `[${r.m_ids.join(',')}]`]
    ];
    const colW = (w - 28) / 4;
    fields.forEach((f, i) => {
      const cx = x + 14 + i * colW;
      svg.append('text').attr('x', cx).attr('y', y + 36).attr('class', 'lbl-mono-dim').attr('font-size', 9).text(f[0]);
      svg.append('text').attr('x', cx).attr('y', y + 56).attr('class', 'lbl-mono').attr('font-size', 13).attr('font-weight', 700)
         .style('fill', 'var(--ink)').text(f[1]);
    });
    if (st.iReaderProbe) {
      svg.append('text').attr('x', x + w / 2).attr('y', y + 88).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', 'var(--ok)').attr('font-weight', 700)
         .text('row.trx_id = 500   ·   500 < m_low_limit_id (511) AND not in m_ids   →   ✓ visible');
      svg.append('text').attr('x', x + w / 2).attr('y', y + 102).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono-dim').attr('font-size', 10).text('(no commit-status lookup needed — pure numeric comparison)');
    }
  }

  // ----- Postgres Reader (Snapshot + CLOG probe) -----
  function drawPReader(svg, x, y, w) {
    if (!st.pReader) {
      svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', 110).attr('rx', 6)
         .attr('fill', 'transparent').attr('stroke', 'var(--border-2)').attr('stroke-dasharray', '4 4');
      svg.append('text').attr('x', x + w / 2).attr('y', y + 60).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono-dim').attr('font-size', 11).text('— no reader yet —');
      return;
    }
    const r = st.pReader;
    svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', 110).attr('rx', 6)
       .attr('fill', 'var(--panel)').attr('stroke', 'var(--green)').attr('stroke-width', 1.4);
    svg.append('text').attr('x', x + 14).attr('y', y + 18).attr('class', 'lbl-mono')
       .attr('font-size', 11).attr('font-weight', 700).style('fill', 'var(--green)').text(`SNAPSHOT · xid ${r.id}`);
    const fields = [
      ['xid (creator)', String(r.id)],
      ['xmin (oldest)', String(r.xmin)],
      ['xmax (next)',   String(r.xmax)],
      ['xip[]',         `[${r.xip.join(',')}]`]
    ];
    const colW = (w - 28) / 4;
    fields.forEach((f, i) => {
      const cx = x + 14 + i * colW;
      svg.append('text').attr('x', cx).attr('y', y + 36).attr('class', 'lbl-mono-dim').attr('font-size', 9).text(f[0]);
      svg.append('text').attr('x', cx).attr('y', y + 56).attr('class', 'lbl-mono').attr('font-size', 13).attr('font-weight', 700)
         .style('fill', 'var(--ink)').text(f[1]);
    });
    if (st.pReaderProbe) {
      svg.append('text').attr('x', x + w / 2).attr('y', y + 86).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', '#a072f3').attr('font-weight', 700)
         .text('row.xmin = 500   →   look up CLOG[500]   →   01 (COMMITTED)');
      svg.append('text').attr('x', x + w / 2).attr('y', y + 100).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', 'var(--ok)').attr('font-weight', 700)
         .text('500 < snapshot.xmin (510)   →   ✓ visible (with CLOG confirming COMMITTED)');
    }
  }

  // ----- Status line below the SVG -----
  function updateLog() {
    const el = document.getElementById('pglg-log');
    if (!el) return;
    const messages = [
      'Click <b>▶ Next step</b> to begin the walk.',
      '<b>Step 1 · BEGIN T1.</b> InnoDB allocates an <em>undo log header</em> with <code>TRX_UNDO_STATE = ACTIVE</code>. Postgres adds xid 500 to the <em>procarray</em>, and CLOG\'s default 2-bit value is <code>00</code> (IN_PROGRESS).',
      '<b>Step 2 · INSERT.</b> Both engines append a change record to their write-ahead-log buffer (in RAM): InnoDB writes <code>MLOG_REC_INSERT</code> at LSN 1000; Postgres writes <code>HEAP_INSERT</code> at LSN 1000. Nothing on disk yet.',
      '<b>Step 3 · COMMIT.</b> InnoDB appends <code>MLOG_TRX_COMMIT</code>, fsyncs the <em>same</em> redo log, and flips the undo header from <code>ACTIVE → TO_PURGE</code>. Postgres appends <code>XACT_COMMIT</code> to WAL, fsyncs, AND flips <code>CLOG[500]</code> from <code>00 → 01</code> (COMMITTED). One log vs two.',
      '<b>Step 4 · Reader opens snapshot.</b> InnoDB constructs a ReadView (m_low_limit_id = 511). Postgres takes a snapshot (xmin = 510, xmax = 511). Both record the active-trx set.',
      '<b>Step 5 · Visibility check.</b> InnoDB compares the row\'s trx_id (500) against the ReadView\'s numeric fields — no extra I/O. Postgres looks up <code>CLOG[500]</code> to confirm it\'s COMMITTED, then compares against the snapshot. That CLOG read is the cost Postgres pays per tuple.'
    ];
    el.innerHTML = messages[st.step];
  }

  // ===== Wire =====
  section.querySelector('[data-act="pglg-next"]').addEventListener('click', () => { nextStep(); render(); });
  section.querySelector('[data-act="pglg-reset"]').addEventListener('click', () => { reset(); render(); });

  render();
})();
