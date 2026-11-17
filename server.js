const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'outputs');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const readyFiles = new Map();
const jobs = new Map();

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase() || '.mp4';
    cb(null, `${crypto.randomUUID()}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 * 1024 }, // 50 GB max (Unlimited)
  fileFilter: (_, file, cb) => {
    const allowedExt = ['.mp4', '.mov', '.mkv', '.webm', '.m4v'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (file.mimetype.startsWith('video/') || allowedExt.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Please upload a valid video file (MP4, MOV, MKV, WEBM).'));
    }
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_, res) => {
  const ffmpegReady = Boolean(ffmpegPath && fs.existsSync(ffmpegPath));
  res.json({ ok: ffmpegReady, ffmpegReady, engine: 'Nha Engine 2.0' });
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
  upload.single('video')(req, res, async err => {
    if (err) return res.status(400).json({ error: err.message });
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
        outputMeta
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