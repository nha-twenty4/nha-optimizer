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

// ====== PLAN LIMITS & KEYS ======
const PLANS = {
  free: { name: 'Free', maxMB: 250, dailyLimit: 5 },
  creator: { name: 'Creator', maxMB: 600, dailyLimit: 15 },
  vip: { name: 'VIP', maxMB: null, dailyLimit: null }
};

const CREATOR_KEYS = new Set(
  (process.env.CREATOR_KEYS ||
    'NHA-CR-4K9M2P,NHA-CR-7X3W8Q,NHA-CR-2R6N5T,NHA-CR-9H4V3Z,NHA-CR-5D8J7B,NHA-CR-3F2Y6C,NHA-CR-8P5G4W,NHA-CR-6T9K3M,NHA-CR-4N7R8H,NHA-CR-2Q5X9D,NHA-CR-7W3B6F,NHA-CR-9M8C4P,NHA-CR-5K2Z7V,NHA-CR-3J6H9N,NHA-CR-8G4T2R,NHA-CR-6V9D5X,NHA-CR-4B3Q8K,NHA-CR-7Y5P2W,NHA-CR-9C6M3J,NHA-CR-2Z8F4G')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean)
);

const VIP_KEYS = new Set(
  (process.env.VIP_KEYS ||
    'NHA-VP-8K4M9R,NHA-VP-3W7X2P,NHA-VP-6N5Q8T,NHA-VP-9Z2H4F,NHA-VP-5C8B7D,NHA-VP-4R6J3M,NHA-VP-7T9V5K,NHA-VP-2P3G8W,NHA-VP-8F5D6Y,NHA-VP-6M2K9N,NHA-VP-3X7C4Q,NHA-VP-9B8R2H,NHA-VP-5W4P7Z,NHA-VP-4H9T6G,NHA-VP-7J3N8V,NHA-VP-2D6F5B,NHA-VP-8Q5Y3K,NHA-VP-6K9W4M,NHA-VP-3G2Z7R,NHA-VP-9V8J5X')
    .split(',')
    .map(k => k.trim())
    .filter(Boolean)
);
// =================================

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const readyFiles = new Map();
const jobs = new Map();
const dailyUsage = new Map();

function getCambodiaDateKey() {
  return new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0].trim();
  }
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

function getPlanFromKey(keyStr) {
  const key = (keyStr || '').toString().trim();
  if (VIP_KEYS.has(key)) return 'vip';
  if (CREATOR_KEYS.has(key)) return 'creator';
  return 'free';
}

function getRequestPlan(req) {
  const key = req.headers['x-vip-key'] || req.query.vipKey || '';
  return getPlanFromKey(key);
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
  const plan = getRequestPlan(req);
  const rules = PLANS[plan];
  const usage = getUsage(getClientIp(req));

  res.json({
    ok: ffmpegReady,
    ffmpegReady,
    engine: 'Nha Engine 2.0',
    plan,
    maxFileMB: rules.maxMB,
    dailyLimit: rules.dailyLimit,
    usedToday: usage.count,
    remainingToday: rules.dailyLimit === null ? null : Math.max(0, rules.dailyLimit - usage.count)
  });
});

app.post('/api/vip/verify', (req, res) => {
  const plan = getPlanFromKey(req.body?.key);
  if (plan === 'vip') {
    return res.json({
      valid: true,
      plan: 'vip',
      maxFileMB: null,
      dailyLimit: null,
      message: 'VIP Unlocked! Unlimited file size & uploads active.'
    });
  }
  if (plan === 'creator') {
    return res.json({
      valid: true,
      plan: 'creator',
      maxFileMB: PLANS.creator.maxMB,
      dailyLimit: PLANS.creator.dailyLimit,
      message: `Creator Unlocked! Max ${PLANS.creator.maxMB} MB & ${PLANS.creator.dailyLimit} uploads/day.`
    });
  }
  return res.status(401).json({ valid: false, error: 'Invalid Key. Contact @ZenZyTwenty4 on Telegram.' });
});

