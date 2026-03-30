/**
 * Ad Video Generator — Premium Canvas + MediaRecorder engine for Facebook ad videos
 *
 * Features:
 * - Realistic iPhone mockup matching homepage design (metallic bezel, shadow, notch, home bar)
 * - Floating sparkle particles in the background
 * - Animated gradient background with slow color shift
 * - Glowing cursor effect during typing
 * - Scale + fade invite reveal with phone glow pulse
 * - Slow scroll through full invite content
 * - Supports Reels (9:16) and Feed (1:1) simultaneously
 */

// ── Video Themes ──
// Phone bezel is always realistic dark metallic — only background/text/CTA colors change
const VIDEO_THEMES = {
  dark_gradient: {
    name: 'Dark Gradient',
    bgGradient: ['#1a0a2e', '#16213e', '#0f3460'],
    bgGradientAlt: ['#0f3460', '#1a0a2e', '#16213e'], // shifted version for animation
    textColor: '#ffffff',
    subtextColor: '#b8b8d0',
    accentColor: '#E94560',
    cursorColor: '#E94560',
    ctaBg: '#E94560',
    ctaText: '#ffffff',
    logoColor: '#ffffff',
    particleColor: 'rgba(233,69,96,0.6)',
    particleColor2: 'rgba(184,184,208,0.4)',
    glowColor: 'rgba(233,69,96,0.3)'
  },
  light_clean: {
    name: 'Light Clean',
    bgGradient: ['#f0f2f5', '#ffffff', '#e8eaf0'],
    bgGradientAlt: ['#e8eaf0', '#f0f2f5', '#ffffff'],
    textColor: '#1a1a2e',
    subtextColor: '#666680',
    accentColor: '#E94560',
    cursorColor: '#E94560',
    ctaBg: '#E94560',
    ctaText: '#ffffff',
    logoColor: '#1a1a2e',
    particleColor: 'rgba(233,69,96,0.35)',
    particleColor2: 'rgba(100,100,140,0.2)',
    glowColor: 'rgba(233,69,96,0.15)'
  },
  ryvite_brand: {
    name: 'Ryvite Brand',
    bgGradient: ['#0a0a1a', '#111133', '#1a1a3e'],
    bgGradientAlt: ['#1a1a3e', '#0a0a1a', '#111133'],
    textColor: '#ffffff',
    subtextColor: '#a8a8c0',
    accentColor: '#E94560',
    cursorColor: '#E94560',
    ctaBg: '#E94560',
    ctaText: '#ffffff',
    logoColor: '#E94560',
    particleColor: 'rgba(233,69,96,0.7)',
    particleColor2: 'rgba(168,168,192,0.4)',
    glowColor: 'rgba(233,69,96,0.4)'
  },
  warm_sunset: {
    name: 'Warm Sunset',
    bgGradient: ['#ffecd2', '#fcb69f', '#ff9a9e'],
    bgGradientAlt: ['#ff9a9e', '#ffecd2', '#fcb69f'],
    textColor: '#3d1f00',
    subtextColor: '#6b4226',
    accentColor: '#E94560',
    cursorColor: '#E94560',
    ctaBg: '#E94560',
    ctaText: '#ffffff',
    logoColor: '#3d1f00',
    particleColor: 'rgba(233,69,96,0.5)',
    particleColor2: 'rgba(255,154,158,0.4)',
    glowColor: 'rgba(233,69,96,0.2)'
  }
};

// ── Phone Design Constants (matches homepage CSS) ──
const PHONE_BEZEL_GRADIENT = ['#2a2a2e', '#1a1a1e']; // metallic dark gradient
const PHONE_BEZEL_ANGLE = 145; // degrees
const PHONE_FRAME_RADIUS = 52; // generous rounding for modern iPhone look
const PHONE_SCREEN_RADIUS = 44; // inner screen corner radius
const PHONE_BEZEL_WIDTH = 12; // visible bezel width
const PHONE_NOTCH_WIDTH_RATIO = 0.30; // dynamic island style (wider)
const PHONE_NOTCH_HEIGHT = 24;
const PHONE_NOTCH_RADIUS = 12;
const PHONE_HOME_BAR_WIDTH = 100;
const PHONE_HOME_BAR_HEIGHT = 5;
const PHONE_SHADOW_BLUR = 64;
const PHONE_SHADOW_OFFSET_Y = 24;
const PHONE_SHADOW_ALPHA = 0.35;

// ── Format Configs (Facebook-compliant: MP4/H.264, 1440px base) ──
// Both formats use centered phone layout with prompt typed on phone screen
const FORMAT_CONFIGS = {
  reels_9x16: {
    width: 1080,
    height: 1920,
    // Phone centered vertically in full frame (no top logo)
    phoneWidth: 660,
    phoneHeight: 1430,
    phoneY: 245,
    promptFontSize: 30,
    promptLineHeight: 44,
    promptLabelSize: 18,
    ctaFontSize: 36,
    particleCount: 30
  },
  feed_1x1: {
    width: 1440,
    height: 1440,
    // Phone centered vertically in full frame
    phoneWidth: 620,
    phoneHeight: 1180,
    phoneY: 130,
    promptFontSize: 28,
    promptLineHeight: 42,
    promptLabelSize: 16,
    ctaFontSize: 32,
    particleCount: 25
  }
};

// ── Animation Timing ──
const CHAR_MS = 40;
const HOOK_FADE_IN_MS = 500; // hook text fade-in during intro
const INTRO_MS = 800;        // phone slide-in
const POST_TYPE_PAUSE = 600;
const DISSOLVE_MS = 500;   // prompt card dissolve before shimmer
const SHIMMER_MS = 1200;
const REVEAL_MS = 1200;    // scale + fade reveal
const SCROLL_PX_PER_SEC = 70;  // scroll speed through invite (slower = more time to see content)
const MAX_SCROLL_MS = 8000; // cap scroll duration
const HOLD_MS = 2500;      // hold at top of invite
const END_HOLD_MS = 2000;  // hold at bottom of invite
const CTA_MS = 3500;
const FPS = 30;
const BG_CYCLE_MS = 12000; // slow background color cycle duration

