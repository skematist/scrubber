// Azure AI Video Indexer plumbing: config, tokens, proxy encode, upload, poll,
// face thumbnails, and the per-movie indexing job state machine.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const APP_DIR = path.join(os.homedir(), 'AppData', 'Local', 'FrameScrubber');
const CONFIG_PATH = path.join(APP_DIR, 'vi-config.json');
const ARM_API_VERSION = '2025-04-01';

// ---------------- config ----------------

const DEFAULT_CONFIG = {
  subscriptionId: '', resourceGroup: '', accountName: '',
  accountId: '', location: '',
  pastedAccessToken: '',
  proxyUpload: true
};

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(cfg) {
  fs.mkdirSync(APP_DIR, { recursive: true });
  const merged = { ...DEFAULT_CONFIG, ...cfg };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2));
  cachedViToken = null; // config change invalidates any cached token
  return merged;
}

function configured(cfg) {
  return !!(cfg.accountId && cfg.location &&
    (cfg.pastedAccessToken || (cfg.subscriptionId && cfg.resourceGroup && cfg.accountName)));
}

// ---------------- auth ----------------

let credential = null;

async function getArmToken() {
  if (!credential) {
    const { DefaultAzureCredential } = require('@azure/identity');
    credential = new DefaultAzureCredential();
  }
  const t = await credential.getToken('https://management.azure.com/.default');
  return t.token;
}

let cachedViToken = null; // { token, expires }
let tokenPromise = null;  // single-flight

async function getViToken(force) {
  const cfg = loadConfig();
  if (cfg.pastedAccessToken) return cfg.pastedAccessToken;
  if (!force && cachedViToken && Date.now() < cachedViToken.expires) return cachedViToken.token;
  if (!tokenPromise) {
    tokenPromise = (async () => {
      const armToken = await getArmToken();
      const url = `https://management.azure.com/subscriptions/${cfg.subscriptionId}` +
        `/resourceGroups/${cfg.resourceGroup}/providers/Microsoft.VideoIndexer/accounts/${cfg.accountName}` +
        `/generateAccessToken?api-version=${ARM_API_VERSION}`;
      const r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${armToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ permissionType: 'Contributor', scope: 'Account' })
      });
      if (!r.ok) {
        const body = await r.text();
        const err = new Error(`generateAccessToken ${r.status}: ${body.slice(0, 500)}`);
        err.status = r.status;
        throw err;
      }
      const j = await r.json();
      cachedViToken = { token: j.accessToken, expires: Date.now() + 50 * 60 * 1000 };
      return j.accessToken;
    })().finally(() => { tokenPromise = null; });
  }
  return tokenPromise;
}

async function viFetch(pathname, opts = {}) {
  const cfg = loadConfig();
  const base = `https://api.videoindexer.ai/${cfg.location}/Accounts/${cfg.accountId}`;
  let token = await getViToken();
  let r = await fetch(base + pathname, {
    ...opts,
    headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` }
  });
  if (r.status === 401 && !cfg.pastedAccessToken) {
    token = await getViToken(true);
    r = await fetch(base + pathname, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` }
    });
  }
  return r;
}

