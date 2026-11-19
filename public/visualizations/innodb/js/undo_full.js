/* undo_full.js — ⑱ Undo · The Heart of InnoDB
   Layout (viewBox 1400 × 900):
     y=  16..150  : transaction timeline (TRX lanes with action markers)
     y= 170..210  : top labels (RECOVERY · INSERT · SELECT · PURGE) + arrows
     y= 220..440  : top row panels (Redo Log · Btree Page · Read View · Purge)
     y= 460..840  : bottom row panels (Redo Log File · Rseg 0 · History List)

   Three scenarios, each as a sequence of steps. Each step has an optional
   marker { trx, kind } that places a colored badge on that trx's timeline lane.
   Step navigation: ▶ Play · ⏮ Prev · ⏭ Next · jump-to by clicking any marker.
*/
(function () {
  const section = document.getElementById('undo-full');
  if (!section) return;

  section.innerHTML = `
    <h2><span class="no">⑱</span>Undo · The Heart of InnoDB</h2>
    <p class="lead">One integrated diagram of how every InnoDB subsystem meets at the undo log. Pick a scenario, then walk through it step-by-step or click any marker on the transaction timeline to jump there.</p>

    <div class="controls">
      <button class="btn primary" data-act="uf-A">▶ Scenario 1 · INSERT + redo</button>
      <button class="btn"          data-act="uf-B">▶ Scenario 2 · SELECT (MVCC)</button>
      <button class="btn"          data-act="uf-C">▶ Scenario 3 · PURGE (blocked → unblocked)</button>
      <span style="margin:0 8px;color:var(--ink-dim)">·</span>
      <button class="btn"          data-act="uf-prev">⏮ Prev</button>
      <button class="btn"          data-act="uf-play">▶ Play</button>
      <button class="btn"          data-act="uf-next">Next ⏭</button>
      <button class="btn"          data-act="uf-reset">↺ Reset</button>
    </div>

    <div class="viz-container" style="padding:24px">
      <svg id="uf-svg" viewBox="0 0 1400 900" style="width:100%;height:auto"></svg>
    </div>

    <div class="inspector" id="uf-log">Pick a scenario, then walk through with the step controls or click markers on the timeline.</div>
  `;

  // ===== Layout =====
  const TL = { x: 24, y: 16, w: 1352, h: 134 };           // timeline panel
  const LABEL_Y = 184, ARROW_Y0 = 190, ARROW_Y1 = 212;     // top column labels
  const L = {
    redoLog:  { x:  24, y: 220, w: 220, h: 220 },
    page:     { x: 264, y: 220, w: 520, h: 220 },
    rv:       { x: 804, y: 220, w: 220, h: 220 },
    purge:    { x: 1044,y: 220, w: 332, h: 220 },
    redoFile: { x:  24, y: 460, w: 220, h: 380 },
    rseg:     { x: 264, y: 460, w: 760, h: 380 },
    history:  { x: 1044,y: 460, w: 332, h: 380 }
  };

  // ===== Mutable diagram state (panels read this) =====
  let st;
  function reset() {
    st = {
      row:           null,
      insertUndo:    null,
      updateUndos:   [],
      redoBuf:       [],
      redoFile:      [],
      readViews:     [],
      historyList:   [],
      purgeActive:   false,
      blockedAt:     null,
      truncated:     [],
      visibleVerdict: null,
      focus:         null,
      arrows:        []
    };
  }
  reset();

  // ===== Scenario engine =====
  let scenario = { steps: [], idx: -1, lanes: new Map() };
  let timer = null;
  function cancelTimer() { if (timer) { clearTimeout(timer); timer = null; } }

  function loadScenario(steps) {
    cancelTimer();
    scenario = { steps, idx: -1, lanes: new Map() };
    // Pre-assign lanes for every TRX referenced in any marker so the timeline
    // shows all participants from the start, not just up to currentIdx.
    steps.forEach(s => {
      if (s.marker && !scenario.lanes.has(s.marker.trx)) {
        scenario.lanes.set(s.marker.trx, scenario.lanes.size);
      }
    });
    reset();
    render();
    log('Scenario loaded — press ▶ Play to auto-advance, or use ⏭ Next / click any marker to jump.');
  }

  function applyUpTo(target) {
    reset();
    for (let i = 0; i <= target && i < scenario.steps.length; i++) {
      scenario.steps[i].do();
    }
    scenario.idx = target;
    render();
    if (target >= 0 && scenario.steps[target]) log(scenario.steps[target].msg);
  }

  function nextStep() {
    if (scenario.idx < scenario.steps.length - 1) applyUpTo(scenario.idx + 1);
  }
  function prevStep() {
    if (scenario.idx >= 0) applyUpTo(scenario.idx - 1);
  }
  function play() {
    if (!scenario.steps.length) return;
    cancelTimer();
    (function tick() {
      if (scenario.idx >= scenario.steps.length - 1) return;
      nextStep();
      timer = setTimeout(tick, 1200);
    })();
  }

  // ===== Connection-point registry — populated during render =====
  let pts = {};
  function setPt(k, x, y) { pts[k] = { x, y }; }

  // ===== Generic helpers =====
  function panel(svg, b, label, focusKey) {
    const focused = st.focus === focusKey;
    svg.append('rect').attr('x', b.x).attr('y', b.y).attr('width', b.w).attr('height', b.h).attr('rx', 8)
       .attr('fill', 'var(--panel-2)')
       .attr('stroke', focused ? 'var(--accent)' : 'var(--border)')
       .attr('stroke-width', focused ? 2 : 1);
    if (focused) {
      const ring = svg.append('rect').attr('x', b.x - 4).attr('y', b.y - 4)
         .attr('width', b.w + 8).attr('height', b.h + 8).attr('rx', 10)
         .attr('fill', 'none').attr('stroke', 'var(--accent)').attr('stroke-width', 2);
      ring.append('animate').attr('attributeName', 'opacity')
          .attr('values', '0.7;0.15;0.7').attr('dur', '1.6s').attr('repeatCount', 'indefinite');
    }
    svg.append('text').attr('x', b.x + 14).attr('y', b.y + 22).attr('class', 'lbl-mono')
       .attr('font-size', 12).style('fill', focused ? 'var(--accent)' : 'var(--ink-2)').text(label);
  }

  // ===== Top labels with downward arrows =====
  function drawTopLabels(svg) {
    const labels = [
      { x: L.redoLog.x + L.redoLog.w / 2, text: 'RECOVERY' },
      { x: L.page.x    + L.page.w    / 2, text: 'INSERT'   },
      { x: L.rv.x      + L.rv.w      / 2, text: 'SELECT'   },
      { x: L.purge.x   + L.purge.w   / 2, text: 'PURGE'    }
    ];
    labels.forEach(l => {
      svg.append('text').attr('x', l.x).attr('y', LABEL_Y).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 14).attr('font-weight', 600)
         .style('fill', 'var(--ink-2)').text(l.text);
      svg.append('line').attr('x1', l.x).attr('y1', ARROW_Y0).attr('x2', l.x).attr('y2', ARROW_Y1)
         .attr('stroke', 'var(--ink-dim)').attr('stroke-width', 1.4)
         .attr('marker-end', 'url(#arrow-head)');
    });
  }

  // ===== Transaction timeline (top panel) =====
  // Lanes for each TRX, with action markers placed by step index. Markers are
  // clickable: a click jumps the scenario to that step (re-applying state).
  function drawTimeline(svg) {
    panel(svg, TL, 'Transactions', null);
    if (scenario.lanes.size === 0) {
      svg.append('text').attr('x', TL.x + TL.w / 2).attr('y', TL.y + TL.h / 2 + 4).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono-dim').attr('font-size', 12).text('— pick a scenario to populate the timeline —');
      return;
    }
    const labelW = 80, padL = 16, padR = 16, padTop = 38, padBot = 14;
    const trackX0 = TL.x + padL + labelW + 12;
    const trackX1 = TL.x + TL.w - padR;
    const trackW  = trackX1 - trackX0;
    const lanes   = [...scenario.lanes.entries()];   // [[trxId, idx], ...]
    const laneH   = (TL.h - padTop - padBot) / Math.max(lanes.length, 1);
    const N       = scenario.steps.length;

    function stepX(i) {
      if (N <= 1) return trackX0 + trackW / 2;
      return trackX0 + (i / (N - 1)) * trackW;
    }

    // Draw each lane: label + lifetime bar
    lanes.forEach(([trxId, laneIdx]) => {
      const ly = TL.y + padTop + laneIdx * laneH + laneH / 2;
      // label
      svg.append('text').attr('x', TL.x + padL).attr('y', ly + 4).attr('class', 'lbl-mono')
         .attr('font-size', 12).style('fill', 'var(--ink-2)').text(trxId);
      // lifetime bar (full track width — every trx is "alive" within the scenario window)
      svg.append('rect').attr('x', trackX0).attr('y', ly - 12).attr('width', trackW).attr('height', 24).attr('rx', 4)
         .attr('fill', 'var(--panel)').attr('stroke', 'var(--border-2)').attr('stroke-width', 1);
    });

    // Faint vertical step gridlines for orientation
    for (let i = 0; i < N; i++) {
      svg.append('line').attr('x1', stepX(i)).attr('y1', TL.y + padTop - 6)
         .attr('x2', stepX(i)).attr('y2', TL.y + TL.h - padBot)
         .attr('stroke', 'var(--border-2)').attr('stroke-width', 0.6).attr('opacity', 0.5);
    }

    // Playhead — a vertical line at the current step
    if (scenario.idx >= 0) {
      const px = stepX(scenario.idx);
      svg.append('line').attr('x1', px).attr('y1', TL.y + padTop - 8)
         .attr('x2', px).attr('y2', TL.y + TL.h - padBot)
         .attr('stroke', 'var(--accent)').attr('stroke-width', 2).attr('opacity', 0.8);
    }

    // Markers
    scenario.steps.forEach((s, i) => {
      if (!s.marker) return;
      const { trx, kind } = s.marker;
      const lane = scenario.lanes.get(trx); if (lane === undefined) return;
      const ly = TL.y + padTop + lane * laneH + laneH / 2;
      const cx = stepX(i);

      const fill = kindFill(kind);
      const isCur  = (i === scenario.idx);
      const reached = (i <= scenario.idx);
      const opacity = reached ? 1 : 0.35;

      const grp = svg.append('g').style('cursor', 'pointer')
        .on('click', () => { applyUpTo(i); })
        .on('mouseenter', function () { d3.select(this).attr('transform', `translate(0,-2)`); })
        .on('mouseleave', function () { d3.select(this).attr('transform', null); });

      grp.append('rect').attr('x', cx - 12).attr('y', ly - 11).attr('width', 24).attr('height', 22).attr('rx', 3)
         .attr('fill', fill).attr('stroke', isCur ? 'var(--accent)' : 'rgba(0,0,0,0.4)')
         .attr('stroke-width', isCur ? 2 : 1).attr('opacity', opacity);
      grp.append('text').attr('x', cx).attr('y', ly + 5).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 12).attr('font-weight', 700)
         .style('fill', '#0a0a0a').attr('opacity', opacity).text(kind);

      // Pulse the current marker
      if (isCur) {
        grp.append('rect').attr('x', cx - 14).attr('y', ly - 13).attr('width', 28).attr('height', 26).attr('rx', 4)
           .attr('fill', 'none').attr('stroke', 'var(--accent)').attr('stroke-width', 2)
           .append('animate').attr('attributeName', 'opacity')
           .attr('values', '0.8;0.15;0.8').attr('dur', '1.4s').attr('repeatCount', 'indefinite');
      }

      // Hover tooltip via shared shell.js helper
      attachTip(grp, () => `<b>${trx}</b> · step ${i + 1}<br>${kindLabel(kind)} — click to jump here`);
    });
  }

  function kindFill(k) {
    return ({
      I: '#ff5e5e',     // INSERT — red
      U: '#ff5e5e',     // UPDATE — red (write op)
      S: '#7ee787',     // SELECT — green
      R: '#5b9cff',     // open ReadView — blue
      C: '#c4c4c4',     // COMMIT — grey
      P: '#ffc07a',     // PURGE  — peach
      X: '#a072f3'      // close / other — purple
    })[k] || '#cccccc';
  }
  function kindLabel(k) {
    return ({
      I: 'INSERT', U: 'UPDATE', S: 'SELECT', R: 'open ReadView',
      C: 'COMMIT', P: 'PURGE', X: 'close ReadView'
    })[k] || k;
  }

  // ===== Panels =====

  function drawRedoLog(svg) {
    panel(svg, L.redoLog, 'Redo Log', 'redoLog');
    const types = ['MLOG_UNDO_HDR_CREATE', 'MLOG_REC_INSERT', 'MLOG_REC_UPDATE_IN_PLACE'];
    types.forEach((t, i) => {
      const y  = L.redoLog.y + 50 + i * 50;
      const present = st.redoBuf.includes(t);
      svg.append('rect').attr('x', L.redoLog.x + 14).attr('y', y).attr('width', L.redoLog.w - 28).attr('height', 36).attr('rx', 4)
         .attr('fill', 'var(--panel)').attr('stroke', present ? 'var(--green)' : 'var(--border-2)').attr('stroke-width', present ? 1.5 : 1)
         .attr('opacity', present ? 1 : 0.45);
      svg.append('text').attr('x', L.redoLog.x + L.redoLog.w / 2).attr('y', y + 22).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 10.5)
         .style('fill', present ? 'var(--green)' : 'var(--ink-dim)').text(t);
    });
  }

  function drawPage(svg) {
    panel(svg, L.page, 'Btree Leaf Page', 'page');
    const px = L.page.x + 24, py = L.page.y + 56, pw = 110;
    svg.append('rect').attr('x', px).attr('y', py).attr('width', pw).attr('height', 26).attr('fill', '#7ee787').attr('opacity', 0.9);
    svg.append('rect').attr('x', px).attr('y', py + 26).attr('width', pw).attr('height', 88).attr('fill', '#5b9cff').attr('opacity', 0.9);
    svg.append('rect').attr('x', px).attr('y', py + 114).attr('width', pw).attr('height', 26).attr('fill', '#7ee787').attr('opacity', 0.9);
    svg.append('text').attr('x', px + pw / 2).attr('y', py + 76).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', '#0a0a0a').attr('font-weight', 600).text('Page');

    const fields = ['ID', 'TRX_ID', 'ROLL_PTR', 'COL1', 'COL2'];
    const rx = px + pw + 30, ry = L.page.y + 110, cellW = 64, cellH = 36, gap = 6;
    const present = st.row !== null;
    fields.forEach((f, i) => {
      const cx = rx + i * (cellW + gap);
      svg.append('rect').attr('x', cx).attr('y', ry).attr('width', cellW).attr('height', cellH).attr('rx', 4)
         .attr('fill', present ? 'var(--panel)' : 'var(--panel-2)')
         .attr('stroke', present ? 'var(--orange)' : 'var(--border-2)')
         .attr('stroke-width', present ? 1.4 : 1).attr('opacity', present ? 1 : 0.5);
      svg.append('text').attr('x', cx + cellW / 2).attr('y', ry + 14).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono-dim').attr('font-size', 9).text(f);
      if (present) {
        const val = (
          f === 'ID'        ? '42' :
          f === 'TRX_ID'    ? `tx_${st.row.trx_id}` :
          f === 'ROLL_PTR'  ? '→ undo' :
          f === 'COL1'      ? st.row.name :
                              '—'
        );
        svg.append('text').attr('x', cx + cellW / 2).attr('y', ry + 28).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 10).style('fill', 'var(--orange)').text(val);
      }
    });
    setPt('row-rollptr', rx + 2 * (cellW + gap) + cellW / 2, ry + cellH);
  }

  function drawReadView(svg) {
    panel(svg, L.rv, 'Read View', 'rv');
    if (st.readViews.length === 0) {
      svg.append('text').attr('x', L.rv.x + L.rv.w / 2).attr('y', L.rv.y + L.rv.h / 2 + 4).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono-dim').attr('font-size', 11).text('— no readers yet —');
      return;
    }
    st.readViews.forEach((rv, i) => {
      const y = L.rv.y + 56 + i * 70;
      const active = rv.active;
      svg.append('rect').attr('x', L.rv.x + 18).attr('y', y).attr('width', L.rv.w - 36).attr('height', 50).attr('rx', 5)
         .attr('fill', active ? '#e0444a' : '#3a1a1a')
         .attr('stroke', active ? '#ff6b6b' : '#5a2a2a').attr('stroke-width', 1.4)
         .attr('opacity', active ? 0.95 : 0.45);
      svg.append('text').attr('x', L.rv.x + L.rv.w / 2).attr('y', y + 21).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 12).attr('font-weight', 600)
         .style('fill', active ? '#fff' : 'var(--ink-dim)').text(`${rv.name}  up_limit=${rv.up_limit}`);
      svg.append('text').attr('x', L.rv.x + L.rv.w / 2).attr('y', y + 38).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 10)
         .style('fill', active ? '#fff' : 'var(--ink-dim)')
         .attr('opacity', active ? 0.9 : 1)
         .text(active ? 'active snapshot' : '(closed)');
      setPt(`rv-${rv.name}`, L.rv.x + 18, y + 25);
    });
  }

  function drawPurge(svg) {
    panel(svg, L.purge, 'Purge', 'purge');
    const cx = L.purge.x + L.purge.w / 2;
    const planY = L.purge.y + 50;
    svg.append('rect').attr('x', L.purge.x + 60).attr('y', planY).attr('width', L.purge.w - 120).attr('height', 36).attr('rx', 5)
       .attr('fill', '#ffe066').attr('opacity', st.purgeActive ? 0.95 : 0.5);
    svg.append('text').attr('x', cx).attr('y', planY + 22).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono').attr('font-size', 12).style('fill', '#0a0a0a').attr('font-weight', 600).text('Plan');

    const workerY = L.purge.y + 100;
    const wW = 130, wGap = 16;
    const w1x = L.purge.x + (L.purge.w - 2 * wW - wGap) / 2;
    const w2x = w1x + wW + wGap;
    [['Purge Worker 1', w1x], ['Purge Worker 2', w2x]].forEach(([t, x]) => {
      svg.append('rect').attr('x', x).attr('y', workerY).attr('width', wW).attr('height', 36).attr('rx', 5)
         .attr('fill', '#ffc07a').attr('opacity', st.purgeActive ? 0.95 : 0.5);
      svg.append('text').attr('x', x + wW / 2).attr('y', workerY + 22).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', '#0a0a0a').attr('font-weight', 600).text(t);
    });
    setPt('worker2', w2x + wW / 2, workerY + 36);

    const trY = L.purge.y + 160;
    svg.append('rect').attr('x', L.purge.x + 80).attr('y', trY).attr('width', L.purge.w - 160).attr('height', 36).attr('rx', 5)
       .attr('fill', '#7ee787').attr('opacity', st.truncated.length ? 0.95 : 0.5);
    svg.append('text').attr('x', cx).attr('y', trY + 22).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono').attr('font-size', 12).style('fill', '#0a0a0a').attr('font-weight', 600).text('Truncate');

    if (st.blockedAt) {
      svg.append('text').attr('x', cx).attr('y', L.purge.y + L.purge.h - 10).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 10).style('fill', 'var(--err)').attr('font-weight', 600)
         .text(`✗ blocked on ${st.blockedAt}`);
    }
  }

  function drawRedoFile(svg) {
    panel(svg, L.redoFile, 'Redo Log File', 'redoFile');
    if (st.redoFile.length === 0) {
      svg.append('text').attr('x', L.redoFile.x + L.redoFile.w / 2).attr('y', L.redoFile.y + 56).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono-dim').attr('font-size', 11).text('— no LSNs yet —');
      return;
    }
    st.redoFile.forEach((lsn, i) => {
      const y = L.redoFile.y + 64 + i * 40;
      svg.append('text').attr('x', L.redoFile.x + L.redoFile.w / 2).attr('y', y).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 18).style('fill', 'var(--ok)').attr('font-weight', 500).text(`LSN ${lsn}`);
    });
  }

  function drawRseg(svg) {
    panel(svg, L.rseg, 'Rseg 0  ·  1 of 128', 'rseg');

    // Each transaction has its own insert_undo and update_undo logs (trx_undo_t).
    // We render each undo log as a CARD: a thin header strip on top with the
    // log's metadata fields (TRX_UNDO_TRX_ID / TRX_UNDO_TRX_NO / TRX_UNDO_STATE)
    // and the record body underneath. Sub-panels span the full rseg width.
    const subX = L.rseg.x + 16;
    const subW = L.rseg.w - 32;
    const insertY = L.rseg.y + 50, insertH = (L.rseg.h - 70 - 16) / 2;
    const updateY = insertY + insertH + 16, updateH = insertH;
    drawSubPanel(svg, subX, insertY, subW, insertH, 'Insert Undo  ·  TRX_UNDO_INSERT_REC log', 'rseg-insert');
    drawSubPanel(svg, subX, updateY, subW, updateH, 'Update Undo  ·  TRX_UNDO_UPD_EXIST_REC log', 'rseg-update');

    if (st.insertUndo) {
      const cardW = 220, cardH = insertH - 38;
      const cardX = subX + 16, cardY = insertY + 28;
      const purged = st.truncated.includes(`trx_${st.insertUndo.trx_id}`);
      const bodyTopY = drawUndoCard(svg, cardX, cardY, cardW, cardH, st.insertUndo.trx_id, '#7ee787', purged);
      setPt('insertUndo',        cardX + cardW / 2, bodyTopY);
      setPt('insertUndo-bottom', cardX + cardW / 2, cardY + cardH);
      setPt('insertUndo-right',  cardX + cardW,     cardY + cardH / 2);
    }

    if (st.updateUndos.length) {
      const cardW = 220, cardH = updateH - 38, gap = 18;
      st.updateUndos.forEach((u, i) => {
        const cardX = subX + 16 + i * (cardW + gap);
        const cardY = updateY + 28;
        const purged = st.truncated.includes(`trx_${u.trx_id}`);
        const bodyTopY = drawUndoCard(svg, cardX, cardY, cardW, cardH, u.trx_id, '#79f0d8', purged);
        setPt(`updateUndo-${i}`,        cardX + cardW / 2, bodyTopY);
        setPt(`updateUndo-${i}-bot`,    cardX + cardW / 2, cardY + cardH);
        setPt(`updateUndo-${i}-left`,   cardX,             cardY + cardH / 2);
        setPt(`updateUndo-${i}-right`,  cardX + cardW,     cardY + cardH / 2);
      });
    }
  }

  // One undo log = header strip (TRX_UNDO_* fields) + record body. Returns the
  // y of the body's top edge so callers can anchor connection arrows there.
  // Header uses two stacked lines to avoid horizontal overflow on 220px cards.
  function drawUndoCard(svg, x, y, w, h, trxId, bodyFill, purged) {
    const headerH = 36;
    const state = purged ? 'FREE' : 'TO_PURGE';
    const stateColor = purged ? 'var(--ok)' : 'var(--orange)';
    const dimColor   = purged ? 'var(--ink-dim)' : 'var(--ink-2)';

    // ---- Header strip — undo log header (TRX_UNDO_PAGE_HDR + TRX_UNDO_SEG_HDR + ...) ----
    const hdrG = svg.append('g');
    hdrG.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', headerH).attr('rx', 4)
        .attr('fill', 'var(--panel-2)').attr('stroke', dimColor).attr('stroke-width', 1)
        .attr('opacity', purged ? 0.5 : 0.95);
    // Line 1: identifiers (left-aligned label + right-aligned value, twice)
    const colW = w / 2;
    hdrG.append('text').attr('x', x + 10).attr('y', y + 14).attr('class', 'lbl-mono').attr('font-size', 9)
        .style('fill', dimColor).text('TRX_ID');
    hdrG.append('text').attr('x', x + colW - 10).attr('y', y + 14).attr('text-anchor', 'end')
        .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', dimColor).attr('font-weight', 600).text(trxId);
    hdrG.append('text').attr('x', x + colW + 10).attr('y', y + 14).attr('class', 'lbl-mono').attr('font-size', 9)
        .style('fill', dimColor).text('TRX_NO');
    hdrG.append('text').attr('x', x + w - 10).attr('y', y + 14).attr('text-anchor', 'end')
        .attr('class', 'lbl-mono').attr('font-size', 11).style('fill', dimColor).attr('font-weight', 600).text(trxId);
    // Line 2: state pill, centered
    hdrG.append('text').attr('x', x + 10).attr('y', y + 28).attr('class', 'lbl-mono').attr('font-size', 9)
        .style('fill', dimColor).text('STATE');
    hdrG.append('text').attr('x', x + w - 10).attr('y', y + 28).attr('text-anchor', 'end')
        .attr('class', 'lbl-mono').attr('font-size', 10).style('fill', stateColor).attr('font-weight', 600).text(state);
    attachTip(hdrG, () => `<b>Undo log header</b><br>TRX_UNDO_TRX_ID = ${trxId}<br>TRX_UNDO_TRX_NO = ${trxId}<br>TRX_UNDO_STATE = ${state}<br>TRX_UNDO_HISTORY_NODE → linked from rseg history list at COMMIT`);

    // ---- Record body — the undo records that follow the header on the page ----
    const by = y + headerH + 2;
    const bh = h - headerH - 2;
    const bodyG = svg.append('g');
    bodyG.append('rect').attr('x', x).attr('y', by).attr('width', w).attr('height', bh).attr('rx', 4)
         .attr('fill', purged ? 'var(--ink-dim)' : bodyFill).attr('opacity', purged ? 0.3 : 0.95);
    ['PK', 'Old Rollback Ptr', 'Old Col1', 'Old Trx ID'].forEach((label, i) => {
      bodyG.append('text').attr('x', x + w / 2).attr('y', by + 16 + i * 13).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 10).style('fill', '#0a0a0a').attr('font-weight', 500).text(label);
    });
    if (purged) {
      bodyG.append('text').attr('x', x + w / 2).attr('y', by + bh - 4).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 9).style('fill', 'var(--ok)').text('✓ purged');
    }
    attachTip(bodyG, () => `<b>Undo record</b><br>tx_${trxId}<br>holds the OLD column values<br>linked back via prev_roll_ptr`);

    return by;
  }

  function drawSubPanel(svg, x, y, w, h, label, focusKey) {
    const focused = st.focus === focusKey;
    svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', h).attr('rx', 6)
       .attr('fill', 'transparent').attr('stroke', focused ? 'var(--accent)' : 'var(--border-2)')
       .attr('stroke-width', focused ? 1.6 : 1);
    svg.append('text').attr('x', x + 12).attr('y', y + 18).attr('class', 'lbl-mono')
       .attr('font-size', 11).style('fill', focused ? 'var(--accent)' : 'var(--ink-2)').text(label);
  }

  function drawHistory(svg) {
    panel(svg, L.history, 'History List', 'history');
    if (st.historyList.length === 0) {
      svg.append('text').attr('x', L.history.x + L.history.w / 2).attr('y', L.history.y + 80).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono-dim').attr('font-size', 11).text('— empty —');
      return;
    }
    st.historyList.forEach((trx, i) => {
      const y = L.history.y + 60 + i * 56;
      const purged = st.truncated.includes(trx);
      svg.append('rect').attr('x', L.history.x + 30).attr('y', y).attr('width', L.history.w - 60).attr('height', 40).attr('rx', 5)
         .attr('fill', 'var(--panel)').attr('stroke', purged ? 'var(--ink-dim)' : 'var(--accent)').attr('stroke-width', 1.4)
         .attr('opacity', purged ? 0.35 : 1);
      svg.append('text').attr('x', L.history.x + L.history.w / 2).attr('y', y + 26).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 14)
         .style('fill', purged ? 'var(--ink-dim)' : 'var(--accent)').attr('font-weight', 500)
         .text(purged ? `${trx} ✓` : trx);
      if (i === 0) setPt('history-first', L.history.x + 30, y + 20);
    });
  }

  function drawArrows(svg) {
    st.arrows.forEach(a => {
      const p = pts[a.from], q = pts[a.to];
      if (!p || !q) return;
      const color = a.color || 'var(--accent-2)';
      const dx = q.x - p.x, dy = q.y - p.y;
      const dist = Math.hypot(dx, dy) || 1;
      // Perpendicular unit vector (rotate p→q by 90° CCW). Both control points
      // get pulled perpendicular by `bow` to give an organic, curvy arc rather
      // than the previous rigid right-angle S-curve.
      const nx = -dy / dist, ny = dx / dist;
      const bow = Math.min(dist * 0.32, 90) * (a.bow ?? 1);
      const c1x = p.x + dx * 0.25 + nx * bow;
      const c1y = p.y + dy * 0.25 + ny * bow;
      const c2x = p.x + dx * 0.75 + nx * bow;
      const c2y = p.y + dy * 0.75 + ny * bow;

      svg.append('path')
         .attr('d', `M${p.x},${p.y} C${c1x},${c1y} ${c2x},${c2y} ${q.x},${q.y}`)
         .attr('fill', 'none').attr('stroke', color).attr('stroke-width', 2)
         .attr('opacity', 0).attr('stroke-dasharray', a.dashed ? '5 4' : null)
         .transition().duration(400).attr('opacity', 0.95);

      // Arrowhead oriented to the path's tangent at q (computed from c2)
      const tx = q.x - c2x, ty = q.y - c2y;
      const tlen = Math.hypot(tx, ty) || 1;
      const ux = tx / tlen, uy = ty / tlen;
      const bx = q.x - ux * 9, by = q.y - uy * 9;
      const wx = -uy * 5, wy = ux * 5;
      svg.append('path')
         .attr('d', `M${bx + wx},${by + wy} L${q.x},${q.y} L${bx - wx},${by - wy} Z`)
         .attr('fill', color).attr('opacity', 0)
         .transition().delay(380).duration(220).attr('opacity', 0.95);
    });
  }

  function render() {
    const svg = d3.select('#uf-svg');
    svg.selectAll('*').remove();
    installArrowDefs(svg);
    pts = {};
    drawTimeline(svg);
    drawTopLabels(svg);
    drawRedoLog(svg);
    drawPage(svg);
    drawReadView(svg);
    drawPurge(svg);
    drawRedoFile(svg);
    drawRseg(svg);
    drawHistory(svg);
    drawArrows(svg);
  }

  function log(html) { document.getElementById('uf-log').innerHTML = html; }

  // ===== Scenario 1 — INSERT + UPDATE + redo =====
  function scenario1() {
    const RED = '#ff5e5e';
    const PURPLE = 'var(--accent-2)';
    return [
      { do: () => { st.focus = 'page'; st.row = { trx_id: 100, name: 'alice' }; },
        marker: { trx: 'TRX100', kind: 'I' },
        msg: '<b>Step 1 · INSERT row PK=42 (TRX100)</b> — the new row lands in the B-tree leaf page with DB_TRX_ID=tx_100.' },
      { do: () => { st.focus = 'rseg-insert';
                    st.insertUndo = { trx_id: 100 };
                    st.arrows = [{ from: 'row-rollptr', to: 'insertUndo', color: RED }]; },
        msg: '<b>Step 2 · Insert undo created</b> — Rseg 0 records a <code>TRX_UNDO_INSERT_REC</code> (green). The row\'s ROLL_PTR points at it. This undo is freed-at-COMMIT — no future ReadView can need to reconstruct "before the row existed".' },
      { do: () => { st.focus = 'redoLog';
                    st.redoBuf = ['MLOG_UNDO_HDR_CREATE', 'MLOG_REC_INSERT'];
                    st.arrows = [{ from: 'row-rollptr', to: 'insertUndo', color: RED }]; },
        msg: '<b>Step 3 · Redo for INSERT buffered</b> — <code>MLOG_UNDO_HDR_CREATE</code> for the new undo header, <code>MLOG_REC_INSERT</code> for the row insert. Both live in the redo log buffer in RAM.' },
      { do: () => { st.focus = 'redoFile';
                    st.redoFile = [100, 110];
                    st.redoBuf = [];   // buffer drains as records are persisted
                    st.arrows = [{ from: 'row-rollptr', to: 'insertUndo', color: RED }]; },
        marker: { trx: 'TRX100', kind: 'C' },
        msg: '<b>Step 4 · Redo fsynced at COMMIT (TRX100)</b> — LSN 100, 110 land in the redo log file. The buffer drains as records persist; the row now survives a crash even if the dirty page never made it to its tablespace.' },
      { do: () => { st.focus = 'page';
                    st.row = { trx_id: 101, name: 'bob' };
                    st.redoFile = [100, 110];
                    st.redoBuf = [];
                    st.arrows = [{ from: 'row-rollptr', to: 'insertUndo', color: RED }]; },
        marker: { trx: 'TRX101', kind: 'U' },
        msg: '<b>Step 5 · UPDATE row (TRX101)</b> — name \'alice\' → \'bob\'. The page row\'s TRX_ID jumps to tx_101.' },
      { do: () => { st.focus = 'rseg-update';
                    st.redoBuf = [];
                    st.updateUndos = [{ trx_id: 101 }];
                    st.arrows = [
                      { from: 'row-rollptr',  to: 'updateUndo-0',      color: RED },
                      { from: 'updateUndo-0', to: 'insertUndo-bottom', color: PURPLE }
                    ]; },
        msg: '<b>Step 6 · Update undo created</b> — Rseg 0 writes a <code>TRX_UNDO_UPD_EXIST_REC</code> (cyan) carrying the OLD name. ROLL_PTR moves to this fresh undo; its prev_roll_ptr (purple) chains back to the insert undo. That\'s the version chain.' },
      { do: () => { st.focus = 'redoLog';
                    st.redoBuf = ['MLOG_REC_UPDATE_IN_PLACE'];   // only the new record lives in the buffer
                    st.arrows = [
                      { from: 'row-rollptr',  to: 'updateUndo-0',      color: RED },
                      { from: 'updateUndo-0', to: 'insertUndo-bottom', color: PURPLE }
                    ]; },
        msg: '<b>Step 7 · Redo for UPDATE buffered</b> — <code>MLOG_REC_UPDATE_IN_PLACE</code> joins the (now-empty-after-fsync) redo buffer. It records the bytes that changed on the page, not the full row.' },
      { do: () => { st.focus = 'redoFile';
                    st.redoFile = [100, 110, 120, 130];
                    st.redoBuf = [];   // drained by fsync
                    st.arrows = [
                      { from: 'row-rollptr',  to: 'updateUndo-0',      color: RED },
                      { from: 'updateUndo-0', to: 'insertUndo-bottom', color: PURPLE }
                    ]; },
        marker: { trx: 'TRX101', kind: 'C' },
        msg: '<b>Step 8 · Redo fsynced at COMMIT (TRX101)</b> — LSN 120, 130 land in the redo log file. Buffer drains again; the redo file now holds the complete history needed to replay both INSERT and UPDATE.' },
      { do: () => {},
        msg: '<b>Scenario 1 done</b> · INSERT and UPDATE each touch four subsystems: page row, Rseg 0, redo buffer, redo file. Click any marker on the timeline above to jump back, or use ⏮ / ⏭.' }
    ];
  }

  // ===== Scenario 2 — SELECT (MVCC) =====
  // 3 transactions:
  //   TRX100 (id=100): INSERT, COMMIT — initial writer
  //   TRX101 (id=101): R, S, C        — reader (long-lived; opens RV before TRX102 starts)
  //   TRX102 (id=102): UPDATE, COMMIT — concurrent writer; invisible to TRX101's snapshot
  function scenario2() {
    const RED    = '#ff5e5e';
    const PURPLE = 'var(--accent-2)';
    const BLUE   = '#5b9cff';
    function chainArrows() {
      return [
        { from: 'row-rollptr',  to: 'updateUndo-0',      color: RED },
        { from: 'updateUndo-0', to: 'insertUndo-bottom', color: PURPLE }
      ];
    }
    return [
      { do: () => { st.focus = 'page';
                    st.row = { trx_id: 100, name: 'alice' };
                    st.insertUndo = { trx_id: 100 };
                    st.arrows = [{ from: 'row-rollptr', to: 'insertUndo', color: RED }]; },
        marker: { trx: 'TRX100', kind: 'I' },
        msg: '<b>Step 1 · TRX100 INSERT</b> — row PK=42 born with name=\'alice\'. Insert undo (green) created in Rseg 0; row\'s ROLL_PTR points at it.' },
      { do: () => { st.row = { trx_id: 100, name: 'alice' };
                    st.insertUndo = { trx_id: 100 };
                    st.arrows = [{ from: 'row-rollptr', to: 'insertUndo', color: RED }]; },
        marker: { trx: 'TRX100', kind: 'C' },
        msg: '<b>Step 2 · TRX100 COMMIT</b> — insert undo is freed-at-commit (never enters history list). Next allocatable trx_id = 101.' },
      { do: () => { st.focus = 'rv';
                    st.row = { trx_id: 100, name: 'alice' };
                    st.insertUndo = { trx_id: 100 };
                    st.readViews = [{ name: 'RV', up_limit: 102, active: true }];
                    st.arrows = [{ from: 'row-rollptr', to: 'insertUndo', color: RED }]; },
        marker: { trx: 'TRX101', kind: 'R' },
        msg: '<b>Step 3 · TRX101 begins, opens ReadView</b> — TRX101 (id=101) is the only active trx; m_up_limit_id = m_low_limit_id = 102. Anything with trx_id ≥ 102 will be invisible to this snapshot.' },
      { do: () => { st.focus = 'rseg-update';
                    st.row = { trx_id: 102, name: 'bob' };
                    st.insertUndo = { trx_id: 100 };
                    st.updateUndos = [{ trx_id: 102 }];
                    st.readViews = [{ name: 'RV', up_limit: 102, active: true }];
                    st.arrows = chainArrows(); },
        marker: { trx: 'TRX102', kind: 'U' },
        msg: '<b>Step 4 · TRX102 UPDATE</b> — name \'alice\' → \'bob\'. Update undo (cyan) records the OLD name and chains back via prev_roll_ptr (purple) to the insert undo. ROLL_PTR re-routes to the new chain head.' },
      { do: () => { st.row = { trx_id: 102, name: 'bob' };
                    st.insertUndo = { trx_id: 100 };
                    st.updateUndos = [{ trx_id: 102 }];
                    st.readViews = [{ name: 'RV', up_limit: 102, active: true }];
                    st.arrows = chainArrows(); },
        marker: { trx: 'TRX102', kind: 'C' },
        msg: '<b>Step 5 · TRX102 COMMIT</b> — TRX102\'s update undo header is linked into the rseg history list. Live row now reads name=\'bob\' for any new transaction.' },
      { do: () => { st.focus = 'rv';
                    st.row = { trx_id: 102, name: 'bob' };
                    st.insertUndo = { trx_id: 100 };
                    st.updateUndos = [{ trx_id: 102 }];
                    st.readViews = [{ name: 'RV', up_limit: 102, active: true }];
                    st.arrows = [...chainArrows(),
                                 { from: 'rv-RV', to: 'insertUndo', color: BLUE }]; },
        marker: { trx: 'TRX101', kind: 'S' },
        msg: '<b>Step 6 · TRX101 SELECT</b> — walks the chain: live row trx=102 ≥ up_limit=102 → invisible. Walks back via DB_ROLL_PTR to update undo (trx=102) — also invisible. Walks again via prev_roll_ptr to insert undo (trx=100) — visible (100 &lt; 102). Returns name=\'alice\'. <span style="color:#5b9cff">Blue</span> arrow shows where the reader landed.' },
      { do: () => { st.row = { trx_id: 102, name: 'bob' };
                    st.insertUndo = { trx_id: 100 };
                    st.updateUndos = [{ trx_id: 102 }];
                    st.readViews = [{ name: 'RV', up_limit: 102, active: false }];
                    st.arrows = chainArrows(); },
        marker: { trx: 'TRX101', kind: 'C' },
        msg: '<b>Step 7 · TRX101 COMMIT</b> — closes its ReadView. Done — TRX101 saw \'alice\' from a moment in time before TRX102 even started, with zero locks. That\'s MVCC: <em>writers never block readers, readers never block writers</em>.' }
    ];
  }

  // ===== Scenario 3 — PURGE blocked → unblocked =====
  // 3 transactions:
  //   TRX100 (id=100): INSERT, COMMIT — initial writer
  //   TRX101 (id=101): R, C           — long-running reader; opens RV early to block purge
  //   TRX102 (id=102): UPDATE, COMMIT — concurrent writer; its undo enters the history list
  //                                      and is held by TRX101's snapshot
  function scenario3() {
    const RED    = '#ff5e5e';
    const PURPLE = 'var(--accent-2)';
    const BLUE   = '#5b9cff';
    function chainArrows() {
      return [
        { from: 'row-rollptr',  to: 'updateUndo-0',      color: RED },
        { from: 'updateUndo-0', to: 'insertUndo-bottom', color: PURPLE }
      ];
    }
    return [
      { do: () => { st.focus = 'page';
                    st.row = { trx_id: 100, name: 'alice' };
                    st.insertUndo = { trx_id: 100 };
                    st.arrows = [{ from: 'row-rollptr', to: 'insertUndo', color: RED }]; },
        marker: { trx: 'TRX100', kind: 'I' },
        msg: '<b>Step 1 · TRX100 INSERT</b> — row PK=42 born. Insert undo created in Rseg 0.' },
      { do: () => { st.row = { trx_id: 100, name: 'alice' };
                    st.insertUndo = { trx_id: 100 };
                    st.arrows = [{ from: 'row-rollptr', to: 'insertUndo', color: RED }]; },
        marker: { trx: 'TRX100', kind: 'C' },
        msg: '<b>Step 2 · TRX100 COMMIT</b> — insert undo is freed-at-commit (never enters history list).' },
      { do: () => { st.focus = 'rv';
                    st.row = { trx_id: 100, name: 'alice' };
                    st.insertUndo = { trx_id: 100 };
                    st.readViews = [{ name: 'RV', up_limit: 102, active: true }];
                    st.arrows = [{ from: 'row-rollptr', to: 'insertUndo', color: RED }]; },
        marker: { trx: 'TRX101', kind: 'R' },
        msg: '<b>Step 3 · TRX101 begins, opens ReadView EARLY</b> — TRX101 is allocated id=101; its RV captures m_up_limit_id = m_low_limit_id = 102 (next free). From here, purge cannot reap any committed undo whose trx_no needs to remain reachable from this snapshot.' },
      { do: () => { st.focus = 'rseg-update';
                    st.row = { trx_id: 102, name: 'bob' };
                    st.insertUndo = { trx_id: 100 };
                    st.updateUndos = [{ trx_id: 102 }];
                    st.readViews = [{ name: 'RV', up_limit: 102, active: true }];
                    st.arrows = [...chainArrows(),
                                 { from: 'rv-RV', to: 'insertUndo', color: BLUE }]; },
        marker: { trx: 'TRX102', kind: 'U' },
        msg: '<b>Step 4 · TRX102 UPDATE</b> — name → \'bob\'. Update undo (cyan) created; chain links back to the insert undo. Blue arrow shows where TRX101 would land if it did a SELECT now (insert undo with trx=100, &lt; up_limit=102).' },
      { do: () => { st.row = { trx_id: 102, name: 'bob' };
                    st.insertUndo = { trx_id: 100 };
                    st.updateUndos = [{ trx_id: 102 }];
                    st.historyList = ['trx_102'];
                    st.readViews = [{ name: 'RV', up_limit: 102, active: true }];
                    st.arrows = [...chainArrows(),
                                 { from: 'rv-RV', to: 'insertUndo', color: BLUE }]; },
        marker: { trx: 'TRX102', kind: 'C' },
        msg: '<b>Step 5 · TRX102 COMMIT</b> — at commit, TRX102\'s update undo header\'s <code>TRX_UNDO_HISTORY_NODE</code> is linked into the rseg history list. <code>trx_102</code> appears in the History List panel — queued for purge.' },
      { do: () => { st.focus = 'purge';
                    st.purgeActive = true;
                    st.blockedAt = 'trx_102';
                    st.row = { trx_id: 102, name: 'bob' };
                    st.insertUndo = { trx_id: 100 };
                    st.updateUndos = [{ trx_id: 102 }];
                    st.historyList = ['trx_102'];
                    st.readViews = [{ name: 'RV', up_limit: 102, active: true }];
                    st.arrows = [...chainArrows(),
                                 { from: 'rv-RV', to: 'insertUndo', color: BLUE },
                                 { from: 'worker2', to: 'history-first', color: 'var(--err)', dashed: true }]; },
        msg: '<b>Step 6 · PURGE attempted, BLOCKED</b> — Worker walks the History List, reaches <code>trx_102</code>. But TRX101 is still active; its snapshot needs the chain reachable. Worker leaves it. Red <em>blocked on trx_102</em> indicator lights up.' },
      { do: () => { st.purgeActive = false;
                    st.blockedAt = null;
                    st.row = { trx_id: 102, name: 'bob' };
                    st.insertUndo = { trx_id: 100 };
                    st.updateUndos = [{ trx_id: 102 }];
                    st.historyList = ['trx_102'];
                    st.readViews = [{ name: 'RV', up_limit: 102, active: false }];
                    st.arrows = chainArrows(); },
        marker: { trx: 'TRX101', kind: 'C' },
        msg: '<b>Step 7 · TRX101 COMMIT</b> — long-running reader finishes; its ReadView closes. With no active readers, the purge low-water-mark advances to ∞.' },
      { do: () => { st.focus = 'purge';
                    st.purgeActive = true;
                    st.row = { trx_id: 102, name: 'bob' };
                    st.insertUndo = { trx_id: 100 };
                    st.updateUndos = [{ trx_id: 102 }];
                    st.historyList = ['trx_102'];
                    st.truncated = ['trx_102'];
                    st.arrows = [...chainArrows(),
                                 { from: 'worker2', to: 'history-first', color: 'var(--ok)' }]; },
        msg: '<b>Step 8 · PURGE succeeds</b> — Worker reaps <code>trx_102</code>. Update undo card turns ✓ purged; history entry dims out. The live row\'s DB_ROLL_PTR now dangles into freed memory — harmless: any new reader has up_limit &gt; 102 and reads the live row directly without walking the chain.' }
    ];
  }

  // ===== Wire controls =====
  section.querySelector('[data-act="uf-A"]').addEventListener('click',     () => { loadScenario(scenario1()); });
  section.querySelector('[data-act="uf-B"]').addEventListener('click',     () => { loadScenario(scenario2()); });
  section.querySelector('[data-act="uf-C"]').addEventListener('click',     () => { loadScenario(scenario3()); });
  section.querySelector('[data-act="uf-prev"]').addEventListener('click',  () => { cancelTimer(); prevStep(); });
  section.querySelector('[data-act="uf-next"]').addEventListener('click',  () => { cancelTimer(); nextStep(); });
  section.querySelector('[data-act="uf-play"]').addEventListener('click',  () => { play(); });
  section.querySelector('[data-act="uf-reset"]').addEventListener('click', () => {
    cancelTimer(); reset(); scenario = { steps: [], idx: -1, lanes: new Map() };
    log('Reset. Pick a scenario above to begin.'); render();
  });

  render();
})();
