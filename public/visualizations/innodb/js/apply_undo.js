/* resurrect.js — ⑪ Apply Undo
   Step-by-step recovery walks every rollback segment, classifies each undo log
   header by TRX_UNDO_STATE, and either rolls back ACTIVE txns (applying undo
   records LIFO until the trx undo is empty), keeps PREPARED txns alive for XA,
   or simply joins TO_PURGE undo onto the history list.

   Real entry points (5.7):
     trx_resurrect_insert()
     trx_resurrect_update()
     trx_resurrect_update_in_prepared_state()
   See storage/innobase/trx/trx0trx.cc and trx0undo.cc.
*/
(function () {
  const section = document.getElementById('resurrect');
  section.innerHTML = `
    <h2><span class="no">⑫</span>Apply Undo</h2>
    <p class="lead">After redo replay, every page is at its post-crash state — but some pages still hold partial writes from in-flight transactions. Recovery scans every rollback segment, reads each undo header's <code>TRX_UNDO_STATE</code>, and: rolls back <code>ACTIVE</code> txns (newest undo first, LIFO), keeps <code>PREPARED</code> txns alive for XA, or just joins <code>TO_PURGE</code> headers to the history list.</p>
    <p>Click <b>Step ▶</b> to walk through one full recovery cycle: scan, classify, apply each undo record (the row's <code>NAME</code> rewinds <code>'dave' → 'carl' → 'carol' → 'bob'</code>, and <code>DB_ROLL_PTR</code> hops back through the version chain — even crossing into another trx). Once a trx's undo is fully applied it transitions <code>ACTIVE → TO_PURGE</code>; only the <code>PREPARED</code> trx survives the recovery cycle.</p>

    <div class="controls">
      <button class="btn primary" data-act="step">Step ▶</button>
      <button class="btn"          data-act="play">▶ Auto play</button>
      <button class="btn"          data-act="reset">↺ Reset</button>
    </div>
    <div class="viz-container" style="padding:24px">
      <svg id="au-svg" viewBox="0 0 1200 760" style="width:100%;height:auto"></svg>
    </div>
    <div class="inspector" id="au-log"></div>
    <p class="ref"><code>trx/trx0trx.cc::trx_resurrect_insert / trx_resurrect_update / trx_resurrect_update_in_prepared_state</code></p>
  `;

  // ===== Static topology of the three caught-mid-flight txns =====
  // Version chain on the row (newest first):
  //   row.DB_ROLL_PTR → tx_202.undo#4 → tx_200.undo#3 → tx_200.undo#2 → tx_201.undo#1 → NULL
  const TRXS = [
    { name:'tx_202', state:'ACTIVE',   undos:[ { id:4, oldName:'carl',  prev:{trx:'tx_200', undo:3} } ] },
    { name:'tx_200', state:'ACTIVE',   undos:[
        { id:3, oldName:'carol', prev:{trx:'tx_200', undo:2} },
        { id:2, oldName:'bob',   prev:{trx:'tx_201', undo:1} }
      ] },
    { name:'tx_201', state:'PREPARED', undos:[ { id:1, oldName:'alice', prev:null } ] }
  ];

  // ===== Step program =====
  // Each step is tagged with a PHASE matching the source-code split:
  //   Phase 1 · RESURRECT  — trx_resurrect_*()  (scan rsegs, read header bytes)
  //   Phase 2 · ROLLBACK   — trx_rollback_or_clean_recovered() (walk undo LIFO)
  const STEPS = [
    { kind:'init', phase:'init',
      msg:'<b>Recovery starts after redo replay.</b> Three undo log headers are still ACTIVE/PREPARED in the rollback segments. The row sits at <code>name=\'dave\'</code>, written by tx_202.' },

    { kind:'scan',  who:'tx_202', phase:1,
      msg:'<b>Phase 1 · RESURRECT.</b> Scan rseg 0 → tx_202. State byte = <code>TRX_UNDO_ACTIVE</code> → call <code>trx_resurrect_update()</code>. trx struct rebuilt in memory; nothing rolled back yet.' },

    { kind:'scan',  who:'tx_200', phase:1,
      msg:'<b>Phase 1 · RESURRECT.</b> Scan rseg 0 → tx_200. State = <code>TRX_UNDO_ACTIVE</code> → resurrect_update again. Note its undo chain crosses into tx_201 via PREV_ROLL_PTR.' },

    { kind:'scan',  who:'tx_201', phase:1,
      msg:'<b>Phase 1 · RESURRECT.</b> Scan rseg 1 → tx_201. State = <code>TRX_UNDO_PREPARED</code> → <code>trx_resurrect_update_in_prepared_state()</code>. trx kept alive; XA coordinator decides COMMIT/ROLLBACK later.' },

    { kind:'apply', who:'tx_202', undo:4, phase:2,
      newRow:{ name:'carl', trx:'tx_200', rollPtr:3, rollPtrTrx:'tx_200' },
      msg:'<b>Phase 2 · ROLLBACK.</b> <code>trx_rollback_or_clean_recovered()</code> picks tx_202 first. Walk its undo log LIFO → apply undo #4: restore <code>name=\'carl\'</code>, rewrite DB_TRX_ID / DB_ROLL_PTR from the undo. Card marked <span style="color:var(--err)">APPLIED · KEPT</span> (records aren\'t erased; purge does that later).' },

    { kind:'transition', who:'tx_202', newState:'TO_PURGE', phase:2,
      msg:'<b>Phase 2 · ROLLBACK.</b> tx_202 fully rolled back. Segment transitions <code>TRX_UNDO_ACTIVE → TRX_UNDO_TO_PURGE</code> via <code>trx_undo_set_state_at_finish</code>; header joins the rseg history list.' },

    { kind:'apply', who:'tx_200', undo:3, phase:2,
      newRow:{ name:'carol', trx:'tx_200', rollPtr:2, rollPtrTrx:'tx_200' },
      msg:'<b>Phase 2 · ROLLBACK.</b> Apply tx_200.undo #3: restore <code>name=\'carol\'</code>. DB_ROLL_PTR hops to undo #2 (still inside tx_200).' },

    { kind:'apply', who:'tx_200', undo:2, phase:2,
      newRow:{ name:'bob', trx:'tx_201', rollPtr:1, rollPtrTrx:'tx_201' },
      msg:'<b>Phase 2 · ROLLBACK.</b> Apply tx_200.undo #2: restore <code>name=\'bob\'</code>. DB_ROLL_PTR now <em>crosses transactions</em> → it points at tx_201.undo #1, the version written before tx_200 even started.' },

    { kind:'transition', who:'tx_200', newState:'TO_PURGE', phase:2,
      msg:'<b>Phase 2 · ROLLBACK.</b> tx_200 fully rolled back. Header transitions to <code>TRX_UNDO_TO_PURGE</code> and joins the rseg history list alongside tx_202.' },

    { kind:'wait', who:'tx_201', phase:'done',
      msg:'<b>Recovery complete.</b> ACTIVE trxs are rolled back + on the history list (purge frees them later). The PREPARED trx stays in memory awaiting XA. Row remains at <code>name=\'bob\'</code>, owned by tx_201.' }
  ];

  let step = 0;
  let resTimer = null;
  section.querySelector('[data-act="step"]').addEventListener('click', () => {
    if (step < STEPS.length - 1) step++;
    render();
  });
  section.querySelector('[data-act="play"]').addEventListener('click', () => {
    if (resTimer) { clearInterval(resTimer); resTimer = null; return; }
    resTimer = setInterval(() => {
      if (step >= STEPS.length - 1) { clearInterval(resTimer); resTimer = null; return; }
      step++; render();
    }, 1300);
  });
  section.querySelector('[data-act="reset"]').addEventListener('click', () => {
    if (resTimer) { clearInterval(resTimer); resTimer = null; }
    step = 0; render();
  });

  // Derive everything (current row, trx states, applied undos, current focus) from the step number.
  function deriveState(idx) {
    const trxStates = { tx_202:'ACTIVE', tx_200:'ACTIVE', tx_201:'PREPARED' };
    const applied   = new Set();
    let row = { name:'dave', trx:'tx_202', rollPtr:4, rollPtrTrx:'tx_202' };
    let focus = null;
    let msg = STEPS[0].msg;
    for (let i = 0; i <= idx; i++) {
      const s = STEPS[i];
      msg = s.msg;
      if (s.who) focus = s.who;
      if (s.kind === 'apply') {
        applied.add(`${s.who}#${s.undo}`);
        row = { ...s.newRow };
      } else if (s.kind === 'transition') {
        trxStates[s.who] = s.newState;
      }
    }
    return { trxStates, applied, row, focus, msg };
  }

  // ===== Layout constants =====
  // y=0..36 is the phase-chip row (rendered in render()), so ROW_Y starts at 50.
  const ROW_Y = 50, ROW_H = 84;
  const PANEL_X = 16, PANEL_W = 1168;
  const RSEG_Y  = 156;                          // outer rseg container starts here
  const RSEG_H  = 596;
  const SUB_Y0  = RSEG_Y + 30;                  // first sub-trx panel y
  const SUB_H   = 168;
  const SUB_GAP = 16;
  function panelY(i)   { return SUB_Y0 + i * (SUB_H + SUB_GAP); }
  const UNDO_W = 240, UNDO_H = 110;
  function undoBoxX(j) { return PANEL_X + 60 + j * (UNDO_W + 36); }
  function undoBoxY(p) { return p + 56; }

  function rectOfUndo(trxName, undoId) {
    const trxIdx = TRXS.findIndex(t => t.name === trxName); if (trxIdx < 0) return null;
    const t = TRXS[trxIdx];
    const j = t.undos.findIndex(u => u.id === undoId); if (j < 0) return null;
    const py = panelY(trxIdx);
    return { x: undoBoxX(j), y: undoBoxY(py), w: UNDO_W, h: UNDO_H };
  }

  function render() {
    const svg = d3.select('#au-svg'); svg.selectAll('*').remove(); installArrowDefs(svg);
    const st = deriveState(step);
    const phase = STEPS[step].phase;
    d3.select('#au-log').html(st.msg);

    // ===== PHASE chips — taller pills with shorter labels so they fit cleanly =====
    {
      const chips = [
        { label:'INIT',          sub:'post-redo',                  active: phase === 'init', color:'var(--ink-dim)' },
        { label:'PHASE 1',       sub:'RESURRECT',                  active: phase === 1,      color:'var(--accent)' },
        { label:'PHASE 2',       sub:'ROLLBACK',                   active: phase === 2,      color:'var(--orange)' },
        { label:'DONE',          sub:'waiting for purge / XA',     active: phase === 'done', color:'var(--ok)' }
      ];
      // Even-width chips spread across the full panel width so spacing is balanced.
      const chipH = 36, chipGap = 10;
      const totalGap = chipGap * (chips.length - 1);
      const chipW = (PANEL_W - totalGap) / chips.length;
      chips.forEach((c, i) => {
        const cx = PANEL_X + i * (chipW + chipGap);
        const stroke = c.active ? c.color : 'var(--border-2)';
        const fill   = c.active ? 'rgba(74,229,229,0.04)' : 'var(--panel)';
        svg.append('rect').attr('x', cx).attr('y', 0).attr('width', chipW).attr('height', chipH).attr('rx', 6)
           .attr('fill', fill).attr('stroke', stroke).attr('stroke-width', c.active ? 1.8 : 1);
        // top-line: phase label
        svg.append('text').attr('x', cx + chipW / 2).attr('y', 14).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 11).attr('font-weight', 600)
           .attr('fill', c.active ? c.color : 'var(--ink-dim)').text(c.label);
        // sub-line: the function/description
        svg.append('text').attr('x', cx + chipW / 2).attr('y', 28).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono-dim').attr('font-size', 10)
           .attr('fill', c.active ? c.color : 'var(--ink-dim)').attr('opacity', 0.85).text(c.sub);
      });
    }

    // ===== ROW · USERS · ID=42 =====
    svg.append('rect').attr('x', PANEL_X).attr('y', ROW_Y).attr('width', PANEL_W).attr('height', ROW_H).attr('rx', 8)
       .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--ink-dim)').attr('stroke-width', 1.5);
    svg.append('text').attr('x', PANEL_X + 14).attr('y', ROW_Y + 22).attr('class', 'lbl-mono-dim').text('ROW · USERS · ID=42');
    [
      { l:'ID',          v:'42',                       c:'var(--orange)' },
      { l:'NAME',        v:`'${st.row.name}'`,         c:'var(--green)' },
      { l:'DB_TRX_ID',   v: st.row.trx,                c:'var(--purple)' },
      { l:'DB_ROLL_PTR', v: `→ undo #${st.row.rollPtr}`, c:'var(--err)' }
    ].forEach((c, i) => {
      const x = PANEL_X + 16 + i * 286, y = ROW_Y + 30, w = 270, h = 46;
      svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', h).attr('rx', 4)
         .attr('fill', 'var(--panel)').attr('stroke', c.c);
      svg.append('text').attr('x', x + 12).attr('y', y + 18).attr('class', 'rcell-label').attr('fill', c.c).text(c.l);
      svg.append('text').attr('x', x + w - 12).attr('y', y + 36).attr('text-anchor', 'end').attr('class', 'rcell-val').text(c.v);
    });

    // ===== Outer ROLLBACK SEGMENT container =====
    svg.append('rect').attr('x', PANEL_X).attr('y', RSEG_Y).attr('width', PANEL_W).attr('height', RSEG_H).attr('rx', 8)
       .attr('fill', 'none').attr('stroke', 'var(--orange)').attr('stroke-width', 1.5).attr('stroke-dasharray', '6 4');
    svg.append('text').attr('x', PANEL_X + 14).attr('y', RSEG_Y + 18).attr('class', 'lbl-mono-dim').attr('fill', 'var(--orange)')
       .text("ROLLBACK SEGMENT 0 · ATTACHED UNDO LOGS (ONE PER IN-FLIGHT TRX)");

    // ===== Three trx sub-panels =====
    TRXS.forEach((t, i) => {
      const py = panelY(i);
      const trxState  = st.trxStates[t.name];
      const isFocus   = (st.focus === t.name);
      const isPrep    = (trxState === 'PREPARED');
      const isPurge   = (trxState === 'TO_PURGE');
      const c = isPrep ? 'var(--warn)' : (isPurge ? 'var(--ink-dim)' : 'var(--err)');

      // Inner panel
      svg.append('rect').attr('x', PANEL_X + 16).attr('y', py).attr('width', PANEL_W - 32).attr('height', SUB_H).attr('rx', 8)
         .attr('fill', 'var(--panel-2)').attr('stroke', c).attr('stroke-width', isFocus ? 2.5 : 1.2);

      // trx name
      svg.append('text').attr('x', PANEL_X + 30).attr('y', py + 22).attr('class', 'lbl-mono').attr('fill', c).text(t.name);
      // state badge
      const stx = PANEL_X + 110, sty = py + 8, stw = 96;
      svg.append('rect').attr('x', stx).attr('y', sty).attr('width', stw).attr('height', 22).attr('rx', 4)
         .attr('fill', isPrep ? 'rgba(232,233,74,.18)' : isPurge ? 'rgba(125,133,144,.18)' : 'rgba(242,92,92,.18)')
         .attr('stroke', c);
      svg.append('text').attr('x', stx + stw / 2).attr('y', sty + 15).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 10).attr('fill', c).text(trxState);
      // right-side action label
      const right = isPrep
        ? '→ WAIT FOR XA COMMIT / ROLLBACK'
        : isPurge
          ? '→ ON HISTORY LIST · WAITING FOR PURGE'
          : '→ ROLLBACK IN BACKGROUND';
      svg.append('text').attr('x', PANEL_X + PANEL_W - 30).attr('y', py + 22).attr('text-anchor', 'end')
         .attr('class', 'lbl-mono').attr('font-size', 11).attr('fill', c).text(right);
      svg.append('text').attr('x', PANEL_X + 30).attr('y', py + 46).attr('class', 'lbl-mono-dim').attr('font-size', 10)
         .text('UNDO LOG (LIFO · NEWEST FIRST):');

      // Undo cards
      t.undos.forEach((u, j) => {
        const r = rectOfUndo(t.name, u.id);
        const isApplied = st.applied.has(`${t.name}#${u.id}`);
        const isNewest  = (j === 0);
        const isOldest  = (j === t.undos.length - 1) && (t.undos.length > 1);
        const cardC = isApplied ? 'var(--err)' : c;
        // background tint when applied
        svg.append('rect').attr('x', r.x).attr('y', r.y).attr('width', r.w).attr('height', r.h).attr('rx', 6)
           .attr('fill', isApplied ? 'rgba(242,92,92,.12)' : 'var(--panel)')
           .attr('stroke', cardC).attr('stroke-width', 1.4);
        svg.append('text').attr('x', r.x + 12).attr('y', r.y + 22).attr('class', 'lbl-mono')
           .attr('fill', cardC).text(`undo #${u.id} · UPD`);
        // NEWEST/OLDEST tag
        const tag = isApplied ? 'APPLIED · KEPT' : (isNewest ? 'NEWEST' : (isOldest ? 'OLDEST' : ''));
        if (tag) {
          svg.append('text').attr('x', r.x + r.w - 12).attr('y', r.y + 22).attr('text-anchor', 'end')
             .attr('class', 'lbl-mono').attr('font-size', 10)
             .attr('fill', isApplied ? 'var(--err)' : 'var(--ink-dim)').text(tag);
        }
        svg.append('text').attr('x', r.x + 12).attr('y', r.y + 50).attr('class', 'lbl-mono')
           .attr('font-size', 11).attr('fill', isApplied ? 'var(--ink-dim)' : 'var(--ink-2)')
           .text(`old name = '${u.oldName}'`);
        const prevTxt = u.prev ? `→ ${u.prev.trx} · undo #${u.prev.undo}` : '→ NULL (oldest version)';
        svg.append('text').attr('x', r.x + 12).attr('y', r.y + 72).attr('class', 'lbl-mono-dim').attr('font-size', 10)
           .text('PREV_ROLL_PTR ' + prevTxt);
      });
    });

    // ===== DB_ROLL_PTR arrow (row → currently-pointed undo) =====
    {
      const target = rectOfUndo(st.row.rollPtrTrx, st.row.rollPtr);
      if (target) {
        const startX = PANEL_X + 16 + 3 * 286 + 270 - 12;          // bottom-right of DB_ROLL_PTR cell
        const startY = ROW_Y + 30 + 23;
        const endX   = target.x + target.w / 2;
        const endY   = target.y - 4;
        svg.append('path')
           .attr('d', `M${startX},${startY} C${startX + 80},${startY} ${endX},${endY - 60} ${endX},${endY}`)
           .attr('fill', 'none').attr('stroke', 'var(--orange)').attr('stroke-width', 2)
           .attr('marker-end', 'url(#arrow-head-acc)')
           .attr('opacity', 0).transition().duration(280).attr('opacity', 1);
        svg.append('text').attr('x', (startX + endX) / 2).attr('y', startY + 22).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 10).attr('fill', 'var(--orange)').text('DB_ROLL_PTR');
      }
    }

    // ===== PREV_ROLL_PTR (same trx & cross trx) =====
    TRXS.forEach(t => {
      t.undos.forEach(u => {
        if (!u.prev) return;
        const from = rectOfUndo(t.name, u.id);
        const to   = rectOfUndo(u.prev.trx, u.prev.undo);
        if (!from || !to) return;
        const isSame = (t.name === u.prev.trx);
        const fx = from.x + 12,            fy = from.y + from.h - 18;
        const tx = to.x   + to.w - 12,     ty = to.y + 18;
        const midY = isSame ? (fy + ty) / 2 : (from.y + from.h + 14);
        const path = isSame
          ? `M${fx},${fy} L${fx},${midY} L${tx},${midY} L${tx},${ty}`
          : `M${fx},${fy} C${fx},${midY + 30} ${tx},${midY + 30} ${tx},${ty}`;
        svg.append('path').attr('d', path).attr('fill', 'none')
           .attr('stroke', isSame ? 'var(--ink-dim)' : 'var(--accent-2)')
           .attr('stroke-width', 1.4)
           .attr('stroke-dasharray', isSame ? null : '5 4')
           .attr('marker-end', isSame ? 'url(#arrow-head)' : 'url(#arrow-head-purple)')
           .attr('opacity', 0.85);
      });
    });

    // ===== Legend =====
    const legY = RSEG_Y + RSEG_H + 18;
    const items = [
      { c:'var(--orange)',   dash:false, t:'ROW DB_ROLL_PTR' },
      { c:'var(--ink-dim)',  dash:false, t:'PREV_ROLL_PTR (SAME TRX)' },
      { c:'var(--accent-2)', dash:true,  t:'PREV_ROLL_PTR (CROSSES TRX)' }
    ];
    let lx = 28;
    items.forEach(it => {
      svg.append('line').attr('x1', lx).attr('y1', legY).attr('x2', lx + 36).attr('y2', legY)
         .attr('stroke', it.c).attr('stroke-width', 2)
         .attr('stroke-dasharray', it.dash ? '5 4' : null);
      svg.append('text').attr('x', lx + 44).attr('y', legY + 4).attr('class', 'lbl-mono-dim').attr('font-size', 11).text(it.t);
      lx += 44 + it.t.length * 7 + 28;
    });
  }

  render();
})();