// Validates the whole chain and classifies the failure for the settings panel.
async function validateConfig() {
  const cfg = loadConfig();
  if (!configured(cfg)) return { ok: false, stage: 'config', error: 'Fill in account ID + location, plus either the ARM identifiers (subscription/resource group/account name) or a pasted access token.' };
  if (!cfg.pastedAccessToken) {
    try {
      await getArmToken();
    } catch (e) {
      return { ok: false, stage: 'azure-login', error: 'Azure sign-in failed. Run "az login" in a terminal on this machine (or set AZURE_* env vars). Details: ' + e.message.slice(0, 300) };
    }
    try {
      await getViToken(true);
    } catch (e) {
      const hint = e.status === 403 ? 'Your Azure identity lacks Contributor role on the Video Indexer resource (RBAC).'
        : e.status === 404 ? 'Subscription / resource group / account name did not resolve to a Video Indexer resource.'
          : 'Token generation failed.';
      return { ok: false, stage: 'vi-token', error: `${hint} Details: ${e.message.slice(0, 300)}` };
    }
  }
  try {
    const r = await viFetch('/Videos?pageSize=1');
    if (!r.ok) return { ok: false, stage: 'vi-api', error: `Video Indexer API rejected the call (${r.status}). Check account ID and location. ${(await r.text()).slice(0, 300)}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, stage: 'vi-api', error: 'Could not reach api.videoindexer.ai: ' + e.message.slice(0, 300) };
  }
}

// ---------------- proxy encode ----------------

function makeProxy(file, outPath, durationSec, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-i', file,
      '-vf', 'scale=-2:720',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '96k',
      '-movflags', '+faststart',
      '-f', 'mp4',
      '-progress', 'pipe:1',
      '-y', outPath
    ]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d; });
    let buf = '';
    proc.stdout.on('data', d => {
      buf += d.toString();
      const matches = buf.match(/out_time_ms=(\d+)/g);
      if (matches && durationSec > 0) {
        const ms = parseInt(matches[matches.length - 1].slice(12), 10);
        onProgress && onProgress(Math.min(99, Math.round(ms / 10000 / durationSec)));
        buf = buf.slice(-200);
      }
    });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('proxy encode failed: ' + stderr.slice(-500)));
    });
    proc.on('error', reject);
  });
}

// ---------------- VI operations ----------------

async function uploadVideo(filePath, name) {
  const qs = new URLSearchParams({
    name: name.slice(0, 80),
    privacy: 'Private',
    indexingPreset: 'Default',
    streamingPreset: 'NoStreaming',
    language: 'auto'
  });
  const blob = await fs.openAsBlob(filePath);
  const fd = new FormData();
  fd.append('file', blob, name.slice(0, 60).replace(/[^\w.\- ]+/g, '_') + '.mp4');
  const r = await viFetch(`/Videos?${qs}`, { method: 'POST', body: fd });
  if (!r.ok) throw new Error(`Upload-Video ${r.status}: ${(await r.text()).slice(0, 500)}`);
  return r.json(); // { id, state, ... }
}

async function getVideoIndex(videoId) {
  const r = await viFetch(`/Videos/${videoId}/Index?includeSummarizedInsights=false`);
  if (!r.ok) throw new Error(`Get-Video-Index ${r.status}: ${(await r.text()).slice(0, 500)}`);
  return r.json();
}

async function pollIndex(videoId, onProgress, isCancelled) {
  for (; ;) {
    const idx = await getVideoIndex(videoId);
    const v = idx.videos && idx.videos[0];
    const state = (v && v.state) || idx.state;
    if (state === 'Processed') return idx;
    if (state === 'Failed') {
      throw new Error('Indexing failed: ' + ((v && v.failureMessage) || 'unknown reason'));
    }
    onProgress && onProgress((v && v.processingProgress) || '0%');
    for (let i = 0; i < 20; i++) { // 20s, checking cancellation each second
      if (isCancelled && isCancelled()) throw new Error('cancelled');
      await new Promise(res => setTimeout(res, 1000));
    }
  }
}

async function downloadFaceThumbs(videoId, faces, dir) {
  fs.mkdirSync(dir, { recursive: true });
  for (const f of faces) {
    if (!f.thumbnailId) continue;
    const out = path.join(dir, f.thumbnailId + '.jpg');
    if (fs.existsSync(out)) continue;
    try {
      const r = await viFetch(`/Videos/${videoId}/Thumbnails/${f.thumbnailId}?format=Jpeg`);
      if (r.ok) fs.writeFileSync(out, Buffer.from(await r.arrayBuffer()));
    } catch { /* a missing face crop is not fatal */ }
  }
}

async function deleteCloudVideo(videoId) {
  const r = await viFetch(`/Videos/${videoId}`, { method: 'DELETE' });
  return r.ok || r.status === 404;
}

// ---------------- indexing job state machine ----------------

const { normalize } = require('./vi-normalize');

const jobs = new Map(); // cacheKey -> { stage, progress, viProgress, videoId, error, cancelled }

function viDir(cacheRoot, key) { return path.join(cacheRoot, key, 'vi'); }

function readMeta(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { return null; }
}

function writeMeta(dir, meta) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
}

function getStatus(cacheRoot, key) {
  const live = jobs.get(key);
  if (live) return live;
  const dir = viDir(cacheRoot, key);
  if (fs.existsSync(path.join(dir, 'insights.json'))) return { stage: 'ready', progress: 100 };
  const meta = readMeta(dir);
  if (meta && meta.error) return { stage: 'failed', error: meta.error, videoId: meta.videoId };
  if (meta && meta.videoId) return { stage: 'interrupted', videoId: meta.videoId };
  return { stage: 'idle' };
}

function startIndexJob({ file, cacheRoot, key, probe, force }) {
  const dir = viDir(cacheRoot, key);
  if (force) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { } }
  if (fs.existsSync(path.join(dir, 'insights.json'))) return { stage: 'ready' };
  if (jobs.has(key)) return jobs.get(key);

  const job = { stage: 'starting', progress: 0, viProgress: null, videoId: null, error: null, cancelled: false };
  jobs.set(key, job);

  (async () => {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const prior = readMeta(dir);

      if (prior && prior.videoId && !prior.error) {
        // resume: skip proxy+upload, go straight to polling — never re-bill
        job.videoId = prior.videoId;
      } else {
        // decide upload source
        const st = fs.statSync(file);
        const cfg = loadConfig();
        let uploadPath = file;
        const needsProxy = st.size > 1.9 * 1024 * 1024 * 1024 || cfg.proxyUpload;
        if (needsProxy) {
          job.stage = 'proxy';
          uploadPath = path.join(dir, 'proxy.mp4');
          if (!fs.existsSync(uploadPath)) {
            await makeProxy(file, uploadPath + '.part', probe.duration, p => { job.progress = p; });
            fs.renameSync(uploadPath + '.part', uploadPath);
          }
          // guard the indexing spend: proxy must match the original timeline
          const proxyDur = await probeDuration(uploadPath);
          if (Math.abs(proxyDur - probe.duration) > 0.5) {
            throw new Error(`proxy duration ${proxyDur}s deviates from original ${probe.duration}s`);
          }
          if (fs.statSync(uploadPath).size > 1.9 * 1024 * 1024 * 1024) {
            throw new Error('720p proxy still exceeds the 2 GB direct-upload limit; stage the file in Azure Blob Storage and index via SAS URL instead.');
          }
        } else if (st.size > 1.9 * 1024 * 1024 * 1024) {
          throw new Error('File exceeds the 2 GB direct-upload limit; enable proxy upload or stage in Blob Storage.');
        }

        job.stage = 'uploading';
        job.progress = 0;
        const up = await uploadVideo(uploadPath, probe.name || path.basename(file));
        job.videoId = up.id;
        writeMeta(dir, { videoId: up.id, uploadedAt: new Date().toISOString(), preset: 'Default', proxyUsed: needsProxy, sourceFile: file });
      }

      job.stage = 'indexing';
      const raw = await pollIndex(job.videoId, p => { job.viProgress = p; job.progress = parseInt(p, 10) || 0; }, () => job.cancelled);
      fs.writeFileSync(path.join(dir, 'raw-index.json'), JSON.stringify(raw));

      job.stage = 'faces';
      const insightsRaw = (raw.videos && raw.videos[0] && raw.videos[0].insights) || {};
      await downloadFaceThumbs(job.videoId, insightsRaw.faces || [], path.join(dir, 'faces'));

      job.stage = 'normalizing';
      const model = normalize(raw, { duration: probe.duration });
      fs.writeFileSync(path.join(dir, 'insights.json'), JSON.stringify(model));

      const meta = readMeta(dir) || { videoId: job.videoId };
      writeMeta(dir, { ...meta, state: 'ready', finishedAt: new Date().toISOString() });
      try { fs.rmSync(path.join(dir, 'proxy.mp4'), { force: true }); } catch { }

      job.stage = 'ready';
      job.progress = 100;
    } catch (e) {
      job.stage = 'failed';
      job.error = e.message;
      const meta = readMeta(dir) || {};
      // keep videoId in meta so resume is possible; record the error
      writeMeta(dir, { ...meta, videoId: meta.videoId || job.videoId, error: e.message });
    } finally {
      setTimeout(() => { if (jobs.get(key) && jobs.get(key).stage !== 'indexing') jobs.delete(key); }, 60 * 1000);
    }
  })();

  return job;
}

function probeDuration(file) {
  const { execFile } = require('child_process');
  const ffprobePath = require('ffprobe-static').path;
  return new Promise((resolve, reject) => {
    execFile(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file], (err, stdout) => {
      if (err) return reject(err);
      resolve(parseFloat(JSON.parse(stdout).format.duration));
    });
  });
}

module.exports = {
  loadConfig, saveConfig, configured, validateConfig,
  startIndexJob, getStatus, viDir, readMeta, writeMeta,
  viFetch, deleteCloudVideo
};
