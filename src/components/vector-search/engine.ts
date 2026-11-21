export const DIM = 784;
export const INDEXED = 6000;
export const QUERIES = 500;
const LABELS = ['T-shirt', 'Trousers', 'Pullover', 'Dress', 'Coat', 'Sandal', 'Shirt', 'Sneaker', 'Bag', 'Ankle boot'];

export const VIEWS = ['graph', 'search', 'hnsw-insert'] as const;
export type View = (typeof VIEWS)[number];

export const DEFAULTS = {
  q: 3, k: 8, seed: 41, ef: 32, M: 8, efc: 40,
};
export type Parameters = typeof DEFAULTS;
export type Hit = [id: number, score: number];
export type Frame = {
  title: string;
  layer: number;
  node: number;
  scored: number;
  visited: number;
  examined: Hit[];
  frontier: Hit[];
  best: Hit[];
  rejected: Hit[];
  ranked: Hit[];
  links: [from: number, to: number][];
  stop: [current: number, bound: number, full: boolean] | null;
};
export type Report = {
  scale: number;
  entry: number;
  levels: number[];
  edges: [layer: number, from: number, to: number][];
  insertion: [id: number, layer: number] | null;
  result: Hit[];
  baseline: Hit[];
  frames: Frame[];
};
export type WorkerInput =
  | { type: 'init'; engine: string; data: string }
  | { type: 'run'; job: number; view: View; params: Parameters };
export type WorkerOutput =
  | { type: 'ready'; data: ArrayBuffer }
  | { type: 'result'; job: number; reports: Report[] }
  | { type: 'error'; job?: number; message: string };

export class Dataset {
  private pixels: Uint8Array;
  private coords: DataView;
  private labels: Uint8Array;
  private thumbnails = new Map<number, string>();

  constructor(buffer: ArrayBuffer) {
    const count = INDEXED + QUERIES;
    this.pixels = new Uint8Array(buffer, 0, count * DIM);
    this.labels = new Uint8Array(buffer, this.pixels.length, count);
    this.coords = new DataView(buffer, this.pixels.length + count, count * 4);
  }

  label(id: number) { return LABELS[this.labels[id]]; }

  point(id: number) {
    return [this.coords.getUint16(id * 4, true) / 65535, this.coords.getUint16(id * 4 + 2, true) / 65535];
  }

  thumbnail(id: number) {
    let src = this.thumbnails.get(id);
    if (!src) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 28;
      const context = canvas.getContext('2d')!;
      const rgba = context.createImageData(28, 28);
      this.pixels.subarray(id * DIM, (id + 1) * DIM).forEach((value, i) => {
        rgba.data.set([value, value, value, 255], i * 4);
      });
      context.putImageData(rgba, 0, 0);
      src = canvas.toDataURL();
      this.thumbnails.set(id, src);
    }
    const image = new Image(28, 28);
    image.src = src;
    image.alt = this.label(id);
    image.draggable = false;
    return image;
  }
}
