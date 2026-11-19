/* readview.js — ⑫ Read View + ⑬ Visibility (one module covers both sections) */
(function () {
  // ===== ⑫ Read View =====
  const rv = document.getElementById('readview');
  rv.innerHTML = `
    <h2><span class="no">⑬</span>Read View</h2>
    <p class="lead">A ReadView is the snapshot MVCC uses to answer "what does this SELECT see?" It captures three things about the trx id space — the smallest active id, the next free id, and the list of active ids in between. Watch how different readers see different answers.</p>
    <h3>Transaction timeline</h3>
    <p>Five transactions on row acct=42. Click either ReadView marker to re-run the walk with that reader's snapshot.</p>
    <div class="viz-container" style="padding:24px">
      <svg id="rv-time" viewBox="0 0 1200 360" style="width:100%;height:auto"></svg>
    </div>
    <details class="explain" open><summary>How <code>m_up_limit_id</code> is computed</summary><div class="body">Smallest currently-active trx id at snapshot time. Anything strictly less is committed; visible.</div></details>
    <details class="explain"><summary>How <code>m_low_limit_id</code> is computed</summary><div class="body">The next trx id to be allocated (= max_assigned + 1). Anything ≥ this hasn't started yet at snapshot time.</div></details>
    <details class="explain"><summary>How <code>m_ids[]</code> is populated</summary><div class="body">The set of trx ids that were active at snapshot time. Active = invisible. Their commits, if they happen later, won't change this snapshot.</div></details>
    <p class="ref"><code>read/read0read.cc:view_open</code> · <code>read0types.h</code></p>
    <p class="ref" style="color:var(--accent)"><a href="#visibility" style="color:var(--accent)">Next: how the ReadView decides visibility during a SELECT</a></p>
  `;

  // ===== ⑬ Visibility =====
  const vis = document.getElementById('visibility');
  vis.innerHTML = `
    <h2><span class="no">⑭</span>Visibility</h2>
    <p class="lead">When a SELECT walks a row's version chain, it asks the ReadView "can I see this version?" for each node. We stop at the first visible one and return it. Switch readers to see how different snapshots produce different answers on the same chain.</p>
    <h3>Walking the version chain</h3>
    <div class="controls">
      <button class="btn primary" data-act="vis-A">Use reader A (tx_150)</button>
      <button class="btn"          data-act="vis-B">Use reader B (tx_155)</button>
      <button class="btn"          data-act="vis-step">Step ▶</button>
      <button class="btn"          data-act="vis-reset">↺ Reset</button>
    </div>
    <pre id="vis-snapshot" style="font-family:'JetBrains Mono',monospace;font-size:11.5px;color:var(--err);background:var(--panel);border:1px solid var(--border);border-radius:6px;padding:12px 14px;white-space:pre-wrap;line-height:1.5"></pre>
    <div class="viz-container" style="padding:24px">
      <svg id="vis-svg" viewBox="0 0 1200 540" style="width:100%;height:auto"></svg>
    </div>
    <div class="inspector" id="vis-log"></div>
  `;

  // RV B is now opened while tx_150 is still in flight (it never committed),
  // so its m_up_limit_id pins to 150 and m_ids = [150]. That's both more
  // realistic and gives the snapshot fields meaningful values.
  const READERS = {
    A: { name: 'tx_150', m_low_limit_id: 151, m_up_limit_id: 149, m_ids: [148, 149], m_creator_trx_id: 150, openedAt: 4 },
    B: { name: 'tx_155', m_low_limit_id: 156, m_up_limit_id: 150, m_ids: [150],      m_creator_trx_id: 155, openedAt: 9 }
  };
  const VERSIONS = [
    { lane: 'LIVE ROW',  committed_at: 'T=8', balance: '$500',  trx_id: 'tx_152', roll: '→ undo (tx_149)' },
    { lane: 'UNDO #4',   committed_at: 'T=5', balance: '$1500', trx_id: 'tx_149', roll: '→ undo (tx_148)' },
    { lane: 'UNDO #3',   committed_at: 'T=4', balance: '$200',  trx_id: 'tx_148', roll: '→ undo (tx_145)' },
    { lane: 'UNDO #2',   committed_at: 'T=3', balance: '$1000', trx_id: 'tx_145', roll: '→ undo (tx_100)' },
    { lane: 'UNDO #1',   committed_at: 'T=1', balance: '$500',  trx_id: 'tx_100', roll: 'NULL' }
  ];
  let cur = 'A';
  let walkStep = 0;     // number of version-chain cards already checked (0 = walk hasn't started)

  function visible(trx_id, r) {
    const tid = parseInt(trx_id.split('_')[1], 10);
    if (tid === r.m_creator_trx_id) return true;
    if (tid <  r.m_up_limit_id)     return true;
    if (tid >= r.m_low_limit_id)    return false;
    if (r.m_ids.includes(tid))      return false;
    return true;
  }

  function renderTimeline() {
    const svg = d3.select('#rv-time'); svg.selectAll('*').remove(); installArrowDefs(svg);

    // viewBox 1200 × 360. Bands:
    //   y=0..40    Header — RV buttons (left) + snapshot title (centered at snapX)
    //   y=44..230  Timeline body (tinted regions, captions, trx spans, axis)
    //   y=240..330 Snapshot field pills
    const X0 = 24, X1 = 1140;
    const T  = 1100;
    const TIMELINE_TOP    = 50;
    const TIMELINE_BOTTOM = 230;
    const SPAN_Y0         = 76;
    const SPAN_GAP        = 18;
    const trackY          = 210;

    // Two kinds of trx on the timeline:
    //   kind:'writer' — modifies the row, has open + commit dots, money pill
    //   kind:'reader' — opens a ReadView; for this demo both readers are still
    //                   in flight when their snapshot is taken, so we draw the
    //                   span to the right edge with no commit dot. This makes
    //                   it obvious why tx_150 ∈ m_ids when Reader B opens.
    const events = [
      { id:'tx_100', kind:'writer', open:  20, commit:  80, money:'$100'  },
      { id:'tx_145', kind:'writer', open:  60, commit: 200, money:'$200'  },
      { id:'tx_148', kind:'writer', open: 200, commit: 600, money:'$500'  },
      { id:'tx_149', kind:'writer', open: 220, commit: 500, money:'$300'  },
      { id:'tx_152', kind:'writer', open: 480, commit: 950, money:'$1000' },
      { id:'tx_150', kind:'reader', open: 300, pending: true },
      { id:'tx_155', kind:'reader', open: 900, pending: true }
    ];
    const READERS_T = { A: 400, B: 980 };

    function tx(t) { return X0 + (t / T) * (X1 - X0); }
    const snapT = READERS_T[cur];
    const snapX = tx(snapT);

    // ----- BEFORE / AFTER tinted regions -----
    svg.append('rect').attr('x', X0).attr('y', TIMELINE_TOP).attr('width', snapX - X0).attr('height', TIMELINE_BOTTOM - TIMELINE_TOP).attr('rx', 6)
       .attr('fill', 'rgba(74,242,118,0.06)').attr('stroke', 'rgba(74,242,118,0.25)');
    svg.append('rect').attr('x', snapX).attr('y', TIMELINE_TOP).attr('width', X1 - snapX).attr('height', TIMELINE_BOTTOM - TIMELINE_TOP).attr('rx', 6)
       .attr('fill', 'rgba(242,92,92,0.06)').attr('stroke', 'rgba(242,92,92,0.25)');

    // ----- region captions inside their own band -----
    svg.append('text').attr('x', X0 + 12).attr('y', TIMELINE_TOP + 16).attr('class', 'lbl-mono-dim').attr('font-size', 10).attr('fill', 'var(--green)').text('BEFORE SNAPSHOT · could be visible');
    svg.append('text').attr('x', X1 - 12).attr('y', TIMELINE_TOP + 16).attr('text-anchor', 'end').attr('class', 'lbl-mono-dim').attr('font-size', 10).attr('fill', 'var(--err)').text('AFTER SNAPSHOT · invisible');

    // ----- wall-clock axis -----
    svg.append('line').attr('x1', X0).attr('y1', trackY).attr('x2', X1).attr('y2', trackY)
       .attr('stroke', 'var(--border-2)');
    svg.append('text').attr('x', X1 + 6).attr('y', trackY + 4).attr('class', 'lbl-mono-dim').attr('font-size', 11).text('→ WALL CLOCK');
    for (let t = 0; t <= T; t += 100) {
      svg.append('line').attr('x1', tx(t)).attr('y1', trackY - 4).attr('x2', tx(t)).attr('y2', trackY + 4)
         .attr('stroke', 'var(--border-2)');
    }

    // ----- transaction spans (well-spaced rows) -----
    // Writers: open dot → orange line → green commit dot, with money pill.
    // Readers (tx_150, tx_155): open dot → cyan line that runs off the right
    // edge with a dashed tail (no commit dot), labeled "(in flight)" — so the
    // user can see exactly why tx_150 is in m_ids when Reader B's snapshot is
    // taken at t=980.
    events.forEach((e, i) => {
      const ox = tx(e.open);
      const ey = SPAN_Y0 + i * SPAN_GAP;
      const isReader = e.kind === 'reader';
      const lineColor = isReader ? 'var(--accent)' : 'var(--orange)';
      const cx = isReader ? X1 : tx(e.commit);

      // open dot
      svg.append('circle').attr('cx', ox).attr('cy', ey).attr('r', 4).attr('fill', lineColor);

      if (isReader) {
        // Solid portion to ~80% of the way; dashed tail to the right edge.
        const splitX = ox + (X1 - ox) * 0.78;
        svg.append('line').attr('x1', ox).attr('y1', ey).attr('x2', splitX).attr('y2', ey)
           .attr('stroke', lineColor).attr('stroke-width', 2).attr('opacity', 0.9);
        svg.append('line').attr('x1', splitX).attr('y1', ey).attr('x2', X1).attr('y2', ey)
           .attr('stroke', lineColor).attr('stroke-width', 2).attr('opacity', 0.7).attr('stroke-dasharray', '4 4');
        // Inline label above the open dot — easier to find than mid-span
        svg.append('text').attr('x', ox + 8).attr('y', ey - 6)
           .attr('class', 'lbl-mono').attr('font-size', 10).attr('fill', lineColor).text(`${e.id} (still in flight)`);
      } else {
        svg.append('line').attr('x1', ox).attr('y1', ey).attr('x2', cx).attr('y2', ey)
           .attr('stroke', lineColor).attr('stroke-width', 2).attr('opacity', 0.9);
        svg.append('circle').attr('cx', cx).attr('cy', ey).attr('r', 4).attr('fill', 'var(--ok)');
        const midX = (ox + cx) / 2;
        svg.append('text').attr('x', midX).attr('y', ey - 5).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 10).attr('fill', lineColor).text(e.id);
        svg.append('text').attr('x', cx + 8).attr('y', ey + 4).attr('class', 'lbl-mono')
           .attr('font-size', 10).attr('fill', 'var(--ok)').text(e.money);
      }
    });

    // ----- snapshot marker (dashed line through the entire timeline body) -----
    svg.append('line').attr('x1', snapX).attr('y1', TIMELINE_TOP - 6).attr('x2', snapX).attr('y2', TIMELINE_BOTTOM + 8)
       .attr('stroke', 'var(--accent)').attr('stroke-width', 1.5).attr('stroke-dasharray', '5 4');
    // Snapshot title — centered at snapX, lives in the HEADER band (y=0..40)
    svg.append('text').attr('x', snapX).attr('y', 26).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono').attr('font-size', 13).attr('fill', 'var(--accent)')
       .text(`👁 ${READERS[cur].name} opens ReadView`);

    // ----- Reader buttons (top-left, in the header band) -----
    // Use inline .style('fill') so the active-state dark text isn't overridden
    // by the .lbl-mono CSS class fill (which would wash out contrast).
    [['A', 'tx_150'], ['B', 'tx_155']].forEach(([key, name], i) => {
      const isActive = cur === key;
      const bx = 12 + i * 130, by = 8;
      const r = svg.append('rect').attr('x', bx).attr('y', by).attr('width', 118).attr('height', 24).attr('rx', 5)
         .style('fill', isActive ? 'var(--accent)' : 'var(--panel)').style('stroke', 'var(--accent)').attr('stroke-width', 1.5)
         .style('cursor', 'pointer');
      r.on('click', () => { cur = key; renderAll(); });
      svg.append('text').attr('x', bx + 59).attr('y', by + 16).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 11)
         .style('fill', isActive ? 'var(--bg)' : 'var(--accent)')
         .attr('font-weight', 600)
         .style('pointer-events', 'none').text(`RV ${key} · ${name}`);
    });

    // ----- snapshot field pills (in their own band, well below the timeline) -----
    const r = READERS[cur];
    const pills = [
      { l:'m_up_limit_id',    v: r.m_up_limit_id,            color:'var(--green)' },
      { l:'m_low_limit_id',   v: r.m_low_limit_id,           color:'var(--orange)' },
      { l:'m_ids',            v: `[${r.m_ids.join(', ')}]`,  color:'var(--warn)' },
      { l:'m_creator_trx_id', v: r.m_creator_trx_id,         color:'var(--accent-2)' }
    ];
    const pillW = 260, pillGap = 18, pillsTotal = 4 * pillW + 3 * pillGap;
    const pillX0 = (1200 - pillsTotal) / 2;
    pills.forEach((p, i) => {
      const x = pillX0 + i * (pillW + pillGap);
      svg.append('rect').attr('x', x).attr('y', 286).attr('width', pillW).attr('height', 42).attr('rx', 6)
         .attr('fill', 'var(--panel-2)').attr('stroke', p.color).attr('stroke-width', 1.5);
      svg.append('text').attr('x', x + 14).attr('y', 308).attr('class', 'lbl-mono')
         .attr('font-size', 11).attr('fill', p.color).text(p.l);
      svg.append('text').attr('x', x + pillW - 14).attr('y', 316).attr('text-anchor', 'end')
         .attr('class', 'lbl-mono').attr('font-size', 14).text(p.v);
    });
  }

  function renderSnapshot() {
    const r = READERS[cur];
    document.getElementById('vis-snapshot').textContent =
`Reader ${cur} (${r.name}) opened ReadView at t=${r.openedAt}.

  m_creator_trx_id = ${r.m_creator_trx_id}     ← our own id
  m_up_limit_id    = ${r.m_up_limit_id}     ← smallest active trx at snapshot = min(${r.m_ids.length ? r.m_ids.join(', ') : '—'})
  m_low_limit_id   = ${r.m_low_limit_id}     ← next trx_id to be allocated (= max_allocated ${r.m_low_limit_id - 1} + 1)
  m_ids[]          = [${r.m_ids.join(', ')}]   ← active writer trx

A version's DB_TRX_ID is tested in this order:
  1. id == m_creator_trx_id    → visible (our own writes)
  2. id <  m_up_limit_id       → visible (commit happened before snapshot)
  3. id >= m_low_limit_id      → invisible (from future)
  4. else if id ∈ m_ids        → invisible (was active)
  5. else                      → visible (committed inside the open range)`;
  }

  function renderVis() {
    const svg = d3.select('#vis-svg'); svg.selectAll('*').remove(); installArrowDefs(svg);
    const r = READERS[cur];
    const firstVis = VERSIONS.findIndex(v => visible(v.trx_id, r));

    VERSIONS.forEach((v, i) => {
      const y = 16 + i * 98;
      // Walk semantics:
      //   i <  walkStep        → already walked
      //                          (if i === firstVis → green, else red)
      //   i === walkStep       → currently being checked (highlighted yellow)
      //   i >  walkStep        → not yet visited (dim)
      let mode;
      if (walkStep === 0)                      mode = 'pending';
      else if (i < walkStep && i === firstVis) mode = 'visible';
      else if (i < walkStep)                   mode = 'invisible';
      else if (i === walkStep && walkStep <= firstVis) mode = 'checking';
      else                                     mode = 'pending';

      const styles = {
        pending:    { stroke:'var(--border-2)', tag:'— not visited —',     tagC:'var(--ink-dim)', strokeW:1.2, opacity:0.55 },
        checking:   { stroke:'var(--warn)',     tag:'· checking …',         tagC:'var(--warn)',    strokeW:2.5, opacity:1 },
        visible:    { stroke:'var(--ok)',       tag:'✓ VISIBLE — return',   tagC:'var(--ok)',      strokeW:2.5, opacity:1 },
        invisible:  { stroke:'var(--err)',      tag:'✗ invisible — skip',   tagC:'var(--err)',     strokeW:1.8, opacity:1 }
      }[mode];

      const g = svg.append('g').attr('opacity', styles.opacity);
      g.append('rect').attr('x', 28).attr('y', y).attr('width', 1144).attr('height', 84).attr('rx', 6)
        .attr('fill', mode === 'visible' ? 'rgba(74,242,118,0.07)' : (mode === 'invisible' ? 'rgba(242,92,92,0.05)' : 'var(--panel-2)'))
        .attr('stroke', styles.stroke).attr('stroke-width', styles.strokeW);
      g.append('text').attr('x', 40).attr('y', y + 22).attr('class', 'lbl-mono').attr('fill', styles.stroke).text(v.lane);
      g.append('text').attr('x', 220).attr('y', y + 22).attr('class', 'lbl-mono-dim').text(`COMMITTED AT ${v.committed_at}`);
      g.append('text').attr('x', 1160).attr('y', y + 22).attr('text-anchor', 'end').attr('class', 'lbl-mono').attr('fill', styles.tagC).text(styles.tag);

      const cells = [['ID','42'], ['BALANCE', v.balance], ['DB_TRX_ID', v.trx_id], ['DB_ROLL_PTR', v.roll]];
      cells.forEach(([k, val], j) => {
        const x = 40 + j * 282;
        g.append('rect').attr('x', x).attr('y', y + 38).attr('width', 270).attr('height', 38).attr('rx', 4)
          .attr('fill', 'var(--panel)').attr('stroke', styles.stroke);
        g.append('text').attr('x', x + 8).attr('y', y + 54).attr('class', 'lbl-mono-dim').attr('fill', styles.tagC).attr('font-size', 10).text(k);
        g.append('text').attr('x', x + 260).attr('y', y + 66).attr('text-anchor', 'end').attr('class', 'lbl-mono').text(val);
      });
    });

    // Status line per walkStep
    if (walkStep === 0) {
      d3.select('#vis-log').html(`Click <b>Step ▶</b> to start walking the version chain with reader <b>${cur}</b>.`);
    } else if (walkStep === firstVis + 1) {
      const v = VERSIONS[firstVis];
      d3.select('#vis-log').html(`Walk complete · stopped at <b>${v.lane}</b> (<code>${v.trx_id}</code>, ${v.balance}) — first visible version. Reader ${cur} returns balance = <code>${v.balance}</code>.`);
    } else if (walkStep <= firstVis) {
      const v = VERSIONS[walkStep];
      d3.select('#vis-log').html(`Step ${walkStep + 1}: checking <b>${v.lane}</b> (<code>${v.trx_id}</code>) — currently invisible to ${cur}, walk back to next version.`);
    }
  }

  function renderAll() { renderTimeline(); renderSnapshot(); renderVis(); }

  vis.querySelector('[data-act="vis-A"]').addEventListener('click', () => { cur = 'A'; walkStep = 0; renderAll(); });
  vis.querySelector('[data-act="vis-B"]').addEventListener('click', () => { cur = 'B'; walkStep = 0; renderAll(); });
  vis.querySelector('[data-act="vis-step"]').addEventListener('click', () => {
    const r = READERS[cur];
    const firstVis = VERSIONS.findIndex(v => visible(v.trx_id, r));
    // Advance one card at a time until we've revealed the first visible one.
    if (walkStep < firstVis + 1) { walkStep++; renderAll(); }
  });
  vis.querySelector('[data-act="vis-reset"]').addEventListener('click', () => { cur = 'A'; walkStep = 0; renderAll(); });

  renderAll();
})();
