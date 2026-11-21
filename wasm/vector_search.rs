use std::cell::RefCell;
use std::cmp::Reverse;
use std::collections::BinaryHeap;
use std::fmt::Write;

const DIM: usize = 784;
const N: usize = 6000;
const QUERIES: usize = 500;
const SQ: u64 = 127 * 127;

#[derive(Clone, Copy, Debug, Default, Eq, Ord, PartialEq, PartialOrd)]
struct Hit {
    score: u64,
    id: usize,
}

struct Rng(u32);
impl Rng {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0
    }
}

fn image(data: &[u8], id: usize) -> &[u8] {
    &data[id * DIM..(id + 1) * DIM]
}

fn l2(a: &[u8], b: &[u8]) -> u64 {
    a.iter()
        .zip(b)
        .map(|(&x, &y)| {
            let delta = i32::from(x) - i32::from(y);
            (delta * delta) as u32
        })
        .sum::<u32>() as u64
}

fn distance(data: &[u8], a: usize, b: usize) -> u64 {
    l2(image(data, a), image(data, b))
}

fn exact(data: &[u8], query: usize, k: usize, scale: u64) -> Vec<Hit> {
    let mut rows: Vec<_> = (0..N)
        .map(|id| Hit {
            id,
            score: distance(data, query, id) * scale,
        })
        .collect();
    rows.sort_unstable();
    rows.truncate(k);
    rows
}

#[derive(Default)]
struct Frame {
    title: String,
    layer: usize,
    node: Option<usize>,
    leaf: Option<usize>,
    scored: usize,
    visited: usize,
    examined: Vec<Hit>,
    frontier: Vec<Hit>,
    best: Vec<Hit>,
    rejected: Vec<Hit>,
    ranked: Vec<Hit>,
    links: Vec<[usize; 2]>,
    stop: Option<(u64, u64, bool)>,
    codes: Vec<i8>,
}

#[derive(Default)]
struct Trace {
    frames: Vec<Frame>,
    scored: usize,
    visited: usize,
}

impl Trace {
    fn push(&mut self, mut frame: Frame) {
        frame.scored = self.scored;
        frame.visited = self.visited;
        self.frames.push(frame);
    }
}

fn record(trace: &mut Option<&mut Trace>, frame: impl FnOnce() -> Frame) {
    if let Some(trace) = trace {
        trace.push(frame());
    }
}

fn heap_ids(heap: &BinaryHeap<Reverse<Hit>>) -> Vec<Hit> {
    heap.as_slice().iter().map(|hit| hit.0).collect()
}

#[derive(Clone)]
struct Graph {
    // The row at id contains one neighbour list per layer this node belongs to.
    links: Vec<Vec<Vec<usize>>>,
    entry: usize,
    top: usize,
    max_links: usize,
    ef_construction: usize,
    rng_state: u32,
}

struct Beam {
    visited: Vec<bool>,
    candidates: BinaryHeap<Reverse<Hit>>,
    best: BinaryHeap<Hit>,
}

impl Graph {
    fn build(data: &[u8], seed: u32, max_links: usize, ef_construction: usize) -> Self {
        let mut graph = Self {
            links: Vec::with_capacity(N + QUERIES),
            entry: 0,
            top: 0,
            max_links,
            ef_construction,
            rng_state: seed.max(1),
        };
        for id in 0..N {
            graph.insert(data, id, None);
        }
        graph
    }

    fn greedy(
        &self,
        data: &[u8],
        query: usize,
        mut cursor: Hit,
        layer: usize,
        trace: &mut Option<&mut Trace>,
    ) -> Hit {
        loop {
            let mut closest = cursor;
            let mut examined = Vec::new();
            for &id in &self.links[cursor.id][layer] {
                let hit = Hit {
                    id,
                    score: distance(data, query, id),
                };
                closest = closest.min(hit);
                if let Some(trace) = trace {
                    trace.scored += 1;
                    examined.push(hit);
                }
            }
            if let Some(trace) = trace {
                trace.visited += 1;
                let title = if closest == cursor {
                    format!("Layer {layer}: descend from #{}", cursor.id)
                } else {
                    format!("Layer {layer}: move #{} to #{}", cursor.id, closest.id)
                };
                trace.push(Frame {
                    title,
                    layer,
                    node: Some(cursor.id),
                    examined,
                    best: vec![closest],
                    ..Frame::default()
                });
            }
            if closest == cursor {
                return cursor;
            }
            cursor = closest;
        }
    }