/**
 * Generate sparkle particle positions (randomized once, animated per-frame)
 */
function createParticles(count, canvasW, canvasH) {
  var particles = [];
  for (var i = 0; i < count; i++) {
    particles.push({
      x: Math.random() * canvasW,
      y: Math.random() * canvasH,
      size: 1.5 + Math.random() * 3,
      speed: 0.15 + Math.random() * 0.4, // drift speed
      phase: Math.random() * Math.PI * 2, // twinkle phase offset
      twinkleSpeed: 1.5 + Math.random() * 3, // how fast it twinkles
      drift: (Math.random() - 0.5) * 0.3, // horizontal drift
      type: Math.random() > 0.6 ? 'star' : 'dot' // some are star-shaped
    });
  }
  return particles;
}

/**
 * Main entry: generate an ad video and return a Blob
 * @param {Object} opts
 * @param {boolean} opts.liveAnimation - If true, records actual CSS animations via server-side Puppeteer
 * @param {Function} opts.authFetch - Required for liveAnimation: authenticated fetch function
 */
async function generateAdVideo({ html, css, config, promptText, hookText, format, theme, onProgress, liveAnimation, authFetch }) {
  onProgress = onProgress || function() {};
  const fmt = FORMAT_CONFIGS[format] || FORMAT_CONFIGS.reels_9x16;
  const thm = VIDEO_THEMES[theme] || VIDEO_THEMES.dark_gradient;

  onProgress(0, 'Preparing invite...');

  var inviteSource;

  if (liveAnimation && authFetch) {
    // Server-side: record actual CSS animations via Puppeteer
    // Smooth progress animation during server wait (advances 2→18% over ~40s)
    var serverDone = false;
    var fakeProgress = 2;
    var progressMessages = [
      'Launching browser...',
      'Loading invite...',
      'Recording animations...',
      'Capturing frames...',
      'Processing...'
    ];
    var progressInterval = setInterval(function() {
      if (serverDone) return;
      fakeProgress += (18 - fakeProgress) * 0.06; // asymptotic approach to 18%
      var msgIdx = Math.min(Math.floor((fakeProgress - 2) / 3.2), progressMessages.length - 1);
      onProgress(Math.round(fakeProgress), progressMessages[msgIdx]);
    }, 800);
    onProgress(2, 'Launching browser...');

    try {
      inviteSource = await renderInviteVideo(html, css, config, format, authFetch, function(pct) {
        // Frame loading progress: 18% → 20%
        onProgress(18 + pct * 0.02, 'Loading frames...');
      });
    } finally {
      serverDone = true;
      clearInterval(progressInterval);
    }
    onProgress(20, 'Compositing ad video...');
  } else {
    // Client-side: static screenshot via html2canvas (original fast path)
    const inviteImg = await renderInviteToImage(html, css, config, 393);
    inviteSource = inviteImg;
    onProgress(20, 'Starting animation...');
  }

  const blob = await animateAndRecord(inviteSource, promptText, hookText, fmt, thm, onProgress);
  onProgress(100, 'Done!');
  return blob;
}

/**
 * Record actual CSS animations via server-side Puppeteer.
 * Returns a frame player object that animateAndRecord can draw from.
 * The server streams frames via SSE as they're captured.
 */
async function renderInviteVideo(html, css, config, format, authFetch, onProgress) {
  onProgress = onProgress || function() {};

  // Call the render-video API (returns SSE stream)
  var res = await authFetch('/api/v2/render-video', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      html: html,
      css: css,
      config: config,
      format: format,
      duration: 10
    })
  });

  // Parse the full SSE response (using res.text() for Safari compatibility)
  var text = await res.text();
  var lines = text.split('\n');
  var frames = [];
  var fps = 4;
  var totalFrames = 24;
  var error = null;

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line.startsWith('data: ')) continue;
    try {
      var evt = JSON.parse(line.substring(6));
      if (evt.type === 'meta') {
        fps = evt.fps || 4;
        totalFrames = evt.totalFrames || 24;
      } else if (evt.type === 'frame') {
        frames.push(evt.data);
      } else if (evt.type === 'error') {
        error = evt.error;
      }
    } catch(e) { /* skip unparseable lines */ }
  }

  if (error) throw new Error('Video recording failed: ' + error);
  if (!frames.length) throw new Error('Video recording failed: no frames captured');

  onProgress(50);

  // Load all frames as Image objects
  var images = [];
  for (var j = 0; j < frames.length; j++) {
    var img = new Image();
    img.src = 'data:image/jpeg;base64,' + frames[j];
    await new Promise(function(resolve, reject) {
      img.onload = resolve;
      img.onerror = function() { reject(new Error('Failed to load frame ' + j)); };
    });
    images.push(img);
    onProgress(50 + (j / frames.length) * 50);
  }

  // Create a frame player with cross-fade blending between frames for smooth playback
  var blendCanvas = document.createElement('canvas');
  blendCanvas.width = images[0].naturalWidth;
  blendCanvas.height = images[0].naturalHeight;
  var blendCtx = blendCanvas.getContext('2d');

  var framePlayer = {
    _isVideoSource: true,
    _frames: images,
    _fps: fps,
    _startTime: null,
    _blendCanvas: blendCanvas,
    _blendCtx: blendCtx,
    videoWidth: images[0].naturalWidth,
    videoHeight: images[0].naturalHeight,
    // Get the current frame with cross-fade blending between adjacent frames
    getCurrentFrame: function() {
      if (!this._startTime) this._startTime = Date.now();
      var elapsed = Date.now() - this._startTime;
      var exactFrame = (elapsed / 1000) * this._fps;
      var totalFrames = this._frames.length;
      // Clamp to last frame instead of looping — prevents invite from reloading
      var frameA = Math.min(Math.floor(exactFrame), totalFrames - 1);
      var frameB = Math.min(frameA + 1, totalFrames - 1);
      var blend = exactFrame - Math.floor(exactFrame); // 0-1 between frames

      // If blend is very close to 0 or 1, skip blending for performance
      if (blend < 0.05) return this._frames[frameA];
      if (blend > 0.95) return this._frames[frameB];

      // Cross-fade: draw frame A, then overlay frame B with alpha
      this._blendCtx.globalAlpha = 1;
      this._blendCtx.drawImage(this._frames[frameA], 0, 0);
      this._blendCtx.globalAlpha = blend;
      this._blendCtx.drawImage(this._frames[frameB], 0, 0);
      this._blendCtx.globalAlpha = 1;
      return this._blendCanvas;
    }
  };

  return framePlayer;
}

