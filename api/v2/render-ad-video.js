/**
 * Vercel API endpoint for Shotstack-powered ad video rendering.
 *
 * Flow:
 * 1. Receive invite screenshot URL + video params (promptText, format, theme)
 * 2. Build a Shotstack JSON timeline (phone mockup, typing, shimmer, invite scroll, CTA)
 * 3. POST to Shotstack render API
 * 4. Poll for completion, stream progress via SSE
 * 5. Return the rendered MP4 URL
 *
 * Requires env var: SHOTSTACK_API_KEY
 * Optional: SHOTSTACK_ENV (default: 'stage' for sandbox, set to 'v1' for production)
 */

import { createClient } from '@supabase/supabase-js';

const SHOTSTACK_BASE = 'https://api.shotstack.io/edit';

async function getUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY,
    { global: { headers: { Authorization: `Bearer ${token}` } } }
  );
  const { data: { user }, error } = await supabase.auth.getUser();
  return error ? null : user;
}

// Theme color palettes (matches ad-video-generator.js)
const THEMES = {
  dark_gradient:  { bg: '#1a0a2e', text: '#ffffff', subtext: '#b8b8d0', accent: '#E94560' },
  light_clean:    { bg: '#f0f2f5', text: '#1a1a2e', subtext: '#666680', accent: '#E94560' },
  ryvite_brand:   { bg: '#0a0a1a', text: '#ffffff', subtext: '#a8a8c0', accent: '#E94560' },
  warm_sunset:    { bg: '#ffecd2', text: '#3d1f00', subtext: '#6b4226', accent: '#E94560' },
};

// Format dimensions
const FORMATS = {
  reels_9x16: { width: 1080, height: 1920 },
  feed_1x1:   { width: 1080, height: 1080 },
};

/**
 * Build a Shotstack timeline JSON for the ad video.
 *
 * Layers (tracks, top to bottom):
 * 5. CTA button text (appears at end)
 * 4. Prompt typing text (appears early, fades out)
 * 3. "YOUR PROMPT" label
 * 2. Invite screenshot (with zoom-in reveal + scroll effect)
 * 1. Phone frame overlay (static, full duration)
 * 0. Background color
 */
