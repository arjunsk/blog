/* shell.js — global tooltip + scroll-spy sidebar + shared SVG defs */
(function () {
  document.body.classList.toggle('is-embedded', window.self !== window.top);
  // ---------- Global tooltip (created once, attached to body) ----------
  const tooltipEl = document.createElement('div');
  tooltipEl.id = 'tooltip';
  document.body.appendChild(tooltipEl);

  window.Tooltip = {
    show(html, x, y) {
      tooltipEl.innerHTML = html;
      let px = x + 14, py = y + 14;
      const tw = tooltipEl.offsetWidth, th = tooltipEl.offsetHeight;
      // Position near cursor, flipping if needed
      if (px + tw > window.innerWidth  - 10) px = x - tw - 14;
      if (py + th > window.innerHeight - 10) py = y - th - 14;
      tooltipEl.style.left = px + 'px';
      tooltipEl.style.top  = py + 'px';
      tooltipEl.classList.add('show');
    },
    hide() { tooltipEl.classList.remove('show'); }
  };

  // attachTip — attach hover tooltips to a D3 selection
  window.attachTip = function (sel, htmlFn) {
    sel.classed('hover-target', true)
       .on('mousemove.tip',  function (e, d) { Tooltip.show(htmlFn(d, this), e.clientX, e.clientY); })
       .on('mouseleave.tip', function ()      { Tooltip.hide(); });
  };

  // ---------- Scroll-spy for sidebar ----------
  function initScrollSpy() {
    const links = document.querySelectorAll('#sidebar nav a');
    const sections = [...links].map(a => document.querySelector(a.getAttribute('href')));
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) {
          const id = '#' + e.target.id;
          links.forEach(a => a.classList.toggle('active', a.getAttribute('href') === id));
        }
      });
    }, { rootMargin: '-40% 0px -55% 0px' });
    sections.forEach(s => s && observer.observe(s));
  }

  // ---------- Shared SVG arrow markers ----------
  // Inject one <defs> into every SVG that any module creates.
  window.installArrowDefs = function (svgSel) {
    if (svgSel.select('defs[data-shell]').size()) return;
    const defs = svgSel.insert('defs', ':first-child').attr('data-shell', '1');
    const m = (id, fill) => defs.append('marker')
      .attr('id', id).attr('viewBox', '0 0 10 10').attr('refX', 9).attr('refY', 5)
      .attr('markerWidth', 6).attr('markerHeight', 6).attr('orient', 'auto')
      .append('path').attr('d', 'M0,0 L10,5 L0,10 z').attr('fill', fill);
    m('arrow-head',         'var(--ink-dim)');
    m('arrow-head-acc',     'var(--accent)');
    m('arrow-head-purple',  'var(--accent-2)');
    m('arrow-head-warn',    'var(--warn)');
    m('arrow-head-blue',    'var(--blue)');
  };

  // ---------- Sidebar toggle (click button, [, or ⌘/Ctrl+B) ----------
  function initSidebarToggle() {
    const key = 'innodb-sidebar-collapsed';
    const button = document.getElementById('sidebar-toggle');
    const sidebar = document.getElementById('sidebar');
    const compact = window.matchMedia('(max-width: 860px)');
    let desktopPreference = false;
    try { desktopPreference = localStorage.getItem(key) === '1'; } catch (_) {}

    function setCollapsed(collapsed) {
      document.body.classList.toggle('sidebar-collapsed', collapsed);
      button.setAttribute('aria-expanded', String(!collapsed));
      sidebar.inert = collapsed;
    }

    function syncLayout() {
      setCollapsed(compact.matches || desktopPreference);
    }

    function toggle() {
      const collapsed = !document.body.classList.contains('sidebar-collapsed');
      setCollapsed(collapsed);
      if (!compact.matches) {
        desktopPreference = collapsed;
        try { localStorage.setItem(key, collapsed ? '1' : '0'); } catch (_) {}
      }
    }

    syncLayout();
    compact.addEventListener('change', syncLayout);
    button.addEventListener('click', toggle);
    sidebar.querySelectorAll('nav a').forEach(link => link.addEventListener('click', () => {
      if (compact.matches) {
        setCollapsed(true);
        button.focus({ preventScroll: true });
      }
    }));

    document.addEventListener('keydown', event => {
      const target = event.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      if (event.key === '[' || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b')) {
        event.preventDefault();
        toggle();
      }
      if (event.key === 'Escape' && compact.matches && !sidebar.inert) {
        setCollapsed(true);
        button.focus({ preventScroll: true });
      }
    });
  }

  // Boot: after all module IIFEs ran, install defs everywhere and start scroll-spy.
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('main svg').forEach(s => installArrowDefs(d3.select(s)));
    initScrollSpy();
    initSidebarToggle();
  });
})();
