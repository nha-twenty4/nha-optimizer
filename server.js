const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ====== PLAN LIMITS & KEYS (KEY = Lifetime | KEY@15d = 15 days from first use | KEY@YYYY-MM-DD = Fixed date) ======
const PLANS = {
  free: { name: 'Free', maxMB: 250, dailyLimit: 5 },
  creator: { name: 'Creator', maxMB: 600, dailyLimit: 15 },
  vip: { name: 'VIP', maxMB: null, dailyLimit: null }
};

function parseRule(specStr) {
  const spec = (specStr || '').trim();
  if (!spec || spec.toLowerCase() === 'lifetime') return { type: 'lifetime' };
  if (/^\d+d$/i.test(spec)) {
    const days = Number(spec.slice(0, -1));
    return { type: 'duration', days, ms: days * 86400 * 1000 };
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(spec)) return { type: 'date', date: spec };
  return { type: 'lifetime' };
}

function buildKeyMap(rawStr) {
  const map = new Map();
  for (const item of rawStr.split(',')) {
    const clean = item.trim();
    if (!clean) continue;
    const [keyPart, specPart] = clean.split('@');
    const key = (keyPart || '').trim();
    if (key) map.set(key, parseRule(specPart));
  }
  return map;
}

const CREATOR_KEY_MAP = buildKeyMap(
  process.env.CREATOR_KEYS ||
    [
      // 15-day Creator Keys (starts counting 15 days when first activated)
      'NHA-CR-4K9M2P@15d', 'NHA-CR-7X3W8Q@15d', 'NHA-CR-2R6N5T@15d', 'NHA-CR-9H4V3Z@15d', 'NHA-CR-5D8J7B@15d',
      'NHA-CR-3F2Y6C@15d', 'NHA-CR-8P5G4W@15d', 'NHA-CR-6T9K3M@15d', 'NHA-CR-4N7R8H@15d', 'NHA-CR-2Q5X9D@15d',
      // Lifetime Creator Keys
      'NHA-CR-7W3B6F', 'NHA-CR-9M8C4P', 'NHA-CR-5K2Z7V', 'NHA-CR-3J6H9N', 'NHA-CR-8G4T2R',
      'NHA-CR-6V9D5X', 'NHA-CR-4B3Q8K', 'NHA-CR-7Y5P2W', 'NHA-CR-9C6M3J', 'NHA-CR-2Z8F4G'
    ].join(',')
);

const VIP_KEY_MAP = buildKeyMap(
  process.env.VIP_KEYS ||
    [
      // 30-day VIP Keys (starts counting 30 days when first activated)
      'NHA-VP-8K4M9R@30d', 'NHA-VP-3W7X2P@30d', 'NHA-VP-6N5Q8T@30d', 'NHA-VP-9Z2H4F@30d', 'NHA-VP-5C8B7D@30d',
      'NHA-VP-4R6J3M@30d', 'NHA-VP-7T9V5K@30d', 'NHA-VP-2P3G8W@30d', 'NHA-VP-8F5D6Y@30d', 'NHA-VP-6M2K9N@30d',
      // Lifetime VIP Keys
      'NHA-VP-3X7C4Q', 'NHA-VP-9B8R2H', 'NHA-VP-5W4P7Z', 'NHA-VP-4H9T6G', 'NHA-VP-7J3N8V',
      'NHA-VP-2D6F5B', 'NHA-VP-8Q5Y3K', 'NHA-VP-6K9W4M', 'NHA-VP-3G2Z7R', 'NHA-VP-9V8J5X'
    ].join(',')
);
// ===================================================================================================================

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
const ACTIVATIONS_FILE = path.join(__dirname, 'key-activations.json');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const readyFiles = new Map();
const jobs = new Map();
const dailyUsage = new Map();

// Load & save key activation timestamps
const activations = new Map();
try {
  if (fs.existsSync(ACTIVATIONS_FILE)) {
    const raw = JSON.parse(fs.readFileSync(ACTIVATIONS_FILE, 'utf8'));
    for (const [k, ts] of Object.entries(raw)) {
      if (typeof ts === 'number') activations.set(k, ts);
    }
  }
} catch {}

function saveActivations() {
  try {
    fs.writeFileSync(ACTIVATIONS_FILE, JSON.stringify(Object.fromEntries(activations), null, 2));
  } catch {}
}

function getCambodiaDateKey() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
  return req.ip || 'unknown';
}

function getUsage(ip) {
  const today = getCambodiaDateKey();
  const entry = dailyUsage.get(ip);
  if (!entry || entry.date !== today) {
    const fresh = { date: today, count: 0 };
    dailyUsage.set(ip, fresh);
    return fresh;
  }
  return entry;
}

