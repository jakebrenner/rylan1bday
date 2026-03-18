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

// ── Format Configs ──
const FORMAT_CONFIGS = {
  reels_9x16: {
    width: 1080,
    height: 1920,
    logoY: 120,
    logoSize: 48,
    promptAreaY: 230,
    promptAreaHeight: 280,
    promptFontSize: 34,
    promptMaxWidth: 900,
    promptLineHeight: 50,
    phoneY: 620,
    phoneWidth: 480,
    phoneHeight: 980,
    ctaY: 1720,
    ctaFontSize: 32,
    labelFontSize: 20,
    labelY: 185,
    particleCount: 40
  },
  feed_1x1: {
    width: 1080,
    height: 1080,
    // Side-by-side layout: prompt left, phone right
    layout: 'side_by_side',
    logoY: 60,
    logoSize: 36,
    // Prompt on left side
    promptAreaX: 40,
    promptAreaY: 170,
    promptAreaHeight: 350,
    promptFontSize: 26,
    promptMaxWidth: 470,
    promptLineHeight: 40,
    // Taller phone on right side (proper iPhone proportions ~393:852)
    phoneX: 590,
    phoneY: 60,
    phoneWidth: 400,
    phoneHeight: 870,
    ctaY: 970,
    ctaFontSize: 24,
    labelFontSize: 15,
    labelY: 105,
    particleCount: 25
  }
};

// ── Animation Timing ──
const CHAR_MS = 35;
const INTRO_MS = 800;      // longer intro for premium feel
const POST_TYPE_PAUSE = 600;
const SHIMMER_MS = 1200;
const REVEAL_MS = 1200;    // scale + fade reveal
const SCROLL_PX_PER_SEC = 40;
const MIN_HOLD_MS = 3000;
const CTA_MS = 1500;
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
 */
async function generateAdVideo({ html, css, config, promptText, format, theme, onProgress }) {
  onProgress = onProgress || function() {};
  const fmt = FORMAT_CONFIGS[format] || FORMAT_CONFIGS.reels_9x16;
  const thm = VIDEO_THEMES[theme] || VIDEO_THEMES.dark_gradient;

  onProgress(0, 'Preparing invite...');

  // Render invite at the screen width (inside bezel)
  const screenW = fmt.phoneWidth - (PHONE_BEZEL_WIDTH * 2);
  const inviteImg = await renderInviteToImage(html, css, config, screenW);
  onProgress(20, 'Starting animation...');

  const blob = await animateAndRecord(inviteImg, promptText, fmt, thm, onProgress);
  onProgress(100, 'Done!');
  return blob;
}

/**
 * Render HTML invite into a full-height image using html2canvas.
 */
