/**
 * Server-side ad video rendering endpoint.
 *
 * Flow:
 * 1. Client POSTs with invite data + creative params
 * 2. Server creates/updates ad_creative record with status "rendering"
 * 3. Returns creative_id immediately
 * 4. Launches Puppeteer, loads a page with the full Canvas animation engine
 * 5. Page runs the animation and records via MediaRecorder (headless)
 * 6. Extracts the video blob, uploads to Supabase Storage
 * 7. Updates ad_creative with status "ready" + video_url
 *
 * The client polls the ad_creatives list to see when status changes to "ready".
 */

import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function getUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
  const { data: { user }, error } = await supabase.auth.getUser();
  return error ? null : user;
}

/**
 * Build a self-contained HTML page that runs the full ad video animation
 * and records it via MediaRecorder. The page signals completion by setting
 * window.__VIDEO_DONE = true and window.__VIDEO_BASE64 = <data>.
 */
function buildAnimationPage(opts) {
  const { html, css, config, promptText, format, theme, liveAnimation } = opts;

  // Escape for embedding in JS string
  const esc = (s) => (s || '').replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$/g, '\\$');

  return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<script src="https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js"><\/script>
</head>
<body style="margin:0;padding:0;background:#000;">
<script>
// Signal for Puppeteer to know when we're done
window.__VIDEO_DONE = false;
window.__VIDEO_BASE64 = null;
window.__VIDEO_ERROR = null;
window.__VIDEO_PROGRESS = 'Loading...';
<\/script>

<!-- Load the full ad video generator engine -->
<script src="https://${process.env.VERCEL_URL || 'ryvite.com'}/v2/admin/ad-video-generator.js"><\/script>