function formatRemaining(expiresAtMs) {
  if (!expiresAtMs) return 'Lifetime';
  const diff = expiresAtMs - Date.now();
  if (diff <= 0) return 'Expired';
  const totalMins = Math.floor(diff / 60000);
  const days = Math.floor(totalMins / 1440);
  const hours = Math.floor((totalMins % 1440) / 60);
  const mins = totalMins % 60;
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${mins}m left`;
  return `${Math.max(1, mins)}m left`;
}

function checkKey(keyStr) {
  const key = (keyStr || '').toString().trim();
  let plan = null;
  let rule = null;

  if (VIP_KEY_MAP.has(key)) {
    plan = 'vip';
    rule = VIP_KEY_MAP.get(key);
  } else if (CREATOR_KEY_MAP.has(key)) {
    plan = 'creator';
    rule = CREATOR_KEY_MAP.get(key);
  }

  if (!plan) {
    return { plan: 'free', valid: false, expired: false, expiresAtMs: null, label: null };
  }

  if (rule.type === 'lifetime') {
    return { plan, valid: true, expired: false, expiresAtMs: null, label: 'Lifetime' };
  }

  if (rule.type === 'date') {
    const endMs = Date.parse(`${rule.date}T23:59:59+07:00`);
    if (Date.now() > endMs) {
      return { plan: 'free', valid: false, expired: true, expiresAtMs: endMs, label: 'Expired' };
    }
    return { plan, valid: true, expired: false, expiresAtMs: endMs, label: formatRemaining(endMs) };
  }

  // Duration key (starts counting when first entered/used)
  let activatedAt = activations.get(key);
  if (!activatedAt) {
    activatedAt = Date.now();
    activations.set(key, activatedAt);
    saveActivations();
  }
  const expiresAtMs = activatedAt + rule.ms;
  if (Date.now() > expiresAtMs) {
    return { plan: 'free', valid: false, expired: true, expiresAtMs, label: 'Expired' };
  }
  return { plan, valid: true, expired: false, expiresAtMs, label: formatRemaining(expiresAtMs) };
}

function getRequestKeyCheck(req) {
  return checkKey(req.headers['x-vip-key'] || req.query.vipKey || '');
}

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});

function videoFileFilter(_, file, cb) {
  const allowedExt = ['.mp4', '.mov', '.mkv', '.webm', '.m4v'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (file.mimetype.startsWith('video/') || allowedExt.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Please upload a valid video file (MP4, MOV, MKV, WEBM).'));
  }
}

const uploaders = {
  free: multer({ storage, limits: { fileSize: PLANS.free.maxMB * 1024 * 1024 }, fileFilter: videoFileFilter }),
  creator: multer({ storage, limits: { fileSize: PLANS.creator.maxMB * 1024 * 1024 }, fileFilter: videoFileFilter }),
  vip: multer({ storage, limits: { fileSize: 50 * 1024 * 1024 * 1024 }, fileFilter: videoFileFilter })
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (req, res) => {
  const ffmpegReady = Boolean(ffmpegPath && fs.existsSync(ffmpegPath));
  const keyStatus = getRequestKeyCheck(req);
  const rules = PLANS[keyStatus.plan];
  const usage = getUsage(getClientIp(req));

  res.json({
    ok: ffmpegReady,
    ffmpegReady,
    engine: 'Nha Engine 2.0',
    plan: keyStatus.plan,
    expiresAtMs: keyStatus.expiresAtMs,
    timeLabel: keyStatus.label,
    expired: keyStatus.expired,
    maxFileMB: rules.maxMB,
    dailyLimit: rules.dailyLimit,
    usedToday: usage.count,
    remainingToday: rules.dailyLimit === null ? null : Math.max(0, rules.dailyLimit - usage.count)
  });
});

app.post('/api/vip/verify', (req, res) => {
  const status = checkKey(req.body?.key);
  if (status.expired) {
    return res.status(401).json({
      valid: false,
      expired: true,
      error: 'Your Key has expired! Contact @ZenZyTwenty4 on Telegram to renew.'
    });
  }
  if (status.plan === 'vip') {
    return res.json({
      valid: true,
      plan: 'vip',
      expiresAtMs: status.expiresAtMs,
      timeLabel: status.label,
      message: `VIP Unlocked (${status.label})! Unlimited size & uploads active.`
    });
  }
  if (status.plan === 'creator') {
    return res.json({
      valid: true,
      plan: 'creator',
      expiresAtMs: status.expiresAtMs,
      timeLabel: status.label,
      message: `Creator Unlocked (${status.label})! Max ${PLANS.creator.maxMB} MB & ${PLANS.creator.dailyLimit}/day.`
    });
  }
  return res.status(401).json({ valid: false, error: 'Invalid Key. Contact @ZenZyTwenty4 on Telegram.' });
});

app.post('/api/quota/consume', (req, res) => {
  const status = getRequestKeyCheck(req);
  const rules = PLANS[status.plan];
  if (rules.dailyLimit === null) {
    return res.json({ allowed: true, plan: status.plan, remainingToday: null });
  }
  const usage = getUsage(getClientIp(req));
  if (usage.count >= rules.dailyLimit) {
    return res.status(429).json({
      allowed: false,
      error: `Daily ${rules.name} limit reached (${rules.dailyLimit}/${rules.dailyLimit} today). Get a VIP Key for Unlimited!`
    });
  }
  usage.count += 1;
  res.json({
    allowed: true,
    plan: status.plan,
    usedToday: usage.count,
    remainingToday: Math.max(0, rules.dailyLimit - usage.count)
  });
});

app.get('/api/progress/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  res.json(job || { pct: 0, msg: 'Waiting...' });
});

function runExec(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout, stderr });
    });
  });
}

function parseTimeToSec(str) {
  const m = /(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(str);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function runFfmpegWithProgress(args, totalDuration, jobId) {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
      return reject(new Error('FFmpeg binary missing! Run: node node_modules/ffmpeg-static/install.js'));
    }

    const proc = spawn(ffmpegPath, args);
    let stderrTail = '';

    proc.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      const timeMatches = text.match(/time=(\d+:\d+:\d+(?:\.\d+)?)/g);
      if (timeMatches && totalDuration > 0 && jobId) {
        const currentSec = parseTimeToSec(timeMatches[timeMatches.length - 1]);
        const pct = Math.min(99, Math.max(1, Math.round((currentSec / totalDuration) * 100)));
        const fpsMatch = text.match(/fps=\s*([\d.]+)/);
        const fpsInfo = fpsMatch ? ` (${fpsMatch[1]} fps)` : '';
        jobs.set(jobId, { pct, msg: `Encoding ${pct}%${fpsInfo}...` });
      }
    });

    proc.on('error', err => reject(err));
    proc.on('close', code => {
      if (code === 0) {
        if (jobId) jobs.set(jobId, { pct: 100, msg: 'Finalizing...' });
        resolve();
      } else {
        reject(new Error(stderrTail.trim() || `FFmpeg exited with code ${code}`));
      }
    });
  });
}

function parseFps(rateStr) {
  if (!rateStr || !rateStr.includes('/')) return 0;
  const [num, den] = rateStr.split('/').map(Number);
  if (!den) return 0;
  return Number((num / den).toFixed(2));
}

async function probeVideo(filePath) {
  const { stdout } = await runExec(ffprobePath, [
    '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath
  ]);
  const info = JSON.parse(stdout);
  const videoStream = (info.streams || []).find(s => s.codec_type === 'video');
  const audioStream = (info.streams || []).find(s => s.codec_type === 'audio');

  const sizeBytes = Number(info.format?.size || fs.statSync(filePath).size || 0);
  const duration = Number(info.format?.duration || 0);
  const bitrateMbps = info.format?.bit_rate ? Number((Number(info.format.bit_rate) / 1_000_000).toFixed(2)) : 0;

  return {
    width: videoStream?.width || 0,
    height: videoStream?.height || 0,
    fps: parseFps(videoStream?.avg_frame_rate) || parseFps(videoStream?.r_frame_rate),
    videoCodec: videoStream?.codec_name || 'unknown',
    audioCodec: audioStream?.codec_name || null,
    duration: Number(duration.toFixed(2)),
    bitrateMbps,
    sizeMB: Number((sizeBytes / (1024 * 1024)).toFixed(2))
  };
}

function safeUnlink(filePath) {
  if (filePath && fs.existsSync(filePath)) fs.unlink(filePath, () => {});
}

app.post('/api/optimize', (req, res) => {
  const ip = getClientIp(req);
  const keyStatus = getRequestKeyCheck(req);
  const rules = PLANS[keyStatus.plan];
  const usage = getUsage(ip);

  if (rules.dailyLimit !== null && usage.count >= rules.dailyLimit) {
    return res.status(429).json({
      error: `Daily ${rules.name} limit reached (${rules.dailyLimit}/${rules.dailyLimit} today). Enter a VIP Key for Unlimited uploads!`
    });
  }

  uploaders[keyStatus.plan].single('video')(req, res, async err => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: `File exceeds the ${rules.name} ${rules.maxMB} MB limit. Get a Creator (600 MB) or VIP (Unlimited) Key!`
        });
      }
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) return res.status(400).json({ error: 'No video file uploaded.' });

    const inputPath = req.file.path;
    const mode = req.body.mode || 'tiktok60';
    const jobId = req.query.jobId || crypto.randomUUID();
    const fileId = crypto.randomUUID();
    const baseName = path.basename(req.file.originalname, path.extname(req.file.originalname))
      .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60) || 'video';
    const downloadName = `NHA_${mode}_${baseName}.mp4`;
    const outputPath = path.join(OUTPUT_DIR, `${fileId}.mp4`);

    jobs.set(jobId, { pct: 1, msg: 'Inspecting video...' });

    try {
      const inputMeta = await probeVideo(inputPath);
      if (!inputMeta.width || !inputMeta.height) {
        throw new Error('Could not detect a valid video stream in this file.');
      }

      const mp4CompatAudio = new Set(['aac', 'mp3', 'ac3', 'eac3', 'alac', 'flac', 'opus']);
      const copyAudioArgs = !inputMeta.audioCodec
        ? ['-an']
        : mp4CompatAudio.has(inputMeta.audioCodec.toLowerCase()) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '192k'];

      const encodeAudioArgs = inputMeta.audioCodec ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000'] : ['-an'];

      const isLandscape = inputMeta.width >= inputMeta.height;
      const targetW = isLandscape ? 1920 : 1080;
      const targetH = isLandscape ? 1080 : 1920;
      const vf = `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

      let ffmpegArgs;
      if (mode === 'tiktok60') {
        ffmpegArgs = [
          '-y', '-i', inputPath, '-vf', vf, '-r', '60',
          '-c:v', 'libx264', '-profile:v', 'high', '-level:v', '4.2', '-preset', 'veryfast',
          '-crf', '18', '-maxrate', '16M', '-bufsize', '32M', '-pix_fmt', 'yuv420p',
          ...encodeAudioArgs, '-movflags', '+faststart', outputPath
        ];
      } else if (mode === 'fhd120') {
        ffmpegArgs = [
          '-y', '-i', inputPath, '-vf', vf, '-r', '120',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p',
          ...encodeAudioArgs, '-movflags', '+faststart', outputPath
        ];
      } else if (mode === 'patch60') {
        ffmpegArgs = ['-y', '-itsscale', '2', '-i', inputPath, '-c:v', 'copy', ...copyAudioArgs, '-movflags', '+faststart', outputPath];
      } else {
        ffmpegArgs = ['-y', '-i', inputPath, '-c:v', 'copy', ...copyAudioArgs, '-movflags', '+faststart', outputPath];
      }

      await runFfmpegWithProgress(ffmpegArgs, inputMeta.duration, jobId);
      const outputMeta = await probeVideo(outputPath);

      safeUnlink(inputPath);
      setTimeout(() => jobs.delete(jobId), 60_000);

      if (rules.dailyLimit !== null) usage.count += 1;

      readyFiles.set(fileId, { filePath: outputPath, downloadName, createdAt: Date.now() });

      res.json({
        success: true,
        fileId,
        downloadName,
        downloadUrl: `/api/download/${fileId}`,
        inputMeta,
        outputMeta,
        plan: keyStatus.plan,
        remainingToday: rules.dailyLimit === null ? null : Math.max(0, rules.dailyLimit - usage.count)
      });
    } catch (procErr) {
      safeUnlink(inputPath);
      safeUnlink(outputPath);
      jobs.delete(jobId);
      res.status(500).json({ error: procErr.message || 'FFmpeg processing failed.' });
    }
  });
});

app.get('/api/download/:id', (req, res) => {
  const entry = readyFiles.get(req.params.id);
  if (!entry || !fs.existsSync(entry.filePath)) {
    return res.status(404).send('File expired or not found. Please optimize again.');
  }
  res.download(entry.filePath, entry.downloadName);
});

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of readyFiles.entries()) {
    if (now - entry.createdAt > 30 * 60 * 1000) {
      safeUnlink(entry.filePath);
      readyFiles.delete(id);
    }
  }
}, 2 * 60 * 1000);

const server = app.listen(PORT, () => {
  const ok = ffmpegPath && fs.existsSync(ffmpegPath);
  console.log(`Nha Engine 2.0 running at http://localhost:${PORT}`);
  console.log(ok ? 'FFmpeg binary: READY' : 'FFmpeg binary MISSING! Run: node node_modules/ffmpeg-static/install.js');
});
server.timeout = 0;
server.requestTimeout = 0;