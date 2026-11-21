import { DIM, INDEXED, QUERIES, VIEWS, type WorkerInput, type WorkerOutput } from './engine';

type Engine = {
  memory: WebAssembly.Memory;
  init_pixels: () => number;
  run: (...args: number[]) => number;
  output_ptr: () => number;
};

const decoder = new TextDecoder();
let engine: Engine;

async function fetchAsset(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('An explorer asset could not be loaded.');
  return response;
}

self.onmessage = async ({ data }: MessageEvent<WorkerInput>) => {
  const post = (message: WorkerOutput, transfer: Transferable[] = []) => self.postMessage(message, { transfer });
  try {
    if (data.type === 'init') {
      const [wasm, compressed] = await Promise.all([fetchAsset(data.engine), fetchAsset(data.data)]);
      const [{ instance }, buffer] = await Promise.all([
        wasm.arrayBuffer().then(bytes => WebAssembly.instantiate(bytes)),
        new Response(compressed.body!.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer(),
      ]);
      engine = instance.exports as unknown as Engine;
      const count = INDEXED + QUERIES;
      if (buffer.byteLength !== count * (DIM + 5)) throw new Error('The image dataset has an unexpected size.');
      const offset = engine.init_pixels();
      new Uint8Array(engine.memory.buffer, offset, count * DIM).set(new Uint8Array(buffer, 0, count * DIM));
      post({ type: 'ready', data: buffer }, [buffer]);
    } else {
      const { q, k, seed, ef, M, efc } = data.params;
      const size = engine.run(VIEWS.indexOf(data.view), q, k, seed, ef, M, efc, 0, 0, 0, 1);
      const bytes = new Uint8Array(engine.memory.buffer, engine.output_ptr(), size);
      post({ type: 'result', job: data.job, reports: JSON.parse(decoder.decode(bytes)) });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The explorer could not run.';
    post({ type: 'error', job: data.type === 'run' ? data.job : undefined, message });
  }
};
