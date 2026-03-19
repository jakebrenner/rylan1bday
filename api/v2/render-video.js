import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

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
 * Build a self-contained HTML document for the invite, matching buildSrcdoc() from create page.
 * The HTML is ready to render in a headless browser with all CSS, fonts, and content.
 */
function buildInviteHtml(html, css, config) {
  const configObj = typeof config === 'string' ? JSON.parse(config || '{}') : (config || {});

  // Font import
  let fontsImport = '';
  if (configObj.fontUrl) {
    fontsImport = `@import url("${configObj.fontUrl}");`;
  } else if (configObj.googleFontsImport) {
    fontsImport = configObj.googleFontsImport;
    if (fontsImport && !fontsImport.startsWith('@import')) {
      fontsImport = `@import url('${fontsImport}');`;
    }
  }
  const fontsStyle = fontsImport ? `<style>${fontsImport}</style>` : '';

  // Extract body attributes
  const bodyTagMatch = (html || '').match(/<body\b([^>]*)>/i);
  const bodyAttrs = bodyTagMatch ? bodyTagMatch[1].trim() : '';

  // Extract <head> <style> blocks
  let headStyles = '';
  const headMatch = (html || '').match(/<head(?:\s[^>]*)?>[\s\S]*?<\/head\s*>/i);
  if (headMatch) {
    const headStyleMatches = headMatch[0].match(/<style[^>]*>([\s\S]*?)<\/style\s*>/gi);
    if (headStyleMatches) {
      const headCss = headStyleMatches.map(s =>
        s.replace(/<style[^>]*>/gi, '').replace(/<\/style\s*>/gi, '')
      ).join('\n');
      if (headCss.trim()) headStyles = `<style>${headCss}</style>`;
    }
  }

  // Strip document wrappers from HTML
  let themeHtml = (html || '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<html\b[^>]*>/gi, '').replace(/<\/html\s*>/gi, '')
    .replace(/<head(?:\s[^>]*)?>[\s\S]*?<\/head\s*>/gi, '')
    .replace(/<body\b[^>]*>/gi, '').replace(/<\/body\s*>/gi, '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');

  // CSS: merge passed css + any embedded <style> blocks in HTML
  let embeddedCss = '';
  const styleMatches = themeHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
  if (styleMatches) {
    embeddedCss = styleMatches.map(s =>
      s.replace(/<\/?style[^>]*>/gi, '')
    ).join('\n');
    themeHtml = themeHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  }

  let allCss = (css || '') + '\n' + embeddedCss;

  // Move stray @imports to fonts block
  const strayImports = allCss.match(/@import\s+url\([^)]+\);?\s*/g);
  if (strayImports) {
    strayImports.forEach(imp => { allCss = allCss.replace(imp, ''); });
  }

  // Fallback colors from config
  const fallbackBg = configObj.backgroundColor || '#FFFAF5';
  const fallbackText = configObj.textColor || '#1A1A2E';
  const fallbackFont = configObj.fontBody || 'Inter';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<meta name="viewport" content="width=393, initial-scale=1.0">
${fontsStyle}
<style>
* { margin:0; padding:0; box-sizing:border-box; }
html, body { width: 393px; min-height: 100vh; overflow-x: hidden; }
html, body { background:${fallbackBg}; color:${fallbackText}; font-family:'${fallbackFont}',sans-serif; }
</style>
${headStyles}
<style>${allCss}</style>
</head><body${bodyAttrs ? ' ' + bodyAttrs : ''}>${themeHtml}</body></html>`;
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

  const { html, css, config, format, duration } = req.body;
  if (!html) return res.status(400).json({ error: 'html is required' });

  const recordDuration = Math.min(Math.max(duration || 6, 2), 10); // 2-10 seconds
  const viewport = format === 'feed_1x1'
    ? { width: 393, height: 393, deviceScaleFactor: 2 }
    : { width: 393, height: 852, deviceScaleFactor: 2 }; // 2x for crisp rendering

  const fps = 4; // 4fps is enough for CSS animation capture
  const totalFrames = Math.ceil(recordDuration * fps);
  const frameInterval = 1000 / fps; // 250ms between frames

  // Use SSE streaming to prevent gateway timeout and send progress
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // Keepalive interval to prevent proxy timeout
  const keepalive = setInterval(() => { res.write(': keepalive\n\n'); }, 3000);

  let browser = null;
  try {
    // Send metadata
    res.write(`data: ${JSON.stringify({ type: 'meta', fps, totalFrames, duration: recordDuration })}\n\n`);

    // Build the invite HTML document
    const inviteHtml = buildInviteHtml(html, css, config);

    res.write(`data: ${JSON.stringify({ type: 'progress', message: 'Launching browser...' })}\n\n`);

    // Launch headless Chrome
    chromium.setGraphicsMode = false;
    const executablePath = await chromium.executablePath();
    browser = await puppeteer.launch({
      args: chromium.args,
      defaultViewport: viewport,
      executablePath,
      headless: chromium.headless
    });

    const page = await browser.newPage();

    res.write(`data: ${JSON.stringify({ type: 'progress', message: 'Loading invite...' })}\n\n`);

    // Load the invite
    await page.setContent(inviteHtml, { waitUntil: 'networkidle0', timeout: 30000 });

    // Wait for fonts to load and entrance animations to begin
    await page.evaluate(() => document.fonts.ready);
    await new Promise(r => setTimeout(r, 500));

    res.write(`data: ${JSON.stringify({ type: 'progress', message: 'Recording animations...' })}\n\n`);

    // Capture animation frames via sequential screenshots
    const startTime = Date.now();

    for (let i = 0; i < totalFrames; i++) {
      const screenshot = await page.screenshot({
        type: 'jpeg',
        quality: 50,
        encoding: 'base64',
        fullPage: true
      });

      // Stream each frame as it's captured
      res.write(`data: ${JSON.stringify({ type: 'frame', index: i, data: screenshot })}\n\n`);

      // Sleep until the next frame time (accounting for screenshot duration)
      if (i < totalFrames - 1) {
        const nextFrameTime = startTime + (i + 1) * frameInterval;
        const sleepMs = Math.max(0, nextFrameTime - Date.now());
        if (sleepMs > 0) {
          await new Promise(r => setTimeout(r, sleepMs));
        }
      }
    }

    await browser.close();
    browser = null;

    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);

  } catch (err) {
    console.error('[render-video] Error:', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', error: err.message })}\n\n`);
  } finally {
    clearInterval(keepalive);
    if (browser) {
      try { await browser.close(); } catch (e) {}
    }
    res.end();
  }
}
