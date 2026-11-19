/* page.js — ② Leaf Page & Slots: regions + page directory */
(function () {
  const section = document.getElementById('page');
  section.innerHTML = `
    <h2><span class="no">②</span>Leaf Page &amp; Slots</h2>
    <p class="lead">Every byte InnoDB touches lives in a 16 KB page. An <code>INDEX</code> page has fixed regions — and a clever trick: records are stored on the <b>heap</b> (in insertion order) but linked together in <b>key order</b>, with a sparse <em>page directory</em> enabling O(log n) search within the page.</p>

    <div class="chips">
      <span class="chip"><span class="sw" style="background:var(--purple)"></span>FIL / page header</span>
      <span class="chip"><span class="sw" style="background:var(--ink-dim)"></span>INFIMUM · SUPREMUM</span>
      <span class="chip"><span class="sw" style="background:var(--blue)"></span>user records</span>
      <span class="chip"><span class="sw" style="background:var(--border)"></span>free space</span>
      <span class="chip"><span class="sw" style="background:var(--orange)"></span>page directory</span>
    </div>

    <div class="two-col">
      <div class="viz-container" style="padding:24px">
        <svg id="page-svg" viewBox="0 0 760 440" style="width:100%;height:auto"></svg>
      </div>
      <div>
        <h3>Hover any region</h3>
        <div class="inspector" id="page-inspector">Click a region to see what it stores.</div>
      </div>
    </div>

    <h3 style="margin-top:56px">Heap order vs key order — the page directory</h3>
    <p style="max-width:760px">Records are written to the heap in <b>insertion order</b> (whatever order you <code>INSERT</code>ed them). But they're linked via <code>next_record_offset</code> in <em>key</em> order. The page directory is a sparse array of offsets — every ~4–8th record in key order gets a slot, so binary search can jump close to any key in O(log n) without walking the linked list from <code>INFIMUM</code>.</p>
    <div class="viz-container" style="padding:24px">
      <svg id="pgdir-svg" viewBox="0 0 960 480" style="width:100%;height:auto"></svg>
    </div>
    <p class="ref"><code>storage/innobase/include/page0page.h</code> · <code>page/page0cur.cc:page_cur_search</code> · <a href="#record" style="color:var(--accent)">Next: the anatomy of one record</a></p>
  `;

  // ---------- ① Page regions ----------
  const regions = [
    { id:'pg-h',    label:'Page header',    size:'56 B',     cls:'seg-header',  y0:0.06, y1:0.16, desc:'PAGE_N_RECS, PAGE_HEAP_TOP, PAGE_LAST_INSERT, PAGE_LEVEL (leaf=0), PAGE_MAX_TRX_ID (last writer).<br>File: <span class="val">include/page0page.h</span>' },
    { id:'inf',     label:'INFIMUM',        size:'13 B',     cls:'seg-inf',     y0:0.16, y1:0.22, desc:'The "smaller than everything" sentinel. The record linked-list starts here. REC_STATUS = 2.' },
    { id:'records', label:'User records',   size:'grows ↓',  cls:'seg-record',  y0:0.22, y1:0.62, desc:'Actual row data. Stored in insertion order on the heap, but singly-linked in <em>key order</em> via each record\'s "next-record offset".' },
    { id:'free',    label:'Free space',     size:'shrinks',  cls:'seg-free',    y0:0.62, y1:0.80, desc:'Unused bytes between the user-record heap (growing down) and the page directory (growing up).' },
    { id:'dir',     label:'Page directory', size:'grows ↑',  cls:'seg-dir',     y0:0.80, y1:0.90, desc:'Sparse index of record offsets — one slot every 4–8 records — enables binary search inside the page. Grows from the bottom of the page upward.' },
    { id:'sup',     label:'SUPREMUM',       size:'13 B',     cls:'seg-sup',     y0:0.90, y1:0.96, desc:'The "larger than everything" sentinel. Terminates the linked list. REC_STATUS = 3.' },
    { id:'trl',     label:'FIL trailer',    size:'8 B',      cls:'seg-trailer', y0:0.96, y1:1.00, desc:'LSN + checksum repeated — lets a torn write be detected when reading the page back from disk.' }
  ];
  // FIL header is the very top
  regions.unshift({ id:'fil', label:'FIL header', size:'38 B', cls:'seg-trailer', y0:0.0, y1:0.06,
    desc:'Space ID, page number, prev/next page pointers (sibling leaf pages), flush LSN, type (FIL_PAGE_INDEX), checksum.<br>File: <span class="val">include/fil0fil.h</span>' });

  function highlight(id) {
    d3.selectAll('#page-svg .seg').classed('dim', function () { return this.getAttribute('data-id') !== id; });
    const r = regions.find(x => x.id === id);
    if (r) d3.select('#page-inspector').html(`<b>${r.label}</b> <span class="dim">(${r.size})</span><br><br>${r.desc}`);
  }

  function renderPage() {
    const svg = d3.select('#page-svg');
    installArrowDefs(svg);
    const pageX = 60, pageY = 30, pageW = 540, pageH = 360;

    // page frame
    svg.append('rect').attr('x', pageX).attr('y', pageY).attr('width', pageW).attr('height', pageH).attr('rx', 6)
       .attr('fill', 'var(--bg-2)').attr('stroke', 'var(--border-2)');
    svg.append('text').attr('x', pageX).attr('y', 22).attr('class', 'lbl-mono-dim')
       .text('PAGE #42 · 16 KB · INDEX');

    // regions
    const g = svg.append('g').attr('class', 'regions');
    g.selectAll('g.region').data(regions).join('g').attr('class', 'region')
      .each(function (d) {
        const y = pageY + d.y0 * pageH;
        const h = (d.y1 - d.y0) * pageH;
        const gEl = d3.select(this);
        gEl.append('rect').attr('class', 'seg ' + d.cls)
           .attr('x', pageX).attr('y', y).attr('width', pageW).attr('height', h)
           .attr('data-id', d.id)
           .on('mouseenter', () => highlight(d.id))
           .on('click',      () => highlight(d.id));
        gEl.append('text').attr('x', pageX + 14).attr('y', y + h / 2 + 4).attr('class', 'lbl')
           .attr('fill', h < 24 ? 'var(--ink-2)' : 'var(--bg)').text(d.label);
        gEl.append('text').attr('x', pageX + pageW - 14).attr('y', y + h / 2 + 4).attr('text-anchor', 'end')
           .attr('class', 'lbl-mono-dim')
           .attr('fill', h < 24 ? 'var(--ink-dim)' : 'rgba(10,14,26,0.65)').text(d.size);
      });

    highlight('records');
  }

  // ---------- ② Page directory: heap order vs key order ----------
  const inserted = [42, 8, 67, 15, 23, 95, 4, 31];

  function renderPgDir() {
    const dsvg = d3.select('#pgdir-svg');
    dsvg.selectAll('*').remove();
    installArrowDefs(dsvg);

    // ONE consistent x-grid: 10 columns = INFIMUM + 8 records + SUPREMUM
    const gx0 = 40, gx1 = 920;
    const COLS = inserted.length + 2;
    const colW = (gx1 - gx0) / COLS;
    const colX = (i) => gx0 + i * colW + colW / 2;

    // heap_no: infimum=0, supremum=1, user records in insertion order at hno=2..N
    const heap = inserted.map((k, i) => ({ key: k, hno: i + 2 }));
    const sortedHeap = [...heap].sort((a, b) => a.key - b.key);
    const heapColByKey = {};
    heap.forEach((r, i) => heapColByKey[r.key] = i + 1);

    // Layout y-positions
    const heapY = 40,  cellH = 48;     // top lane
    const ringY = 240,  nodeR  = 22;    // middle lane (shifted down for arc room)
    const slotY = 332,  slotH = 44, slotW = 130, slotGap = 14;
    const captionY = 410;

    // ---- TITLES ----
    dsvg.append('text').attr('x', 40).attr('y', 26).attr('class', 'lbl-mono-dim')
        .text('PAGE HEAP · INSERTION ORDER · ADDRESSED BY HEAP_NO');
    dsvg.append('text').attr('x', 40).attr('y', 130).attr('class', 'lbl-mono-dim')
        .text('LINKED LIST VIA NEXT_RECORD_OFFSET · KEY ORDER · HOVER A NODE TO TRACE THE WALK');
    dsvg.append('text').attr('x', 40).attr('y', 316).attr('class', 'lbl-mono-dim')
        .text('PAGE DIRECTORY · SPARSE SLOT TABLE · BINARY SEARCH ENTRY POINTS');

    // ---- HEAP LANE (top) — interactive ----
    function heapCell(col, displayKey, label, stroke) {
      const w = colW - 10, cx = colX(col), x = cx - w / 2;
      const g = dsvg.append('g').attr('class', 'rec-col hover-target')
                    .attr('data-key', String(displayKey)).style('cursor', 'pointer');
      g.append('rect').attr('class', 'heap-rect')
       .attr('x', x).attr('y', heapY).attr('width', w).attr('height', cellH).attr('rx', 5)
       .attr('fill', 'var(--panel-2)').attr('stroke', stroke).attr('stroke-width', 1.2);
      g.append('text').attr('x', cx).attr('y', heapY + 18).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono-dim').text(label.hno);
      g.append('text').attr('x', cx).attr('y', heapY + 36).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono').text(label.k);
      g.on('mouseenter', () => setActive(String(displayKey)))
       .on('mouseleave', () => setActive(null));
      return g;
    }
    heapCell(0, 'INF', { hno:'HNO 0', k:'INF' }, 'var(--ink-dim)');
    heap.forEach((r, i) => heapCell(i + 1, r.key, { hno:`HNO ${r.hno}`, k:`k=${r.key}` }, 'var(--orange)'));
    heapCell(COLS - 1, 'SUP', { hno:'HNO 1', k:'SUP' }, 'var(--ink-dim)');

    // ---- LINKED LIST chain — arcs first, then circles on top ----
    const chain = [
      { key:'INF', col:0 },
      ...sortedHeap.map(r => ({ key: String(r.key), col: heapColByKey[r.key] })),
      { key:'SUP', col: COLS - 1 }
    ];

    // Arcs: stagger height by horizontal distance so long jumps go higher.
    // All arcs go UP — direction is shown by the arrowhead.
    for (let i = 0; i < chain.length - 1; i++) {
      const from = chain[i], to = chain[i + 1];
      const goingForward = to.col > from.col;
      const distance     = Math.abs(to.col - from.col);
      const arch         = 18 + distance * 8;     // 26..82 px
      const peakY        = ringY - arch;
      const x1 = colX(from.col) + (goingForward ?  nodeR : -nodeR);
      const x2 = colX(to.col)   + (goingForward ? -nodeR :  nodeR);
      const c1x = x1 + (x2 - x1) * 0.20;
      const c2x = x1 + (x2 - x1) * 0.80;
      dsvg.append('path')
          .attr('class', 'chain-arc')
          .attr('data-from', from.key).attr('data-to', to.key).attr('data-step', i)
          .attr('d', `M${x1},${ringY} C${c1x},${peakY} ${c2x},${peakY} ${x2},${ringY}`)
          .attr('fill', 'none')
          .attr('stroke', 'var(--ink-dim)').attr('stroke-width', 1.5)
          .attr('opacity', 0.20)
          .attr('marker-end', 'url(#arrow-head)');
    }

    // Circles (drawn last so they sit on top of arc endpoints)
    function drawCircle(node, stroke) {
      const cx = colX(node.col);
      const g = dsvg.append('g').attr('class', 'kr-circle hover-target')
                    .attr('data-key', node.key).style('cursor', 'pointer');
      g.append('circle').attr('class', 'kr-disc')
       .attr('cx', cx).attr('cy', ringY).attr('r', nodeR)
       .attr('fill', 'var(--panel-2)').attr('stroke', stroke).attr('stroke-width', 1.5);
      g.append('text').attr('x', cx).attr('y', ringY + 4).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono')
       .text(node.key === 'INF' ? 'INF' : node.key === 'SUP' ? 'SUP' : `k=${node.key}`);
      g.on('mouseenter', () => setActive(node.key))
       .on('mouseleave', () => setActive(null));
    }
    chain.forEach(node => {
      drawCircle(node, node.key === 'INF' || node.key === 'SUP' ? 'var(--ink-dim)' : 'var(--accent)');
    });

    // ---- PAGE DIRECTORY (bottom) — interactive ----
    const slotKeys = [
      { ptr:'INF',  target:'INF' },
      { ptr:'k=8',  target:'8'   },
      { ptr:'k=23', target:'23'  },
      { ptr:'k=42', target:'42'  },
      { ptr:'k=95', target:'95'  },
      { ptr:'SUP',  target:'SUP' }
    ];
    slotKeys.forEach((s, i) => {
      const x = 40 + i * (slotW + slotGap);
      const g = dsvg.append('g').attr('class', 'pd-slot hover-target')
                    .attr('data-key', s.target).style('cursor', 'pointer');
      g.append('rect').attr('class', 'pd-rect')
       .attr('x', x).attr('y', slotY).attr('width', slotW).attr('height', slotH).attr('rx', 5)
       .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--orange)').attr('stroke-width', 1.5);
      g.append('text').attr('x', x + slotW / 2).attr('y', slotY + 18).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono-dim').text(`SLOT ${i}`);
      g.append('text').attr('x', x + slotW / 2).attr('y', slotY + 36).attr('text-anchor', 'middle')
       .attr('class', 'lbl-mono').text(`→ ${s.ptr}`);
      // dotted up-link to the corresponding linked-list circle
      const cx = s.target === 'INF' ? colX(0)
               : s.target === 'SUP' ? colX(COLS - 1)
               : colX(heapColByKey[parseInt(s.target, 10)]);
      dsvg.append('path').attr('class', 'pd-link')
          .attr('data-key', s.target)
          .attr('d', `M${x + slotW / 2},${slotY} L${cx},${ringY + nodeR + 2}`)
          .attr('stroke', 'var(--border-2)').attr('fill', 'none').attr('stroke-dasharray', '3 3')
          .attr('opacity', 0.55);
      g.on('mouseenter', () => setActive(s.target))
       .on('mouseleave', () => setActive(null));
    });

    // ---- Caption ----
    dsvg.append('text').attr('x', 40).attr('y', captionY).attr('class', 'lbl')
        .text('To find key 31: binary-search over slots → slot 2 (k=23) ≤ 31 < slot 3 (k=42) → walk the list 23 → 31 (one hop).');
    dsvg.append('text').attr('x', 40).attr('y', captionY + 22).attr('class', 'lbl-dim').attr('font-size', 12)
        .text('Hover any heap cell, linked-list node, or page-directory slot to highlight the same record across all three lanes.');

    // ---- INTERACTIVITY ----
    function setActive(activeKey) {
      // Reset everything to the resting state
      dsvg.selectAll('.heap-rect').attr('stroke-width', 1.2);
      dsvg.selectAll('.kr-disc')
          .attr('stroke-width', 1.5)
          .attr('stroke', function () { const k = this.parentNode.getAttribute('data-key');
            return k === 'INF' || k === 'SUP' ? 'var(--ink-dim)' : 'var(--accent)'; });
      dsvg.selectAll('.chain-arc')
          .attr('stroke', 'var(--ink-dim)').attr('stroke-width', 1.5)
          .attr('opacity', 0.20).attr('marker-end', 'url(#arrow-head)');
      dsvg.selectAll('.pd-rect').attr('stroke-width', 1.5);
      dsvg.selectAll('.pd-link').attr('opacity', 0.55).attr('stroke', 'var(--border-2)');
      if (activeKey == null) return;

      // Highlight matching cells in all three lanes
      dsvg.selectAll(`.rec-col[data-key="${activeKey}"] .heap-rect`).attr('stroke-width', 2.5);
      dsvg.selectAll(`.kr-circle[data-key="${activeKey}"] .kr-disc`)
          .attr('stroke', 'var(--accent)').attr('stroke-width', 3);
      dsvg.selectAll(`.pd-slot[data-key="${activeKey}"] .pd-rect`).attr('stroke-width', 2.5);
      dsvg.selectAll(`.pd-link[data-key="${activeKey}"]`)
          .attr('opacity', 1).attr('stroke', 'var(--orange)');

      // Highlight the two arcs that touch this node (incoming + outgoing)
      dsvg.selectAll('.chain-arc')
          .filter(function () {
            return this.getAttribute('data-from') === activeKey
                || this.getAttribute('data-to')   === activeKey;
          })
          .attr('stroke', 'var(--accent)').attr('stroke-width', 2.5)
          .attr('opacity', 1).attr('marker-end', 'url(#arrow-head-acc)');
    }

    setActive(null);
  }

  renderPage();
  renderPgDir();
})();