<script>
(async function() {
  try {
    window.__VIDEO_PROGRESS = 'Starting render...';

    var blob = await window.AdVideoGenerator.generate({
      html: \`${esc(html)}\`,
      css: \`${esc(css)}\`,
      config: ${JSON.stringify(config || {})},
      promptText: \`${esc(promptText)}\`,
      format: '${format}',
      theme: '${theme || 'dark_gradient'}',
      liveAnimation: false,
      onProgress: function(pct, phase) {
        window.__VIDEO_PROGRESS = phase || ('Rendering ' + Math.round(pct) + '%');
      }
    });

    // Convert blob to base64
    window.__VIDEO_PROGRESS = 'Converting...';
    var reader = new FileReader();
    reader.onloadend = function() {
      window.__VIDEO_BASE64 = reader.result;
      window.__VIDEO_DONE = true;
    };
    reader.readAsDataURL(blob);

  } catch (err) {
    window.__VIDEO_ERROR = err.message || 'Unknown render error';
    window.__VIDEO_DONE = true;
  }
})();
<\/script>
</body></html>`;
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized' });

  const {
    creativeId, // existing creative to render video for
    html, css, config, promptText, format, theme,
    // Fields for creating a new creative
    campaignLabel, sourceType, sourceId, eventType, destinationUrl, videoTheme
  } = req.body;

  if (!html) return res.status(400).json({ error: 'html is required' });
  if (!format) return res.status(400).json({ error: 'format is required' });
  if (!promptText) return res.status(400).json({ error: 'promptText is required' });

  let targetCreativeId = creativeId;

  // If no creativeId provided, create a new ad_creative record
  if (!targetCreativeId && sourceType && sourceId) {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let newId = 'fb-';
    for (let i = 0; i < 8; i++) newId += chars[Math.floor(Math.random() * chars.length)];

    const now = new Date();
    const campaign = `ryvite_${eventType || 'general'}_${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const baseUrl = destinationUrl || 'https://ryvite.com/lp/';
    const sep = baseUrl.includes('?') ? '&' : '?';
    const utmUrl = `${baseUrl}${sep}utm_source=facebook&utm_medium=paid&utm_campaign=${encodeURIComponent(campaign)}&utm_content=${encodeURIComponent(sourceId)}`;

    const { data: creative, error: createErr } = await supabaseAdmin
      .from('ad_creatives')
      .insert({
        creative_id: newId,
        campaign_name: campaign,
        campaign_label: campaignLabel || null,
        source_type: sourceType,
        source_id: sourceId,
        event_type: eventType || null,
        format,
        video_theme: videoTheme || theme || 'dark_gradient',
        prompt_text: promptText,
        utm_url: utmUrl,
        invite_html: html,
        invite_css: css,
        invite_config: config,
        created_by: user.id,
        video_status: 'rendering',
        video_started_at: new Date().toISOString(),
      })
      .select('creative_id')
      .single();

    if (createErr) {
      return res.status(500).json({ error: 'Failed to create creative: ' + createErr.message });
    }
    targetCreativeId = creative.creative_id;
  } else if (targetCreativeId) {
    // Update existing creative to rendering status
    await supabaseAdmin
      .from('ad_creatives')
      .update({ video_status: 'rendering', video_started_at: new Date().toISOString(), video_error: null })
      .eq('creative_id', targetCreativeId);
  }

  // Return the creative ID immediately — client can poll for status
  res.status(200).json({
    success: true,
    creativeId: targetCreativeId,
    status: 'rendering',
    message: 'Video rendering started. Check ad_creatives for status updates.',
  });

  // ── Background rendering (continues after response is sent) ──
  let browser = null;
  try {
    chromium.setGraphicsMode = false;
    const executablePath = await chromium.executablePath();
    browser = await puppeteer.launch({
      args: [...chromium.args, '--autoplay-policy=no-user-gesture-required'],
      defaultViewport: { width: 1440, height: 1080 },
      executablePath,
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    // Build and load the animation page
    const pageHtml = buildAnimationPage({ html, css, config, promptText, format, theme });
    await page.setContent(pageHtml, { waitUntil: 'networkidle0', timeout: 30000 });

    // Wait for fonts
    await page.evaluate(() => document.fonts && document.fonts.ready);

    // Poll for completion (check every 2 seconds, max 4 minutes)
    const maxWait = 240000;
    const pollInterval = 2000;
    let waited = 0;

    while (waited < maxWait) {
      await new Promise(r => setTimeout(r, pollInterval));
      waited += pollInterval;

      const status = await page.evaluate(() => ({
        done: window.__VIDEO_DONE,
        error: window.__VIDEO_ERROR,
        progress: window.__VIDEO_PROGRESS,
      }));

      if (status.done) {
        if (status.error) {
          throw new Error(status.error);
        }

        // Get the video data
        const videoBase64 = await page.evaluate(() => window.__VIDEO_BASE64);
        if (!videoBase64) throw new Error('No video data produced');

        // Parse data URL → buffer
        const matches = videoBase64.match(/^data:([^;]+);base64,(.+)$/);
        if (!matches) throw new Error('Invalid video data format');

        const mimeType = matches[1];
        const buffer = Buffer.from(matches[2], 'base64');
        const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
        const storagePath = `${targetCreativeId}/${format}.${ext}`;

        // Upload to Supabase Storage
        const { error: uploadErr } = await supabaseAdmin.storage
          .from('ad-videos')
          .upload(storagePath, buffer, {
            contentType: mimeType,
            upsert: true,
          });

        if (uploadErr) throw new Error('Upload failed: ' + uploadErr.message);

        // Get public URL
        const { data: urlData } = supabaseAdmin.storage.from('ad-videos').getPublicUrl(storagePath);
        const videoUrl = urlData?.publicUrl;

        // Update creative record
        await supabaseAdmin
          .from('ad_creatives')
          .update({
            video_status: 'ready',
            video_url: videoUrl,
            video_completed_at: new Date().toISOString(),
          })
          .eq('creative_id', targetCreativeId);

        break;
      }
    }

    if (waited >= maxWait) {
      throw new Error('Render timed out after 4 minutes');
    }

  } catch (err) {
    console.error('[render-ad-video] Error:', err.message);
    // Update creative with error status
    await supabaseAdmin
      .from('ad_creatives')
      .update({
        video_status: 'failed',
        video_error: err.message,
        video_completed_at: new Date().toISOString(),
      })
      .eq('creative_id', targetCreativeId)
      .catch(() => {});
  } finally {
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
  }
}
