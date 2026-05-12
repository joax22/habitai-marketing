require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const TEMP_DIR = path.join(__dirname, 'temp');
const YTDLP = fs.existsSync(path.join(__dirname, 'yt-dlp.exe'))
  ? `"${path.join(__dirname, 'yt-dlp.exe')}"`
  : 'yt-dlp';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

// ── Cleanup temp files for a given session ID ──
function cleanup(sessionId) {
  try {
    fs.readdirSync(TEMP_DIR)
      .filter(f => f.startsWith(sessionId))
      .forEach(f => fs.unlinkSync(path.join(TEMP_DIR, f)));
  } catch (_) {}
}

// ══════════════════════════════════════════
// POST /api/analyze
// Downloads TikTok/Instagram video via yt-dlp,
// extracts frames with ffmpeg, sends to Claude.
// ══════════════════════════════════════════
app.post('/api/analyze', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required.' });

  const sessionId = `vid_${Date.now()}`;
  const frames = [];

  try {
    // ── 1. Download video ──
    const outputTemplate = path.join(TEMP_DIR, `${sessionId}.%(ext)s`).replace(/\\/g, '/');
    console.log('[1/3] Downloading post...');
    try {
      execSync(
        `${YTDLP} -o "${outputTemplate}" --no-playlist "${url}"`,
        { timeout: 90000, stdio: 'pipe' }
      );
    } catch (e) {
      const detail = e.stderr ? e.stderr.toString() : e.message;
      if (detail.includes('Unsupported URL') || detail.includes('generic')) {
        throw new Error('Could not download this post. Make sure yt-dlp.exe is up to date and the post is public.');
      }
      throw new Error(`Download failed: ${detail.slice(0, 200)}`);
    }
    console.log('[1/3] Download complete.');

    // Find all downloaded files for this session
    const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'];
    const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.mkv', '.avi'];
    const allDownloaded = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith(sessionId));
    const imageFiles = allDownloaded.filter(f => IMAGE_EXTS.some(e => f.toLowerCase().endsWith(e)));
    const videoFiles = allDownloaded.filter(f => VIDEO_EXTS.some(e => f.toLowerCase().endsWith(e)));

    if (!allDownloaded.length) throw new Error('Download completed but no files found.');

    // ── 2a. Photo slideshow — use images directly ──
    if (imageFiles.length && !videoFiles.length) {
      console.log(`[2/3] Photo post — using ${imageFiles.length} image(s) directly.`);
      frames.push(...imageFiles.map(f => path.join(TEMP_DIR, f)));

    // ── 2b. Video — extract frames with ffmpeg ──
    } else if (videoFiles.length) {
      console.log('[2/3] Video post — extracting frames with ffmpeg...');
      const videoPath = path.join(TEMP_DIR, videoFiles[0]).replace(/\\/g, '/');
      const timestamps = [0, 1, 3, 6, 10];
      for (const t of timestamps) {
        const framePath = path.join(TEMP_DIR, `${sessionId}_f${t}.jpg`).replace(/\\/g, '/');
        try {
          execSync(
            `ffmpeg -y -i "${videoPath}" -ss ${t} -frames:v 1 -q:v 2 "${framePath}"`,
            { timeout: 15000, stdio: 'pipe' }
          );
          if (fs.existsSync(framePath)) frames.push(framePath);
        } catch (_) { /* frame past video end — skip */ }
      }
      if (!frames.length) throw new Error('Could not extract frames. Is ffmpeg installed? Run: winget install ffmpeg');
      console.log(`[2/3] Extracted ${frames.length} frames.`);
    } else {
      throw new Error('Downloaded files were not recognised as images or video.');
    }

    // ── 3. Send to Claude ──
    console.log('[3/3] Sending to Claude for analysis...');
    const imageBlocks = frames.map(fp => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: fs.readFileSync(fp).toString('base64'),
      },
    }));

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          ...imageBlocks,
          {
            type: 'text',
            text: `These are sequential frames from a TikTok or Instagram Reel. Analyse it as a marketing researcher studying viral short-form content for a habit tracker app called HabitAI.

Return ONLY valid JSON — no markdown, no extra text, no code blocks:
{
  "hook": "The exact hook used in the first 2-3 seconds — the words or action that stops the scroll",
  "structure": "Step-by-step structure of the video (e.g. bold claim → relatable problem → solution reveal → CTA)",
  "why": "Why this format works — psychological triggers, emotional hooks, retention tactics",
  "tags": "comma-separated topic tags (e.g. productivity, morning routine, habits, self-improvement)"
}`,
          },
        ],
      }],
    });

    let result;
    try {
      result = JSON.parse(message.content[0].text.trim());
    } catch (_) {
      throw new Error('Claude returned an unexpected response format.');
    }

    res.json({ success: true, ...result });

  } catch (err) {
    console.error('[analyze]', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    cleanup(sessionId);
  }
});

// ══════════════════════════════════════════
// POST /api/generate-image
// Generates an AI influencer face image using
// Google Imagen (NanoBanana key).
// ══════════════════════════════════════════
app.post('/api/generate-image', async (req, res) => {
  const { description, name, niche } = req.body;
  if (!description) return res.status(400).json({ error: 'Description is required.' });

  const prompt = `Professional lifestyle photo of a ${niche || 'wellness'} social media influencer named ${name || 'an influencer'}. ${description}. The person appears authentic, approachable and confident. Clean background, natural lighting, portrait crop, photorealistic, high quality.`;

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:predict?key=${process.env.NANOBANANA_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: [{ prompt }],
          parameters: { sampleCount: 1, aspectRatio: '1:1' },
        }),
      }
    );

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error?.message || `Image API error: ${response.status}`);
    }

    const b64 = data.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) throw new Error('No image returned from generation API.');

    res.json({ success: true, image: `data:image/png;base64,${b64}` });

  } catch (err) {
    console.error('[generate-image]', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n  HabitAI Marketing System`);
  console.log(`  Running at http://localhost:${PORT}\n`);
});