async function renderInviteToImage(html, css, config, targetWidth) {
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;left:-9999px;top:0;width:' + targetWidth + 'px;overflow:hidden;z-index:-1;';
  document.body.appendChild(container);

  var configObj = config;
  if (typeof config === 'string') {
    try { configObj = JSON.parse(config); } catch(e) { configObj = {}; }
  }
  configObj = configObj || {};

  var fontsImport = '';
  if (configObj.fontUrl) {
    fontsImport = '@import url("' + configObj.fontUrl + '");';
  } else if (configObj.googleFontsImport) {
    fontsImport = configObj.googleFontsImport;
  }

  container.innerHTML = '<div id="__adgen_invite" style="width:' + targetWidth + 'px;overflow:hidden;">'
    + '<style>' + fontsImport + '</style>'
    + '<style>' + (css || '') + '</style>'
    + '<style>.rsvp-slot,.details-slot{display:none !important}</style>'
    + (html || '')
    + '</div>';

  await new Promise(function(resolve) { setTimeout(resolve, 1500); });
  if (document.fonts && document.fonts.ready) {
    await document.fonts.ready;
  }

  const inviteEl = container.querySelector('#__adgen_invite');
  const naturalHeight = inviteEl.scrollHeight;
  const canvas = await html2canvas(inviteEl, {
    width: targetWidth,
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

  // Screen background — only visible before invite loads (during shimmer/empty phases)
  // Use a very dark color that won't tint the invite when it's drawn at full opacity
  ctx.save();
  roundRect(ctx, screenX, screenY, screenW, screenH, sr);
  ctx.fillStyle = '#0a0a12';
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
 * Run the animation on canvas and record to WebM.
 */
function animateAndRecord(inviteImg, promptText, fmt, thm, onProgress) {
  return new Promise(function(resolve, reject) {
    const canvas = document.createElement('canvas');
    canvas.width = fmt.width;
    canvas.height = fmt.height;
    const ctx = canvas.getContext('2d');

    // Phone screen dimensions
    const screenW = fmt.phoneWidth - (PHONE_BEZEL_WIDTH * 2);
    const screenContentH = fmt.phoneHeight - (PHONE_BEZEL_WIDTH * 2) - 12 - PHONE_NOTCH_HEIGHT - 4;

    // Invite draw dimensions
    const inviteDrawHeight = (inviteImg.naturalHeight / inviteImg.naturalWidth) * screenW;
    const scrollDistance = Math.max(0, inviteDrawHeight - screenContentH);
    const scrollMs = scrollDistance > 0 ? (scrollDistance / SCROLL_PX_PER_SEC) * 1000 : MIN_HOLD_MS;
    const holdMs = MIN_HOLD_MS;

    // Total duration
    const typingMs = promptText.length * CHAR_MS;
    const totalMs = INTRO_MS + typingMs + POST_TYPE_PAUSE + SHIMMER_MS + REVEAL_MS + holdMs + scrollMs + MIN_HOLD_MS + CTA_MS;

    // Create particles
    const particles = createParticles(fmt.particleCount || 30, fmt.width, fmt.height);

    // MediaRecorder
    const stream = canvas.captureStream(FPS);
    const recorder = new MediaRecorder(stream, {
      mimeType: 'video/webm;codecs=vp9',
      videoBitsPerSecond: 8000000
    });
    const chunks = [];

    recorder.ondataavailable = function(e) { if (e.data.size > 0) chunks.push(e.data); };
    recorder.onstop = function() { resolve(new Blob(chunks, { type: 'video/webm' })); };
    recorder.onerror = function(e) { reject(new Error('MediaRecorder error: ' + (e.error || e.message || 'unknown'))); };

    const logoText = 'Ryvite';
    let startTime = null;
    let animFrameId = null;

    recorder.start();

    function drawFrame(timestamp) {
      if (!startTime) startTime = timestamp;
      const elapsed = timestamp - startTime;

      ctx.clearRect(0, 0, fmt.width, fmt.height);

      // ── Animated background gradient ──
      drawAnimatedBackground(ctx, fmt.width, fmt.height, elapsed, thm);

      // ── Floating particles ──
      drawParticles(ctx, particles, elapsed, thm);

      // ── Phase calculations ──
      const introEnd = INTRO_MS;
      const typeEnd = introEnd + typingMs;
      const pauseEnd = typeEnd + POST_TYPE_PAUSE;
      const shimmerEnd = pauseEnd + SHIMMER_MS;
      const revealEnd = shimmerEnd + REVEAL_MS;
      const holdEnd = revealEnd + holdMs;
      const scrollEnd = holdEnd + scrollMs;
      const finalHoldEnd = scrollEnd + MIN_HOLD_MS;

      // ── Layout mode ──
      const isSideBySide = fmt.layout === 'side_by_side';
      const logoX = isSideBySide ? fmt.promptAreaX + fmt.promptMaxWidth / 2 : fmt.width / 2;

      // ── Logo (fades in + slides down during intro) ──
      const logoProgress = Math.min(1, elapsed / INTRO_MS);
      const logoEased = easeOutCubic(logoProgress);
      ctx.save();
      ctx.globalAlpha = logoEased;
      ctx.font = 'bold ' + fmt.logoSize + 'px "Inter", "Helvetica Neue", Arial, sans-serif';
      ctx.fillStyle = thm.logoColor;
      ctx.textAlign = 'center';
      ctx.fillText(logoText, logoX, fmt.logoY - 20 + logoEased * 20);

      // Subtitle
      ctx.font = fmt.labelFontSize + 'px "Inter", "Helvetica Neue", Arial, sans-serif';
      ctx.fillStyle = thm.subtextColor;
      ctx.fillText('AI-Powered Event Invitations', logoX, fmt.labelY - 15 + logoEased * 15);
      ctx.restore();

      // ── Prompt Card (white rounded card matching homepage .demo-chat-bubble) ──
      if (elapsed > INTRO_MS * 0.5) {
        const typeElapsed = Math.max(0, elapsed - introEnd);
        const charCount = Math.min(promptText.length, Math.floor(typeElapsed / CHAR_MS));
        const displayText = promptText.substring(0, charCount);

        // Prompt card position
        const cardX = isSideBySide ? (fmt.promptAreaX || 40) : (fmt.width - fmt.promptMaxWidth) / 2;
        const cardW = fmt.promptMaxWidth;
        const cardPadX = 36;
        const cardPadTop = 50;
        const cardPadBottom = 40;
        const cardRadius = 24;

        // Measure text height for card sizing
        ctx.save();
        ctx.font = fmt.promptFontSize + 'px "Inter", "Helvetica Neue", Arial, sans-serif';
        const allLines = wrapText(ctx, promptText, cardW - cardPadX * 2 - 20);
        const textBlockH = allLines.length * fmt.promptLineHeight;
        ctx.restore();

        const cardH = Math.max(cardPadTop + textBlockH + cardPadBottom + 20, fmt.promptAreaHeight || 200);
        const cardY = fmt.promptAreaY - 10;

        // Card fade-in
        const cardAlpha = Math.min(1, (elapsed - INTRO_MS * 0.5) / 400);

        ctx.save();
        ctx.globalAlpha = cardAlpha;

        // Card shadow
        ctx.shadowColor = 'rgba(0,0,0,0.08)';
        ctx.shadowBlur = 24;
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

        // "YOUR PROMPT" header label
        ctx.font = '700 ' + Math.round(fmt.promptFontSize * 0.42) + 'px "Inter", "Helvetica Neue", Arial, sans-serif';
        ctx.fillStyle = '#E94560';
        ctx.textAlign = 'center';
        ctx.letterSpacing = '1.5px';
        ctx.fillText('YOUR PROMPT', cardX + cardW / 2, cardY + 36);
        ctx.letterSpacing = '0px';

        // Prompt text (centered, dark color)
        if (displayText.length > 0) {
          ctx.font = fmt.promptFontSize + 'px "Inter", "Helvetica Neue", Arial, sans-serif';
          ctx.fillStyle = '#1a1a2e';
          ctx.textAlign = 'center';

          const lines = wrapText(ctx, displayText, cardW - cardPadX * 2);
          const textStartY = cardY + cardPadTop + 16;
          lines.forEach(function(line, i) {
            ctx.fillText(line, cardX + cardW / 2, textStartY + i * fmt.promptLineHeight);
          });

          // Blinking cursor (coral colored, matching homepage)
          const cursorBlink = Math.sin(elapsed / 400 * Math.PI) > 0;
          if (charCount < promptText.length || (elapsed < pauseEnd && cursorBlink)) {
            const lastLine = lines[lines.length - 1] || '';
            const lastLineW = ctx.measureText(lastLine).width;
            const cursorX = cardX + cardW / 2 + lastLineW / 2 + 4;
            const cursorY = textStartY + (lines.length - 1) * fmt.promptLineHeight;

            ctx.fillStyle = '#E94560';
            ctx.fillRect(cursorX, cursorY - fmt.promptFontSize + 6, 2.5, fmt.promptFontSize - 2);
          }
        }

        ctx.restore();
      }

      // ── Premium Phone Mockup ──
      // For side-by-side layout, phone is positioned on the right; for vertical, centered
      const phoneX = isSideBySide ? (fmt.phoneX || 580) : (fmt.width - fmt.phoneWidth) / 2;
      const phoneY = fmt.phoneY;

      // Phone glow effect during/after reveal
      if (elapsed >= shimmerEnd) {
        var glowIntensity = 0;
        if (elapsed < revealEnd) {
          glowIntensity = easeOutCubic((elapsed - shimmerEnd) / REVEAL_MS) * 0.6;
        } else {
          // Subtle pulsing glow after reveal
          glowIntensity = 0.15 + 0.1 * Math.sin(elapsed / 2000 * Math.PI);
        }
        ctx.save();
        ctx.shadowColor = thm.accentColor;
        ctx.shadowBlur = 60;
        ctx.globalAlpha = glowIntensity;
        roundRect(ctx, phoneX + 4, phoneY + 4, fmt.phoneWidth - 8, fmt.phoneHeight - 8, PHONE_FRAME_RADIUS - 2);
        ctx.fillStyle = thm.accentColor;
        ctx.fill();
        ctx.restore();
      }

      // Draw the phone frame (always realistic metallic look)
      var screen = drawPhoneFrame(ctx, phoneX, phoneY, fmt.phoneWidth, fmt.phoneHeight, elapsed);

      // ── Phone screen content ──
      if (elapsed >= shimmerEnd) {
        // ── Invite reveal with scale + fade ──
        const revealProgress = Math.min(1, (elapsed - shimmerEnd) / REVEAL_MS);
        const eased = easeOutCubic(revealProgress);

        // Scroll offset
        let scrollOffset = 0;
        if (elapsed >= holdEnd && scrollDistance > 0) {
          if (elapsed < scrollEnd) {
            scrollOffset = easeInOutCubic((elapsed - holdEnd) / scrollMs) * scrollDistance;
          } else {
            scrollOffset = scrollDistance;
          }
        }

        // Scale from 0.92 to 1.0 during reveal
        const scale = 0.92 + eased * 0.08;
        const revealAlpha = eased;

        ctx.save();
        // Clip to screen area
        roundRect(ctx, screen.screenX, screen.screenY, screen.screenW, screen.screenH, screen.screenRadius);
        ctx.clip();

        ctx.globalAlpha = revealAlpha;

        // Apply scale from center of screen
        var scaleCenterX = screen.x + screen.w / 2;
        var scaleCenterY = screen.y + screen.h / 2;
        ctx.translate(scaleCenterX, scaleCenterY);
        ctx.scale(scale, scale);
        ctx.translate(-scaleCenterX, -scaleCenterY);

        // Draw invite
        ctx.drawImage(inviteImg, screen.x, screen.y - scrollOffset, screen.w, inviteDrawHeight);
        ctx.restore();
      } else if (elapsed >= pauseEnd) {
        // Shimmer loading effect
        ctx.save();
        roundRect(ctx, screen.screenX, screen.screenY, screen.screenW, screen.screenH, screen.screenRadius);
        ctx.clip();
        var shimmerProgress = (elapsed - pauseEnd) / SHIMMER_MS;
        drawShimmer(ctx, screen.x, screen.y, screen.w, screen.h, shimmerProgress, thm);
        ctx.restore();
      } else {
        // Empty screen with loading dots
        ctx.save();
        roundRect(ctx, screen.screenX, screen.screenY, screen.screenW, screen.screenH, screen.screenRadius);
        ctx.clip();
        if (elapsed > introEnd) {
          var dotAlpha = 0.3 + 0.2 * Math.sin(elapsed / 500 * Math.PI);
          ctx.globalAlpha = dotAlpha;
          for (var i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.arc(screen.x + screen.w / 2 - 30 + i * 30, screen.y + screen.h / 2, 5, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(255,255,255,0.5)';
            ctx.fill();
          }
        }
        ctx.restore();
      }

      // ── CTA ──
      if (elapsed >= finalHoldEnd) {
        var ctaProgress = Math.min(1, (elapsed - finalHoldEnd) / CTA_MS);
        var ctaEased = easeOutCubic(ctaProgress);

        ctx.save();
        ctx.globalAlpha = ctaEased;

        // CTA button with subtle shadow
        var ctaW = Math.min(460, fmt.width * 0.44);
        var ctaH = 64;
        var ctaX = (fmt.width - ctaW) / 2;

        // Button shadow
        ctx.shadowColor = 'rgba(233,69,96,0.4)';
        ctx.shadowBlur = 20;
        ctx.shadowOffsetY = 6;
        roundRect(ctx, ctaX, fmt.ctaY, ctaW, ctaH, 32);
        ctx.fillStyle = thm.ctaBg;
        ctx.fill();
        ctx.shadowColor = 'transparent';

        ctx.font = 'bold ' + fmt.ctaFontSize + 'px "Inter", Arial, sans-serif';
        ctx.fillStyle = thm.ctaText;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Create Yours Free', fmt.width / 2, fmt.ctaY + ctaH / 2);

        ctx.font = (fmt.ctaFontSize * 0.65) + 'px "Inter", Arial, sans-serif';
        ctx.fillStyle = thm.subtextColor;
        ctx.fillText('ryvite.com', fmt.width / 2, fmt.ctaY + ctaH + 30);

        ctx.restore();
      }

      // Progress reporting
      var progress = 20 + Math.min(75, (elapsed / totalMs) * 75);
      var phase = 'Processing...';
      if (elapsed < typeEnd) phase = 'Typing...';
      else if (elapsed < shimmerEnd) phase = 'Generating...';
      else if (elapsed < revealEnd) phase = 'Revealing...';
      else if (elapsed < scrollEnd && scrollDistance > 0) phase = 'Scrolling invite...';
      else if (elapsed < finalHoldEnd) phase = 'Finishing...';
      else phase = 'Rendering CTA...';
      onProgress(progress, phase);

      if (elapsed < totalMs) {
        animFrameId = requestAnimationFrame(drawFrame);
      } else {
        setTimeout(function() {
          recorder.stop();
          cancelAnimationFrame(animFrameId);
        }, 200);
      }
    }

    animFrameId = requestAnimationFrame(drawFrame);
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
  // Dark screen background
  ctx.fillStyle = '#0a0a14';
  ctx.fillRect(x, y, w, h);

  // Animated shimmer sweep
  var shimmerX = x - w + progress * (w * 3);
  var grad = ctx.createLinearGradient(shimmerX, y, shimmerX + w * 0.6, y);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.06)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.06)');
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
  download: downloadBlob,
  themes: VIDEO_THEMES,
  formats: FORMAT_CONFIGS
};
