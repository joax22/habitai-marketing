const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const fetch = require('node-fetch');
const puppeteer = require('puppeteer');

const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

const hashOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

// ══════════════════════════════════════════
// Capture screenshots of a TikTok / Instagram post
// using a headless Chrome browser via Puppeteer.
// ══════════════════════════════════════════
async function capturePost(url) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
    ],
  });

  try {
    const page = await browser.newPage();

    // Mobile user-agent gives a cleaner, content-focused page on TikTok/Instagram
    await page.setUserAgent(
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
    );
    await page.setViewport({ width: 414, height: 896, isMobile: true, hasTouch: true });

    console.log('  → Navigating to page...');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    console.log('  → Waiting for content to render...');
    await new Promise(r => setTimeout(r, 5000));

    // Dismiss any cookie / login dismissable overlays
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll('button')];
      const dismissText = /accept|agree|got it|close|continue|skip|not now/i;
      for (const btn of buttons) {
        if (dismissText.test(btn.textContent || '')) {
          try { btn.click(); } catch (_) {}
        }
      }
    }).catch(() => {});

    await new Promise(r => setTimeout(r, 1500));

    const screenshots = [];
    const seenHashes = new Set();

    const takeShot = async () => {
      // Puppeteer 23+ returns Uint8Array — wrap in Buffer for reliable base64
      const raw = await page.screenshot({ type: 'jpeg', quality: 75 });
      const buf = Buffer.from(raw);
      if (!buf || buf.length === 0) return null;
      const h = hashOf(buf);
      if (seenHashes.has(h)) return { duplicate: true };
      seenHashes.add(h);
      return { buf };
    };

    const hasVideo = await page.evaluate(() => !!document.querySelector('video'));

    if (hasVideo) {
      console.log('  → Video post — capturing frames over time...');
      for (let i = 0; i < 5; i++) {
        const r = await takeShot();
        if (r && r.buf) screenshots.push(r.buf);
        if (i < 4) await new Promise(rs => setTimeout(rs, 1500));
      }
    } else {
      console.log('  → Photo post — capturing slides...');
      const first = await takeShot();
      if (first && first.buf) screenshots.push(first.buf);

      for (let i = 0; i < 9; i++) {
        const advanced = await page.evaluate(() => {
          const selectors = [
            '[data-e2e="arrow-right"]',
            '[data-e2e="slideshow-arrow-right"]',
            'button[aria-label*="Next" i]',
            '.swiper-button-next',
            '[class*="ArrowRight"]',
            '[class*="arrow-right"]',
          ];
          for (const sel of selectors) {
            const el = document.querySelector(sel);
            if (el && !el.disabled) { el.click(); return true; }
          }
          return false;
        });
        if (!advanced) {
          try { await page.keyboard.press('ArrowRight'); } catch (_) {}
        }
        await new Promise(rs => setTimeout(rs, 900));
        const r = await takeShot();
        if (!r) continue;
        if (r.duplicate) {
          console.log(`  → No new slide detected — stopping at slide ${screenshots.length}.`);
          break;
        }
        screenshots.push(r.buf);
      }
    }

    // Persist to temp/ for debugging — gitignored
    const stamp = Date.now();
    screenshots.forEach((b, i) => {
      try { fs.writeFileSync(path.join(TEMP_DIR, `shot_${stamp}_${i}.jpg`), b); } catch (_) {}
    });

    return screenshots;
  } finally {
    await browser.close();
  }
}

// ══════════════════════════════════════════
// POST /api/analyze
// ══════════════════════════════════════════
app.post('/api/analyze', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required.' });

  try {
    console.log(`\n[analyze] ${url}`);
    console.log('[1/2] Capturing post with headless browser...');
    const screenshots = await capturePost(url);
    if (!screenshots.length) throw new Error('No screenshots captured.');
    console.log(`[1/2] Captured ${screenshots.length} screenshot(s).`);

    console.log('[2/2] Sending to Claude for analysis...');
    const imageBlocks = screenshots.map(buf => ({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg',
        data: Buffer.from(buf).toString('base64'),
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
            text: `These are sequential screenshots of a TikTok or Instagram post. They may be frames from a video, slides from a photo carousel, or both. Analyse this content as a marketing researcher studying viral short-form content for a habit tracker app called HabitAI.

Return ONLY valid JSON — no markdown, no extra text, no code blocks:
{
  "hook": "The exact hook used in the first 2-3 seconds — the words or visual that stops the scroll",
  "structure": "Step-by-step structure of the post (e.g. bold claim → relatable problem → solution reveal → CTA)",
  "why": "Why this format works — psychological triggers, emotional hooks, retention tactics",
  "tags": "comma-separated topic tags (e.g. productivity, morning routine, habits, self-improvement)"
}`,
          },
        ],
      }],
    });

    let raw = (message.content[0]?.text || '').trim();
    // Strip ```json ... ``` or ``` ... ``` fences if present
    raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    // Pull the first {...} block as a last resort
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) raw = jsonMatch[0];

    let result;
    try {
      result = JSON.parse(raw);
    } catch (e) {
      console.error('[analyze] could not parse Claude reply:', raw.slice(0, 300));
      throw new Error('Claude returned an unexpected response format.');
    }

    console.log('[2/2] Analysis complete.\n');
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('[analyze]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════
// POST /api/generate-image — Google Imagen
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
    if (!response.ok) throw new Error(data.error?.message || `Image API error: ${response.status}`);

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
