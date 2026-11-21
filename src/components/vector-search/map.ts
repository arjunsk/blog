import { Dataset, INDEXED, type Frame, type Report } from './engine';

type Target = { id: number; x: number; y: number; context: string };


export class SearchMap {
  private targets: Target[] = [];
  private pinned = false;
  private shown?: Target;

  constructor(private canvas: HTMLCanvasElement, private popup: HTMLElement, private data: Dataset) {
    canvas.addEventListener('pointermove', event => {
      if (!this.pinned) this.inspect(event);
    });
    canvas.addEventListener('pointerleave', () => {
      if (!this.pinned) this.close();
    });
    canvas.addEventListener('click', event => {
      this.pinned = false;
      this.pinned = this.inspect(event);
    });
  }

  close() {
    this.pinned = false;
    this.shown = undefined;
    this.popup.hidden = true;
  }

  private inspect(event: MouseEvent) {
    let nearest: Target | undefined;
    let min = 64;
    for (const target of this.targets) {
      const score = (event.offsetX - target.x) ** 2 + (event.offsetY - target.y) ** 2;
      if (score < min) {
        nearest = target;
        min = score;
      }
    }
    if (!nearest) {
      this.close();
      return false;
    }
    if (nearest.id === this.shown?.id && nearest.context === this.shown.context) return true;
    const label = document.createElement('span');
    label.textContent = `#${nearest.id} · ${this.data.label(nearest.id)} · ${nearest.context}`;
    this.popup.replaceChildren(this.data.thumbnail(nearest.id), label);
    this.popup.style.left = `${Math.max(0, Math.min(nearest.x + 8, this.canvas.clientWidth - 158))}px`;
    this.popup.style.top = `${Math.max(0, Math.min(nearest.y + 8, this.canvas.clientHeight - 45))}px`;
    this.popup.hidden = false;
    this.shown = nearest;
    return true;
  }

  draw(report: Report, frame: Frame, query: number) {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w < 1 || h < 1) return;
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * ratio);
    this.canvas.height = Math.round(h * ratio);
    const c = this.canvas.getContext('2d')!;
    c.scale(ratio, ratio);
    c.font = '11px ui-monospace, monospace';
    this.targets = [];
    const top = Math.max(report.insertion?.[1] ?? 0, ...report.levels);
    const stride = h / (top + 1);

    const place = (id: number, layer: number) => {
      const [x, y] = this.data.point(id);
      return [14 + x * (w - 28), (top - layer) * stride + 23 + (1 - y) * Math.max(1, stride - 37)];
    };
    const line = (a: number[], b: number[], color: string) => {
      c.strokeStyle = color;
      c.beginPath();
      c.moveTo(a[0], a[1]);
      c.lineTo(b[0], b[1]);
      c.stroke();
    };
    const point = (id: number, layer: number, size: number, color: string, shape: 'dot' | 'square' | 'ring' | 'cross' | 'diamond') => {
      const [x, y] = place(id, layer);
      c.fillStyle = c.strokeStyle = color;
      c.beginPath();
      if (shape === 'diamond') {
        c.moveTo(x, y - size);
        c.lineTo(x + size, y);
        c.lineTo(x, y + size);
        c.lineTo(x - size, y);
        c.closePath();
        c.fill();
      } else if (shape === 'cross') {
        line([x - size, y - size], [x + size, y + size], color);
        line([x - size, y + size], [x + size, y - size], color);
      } else if (shape === 'square') {
        c.fillRect(x - size, y - size, size * 2, size * 2);
      } else {
        c.arc(x, y, size, 0, Math.PI * 2);
        if (shape === 'ring') c.stroke(); else c.fill();
      }
    };

    for (let layer = top; layer >= 0; layer--) {
      const offset = (top - layer) * stride;
      c.fillStyle = layer === frame.layer ? '#1c2737' : '#151d2a';
      c.fillRect(0, offset + 1, w, stride - 3);
      c.fillStyle = '#b9c8dc';
      const count = report.levels.filter(level => level >= layer).length;
      c.fillText(`Layer ${layer} · ${count.toLocaleString()} nodes`, 10, offset + 15);
    }
    c.strokeStyle = '#4b637b';
    c.setLineDash([2, 3]);
    const descent = frame.best[0]?.[0] ?? frame.node;
    if (frame.layer > 0 && descent >= 0 && report.levels[descent] >= frame.layer) {
      line(place(descent, frame.layer), place(descent, frame.layer - 1), '#778eac');
    }
    c.setLineDash([]);
    for (const [layer, from, to] of report.edges) line(place(from, layer), place(to, layer), '#8fb8f012');
    for (let id = 0; id < INDEXED; id++) {
      for (let layer = 0; layer <= report.levels[id]; layer++) {
        point(id, layer, layer === 0 ? 1 : 1.7, layer === frame.layer ? '#8097b67d' : '#819abb55', 'dot');
        const [x, y] = place(id, layer);
        this.targets.push({ id, x, y, context: `layer ${layer}` });
      }
    }
    for (const [from, to] of frame.links) line(place(from, frame.layer), place(to, frame.layer), '#b1d1fc9c');

    const layer = frame.layer;
    for (const [id] of frame.examined) point(id, layer, 3, '#78b4fa', 'dot');
    for (const [id] of frame.rejected) point(id, layer, 3, '#f58c94', 'cross');
    for (const [id] of frame.best.slice(0, 24)) point(id, layer, 3, '#68d8ab', 'square');
    if (frame.node >= 0) point(frame.node, layer, 6, '#ffb575', 'ring');
    point(query, layer, 5, '#f491d3', 'diamond');
    const [x, y] = place(query, layer);
    this.targets.unshift({ id: query, x, y, context: 'query' });
  }
}