    fn search_layer(
        &self,
        data: &[u8],
        query: usize,
        entry: Hit,
        layer: usize,
        ef: usize,
        trace: &mut Option<&mut Trace>,
    ) -> Vec<Hit> {
        let mut beam = Beam {
            visited: vec![false; self.links.len()],
            candidates: BinaryHeap::from([Reverse(entry)]),
            best: BinaryHeap::from([entry]),
        };
        beam.visited[entry.id] = true;
        if let Some(trace) = trace {
            trace.visited += 1;
        }
        record(trace, || Frame {
            title: format!("Layer {layer}: seed the heaps with #{}", entry.id),
            layer,
            node: Some(entry.id),
            frontier: vec![entry],
            best: vec![entry],
            ..Frame::default()
        });

        while let Some(Reverse(current)) = beam.candidates.pop() {
            let furthest = beam.best.peek().unwrap().score;
            let full = beam.best.len() == ef;
            if full && current.score > furthest {
                record(trace, || Frame {
                    title: format!("Layer {layer}: stop at #{}", current.id),
                    layer,
                    node: Some(current.id),
                    frontier: heap_ids(&beam.candidates),
                    best: beam.best.as_slice().to_vec(),
                    stop: Some((current.score, furthest, full)),
                    ..Frame::default()
                });
                break;
            }

            let mut examined = Vec::new();
            let mut rejected = Vec::new();
            let mut links = Vec::new();
            for &id in &self.links[current.id][layer] {
                if beam.visited[id] {
                    continue;
                }
                beam.visited[id] = true;
                let hit = Hit {
                    id,
                    score: distance(data, query, id),
                };
                let removed = if beam.best.len() < ef || hit < *beam.best.peek().unwrap() {
                    beam.candidates.push(Reverse(hit));
                    beam.best.push(hit);
                    if beam.best.len() > ef {
                        beam.best.pop()
                    } else {
                        None
                    }
                } else {
                    Some(hit)
                };
                if let Some(trace) = trace {
                    trace.scored += 1;
                    trace.visited += 1;
                    examined.push(hit);
                    links.push([current.id, id]);
                    if let Some(hit) = removed {
                        rejected.push(hit);
                    }
                }
            }
            record(trace, || Frame {
                title: format!(
                    "Layer {layer}: expand #{} ({} new)",
                    current.id,
                    examined.len()
                ),
                layer,
                node: Some(current.id),
                examined,
                rejected,
                links,
                frontier: heap_ids(&beam.candidates),
                best: beam.best.as_slice().to_vec(),
                stop: Some((current.score, furthest, full)),
                ..Frame::default()
            });
        }
        beam.best.into_sorted_vec()
    }

    fn query(
        &self,
        data: &[u8],
        query: usize,
        k: usize,
        ef: usize,
        mut trace: Option<&mut Trace>,
    ) -> Vec<Hit> {
        let mut cursor = Hit {
            id: self.entry,
            score: distance(data, query, self.entry),
        };
        if let Some(trace) = &mut trace {
            trace.scored += 1;
        }
        record(&mut trace, || Frame {
            title: format!("Start at entry #{} on layer {}", cursor.id, self.top),
            layer: self.top,
            node: Some(cursor.id),
            best: vec![cursor],
            ..Frame::default()
        });
        for layer in (1..=self.top).rev() {
            cursor = self.greedy(data, query, cursor, layer, &mut trace);
        }
        let mut best = self.search_layer(data, query, cursor, 0, ef, &mut trace);
        best.truncate(k);
        record(&mut trace, || Frame {
            title: format!("Return {} results in distance order", best.len()),
            best: best.clone(),
            ..Frame::default()
        });
        best
    }

    fn select_neighbors(
        data: &[u8],
        candidates: &[Hit],
        limit: usize,
    ) -> (Vec<usize>, Vec<Hit>, Vec<usize>, usize) {
        let mut kept = Vec::new();
        let mut discarded = Vec::new();
        let mut scored = 0;
        for &hit in candidates {
            if kept.len() < limit
                && kept.iter().all(|&other| {
                    scored += 1;
                    distance(data, hit.id, other) >= hit.score
                })
            {
                kept.push(hit.id);
            } else {
                discarded.push(hit);
            }
        }
        let refill: Vec<_> = discarded
            .iter()
            .take(limit - kept.len())
            .map(|hit| hit.id)
            .collect();
        kept.extend(&refill);
        (kept, discarded, refill, scored)
    }

