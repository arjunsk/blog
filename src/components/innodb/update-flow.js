import { select } from 'd3-selection';
import { installArrowDefs } from './arrow-defs.js';

export function mountUpdate(section) {
  const figure = select(section);

  const NAME_CYCLE = ['alice', 'alicia', 'allie', 'al'];

  let state;
  function reset() {
    state = {
      phase: 'idle',
      trxId: 'tx_100',
      trxNo: null,
      row: null,
      undo: [],
      undoSeq: 1,
      undoHeader: null,
      redoBuf: [],
      lsn: 100,
      committed: false,
      lastHighlight: null
    };
  }
  reset();

  function log(html) { figure.select('[data-status]').html(html); }
  function nextLsn() { state.lsn += 10; return state.lsn; }
  function addRedo(type) {
    const r = { id: state.redoBuf.length + 1, lsn: nextLsn(), type, onDisk: false };
    state.redoBuf.push(r);
    return r;
  }

  // ---- handlers ----
  function begin() {
    state.phase = 'begin';
    log(`BEGIN <code>tx_100</code>: a transaction id is assigned. No undo yet — undo header is created lazily on the first row write.`);
    render();
  }
  function insert() {
    if (state.row) { log('Row already exists. Use UPDATE name.'); return; }
    if (!state.undoHeader) {
      state.undoHeader = { state: 'TRX_UNDO_ACTIVE', trxId: state.trxId };
      addRedo('MLOG_UNDO_HDR_CREATE · TRX=tx_100');
    }
    const u = { id: state.undoSeq++, type: 'INSERT_REC', oldName: null, oldTrx: null, oldRollPtr: null };
    state.undo.push(u);
    addRedo('MLOG_REC_INSERT · PAGE+OFFSET · NEW BYTES');
    state.row = { id: 42, nameIdx: 0, trx: state.trxId, rollPtr: u.id };
    state.phase = 'inserted';
    state.lastHighlight = 'row';
    log(`<b>INSERT (id=42, 'alice')</b>: first write of the trx, so the undo log header is created on an undo page (<code>MLOG_UNDO_HDR_CREATE</code>) — it stamps <code>TRX_UNDO_ACTIVE</code>. The insert-undo carries only the PK so rollback can find the row.`);
    render();
  }
  function update() {
    if (!state.row) { log('Nothing to update. Run INSERT first.'); return; }
    const oldNameIdx = state.row.nameIdx;
    const oldName    = NAME_CYCLE[oldNameIdx];
    const oldTrx     = state.row.trx;
    const oldRollPtr = state.row.rollPtr;
    const u = { id: state.undoSeq++, type: 'UPD_EXIST', oldName, oldTrx, oldRollPtr };
    state.undo.push(u);
    addRedo(`MLOG_REC_UPDATE_IN_PLACE · NAME='${NAME_CYCLE[(oldNameIdx + 1) % NAME_CYCLE.length]}'`);
    state.row.nameIdx = (oldNameIdx + 1) % NAME_CYCLE.length;
    state.row.rollPtr = u.id;
    state.phase = 'updated';
    state.lastHighlight = 'rollptr';
    log(`<b>UPDATE name = ${NAME_CYCLE[state.row.nameIdx]}</b>: row overwritten IN PLACE on the btree page. <code>UPDATE-undo #${u.id}</code> stores old name=<code>'${oldName}'</code>. <code>DB_ROLL_PTR</code> now points to undo #${u.id}.`);
    render();
  }
  function commit() {
    if (state.phase === 'idle' && !state.row) { log('Nothing to commit.'); return; }
    state.redoBuf.forEach(r => r.onDisk = true);
    state.committed = true;
    state.phase = 'committed';
    if (state.undoHeader) state.undoHeader.state = 'TRX_UNDO_TO_PURGE';
    state.trxNo = 100;
    log(`<code>COMMIT tx_100</code>: redo log buffer fsynced. <code>INSERT-undo</code> will be discarded; <code>UPDATE-undo</code> joins rseg 0's history list.`);
    render();
  }
  const actions = {
    begin,
    insert,
    update,
    commit,
    reset() {
      reset();
      log('— reset —');
      render();
    }
  };

  for (const [action, handler] of Object.entries(actions)) {
    section.querySelector(`[data-act="${action}"]`).addEventListener('click', () => {
      handler();
      updateBtns();
    });
  }

  // Enable / disable the action buttons so the user can only press what makes
  // sense at the current phase — avoids accumulating bogus state.
  function updateBtns() {
    const has  = (act, ok) => { const b = section.querySelector(`[data-act="${act}"]`); if (b) b.disabled = !ok; };
    const inFlight = !!state.row && !state.committed;
    has('begin',   state.phase === 'idle');
    has('insert',  state.phase === 'begin' && !state.row);
    has('update',  inFlight);
    has('commit',  inFlight);
    has('reset',   true);
  }

  // ===== drawing helpers =====
  const svg = () => figure.select('[data-diagram]');

  function panel(g, x, y, w, h, title, sub, stroke) {
    g.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', h).attr('rx', 8)
     .attr('fill', 'none').attr('stroke', stroke || 'var(--border)').attr('stroke-width', 1.5);
    g.append('text').attr('x', x + 14).attr('y', y + 22).attr('class', 'lbl-mono-dim').text(title);
    if (sub) g.append('text').attr('x', x + w - 14).attr('y', y + 22).attr('text-anchor', 'end').attr('class', 'lbl-mono-dim').text(sub);
  }

  // Geometry — kept as named constants so the arrow knows where it starts/ends.
  const GEOM = {
    bp:  { x: 16,  y: 16,  w: 580, h: 280 },
    rb:  { x: 612, y: 16,  w: 332, h: 200 },
    rf:  { x: 612, y: 232, w: 332, h: 64  },
    ut:  { x: 16,  y: 312, w: 928, h: 372 }
  };
  // Inside UNDO TABLESPACE
  const UT = {
    headerBox:  { x: 32,  y: 358, w: 380, h: 290 },
    recordsBox: { x: 432, y: 358, w: 496, h: 290 },
    // Auto-shrink card grid. Cards live in a single row centered in the
    // records box. As `total` grows the card width shrinks and the inter-card
    // gap shrinks; below `minCardW` the gap is set to 0 so cards touch.
    undoSlot: function (i, total) {
      const innerX = 446, innerY = 396, h = 144;
      const innerW = 468;
      const maxCardW = 220;
      // Pick a gap that scales down with count.
      let gap = total <= 2 ? 24 : total <= 4 ? 14 : total <= 6 ? 8 : 4;
      let cardW = (innerW - (total - 1) * gap) / Math.max(total, 1);
      if (cardW > maxCardW) { cardW = maxCardW; gap = total > 1 ? (innerW - total * cardW) / (total - 1) : 0; }
      const minCardW = 56;
      if (cardW < minCardW) {
        cardW = Math.max(40, (innerW - (total - 1) * 2) / total);  // last-resort tightening
        gap = 2;
      }
      const totalW = total * cardW + (total - 1) * gap;
      const startX = innerX + Math.max(0, (innerW - totalW) / 2);
      return { x: startX + i * (cardW + gap), y: innerY, w: cardW, h, gap };
    }
  };
  // Inside BUFFER POOL row of cells
  function bpCellBox(i) {
    const cellW = 132, cellH = 90, gap = 6;
    const startX = 32, y = 126;
    return { x: startX + i * (cellW + gap), y, w: cellW, h: cellH };
  }

  function render() {
    const s = svg(); s.selectAll('*').remove(); const arrows = installArrowDefs(s);

    // ===== ① BUFFER POOL =====
    panel(s, GEOM.bp.x, GEOM.bp.y, GEOM.bp.w, GEOM.bp.h, 'BUFFER POOL',
      'PAGE STATE: ' + (state.row ? 'DIRTY (NOT FLUSHED)' : 'EMPTY'));
    s.append('text').attr('x', GEOM.bp.x + 16).attr('y', GEOM.bp.y + 56).attr('class', 'lbl-mono-dim')
      .text('B+TREE LEAF PAGE · 1 ROW');
    if (state.row) {
      const cells = [
        { l:'ID',           v: state.row.id,                          c:'var(--orange)'  },
        { l:'NAME',         v: `'${NAME_CYCLE[state.row.nameIdx]}'`,  c:'var(--green)'   },
        { l:'DB_TRX_ID',    v: state.row.trx,                         c:'var(--purple)'  },
        { l:'DB_ROLL_PTR',  v: `→ undo #${state.row.rollPtr}`,        c:'var(--orange)', hi: state.lastHighlight === 'rollptr' }
      ];
      cells.forEach((c, i) => {
        const b = bpCellBox(i);
        s.append('rect').attr('x', b.x).attr('y', b.y).attr('width', b.w).attr('height', b.h).attr('rx', 6)
         .attr('fill', 'var(--panel-2)').attr('stroke', c.c).attr('stroke-width', c.hi ? 2.5 : 1.2);
        s.append('text').attr('x', b.x + b.w / 2).attr('y', b.y + 32).attr('text-anchor', 'middle')
         .attr('class', 'rcell-label').attr('fill', c.c).text(c.l);
        s.append('text').attr('x', b.x + b.w / 2).attr('y', b.y + 60).attr('text-anchor', 'middle')
         .attr('class', 'rcell-val').text(c.v);
      });
    } else {
      s.append('text').attr('x', GEOM.bp.x + 16).attr('y', GEOM.bp.y + 130).attr('class', 'lbl-mono-dim')
        .text('(no row yet — press INSERT)');
    }

    // ===== ② REDO LOG BUFFER =====
    panel(s, GEOM.rb.x, GEOM.rb.y, GEOM.rb.w, GEOM.rb.h, 'REDO LOG BUFFER (RAM)',
      `${state.redoBuf.length} RECORD(S)`);
    state.redoBuf.slice(-5).forEach((r, i) => {
      const y = GEOM.rb.y + 56 + i * 28;
      const c = r.onDisk ? 'var(--ok)' : 'var(--orange)';
      const idx = state.redoBuf.length - state.redoBuf.slice(-5).length + i + 1;
      s.append('rect').attr('x', GEOM.rb.x + 14).attr('y', y).attr('width', GEOM.rb.w - 28).attr('height', 22).attr('rx', 4)
       .attr('fill', 'var(--panel-2)').attr('stroke', c);
      s.append('text').attr('x', GEOM.rb.x + 22).attr('y', y + 15).attr('class', 'lbl-mono-dim')
       .attr('font-size', 10).text(`#${idx}`);
      s.append('text').attr('x', GEOM.rb.x + 50).attr('y', y + 15).attr('class', 'lbl-mono')
       .attr('font-size', 10).attr('fill', 'var(--accent)').text(r.type.split(' · ')[0]);
    });

    // ===== ③ REDO LOG FILE =====
    panel(s, GEOM.rf.x, GEOM.rf.y, GEOM.rf.w, GEOM.rf.h,
      state.committed
        ? `REDO LOG FILE · ${state.redoBuf.length} fsynced`
        : 'REDO LOG FILE · empty',
      null,
      state.committed ? 'var(--ok)' : 'var(--border)');
    {
      const bodyY = GEOM.rf.y + GEOM.rf.h - 12;
      s.append('text').attr('x', GEOM.rf.x + 16).attr('y', bodyY)
       .attr('class', 'lbl-mono-dim').attr('font-size', 10)
       .text(state.committed
              ? 'durable · survives a crash'
              : 'buffer in RAM only');
    }

    // ===== ④ UNDO TABLESPACE =====
    panel(s, GEOM.ut.x, GEOM.ut.y, GEOM.ut.w, GEOM.ut.h, "UNDO TABLESPACE · TX_100'S UNDO PAGES",
      state.committed ? 'COMMITTED · ON HISTORY LIST' : 'IN PROGRESS · UNCOMMITTED');

    // -- HEADER box (left) --
    if (state.undoHeader) {
      s.append('rect').attr('x', UT.headerBox.x).attr('y', UT.headerBox.y).attr('width', UT.headerBox.w).attr('height', UT.headerBox.h).attr('rx', 6)
       .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--orange)');
      s.append('text').attr('x', UT.headerBox.x + 14).attr('y', UT.headerBox.y + 22).attr('class', 'lbl-mono-dim')
       .text('UNDO LOG HEADER · FIRST PAGE OF UNDO LOG');
      const meta = [
        ['TRX_UNDO_STATE',     state.undoHeader.state],
        ['TRX_UNDO_TRX_ID',    state.undoHeader.trxId],
        ['TRX_UNDO_TRX_NO',    state.trxNo || '—'],
        ['TRX_UNDO_XID',       '—'],
        ['TRX_UNDO_DICT_TRANS','0']
      ];
      meta.forEach(([k, v], i) => {
        s.append('text').attr('x', UT.headerBox.x + 14).attr('y', UT.headerBox.y + 56 + i * 26).attr('class', 'lbl-mono')
         .attr('font-size', 11).attr('fill', 'var(--ink-dim)').text(k);
        s.append('text').attr('x', UT.headerBox.x + UT.headerBox.w - 14).attr('y', UT.headerBox.y + 56 + i * 26).attr('text-anchor', 'end')
         .attr('class', 'lbl-mono').attr('font-size', 11).text(v);
      });
      s.append('text').attr('x', UT.headerBox.x + 14).attr('y', UT.headerBox.y + UT.headerBox.h - 14).attr('class', 'lbl-mono-dim')
       .attr('font-size', 10).text('RECOVERY READS THIS BYTE ↑');
    }

    // -- RECORDS box (right) --
    s.append('rect').attr('x', UT.recordsBox.x).attr('y', UT.recordsBox.y).attr('width', UT.recordsBox.w).attr('height', UT.recordsBox.h).attr('rx', 6)
     .attr('fill', 'none').attr('stroke', 'var(--border-2)').attr('stroke-dasharray', '5 4');
    s.append('text').attr('x', UT.recordsBox.x + 14).attr('y', UT.recordsBox.y + 22).attr('class', 'lbl-mono-dim').text('UNDO LOG RECORDS');
    s.append('text').attr('x', UT.recordsBox.x + UT.recordsBox.w - 14).attr('y', UT.recordsBox.y + 22).attr('text-anchor', 'end')
     .attr('class', 'lbl-mono-dim').text('ONE PER ROW MODIFICATION');

    // Show ALL undo records — cards auto-shrink to fit the records box width.
    // Three density modes:
    //   full   (W ≥ 150): label-on-left, value-on-right per row
    //   short  (95 ≤ W < 150): same but with abbreviated labels
    //   tight  (W < 95): value-only, stacked centered, small font
    const total = state.undo.length;
    state.undo.forEach((u, i) => {
      const b = UT.undoSlot(i, total);
      const isLatest = (u.id === state.row?.rollPtr);
      const c = u.type === 'INSERT_REC' ? 'var(--green)' : 'var(--orange)';
      const isInsert = (u.type === 'INSERT_REC');
      const W = b.w;
      const detail = W >= 150 ? 'full' : W >= 95 ? 'short' : 'tight';

      // ----- card frame -----
      const card = s.append('g');
      card.append('rect').attr('x', b.x).attr('y', b.y).attr('width', b.w).attr('height', b.h).attr('rx', 6)
        .attr('fill', 'var(--panel-2)').attr('stroke', c).attr('stroke-width', isLatest ? 2.5 : 1.4);
      // hover-tooltip with the full text (always available, even in tight mode)
      const fullDesc = isInsert
        ? `undo #${u.id} · INSERT_REC\nPK: id=42\npurpose: rollback only\nat commit: dropped`
        : `undo #${u.id} · UPD_EXIST\nPK: id=42\nold name: '${u.oldName}'\nold trx: ${u.oldTrx}\nprev roll_ptr: ${u.oldRollPtr ? '#' + u.oldRollPtr : 'NULL'}`;
      card.append('title').text(fullDesc);

      // ----- header row: id + type chip -----
      const headFont = detail === 'tight' ? 9.5 : 11;
      s.append('text').attr('x', b.x + 6).attr('y', b.y + 16)
        .attr('class', 'lbl-mono-dim').attr('font-size', headFont).text(`#${u.id}`);
      const typeText = isInsert ? (detail === 'tight' ? 'INS' : 'INSERT') : 'UPD';
      s.append('text').attr('x', b.x + b.w - 6).attr('y', b.y + 16).attr('text-anchor', 'end')
        .attr('class', 'lbl-mono').attr('fill', c).attr('font-size', detail === 'tight' ? 9 : 10).text(typeText);

      // separator
      s.append('line').attr('x1', b.x + 6).attr('y1', b.y + 24).attr('x2', b.x + b.w - 6).attr('y2', b.y + 24)
        .attr('stroke', c).attr('opacity', 0.35);

      // ----- body rows -----
      let rows;
      if (isInsert) {
        rows = detail === 'full'
          ? [['PK', 'id=42'], ['PURPOSE', 'rollback only'], ['@ COMMIT', 'dropped']]
          : detail === 'short'
          ? [['PK', 'id=42'], ['@COMMIT', 'dropped']]
          : [['', 'id=42'], ['', 'dropped']];
      } else {
        rows = detail === 'full'
          ? [['PK', 'id=42'], ['OLD NAME', `'${u.oldName}'`], ['OLD TRX', u.oldTrx], ['PREV_ROLL', u.oldRollPtr ? '→ #' + u.oldRollPtr : 'NULL']]
          : detail === 'short'
          ? [['NAME', `'${u.oldName}'`], ['TRX', u.oldTrx], ['PREV', u.oldRollPtr ? '#' + u.oldRollPtr : 'NULL']]
          : [['', `'${u.oldName}'`], ['', u.oldRollPtr ? '#' + u.oldRollPtr : '-']];
      }
      const bodyFont = detail === 'tight' ? 9 : 10;
      const rowGap   = detail === 'tight' ? 18 : 18;
      const startY   = b.y + 40;
      rows.forEach(([k, v], j) => {
        const y = startY + j * rowGap;
        if (k) {
          s.append('text').attr('x', b.x + 6).attr('y', y)
            .attr('class', 'lbl-mono').attr('font-size', bodyFont).attr('fill', 'var(--ink-dim)').text(k);
          s.append('text').attr('x', b.x + b.w - 6).attr('y', y).attr('text-anchor', 'end')
            .attr('class', 'lbl-mono').attr('font-size', bodyFont).text(v);
        } else {
          // tight mode: just the value, centered
          s.append('text').attr('x', b.x + b.w / 2).attr('y', y).attr('text-anchor', 'middle')
            .attr('class', 'lbl-mono').attr('font-size', bodyFont).text(v);
        }
      });
    });

    // PREV_ROLL_PTR chain — short purple arrow in the gap between consecutive cards.
    state.undo.forEach((u, i) => {
      if (!u.oldRollPtr) return;
      const prevIdx = state.undo.findIndex(x => x.id === u.oldRollPtr);
      if (prevIdx < 0) return;
      const here = UT.undoSlot(i, total);
      const prev = UT.undoSlot(prevIdx, total);
      const midY = here.y + here.h / 2;
      const x1 = here.x - 2;
      const x2 = prev.x + prev.w + 2;
      // Skip when the gap is too small for a visible arrow (cards adjacent).
      if (Math.abs(x1 - x2) < 6) return;
      s.append('path')
       .attr('d', `M${x1},${midY} L${x2},${midY}`)
       .attr('fill', 'none')
       .attr('stroke', 'var(--accent-2)').attr('stroke-width', 1.5)
       .attr('marker-end', arrows.undo)
       .attr('opacity', 0.9);
    });

    // Single legend below the cards.
    if (state.undo.some(u => u.oldRollPtr)) {
      s.append('text')
       .attr('x', UT.recordsBox.x + UT.recordsBox.w / 2)
       .attr('y', UT.recordsBox.y + UT.recordsBox.h - 14)
       .attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono-dim').attr('font-size', 10).attr('fill', 'var(--accent-2)')
       .text('purple ← = PREV_ROLL_PTR (chain to older version)');
    }

    // ===== ⑤ DB_ROLL_PTR ARROW (the clean one) =====
    if (state.row && state.undo.length) {
      drawRollPtrArrow(arrows.flow);
    }
  }

  // Route the roll pointer through the gap above the undo tablespace.
  function drawRollPtrArrow(markerUrl) {
    const s = svg();
    const cell = bpCellBox(3);
    const startX = cell.x + cell.w / 2;
    const startY = cell.y + cell.h;
    const total = state.undo.length;
    const latestIdx = state.undo.findIndex(u => u.id === state.row.rollPtr);
    if (latestIdx < 0) return;
    const tgt = UT.undoSlot(latestIdx, total);
    const endX = tgt.x + tgt.w / 2;
    const endY = tgt.y;

    const channelY = (GEOM.bp.y + GEOM.bp.h + GEOM.ut.y) / 2;
    const path = `M${startX},${startY} V${channelY} H${endX} V${endY}`;

    s.append('path')
     .attr('d', path)
     .attr('fill', 'none')
     .attr('stroke', 'var(--orange)')
     .attr('stroke-width', 2)
     .attr('stroke-linejoin', 'round')
     .attr('stroke-linecap', 'round')
     .attr('marker-end', markerUrl);
    // No label — the orange color + arrowhead is self-explanatory and a
    // text label here would overlap the REDO LOG FILE panel header.
  }

  render(); updateBtns();
}