/**
 * Render HTML invite into a full-height image using html2canvas.
 */
/**
 * Remap body/html CSS selectors to a target selector.
 * Theme CSS uses `body { background: ... }` which won't match inside a div.
 */
function remapBodySelectors(cssText, targetSel) {
  return (cssText || '')
    .replace(/\bhtml\s*,\s*body\s*\{/g, targetSel + ' {')
    .replace(/\bbody\s*,\s*html\s*\{/g, targetSel + ' {')
    .replace(/\bbody\s*\{/g, targetSel + ' {')
    .replace(/\bhtml\s*\{/g, targetSel + ' {');
}

/**
 * Render HTML invite into a full-height image using html2canvas.
 * Matches the rendering context of buildSrcdoc / buildTestSrcdoc:
 * - 393px design width, reset CSS, proper font loading
 * - Extracts embedded <style> from HTML, strips document wrappers
 * - Jumps animations to end state (not disabled — preserves final opacity/transform)
 */
async function renderInviteToImage(html, css, config, targetWidth) {
  var DESIGN_WIDTH = 393; // All invites are designed for this width
  var renderWidth = targetWidth || DESIGN_WIDTH;

  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;left:-9999px;top:0;width:' + renderWidth + 'px;overflow:hidden;z-index:-1;';
  document.body.appendChild(container);

  var configObj = config;
  if (typeof config === 'string') {
    try { configObj = JSON.parse(config); } catch(e) { configObj = {}; }
  }
  configObj = configObj || {};

  // ── Fonts (must be in first <style> block or @import silently fails) ──
  var fontsImport = '';
  if (configObj.fontUrl) {
    fontsImport = '@import url("' + configObj.fontUrl + '");';
  } else if (configObj.googleFontsImport) {
    fontsImport = configObj.googleFontsImport;
    if (fontsImport && !fontsImport.startsWith('@import')) {
      fontsImport = "@import url('" + fontsImport + "');";
    }
  }

  // ── Prepare HTML: extract embedded <style> tags, strip document wrappers ──
  var themeHtml = (html || '');
  var embeddedCss = '';

  // Extract embedded <style> blocks from HTML (matching buildSrcdoc pattern)
  var styleMatches = themeHtml.match(/<style[^>]*>([\s\S]*?)<\/style>/gi);
  if (styleMatches) {
    embeddedCss = styleMatches.map(function(s) {
      return s.replace(/<\/?style[^>]*>/gi, '');
    }).join('\n');
    themeHtml = themeHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  }

  // Strip full HTML document wrappers if present
  if (themeHtml.match(/^<!DOCTYPE/i) || themeHtml.match(/^<html/i)) {
    var bodyMatch = themeHtml.match(/<body[^>]*>([\s\S]*)<\/body>/i);
    if (bodyMatch) themeHtml = bodyMatch[1].trim();
    themeHtml = themeHtml
      .replace(/<!DOCTYPE[^>]*>/gi, '')
      .replace(/<html\b[^>]*>/gi, '').replace(/<\/html\s*>/gi, '')
      .replace(/<head(?:\s[^>]*)?>[\s\S]*?<\/head\s*>/gi, '')
      .replace(/<body\b[^>]*>/gi, '').replace(/<\/body\s*>/gi, '');
  }

  // Strip scripts
  themeHtml = themeHtml.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');

  // ── Merge and remap all CSS ──
  var allCss = (css || '') + '\n' + embeddedCss;
  var sel = '#__adgen_invite';
  var adjustedCss = remapBodySelectors(allCss, sel);

  // ── Reset CSS (matching buildSrcdoc) ──
  var resetCss = '* { margin:0; padding:0; box-sizing:border-box; } '
    + sel + ' { width:' + renderWidth + 'px; min-height:100%; overflow-x:hidden; }';

  // ── Let entrance animations complete naturally, then capture ──
  // We wait 2.5s before capturing, which is enough for most entrance animations
  // (fade-in, slide-up, etc.) to complete. animation-fill-mode:forwards ensures
  // elements stay at their final animated state (opacity:1, translateY:0, etc.)
  // We only disable transitions to prevent flash-of-unstyled-content issues.
  var h2cFixes = '*, *::before, *::after { '
    + 'animation-fill-mode: forwards !important; '
    + 'transition: none !important; '
    + '} '
    // Ensure infinite ambient animations (floating, pulsing) are paused at a nice frame
    + '@media (prefers-reduced-motion: no-preference) { '
    + '[class*="float"], [class*="pulse"], [class*="bounce"], [class*="shimmer"], '
    + '[class*="sparkle"], [class*="glow"], [class*="wave"], [class*="drift"] { '
    + 'animation-play-state: running !important; '
    + '} } ';

  // ── Build container HTML ──
  container.innerHTML = '<div id="__adgen_invite" style="width:' + renderWidth + 'px;overflow:hidden;">'
    + '<style>' + fontsImport + '</style>'
    + '<style>' + resetCss + '</style>'
    + '<style>' + adjustedCss + '</style>'
    + '<style>' + h2cFixes + '</style>'
    + '<style>.rsvp-slot,.details-slot{display:none !important}</style>'
    + themeHtml
    + '</div>';

  // ── Wait for fonts and rendering ──
  await new Promise(function(resolve) { setTimeout(resolve, 2000); });
  if (document.fonts && document.fonts.ready) {
    await document.fonts.ready;
  }
  await new Promise(function(resolve) { setTimeout(resolve, 500); });

  const inviteEl = container.querySelector('#__adgen_invite');
  const naturalHeight = inviteEl.scrollHeight;
  const canvas = await html2canvas(inviteEl, {
    width: renderWidth,
    height: naturalHeight,
    scale: 2,
    useCORS: true,
    allowTaint: true,
    backgroundColor: null,
    logging: false
  });

  document.body.removeChild(container);

  return new Promise(function(resolve) {
    const img = new Image();
    img.onload = function() { resolve(img); };
    img.src = canvas.toDataURL('image/png');
  });
}

/**
 * Draw a premium iPhone-style phone frame on canvas
 * Matches the homepage CSS: metallic gradient bezel, drop shadow, rim light, notch, home bar
 */
function drawPhoneFrame(ctx, phoneX, phoneY, phoneW, phoneH, elapsed) {
  const bw = PHONE_BEZEL_WIDTH;
  const fr = PHONE_FRAME_RADIUS;
  const sr = PHONE_SCREEN_RADIUS;

  // ── Drop shadow ──
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,' + PHONE_SHADOW_ALPHA + ')';
  ctx.shadowBlur = PHONE_SHADOW_BLUR;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = PHONE_SHADOW_OFFSET_Y;
  roundRect(ctx, phoneX, phoneY, phoneW, phoneH, fr);
  ctx.fillStyle = '#1a1a1e';
  ctx.fill();
  ctx.restore();

  // ── Metallic bezel gradient (145deg angle) ──
  // Convert 145deg to canvas gradient coords
  const rad = (PHONE_BEZEL_ANGLE * Math.PI) / 180;
  const cx = phoneX + phoneW / 2;
  const cy = phoneY + phoneH / 2;
  const halfDiag = Math.sqrt(phoneW * phoneW + phoneH * phoneH) / 2;
  const gx1 = cx - Math.cos(rad) * halfDiag;
  const gy1 = cy - Math.sin(rad) * halfDiag;
  const gx2 = cx + Math.cos(rad) * halfDiag;
  const gy2 = cy + Math.sin(rad) * halfDiag;

  ctx.save();
  roundRect(ctx, phoneX, phoneY, phoneW, phoneH, fr);
  const bezelGrad = ctx.createLinearGradient(gx1, gy1, gx2, gy2);
  bezelGrad.addColorStop(0, PHONE_BEZEL_GRADIENT[0]);
  bezelGrad.addColorStop(1, PHONE_BEZEL_GRADIENT[1]);
  ctx.fillStyle = bezelGrad;
  ctx.fill();

  // ── Inset rim highlight (1px white border) ──
  roundRect(ctx, phoneX + 0.5, phoneY + 0.5, phoneW - 1, phoneH - 1, fr);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // ── Subtle edge highlight on top-left (light reflection) ──
  const reflGrad = ctx.createLinearGradient(phoneX, phoneY, phoneX + phoneW * 0.3, phoneY + phoneH * 0.2);
  reflGrad.addColorStop(0, 'rgba(255,255,255,0.06)');
  reflGrad.addColorStop(1, 'rgba(255,255,255,0)');
  roundRect(ctx, phoneX, phoneY, phoneW, phoneH, fr);
  ctx.fillStyle = reflGrad;
  ctx.fill();
  ctx.restore();

  // ── Screen area ──
  const screenX = phoneX + bw;
  const screenY = phoneY + bw;
  const screenW = phoneW - bw * 2;
  const screenH = phoneH - bw * 2 - 12; // leave room for home bar area

  // Screen background — visible before invite loads (during shimmer/empty phases)
  // Use white so the invite reveal doesn't show a dark tint underneath
  ctx.save();
  roundRect(ctx, screenX, screenY, screenW, screenH, sr);
  ctx.fillStyle = '#f5f5f5';
  ctx.fill();
  ctx.restore();

  // ── Dynamic Island (pill shape centered at top of screen) ──
  const notchW = Math.round(phoneW * PHONE_NOTCH_WIDTH_RATIO);
  const notchH = PHONE_NOTCH_HEIGHT;
  const notchX = phoneX + (phoneW - notchW) / 2;
  const notchY = phoneY + bw + 6;

  ctx.save();
  roundRect(ctx, notchX, notchY, notchW, notchH, notchH / 2); // pill shape
  ctx.fillStyle = '#000000';
  ctx.fill();
  ctx.restore();

  // ── Home bar indicator at bottom ──
  const homeBarY = phoneY + phoneH - bw - 8;
  const homeBarX = phoneX + (phoneW - PHONE_HOME_BAR_WIDTH) / 2;

  ctx.save();
  roundRect(ctx, homeBarX, homeBarY, PHONE_HOME_BAR_WIDTH, PHONE_HOME_BAR_HEIGHT, 2);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  ctx.fill();
  ctx.restore();

  // Return screen content area coordinates
  return {
    x: screenX,
    y: screenY + notchH + 2, // below notch
    w: screenW,
    h: screenH - notchH - 4, // minus notch and bottom margin
    screenX: screenX,
    screenY: screenY,
    screenW: screenW,
    screenH: screenH,
    screenRadius: sr
  };
}

/**
 * Draw floating sparkle particles
 */
function drawParticles(ctx, particles, elapsed, thm) {
  particles.forEach(function(p) {
    var twinkle = 0.3 + 0.7 * Math.abs(Math.sin((elapsed / 1000) * p.twinkleSpeed + p.phase));
    var y = (p.y - (elapsed / 1000) * p.speed * 30) % (ctx.canvas.height + 40);
    if (y < -20) y += ctx.canvas.height + 40;
    var x = p.x + Math.sin((elapsed / 1000) * 0.5 + p.phase) * 20 * p.drift;

    ctx.save();
    ctx.globalAlpha = twinkle * 0.7;

    if (p.type === 'star') {
      // Draw a 4-point star sparkle
      drawStar(ctx, x, y, p.size * 1.5, p.size * 0.4, 4);
      ctx.fillStyle = thm.particleColor;
      ctx.fill();
    } else {
      // Simple glowing dot
      ctx.beginPath();
      ctx.arc(x, y, p.size, 0, Math.PI * 2);
      ctx.fillStyle = thm.particleColor2;
      ctx.fill();
    }
    ctx.restore();
  });
}

/**
 * Draw a multi-pointed star shape
 */
function drawStar(ctx, cx, cy, outerR, innerR, points) {
  ctx.beginPath();
  for (var i = 0; i < points * 2; i++) {
    var angle = (i * Math.PI) / points - Math.PI / 2;
    var r = i % 2 === 0 ? outerR : innerR;
    var x = cx + Math.cos(angle) * r;
    var y = cy + Math.sin(angle) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/**
 * Draw animated gradient background with slow color shifting
 */
function drawAnimatedBackground(ctx, w, h, elapsed, thm) {
  var cycle = (elapsed % BG_CYCLE_MS) / BG_CYCLE_MS;
  var blend = (Math.sin(cycle * Math.PI * 2) + 1) / 2; // 0-1 smooth oscillation

  var bgGrad = ctx.createLinearGradient(0, 0, 0, h);
  for (var i = 0; i < thm.bgGradient.length; i++) {
    var stop = i / (thm.bgGradient.length - 1);
    var c1 = hexToRgb(thm.bgGradient[i]);
    var c2 = hexToRgb(thm.bgGradientAlt[i]);
    var r = Math.round(c1.r + (c2.r - c1.r) * blend);
    var g = Math.round(c1.g + (c2.g - c1.g) * blend);
    var b = Math.round(c1.b + (c2.b - c1.b) * blend);
    bgGrad.addColorStop(stop, 'rgb(' + r + ',' + g + ',' + b + ')');
  }
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, w, h);
}

/**
 * Run the animation on canvas and record to WebM/MP4.
 * New flow: Centered phone → prompt typed on phone screen → dissolve → shimmer → invite reveal + scroll → CTA
 */
function animateAndRecord(inviteSource, promptText, hookText, fmt, thm, onProgress) {
  return new Promise(function(resolve, reject) {
    const canvas = document.createElement('canvas');
    canvas.width = fmt.width;
    canvas.height = fmt.height;
    const ctx = canvas.getContext('2d');

    const isVideo = !!(inviteSource && inviteSource._isVideoSource);

    // Phone screen dimensions (inside bezel)
    const screenW = fmt.phoneWidth - (PHONE_BEZEL_WIDTH * 2);
    const screenContentH = fmt.phoneHeight - (PHONE_BEZEL_WIDTH * 2) - 12 - PHONE_NOTCH_HEIGHT - 4;

    // Invite draw dimensions — scale invite to fill phone screen width
    const inviteNaturalW = isVideo ? inviteSource.videoWidth : inviteSource.naturalWidth;
    const inviteNaturalH = isVideo ? inviteSource.videoHeight : inviteSource.naturalHeight;
    const inviteDrawHeight = (inviteNaturalH / inviteNaturalW) * screenW;
    // Both video and static sources scroll through the full invite
    const scrollDistance = Math.max(0, inviteDrawHeight - screenContentH);
    const rawScrollMs = scrollDistance > 0 ? (scrollDistance / SCROLL_PX_PER_SEC) * 1000 : 0;
    const scrollMs = Math.min(rawScrollMs, MAX_SCROLL_MS);
    const effectiveScrollSpeed = scrollMs > 0 ? scrollDistance / (scrollMs / 1000) : SCROLL_PX_PER_SEC;

    // Timeline
    const hasHook = !!(hookText && hookText.trim());
    const hookTotalMs = 0; // hook is now part of intro phase, not a separate phase
    const typingMs = promptText.length * CHAR_MS;
    const displayMs = HOLD_MS + (scrollMs || HOLD_MS) + END_HOLD_MS;
    const totalMs = hookTotalMs + INTRO_MS + typingMs + POST_TYPE_PAUSE + DISSOLVE_MS + SHIMMER_MS + REVEAL_MS + displayMs + CTA_MS;

    // Create particles
    const particles = createParticles(fmt.particleCount || 30, fmt.width, fmt.height);

    // Phone position (always centered)
    const phoneX = (fmt.width - fmt.phoneWidth) / 2;
    const phoneBaseY = fmt.phoneY;

    // MediaRecorder — prefer MP4/H.264, fall back to WebM
    const stream = canvas.captureStream(FPS);
    const mp4Types = ['video/mp4;codecs=avc1', 'video/mp4;codecs=avc1.42E01E', 'video/mp4'];
    const webmTypes = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    let chosenMime = '';
    for (const t of mp4Types.concat(webmTypes)) {
      if (MediaRecorder.isTypeSupported(t)) { chosenMime = t; break; }
    }
    if (!chosenMime) chosenMime = 'video/webm';
    const isMP4 = chosenMime.startsWith('video/mp4');
    const blobType = isMP4 ? 'video/mp4' : 'video/webm';
    const recorder = new MediaRecorder(stream, {
      mimeType: chosenMime,
      videoBitsPerSecond: 16000000
    });
    const chunks = [];

    recorder.ondataavailable = function(e) { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = function() { resolve(new Blob(chunks, { type: blobType })); };
    recorder.onerror = function(e) { reject(new Error('MediaRecorder error: ' + (e.error || e.message || 'unknown'))); };

    let startTime = null;
    let animId = null;

    recorder.start(1000);

    function drawFrame(rafTimestamp) {
      if (!startTime) startTime = performance.now();
      const elapsed = performance.now() - startTime;

      ctx.clearRect(0, 0, fmt.width, fmt.height);

      // ── Background + particles ──
      drawAnimatedBackground(ctx, fmt.width, fmt.height, elapsed, thm);
      drawParticles(ctx, particles, elapsed, thm);

      // ── Phase boundaries (intro → type → pause → dissolve → shimmer → reveal → hold → scroll → endHold → CTA) ──
      const hookEnd = hookTotalMs;
      const introEnd = hookEnd + INTRO_MS;
      const typeEnd = introEnd + typingMs;
      const pauseEnd = typeEnd + POST_TYPE_PAUSE;
      const dissolveEnd = pauseEnd + DISSOLVE_MS;
      const shimmerEnd = dissolveEnd + SHIMMER_MS;
      const revealEnd = shimmerEnd + REVEAL_MS;
      const holdEnd = revealEnd + HOLD_MS;
      const scrollEnd = holdEnd + (scrollMs || HOLD_MS);
      const endHoldEnd = scrollEnd + END_HOLD_MS;

      // ── Intro animation (phone slides up) ──
      var introElapsed = Math.max(0, elapsed - hookEnd);
      const introProgress = Math.min(1, introElapsed / INTRO_MS);
      const introEased = easeOutCubic(introProgress);
      const phoneSlideY = phoneBaseY + (1 - introEased) * 80;

      // ── Phone glow (during/after reveal) ──
      if (elapsed >= shimmerEnd) {
        var glowIntensity = 0;
        if (elapsed < revealEnd) {
          glowIntensity = easeOutCubic((elapsed - shimmerEnd) / REVEAL_MS) * 0.6;
        } else {
          glowIntensity = 0.15 + 0.1 * Math.sin(elapsed / 2000 * Math.PI);
        }
        ctx.save();
        ctx.shadowColor = thm.accentColor;
        ctx.shadowBlur = 60;
        ctx.globalAlpha = glowIntensity;
        roundRect(ctx, phoneX + 4, phoneSlideY + 4, fmt.phoneWidth - 8, fmt.phoneHeight - 8, PHONE_FRAME_RADIUS - 2);
        ctx.fillStyle = thm.accentColor;
        ctx.fill();
        ctx.restore();
      }

      // ── Phone frame (always drawn) ──
      var screen = drawPhoneFrame(ctx, phoneX, phoneSlideY, fmt.phoneWidth, fmt.phoneHeight, elapsed);

      // ── Phone screen content ──
      if (elapsed < dissolveEnd) {
        // ═══ PROMPT CARD ON PHONE SCREEN ═══
        var promptAlpha = 1;
        if (elapsed >= pauseEnd) {
          // Dissolving out
          promptAlpha = 1 - easeOutCubic((elapsed - pauseEnd) / DISSOLVE_MS);
        } else if (elapsed < introEnd) {
          // Fading in with phone
          promptAlpha = introEased;
        }

        if (promptAlpha > 0.01) {
          ctx.save();
          roundRect(ctx, screen.screenX, screen.screenY, screen.screenW, screen.screenH, screen.screenRadius);
          ctx.clip();
          ctx.globalAlpha = promptAlpha;

          // Subtle app-like background on phone screen
          var appBg = ctx.createLinearGradient(screen.x, screen.y, screen.x, screen.y + screen.h);
          appBg.addColorStop(0, '#f8f8fa');
          appBg.addColorStop(1, '#eeeef2');
          ctx.fillStyle = appBg;
          ctx.fillRect(screen.screenX, screen.screenY, screen.screenW, screen.screenH);

          // ── Hook text at top of phone screen (when present) ──
          var hookTextBottomY = screen.y;
          if (hasHook) {
            var hookFadeIn = Math.min(1, elapsed / HOOK_FADE_IN_MS);
            var hookFontSize = Math.round(fmt.promptFontSize * 1.35);
            ctx.save();
            ctx.globalAlpha = promptAlpha * hookFadeIn;
            ctx.font = '700 ' + hookFontSize + 'px "Inter", Arial, sans-serif';
            ctx.fillStyle = '#1a1a2e';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';

            var hookLines = wrapText(ctx, hookText.trim(), screen.w * 0.78);
            var hookLineH = hookFontSize * 1.35;
            var hookStartY = screen.y + 36; // top padding inside screen
            hookLines.forEach(function(line, i) {
              ctx.fillText(line, screen.x + screen.w / 2, hookStartY + i * hookLineH);
            });
            ctx.restore();

            hookTextBottomY = hookStartY + hookLines.length * hookLineH + 24; // gap below hook text
          }

          // Prompt card dimensions
          var cardPadSide = 24;
          var cardX = screen.x + cardPadSide;
          var cardW = screen.w - cardPadSide * 2;
          var cardPadTop = 50;
          var cardPadBottom = 30;
          var cardRadius = 18;

          // Measure full text to size the card
          ctx.font = fmt.promptFontSize + 'px "Inter", "Helvetica Neue", Arial, sans-serif';
          var allLines = wrapText(ctx, promptText, cardW - 40);
          var textBlockH = allLines.length * fmt.promptLineHeight;
          var cardH = cardPadTop + textBlockH + cardPadBottom;

          // Position card: below hook text if present, otherwise centered
          var cardY;
          if (hasHook) {
            cardY = hookTextBottomY + 10;
          } else {
            cardY = screen.y + (screen.h - cardH) / 2 - 20;
          }

          // White card with shadow
          ctx.shadowColor = 'rgba(0,0,0,0.1)';
          ctx.shadowBlur = 16;
          ctx.shadowOffsetY = 4;
          roundRect(ctx, cardX, cardY, cardW, cardH, cardRadius);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.shadowColor = 'transparent';

          // Subtle border
          roundRect(ctx, cardX, cardY, cardW, cardH, cardRadius);
          ctx.strokeStyle = 'rgba(0,0,0,0.06)';
          ctx.lineWidth = 1;
          ctx.stroke();

          // "YOUR PROMPT" label
          ctx.font = '700 ' + (fmt.promptLabelSize || 20) + 'px "Inter", sans-serif';
          ctx.fillStyle = '#E94560';
          ctx.textAlign = 'center';
          ctx.fillText('YOUR PROMPT', cardX + cardW / 2, cardY + 32);

          // Typed text
          var typeElapsed = Math.max(0, elapsed - introEnd);
          var charCount = Math.min(promptText.length, Math.floor(typeElapsed / CHAR_MS));
          var displayText = promptText.substring(0, charCount);

          if (displayText.length > 0) {
            ctx.font = fmt.promptFontSize + 'px "Inter", "Helvetica Neue", Arial, sans-serif';
            ctx.fillStyle = '#1a1a2e';
            ctx.textAlign = 'center';

            var lines = wrapText(ctx, displayText, cardW - 40);
            var textStartY = cardY + cardPadTop + 10;
            lines.forEach(function(line, i) {
              ctx.fillText(line, cardX + cardW / 2, textStartY + i * fmt.promptLineHeight);
            });

            // Blinking cursor
            var cursorBlink = Math.sin(elapsed / 400 * Math.PI) > 0;
            if (charCount < promptText.length || (elapsed < pauseEnd && cursorBlink)) {
              var lastLine = lines[lines.length - 1] || '';
              var lastLineW = ctx.measureText(lastLine).width;
              var cursorX = cardX + cardW / 2 + lastLineW / 2 + 4;
              var cursorY = textStartY + (lines.length - 1) * fmt.promptLineHeight;
              ctx.fillStyle = '#E94560';
              ctx.fillRect(cursorX, cursorY - fmt.promptFontSize + 6, 2, fmt.promptFontSize - 4);
            }
          }

          ctx.restore();
        }
      } else if (elapsed < shimmerEnd) {
        // ═══ SHIMMER / AI GENERATION EFFECT ═══
        ctx.save();
        roundRect(ctx, screen.screenX, screen.screenY, screen.screenW, screen.screenH, screen.screenRadius);
        ctx.clip();
        var shimmerProgress = (elapsed - dissolveEnd) / SHIMMER_MS;
        drawShimmer(ctx, screen.x, screen.y, screen.w, screen.h, shimmerProgress, thm);
        ctx.restore();
      } else {
        // ═══ INVITE REVEAL + SCROLL ═══
        var revealProgress = Math.min(1, (elapsed - shimmerEnd) / REVEAL_MS);
        var eased = easeOutCubic(revealProgress);

        // Scroll offset (works for both video and static sources)
        var scrollOffset = 0;
        if (elapsed >= holdEnd && scrollDistance > 0) {
          if (elapsed < scrollEnd) {
            scrollOffset = easeInOutCubic((elapsed - holdEnd) / (scrollMs || 1)) * scrollDistance;
          } else {
            scrollOffset = scrollDistance;
          }
        }

        // Scale from 0.92 → 1.0 during reveal
        var scale = 0.92 + eased * 0.08;
        var revealAlpha = eased;

        ctx.save();
        roundRect(ctx, screen.screenX, screen.screenY, screen.screenW, screen.screenH, screen.screenRadius);
        ctx.clip();
        ctx.globalAlpha = revealAlpha;

        // Scale from center of screen
        var scaleCenterX = screen.x + screen.w / 2;
        var scaleCenterY = screen.y + screen.h / 2;
        ctx.translate(scaleCenterX, scaleCenterY);
        ctx.scale(scale, scale);
        ctx.translate(-scaleCenterX, -scaleCenterY);

        // Draw invite (video frame or static image)
        var drawSource = inviteSource.getCurrentFrame ? inviteSource.getCurrentFrame() : inviteSource;
        ctx.drawImage(drawSource, screen.x, screen.y - scrollOffset, screen.w, inviteDrawHeight);
        ctx.restore();
      }

      // ── CTA page (slides up inside phone screen after invite) ──
      if (elapsed >= endHoldEnd) {
        var ctaProgress = Math.min(1, (elapsed - endHoldEnd) / CTA_MS);
        var ctaEased = easeOutCubic(ctaProgress);

        ctx.save();
        // Clip to phone screen
        roundRect(ctx, screen.screenX, screen.screenY, screen.screenW, screen.screenH, screen.screenRadius);
        ctx.clip();

        // White page slides up from bottom
        var slideOffset = (1 - ctaEased) * screen.screenH;
        var pageY = screen.screenY + slideOffset;

        // White background
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(screen.screenX, pageY, screen.screenW, screen.screenH);

        ctx.globalAlpha = ctaEased;
        var centerX = screen.x + screen.w / 2;
        var centerY = pageY + screen.screenH / 2;

        // ── Ryvite logo (envelope icon + wordmark) in accent red ──
        var logoSize = Math.round((fmt.ctaFontSize || 32) * 1.6);
        var logoY = centerY - 100;

        // Envelope icon circle
        var iconR = logoSize * 0.45;
        ctx.beginPath();
        ctx.arc(centerX, logoY, iconR, 0, Math.PI * 2);
        ctx.strokeStyle = thm.accentColor || '#E94560';
        ctx.lineWidth = 3;
        ctx.stroke();
        // Envelope flap
        ctx.beginPath();
        ctx.moveTo(centerX - iconR * 0.55, logoY - iconR * 0.3);
        ctx.lineTo(centerX, logoY + iconR * 0.15);
        ctx.lineTo(centerX + iconR * 0.55, logoY - iconR * 0.3);
        ctx.strokeStyle = thm.accentColor || '#E94560';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.stroke();
        // Envelope bottom
        ctx.beginPath();
        ctx.moveTo(centerX - iconR * 0.55, logoY + iconR * 0.4);
        ctx.lineTo(centerX + iconR * 0.55, logoY + iconR * 0.4);
        ctx.strokeStyle = thm.accentColor || '#E94560';
        ctx.lineWidth = 2.5;
        ctx.lineCap = 'round';
        ctx.stroke();

        // "Ryvite" wordmark
        ctx.font = '600 ' + logoSize + 'px "Playfair Display", "Georgia", serif';
        ctx.fillStyle = thm.accentColor || '#E94560';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Ryvite', centerX, logoY + iconR + logoSize * 0.7);

        // ── Tagline text ──
        var tagY = centerY + 40;
        var tagFontSize = Math.round((fmt.ctaFontSize || 32) * 0.85);

        ctx.font = 'bold ' + tagFontSize + 'px "Inter", Arial, sans-serif';
        ctx.fillStyle = '#1a1a2e';
        ctx.fillText('100% Unique AI Invitations.', centerX, tagY);
        ctx.fillText('100% Free.', centerX, tagY + tagFontSize * 1.4);

        // "Create Yours Now" CTA button
        var ctaBtnY = tagY + tagFontSize * 3.2;
        var ctaBtnW = Math.min(screen.w * 0.7, 340);
        var ctaBtnH = 52;
        var ctaBtnX = centerX - ctaBtnW / 2;

        ctx.shadowColor = 'rgba(233,69,96,0.4)';
        ctx.shadowBlur = 16;
        ctx.shadowOffsetY = 4;
        roundRect(ctx, ctaBtnX, ctaBtnY, ctaBtnW, ctaBtnH, 26);
        ctx.fillStyle = thm.accentColor || '#E94560';
        ctx.fill();
        ctx.shadowColor = 'transparent';

        ctx.font = 'bold ' + Math.round(tagFontSize * 0.85) + 'px "Inter", Arial, sans-serif';
        ctx.fillStyle = '#ffffff';
        ctx.fillText('Create Yours Now', centerX, ctaBtnY + ctaBtnH / 2);

        ctx.restore();
      }

      // ── Progress ──
      var progress = 20 + Math.min(75, (elapsed / totalMs) * 75);
      var phase = 'Processing...';
      if (elapsed < typeEnd) phase = 'Typing prompt...';
      else if (elapsed < dissolveEnd) phase = 'Transitioning...';
      else if (elapsed < shimmerEnd) phase = 'AI generating...';
      else if (elapsed < revealEnd) phase = 'Revealing invite...';
      else if (elapsed < scrollEnd && scrollDistance > 0) phase = 'Scrolling invite...';
      else if (elapsed < endHoldEnd) phase = 'Finishing...';
      else phase = 'Rendering CTA...';
      onProgress(progress, phase);

      if (elapsed < totalMs) {
        // Use requestAnimationFrame for smooth rendering when tab is visible,
        // fall back to setTimeout when tab is hidden (RAF gets throttled to ~1fps)
        if (document.hidden) {
          animId = setTimeout(drawFrame, 1000 / FPS);
        } else {
          animId = requestAnimationFrame(drawFrame);
        }
      } else {
        setTimeout(function() {
          recorder.stop();
          if (typeof animId === 'number') cancelAnimationFrame(animId);
        }, 200);
      }
    }

    animId = requestAnimationFrame(drawFrame);
  });
}

// ── Helpers ──

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function wrapText(ctx, text, maxWidth) {
  var words = text.split(' ');
  var lines = [];
  var currentLine = '';
  for (var i = 0; i < words.length; i++) {
    var testLine = currentLine ? currentLine + ' ' + words[i] : words[i];
    if (ctx.measureText(testLine).width > maxWidth && currentLine) {
      lines.push(currentLine);
      currentLine = words[i];
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}

function drawShimmer(ctx, x, y, w, h, progress, thm) {
  // Light screen background for shimmer phase
  ctx.fillStyle = '#f0f0f0';
  ctx.fillRect(x, y, w, h);

  // Animated shimmer sweep (light-on-light, subtle highlight)
  var shimmerX = x - w + progress * (w * 3);
  var grad = ctx.createLinearGradient(shimmerX, y, shimmerX + w * 0.6, y);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.8)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);

  // Animated sparkle dots orbiting in a circle
  var centerX = x + w / 2;
  var centerY = y + h * 0.4;
  var orbitR = Math.min(w, h) * 0.15;
  var numDots = 8;
  for (var i = 0; i < numDots; i++) {
    var angle = (i / numDots) * Math.PI * 2 + progress * Math.PI * 6;
    var dotX = centerX + Math.cos(angle) * orbitR;
    var dotY = centerY + Math.sin(angle) * orbitR * 0.6; // slight ellipse
    var dotAlpha = 0.3 + 0.7 * Math.abs(Math.sin(angle + progress * Math.PI * 2));
    var dotSize = 3 + 2 * Math.abs(Math.sin(angle));

    ctx.save();
    ctx.globalAlpha = dotAlpha;
    ctx.beginPath();
    ctx.arc(dotX, dotY, dotSize, 0, Math.PI * 2);
    var dotGrad = ctx.createRadialGradient(dotX, dotY, 0, dotX, dotY, dotSize * 2);
    dotGrad.addColorStop(0, 'rgba(233,69,96,0.8)');
    dotGrad.addColorStop(1, 'rgba(233,69,96,0)');
    ctx.fillStyle = dotGrad;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(dotX, dotY, dotSize * 0.6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fill();
    ctx.restore();
  }

  // Central pulsing icon (sparkle)
  ctx.save();
  var pulseScale = 0.8 + 0.2 * Math.sin(progress * Math.PI * 8);
  ctx.globalAlpha = 0.6 + 0.3 * Math.sin(progress * Math.PI * 4);
  ctx.translate(centerX, centerY);
  ctx.scale(pulseScale, pulseScale);
  drawStar(ctx, 0, 0, 16, 6, 4);
  ctx.fillStyle = 'rgba(233,69,96,0.7)';
  ctx.fill();
  drawStar(ctx, 0, 0, 10, 4, 4);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fill();
  ctx.restore();

  // "Generating..." text with bounce
  var textBounce = Math.sin(progress * Math.PI * 6) * 3;
  ctx.save();
  ctx.globalAlpha = 0.6 + 0.2 * Math.sin(progress * Math.PI * 4);
  ctx.font = '20px "Inter", Arial, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.textAlign = 'center';
  ctx.fillText('Creating your invite...', centerX, centerY + orbitR + 40 + textBounce);
  ctx.restore();

  // Animated dots after text (...)
  var dotCount = Math.floor(progress * 12) % 4;
  ctx.save();
  ctx.globalAlpha = 0.5;
  for (var d = 0; d < dotCount; d++) {
    ctx.beginPath();
    ctx.arc(centerX + 75 + d * 10, centerY + orbitR + 36 + textBounce, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.fill();
  }
  ctx.restore();
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function hexToRgb(hex) {
  var result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 0, g: 0, b: 0 };
}

function downloadBlob(blob, filename) {
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 5000);
}

// Export
window.AdVideoGenerator = {
  generate: generateAdVideo,
  renderVideo: renderInviteVideo,
  download: downloadBlob,
  themes: VIDEO_THEMES,
  formats: FORMAT_CONFIGS
};