    fn insert(&mut self, data: &[u8], row: usize, mut trace: Option<&mut Trace>) -> usize {
        let mut rng = Rng(self.rng_state);
        let mut level = 0;
        while rng.next().is_multiple_of(self.max_links as u32) && level < 5 {
            level += 1;
        }
        self.rng_state = rng.0;
        record(&mut trace, || Frame {
            title: format!("Draw layer {level} for the new node #{row}"),
            layer: level,
            node: Some(row),
            ..Frame::default()
        });

        // Insertions may use a held-out query ID, which need not follow N.
        let first = self.links.is_empty();
        self.links.resize_with(row + 1, Vec::new);
        self.links[row] = vec![Vec::new(); level + 1];
        if first {
            self.entry = row;
            self.top = level;
            return level;
        }

        let mut cursor = Hit {
            id: self.entry,
            score: distance(data, row, self.entry),
        };
        if let Some(trace) = &mut trace {
            trace.scored += 1;
        }
        for layer in ((level + 1)..=self.top).rev() {
            cursor = self.greedy(data, row, cursor, layer, &mut trace);
        }
        for layer in (0..=self.top.min(level)).rev() {
            let candidates =
                self.search_layer(data, row, cursor, layer, self.ef_construction, &mut trace);
            cursor = candidates[0];
            let (kept, pruned, refill, scored) =
                Self::select_neighbors(data, &candidates, self.max_links);
            if let Some(trace) = &mut trace {
                trace.scored += scored;
            }
            self.links[row][layer].clone_from(&kept);
            record(&mut trace, || Frame {
                title: format!(
                    "Layer {layer}: keep {} neighbors, refill {}",
                    kept.len(),
                    refill.len()
                ),
                layer,
                node: Some(row),
                examined: candidates.clone(),
                best: candidates
                    .iter()
                    .copied()
                    .filter(|hit| kept.contains(&hit.id))
                    .collect(),
                rejected: pruned
                    .iter()
                    .copied()
                    .filter(|hit| !refill.contains(&hit.id))
                    .collect(),
                ranked: pruned
                    .into_iter()
                    .filter(|hit| refill.contains(&hit.id))
                    .collect(),
                links: kept.iter().map(|&id| [row, id]).collect(),
                ..Frame::default()
            });

            let limit = if layer == 0 {
                self.max_links * 2
            } else {
                self.max_links
            };
            for &id in &kept {
                self.links[id][layer].push(row);
                let mut removed = Vec::new();
                if self.links[id][layer].len() > limit {
                    let mut ranked: Vec<_> = self.links[id][layer]
                        .iter()
                        .map(|&neighbor| Hit {
                            id: neighbor,
                            score: distance(data, id, neighbor),
                        })
                        .collect();
                    ranked.sort_unstable();
                    let (snipped, pruned, _, scored) = Self::select_neighbors(data, &ranked, limit);
                    self.links[id][layer] = snipped;
                    if let Some(trace) = &mut trace {
                        trace.scored += ranked.len() + scored;
                        removed = pruned
                            .into_iter()
                            .filter(|hit| !self.links[id][layer].contains(&hit.id))
                            .collect();
                    }
                }
                record(&mut trace, || Frame {
                    title: format!("Layer {layer}: update backlinks at #{id} (cap {limit})"),
                    layer,
                    node: Some(id),
                    rejected: removed,
                    links: self.links[id][layer]
                        .iter()
                        .map(|&neighbor| [id, neighbor])
                        .collect(),
                    ..Frame::default()
                });
            }
        }
        if level > self.top {
            self.entry = row;
            self.top = level;
        }
        record(&mut trace, || Frame {
            title: format!("Insert #{row} into the copy of the graph"),
            layer: level,
            node: Some(row),
            ..Frame::default()
        });
        level
    }
}

struct PartitionIndex {
    centroids: Vec<Vec<u8>>,
    rows: Vec<Vec<usize>>,
    partitions: Vec<usize>,
    scales: Vec<Vec<u8>>,
    codes: Vec<Vec<i8>>,
}

