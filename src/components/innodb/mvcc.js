export function mountMvcc(section) {
  const rows = [
    {
      label: 'Row 1',
      title: 'Committed balance',
      event: 'T10 writes $100 and commits',
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
      mysql: 'InnoDB path: current $50 rejected by ReadView → undo record returns old $100.',
      postgres: 'Postgres path: tuple $100 passes Snapshot+CLOG checks → $50 is active, $999 aborted.',
      mysqlOn: ['mysql-row', 'mysql-undo', 'mysql-readview', 'mysql-trxsys'],
      pgOn: ['pg-procarray', 'pg-snapshot', 'pg-clog', 'pg-tuple100', 'pg-tuple50', 'pg-tuple999'],
      takeaway: 'Same answer, different machinery: InnoDB reconstructs from undo; Postgres classifies tuple versions with Snapshot+CLOG.'
    }
  ];

  let current = 0;

  function has(key, side) {
    return rows[current][side].includes(key);
  }

  function node(side, key, tone, title, body) {
    const active = has(key, side);
    return `<div class="node ${active ? 'on ' + tone : ''}"><div class="node-title">${title}</div><div class="node-body">${body}</div></div>`;
  }

  function render() {
    const focused = section.contains(document.activeElement) ? document.activeElement : null;
    const action = focused?.getAttribute('data-act');
    const rowIndex = focused?.getAttribute('data-row');
    const row = rows[current];
    section.innerHTML = `

      <div class="controls">
        <button class="btn" data-act="prev">Back</button>
        <button class="btn primary" data-act="next">Next</button>
        <button class="btn" data-act="reset">Reset</button>
      </div>

      <div class="mvcc-clean">
        <div class="row-buttons">
          ${rows.map((item, idx) => `<button class="row-button ${idx === current ? 'active' : ''} ${idx < current ? 'done' : ''}" data-row="${idx}" aria-pressed="${idx === current}"><span class="num">${item.label}</span><span class="name">${item.title}</span></button>`).join('')}
        </div>

        <div class="story-card" aria-live="polite">
          <h3>${row.title}</h3>
          <p><strong>${row.event}.</strong> ${row.takeaway}</p>
        </div>

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
            <div class="cards">
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


      </div>
    `;

    if (action) section.querySelector(`[data-act="${action}"]`)?.focus({ preventScroll: true });
    if (rowIndex !== null && rowIndex !== undefined) {
      section.querySelector(`[data-row="${rowIndex}"]`)?.focus({ preventScroll: true });
    }

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
}