function buildTimeline({ inviteImageUrl, promptText, format, theme, phoneFrameUrl }) {
  const thm = THEMES[theme] || THEMES.dark_gradient;
  const fmt = FORMATS[format] || FORMATS.reels_9x16;
  const isReels = format === 'reels_9x16';

  // Timing (seconds) — simplified from original multi-phase timeline
  const introDelay = 0.5;       // Brief pause before content
  const typingDuration = 3.0;   // Show prompt text
  const transitionGap = 0.5;    // Fade between prompt and invite
  const inviteDuration = 8.0;   // Invite display + slow zoom/pan
  const ctaDuration = 2.5;      // CTA at the end
  const totalDuration = introDelay + typingDuration + transitionGap + inviteDuration + ctaDuration;

  // Phase timestamps
  const promptStart = introDelay;
  const promptEnd = promptStart + typingDuration;
  const inviteStart = promptEnd + transitionGap;
  const inviteEnd = inviteStart + inviteDuration;
  const ctaStart = inviteEnd - 1.0; // Overlap slightly with invite end

  // Phone frame sizing (centered, proportional to canvas)
  const phoneScale = isReels ? 0.42 : 0.55;
  const phoneY = isReels ? -0.05 : -0.02;

  // Invite sizing inside phone (slightly smaller than phone to show bezel)
  const inviteScale = phoneScale * 0.88;
  const inviteY = phoneY + 0.01;

  const tracks = [];

  // Track 5: CTA text ("Create Yours Free" + "ryvite.com")
  tracks.push({
    clips: [
      {
        asset: {
          type: 'html',
          html: `<div style="text-align:center;">
            <div style="background:${thm.accent};color:white;padding:16px 48px;border-radius:32px;font-family:Inter,Arial,sans-serif;font-weight:bold;font-size:28px;display:inline-block;box-shadow:0 6px 20px rgba(233,69,96,0.4);">Create Yours Free</div>
            <div style="color:${thm.subtext};font-family:Inter,Arial,sans-serif;font-size:18px;margin-top:12px;">ryvite.com</div>
          </div>`,
          width: fmt.width,
          height: 200,
        },
        start: ctaStart,
        length: totalDuration - ctaStart,
        position: 'bottom',
        offset: { y: isReels ? 0.05 : 0.04 },
        transition: { in: 'slideUp' },
      },
    ],
  });

  // Track 4b: Prompt card background + "YOUR PROMPT" label
  tracks.push({
    clips: [
      {
        asset: {
          type: 'html',
          html: `<div style="text-align:center;padding:24px;">
            <div style="background:white;border-radius:18px;padding:40px 24px 120px;box-shadow:0 4px 16px rgba(0,0,0,0.1);max-width:360px;margin:0 auto;">
              <div style="font-family:Inter,sans-serif;font-weight:700;font-size:14px;color:${thm.accent};letter-spacing:0.05em;">YOUR PROMPT</div>
            </div>
          </div>`,
          width: Math.round(fmt.width * phoneScale * 0.85),
          height: 400,
        },
        start: promptStart,
        length: typingDuration + transitionGap * 0.5,
        position: 'center',
        offset: { y: phoneY },
        transition: { in: 'fade', out: 'fade' },
      },
    ],
  });

  // Track 4a: Prompt text with typewriter animation (on top of card)
  tracks.unshift({
    clips: [
      {
        asset: {
          type: 'html',
          html: `<div style="text-align:center;font-family:Inter,Helvetica Neue,Arial,sans-serif;font-size:22px;line-height:1.5;color:#1a1a2e;max-width:320px;margin:0 auto;">${promptText}</div>`,
          width: Math.round(fmt.width * phoneScale * 0.75),
          height: 300,
        },
        start: promptStart + 0.3,
        length: typingDuration + transitionGap * 0.2,
        position: 'center',
        offset: { y: phoneY + 0.03 },
        transition: { in: 'fade', out: 'fade' },
      },
    ],
  });

  // Track 3: Shimmer / loading effect (brief, between prompt and invite)
  tracks.push({
    clips: [
      {
        asset: {
          type: 'html',
          html: `<div style="text-align:center;font-family:Inter,sans-serif;font-size:18px;font-weight:600;color:${thm.accent};">
            ✨ Creating your invite...
          </div>`,
          width: 400,
          height: 60,
        },
        start: promptEnd - 0.3,
        length: transitionGap + 0.6,
        position: 'center',
        offset: { y: phoneY + 0.12 },
        transition: {
          in: 'fade',
          out: 'fade',
        },
      },
    ],
  });

  // Track 2: Invite screenshot (inside phone, with slow zoom effect)
  tracks.push({
    clips: [
      {
        asset: {
          type: 'image',
          src: inviteImageUrl,
        },
        start: inviteStart,
        length: inviteDuration,
        fit: 'contain',
        scale: inviteScale,
        position: 'center',
        offset: { y: inviteY },
        effect: 'zoomIn',
        transition: {
          in: 'fade',
        },
      },
    ],
  });

  // Track 1: Ryvite logo + subtitle (top of frame)
  tracks.push({
    clips: [
      {
        asset: {
          type: 'html',
          html: `<div style="text-align:center;">
            <div style="font-family:Playfair Display,Georgia,serif;font-weight:600;font-size:40px;color:${thm.text};">✉ Ryvite</div>
            <div style="font-family:Inter,Helvetica Neue,Arial,sans-serif;font-size:18px;color:${thm.subtext};margin-top:6px;">AI-Powered Event Invitations</div>
          </div>`,
          width: 600,
          height: 120,
        },
        start: 0,
        length: totalDuration,
        position: 'top',
        offset: { y: isReels ? -0.03 : -0.02 },
        transition: { in: 'fade' },
      },
    ],
  });

  // Track 0: Background
  tracks.push({
    clips: [
      {
        asset: {
          type: 'html',
          html: `<div style="width:100%;height:100%;background:linear-gradient(180deg, ${thm.bg}, ${adjustBrightness(thm.bg, 20)});"></div>`,
          width: fmt.width,
          height: fmt.height,
        },
        start: 0,
        length: totalDuration,
      },
    ],
  });

  return {
    timeline: {
      background: thm.bg,
      tracks,
      fonts: [
        { src: 'https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfAZ9hiA.woff2' },
        { src: 'https://fonts.gstatic.com/s/playfairdisplay/v37/nuFvD-vYSZviVYUb_rj3ij__anPXJzDwcbmjWBN2PKd3vXDXbtXK-F2qC0s.woff2' },
      ],
    },
    output: {
      format: 'mp4',
      resolution: isReels ? 'hd' : 'sd',
      aspectRatio: isReels ? '9:16' : '1:1',
      fps: 30,
      quality: 'high',
      size: {
        width: fmt.width,
        height: fmt.height,
      },
    },
  };
}

