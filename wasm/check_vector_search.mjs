import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const asset = name => new URL(`../public/${name}`, import.meta.url);
const scratch = mkdtempSync(join(tmpdir(), 'autoinc-vector-search-'));
try {
  await verify(scratch);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

async function verify(directory) {
  const pixels = gunzipSync(readFileSync(asset('vector-search/fashion-mnist.pack')));
  const rawPath = join(directory, 'fashion-mnist.bin');
  const nativePath = join(directory, 'vector-search-native');
  writeFileSync(rawPath, pixels);
  const compile = spawnSync('rustc', [
    '--edition', '2024', '-C', 'opt-level=3',
    fileURLToPath(new URL('./vector_search.rs', import.meta.url)), '-o', nativePath,
  ], { encoding: 'utf8' });
  assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
  const { instance: { exports: engine } } = await WebAssembly.instantiate(readFileSync(asset('vector-search.wasm')));
  const offset = engine.init_pixels();
  new Uint8Array(engine.memory.buffer, offset, 6500 * 784).set(pixels.subarray(0, 6500 * 784));
  const decoder = new TextDecoder();
  function runWasm(args, trace) {
    const len = engine.run(...args, trace);
    return JSON.parse(decoder.decode(new Uint8Array(engine.memory.buffer, engine.output_ptr(), len)));
  }
  function brute(q, k) {
    return Array.from({ length: 6000 }, (_, id) => {
      let score = 0;
      for (let i = 0; i < 784; i++) {
        const delta = pixels[784 * id + i] - pixels[784 * (6000 + q) + i];
        score += delta * delta;
      }
      return [id, score];
    }).sort((a, b) => a[1] - b[1] || a[0] - b[0]).slice(0, k);
  }
  function heap(list, min) {
    const compare = (a, b) => a[1] - b[1] || a[0] - b[0];
    for (let i=1; i<list.length; i++) assert.ok((min ? 1 : -1) * compare(list[i], list[(i-1)>>1]) >= 0);
  }

  for (const [view,q,k,seed,ef,m,efc,leaves,nleaves,rerank] of [
    [1,3,8,41,32,8,40,12,3,0],
    [1,498,15,7,64,12,72,16,6,0],
    [2,31,8,41,32,8,40,12,3,0],
    [3,0,8,41,32,8,40,12,1,0],
    [3,26,8,1,32,8,40,12,7,32],
    [4,499,8,41,32,8,40,12,3,0],
    [5,77,8,41,32,8,40,12,3,0],
    [0,0,8,41,32,8,40,12,3,0],
  ]) {
    const args = [view,q,k,seed,ef,m,efc,leaves,nleaves,rerank];
    const traced = runWasm(args, 1);
    const silent = runWasm(args, 0);
    assert.deepEqual(traced.map(({frames,...data})=>data), silent.map(({frames,...data})=>data));
    const native = spawnSync(nativePath, [rawPath, ...args.map(String),'1'], {encoding:'utf8',maxBuffer:16*1024*1024});
    assert.equal(native.status, 0, native.stderr);
    assert.deepEqual(traced, JSON.parse(native.stdout));
    for (const report of traced) {
      const expected=brute(q,k);
      if (report.baseline.length) {
        assert.deepEqual(report.baseline.map(([id,score])=>[id,score/report.scale]), expected);
        const hits = report.result.filter(([id])=>expected.some(([exact])=>exact===id)).length;
        console.log('recall',view,q,hits+'/'+k);
      }
      for (const f of report.frames) {
        heap(f.frontier,true);
        if (f.title.includes('expand #')||f.title.includes('stop at #')||f.title.includes('keep row #')||f.title.includes('rows outside the heap')) heap(f.best,false);
        if (f.title.includes('expand #')||f.title.includes('stop at #')) assert.ok(f.best.length<=(view===2?efc:ef));
        if (f.title.includes('keep row #')) assert.ok(f.best.length<=Math.max(k,rerank));
      }
    }
  }
  const baseline=[1,31,8,41,32,8,40,12,3,0];
  const before=runWasm(baseline,1);
  runWasm([2,...baseline.slice(1)],1);
  assert.deepEqual(runWasm(baseline,1),before);
  console.log('Verified native/WASM and trace-on/trace-off parity, exact baseline, and heap invariants.');
}