fn rank_centroids(data: &[u8], centroids: &[Vec<u8>], query: usize) -> Vec<Hit> {
    let mut ranked: Vec<_> = centroids
        .iter()
        .enumerate()
        .map(|(id, center)| Hit {
            id,
            score: l2(image(data, query), center) * SQ,
        })
        .collect();
    ranked.sort_unstable();
    ranked
}

fn encode(row: &[u8], centroid: &[u8], scales: &[u8]) -> Vec<i8> {
    row.iter()
        .zip(centroid)
        .zip(scales)
        .map(|((&pixel, &center), &scale)| {
            let scaled = (i32::from(pixel) - i32::from(center)) * 127;
            let scale = i32::from(scale);
            ((scaled + scaled.signum() * (scale / 2)) / scale).clamp(-127, 127) as i8
        })
        .collect()
}

fn score_code(query: &[u8], centroid: &[u8], scales: &[u8], code: &[i8]) -> u64 {
    query
        .iter()
        .zip(centroid)
        .zip(scales)
        .zip(code)
        .map(|(((&q, &c), &s), &v)| {
            let delta = (i32::from(q) - i32::from(c)) * 127 - i32::from(v) * i32::from(s);
            i64::from(delta) * i64::from(delta)
        })
        .sum::<i64>() as u64
}

impl PartitionIndex {
    fn build(data: &[u8], seed: u32, leaves: usize) -> Self {
        let mut rng = Rng(seed.max(1));
        let mut centroids: Vec<_> = (0..leaves)
            .map(|_| image(data, rng.next() as usize % N).to_vec())
            .collect();
        let mut partitions = vec![0; N];
        for _ in 0..3 {
            assign(data, &centroids, &mut partitions);
            let mut sums = vec![vec![0u32; DIM]; leaves];
            let mut counts = vec![0; leaves];
            for (row, &leaf) in partitions.iter().enumerate() {
                for (sum, &pixel) in sums[leaf].iter_mut().zip(image(data, row)) {
                    *sum += u32::from(pixel);
                }
                counts[leaf] += 1;
            }
            for ((center, sum), count) in centroids.iter_mut().zip(sums).zip(counts) {
                if count != 0 {
                    for (cell, value) in center.iter_mut().zip(sum) {
                        *cell = ((value + count / 2) / count) as u8;
                    }
                }
            }
        }
        assign(data, &centroids, &mut partitions);

        let mut rows = vec![Vec::new(); leaves];
        let mut scales = vec![vec![1u8; DIM]; leaves];
        for (row, &leaf) in partitions.iter().enumerate() {
            rows[leaf].push(row);
            for ((scale, &pixel), &center) in scales[leaf]
                .iter_mut()
                .zip(image(data, row))
                .zip(&centroids[leaf])
            {
                *scale = (*scale).max(pixel.abs_diff(center));
            }
        }
        let codes = partitions
            .iter()
            .enumerate()
            .map(|(row, &leaf)| encode(image(data, row), &centroids[leaf], &scales[leaf]))
            .collect();
        Self {
            centroids,
            rows,
            partitions,
            scales,
            codes,
        }
    }

