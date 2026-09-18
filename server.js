const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

const PORT = process.env.PORT || 3020;
const CACHE_ROOT = path.join(os.homedir(), 'AppData', 'Local', 'FrameScrubber', 'cache');
fs.mkdirSync(CACHE_ROOT, { recursive: true });

const VIDEO_EXTS = new Set(['.mp4', '.mkv', '.mov', '.avi', '.flv', '.m4v', '.mpg', '.mpeg', '.wmv', '.webm', '.ts', '.mts', '.m2ts', '.mxf']);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/cache', express.static(CACHE_ROOT, { maxAge: '30d', immutable: true }));

// ---------- helpers ----------

function cacheKey(filePath) {
  const st = fs.statSync(filePath);
  return crypto.createHash('sha1')
    .update(filePath.toLowerCase() + '|' + st.size + '|' + st.mtimeMs)
    .digest('hex').slice(0, 16);
}

function parseFps(rFrameRate) {
  const [num, den] = String(rFrameRate).split('/').map(Number);
  if (!num || !den) return 24;
  return num / den;
}

function timecode(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds - Math.floor(seconds)) * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}-${pad(m)}-${pad(s)}.${pad(ms, 3)}`;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr ? String(stderr).slice(-2000) : err.message));
      else resolve({ stdout, stderr });
    });
  });
}

// ---------- probe ----------

app.get('/api/probe', (req, res) => {
  const file = req.query.file;
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'File not found: ' + file });
  execFile(ffprobePath, [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,r_frame_rate,codec_name',
    '-show_entries', 'format=duration',
    '-of', 'json', file
  ], (err, stdout) => {
    if (err) return res.status(500).json({ error: 'ffprobe failed: ' + err.message });
    try {
      const info = JSON.parse(stdout);
      const stream = info.streams && info.streams[0];
      if (!stream) return res.status(400).json({ error: 'No video stream found' });
      res.json({
        key: cacheKey(file),
        duration: parseFloat(info.format.duration),
        width: stream.width,
        height: stream.height,
        fps: parseFps(stream.r_frame_rate),
        codec: stream.codec_name,
        name: path.basename(file)
      });
    } catch (e) {
      res.status(500).json({ error: 'probe parse failed: ' + e.message });
    }
  });
});

// ---------- single thumbnail / preview (on-demand, cached, deduped) ----------

const inFlight = new Map();

app.get('/api/thumb', async (req, res) => {
  const file = req.query.file;
  const t = parseFloat(req.query.t);
  const w = Math.min(parseInt(req.query.w || '240', 10), 1920);
  if (!file || !fs.existsSync(file) || isNaN(t)) return res.status(400).end();

  const key = cacheKey(file);
  const dir = path.join(CACHE_ROOT, key);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `t_${t.toFixed(3)}_w${w}.jpg`);

  if (!fs.existsSync(out)) {
    const dedupeKey = out;
    if (!inFlight.has(dedupeKey)) {
      // -ss before -i: fast keyframe seek then accurate decode to target frame
      const seekT = Math.max(0, t - 0.001);
      const p = runFfmpeg([
        '-hide_banner', '-loglevel', 'error',
        '-ss', seekT.toFixed(3), '-i', file,
        '-frames:v', '1',
        '-vf', `scale=${w}:-2`,
        '-q:v', '4', '-y', out
      ]).finally(() => inFlight.delete(dedupeKey));
      inFlight.set(dedupeKey, p);
    }
    try {
      await inFlight.get(dedupeKey);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }
  if (!fs.existsSync(out)) return res.status(500).end();
  res.sendFile(out);
});

// ---------- range extraction: every frame in a window ----------

// Only one active range job at a time; a new request kills the previous one.
const rangeJobs = new Map(); // jobId -> { times, done, error, dir, proc }
let activeJob = null;

app.post('/api/range', (req, res) => {
  const { file, start, dur } = req.body;
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'File not found' });
  const startN = Math.max(0, parseFloat(start));
  const durN = Math.min(parseFloat(dur) || 30, 120);

  const key = cacheKey(file);
  const jobId = `${key}_${startN.toFixed(3)}_${durN.toFixed(3)}`;
  const dir = path.join(CACHE_ROOT, key, `range_${startN.toFixed(3)}_${durN.toFixed(3)}`);
  const doneFile = path.join(dir, 'done.json');

  // Already fully extracted earlier
  if (fs.existsSync(doneFile)) {
    try {
      const meta = JSON.parse(fs.readFileSync(doneFile, 'utf8'));
      rangeJobs.set(jobId, { times: meta.times, done: true, error: null, dir, proc: null });
      return res.json({ jobId, cached: true });
    } catch { /* re-extract below */ }
  }

  // Already running
  const existing = rangeJobs.get(jobId);
  if (existing && !existing.error) return res.json({ jobId });

  // Kill any other active extraction
  if (activeJob && activeJob !== jobId) {
    const prev = rangeJobs.get(activeJob);
    if (prev && prev.proc) { try { prev.proc.kill(); } catch { } }
  }

  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const job = { times: [], done: false, error: null, dir, proc: null };
  rangeJobs.set(jobId, job);
  activeJob = jobId;

  // One decode pass over the window; showinfo gives us each frame's exact
  // timestamp relative to the seek point.
  const proc = spawn(ffmpegPath, [
    '-hide_banner', '-loglevel', 'info',
    '-ss', startN.toFixed(3), '-t', durN.toFixed(3), '-i', file,
    '-vf', 'showinfo,scale=200:-2',
    '-q:v', '5', '-y',
    path.join(dir, 'f_%05d.jpg')
  ]);
  job.proc = proc;

  let buf = '';
  proc.stderr.on('data', chunk => {
    buf += chunk.toString();
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const m = line.match(/n:\s*(\d+).*?pts_time:\s*([\d.]+)/);
      if (m) job.times[parseInt(m[1], 10)] = startN + parseFloat(m[2]);
    }
  });

  proc.on('close', code => {
    job.done = true;
    job.proc = null;
    if (activeJob === jobId) activeJob = null;
    if (code === 0 || job.times.length > 0) {
      // showinfo can log a few frames the muxer never writes; trust the files
      const written = fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).length;
      job.times = job.times.slice(0, written);
      fs.writeFileSync(doneFile, JSON.stringify({ times: job.times }));
    } else {
      job.error = 'ffmpeg exited with code ' + code;
    }
  });
  proc.on('error', err => { job.error = err.message; job.done = true; });

  res.json({ jobId });
});

app.get('/api/range/status', (req, res) => {
  const job = rangeJobs.get(req.query.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown job' });
  // Only report frames whose jpg is actually written. Frame N's file exists
  // once frame N+1 has been logged (or the job finished).
  const safeCount = job.done ? job.times.length : Math.max(0, job.times.length - 2);
  res.json({
    done: job.done,
    error: job.error,
    count: safeCount,
    times: job.times.slice(0, safeCount),
    base: '/cache/' + path.relative(CACHE_ROOT, job.dir).split(path.sep).join('/')
  });
});

// ---------- full-resolution export ----------

app.post('/api/export', async (req, res) => {
  const { file, time, outDir, format } = req.body;
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'File not found' });
  const t = parseFloat(time);
  const fmt = format === 'jpg' ? 'jpg' : 'png';
  const dir = outDir && outDir.trim() ? outDir.trim() : path.join(os.homedir(), 'Pictures', 'frame-exports');
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return res.status(400).json({ error: 'Cannot create output folder: ' + e.message });
  }

  const base = path.basename(file, path.extname(file)).replace(/[^\w\- ]+/g, '_');
  let out = path.join(dir, `${base}_${timecode(t)}.${fmt}`);
  let n = 1;
  while (fs.existsSync(out)) out = path.join(dir, `${base}_${timecode(t)}_${n++}.${fmt}`);

  const qualityArgs = fmt === 'jpg' ? ['-q:v', '1'] : [];
  try {
    // Seek a hair before the exact pts so float rounding can't skip to the next frame
    await runFfmpeg([
      '-hide_banner', '-loglevel', 'error',
      '-ss', Math.max(0, t - 0.001).toFixed(4), '-i', file,
      '-frames:v', '1', ...qualityArgs, '-y', out
    ]);
    res.json({ saved: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Azure Video Indexer ----------

const vi = require('./vi');

function viProbe(file) {
  return new Promise((resolve, reject) => {
    execFile(ffprobePath, [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file
    ], (err, stdout) => {
      if (err) return reject(err);
      resolve({ duration: parseFloat(JSON.parse(stdout).format.duration), name: path.basename(file) });
    });
  });
}

app.get('/api/vi/config', (req, res) => {
  const cfg = vi.loadConfig();
  res.json({ ...cfg, pastedAccessToken: cfg.pastedAccessToken ? '(set)' : '', configured: vi.configured(cfg) });
});

app.post('/api/vi/config', async (req, res) => {
  const prev = vi.loadConfig();
  const body = { ...req.body };
  if (body.pastedAccessToken === '(set)') body.pastedAccessToken = prev.pastedAccessToken;
  vi.saveConfig({ ...prev, ...body });
  res.json(await vi.validateConfig());
});

app.post('/api/vi/index', async (req, res) => {
  const { file, force } = req.body;
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'File not found' });
  if (!vi.configured(vi.loadConfig())) return res.status(400).json({ error: 'Video Indexer is not configured yet — open Settings.' });
  try {
    const probe = await viProbe(file);
    const job = vi.startIndexJob({ file, cacheRoot: CACHE_ROOT, key: cacheKey(file), probe, force: !!force });
    res.json({ stage: job.stage });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/vi/status', (req, res) => {
  const file = req.query.file;
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'File not found' });
  const s = vi.getStatus(CACHE_ROOT, cacheKey(file));
  res.json({ stage: s.stage, progress: s.progress || 0, viProgress: s.viProgress || null, videoId: s.videoId || null, error: s.error || null });
});

app.get('/api/vi/insights', (req, res) => {
  const file = req.query.file;
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'File not found' });
  const p = path.join(vi.viDir(CACHE_ROOT, cacheKey(file)), 'insights.json');
  if (!fs.existsSync(p)) return res.status(404).json({ state: vi.getStatus(CACHE_ROOT, cacheKey(file)).stage });
  res.sendFile(p);
});

app.get('/api/vi/face-thumb', async (req, res) => {
  const { file, id } = req.query;
  if (!file || !fs.existsSync(file) || !/^[\w-]+$/.test(id || '')) return res.status(400).end();
  const dir = vi.viDir(CACHE_ROOT, cacheKey(file));
  const p = path.join(dir, 'faces', id + '.jpg');
  if (!fs.existsSync(p)) {
    // lazy re-fetch (e.g., cache partially cleared)
    const meta = vi.readMeta(dir);
    if (!meta || !meta.videoId) return res.status(404).end();
    try {
      const r = await vi.viFetch(`/Videos/${meta.videoId}/Thumbnails/${id}?format=Jpeg`);
      if (!r.ok) return res.status(404).end();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, Buffer.from(await r.arrayBuffer()));
    } catch {
      return res.status(502).end();
    }
  }
  res.sendFile(p);
});

// rename a person locally (insights.json is ours once downloaded)
app.post('/api/vi/person-name', (req, res) => {
  const { file, id, name } = req.body;
  if (!file || !fs.existsSync(file) || !name) return res.status(400).json({ error: 'file and name required' });
  const p = path.join(vi.viDir(CACHE_ROOT, cacheKey(file)), 'insights.json');
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'No insights yet' });
  const model = JSON.parse(fs.readFileSync(p, 'utf8'));
  const person = model.people.find(x => x.id === id);
  if (!person) return res.status(404).json({ error: 'Unknown person id' });
  person.name = String(name).slice(0, 60);
  fs.writeFileSync(p, JSON.stringify(model));
  res.json({ ok: true });
});

app.delete('/api/vi/index', async (req, res) => {
  const { file, cloud } = req.query;
  if (!file || !fs.existsSync(file)) return res.status(404).json({ error: 'File not found' });
  const dir = vi.viDir(CACHE_ROOT, cacheKey(file));
  const meta = vi.readMeta(dir);
  let cloudDeleted = false;
  if (cloud === '1' && meta && meta.videoId) {
    try { cloudDeleted = await vi.deleteCloudVideo(meta.videoId); } catch { }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  res.json({ ok: true, cloudDeleted });
});

// ---------- file browser ----------

app.get('/api/browse', (req, res) => {
  let dir = req.query.dir || '';
  if (!dir) {
    // list drive letters
    const drives = [];
    for (let c = 65; c <= 90; c++) {
      const d = String.fromCharCode(c) + ':\\';
      try { if (fs.existsSync(d)) drives.push(d); } catch { }
    }
    return res.json({ dir: '', parent: null, dirs: drives, files: [] });
  }
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const dirs = [], files = [];
    for (const e of entries) {
      if (e.name.startsWith('$') || e.name.startsWith('.')) continue;
      try {
        if (e.isDirectory()) dirs.push(e.name);
        else if (VIDEO_EXTS.has(path.extname(e.name).toLowerCase())) files.push(e.name);
      } catch { }
    }
    dirs.sort((a, b) => a.localeCompare(b));
    files.sort((a, b) => a.localeCompare(b));
    const parent = path.dirname(dir) === dir ? '' : path.dirname(dir);
    res.json({ dir, parent, dirs, files });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Frame Scrubber running at http://localhost:${PORT}`);
  console.log(`Cache: ${CACHE_ROOT}`);
});