app.post('/api/quota/consume', (req, res) => {
  const plan = getRequestPlan(req);
  const rules = PLANS[plan];
  if (rules.dailyLimit === null) {
    return res.json({ allowed: true, plan, remainingToday: null });
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
    plan,
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
    '-v', 'quiet',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    filePath
  ]);
  const info = JSON.parse(stdout);
  const videoStream = (info.streams || []).find(s => s.codec_type === 'video');
  const audioStream = (info.streams || []).find(s => s.codec_type === 'audio');

  const sizeBytes = Number(info.format?.size || fs.statSync(filePath).size || 0);
  const duration = Number(info.format?.duration || 0);
  const bitrateMbps = info.format?.bit_rate
    ? Number((Number(info.format.bit_rate) / 1_000_000).toFixed(2))
    : 0;

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
  if (filePath && fs.existsSync(filePath)) {
    fs.unlink(filePath, () => {});
  }
}

app.post('/api/optimize', (req, res) => {
  const ip = getClientIp(req);
  const plan = getRequestPlan(req);
  const rules = PLANS[plan];
  const usage = getUsage(ip);

  if (rules.dailyLimit !== null && usage.count >= rules.dailyLimit) {
    return res.status(429).json({
      error: `Daily ${rules.name} limit reached (${rules.dailyLimit}/${rules.dailyLimit} today). Enter a VIP Key for Unlimited uploads!`
    });
  }

  uploaders[plan].single('video')(req, res, async err => {
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
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 60) || 'video';
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
        : mp4CompatAudio.has(inputMeta.audioCodec.toLowerCase())
          ? ['-c:a', 'copy']
          : ['-c:a', 'aac', '-b:a', '192k'];

      const encodeAudioArgs = inputMeta.audioCodec
        ? ['-c:a', 'aac', '-b:a', '192k', '-ar', '48000']
        : ['-an'];

      const isLandscape = inputMeta.width >= inputMeta.height;
      const targetW = isLandscape ? 1920 : 1080;
      const targetH = isLandscape ? 1080 : 1920;
      const vf = `scale=${targetW}:${targetH}:force_original_aspect_ratio=decrease,pad=${targetW}:${targetH}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

      let ffmpegArgs;
      if (mode === 'tiktok60') {
        ffmpegArgs = [
          '-y', '-i', inputPath,
          '-vf', vf,
          '-r', '60',
          '-c:v', 'libx264', '-profile:v', 'high', '-level:v', '4.2',
          '-preset', 'veryfast',
          '-crf', '18', '-maxrate', '16M', '-bufsize', '32M',
          '-pix_fmt', 'yuv420p',
          ...encodeAudioArgs,
          '-movflags', '+faststart',
          outputPath
        ];
      } else if (mode === 'fhd120') {
        ffmpegArgs = [
          '-y', '-i', inputPath,
          '-vf', vf,
          '-r', '120',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p',
          ...encodeAudioArgs,
          '-movflags', '+faststart',
          outputPath
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

      if (rules.dailyLimit !== null) {
        usage.count += 1;
      }

      readyFiles.set(fileId, {
        filePath: outputPath,
        downloadName,
        createdAt: Date.now()
      });

      res.json({
        success: true,
        fileId,
        downloadName,
        downloadUrl: `/api/download/${fileId}`,
        inputMeta,
        outputMeta,
        plan,
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
  console.log(`Plans: Free=${PLANS.free.maxMB}MB (${PLANS.free.dailyLimit}/day) | Creator=${PLANS.creator.maxMB}MB (${PLANS.creator.dailyLimit}/day) | VIP=Unlimited`);
  console.log(ok ? 'FFmpeg binary: READY' : 'FFmpeg binary MISSING! Run: node node_modules/ffmpeg-static/install.js');
});
server.timeout = 0;
server.requestTimeout = 0;