/** Lighten/darken a hex color */
function adjustBrightness(hex, amount) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, Math.max(0, ((num >> 16) & 255) + amount));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 255) + amount));
  const b = Math.min(255, Math.max(0, (num & 255) + amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Auth
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  // Validate env
  const apiKey = process.env.SHOTSTACK_API_KEY_SAND || process.env.SHOTSTACK_API_KEY;
  const env = process.env.SHOTSTACK_API_KEY_SAND ? 'stage' : (process.env.SHOTSTACK_ENV || 'v1');

  if (!apiKey) {
    return res.status(503).json({
      error: 'Shotstack not configured. Set SHOTSTACK_API_KEY_SAND (sandbox) or SHOTSTACK_API_KEY (production) env var.',
      hint: 'Sign up at https://dashboard.shotstack.io and copy your API key.',
    });
  }

  const { inviteImageBase64, inviteImageUrl: providedUrl, promptText, format, theme } = req.body;

  if (!inviteImageBase64 && !providedUrl) return res.status(400).json({ error: 'inviteImageBase64 or inviteImageUrl is required' });
  if (!promptText) return res.status(400).json({ error: 'promptText is required' });
  if (!format) return res.status(400).json({ error: 'format is required (reels_9x16 or feed_1x1)' });

  // SSE streaming for progress
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const keepalive = setInterval(() => { res.write(': keepalive\n\n'); }, 3000);

  try {
    let inviteImageUrl = providedUrl;

    // If base64 image provided, upload to Shotstack Ingest API first
    if (inviteImageBase64 && !inviteImageUrl) {
      res.write(`data: ${JSON.stringify({ type: 'progress', phase: 'Uploading invite image...', pct: 5 })}\n\n`);

      // Step 1: Request a signed upload URL from Shotstack Ingest API
      const ingestRes = await fetch(`${SHOTSTACK_BASE.replace('/edit', '/ingest')}/${env}/upload`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          fileName: `ryvite-invite-${Date.now()}.png`,
          fileType: 'image/png',
        }),
      });

      if (!ingestRes.ok) {
        // Fallback: if Ingest API isn't available, try a different approach
        // Use a data URL with a smaller image (JPEG, lower quality)
        const dataUrl = inviteImageBase64.startsWith('data:')
          ? inviteImageBase64
          : `data:image/png;base64,${inviteImageBase64}`;
        inviteImageUrl = dataUrl;
        res.write(`data: ${JSON.stringify({ type: 'progress', phase: 'Using inline image...', pct: 8 })}\n\n`);
      } else {
        const ingestData = await ingestRes.json();
        const signedUrl = ingestData?.data?.attributes?.url;
        const sourceUrl = ingestData?.data?.attributes?.source;

        if (signedUrl) {
          // Step 2: Upload the image binary to the signed URL
          const base64Data = inviteImageBase64.replace(/^data:image\/\w+;base64,/, '');
          const imageBuffer = Buffer.from(base64Data, 'base64');

          await fetch(signedUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'image/png' },
            body: imageBuffer,
          });

          inviteImageUrl = sourceUrl || signedUrl.split('?')[0];
          res.write(`data: ${JSON.stringify({ type: 'progress', phase: 'Image uploaded', pct: 10 })}\n\n`);
        } else {
          throw new Error('Failed to get upload URL from Shotstack Ingest API');
        }
      }
    }

    res.write(`data: ${JSON.stringify({ type: 'progress', phase: 'Building video timeline...', pct: 12 })}\n\n`);

    // Build Shotstack timeline
    const payload = buildTimeline({
      inviteImageUrl,
      promptText,
      format,
      theme: theme || 'dark_gradient',
    });

    res.write(`data: ${JSON.stringify({ type: 'progress', phase: 'Submitting to Shotstack...', pct: 15 })}\n\n`);

    // Submit render
    const renderRes = await fetch(`${SHOTSTACK_BASE}/${env}/render`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify(payload),
    });

    const renderData = await renderRes.json();

    if (!renderData.success || !renderData.response?.id) {
      throw new Error(`Shotstack render failed: ${renderData.message || JSON.stringify(renderData)}`);
    }

    const renderId = renderData.response.id;
    res.write(`data: ${JSON.stringify({ type: 'progress', phase: 'Rendering video...', pct: 20, renderId })}\n\n`);

    // Poll for completion
    let done = false;
    let attempts = 0;
    const maxAttempts = 180; // 3 minutes max

    while (!done && attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 1000));
      attempts++;

      const statusRes = await fetch(`${SHOTSTACK_BASE}/${env}/render/${renderId}`, {
        headers: { 'x-api-key': apiKey },
      });

      const statusData = await statusRes.json();
      const status = statusData.response?.status;

      if (status === 'failed') {
        throw new Error(`Shotstack render failed: ${statusData.response?.error || 'Unknown error'}`);
      }

      // Estimate progress (Shotstack doesn't give exact %)
      const pct = Math.min(90, 20 + attempts * 2);
      const phaseLabel = status === 'rendering' ? 'Rendering video...' : status === 'queued' ? 'Queued...' : 'Processing...';
      res.write(`data: ${JSON.stringify({ type: 'progress', phase: phaseLabel, pct })}\n\n`);

      if (status === 'done') {
        done = true;
        const videoUrl = statusData.response.url;

        res.write(`data: ${JSON.stringify({
          type: 'done',
          url: videoUrl,
          renderId,
          pct: 100,
        })}\n\n`);
      }
    }

    if (!done) {
      throw new Error('Render timed out after 3 minutes');
    }

  } catch (err) {
    console.error('[render-ad-video] Error:', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
  } finally {
    clearInterval(keepalive);
    res.end();
  }
}
