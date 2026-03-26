/**
 * Vercel API endpoint for Remotion-powered ad video rendering.
 *
 * Flow:
 * 1. Receive invite data (html, css, config, promptText, format, theme)
 * 2. Screenshot the invite via existing render-video Puppeteer endpoint
 * 3. Upload screenshot to S3
 * 4. Trigger Remotion Lambda render with invite image URL + props
 * 5. Return S3 video URL via SSE progress events
 *
 * Requires env vars:
 * - REMOTION_AWS_ACCESS_KEY_ID, REMOTION_AWS_SECRET_ACCESS_KEY
 * - REMOTION_S3_BUCKET, REMOTION_FUNCTION_NAME, REMOTION_SERVE_URL
 * - REMOTION_AWS_REGION (default: us-east-1)
 */

import { createClient } from '@supabase/supabase-js';

// Lazy-load Remotion Lambda SDK (only imported when actually rendering)
let remotionLambda = null;
async function getRemotionLambda() {
  if (!remotionLambda) {
    remotionLambda = await import('@remotion/lambda/client');
  }
  return remotionLambda;
}

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
  const {
    REMOTION_AWS_ACCESS_KEY_ID,
    REMOTION_AWS_SECRET_ACCESS_KEY,
    REMOTION_S3_BUCKET,
    REMOTION_FUNCTION_NAME,
    REMOTION_SERVE_URL,
    REMOTION_AWS_REGION = 'us-east-1',
  } = process.env;

  if (!REMOTION_FUNCTION_NAME || !REMOTION_SERVE_URL) {
    return res.status(503).json({
      error: 'Remotion Lambda not configured. Set REMOTION_FUNCTION_NAME and REMOTION_SERVE_URL env vars.',
      hint: 'Run: cd remotion && npx remotion lambda functions deploy && npx remotion lambda sites create src/index.ts',
    });
  }

  const { html, css, config, promptText, format, theme, inviteImageUrl, inviteWidth, inviteHeight } = req.body;

  if (!promptText) return res.status(400).json({ error: 'promptText is required' });
  if (!format) return res.status(400).json({ error: 'format is required (reels_9x16 or feed_1x1)' });

  // If invite image URL not provided, we need to generate it
  // (The admin UI should pre-upload the screenshot, but this is a fallback)
  if (!inviteImageUrl) {
    return res.status(400).json({
      error: 'inviteImageUrl is required. Upload the invite screenshot to S3 first.',
      hint: 'Use /api/v2/render-video with ?action=screenshot to capture the invite, then upload to S3.',
    });
  }

  // SSE streaming for progress
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const keepalive = setInterval(() => { res.write(': keepalive\n\n'); }, 3000);

  try {
    res.write(`data: ${JSON.stringify({ type: 'progress', phase: 'Starting Remotion render...', pct: 10 })}\n\n`);

    // Determine composition ID based on format
    const compositionId = format === 'feed_1x1' ? 'AdVideo-Feed' : 'AdVideo-Reels';

    const inputProps = {
      inviteImageUrl,
      promptText,
      format,
      theme: theme || 'dark_gradient',
      inviteWidth: inviteWidth || 786,
      inviteHeight: inviteHeight || 2400,
    };

    res.write(`data: ${JSON.stringify({ type: 'progress', phase: 'Triggering Lambda render...', pct: 20 })}\n\n`);

    const lambda = await getRemotionLambda();

    const { renderId, bucketName } = await lambda.renderMediaOnLambda({
      region: REMOTION_AWS_REGION,
      functionName: REMOTION_FUNCTION_NAME,
      serveUrl: REMOTION_SERVE_URL,
      composition: compositionId,
      inputProps,
      codec: 'h264',
      imageFormat: 'jpeg',
      maxRetries: 1,
      privacy: 'public',
      outName: `ryvite-ad-${format}-${Date.now()}.mp4`,
    });

    res.write(`data: ${JSON.stringify({ type: 'progress', phase: 'Rendering video...', pct: 30, renderId })}\n\n`);

    // Poll for completion
    let done = false;
    let attempts = 0;
    const maxAttempts = 120; // 2 minutes max (polling every 1s)

    while (!done && attempts < maxAttempts) {
      await new Promise(r => setTimeout(r, 1000));
      attempts++;

      try {
        const progress = await lambda.getRenderProgress({
          region: REMOTION_AWS_REGION,
          functionName: REMOTION_FUNCTION_NAME,
          bucketName,
          renderId,
        });

        if (progress.fatalErrorEncountered) {
          throw new Error(`Render failed: ${progress.errors?.[0]?.message || 'Unknown error'}`);
        }

        const pct = 30 + Math.round((progress.overallProgress || 0) * 65);
        res.write(`data: ${JSON.stringify({
          type: 'progress',
          phase: `Rendering... ${Math.round((progress.overallProgress || 0) * 100)}%`,
          pct,
        })}\n\n`);

        if (progress.done) {
          done = true;
          const videoUrl = progress.outputFile;

          res.write(`data: ${JSON.stringify({
            type: 'done',
            url: videoUrl,
            renderId,
            pct: 100,
          })}\n\n`);
        }
      } catch (pollErr) {
        // Non-fatal poll errors — retry
        if (attempts >= maxAttempts) {
          throw new Error(`Render timed out after ${maxAttempts}s: ${pollErr.message}`);
        }
      }
    }

    if (!done) {
      throw new Error('Render timed out');
    }

  } catch (err) {
    console.error('[render-ad-video] Error:', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
  } finally {
    clearInterval(keepalive);
    res.end();
  }
}
