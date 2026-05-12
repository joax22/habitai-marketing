require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { execSync, spawnSync } = require('child_process');
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

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Scrape image URLs from a TikTok / Instagram post page
async function scrapeImagesFromPage(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': BROWSER_UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`Failed to fetch page (${res.status})`);
  const html = await res.text();

  const urls = new Set();

  // 1. og:image meta tags (cover + each slide on most platforms)
  const ogRegex = /<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/gi;
  for (const m of html.matchAll(ogRegex)) urls.add(m[1]);

  // 2. TikTok embeds slideshow URLs inside its hydration JSON
  try {
    const jsonMatch = html.match(/<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]+?)<\/script>/);
    if (jsonMatch) {
      const data = JSON.parse(jsonMatch[1]);
      const item = data?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
      const images = item?.imagePost?.images || [];
      for (const img of images) {
        const candidate = img?.imageURL?.urlList?.[0] || img?.imageURL?.urlList?.find(Boolean);
        if (candidate) urls.add(candidate);
      }
    }
  } catch (_) {}

  return [...urls].filter(u => /^https?:\/\//.test(u));
}

async function downloadImage(url, destPath) {
  const res = await fetch(url, { headers: { 'User-Agent': BROWSER_UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`Image fetch failed (${res.status})`);
  const buffer = await res.buffer();
  fs.writeFileSync(destPath, buffer);
}

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
    const ytdlpBin = path.join(__dirname, 'yt-dlp.exe');
    const browsers = ['chrome', 'edge', 'firefox'];
    let downloaded = false;
    let lastError = '';

    // Try without cookies first, then retry with each browser's cookies
    const attempts = [null, ...browsers];
    for (const browser of attempts) {
      const args = ['-o', outputTemplate, '--no-playlist'];
      if (browser) args.push('--cookies-from-browser', browser);
      args.push(url);

      const result = spawnSync(ytdlpBin, args, { timeout: 90000, encoding: 'utf8' });
      const stderr = result.stderr || '';
      const stdout = result.stdout || '';

      if (result.status === 0) {
        downloaded = true;
        if (browser) console.log(`[1/3] Downloaded using ${browser} cookies.`);
        break;
      }
      lastError = stderr || stdout;
      console.log(`[1/3] Attempt failed${browser ? ` (${browser})` : ''}: ${lastError.slice(0, 120)}`);
    }

    if (!downloaded) {
      // ── Fallback: scrape page directly (TikTok photo posts etc.) ──
      console.log('[1/3] yt-dlp failed — falling back to page scraper...');
      try {
        const imageUrls = await scrapeImagesFromPage(url);
        if (!imageUrls.length) throw new Error('No images found on page.');
        console.log(`[1/3] Scraper found ${imageUrls.length} image(s). Downloading...`);

        let i = 0;
        for (const imgUrl of imageUrls.slice(0, 8)) {
          const destPath = path.join(TEMP_DIR, `${sessionId}_scrape_${i}.jpg`);
          try {
            await downloadImage(imgUrl, destPath);
            i++;
          } catch (e) {
            console.log(`  skip image ${i}: ${e.message}`);
          }
        }
        downloaded = i > 0;
      } catch (e) {
        throw new Error(`Could not download post. Both yt-dlp and the page scraper failed.\n\nyt-dlp: ${lastError.slice(0, 200)}\nScraper: ${e.message}`);
      }
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
  console.log(`  Running at http://localhost:${PORT}`);

  try {
    const ver = spawnSync(path.join(__dirname, 'yt-dlp.exe'), ['--version'], { encoding: 'utf8' });
    console.log(`  yt-dlp version: ${(ver.stdout || ver.stderr || 'unknown').trim()}\n`);
  } catch (_) {
    console.log(`  yt-dlp version: unknown\n`);
  }
});