    fn query(
        &self,
        data: &[u8],
        query: usize,
        k: usize,
        probes: usize,
        rerank: usize,
        mut trace: Option<&mut Trace>,
    ) -> Vec<Hit> {
        let ranked = rank_centroids(data, &self.centroids, query);
        if let Some(trace) = &mut trace {
            trace.scored += ranked.len();
        }
        record(&mut trace, || Frame {
            title: format!("Rank {} centroids by distance", ranked.len()),
            ranked: ranked.clone(),
            ..Frame::default()
        });
        let budget = k.max(rerank);
        let mut best = BinaryHeap::new();
        let query_image = image(data, query);
        for &Hit { id: leaf, .. } in ranked.iter().take(probes) {
            let mut skipped = 0;
            let mut last_skipped = None;
            let mut examined = Vec::new();
            record(&mut trace, || Frame {
                title: format!("Open leaf {} ({} rows)", leaf + 1, self.rows[leaf].len()),
                leaf: Some(leaf),
                ranked: ranked.clone(),
                best: best.as_slice().to_vec(),
                ..Frame::default()
            });
            for &id in &self.rows[leaf] {
                let hit = Hit {
                    id,
                    score: score_code(
                        query_image,
                        &self.centroids[leaf],
                        &self.scales[leaf],
                        &self.codes[id],
                    ),
                };
                if let Some(trace) = &mut trace {
                    trace.scored += 1;
                    trace.visited += 1;
                }
                let threshold = best.peek().copied();
                let full = best.len() == budget;
                let accepted = !full || hit < threshold.unwrap();
                if accepted {
                    best.push(hit);
                    let removed = if best.len() > budget {
                        best.pop()
                    } else {
                        None
                    };
                    record(&mut trace, || Frame {
                        title: format!("Leaf {}: keep row #{id}{}", leaf + 1, skip_note(skipped)),
                        node: Some(id),
                        leaf: Some(leaf),
                        examined: vec![hit],
                        best: best.as_slice().to_vec(),
                        rejected: removed.into_iter().collect(),
                        ranked: ranked.clone(),
                        stop: threshold.map(|t| (hit.score, t.score, full)),
                        ..Frame::default()
                    });
                    skipped = 0;
                    examined.clear();
                } else if trace.is_some() {
                    skipped += 1;
                    last_skipped = Some(hit);
                    if examined.len() < 6 {
                        examined.push(hit);
                    }
                }
            }
            if skipped > 0 {
                let last = last_skipped.unwrap();
                record(&mut trace, || Frame {
                    title: format!("Leaf {}: skip {skipped} rows outside the heap", leaf + 1),
                    node: Some(last.id),
                    leaf: Some(leaf),
                    examined,
                    best: best.as_slice().to_vec(),
                    ranked: ranked.clone(),
                    stop: Some((last.score, best.peek().unwrap().score, true)),
                    ..Frame::default()
                });
            }
        }
        let mut found = best.into_sorted_vec();
        if rerank > 0 {
            let approx = found.clone();
            for hit in &mut found {
                hit.score = distance(data, query, hit.id) * SQ;
            }
            found.sort_unstable();
            if let Some(trace) = &mut trace {
                trace.scored += found.len();
            }
            record(&mut trace, || Frame {
                title: format!("Rerank {} candidates with exact distance", found.len()),
                examined: approx,
                best: found.clone(),
                ranked,
                ..Frame::default()
            });
        }
        found.truncate(k);
        record(&mut trace, || Frame {
            title: format!("Return {} results in distance order", found.len()),
            best: found.clone(),
            ..Frame::default()
        });
        found
    }

    fn preview_insert(&self, data: &[u8], query: usize, trace: &mut Trace) -> usize {
        let ranked = rank_centroids(data, &self.centroids, query);
        let leaf = ranked[0].id;
        trace.scored = ranked.len();
        trace.push(Frame {
            title: format!("Route the new row to leaf {}", leaf + 1),
            node: Some(query),
            leaf: Some(leaf),
            ranked: ranked.clone(),
            ..Frame::default()
        });
        let codes = encode(
            image(data, query),
            &self.centroids[leaf],
            &self.scales[leaf],
        );
        trace.push(Frame {
            title: "Encode 784 residuals as signed 8-bit values".into(),
            node: Some(query),
            leaf: Some(leaf),
            codes: codes.clone(),
            ranked: ranked.clone(),
            ..Frame::default()
        });
        let mut rows = self.rows[leaf].clone();
        rows.push(query);
        trace.visited += 1;
        trace.push(Frame {
            title: format!(
                "Append row #{query} to the copy of leaf {} ({} rows)",
                leaf + 1,
                rows.len()
            ),
            node: Some(query),
            leaf: Some(leaf),
            codes,
            ranked,
            ..Frame::default()
        });
        leaf
    }
}

fn skip_note(skipped: usize) -> String {
    if skipped == 0 {
        String::new()
    } else {
        format!(" after {skipped} skips")
    }
}

fn assign(data: &[u8], centroids: &[Vec<u8>], partitions: &mut [usize]) {
    for (row, leaf) in partitions.iter_mut().enumerate() {
        let pixels = image(data, row);
        *leaf = centroids
            .iter()
            .enumerate()
            .min_by_key(|(_, center)| l2(pixels, center))
            .unwrap()
            .0;
    }
}

