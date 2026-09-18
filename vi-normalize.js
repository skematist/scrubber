// Raw Azure Video Indexer Get-Video-Index JSON → compact client model.
// All times become float seconds; per-shot links are precomputed so the client
// can filter with pure Set intersections.

// "0:00:09.1333333" | "1:02:03" | "0:07" | 12.5 → seconds
function parseTs(v) {
  if (typeof v === 'number') return v;
  if (v == null) return NaN;
  const parts = String(v).split(':').map(Number);
  if (parts.some(isNaN)) return NaN;
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  return s;
}

function instRanges(instances) {
  return (instances || [])
    .map(i => [parseTs(i.start), parseTs(i.end)])
    .filter(([a, b]) => !isNaN(a) && !isNaN(b) && b > a);
}

// merge overlapping/near-adjacent ranges (gap < 1s)
function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] - last[1] < 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

function totalDur(ranges) {
  return ranges.reduce((s, [a, b]) => s + (b - a), 0);
}

// map ranges → indexes of overlapping shots (shots sorted by start)
function linkShots(ranges, shots) {
  const idx = new Set();
  for (const [s, e] of ranges) {
    // binary search: first shot whose end > s
    let lo = 0, hi = shots.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (shots[mid].end > s) hi = mid; else lo = mid + 1;
    }
    for (let i = lo; i < shots.length && shots[i].start < e; i++) {
      const ov = Math.min(e, shots[i].end) - Math.max(s, shots[i].start);
      const shotLen = shots[i].end - shots[i].start;
      if (ov >= Math.min(0.5, 0.5 * shotLen)) idx.add(i);
    }
  }
  return [...idx].sort((a, b) => a - b);
}

function round(n) { return Math.round(n * 1000) / 1000; }

function normalize(raw, opts = {}) {
  const video = (raw.videos && raw.videos[0]) || {};
  const ins = video.insights || {};
  const duration = opts.duration || parseTs(ins.duration) || 0;

  // ---- shots ----
  const shots = (ins.shots || [])
    .map(sh => {
      const inst = instRanges(sh.instances);
      if (!inst.length) return null;
      const kf = (sh.keyFrames || [])
        .flatMap(k => (k.instances || []).map(i => parseTs(i.start)))
        .filter(t => !isNaN(t))
        .sort((a, b) => a - b);
      return { start: inst[0][0], end: inst[inst.length - 1][1], kf, type: sh.tags || [] };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
  // a shot with no detected keyframe still needs an image: use its midpoint
  for (const sh of shots) if (!sh.kf.length) sh.kf = [(sh.start + sh.end) / 2];

  // ---- scenes (shotIdx by midpoint containment; tolerate <3 scenes = empty) ----
  const scenes = (ins.scenes || [])
    .map(sc => {
      const inst = instRanges(sc.instances);
      if (!inst.length) return null;
      return { start: inst[0][0], end: inst[inst.length - 1][1], shotIdx: [] };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);
  shots.forEach((sh, i) => {
    const mid = (sh.start + sh.end) / 2;
    const sc = scenes.find(s => mid >= s.start && mid < s.end);
    if (sc) sc.shotIdx.push(i);
  });

  // ---- people (faces): union of instances ∪ thumbnails[].instances ----
  let unnamed = 0;
  const people = (ins.faces || [])
    .map(f => {
      const ranges = mergeRanges([
        ...instRanges(f.instances),
        ...(f.thumbnails || []).flatMap(t => instRanges(t.instances))
      ]);
      if (!ranges.length || !f.thumbnailId) return null;
      const generic = !f.name || /^Unknown/i.test(f.name);
      return {
        id: f.id,
        name: generic ? `Person ${++unnamed}` : f.name,
        thumbId: f.thumbnailId,
        ranges: ranges.map(r => r.map(round)),
        shotIdx: linkShots(ranges, shots),
        seenDuration: round(totalDur(ranges))
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.seenDuration - a.seenDuration);

  // ---- transcript (with shot links for search snippets) ----
  const transcript = (ins.transcript || [])
    .map(t => {
      const inst = instRanges(t.instances);
      if (!inst.length || !t.text) return null;
      return {
        s: round(inst[0][0]), e: round(inst[0][1]),
        text: t.text, speaker: t.speakerId,
        shotIdx: linkShots(inst, shots)
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.s - b.s);

  // ---- tags: labels + keywords + ocr + named entities ----
  const tags = [];
  const addTag = (kind, text, ranges, sub) => {
    if (!text) return;
    ranges = mergeRanges(ranges);
    if (!ranges.length || totalDur(ranges) < 2) return;
    tags.push({
      kind, text, ...(sub ? { sub } : {}),
      ranges: ranges.map(r => r.map(round)),
      shotIdx: linkShots(ranges, shots)
    });
  };
  for (const l of ins.labels || []) addTag('label', l.name, instRanges(l.instances));
  for (const k of ins.keywords || []) addTag('keyword', k.text, instRanges(k.instances));
  // dedupe identical OCR strings by merging their ranges
  const ocrByText = new Map();
  for (const o of ins.ocr || []) {
    if (!o.text) continue;
    const key = o.text.trim().toLowerCase();
    ocrByText.set(key, [...(ocrByText.get(key) || []), ...instRanges(o.instances)]);
  }
  for (const [text, ranges] of ocrByText) addTag('ocr', text, ranges);
  // named entities carry numeric seconds already
  const entity = (arr, sub) => {
    for (const e of arr || []) {
      addTag('entity', e.name,
        (e.appearances || [])
          .map(a => [a.startSeconds ?? parseTs(a.startTime), a.endSeconds ?? parseTs(a.endTime)])
          .filter(([a, b]) => !isNaN(a) && !isNaN(b) && b > a),
        sub);
    }
  };
  entity(ins.namedPeople, 'person');
  entity(ins.namedLocations, 'location');
  entity(ins.brands, 'brand');

  // keep the payload lean: heaviest 2000 tags by screen time
  tags.sort((a, b) => totalDur(b.ranges) - totalDur(a.ranges));
  tags.length = Math.min(tags.length, 2000);

  return {
    v: 1,
    videoId: video.id || raw.id || null,
    duration: round(duration),
    shots: shots.map(sh => ({
      start: round(sh.start), end: round(sh.end),
      kf: sh.kf.map(round), type: sh.type
    })),
    scenes,
    people,
    transcript,
    tags
  };
}

module.exports = { normalize, parseTs };
