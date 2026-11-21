import { Dataset, DEFAULTS, INDEXED, QUERIES, VIEWS, type Frame, type Hit, type Parameters, type Report, type View, type WorkerInput, type WorkerOutput } from './engine';
import { SearchMap } from './map';

type Param = keyof Parameters;
const KEYS = Object.keys(DEFAULTS) as Param[];

function quantity(count: number, label: string) {
  return `${count.toLocaleString()} ${label}${count === 1 ? '' : 's'}`;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function recall(report: Report) {
  const exact = new Set(report.baseline.map(([id]) => id));
  return report.result.filter(([id]) => exact.has(id)).length;
}

export class VectorSearch extends HTMLElement {
  private worker?: Worker;
  private resize?: ResizeObserver;
  private timer?: number;
  private editTimer?: number;

  connectedCallback() {
    if (this.worker) return;
    const select = <T extends HTMLElement>(selector: string) => this.querySelector<T>(selector)!;
    const inputs = new Map(KEYS.map(key => [key, select<HTMLInputElement>(`[data-parameter="${key}"]`)]));
    const tabs = [...this.querySelectorAll<HTMLButtonElement>('[data-view]')];
    const previous = select<HTMLButtonElement>('[data-prev]');
    const next = select<HTMLButtonElement>('[data-next]');
    const play = select<HTMLButtonElement>('[data-play]');
    const full = select<HTMLButtonElement>('[data-fullscreen]');
    const scrub = select<HTMLInputElement>('[data-scrub]');
    const speed = select<HTMLSelectElement>('[data-speed]');
    const status = select('[data-status]');
    const metrics = select('[data-metrics]');
    const count = select('[data-frame-count]');
    const stage = select('[data-dashboard]');
    const queryStrip = select('[data-queries]');
    const title = select('[data-frame-title]');
    const columns = select('[data-columns]');
    const list = select('[data-steps]');
    const mapCanvas = select<HTMLCanvasElement>('[data-map]');
    const source = select<HTMLDetailsElement>('[data-source]');
    const resultOverlay = select('[data-results]');
    const share = select<HTMLAnchorElement>('[data-share]');
    let data: Dataset;
    let map: SearchMap;
    let stepButtons: HTMLButtonElement[] = [];
    let reports: Report[] = [];
    let busy = true;
    let job = 0;

    // Playback renders independent snapshots written by Rust.
    let step = 0;
    let playing = false;
    const url = new URL(location.href);
    let view: View = VIEWS.find(name => name === url.searchParams.get('view')) ?? 'search';
    let initialStep = VIEWS.some(name => name === url.searchParams.get('view'))
      ? Number(url.searchParams.get('step') ?? '0')
      : 0;
    const params = { ...DEFAULTS };
    for (const [key, input] of inputs) {
      const encoded = url.searchParams.get(key);
      if (encoded !== null) input.value = encoded;
    }

    const parseInputs = () => {
      for (const [key, input] of inputs) {
        const value = input.valueAsNumber;
        params[key] = Math.max(Number(input.min), Math.min(Number(input.max), Number.isFinite(value) ? Math.round(value) : DEFAULTS[key]));
        input.value = String(params[key]);
      }
      params.ef = Math.max(params.k, params.ef);
      params.efc = Math.max(params.M, params.efc);
      for (const [key, input] of inputs) input.value = String(params[key]);
    };

    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    this.worker = worker;
    const post = (message: WorkerInput) => worker.postMessage(message);

    const display = (score: number, report: Report) => (score / (65025 * report.scale)).toFixed(2);

    const syncLink = () => {
      const href = new URL(location.href);
      for (const obsolete of ['leaves', 'nleaves', 'rerank']) href.searchParams.delete(obsolete);
      href.searchParams.set('view', view);
      for (const key of KEYS) href.searchParams.set(key, String(params[key]));
      href.searchParams.set('dist', 'l2');
      href.searchParams.set('step', String(step));
      history.replaceState(history.state, '', href);
      share.href = href.href;
      share.hidden = false;
    };

    const showControls = () => {
      for (const tab of tabs) tab.setAttribute('aria-pressed', String(tab.dataset.view === view));
      for (const group of this.querySelectorAll<HTMLElement>('[data-parameter-group]')) {
        group.hidden = group.dataset.parameterGroup === 'query' && view !== 'search';
      }
      queryStrip.replaceChildren();
      if (!data) return;
      const offset = Math.max(0, Math.min(params.q - 2, QUERIES - 5));
      for (let query = offset; query < offset + 5; query++) {
        const id = INDEXED + query;
        const button = element('button');
        button.type = 'button';
        button.setAttribute('aria-pressed', String(query === params.q));
        const label = `Query ${query}: ${data.label(id)}`;
        button.setAttribute('aria-label', label);
        button.title = label;
        button.append(data.thumbnail(id));
        button.onclick = () => {
          inputs.get('q')!.value = String(query);
          rerun();
        };
        queryStrip.append(button);
      }
    };

    const setBusy = (value: boolean) => {
      busy = value;
      this.toggleAttribute('data-busy', value);
      this.setAttribute('aria-busy', String(value));
      if (value) {
        previous.disabled = next.disabled = play.disabled = scrub.disabled = true;
        status.textContent = 'Running the index in WebAssembly…';
        metrics.hidden = true;
      }
    };

    const setPlaying = (value: boolean) => {
      playing = value;
      play.textContent = value ? 'Pause' : 'Play';
      window.clearTimeout(this.timer);
      if (playing) {
        this.timer = window.setTimeout(() => {
          if (!reports[0]) return;
          if (step < reports[0].frames.length - 1) setStep(step + 1);
          setPlaying(step < reports[0].frames.length - 1);
        }, 770 / Number(speed.value));
      }
    };

    const snapshot = () => {
      const report = reports[0];
      const frame = report?.frames[step];
      if (report && frame) {
        map.draw(report, frame, INDEXED + params.q);
      }
    };

    const imageRow = ([id, score]: Hit, report: Report) => {
      const item = element('li');
      item.append(data.thumbnail(id));
      const label = element('span', `#${id}`);
      label.title = data.label(id);
      item.append(label, element('code', display(score, report)));
      return item;
    };

    const card = (label: string, note: string, hits: Hit[], report: Report) => {
      const shell = element('div', undefined, 'vx-column');
      const sourceLines: Record<string, number> = {
        examined: 221, candidates: 113, best: 114, rejected: 233, refill: 309,
      };
      shell.title = `wasm/vector_search.rs:${sourceLines[label]}`;
      if (label === 'candidates' || label === 'best') shell.setAttribute('data-heap', '');
      shell.append(element('h4', label), element('p', note));
      if (hits.length) {
        const rows = element('ol');
        hits.forEach(hit => rows.append(imageRow(hit, report)));
        shell.append(rows);
      } else {
        shell.append(element('p', 'Empty', 'vx-empty'));
      }
      return shell;
    };

    const renderColumns = (report: Report, frame: Frame) => {
      columns.replaceChildren();
      if (view === 'graph') {
        const graphDetails = element('div', undefined, 'vx-column');
        graphDetails.append(element('h4', 'Graph links'), element('p', 'Directed edges connect nodes within a layer. The base layer shows a sample of its edges.'));
        const counts = element('ul');
        for (let layer = Math.max(...report.levels); layer >= 0; layer--) {
          counts.append(element('li', `Layer ${layer}: ${report.levels.filter(level => level >= layer).length} nodes`));
        }
        graphDetails.append(counts);
        columns.append(graphDetails);
        return;
      }

      columns.append(
        card('examined', 'Neighbors evaluated in this frame', frame.examined, report),
        card('candidates', `Min-heap · ${frame.frontier.length}`, frame.frontier, report),
      );

      const bound = view === 'hnsw-insert' ? params.efc : params.ef;
      const sorted = frame.title.includes('Return');
      const selected = frame.title.includes('keep') && view === 'hnsw-insert';
      const note = sorted ? 'Sorted by distance' : selected ? 'Selected connections' : `${frame.best.length} held · bound ${bound}`;
      const best = card('best', note, frame.best, report);
      if (sorted || selected) best.removeAttribute('data-heap');
      columns.append(best, card('rejected', 'Pruned or evicted this frame', frame.rejected, report));
      if (frame.ranked.length) columns.append(card('refill', 'Closest discarded neighbors reused', frame.ranked, report));

      if (frame.stop) {
        const [candidate, worst, full] = frame.stop;
        const test = element('div', undefined, 'vx-column');
        const op = candidate > worst ? '>' : candidate < worst ? '<' : '=';
        test.append(element('h4', 'Stop test'),
          element('p', full ? 'Heap is full' : 'Heap has space'),
          element('code', `${display(candidate, report)} ${op} ${display(worst, report)}`));
        columns.append(test);
      }

    };

    const results = (report: Report, label: string) => {
      const root = element('div', undefined, 'vx-result-set');
      const exactIds = new Set(report.baseline.map(([id]) => id));
      const sameLabel = report.result.filter(([id]) => data.label(id) === data.label(INDEXED + params.q)).length;
      root.append(element('h4', label), element('p', `Recall@${params.k} ${recall(report)}/${report.baseline.length} · Label matches ${sameLabel}/${report.result.length}`));
      const grids = element('div', undefined, 'vx-result-grids');
      for (const [name, hits] of [['Index', report.result], ['Brute force', report.baseline]] as const) {
        const group = element('div');
        group.append(element('strong', name));
        const rows = element('ol');
        for (const hit of hits) {
          const [id] = hit;
          const row = imageRow(hit, report);
          if (name === 'Index' && !exactIds.has(id)) {
            const miss = element('span', 'Miss', 'vx-miss');
            row.append(miss);
          }
          rows.append(row);
        }
        group.append(rows);
        grids.append(group);
      }
      root.append(grids);
      return root;
    };

    const update = () => {
      const report = reports[0];
      if (!report) return;
      const frame = report.frames[step];
      const total = report.frames.length;
      const atEnd = step === total - 1;
      count.textContent = `Step ${step + 1} of ${total}`;
      scrub.max = String(total - 1);
      scrub.value = String(step);
      previous.disabled = busy || step === 0;
      next.disabled = busy || atEnd;
      play.disabled = scrub.disabled = busy || total < 2;
      snapshot();
      title.textContent = frame.title;
      metrics.textContent = `${quantity(frame.scored, 'distance evaluation')} · ${quantity(frame.visited, 'visit')}`;
      metrics.hidden = false;
      renderColumns(report, frame);
      stepButtons.forEach((button, index) => {
        if (index === step) button.setAttribute('aria-current', 'step');
        else button.removeAttribute('aria-current');
      });
      const active = stepButtons[step];
      const item = active.getBoundingClientRect();
      const steps = list.getBoundingClientRect();
      if (item.bottom > steps.bottom) list.scrollTop += item.bottom - steps.bottom;
      else if (item.top < steps.top) list.scrollTop -= steps.top - item.top;
      resultOverlay.hidden = !atEnd || report.baseline.length === 0;
      if (resultOverlay.hidden) resultOverlay.replaceChildren();
      else resultOverlay.replaceChildren(results(report, 'Final results'));
      syncLink();
    };

    const setStep = (position: number) => {
      if (busy || !reports[0]) return;
      step = Math.min(reports[0].frames.length - 1, Math.max(0, Math.trunc(Number.isFinite(position) ? position : 0)));
      update();
    };

    const rerun = () => {
      window.clearTimeout(this.editTimer);
      if (!data) return;
      setPlaying(false);
      map.close();
      parseInputs();
      showControls();
      reports = [];
      setBusy(true);
      share.hidden = true;
      post({ type: 'run', job: ++job, view, params });
    };

    worker.onmessage = ({ data: message }: MessageEvent<WorkerOutput>) => {
      if (message.type === 'ready') {
        data = new Dataset(message.data);
        map = new SearchMap(mapCanvas, select('[data-popup]'), data);
        this.resize = new ResizeObserver(snapshot);
        this.resize.observe(mapCanvas);
        rerun();
      } else if (message.type === 'result' && message.job === job) {
        reports = message.reports;
        setBusy(false);
        status.textContent = '';
        list.replaceChildren();
        stepButtons = [];
        reports[0].frames.forEach((frame, index) => {
          const li = element('li');
          const button = element('button', frame.title);
          button.type = 'button';
          button.onclick = () => { setPlaying(false); setStep(index); };
          li.append(button);
          list.append(li);
          stepButtons.push(button);
        });
        stage.hidden = false;
        setStep(initialStep);
        initialStep = 0;
      } else if (message.type === 'error' && (message.job === undefined || message.job === job)) {
        setBusy(false);
        status.textContent = message.message;
        stage.hidden = true;
      }
    };
    worker.onerror = () => {
      setBusy(false);
      status.textContent = 'Could not start the WebAssembly worker. Reload to try again.';
    };

    for (const input of inputs.values()) {
      input.addEventListener('input', () => {
        window.clearTimeout(this.editTimer);
        this.editTimer = window.setTimeout(rerun, 400);
      });
      input.addEventListener('change', rerun);
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') rerun();
      });
    }
    for (const tab of tabs) tab.onclick = () => {
      view = tab.dataset.view as View;
      initialStep = 0;
      rerun();
    };
    previous.onclick = () => { setPlaying(false); setStep(step - 1); };
    next.onclick = () => { setPlaying(false); setStep(step + 1); };
    play.onclick = () => {
      if (busy) return;
      if (!playing && step === reports[0].frames.length - 1) setStep(0);
      setPlaying(!playing);
    };
    scrub.oninput = () => { setPlaying(false); setStep(scrub.valueAsNumber); };
    speed.onchange = () => { if (playing) setPlaying(true); };
    const expand = (value: boolean) => {
      this.toggleAttribute('data-expanded', value);
      this.setAttribute('role', value ? 'dialog' : 'region');
      if (value) this.setAttribute('aria-modal', 'true');
      else this.removeAttribute('aria-modal');
      full.textContent = value ? 'Exit full screen' : 'Full screen';
      full.setAttribute('aria-pressed', String(value));
      full.focus({ preventScroll: true });
    };
    full.onclick = () => expand(!this.hasAttribute('data-expanded'));
    this.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        const inspecting = source.open || !select('[data-popup]').hidden;
        map?.close();
        source.open = false;
        if (!inspecting && this.hasAttribute('data-expanded')) expand(false);
      }
      if (event.key === 'Tab' && this.hasAttribute('data-expanded')) {
        const focusable = Array.from(this.querySelectorAll<HTMLElement>('button, input, select, summary, a[href], [tabindex="0"]'))
          .filter(node => !node.matches(':disabled') && node.getClientRects().length > 0);
        const first = focusable[0];
        const last = focusable.at(-1);
        const leaving = event.shiftKey ? document.activeElement === first : document.activeElement === last;
        if (leaving) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
    });
    // The popup also offers keyboard dismissal if the user opened it with a pointer.
    mapCanvas.tabIndex = 0;

    parseInputs();
    showControls();
    setBusy(true);
    status.textContent = 'Loading the WASM explorer and Fashion-MNIST images…';
    post({ type: 'init', engine: this.dataset.engine!, data: this.dataset.dataset! });
  }

  disconnectedCallback() {
    window.clearTimeout(this.timer);
    window.clearTimeout(this.editTimer);
    this.resize?.disconnect();
    this.worker?.terminate();
    this.worker = undefined;
  }
}
