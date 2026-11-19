/* doublewrite.js — ⑨ Doublewrite: torn-write protection on the page-flush path */
(function () {
  const section = document.getElementById('doublewrite');
  if (!section) return;
  section.innerHTML = `
    <h2><span class="no">⑨</span>Doublewrite — protecting pages from torn writes</h2>
    <p class="lead">Before any dirty page leaves the buffer pool for its real home, InnoDB writes a copy to a sequential, fsync'd staging area called the <b>doublewrite buffer</b>. If a crash leaves the home page torn (half old, half new), recovery rebuilds it from the pristine copy. Without this, redo replay would land on a structurally invalid page.</p>

    <h3>Why redo alone is not enough</h3>
    <p>A 16 KB InnoDB page is written to disk atomically <em>only if</em> the filesystem + block device + OS happen to cooperate. In reality, a crash mid-flush can leave a torn page: the 16 KB is half old, half new. Redo can't fix that — it's a <em>logical</em> change stream that assumes the page it replays on is structurally intact (valid header, checksum, record directory).</p>
    <p>Doublewrite is the durability shim: every dirty page is first written to a contiguous, sequential area (<code>#ib_16384_0.dblwr</code> / <code>#ib_16384_1.dblwr</code> since 8.0.20; in <code>ibdata1</code> before that) and <code>fsync</code>'d. Only then is it written to its real home in the tablespace. On recovery, if any page looks torn, InnoDB reads the pristine copy from doublewrite and rewrites it — then redo can safely apply.</p>
    <div class="controls">
      <button class="btn primary" data-act="dw-step">Step ▶</button>
      <button class="btn"          data-act="dw-play">▶ Auto play</button>
      <button class="btn"          data-act="dw-crash">⚡ Crash now</button>
      <button class="btn"          data-act="dw-reset">↺ Reset</button>
    </div>
    <div class="viz-container" style="padding:24px">
      <svg id="dw-svg" viewBox="0 0 1200 520" style="width:100%;height:auto"></svg>
    </div>
    <div class="inspector" id="dw-log">Step through to see doublewrite protect against torn writes.</div>
    <p class="ref"><code>buf/buf0dblwr.cc</code> · tuned by <code>innodb_doublewrite</code>, <code>innodb_doublewrite_pages</code></p>
  `;

  // ===== Doublewrite =====
  // step semantics:
  //   0: idle
  //   1: dirty page in BP
  //   2: ① flush + fsync to doublewrite (DW intact copy)
  //   3: ② write to home page in tablespace (clean OR torn)
  //   4: recovery — ③ scan, detect torn checksum
  //   5: recovery — ④ read intact V2 from doublewrite
  //   6: recovery — ⑤ rewrite tablespace home with V2
  //   7: recovery — ⑥ redo log can apply safely
  let dw;
  function dwReset() { dw = { step: 0, crashed: false }; }
  dwReset();

  function dwAdvance() {
    if (!dw.crashed && dw.step >= 3) return;
    if (dw.crashed && dw.step < 4) dw.step = 4;
    else if (dw.step < 7) dw.step++;
  }

  let dwTimer = null;
  section.querySelector('[data-act="dw-step"]').addEventListener('click', () => { dwAdvance(); renderDw(); });
  section.querySelector('[data-act="dw-play"]').addEventListener('click', () => {
    if (dwTimer) { clearInterval(dwTimer); dwTimer = null; return; }
    dwTimer = setInterval(() => {
      const before = dw.step;
      dwAdvance(); renderDw();
      if (dw.step === before) { clearInterval(dwTimer); dwTimer = null; }
    }, 1300);
  });
  section.querySelector('[data-act="dw-crash"]').addEventListener('click', () => {
    dw.crashed = true;
    if (dw.step < 3) dw.step = 3;
    renderDw();
  });
  section.querySelector('[data-act="dw-reset"]').addEventListener('click', () => {
    if (dwTimer) { clearInterval(dwTimer); dwTimer = null; }
    dwReset(); d3.select('#dw-log').html('— reset —'); renderDw();
  });

  function renderDw() {
    const svg = d3.select('#dw-svg'); svg.selectAll('*').remove(); installArrowDefs(svg);
    const g = svg.append('g');

    const X = 16, W = 1168;
    const stepNow = dw.step;

    function drawPanel(x, y, w, h, title, sub, color, active) {
      const r = g.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', h).attr('rx', 8)
         .attr('fill', 'var(--panel-2)').attr('stroke', color).attr('stroke-width', active ? 2 : 1)
         .attr('opacity', 0);
      r.transition().duration(220).attr('opacity', 1);
      g.append('text').attr('x', x + 14).attr('y', y + 22).attr('class', 'lbl-mono')
        .attr('fill', color).attr('font-size', 12).text(title);
      if (sub) {
        g.append('text').attr('x', x + w - 14).attr('y', y + 22).attr('text-anchor', 'end')
          .attr('class', 'lbl-mono-dim').attr('font-size', 11).text(sub);
      }
    }
    function drawCells(x, y, w, h, cells) {
      const cellW = (w - 30 - (cells.length - 1) * 10) / cells.length;
      cells.forEach((c, i) => {
        const cx = x + 15 + i * (cellW + 10);
        const rect = g.append('rect').attr('x', cx).attr('y', y + h - 28).attr('width', cellW).attr('height', 18).attr('rx', 3)
          .attr('fill', c.bg).attr('stroke', c.color).attr('opacity', 0);
        rect.transition().duration(220).attr('opacity', 1);
        g.append('text').attr('x', cx + cellW / 2).attr('y', y + h - 14).attr('text-anchor', 'middle')
          .attr('class', 'lbl-mono').attr('font-size', 11).attr('fill', c.color).text(c.t);
      });
    }
    function drawArrow(x, y0, y1, label, color, n) {
      const len = Math.abs(y1 - y0);
      const path = g.append('path').attr('d', `M${x},${y0} L${x},${y1}`).attr('fill', 'none')
        .attr('stroke', color).attr('stroke-width', 2)
        .attr('stroke-dasharray', len).attr('stroke-dashoffset', len);
      path.transition().duration(450).attr('stroke-dashoffset', 0);
      g.append('path').attr('d', `M${x - 6},${y1 - 8} L${x},${y1} L${x + 6},${y1 - 8} Z`)
        .attr('fill', color).attr('opacity', 0)
        .transition().delay(420).duration(180).attr('opacity', 1);
      const my = (y0 + y1) / 2;
      g.append('text').attr('x', x + 14).attr('y', my - 4).attr('class', 'lbl-mono')
        .attr('fill', color).attr('font-size', 13).attr('opacity', 0)
        .text(n).transition().delay(220).duration(220).attr('opacity', 1);
      g.append('text').attr('x', x + 30).attr('y', my - 4).attr('class', 'lbl-mono-dim').attr('font-size', 11)
        .attr('opacity', 0).text(label).transition().delay(220).duration(220).attr('opacity', 1);
    }

    const bpY  = 16,  bpH  = 80;
    const dwY  = 130, dwH  = 80;
    const tsY  = 244, tsH  = 90;
    const ax   = 60;

    const bpLit = stepNow >= 1;
    drawPanel(X, bpY, W, bpH, 'BUFFER POOL · in-memory dirty page', '16 KB · volatile',
      bpLit ? (dw.crashed ? 'var(--ink-dim)' : 'var(--orange)') : 'var(--ink-dim)', bpLit);
    if (bpLit) {
      drawCells(X, bpY, W, bpH, [
        { t: dw.crashed ? 'page #128 V2 — process gone' : 'page #128 V2 — dirty',
          color: dw.crashed ? 'var(--ink-dim)' : 'var(--orange)',
          bg:    dw.crashed ? 'var(--panel)'   : 'rgba(255,154,74,.10)' }
      ]);
    } else {
      g.append('text').attr('x', X + W / 2).attr('y', bpY + bpH / 2 + 6).attr('text-anchor', 'middle')
        .attr('class', 'lbl-mono-dim').attr('font-size', 11).text('— click Next step ▶ to dirty a page —');
    }

    if (stepNow >= 2) {
      drawArrow(ax, bpY + bpH + 4, dwY - 6, "flush + fsync to doublewrite (sequential)", 'var(--ok)', '①');
    }
    if (stepNow >= 2) {
      drawPanel(X, dwY, W, dwH, 'DOUBLEWRITE · #ib_16384_*.dblwr', "sequential · fsync'd · buf/buf0dblwr.cc",
        'var(--orange)', true);
      drawCells(X, dwY, W, dwH, [
        { t: "V2 written + fsync'd", color: 'var(--orange)', bg: 'rgba(255,154,74,.20)' },
        { t: 'pristine copy · safe', color: 'var(--orange)', bg: 'rgba(255,154,74,.10)' }
      ]);
    } else {
      drawPanel(X, dwY, W, dwH, 'DOUBLEWRITE · #ib_16384_*.dblwr', "fsync'd staging area",
        'var(--ink-dim)', false);
    }

    if (stepNow >= 3) {
      drawArrow(ax, dwY + dwH + 4, tsY - 6,
        dw.crashed ? '⚡ random write CRASHED — page is torn' : 'random write to home page (16 KB)',
        dw.crashed ? 'var(--err)' : 'var(--accent)', '②');
    }
    if (stepNow >= 3) {
      const tsColor = dw.crashed ? 'var(--err)' : 'var(--ok)';
      drawPanel(X, tsY, W, tsH, 'TABLESPACE · users.ibd · page #128 home',
        dw.crashed ? '⚠ checksum FAILS at next startup' : '✓ checksum matches', tsColor, true);
      const cells = dw.crashed
        ? [
            { t: 'first half · old V1', color: 'var(--orange)', bg: 'rgba(255,154,74,.18)' },
            { t: 'middle · ⚠ TORN',     color: 'var(--err)',    bg: 'rgba(242,92,92,.20)'  },
            { t: 'second half · V2',    color: 'var(--accent)', bg: 'rgba(74,229,229,.18)' }
          ]
        : [
            { t: 'V2', color: 'var(--ok)', bg: 'rgba(74,242,118,.18)' },
            { t: 'V2', color: 'var(--ok)', bg: 'rgba(74,242,118,.18)' },
            { t: 'V2', color: 'var(--ok)', bg: 'rgba(74,242,118,.18)' }
          ];
      drawCells(X, tsY, W, tsH, cells);
    } else {
      drawPanel(X, tsY, W, tsH, 'TABLESPACE · users.ibd · page #128 home', 'final home',
        'var(--ink-dim)', false);
    }

    if (dw.crashed) {
      const ry = 360, rh = 152;
      drawPanel(X, ry, W, rh,
        'RECOVERY (next startup) — doublewrite saves the day',
        'buf/buf0dblwr.cc::buf_dblwr_recover_pages()',
        'var(--ok)', stepNow >= 4);

      const steps = [
        { n: '③', t: 'scan',     d: 'walk every page; mismatched checksum → torn'   },
        { n: '④', t: 'read DW',  d: 'load intact V2 from the doublewrite area'      },
        { n: '⑤', t: 'rewrite',  d: 'overwrite the torn page with the pristine V2'  },
        { n: '⑥', t: 'redo OK',  d: 'page is intact — redo replay can apply safely' }
      ];
      const stepW = (W - 60) / steps.length;
      steps.forEach((s, i) => {
        const cardX = X + 30 + i * stepW;
        const cardY = ry + 50;
        const cardH = rh - 70;
        const reached = (stepNow >= 4 + i);
        const isCur  = (stepNow === 4 + i);
        const c = reached ? 'var(--ok)' : 'var(--ink-dim)';
        const card = g.append('rect').attr('x', cardX).attr('y', cardY).attr('width', stepW - 18).attr('height', cardH).attr('rx', 6)
          .attr('fill', reached ? 'rgba(74,242,118,0.07)' : 'var(--panel)')
          .attr('stroke', c).attr('stroke-width', isCur ? 2 : 1)
          .attr('opacity', 0);
        card.transition().duration(220).attr('opacity', 1);
        g.append('text').attr('x', cardX + 12).attr('y', cardY + 22).attr('class', 'lbl-mono')
          .attr('fill', c).attr('font-size', 14).text(s.n);
        g.append('text').attr('x', cardX + 36).attr('y', cardY + 22).attr('class', 'lbl-mono')
          .attr('fill', c).attr('font-size', 12).text(s.t);
        const words = s.d.split(' ');
        const lines = []; let line = '';
        words.forEach(w => { if ((line + ' ' + w).length > 28) { lines.push(line); line = w; } else { line = line ? line + ' ' + w : w; } });
        if (line) lines.push(line);
        lines.forEach((ln, j) => {
          g.append('text').attr('x', cardX + 12).attr('y', cardY + 44 + j * 14)
            .attr('class', 'lbl-mono-dim').attr('font-size', 10).attr('fill', reached ? 'var(--ink-2)' : 'var(--ink-dim)').text(ln);
        });
        if (i < steps.length - 1 && reached) {
          const ay = cardY + cardH / 2;
          const a = g.append('path').attr('d', `M${cardX + stepW - 18},${ay} L${cardX + stepW - 4},${ay}`)
            .attr('stroke', 'var(--ok)').attr('stroke-width', 2).attr('fill', 'none')
            .attr('marker-end', 'url(#arrow-head-acc)').attr('opacity', 0);
          a.transition().delay(120).duration(220).attr('opacity', 1);
        }
      });
    }

    if (stepNow === 0) {
      d3.select('#dw-log').html('Click <b>Next step ▶</b> to walk the durable-write path, or <b>⚡ Crash now</b> to trigger a torn-write scenario and watch recovery rebuild the page.');
    } else if (stepNow === 1) {
      d3.select('#dw-log').html('A row mutation marked page #128 dirty in the buffer pool. The bytes only exist in RAM — a crash now would lose them.');
    } else if (stepNow === 2) {
      d3.select('#dw-log').html('Step ① · doublewrite area written and fsynced (one large sequential I/O). Now we can risk the random home write — if it tears, the pristine V2 lives here.');
    } else if (stepNow === 3 && !dw.crashed) {
      d3.select('#dw-log').html('Step ② · home page written + fsynced cleanly. Doublewrite area is unused at next boot.');
    } else if (stepNow === 3 && dw.crashed) {
      d3.select('#dw-log').html('Step ② · power loss mid-write. The 16 KB home page is half V1, half V2. Checksum fails. <b>Click Next step ▶</b> to begin recovery.');
    } else if (stepNow === 4) {
      d3.select('#dw-log').html('③ Scan: recovery walks every page header looking for a checksum mismatch. Page #128 is flagged.');
    } else if (stepNow === 5) {
      d3.select('#dw-log').html('④ Read: the pristine V2 is loaded from the doublewrite area (which was fsynced before the home write).');
    } else if (stepNow === 6) {
      d3.select('#dw-log').html('⑤ Rewrite: the torn home page is overwritten with V2. Checksum now matches.');
    } else if (stepNow >= 7) {
      d3.select('#dw-log').html('⑥ Done: redo replay assumes a structurally intact page — now true again. Recovery completes; mysqld continues startup.');
    }
  }
  renderDw();
})();
