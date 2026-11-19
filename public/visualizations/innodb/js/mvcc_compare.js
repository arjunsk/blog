/* mvcc_compare.js — four-row bank account MVCC example */
(function () {
  const section = document.getElementById('mvcc-compare');
  if (!section) return;

  const rows = [
    {
      label: 'Row 1',
      title: 'Committed balance',
      event: 'T10 writes $100 and commits',
      reader: 'Visible baseline',
      result: 'Reader can see $100',
      mysql: 'Clustered row stores balance=$100 with trx_id=T10. No undo needed yet.',
      postgres: 'Heap tuple stores balance=$100 with xmin=T10. CLOG says T10 committed.',
      mysqlOn: ['mysql-row', 'mysql-readview'],
      pgOn: ['pg-tuple100', 'pg-clog'],
      takeaway: 'Both engines agree that committed $100 is visible.'
    },
    {
      label: 'Row 2',
      title: 'Running update',
      event: 'T20 changes $100 → $50 but is still running',
      reader: 'Reader opened while T20 active',
      result: 'Reader must not see $50',
      mysql: 'Clustered row now says $50 with trx_id=T20. ReadView sees T20 active, so InnoDB follows undo.',
      postgres: 'Tuple $100 has xmax=T20 and tuple $50 has xmin=T20. Snapshot sees T20 active, so $50 is ignored.',
      mysqlOn: ['mysql-row', 'mysql-undo', 'mysql-readview', 'mysql-trxsys'],
      pgOn: ['pg-procarray', 'pg-snapshot', 'pg-tuple100', 'pg-tuple50'],
      takeaway: 'Both engines reject T20 because the reader snapshot remembers T20 was active.'
    },
    {
      label: 'Row 3',
      title: 'Aborted update',
      event: 'T30 tries $999 and aborts',
      reader: 'Reader must not see failed write',
      result: 'Hide $999',
      mysql: 'InnoDB rollback uses undo to restore/remove the $999 change. Readers do not need a CLOG lookup for leftover $999.',
      postgres: 'Postgres may still physically have tuple $999 with xmin=T30. Snapshot only says T30 is not active; CLOG says T30 aborted.',
      mysqlOn: ['mysql-undo', 'mysql-rollback'],
      pgOn: ['pg-tuple999', 'pg-snapshot', 'pg-clog'],
      takeaway: 'This is the key CLOG example: not active does not mean committed.'
    },
    {
      label: 'Row 4',
      title: 'Final read result',
      event: 'Bank app asks: what balance should I show?',
      reader: 'Consistent snapshot result',
      result: 'Show $100',
      mysql: 'InnoDB path: current $50 rejected by ReadView → undo record returns old $100.',
      postgres: 'Postgres path: tuple $100 passes Snapshot+CLOG checks → $50 is active, $999 aborted.',
      mysqlOn: ['mysql-row', 'mysql-undo', 'mysql-readview', 'mysql-trxsys'],
      pgOn: ['pg-procarray', 'pg-snapshot', 'pg-clog', 'pg-tuple100', 'pg-tuple50', 'pg-tuple999'],
      takeaway: 'Same answer, different machinery: InnoDB reconstructs from undo; Postgres classifies tuple versions with Snapshot+CLOG.'
    }
  ];

  let current = 0;

  const styles = `
    <style>
      #mvcc-compare .mvcc-clean { display: grid; gap: 16px; }
      #mvcc-compare .story-card { border: 1px solid var(--border); background: var(--panel-2); border-radius: 16px; padding: 18px 20px; }
      #mvcc-compare .story-card h3 { margin: 0 0 8px; font-size: 22px; color: var(--ink); }
      #mvcc-compare .story-card p { margin: 0; line-height: 1.55; color: var(--ink-2); }
      #mvcc-compare .row-buttons { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; }
      #mvcc-compare .row-button { text-align: left; border: 1px solid var(--border); background: var(--panel-2); border-radius: 13px; padding: 12px; cursor: pointer; color: var(--ink-2); }
      #mvcc-compare .row-button.active { border-color: var(--accent); background: rgba(99,102,241,.16); color: var(--ink); }
      #mvcc-compare .row-button.done { border-color: var(--ok); }
      #mvcc-compare .row-button .num { display: block; font-family: var(--mono); font-weight: 700; font-size: 12px; color: var(--accent); margin-bottom: 5px; }
      #mvcc-compare .row-button .name { display: block; font-weight: 700; font-size: 13px; color: var(--ink); }
      #mvcc-compare .four-row-table { border: 1px solid var(--border); border-radius: 16px; overflow: hidden; background: var(--panel-2); }
      #mvcc-compare .four-row { display: grid; grid-template-columns: 150px 1.2fr 1.1fr 1fr; gap: 0; border-top: 1px solid var(--border); }
      #mvcc-compare .four-row:first-child { border-top: 0; }
      #mvcc-compare .four-row.header { background: rgba(148,163,184,.08); font-family: var(--mono); font-weight: 700; color: var(--ink); }
      #mvcc-compare .four-row.active { background: rgba(99,102,241,.13); }
      #mvcc-compare .cell { padding: 12px 14px; border-left: 1px solid var(--border); color: var(--ink-2); line-height: 1.45; }
      #mvcc-compare .cell:first-child { border-left: 0; }
      #mvcc-compare .cell strong { color: var(--ink); }
      #mvcc-compare .cell code { color: var(--ink); }
      #mvcc-compare .engines { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
      #mvcc-compare .engine { border: 1px solid var(--border); border-radius: 16px; background: var(--panel-2); padding: 16px; }
      #mvcc-compare .engine-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
      #mvcc-compare .engine h3 { margin: 0; font-size: 17px; }
      #mvcc-compare .tag { border: 1px solid var(--border); border-radius: 999px; padding: 4px 9px; color: var(--ink-2); font-family: var(--mono); font-size: 11px; white-space: nowrap; }
      #mvcc-compare .cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
      #mvcc-compare .pg-cards { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      #mvcc-compare .node { min-height: 96px; border: 1px solid var(--border); border-radius: 13px; background: var(--panel); padding: 12px; opacity: .42; transition: .16s ease; }
      #mvcc-compare .node.on { opacity: 1; transform: translateY(-1px); box-shadow: 0 0 0 2px rgba(99,102,241,.12); }
      #mvcc-compare .node.ok { border-color: var(--ok); } #mvcc-compare .node.ok .node-title { color: var(--ok); }
      #mvcc-compare .node.warn { border-color: var(--warn); } #mvcc-compare .node.warn .node-title { color: var(--warn); }
      #mvcc-compare .node.err { border-color: var(--err); } #mvcc-compare .node.err .node-title { color: var(--err); }
      #mvcc-compare .node.accent { border-color: var(--accent); } #mvcc-compare .node.accent .node-title { color: var(--accent); }
      #mvcc-compare .node.blue { border-color: #5b9cff; } #mvcc-compare .node.blue .node-title { color: #5b9cff; }
      #mvcc-compare .node-title { font-family: var(--mono); font-size: 12px; font-weight: 700; margin-bottom: 8px; }
      #mvcc-compare .node-body { font-family: var(--mono); white-space: pre-line; color: var(--ink-2); font-size: 12px; line-height: 1.45; }
      #mvcc-compare .decision-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
      #mvcc-compare .decision { border: 1px solid var(--border); border-radius: 14px; padding: 14px; background: var(--panel); }
      #mvcc-compare .decision .label { font-family: var(--mono); font-weight: 700; font-size: 12px; color: var(--accent); margin-bottom: 7px; }
      #mvcc-compare .decision p { margin: 0; color: var(--ink-2); line-height: 1.55; }
      #mvcc-compare .takeaway { border: 1px solid var(--border); border-radius: 14px; background: var(--panel-2); padding: 14px 16px; color: var(--ink-2); line-height: 1.55; }
      #mvcc-compare .takeaway b { color: var(--ink); }
      @media (max-width: 1000px) { #mvcc-compare .engines, #mvcc-compare .decision-grid, #mvcc-compare .row-buttons { grid-template-columns: 1fr; } #mvcc-compare .four-row { grid-template-columns: 1fr; } #mvcc-compare .cell { border-left: 0; border-top: 1px solid var(--border); } #mvcc-compare .cell:first-child { border-top: 0; } }
    </style>
  `;

  function has(key, side) {
    return rows[current][side].includes(key);
  }

  function node(side, key, tone, title, body) {
    const active = has(key, side);
    return `<div class="node ${active ? 'on ' + tone : ''}"><div class="node-title">${title}</div><div class="node-body">${body}</div></div>`;
  }

  function table() {
    return `<div class="four-row-table">
      <div class="four-row header">
        <div class="cell">4-row example</div><div class="cell">Event</div><div class="cell">Reader question</div><div class="cell">Visible result</div>
      </div>
      ${rows.map((row, idx) => `<div class="four-row ${idx === current ? 'active' : ''}">
        <div class="cell"><strong>${row.label}</strong><br>${row.title}</div>
        <div class="cell">${row.event}</div>
        <div class="cell">${row.reader}</div>
        <div class="cell"><code>${row.result}</code></div>
      </div>`).join('')}
    </div>`;
  }

  function render() {
    const row = rows[current];
    section.innerHTML = `${styles}
      <h2><span class="no">㉑</span>MVCC · 4-Row Bank Account Example</h2>
      <p class="lead">A cleaner MVCC story with exactly four rows. The reader opens the bank app while updates are happening. The correct answer is still <code>$100</code>.</p>

      <div class="controls">
        <button class="btn" data-act="prev">← Back</button>
        <button class="btn primary" data-act="next">▶ Next</button>
        <button class="btn" data-act="reset">↺ Reset</button>
      </div>

      <div class="mvcc-clean">
        <div class="row-buttons">
          ${rows.map((item, idx) => `<button class="row-button ${idx === current ? 'active' : ''} ${idx < current ? 'done' : ''}" data-row="${idx}"><span class="num">${item.label}</span><span class="name">${item.title}</span></button>`).join('')}
        </div>

        <div class="story-card">
          <h3>${row.title}</h3>
          <p><strong>${row.event}.</strong> ${row.takeaway}</p>
        </div>

        ${table()}

        <div class="engines">
          <div class="engine">
            <div class="engine-head"><h3>InnoDB</h3><span class="tag">ReadView + undo</span></div>
            <div class="cards">
              ${node('mysqlOn', 'mysql-trxsys', 'warn', 'trx_sys', 'active transactions\n[T20]')}
              ${node('mysqlOn', 'mysql-readview', 'accent', 'ReadView', 'remembers T20 active\nchecks row trx_id')}
              ${node('mysqlOn', 'mysql-row', 'err', 'Current row', 'balance = $50\ntrx_id = T20\nroll_ptr → undo')}
              ${node('mysqlOn', 'mysql-undo', 'ok', 'Undo record', 'old balance = $100\nold trx_id = T10')}
              ${node('mysqlOn', 'mysql-rollback', 'warn', 'Rollback via undo', 'T30 abort restores/removes\nuncommitted $999')}
            </div>
          </div>

          <div class="engine">
            <div class="engine-head"><h3>Postgres</h3><span class="tag">Snapshot + CLOG</span></div>
            <div class="cards pg-cards">
              ${node('pgOn', 'pg-procarray', 'warn', 'ProcArray', 'active xids\n[T20]')}
              ${node('pgOn', 'pg-snapshot', 'blue', 'Snapshot', 'answers:\nwas xid running?')}
              ${node('pgOn', 'pg-clog', 'warn', 'CLOG / pg_xact', 'T10 committed\nT30 aborted')}
              ${node('pgOn', 'pg-tuple100', 'ok', 'Tuple $100', 'xmin = T10\nxmax = T20')}
              ${node('pgOn', 'pg-tuple50', 'err', 'Tuple $50', 'xmin = T20\nstill running')}
              ${node('pgOn', 'pg-tuple999', 'err', 'Tuple $999', 'xmin = T30\naborted')}
            </div>
          </div>
        </div>

        <div class="decision-grid">
          <div class="decision"><div class="label">InnoDB for this row</div><p>${row.mysql}</p></div>
          <div class="decision"><div class="label">Postgres for this row</div><p>${row.postgres}</p></div>
        </div>

        <div class="takeaway"><b>Final mental model:</b> InnoDB keeps the latest row in-place and reconstructs old reads from undo. Postgres keeps tuple versions and uses Snapshot plus CLOG to decide which tuple version is visible.</div>
      </div>
    `;

    section.querySelector('[data-act="prev"]').addEventListener('click', () => {
      current = Math.max(0, current - 1);
      render();
    });
    section.querySelector('[data-act="next"]').addEventListener('click', () => {
      current = Math.min(rows.length - 1, current + 1);
      render();
    });
    section.querySelector('[data-act="reset"]').addEventListener('click', () => {
      current = 0;
      render();
    });
    section.querySelectorAll('[data-row]').forEach(button => {
      button.addEventListener('click', () => {
        current = Number(button.dataset.row);
        render();
      });
    });
  }

  render();
})();