#[derive(Clone, Copy)]
struct Settings {
    view: usize,
    query: usize,
    k: usize,
    seed: u32,
    ef: usize,
    m: usize,
    efc: usize,
    leaves: usize,
    probes: usize,
    rerank: usize,
}

impl Settings {
    fn from_args(args: [u32; 10]) -> Self {
        let [view, q, k, seed, ef, m, efc, leaves, probes, rerank] = args.map(|v| v as usize);
        let k = k.clamp(1, 20);
        let leaves = leaves.clamp(4, 48);
        Self {
            view: view.min(5),
            query: N + q.min(QUERIES - 1),
            k,
            seed: seed as u32,
            ef: ef.clamp(k, 128),
            m: m.clamp(4, 16),
            efc: efc.clamp(m, 128),
            leaves,
            probes: probes.clamp(1, leaves),
            rerank: rerank.min(128),
        }
    }
}

#[derive(Default)]
struct Model {
    pixels: Vec<u8>,
    graph: Option<((u32, usize, usize), Graph)>,
    partitions: Option<((u32, usize), PartitionIndex)>,
    output: String,
}

#[derive(Default)]
struct Report {
    scale: u64,
    trace: Trace,
    result: Vec<Hit>,
    baseline: Vec<Hit>,
    levels: Vec<usize>,
    edges: Vec<[usize; 3]>,
    membership: Vec<usize>,
    entry: usize,
    insertion: Option<[usize; 2]>,
}

impl Model {
    fn graph_report(&mut self, s: Settings, traced: bool) -> Report {
        let key = (s.seed, s.m, s.efc);
        if self.graph.as_ref().is_none_or(|(key0, _)| *key0 != key) {
            self.graph = Some((key, Graph::build(&self.pixels, s.seed, s.m, s.efc)));
        }
        let graph = &self.graph.as_ref().unwrap().1;
        let mut report = Report {
            scale: 1,
            entry: graph.entry,
            levels: graph.links.iter().map(|layers| layers.len() - 1).collect(),
            ..Report::default()
        };
        for (from, layers) in graph.links.iter().enumerate() {
            for (level, neighbors) in layers.iter().enumerate() {
                // The base map is an overview; active layer-zero links come from the trace.
                if level == 0 && from % 29 != 0 {
                    continue;
                }
                report
                    .edges
                    .extend(neighbors.iter().map(|&to| [level, from, to]));
            }
        }
        if s.view == 2 {
            let mut copy = graph.clone();
            let level = copy.insert(&self.pixels, s.query, traced.then_some(&mut report.trace));
            report.insertion = Some([s.query, level]);
        } else if s.view == 0 {
            report.trace.push(Frame {
                title: format!("Graph entry #{} on layer {}", graph.entry, graph.top),
                layer: graph.top,
                node: Some(graph.entry),
                ..Frame::default()
            });
        } else {
            report.result = graph.query(
                &self.pixels,
                s.query,
                s.k,
                s.ef,
                traced.then_some(&mut report.trace),
            );
            report.baseline = exact(&self.pixels, s.query, s.k, 1);
        }
        report
    }

    fn partition_report(&mut self, s: Settings, traced: bool) -> Report {
        let key = (s.seed, s.leaves);
        if self
            .partitions
            .as_ref()
            .is_none_or(|(key0, _)| *key0 != key)
        {
            self.partitions = Some((key, PartitionIndex::build(&self.pixels, s.seed, s.leaves)));
        }
        let index = &self.partitions.as_ref().unwrap().1;
        let mut report = Report {
            scale: SQ,
            membership: index.partitions.clone(),
            ..Report::default()
        };
        if s.view == 4 {
            let mut trace = Trace::default();
            let leaf = index.preview_insert(&self.pixels, s.query, &mut trace);
            if traced {
                report.trace = trace;
            }
            report.insertion = Some([s.query, leaf]);
        } else {
            report.result = index.query(
                &self.pixels,
                s.query,
                s.k,
                s.probes,
                s.rerank,
                traced.then_some(&mut report.trace),
            );
            report.baseline = exact(&self.pixels, s.query, s.k, SQ);
        }
        report
    }

