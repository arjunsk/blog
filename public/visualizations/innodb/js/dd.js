/* dd.js — ⑯ Data Dictionary
   Reference: storage/innobase/dict/dict0load.cc, sql/dd/impl/tables/*.h, sql/dd/cache/dictionary_client.cc
   Three-layer model: SQL caller → DD API → DD in-memory cache → InnoDB B+Trees in mysql.ibd
*/
(function () {
  const section = document.getElementById('dd');
  section.innerHTML = `
    <h2><span class="no">⑰</span>Data Dictionary</h2>
    <p class="lead">Since MySQL 8.0 the data dictionary (a.k.a. the catalog: what tables, columns, indexes, schemata, FKs exist) lives <strong>inside InnoDB</strong>, in a single <code>mysql.ibd</code> tablespace. No more per-table <code>.frm</code> files. This makes DDL atomic, crash-safe, and backed by the same redo + undo machinery as your user writes.</p>

    <h3>14a · Where the catalog lives</h3>
    <p>Three layers cooperate. Click a box to see what it does.</p>
    <div class="viz-container" style="padding:24px">
      <svg id="dd-stack-svg" viewBox="0 0 1200 440" style="width:100%;height:auto"></svg>
    </div>
    <div class="inspector" id="dd-stack-note">Click a layer above.</div>

    <h3 style="margin-top:36px">14b · Key tables in <code>mysql.ibd</code></h3>
    <p>The DD schema is defined in <code>sql/dd/impl/tables/*.h</code>. Each class (e.g. <code>dd::tables::Tables</code>) declares the real InnoDB-backed table — its fields, its indexes, its FKs. Click a table to see its fields.</p>
    <div class="controls" id="dd-tbl-btns" style="margin-top:12px"></div>
    <div class="viz-container" style="padding:24px">
      <svg id="dd-tbl-svg" viewBox="0 0 1200 280" style="width:100%;height:auto"></svg>
    </div>

    <h3 style="margin-top:36px">14c · What happens during <code>CREATE TABLE</code></h3>
    <p>Walk through a single <code>CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(64))</code>. Watch how a DDL statement becomes rows in the DD tables, committed atomically by InnoDB.</p>
    <div class="controls">
      <button class="btn primary" data-act="ddl-step">Step ▶</button>
      <button class="btn"          data-act="ddl-play">▶ Auto play</button>
      <button class="btn"          data-act="ddl-reset">↺ Reset</button>
    </div>
    <div class="viz-container" style="padding:24px">
      <svg id="dd-flow-svg" viewBox="0 0 1200 480" style="width:100%;height:auto"></svg>
    </div>
    <div class="inspector" id="dd-flow-note"></div>
  `;

  // ===== 14a · Stack =====
  // Keys here come from sql/dd/* and storage/innobase/dict/* in the 5.7/8.0 tree.
  const STACK = [
    { id:'sql', kind:'caller', title:'any caller — SHOW TABLES · INFORMATION_SCHEMA · SQL · handler::open()',
      paths: ['sql/sql_show.cc', 'sql/sql_table.cc'],
      arrow:'↓ dd::cache::Dictionary_client::acquire<dd::Table>("users")',
      note:'Top of the stack. Anything that needs to know "what columns does table X have?" goes through the DD client here.' },
    { id:'api', kind:'sql', title:'SQL layer · Data Dictionary API',
      paths: ['sql/dd/types/*.h', 'sql/dd/impl/tables/*.h', 'sql/dd/dd_client.h'],
      arrow:'↓ resolved → handler::ha_innobase open with mysql.ibd cursor',
      note:'<b>Defines the DD schema in code.</b> C++ classes such as <code>dd::tables::Tables</code>, <code>dd::Columns</code>, <code>dd::Indexes</code>, <code>dd::Schema</code>, <code>dd::Foreign_keys</code> describe what each DD table looks like. Read by the dictionary client.' },
    { id:'cache', kind:'cache', title:'DD in-memory cache',
      paths: ['sql/dd/impl/cache/shared_dictionary_cache.cc', 'sql/dd/cache/dictionary_client.cc'],
      arrow:'↓ on miss → handler::read via InnoDB B+Tree lookup',
      note:'LRU cache of recently-acquired <code>dd::Table</code> / <code>dd::Column</code> objects. Eliminates the cluster-index lookup on every parse. <code>acquire()</code> reads, <code>store()</code> commits, <code>drop()</code> evicts.' },
    { id:'inno', kind:'inno', title:'InnoDB · mysql.ibd',
      paths: ['storage/innobase/dict/dict0load.cc', 'storage/innobase/handler/ha_innodb.cc'],
      arrow:'mysql.tables · mysql.columns · mysql.indexes · mysql.schemata · mysql.foreign_keys · 30+ more',
      note:'<b>The catalog actually lives here.</b> Each DD table is a real clustered B+Tree in the single <code>mysql.ibd</code> tablespace. DDL writes them under one InnoDB trx → atomic, crash-safe, redo-and-undo-protected.' }
  ];
  let stackPick = null;

  function renderStack() {
    const svg = d3.select('#dd-stack-svg'); svg.selectAll('*').remove(); installArrowDefs(svg);
    // viewBox is 1200 × 380 (set in HTML). Each layer card now has its title
    // at the top, paths beneath, and the "↓ ..." arrow caption pinned to the
    // bottom-right so nothing overflows.
    const W = 1168, X = 16, Y0 = 8;
    const layerH = 88, gap = 12;

    STACK.forEach((L, i) => {
      const y = Y0 + i * (layerH + gap);
      const isInno = L.kind === 'inno';
      const isCaller = L.kind === 'caller';
      const stroke = isInno ? 'var(--green)' : isCaller ? 'var(--ink-dim)' : 'var(--accent)';
      const isPicked = (stackPick === L.id);

      const r = svg.append('rect').attr('x', X).attr('y', y).attr('width', W).attr('height', layerH).attr('rx', 8)
         .attr('fill', 'var(--panel-2)').attr('stroke', stroke).attr('stroke-width', isPicked ? 2.5 : 1.5)
         .style('cursor', 'pointer');
      if (isCaller) r.attr('stroke-dasharray', '6 4');
      r.on('click', () => { stackPick = L.id; renderStack(); d3.select('#dd-stack-note').html(`<b>${L.title.split('·').slice(-1)[0].trim()}</b><br><br>${L.note}`); });

      // Title (top-left)
      svg.append('text').attr('x', X + 16).attr('y', y + 22).attr('class', 'lbl-mono')
         .attr('fill', stroke).attr('font-size', 12).text(L.title);

      // Source paths (left-aligned, below title)
      L.paths.forEach((p, j) => svg.append('text').attr('x', X + 30).attr('y', y + 42 + j * 14)
         .attr('class', 'lbl-mono-dim').attr('font-size', 10.5).text('· ' + p));

      // "↓ ..." arrow caption pinned to the BOTTOM-RIGHT of the card so it
      // can never overlap the title even when both are long.
      svg.append('text').attr('x', X + W - 16).attr('y', y + layerH - 12).attr('text-anchor', 'end')
         .attr('class', 'lbl-mono').attr('font-size', 11).attr('fill', stroke).text(L.arrow);
    });
  }

  // ===== 14b · Table inspector =====
  // Two-column field listing per the photo.
  const TABLES = {
    schemata: {
      file: 'sql/dd/impl/tables/schemata.h',
      cols: [
        ['id (PK)', 'catalog_id'], ['name', 'default_collation_id'],
        ['default_encryption', 'created'], ['last_altered', 'options']
      ],
      note: 'ONE ROW PER SCHEMA (database). "name" is unique within "catalog_id".'
    },
    tables: {
      file: 'sql/dd/impl/tables/tables.h',
      cols: [
        ['id (PK)', 'schema_id'], ['name', 'engine'], ['row_format', 'options'],
        ['created', 'last_altered'], ['tablespace_id', '']
      ],
      note: 'ONE ROW PER TABLE. "engine" is "InnoDB" for everything since 8.0.'
    },
    columns: {
      file: 'sql/dd/impl/tables/columns.h',
      cols: [
        ['id (PK)', 'table_id'], ['name', 'ordinal_position'],
        ['type', 'char_length'], ['numeric_precision', 'is_nullable'],
        ['default', 'options']
      ],
      note: 'ONE ROW PER COLUMN. JOIN ON table_id GROUP BY table_id ORDER BY ordinal_position.'
    },
    indexes: {
      file: 'sql/dd/impl/tables/indexes.h',
      cols: [
        ['id (PK)', 'table_id'], ['name', 'type (PRIMARY/UNIQUE/...)'],
        ['algorithm', 'is_visible'], ['engine', 'comment'],
        ['ordinal_position', 'options'], ['se_private_data', 'tablespace_id']
      ],
      note: 'ONE ROW PER INDEX. JOIN WITH index_column_usage TO GET THE COLUMN LIST.'
    },
    foreign_keys: {
      file: 'sql/dd/impl/tables/foreign_keys.h',
      cols: [
        ['id (PK)', 'table_id'], ['schema_id', 'name'],
        ['match_option', 'update_rule'], ['delete_rule', 'referenced_table_name']
      ],
      note: 'ONE ROW PER FK CONSTRAINT. Child columns live in foreign_key_column_usage.'
    },
    tablespaces: {
      file: 'sql/dd/impl/tables/tablespaces.h',
      cols: [
        ['id (PK)', 'name'], ['options', 'engine'],
        ['comment', 'encryption'], ['autoextend_size', 'file_per_table']
      ],
      note: 'ONE ROW PER .ibd FILE plus the system tablespaces (mysql, innodb_temporary, ibdata1).'
    }
  };
  let curT = 'indexes';

  function renderTblButtons() {
    const box = section.querySelector('#dd-tbl-btns'); box.innerHTML = '';
    Object.keys(TABLES).forEach(name => {
      const b = document.createElement('button');
      b.className = 'btn' + (name === curT ? ' primary' : '');
      b.textContent = `mysql.${name}`;
      b.addEventListener('click', () => { curT = name; renderTblButtons(); renderTbl(); });
      box.appendChild(b);
    });
  }

  function renderTbl() {
    const svg = d3.select('#dd-tbl-svg'); svg.selectAll('*').remove(); installArrowDefs(svg);
    const T = TABLES[curT];
    const W = 1168, X = 16, Y = 16, H = 240;

    // outer card
    svg.append('rect').attr('x', X).attr('y', Y).attr('width', W).attr('height', H).attr('rx', 8)
       .attr('fill', 'none').attr('stroke', 'var(--border)').attr('stroke-width', 1.5);
    svg.append('text').attr('x', X + 16).attr('y', Y + 24).attr('class', 'lbl-mono')
       .attr('fill', 'var(--accent)').text(`mysql.${curT}`);
    svg.append('text').attr('x', X + W - 16).attr('y', Y + 24).attr('text-anchor', 'end')
       .attr('class', 'lbl-mono-dim').attr('font-size', 11).text(T.file);
    // separator
    svg.append('line').attr('x1', X + 16).attr('y1', Y + 36).attr('x2', X + W - 16).attr('y2', Y + 36)
       .attr('stroke', 'var(--border-2)');

    // two columns of field rows
    const colW = (W - 64) / 2;
    T.cols.forEach((row, i) => {
      const ry = Y + 60 + i * 26;
      [0, 1].forEach(c => {
        const txt = row[c]; if (!txt) return;
        const isPK = txt.includes('(PK)');
        const cx = X + 24 + c * colW;
        svg.append('text').attr('x', cx).attr('y', ry).attr('class', 'lbl-mono')
           .attr('font-size', 12).attr('fill', isPK ? 'var(--accent)' : 'var(--ink)').text(txt);
      });
    });

    // bottom note
    svg.append('text').attr('x', X + 16).attr('y', Y + H - 14).attr('class', 'lbl-mono-dim')
       .attr('font-size', 11).text(T.note);
  }

  // ===== 14c · CREATE TABLE walk =====
  // Each step is colored by its subsystem so the layer hand-offs are visible
  // at a glance. Tag colors:
  //   PARSER       → blue        (SQL parser, top of the SQL layer)
  //   DD CLIENT    → purple      (sql/dd/cache + sql/dd/impl/transaction_impl)
  //   DD OBJECTS   → pink        (sql/dd/types — the in-memory schema model)
  //   INNODB       → orange      (storage/innobase/* — actual disk writes)
  //   SQL+INNODB   → green       (final atomic commit crossing layers)
  const TAG_COLOR = {
    'PARSER':       'var(--blue)',
    'DD CLIENT':    'var(--accent-2)',
    'DD OBJECTS':   'var(--pink)',
    'INNODB':       'var(--orange)',
    'SQL + INNODB': 'var(--green)'
  };
  const STEPS = [
    { id:'parse',  tag:'PARSER',         body:'SQL layer parses the statement', src:'sql/sql_parse.cc → sql/sql_table.cc',
      detail:'<code>CREATE TABLE users (id INT PRIMARY KEY, name VARCHAR(64))</code> is parsed into an AST; <code>mysql_create_table()</code> is called.' },
    { id:'open',   tag:'DD CLIENT',      body:'Open DD transaction',            src:'sql/dd/impl/transaction_impl.cc',
      detail:'A DD-only sub-transaction is opened so DD writes can be rolled back independently of any user-data error.' },
    { id:'build',  tag:'DD OBJECTS',     body:'Build dd::Table in memory',      src:'sql/dd/types/table.h · sql/dd/impl/types/table_impl.cc',
      detail:'The parsed AST is converted into a <code>dd::Table</code> tree: <code>dd::Column</code>s, <code>dd::Index</code>es, options. Pure in-memory at this point.' },
    { id:'store',  tag:'DD CLIENT',      body:'Store through DD client',        src:'sql/dd/impl/cache/dictionary_client.cc::store()',
      detail:'<code>store()</code> queues the dd::Table for write; the cache marks it pending until commit.' },
    { id:'iddata', tag:'INNODB',         body:'InnoDB writes rows to mysql.ibd',src:'storage/innobase/handler/ha_innodb.cc → row/row0ins.cc',
      detail:'For each modified DD table, <code>ha_innobase</code> inserts cluster + secondary index rows. Each insert generates undo + redo just like a user write.' },
    { id:'create', tag:'INNODB',         body:'Create the user tablespace + index', src:'storage/innobase/row/row0mysql.cc · dict0crea.cc',
      detail:'A new .ibd is allocated for the <code>users</code> table; the clustered index page is initialized; the new tablespace id is recorded in mysql.tablespaces.' },
    { id:'commit', tag:'SQL + INNODB',   body:'Commit DD trx atomically',       src:'trx/trx0trx.cc · dictionary_client::commit_modified_objects()',
      detail:'The DD sub-trx commits via the same redo+undo path as user data. After the commit fsync, the cache exposes the new dd::Table to other threads.' }
  ];
  const STEP_AFFECTS = {
    iddata: ['mysql.tables', 'mysql.columns', 'mysql.indexes'],
    create: ['mysql.tablespaces'],
    commit: ['mysql.tables', 'mysql.columns', 'mysql.indexes', 'mysql.tablespaces']
  };
  let st = 0;

  let ddlTimer = null;
  section.querySelector('[data-act="ddl-step"]').addEventListener('click',  () => { if (st < STEPS.length - 1) st++; renderFlow(); });
  section.querySelector('[data-act="ddl-play"]').addEventListener('click', () => {
    if (ddlTimer) { clearInterval(ddlTimer); ddlTimer = null; return; }
    ddlTimer = setInterval(() => {
      if (st >= STEPS.length - 1) { clearInterval(ddlTimer); ddlTimer = null; return; }
      st++; renderFlow();
    }, 1100);
  });
  section.querySelector('[data-act="ddl-reset"]').addEventListener('click', () => {
    if (ddlTimer) { clearInterval(ddlTimer); ddlTimer = null; }
    st = 0; renderFlow();
  });

  function renderFlow() {
    const svg = d3.select('#dd-flow-svg'); svg.selectAll('*').remove(); installArrowDefs(svg);

    // ---- LEFT: numbered steps with subsystem-colored [TAG] chip ----
    svg.append('rect').attr('x', 16).attr('y', 16).attr('width', 700).attr('height', 460).attr('rx', 8)
       .attr('fill', 'none').attr('stroke', 'var(--border)').attr('stroke-width', 1.5);
    STEPS.forEach((s, k) => {
      const y = 36 + k * 60;
      const cur = (k === st), past = (k < st);
      const tagColor = TAG_COLOR[s.tag] || 'var(--accent)';
      const ringColor = cur ? 'var(--accent)' : (past ? 'var(--ok)' : 'var(--ink-dim)');
      // bullet (number ring) — current/past use status color, the tag chip carries the subsystem color
      svg.append('circle').attr('cx', 42).attr('cy', y + 14).attr('r', 11)
         .attr('fill', cur ? 'rgba(74,229,229,0.12)' : 'var(--panel-2)')
         .attr('stroke', ringColor).attr('stroke-width', 1.5);
      svg.append('text').attr('x', 42).attr('y', y + 18).attr('text-anchor', 'middle').attr('class', 'lbl-mono').attr('fill', ringColor).text(k + 1);
      // body
      svg.append('text').attr('x', 64).attr('y', y + 14).attr('class', 'lbl-mono')
         .attr('fill', cur ? 'var(--accent)' : 'var(--ink)').attr('font-weight', cur ? 700 : 400).text(s.body);
      // colorful [TAG] pill — use inline style for fill so the .lbl-mono class
      // (which presets fill:var(--ink-2)) doesn't override the text color and
      // wash out the contrast against the colored pill fill.
      const tagText = s.tag, tagW = tagText.length * 7 + 18;
      svg.append('rect').attr('x', 64).attr('y', y + 24).attr('width', tagW).attr('height', 18).attr('rx', 9)
         .style('fill',   past || cur ? tagColor : 'var(--panel-2)')
         .style('stroke', tagColor).attr('stroke-width', 1.2);
      svg.append('text').attr('x', 64 + tagW / 2).attr('y', y + 37).attr('text-anchor', 'middle')
         .attr('class', 'lbl-mono').attr('font-size', 10)
         .style('fill', past || cur ? 'var(--bg)' : tagColor)   // .style() beats the .lbl-mono class
         .attr('font-weight', 700).text(tagText);
      // src path next to tag
      svg.append('text').attr('x', 64 + tagW + 12).attr('y', y + 37).attr('class', 'lbl-mono-dim').attr('font-size', 10).text(s.src);
    });

    // ---- RIGHT: mysql.ibd · DD tables (glow on affected) ----
    svg.append('rect').attr('x', 736).attr('y', 16).attr('width', 448).attr('height', 460).attr('rx', 8)
       .attr('fill', 'none').attr('stroke', 'var(--green)').attr('stroke-width', 1.5);
    svg.append('text').attr('x', 748).attr('y', 38).attr('class', 'lbl-mono-dim').attr('fill', 'var(--green)').text('mysql.ibd · DD tables');

    const order = ['mysql.tables','mysql.columns','mysql.indexes','mysql.tablespaces'];
    const written = new Set();
    for (let k = 0; k <= st; k++) (STEP_AFFECTS[STEPS[k].id] || []).forEach(t => written.add(t));
    const affectedNow = new Set(STEP_AFFECTS[STEPS[st].id] || []);
    order.forEach((t, k) => {
      const y = 64 + k * 64;
      const isNow = affectedNow.has(t);
      const everWritten = written.has(t);
      const stroke = isNow ? 'var(--accent)' : (everWritten ? 'var(--orange)' : 'var(--border-2)');
      svg.append('rect').attr('x', 752).attr('y', y).attr('width', 416).attr('height', 50).attr('rx', 5)
         .attr('fill', 'var(--panel-2)').attr('stroke', stroke).attr('stroke-width', isNow ? 2 : 1.5);
      svg.append('text').attr('x', 764).attr('y', y + 22).attr('class', 'lbl-mono')
         .attr('fill', isNow ? 'var(--accent)' : (everWritten ? 'var(--orange)' : 'var(--ink-dim)')).text(t);
      svg.append('text').attr('x', 764).attr('y', y + 40).attr('class', 'lbl-mono-dim').attr('font-size', 10)
         .text(isNow ? '+1 PENDING ROW(S) THIS STEP' : (everWritten ? 'PENDING (EARLIER STEP)' : 'NO PENDING CHANGES'));
    });
    // DD trx in flight indicator at the bottom
    const trxY = 64 + 4 * 64 + 16;
    svg.append('rect').attr('x', 752).attr('y', trxY).attr('width', 416).attr('height', 36).attr('rx', 5)
       .attr('fill', 'none').attr('stroke', st >= STEPS.length - 1 ? 'var(--ok)' : 'var(--orange)').attr('stroke-dasharray', '5 4');
    svg.append('text').attr('x', 764).attr('y', trxY + 22).attr('class', 'lbl-mono')
       .attr('fill', st >= STEPS.length - 1 ? 'var(--ok)' : 'var(--orange)')
       .text(st >= STEPS.length - 1 ? 'DD trx COMMITTED & fsynced' : 'DD trx in flight (not durable yet)');

    d3.select('#dd-flow-note').html(`<b>Step ${st + 1}/${STEPS.length}</b> — ${STEPS[st].body} <code>${STEPS[st].src}</code><br><br>${STEPS[st].detail}`);
  }

  renderStack();
  renderTblButtons();
  renderTbl();
  renderFlow();
})();
