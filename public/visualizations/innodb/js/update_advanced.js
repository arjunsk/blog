/* insert_adv.js — ⑥ Update · Advanced
   6A · Change Buffer        — defer secondary-index writes when the leaf page isn't in BP
   6B · Adaptive Hash Index  — short-circuit B+Tree traversal for hot prefixes

   Reference: storage/innobase/ibuf/ibuf0ibuf.cc, storage/innobase/btr/btr0sea.cc */
(function () {
  const section = document.getElementById('insert-adv');
  section.innerHTML = `
    <h2><span class="no">⑥</span>Update · Advanced</h2>
    <p class="lead">Two optimisations sit on top of the standard write/read path that can dramatically change when and how a secondary index page is touched: the <b>Change Buffer</b> (defer secondary-index writes when the leaf page isn't in the buffer pool) and the <b>Adaptive Hash Index</b> (skip the B+Tree walk when a prefix is hot).</p>

    <h3>6A · Change buffer · deferring secondary-index writes</h3>
    <p>For a secondary, non-unique index, InnoDB can <b>skip</b> reading the leaf page on INSERT / DELETE-MARK / DELETE. It records the operation in a special system tree (the change buffer, a.k.a. insert buffer, ibdata space). The operation is later merged when the page is read for any reason (customer query or a background merger).</p>
    <div class="controls">
      <button class="btn primary" data-act="cb-insert">INSERT into sec-idx row</button>
      <button class="btn"          data-act="cb-select">SELECT that touches the page</button>
      <button class="btn"          data-act="cb-bg">↻ Background merge</button>
      <button class="btn"          data-act="cb-reset">↺ Reset</button>
    </div>
    <div class="viz-container" style="padding:24px">
      <svg id="cb-svg" viewBox="0 0 1100 380" style="width:100%;height:auto"></svg>
    </div>
    <div class="inspector" id="cb-log">Click <b>INSERT</b> when the page isn't in the buffer pool — InnoDB will buffer the change instead of doing a 16 KB random read.</div>

    <h3 style="margin-top:48px">6B · Adaptive Hash Index</h3>
    <p>InnoDB watches the search pattern. If the same leaf page keeps being hit by lookups with the same prefix length, it builds a hash entry <code>(prefix-tuple) → (page + rec-offset)</code>. The next matching search jumps directly to the record, skipping the whole B+Tree traversal.</p>
    <div class="controls">
      <button class="btn primary" data-act="ahi-search">SELECT … WHERE id = 42</button>
      <button class="btn"          data-act="ahi-other">SELECT … WHERE id = 17</button>
      <button class="btn"          data-act="ahi-reset">↺ Reset</button>
    </div>
    <div class="viz-container" style="padding:24px">
      <svg id="ahi-svg" viewBox="0 0 1100 440" style="width:100%;height:auto"></svg>
    </div>
    <div class="inspector" id="ahi-log">Click <b>SELECT … WHERE id = 42</b> a few times to see how InnoDB promotes a hot search prefix into the AHI.</div>

    <details class="explain">
      <summary>AHI caveats</summary>
      <div class="body">
        <ul>
          <li>Disabled if contention is high (latching becomes the bottleneck) — <code>innodb_adaptive_hash_index_parts</code> partitions help.</li>
          <li>Entries are invalidated when the page changes — keep workload prefix-stable to benefit.</li>
          <li>It's a cache, not a source of truth: a miss simply falls through to the B+Tree walk.</li>
        </ul>
      </div>
    </details>
  `;

  // ===================== 6A · Change buffer =====================
  // Each pending entry is shown as a colored chip in the change-buffer tree.
  // On SELECT, the page is read and a brief "merging…" animation runs.
  const KIND_COLORS = { INSERT:'var(--green)', 'DEL-MARK':'var(--orange)', DELETE:'var(--err)' };
  const cb = {
    pending: [],          // [{ id, kind, key }]
    inPool:  false,
    nextId:  1,
    flash:   null         // 'merging' | 'reading'
  };

  function renderCB() {
    const svg = d3.select('#cb-svg'); svg.selectAll('*').remove(); installArrowDefs(svg);

    // ---- BUFFER POOL panel (left) ----
    svg.append('rect').attr('x', 16).attr('y', 16).attr('width', 360).attr('height', 300).attr('rx', 8)
       .attr('fill', 'var(--panel-2)').attr('stroke', cb.inPool ? 'var(--ok)' : 'var(--ink-dim)').attr('stroke-width', 1.5);
    svg.append('text').attr('x', 28).attr('y', 38).attr('class', 'lbl-mono-dim').text('BUFFER POOL');
    svg.append('text').attr('x', 28).attr('y', 56).attr('class', 'lbl-mono-dim').attr('font-size', 10).text('idx_name leaf page');

    if (cb.inPool) {
      svg.append('rect').attr('x', 36).attr('y', 90).attr('width', 320).attr('height', 200).attr('rx', 6)
         .attr('fill', 'rgba(74,242,118,0.10)').attr('stroke', 'var(--ok)');
      svg.append('text').attr('x', 196).attr('y', 116).attr('text-anchor', 'middle').attr('class', 'lbl-mono').attr('fill', 'var(--ok)').attr('font-size', 13).text('PAGE #128 · in buffer pool');
      svg.append('text').attr('x', 196).attr('y', 138).attr('text-anchor', 'middle').attr('class', 'lbl-mono-dim').attr('font-size', 10).text('idx_name secondary index');
      // show the merged ops landing on the page as faint chips
      cb._mergedFlash?.forEach((m, i) => {
        const cx = 56 + (i % 3) * 100, cy = 168 + Math.floor(i / 3) * 36;
        svg.append('rect').attr('x', cx).attr('y', cy).attr('width', 88).attr('height', 26).attr('rx', 4)
           .attr('fill', 'var(--panel-2)').attr('stroke', KIND_COLORS[m.kind])
           .attr('opacity', cb.flash === 'merging' ? 0.55 : 1);
        svg.append('text').attr('x', cx + 44).attr('y', cy + 17).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 10).attr('fill', KIND_COLORS[m.kind]).text(`${m.kind} ${m.key}`);
      });
    } else {
      svg.append('rect').attr('x', 36).attr('y', 90).attr('width', 320).attr('height', 200).attr('rx', 6)
         .attr('fill', 'none').attr('stroke', 'var(--ink-dim)').attr('stroke-dasharray', '5 5');
      svg.append('text').attr('x', 196).attr('y', 188).attr('text-anchor', 'middle').attr('class', 'lbl-mono').attr('fill', 'var(--ink-dim)').attr('font-size', 13).text('PAGE #128 · NOT cached');
      svg.append('text').attr('x', 196).attr('y', 210).attr('text-anchor', 'middle').attr('class', 'lbl-mono-dim').attr('font-size', 10).text('reading would cost a 16 KB random I/O');
    }

    // ---- DECISION rules (top right) ----
    svg.append('rect').attr('x', 396).attr('y', 16).attr('width', 360).attr('height', 140).attr('rx', 8)
       .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--border)').attr('stroke-width', 1.5);
    svg.append('text').attr('x', 408).attr('y', 38).attr('class', 'lbl-mono-dim').text('DECISION: ibuf_should_try()');
    const rules = [
      ['secondary index?',     'yes',                                          'var(--ok)'],
      ['not unique?',          'yes',                                          'var(--ok)'],
      ['not in recovery?',     'yes',                                          'var(--ok)'],
      ['page in buffer pool?', cb.inPool ? 'yes → write direct' : 'NO → buffer', cb.inPool ? 'var(--ok)' : 'var(--orange)']
    ];
    rules.forEach(([k, v, c], i) => {
      svg.append('text').attr('x', 408).attr('y', 64 + i * 22).attr('class', 'lbl-mono').attr('font-size', 11).attr('fill', 'var(--ink-dim)').text(k);
      svg.append('text').attr('x', 744).attr('y', 64 + i * 22).attr('text-anchor', 'end').attr('class', 'lbl-mono').attr('font-size', 11).attr('fill', c).text(v);
    });

    // ---- CHANGE BUFFER TREE (bottom right) ----
    svg.append('rect').attr('x', 396).attr('y', 176).attr('width', 688).attr('height', 140).attr('rx', 8)
       .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--orange)').attr('stroke-width', 1.5);
    svg.append('text').attr('x', 408).attr('y', 198).attr('class', 'lbl-mono-dim').attr('fill', 'var(--orange)').text('CHANGE BUFFER TREE');
    svg.append('text').attr('x', 408).attr('y', 214).attr('class', 'lbl-mono-dim').attr('font-size', 10).text('SYSTEM TABLESPACE · SPACE 0 · ibuf::SYS_IBUF_TABLE_ID');
    svg.append('text').attr('x', 1072).attr('y', 198).attr('text-anchor', 'end').attr('class', 'lbl-mono').attr('fill', 'var(--orange)').attr('font-size', 14).text(`${cb.pending.length} pending`);

    if (cb.pending.length === 0) {
      svg.append('text').attr('x', 740).attr('y', 270).attr('text-anchor', 'middle').attr('class', 'lbl-mono-dim').text('(empty)');
    } else {
      cb.pending.forEach((p, i) => {
        const cx = 412 + (i % 6) * 110, cy = 232 + Math.floor(i / 6) * 36;
        svg.append('rect').attr('x', cx).attr('y', cy).attr('width', 100).attr('height', 28).attr('rx', 4)
           .attr('fill', 'var(--panel)').attr('stroke', KIND_COLORS[p.kind]).attr('stroke-width', 1.5);
        svg.append('text').attr('x', cx + 50).attr('y', cy + 19).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 10).attr('fill', KIND_COLORS[p.kind])
           .text(`${p.kind} ${p.key}`);
      });
    }

    // ---- DISK strip ----
    svg.append('rect').attr('x', 16).attr('y', 332).attr('width', 1068).attr('height', 36).attr('rx', 6)
       .attr('fill', 'none').attr('stroke', 'var(--border-2)');
    svg.append('text').attr('x', 28).attr('y', 354).attr('class', 'lbl-mono')
       .attr('fill', cb.flash === 'reading' ? 'var(--accent)' : 'var(--ink-dim)')
       .text(cb.flash === 'reading' ? 'DISK · users.ibd · idx_name leaf pages · READING 16 KB…' : 'DISK · users.ibd · idx_name leaf pages');

    // ---- ARROWS depicting the data flow ----
    if (cb.flash === 'buffering') {
      // arrow from rules box → change-buffer tree (op going INTO buffer)
      svg.append('path').attr('d', 'M576,156 L576,176').attr('class', 'arrow active');
      svg.append('text').attr('x', 590).attr('y', 172).attr('class', 'lbl-mono-dim').attr('font-size', 10).attr('fill', 'var(--accent)').text('ibuf_insert(IBUF_OP_INSERT)');
    }
    if (cb.flash === 'merging') {
      // arrow from change buffer → buffer pool (chips merging into the page)
      svg.append('path').attr('d', 'M396,246 C300,246 300,200 376,200').attr('class', 'arrow active');
      svg.append('text').attr('x', 200).attr('y', 232).attr('class', 'lbl-mono-dim').attr('font-size', 10).attr('fill', 'var(--accent)').text('ibuf_merge_in_background()');
    }
  }

  function pulseCB(kind, key, then) {
    cb.flash = kind;
    renderCB();
    setTimeout(() => { cb.flash = null; if (then) then(); renderCB(); }, 600);
  }

  section.querySelector('[data-act="cb-insert"]').addEventListener('click', () => {
    const k = 100 + Math.floor(Math.random() * 900);
    if (cb.inPool) {
      d3.select('#cb-log').html(`Page is already in the buffer pool — write applied directly to the leaf page in memory. No change-buffer entry created.`);
      cb._mergedFlash = (cb._mergedFlash || []).concat([{ kind:'INSERT', key:k }]);
    } else {
      cb.pending.push({ id: cb.nextId++, kind: 'INSERT', key: k });
      d3.select('#cb-log').html(`Page #128 not in BP → <code>ibuf_insert(IBUF_OP_INSERT, key=${k})</code> recorded in the change buffer tree. <b>${cb.pending.length}</b> pending. Disk is NOT read — the whole point is to avoid the random I/O.`);
    }
    pulseCB('buffering');
  });

  section.querySelector('[data-act="cb-select"]').addEventListener('click', () => {
    const wasInPool = cb.inPool;
    cb.inPool = true;
    if (cb.pending.length > 0) {
      cb._mergedFlash = cb.pending.slice();
      const n = cb.pending.length;
      cb.pending = [];
      d3.select('#cb-log').html(`Page #128 read from disk → <code>ibuf_merge_in_background()</code> applies the <b>${n}</b> pending op(s) on the in-memory page. From the reader's view, the page looks up to date.`);
      pulseCB(wasInPool ? 'reading' : 'merging');
    } else {
      d3.select('#cb-log').html(`Page #128 read from disk into BP. Change buffer was empty — nothing to merge.`);
      pulseCB('reading');
    }
  });

  section.querySelector('[data-act="cb-bg"]').addEventListener('click', () => {
    if (cb.pending.length === 0) { d3.select('#cb-log').html('Nothing to merge — change buffer is empty.'); return; }
    cb._mergedFlash = cb.pending.slice();
    const n = cb.pending.length;
    cb.pending = [];
    cb.inPool = true;
    d3.select('#cb-log').html(`Background master thread woke up → read page #128 → merged <b>${n}</b> change-buffer op(s). Customer was not waiting.`);
    pulseCB('merging');
  });

  section.querySelector('[data-act="cb-reset"]').addEventListener('click', () => {
    cb.pending = []; cb.inPool = false; cb._mergedFlash = []; cb.flash = null;
    d3.select('#cb-log').html('— reset —');
    renderCB();
  });

  // ===================== 6B · Adaptive Hash Index =====================
  // Multiple search prefixes are tracked. Each rep on the SAME prefix climbs
  // toward a hash promotion threshold. Once promoted, future hits are O(1).
  const ahi = {
    counts: {},      // prefix → hits seen
    hashed: {},      // prefix → bool (promoted to AHI)
    lastSearch: null,// {prefix, hit, walkedTree}
    THRESHOLD: 3
  };

  function renderAHI() {
    const svg = d3.select('#ahi-svg'); svg.selectAll('*').remove(); installArrowDefs(svg);

    // viewBox is 1100 × 440. Two side-by-side panes, both full height:
    //   LEFT  (16..496 x 16..420)  : B+Tree traversal
    //   RIGHT (520..1080 x 16..420): AHI — counters on top, hash entries below
    const wasHashHit = ahi.lastSearch && ahi.lastSearch.hit;

    // ===== LEFT pane =====
    svg.append('rect').attr('x', 16).attr('y', 16).attr('width', 480).attr('height', 404).attr('rx', 8)
       .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--border)').attr('stroke-width', 1.5);
    svg.append('text').attr('x', 28).attr('y', 36).attr('class', 'lbl-mono-dim').text('B+TREE TRAVERSAL');
    svg.append('text').attr('x', 28).attr('y', 52).attr('class', 'lbl-mono-dim').attr('font-size', 10).text('btr_cur_search_to_nth_level');

    // Tree topology — each internal owns 2 leaves. Leaves are 56 px wide and
    // sit ±36 from their parent internal so neighbouring pairs have a clean
    // 32 px gap between them (no overlap).
    const rootCx = 256, rootY = 96;
    const intCx  = [96, 256, 416], intY = 176;
    const cleanLeafCx = [];
    intCx.forEach(px => {
      cleanLeafCx.push(px - 36);
      cleanLeafCx.push(px + 36);
    });
    const leafY = 270;
    const LEAF_W = 56, LEAF_H = 26;
    const walkLeafIdx = 3;        // which leaf the search lands on (under internal[1])

    const stroke = wasHashHit ? 'var(--ink-dim)' : 'var(--accent)';
    const fill   = wasHashHit ? 'var(--panel-2)' : 'rgba(74,229,229,0.10)';
    const opac   = wasHashHit ? 0.4 : 1.0;

    function box(cx, cy, w, h, label, isOnPath) {
      const x = cx - w/2, y = cy - h/2;
      const isWalk = isOnPath && !wasHashHit;
      svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', h).attr('rx', 5)
         .attr('fill', isWalk ? 'rgba(74,229,229,0.18)' : fill)
         .attr('stroke', isWalk ? 'var(--accent)' : stroke).attr('stroke-width', isWalk ? 1.6 : 1)
         .attr('opacity', opac);
      svg.append('text').attr('x', cx).attr('y', cy + 4).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 10)
         .attr('fill', isWalk ? 'var(--accent)' : stroke).attr('opacity', opac).text(label);
    }
    function link(x1, y1, x2, y2, isWalk) {
      svg.append('path').attr('d', `M${x1},${y1} L${x2},${y2}`)
         .attr('stroke', isWalk && !wasHashHit ? 'var(--accent)' : 'var(--border-2)')
         .attr('stroke-width', isWalk && !wasHashHit ? 2 : 1)
         .attr('opacity', wasHashHit ? 0.25 : 0.85).attr('fill', 'none');
    }

    // root → internals
    intCx.forEach((ix, i) => link(rootCx, rootY + 18, ix, intY - 18, i === 1));
    // each internal → its 2 child leaves
    intCx.forEach((ix, i) => {
      const left  = cleanLeafCx[i*2];
      const right = cleanLeafCx[i*2 + 1];
      link(ix, intY + 18, left,  leafY - 16, i === 1 && walkLeafIdx === i*2);
      link(ix, intY + 18, right, leafY - 16, i === 1 && walkLeafIdx === i*2 + 1);
    });
    // boxes (drawn after lines so they sit on top)
    box(rootCx, rootY, 80, 30, 'root', true);
    intCx.forEach((ix, i) => box(ix, intY, 80, 30, 'internal', i === 1));
    cleanLeafCx.forEach((lx, i) => box(lx, leafY, LEAF_W, LEAF_H, 'leaf', i === walkLeafIdx));

    svg.append('text').attr('x', 28).attr('y', 360).attr('class', 'lbl-mono')
       .attr('font-size', 12)
       .attr('fill', wasHashHit ? 'var(--ok)' : 'var(--accent)')
       .text(`~3 PAGES LATCHED · ${wasHashHit ? 'SKIPPED (AHI HIT)' : 'NEEDED'}`);
    svg.append('text').attr('x', 28).attr('y', 380).attr('class', 'lbl-mono-dim').attr('font-size', 10)
       .text(wasHashHit ? 'AHI short-circuits root + internal + leaf latches'
                        : 'every level needs an S-latch on the page block');

    // ===== RIGHT pane =====
    svg.append('rect').attr('x', 520).attr('y', 16).attr('width', 560).attr('height', 404).attr('rx', 8)
       .attr('fill', 'var(--panel-2)').attr('stroke', 'var(--border)').attr('stroke-width', 1.5);
    svg.append('text').attr('x', 532).attr('y', 36).attr('class', 'lbl-mono-dim').text('ADAPTIVE HASH INDEX · btr_search_sys');
    svg.append('text').attr('x', 532).attr('y', 52).attr('class', 'lbl-mono-dim').attr('font-size', 10).text('partitioned · default 8 parts · btr/btr0sea.cc');

    // Counters band (y=68..208)
    const prefixes = ['id=42', 'id=17'];
    svg.append('text').attr('x', 532).attr('y', 78).attr('class', 'lbl-mono-dim').attr('font-size', 11).text('OBSERVED SEARCHES PER PREFIX');
    prefixes.forEach((p, row) => {
      const y = 92 + row * 60;             // 60 px row, two rows fit in 120 px
      const promoted = ahi.hashed[p];
      const c = promoted ? 'var(--ok)' : 'var(--accent)';
      // row card
      svg.append('rect').attr('x', 532).attr('y', y).attr('width', 540).attr('height', 50).attr('rx', 6)
         .attr('fill', promoted ? 'rgba(74,242,118,0.06)' : 'var(--panel)')
         .attr('stroke', c).attr('stroke-width', promoted ? 1.5 : 1);
      // prefix label
      svg.append('text').attr('x', 544).attr('y', y + 22).attr('class', 'lbl-mono').attr('font-size', 12)
         .attr('fill', c).text(`prefix  '${p}'`);
      // hit dots
      for (let i = 0; i < ahi.THRESHOLD; i++) {
        const cx = 700 + i * 30, cy = y + 14;
        const lit = (ahi.counts[p] || 0) > i;
        svg.append('rect').attr('x', cx).attr('y', cy).attr('width', 22).attr('height', 22).attr('rx', 4)
           .attr('fill', lit ? (promoted ? 'var(--ok)' : 'rgba(74,229,229,0.30)') : 'var(--bg)')
           .attr('stroke', lit ? c : 'var(--border-2)').attr('stroke-width', 1.2);
      }
      // status pill (inline-style fill so .lbl-mono can't wash out the contrast)
      const status = promoted ? 'PROMOTED' : `${ahi.counts[p] || 0} / ${ahi.THRESHOLD}`;
      const sw = promoted ? 92 : 56;
      svg.append('rect').attr('x', 1060 - sw).attr('y', y + 6).attr('width', sw).attr('height', 20).attr('rx', 10)
         .style('fill', promoted ? 'var(--ok)' : 'var(--panel-2)').style('stroke', c);
      svg.append('text').attr('x', 1060 - sw / 2).attr('y', y + 20).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 11)
         .style('fill', promoted ? 'var(--bg)' : c).attr('font-weight', 700).text(status);
      // sub-text under dots
      svg.append('text').attr('x', 700).attr('y', y + 46).attr('class', 'lbl-mono-dim').attr('font-size', 10)
         .text(promoted ? `hashed → btr_search_guess_on_hash()` : `keep searching to reach threshold (${ahi.THRESHOLD})`);
    });

    // Hash table entries band (y=224..400) — always shown but body is conditional
    svg.append('rect').attr('x', 532).attr('y', 224).attr('width', 540).attr('height', 180).attr('rx', 6)
       .attr('fill', 'rgba(74,242,118,0.04)').attr('stroke', 'var(--ok)').attr('stroke-width', 1.2)
       .attr('stroke-dasharray', Object.values(ahi.hashed).some(Boolean) ? null : '5 4');
    svg.append('text').attr('x', 544).attr('y', 246).attr('class', 'lbl-mono').attr('fill', 'var(--ok)').text('HASH TABLE ENTRIES');
    svg.append('text').attr('x', 1060).attr('y', 246).attr('text-anchor', 'end').attr('class', 'lbl-mono-dim').attr('font-size', 10).text('btr_search_sys.hash_index_t');

    const promoted = prefixes.filter(p => ahi.hashed[p]);
    if (promoted.length === 0) {
      svg.append('text').attr('x', 802).attr('y', 320).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono-dim').attr('font-size', 11)
         .text('(empty — promote a prefix to populate)');
    } else {
      promoted.forEach((p, i) => {
        const y = 270 + i * 56;
        // entry card
        svg.append('rect').attr('x', 544).attr('y', y).attr('width', 516).attr('height', 44).attr('rx', 5)
           .attr('fill', 'var(--panel)').attr('stroke', 'var(--ok)').attr('stroke-width', 1.2);
        svg.append('text').attr('x', 556).attr('y', y + 18).attr('class', 'lbl-mono').attr('font-size', 11)
           .attr('fill', 'var(--ok)').text(`hash{ fold('${p}') }`);
        svg.append('text').attr('x', 740).attr('y', y + 18).attr('text-anchor', 'middle')
           .attr('class', 'lbl-mono').attr('font-size', 14).attr('fill', 'var(--ink-dim)').text('→');
        svg.append('text').attr('x', 760).attr('y', y + 18).attr('class', 'lbl-mono').attr('font-size', 11)
           .attr('fill', 'var(--accent)').text('page_block + rec_offs');
        svg.append('text').attr('x', 556).attr('y', y + 34).attr('class', 'lbl-mono-dim').attr('font-size', 10)
           .text('lookup: O(1) — direct pointer to the leaf record');
      });
    }

    // (HIT/MISS narration is shown in the inspector log below the SVG —
    //  putting another text banner inside the SVG would overlap the tree boxes.)
  }

  function doSearch(prefix) {
    if (ahi.hashed[prefix]) {
      ahi.lastSearch = { prefix, hit: true, walkedTree: false };
      d3.select('#ahi-log').html(`<b>AHI hit</b> for prefix <code>'${prefix}'</code> — <code>btr_search_guess_on_hash()</code> jumped straight to the record. Zero page latches taken on the B+Tree.`);
    } else {
      ahi.counts[prefix] = (ahi.counts[prefix] || 0) + 1;
      ahi.lastSearch = { prefix, hit: false, walkedTree: true };
      if (ahi.counts[prefix] >= ahi.THRESHOLD) {
        ahi.hashed[prefix] = true;
        d3.select('#ahi-log').html(`Threshold reached for <code>'${prefix}'</code> · <code>btr_search_info_update()</code> built a hash entry. The next matching search will skip the tree.`);
      } else {
        d3.select('#ahi-log').html(`Tree walk: root → internal → leaf (3 page latches). AHI observed prefix <code>'${prefix}'</code> (${ahi.counts[prefix]}/${ahi.THRESHOLD} toward promotion).`);
      }
    }
    renderAHI();
  }

  section.querySelector('[data-act="ahi-search"]').addEventListener('click', () => doSearch('id=42'));
  section.querySelector('[data-act="ahi-other"]').addEventListener('click', () => doSearch('id=17'));
  section.querySelector('[data-act="ahi-reset"]').addEventListener('click', () => {
    ahi.counts = {}; ahi.hashed = {}; ahi.lastSearch = null;
    d3.select('#ahi-log').html('— reset —');
    renderAHI();
  });

  // initial paint
  renderCB();
  renderAHI();
})();
