/* pg_locks.js — ㉔ Locking & Serializable · Postgres vs InnoDB
   Both engines achieve serializable isolation but with opposite philosophies.
     · InnoDB (REPEATABLE READ + gap locks, or SERIALIZABLE): pessimistic.
       Acquires next-key locks on the index range. A second writer trying
       to insert into the same range BLOCKS until the first commits.
     · Postgres (SERIALIZABLE = SSI): optimistic. Both transactions run
       in parallel, taking SIRead "predicate" locks (no blocking). At
       commit, the system detects rw-antidependency cycles and aborts
       one transaction with serialization_failure.

   We use a phantom-read scenario: two transactions both try to insert a
   row that would matter to each other\'s SELECT WHERE id BETWEEN 40 AND 50.
*/
(function () {
  const section = document.getElementById('pg-locks');
  if (!section) return;

  section.innerHTML = `
    <h2><span class="no">㉔</span>Locking &amp; Serializable · pessimistic vs optimistic</h2>
    <p class="lead">Both engines can deliver serializable isolation, but they get there in opposite ways. <em>InnoDB</em> is pessimistic — gap and next-key locks on the index range stop other writers from intruding (the second trx <b>blocks</b>). <em>Postgres</em> is optimistic — SSI lets both run, takes lightweight predicate locks (<code>SIRead</code>), and aborts one with <code>serialization_failure</code> only if a real conflict is detected at commit time.</p>

    <div class="controls">
      <button class="btn primary" data-act="pgl-t1insert">▶ T1: INSERT id=43</button>
      <button class="btn"          data-act="pgl-t2insert">▶ T2: INSERT id=47</button>
      <button class="btn"          data-act="pgl-t1commit">✓ T1 COMMIT</button>
      <button class="btn"          data-act="pgl-t2commit">✓ T2 COMMIT</button>
      <button class="btn"          data-act="pgl-reset">↺ Reset</button>
    </div>

    <div class="viz-container" style="padding:24px">
      <svg id="pgl-svg" viewBox="0 0 1400 540" style="width:100%;height:auto"></svg>
    </div>

    <div class="inspector" id="pgl-log">Two transactions, T1 and T2, each open with <code>SELECT * FROM users WHERE id BETWEEN 40 AND 50</code>. Then both try to INSERT into that range. Watch how each engine handles it.</div>
  `;

  // ===== State =====
  // Phases per engine:
  //   InnoDB: idle → t1Inserted → t2Blocked → t1Committed → t2Inserted → t2Committed
  //   Postgres: idle → t1Inserted → t2Inserted → t1Committed → t2Aborted (or t2Committed if no conflict)
  let st;
  function reset() {
    st = {
      innodb:   { t1: 'idle', t2: 'idle', notes: [] },
      postgres: { t1: 'idle', t2: 'idle', notes: [] }
    };
  }
  reset();

  function t1Insert() {
    if (st.innodb.t1 === 'idle') {
      st.innodb.t1 = 'inserted';
      st.innodb.notes.push('T1 INSERT id=43 → acquires next-key lock on (40, 50] gap.');
    }
    if (st.postgres.t1 === 'idle') {
      st.postgres.t1 = 'inserted';
      st.postgres.notes.push('T1 INSERT id=43 → SIRead lock on predicate (id BETWEEN 40 AND 50).');
    }
  }
  function t2Insert() {
    if (st.innodb.t2 === 'idle' && st.innodb.t1 === 'inserted') {
      st.innodb.t2 = 'blocked';
      st.innodb.notes.push('T2 INSERT id=47 → BLOCKED on T1\'s gap lock. Waits.');
    } else if (st.innodb.t2 === 'idle' && st.innodb.t1 === 'committed') {
      st.innodb.t2 = 'inserted';
      st.innodb.notes.push('T2 INSERT id=47 → proceeds (T1 already committed, lock released).');
    }
    if (st.postgres.t2 === 'idle') {
      st.postgres.t2 = 'inserted';
      st.postgres.notes.push('T2 INSERT id=47 → no blocking. Both INSERTs coexist; conflict detected at commit time, not now.');
    }
  }
  function t1Commit() {
    if (st.innodb.t1 === 'inserted') {
      st.innodb.t1 = 'committed';
      st.innodb.notes.push('T1 COMMIT → next-key lock released. If T2 was waiting, it wakes.');
      if (st.innodb.t2 === 'blocked') {
        st.innodb.t2 = 'inserted';
        st.innodb.notes.push('T2 was blocked — wakes and proceeds with INSERT id=47.');
      }
    }
    if (st.postgres.t1 === 'inserted') {
      st.postgres.t1 = 'committed';
      st.postgres.notes.push('T1 COMMIT → succeeds. SIRead recorded. Postgres now checks if any in-flight T2 has rw-antidep on T1 → none yet, so OK.');
    }
  }
  function t2Commit() {
    if (st.innodb.t2 === 'inserted') {
      st.innodb.t2 = 'committed';
      st.innodb.notes.push('T2 COMMIT → succeeds. Both rows live: id=43, id=47.');
    }
    if (st.postgres.t2 === 'inserted') {
      st.postgres.t2 = 'aborted';
      st.postgres.notes.push('T2 COMMIT → ❌ serialization_failure. SSI detected an rw-antidependency cycle: both transactions read a range and wrote into it. One must roll back; here, T2 loses.');
    }
  }

  // ===== Render =====
  function render() {
    const svg = d3.select('#pgl-svg');
    svg.selectAll('*').remove();
    drawEngine(svg, 24, 24, 660, 490, 'InnoDB · pessimistic (gap/next-key locks)', 'var(--accent)', st.innodb);
    drawEngine(svg, 716, 24, 660, 490, 'Postgres · optimistic (SSI / predicate locks)', '#5b9cff', st.postgres);
    updateLog();
  }

  function drawEngine(svg, x, y, w, h, title, color, eng) {
    svg.append('rect').attr('x', x).attr('y', y).attr('width', w).attr('height', h).attr('rx', 8)
       .attr('fill', 'var(--panel-2)').attr('stroke', color).attr('stroke-width', 1.4);
    svg.append('text').attr('x', x + 14).attr('y', y + 22).attr('class', 'lbl-mono')
       .attr('font-size', 13).attr('font-weight', 600).style('fill', color).text(title);

    // Two trx lanes
    const laneY0 = y + 60, laneH = 110, laneGap = 12;
    [['T1', eng.t1, 'INSERT id=43'], ['T2', eng.t2, 'INSERT id=47']].forEach(([name, status, op], i) => {
      const ly = laneY0 + i * (laneH + laneGap);
      svg.append('rect').attr('x', x + 16).attr('y', ly).attr('width', w - 32).attr('height', laneH).attr('rx', 6)
         .attr('fill', 'var(--panel)').attr('stroke', statusStroke(status)).attr('stroke-width', 1.4);
      svg.append('text').attr('x', x + 28).attr('y', ly + 22).attr('class', 'lbl-mono')
         .attr('font-size', 12).attr('font-weight', 600).style('fill', color).text(name);
      svg.append('text').attr('x', x + 28).attr('y', ly + 42).attr('class', 'lbl-mono-dim').attr('font-size', 11).text(op);

      // Status pill
      const pillW = 130, pillX = x + w - 28 - pillW;
      svg.append('rect').attr('x', pillX).attr('y', ly + 14).attr('width', pillW).attr('height', 26).attr('rx', 4)
         .attr('fill', statusFill(status)).attr('opacity', 0.95);
      svg.append('text').attr('x', pillX + pillW / 2).attr('y', ly + 32).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 11).attr('font-weight', 700)
         .style('fill', '#0a0a0a').text(statusLabel(status));

      // Lock / predicate hint
      const hintY = ly + 70;
      const hint = lockHint(name, status, eng === st.innodb);
      svg.append('text').attr('x', x + 28).attr('y', hintY).attr('class', 'lbl-mono-dim').attr('font-size', 10).text(hint);

      if (status === 'aborted') {
        svg.append('text').attr('x', x + 28).attr('y', hintY + 16).attr('class', 'lbl-mono')
           .attr('font-size', 11).style('fill', 'var(--err)').attr('font-weight', 600)
           .text('❌ ROLLBACK · serialization_failure');
      }
      if (status === 'blocked') {
        svg.append('text').attr('x', x + 28).attr('y', hintY + 16).attr('class', 'lbl-mono')
           .attr('font-size', 11).style('fill', '#ff9f4d').attr('font-weight', 600)
           .text('⏳ BLOCKED · waiting for T1\'s gap lock');
      }
      if (status === 'committed') {
        svg.append('text').attr('x', x + 28).attr('y', hintY + 16).attr('class', 'lbl-mono')
           .attr('font-size', 11).style('fill', 'var(--ok)').attr('font-weight', 600)
           .text('✓ committed · row visible to all');
      }
    });

    // Notes log at bottom
    const logY = laneY0 + 2 * (laneH + laneGap) + 4;
    svg.append('rect').attr('x', x + 16).attr('y', logY).attr('width', w - 32).attr('height', h - (logY - y) - 16).attr('rx', 6)
       .attr('fill', 'var(--bg-2)').attr('stroke', 'var(--border-2)');
    svg.append('text').attr('x', x + 28).attr('y', logY + 18).attr('class', 'lbl-mono-dim').attr('font-size', 10).text('TRACE');
    eng.notes.slice(-5).forEach((n, i) => {
      svg.append('text').attr('x', x + 28).attr('y', logY + 38 + i * 14).attr('class', 'lbl-mono')
         .attr('font-size', 10).style('fill', 'var(--ink-2)').text('· ' + n);
    });
  }

  function statusFill(s) {
    return ({
      idle:      '#c4c4c4',
      inserted:  '#7ee787',
      blocked:   '#ffb84d',
      committed: '#7ee787',
      aborted:   '#ff8c8c'
    })[s] || '#c4c4c4';
  }
  function statusStroke(s) {
    return ({
      idle:      'var(--ink-dim)',
      inserted:  '#5fbf5f',
      blocked:   '#ff9f4d',
      committed: '#5fbf5f',
      aborted:   '#d44'
    })[s] || 'var(--ink-dim)';
  }
  function statusLabel(s) {
    return ({
      idle:      'IDLE',
      inserted:  'INSERTED',
      blocked:   'BLOCKED',
      committed: 'COMMITTED',
      aborted:   'ABORTED'
    })[s] || 'IDLE';
  }
  function lockHint(name, status, isInnoDB) {
    if (status === 'idle') return 'not started';
    if (isInnoDB) {
      if (name === 'T1') return 'holds: NEXT-KEY LOCK on (40, 50]';
      return status === 'blocked' ? 'wants: GAP in (40, 50] — held by T1' : 'INSERT proceeds; lock briefly held';
    } else {
      if (status === 'inserted') return 'holds: SIRead lock on predicate (id BETWEEN 40 AND 50)';
      if (status === 'aborted')   return 'rolled back at commit; rw-antidep with T1';
      return 'committed; SIRead released';
    }
  }

  function updateLog() {
    const el = document.getElementById('pgl-log');
    if (!el) return;
    const ip = st.innodb,  pp = st.postgres;
    if (ip.t1 === 'idle' && ip.t2 === 'idle') {
      el.innerHTML = 'Both transactions are idle. Click <b>▶ T1: INSERT</b> first to begin.';
    } else if (ip.t2 === 'blocked') {
      el.innerHTML = '<b>InnoDB:</b> T1 holds a next-key lock on (40, 50]; T2 is BLOCKED waiting. <b>Postgres:</b> T2 already inserted — no blocking. Click <b>✓ T1 COMMIT</b> to proceed on both sides.';
    } else if (pp.t2 === 'aborted') {
      el.innerHTML = '<b>Postgres SSI</b> aborted T2 with <code>serialization_failure</code>. The application must retry. <b>InnoDB</b>: both committed serially — no abort, but T2 had to wait. Same outcome (consistency), different cost model.';
    } else if (ip.t1 === 'committed' && ip.t2 === 'committed') {
      el.innerHTML = '<b>InnoDB:</b> both rows committed serially (T2 waited for T1\'s lock). <b>Postgres:</b> if T2 hasn\'t been aborted yet, click <b>✓ T2 COMMIT</b> to see SSI fire.';
    }
  }

  // ===== Wire =====
  section.querySelector('[data-act="pgl-t1insert"]').addEventListener('click', () => { t1Insert(); render(); });
  section.querySelector('[data-act="pgl-t2insert"]').addEventListener('click', () => { t2Insert(); render(); });
  section.querySelector('[data-act="pgl-t1commit"]').addEventListener('click', () => { t1Commit(); render(); });
  section.querySelector('[data-act="pgl-t2commit"]').addEventListener('click', () => { t2Commit(); render(); });
  section.querySelector('[data-act="pgl-reset"]').addEventListener('click', () => { reset(); render(); });

  render();
})();