    fn run(&mut self, s: Settings, traced: bool) {
        let mut primary = if s.view < 3 || s.view == 5 {
            self.graph_report(s, traced)
        } else {
            self.partition_report(s, traced)
        };
        let mut output = String::new();
        if s.view == 5 {
            let mut other = self.partition_report(s, traced);
            keep_final_frame(&mut primary);
            keep_final_frame(&mut other);
            output.push('[');
            primary.write_json(&mut output);
            output.push(',');
            other.write_json(&mut output);
            output.push(']');
        } else {
            output.push('[');
            primary.write_json(&mut output);
            output.push(']');
        }
        self.output = output;
    }
}

fn keep_final_frame(report: &mut Report) {
    let final_frame = report.trace.frames.pop();
    report.trace.frames = final_frame.into_iter().collect();
}

fn hits_json(out: &mut String, hits: &[Hit]) {
    out.push('[');
    for (index, hit) in hits.iter().enumerate() {
        if index != 0 {
            out.push(',');
        }
        write!(out, "[{},{}]", hit.id, hit.score).unwrap();
    }
    out.push(']');
}

impl Report {
    fn write_json(&self, out: &mut String) {
        write!(
            out,
            r#"{{"scale":{},"entry":{},"levels":{:?},"edges":{:?},"membership":{:?},"insertion":"#,
            self.scale, self.entry, self.levels, self.edges, self.membership
        )
        .unwrap();
        if let Some(insert) = self.insertion {
            write!(out, "{insert:?}").unwrap();
        } else {
            out.push_str("null");
        }
        out.push_str(r#","result":"#);
        hits_json(out, &self.result);
        out.push_str(r#","baseline":"#);
        hits_json(out, &self.baseline);
        out.push_str(r#","frames":["#);
        for (index, frame) in self.trace.frames.iter().enumerate() {
            if index != 0 {
                out.push(',');
            }
            write!(out, r#"{{"title":{:?},"layer":{},"node":{},"leaf":{},"scored":{},"visited":{},"links":{:?},"codes":{:?},"stop":"#,
                frame.title, frame.layer, frame.node.map_or(-1, |n| n as isize),
                frame.leaf.map_or(-1, |n| n as isize), frame.scored, frame.visited, frame.links, frame.codes).unwrap();
            if let Some((current, worst, full)) = frame.stop {
                write!(out, "[{current},{worst},{full}]").unwrap();
            } else {
                out.push_str("null");
            }
            for (key, values) in [
                ("examined", &frame.examined),
                ("frontier", &frame.frontier),
                ("best", &frame.best),
                ("rejected", &frame.rejected),
                ("ranked", &frame.ranked),
            ] {
                write!(out, ",\"{key}\":").unwrap();
                hits_json(out, values);
            }
            out.push('}');
        }
        out.push_str("]}");
    }
}

thread_local! { static MODEL: RefCell<Model> = RefCell::new(Model::default()); }

#[unsafe(no_mangle)]
pub extern "C" fn init_pixels() -> *mut u8 {
    MODEL.with_borrow_mut(|model| {
        model.pixels = vec![0; (N + QUERIES) * DIM];
        model.graph = None;
        model.partitions = None;
        model.pixels.as_mut_ptr()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn run(
    view: u32,
    query: u32,
    k: u32,
    seed: u32,
    ef: u32,
    m: u32,
    efc: u32,
    leaves: u32,
    probes: u32,
    rerank: u32,
    traced: u32,
) -> usize {
    MODEL.with_borrow_mut(|model| {
        let settings =
            Settings::from_args([view, query, k, seed, ef, m, efc, leaves, probes, rerank]);
        model.run(settings, traced != 0);
        model.output.len()
    })
}

#[unsafe(no_mangle)]
pub extern "C" fn output_ptr() -> *const u8 {
    MODEL.with_borrow(|model| model.output.as_ptr())
}

#[cfg(not(target_arch = "wasm32"))]
fn main() {
    let mut args = std::env::args().skip(1);
    let source = std::fs::read(args.next().expect("path to raw pixels")).unwrap();
    assert!(source.len() >= (N + QUERIES) * DIM);
    let values: Vec<u32> = args.map(|arg| arg.parse().unwrap()).collect();
    assert_eq!(values.len(), 11);
    MODEL.with_borrow_mut(|model| model.pixels = source);
    run(
        values[0], values[1], values[2], values[3], values[4], values[5], values[6], values[7],
        values[8], values[9], values[10],
    );
    MODEL.with_borrow(|model| print!("{}", model.output));
}
