/**
 * Ad Video Generator — Canvas + MediaRecorder engine for Facebook ad videos
 *
 * Renders a typing animation + invite reveal + slow scroll video, downloadable as WebM.
 * Supports two formats: Reels (9:16, 1080x1920) and Feed (1:1, 1080x1080).
 * Can generate both formats at once.
 *
 * Usage:
 *   const blob = await generateAdVideo({
 *     html, css, config, promptText,
 *     format: 'reels_9x16',     // or 'feed_1x1'
 *     theme: 'dark_gradient',   // or 'light_clean', 'ryvite_brand', 'warm_sunset'
 *     onProgress: (pct, phase) => { ... }
 *   });
 */

// ── Video Themes ──
const VIDEO_THEMES = {
  dark_gradient: {
    name: 'Dark Gradient',
    bgGradient: ['#1a0a2e', '#16213e', '#0f3460'],
    textColor: '#ffffff',
    subtextColor: '#b8b8d0',
    accentColor: '#E94560',
    cursorColor: '#E94560',
    phoneBorder: '#333355',
    phoneInner: '#111122',
    ctaBg: '#E94560',
    ctaText: '#ffffff',
    logoColor: '#ffffff'
  },
  light_clean: {
    name: 'Light Clean',
    bgGradient: ['#f8f9fa', '#ffffff', '#f0f2f5'],
    textColor: '#1a1a2e',
    subtextColor: '#666680',
    accentColor: '#E94560',
    cursorColor: '#E94560',
    phoneBorder: '#d0d0dd',
    phoneInner: '#f5f5fa',
    ctaBg: '#E94560',
    ctaText: '#ffffff',
    logoColor: '#1a1a2e'
  },
  ryvite_brand: {
    name: 'Ryvite Brand',
    bgGradient: ['#0a0a1a', '#111133', '#1a1a3e'],
    textColor: '#ffffff',
    subtextColor: '#a8a8c0',
    accentColor: '#E94560',
    cursorColor: '#E94560',
    phoneBorder: '#E94560',
    phoneInner: '#0d0d20',
    ctaBg: '#E94560',
    ctaText: '#ffffff',
    logoColor: '#E94560'
  },
  warm_sunset: {
    name: 'Warm Sunset',
    bgGradient: ['#ffecd2', '#fcb69f', '#ff9a9e'],
    textColor: '#3d1f00',
    subtextColor: '#6b4226',
    accentColor: '#E94560',
    cursorColor: '#E94560',
    phoneBorder: '#d4856a',
    phoneInner: '#fff5ef',
    ctaBg: '#E94560',
    ctaText: '#ffffff',
    logoColor: '#3d1f00'
  }
};

// ── Format Configs ──
const FORMAT_CONFIGS = {
  reels_9x16: {
    width: 1080,
    height: 1920,
    logoY: 80,
    logoSize: 42,
    promptAreaY: 200,
    promptAreaHeight: 300,
    promptFontSize: 36,
    promptMaxWidth: 920,
    promptLineHeight: 52,
    phoneY: 550,
    phoneWidth: 580,
    phoneHeight: 1050,
    phoneRadius: 44,
    ctaY: 1700,
    ctaFontSize: 32,
    labelFontSize: 18,
    labelY: 170
  },
  feed_1x1: {
    width: 1080,
    height: 1080,
    logoY: 50,
    logoSize: 36,
    promptAreaY: 130,
    promptAreaHeight: 200,
    promptFontSize: 30,
    promptMaxWidth: 800,
    promptLineHeight: 44,
    phoneY: 360,
    phoneWidth: 400,
    phoneHeight: 520,
    phoneRadius: 32,
    ctaY: 950,
    ctaFontSize: 28,
    labelFontSize: 16,
    labelY: 108
  }
};

// ── Animation Timing ──
const CHAR_MS = 35;        // ms per character typed (matches homepage)
const INTRO_MS = 500;      // logo fade-in
const POST_TYPE_PAUSE = 500;
const SHIMMER_MS = 1000;   // "generating" shimmer
const REVEAL_MS = 1000;    // invite slide-up reveal
const SCROLL_PX_PER_SEC = 40; // very slow scroll speed (pixels per second)
const MIN_HOLD_MS = 3000;  // minimum hold time if no scrolling needed
const CTA_MS = 1500;       // CTA fade-in
const FPS = 30;
const FRAME_MS = 1000 / FPS;

/**
 * Main entry: generate an ad video and return a Blob
 */
async function generateAdVideo({ html, css, config, promptText, format, theme, onProgress }) {
  onProgress = onProgress || function() {};
  const fmt = FORMAT_CONFIGS[format] || FORMAT_CONFIGS.reels_9x16;
  const thm = VIDEO_THEMES[theme] || VIDEO_THEMES.dark_gradient;

  onProgress(0, 'Preparing invite...');

  // Step 1: Render invite HTML to a full-height image (no cropping)
  // Use full inner phone width (flush with phone bezel, no padding)
  const contentW = fmt.phoneWidth - 8;
  const inviteImg = await renderInviteToImage(html, css, config, contentW);
  onProgress(20, 'Starting animation...');

  // Step 2: Animate and record
  const blob = await animateAndRecord(inviteImg, promptText, fmt, thm, onProgress);
  onProgress(100, 'Done!');

  return blob;
}

/**
 * Render HTML invite into a full-height image using html2canvas.
 * Captures the ENTIRE invite (not cropped) so we can scroll through it in the video.
 */
async function renderInviteToImage(html, css, config, targetWidth) {
  // Create a hidden container
  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;left:-9999px;top:0;width:' + targetWidth + 'px;overflow:hidden;z-index:-1;';
  document.body.appendChild(container);

  // Parse config if needed
  var configObj = config;
  if (typeof config === 'string') {
    try { configObj = JSON.parse(config); } catch(e) { configObj = {}; }
  }
  configObj = configObj || {};

  // Build the invite content — use the invite's own styles exactly as-is
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

  // Wait for fonts to load
  await new Promise(function(resolve) { setTimeout(resolve, 1500); });
  if (document.fonts && document.fonts.ready) {
    await document.fonts.ready;
  }

  // Capture with html2canvas — full natural height, no cropping
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

  // Convert to image
  return new Promise(function(resolve) {
    const img = new Image();
    img.onload = function() { resolve(img); };
    img.src = canvas.toDataURL('image/png');
  });
}

/**
 * Run the animation on canvas and record to WebM.
 * After reveal, slowly scrolls through the full invite.
 */
function animateAndRecord(inviteImg, promptText, fmt, thm, onProgress) {
  return new Promise(function(resolve, reject) {
    const canvas = document.createElement('canvas');
    canvas.width = fmt.width;
    canvas.height = fmt.height;
    const ctx = canvas.getContext('2d');

    // Calculate phone content area — flush with inner bezel edge
    const contentW = fmt.phoneWidth - 8;
    const contentH = fmt.phoneHeight - 36; // 4px top bezel + 28px notch + 4px bottom bezel

    // The invite image is rendered at 2x scale for the contentW width
    // So the actual content it represents = inviteImg.naturalHeight / 2 in CSS pixels
    // But we draw it scaled to fit contentW, so the visible height at contentW scale:
    const inviteDrawHeight = (inviteImg.naturalHeight / inviteImg.naturalWidth) * contentW;

    // Calculate scroll distance — how much we need to scroll to see the whole invite
    const scrollDistance = Math.max(0, inviteDrawHeight - contentH);

    // Calculate scroll duration: very slow, proportional to content
    const scrollMs = scrollDistance > 0 ? (scrollDistance / SCROLL_PX_PER_SEC) * 1000 : MIN_HOLD_MS;
    const holdMs = scrollDistance > 0 ? MIN_HOLD_MS : MIN_HOLD_MS; // hold at top before scrolling

    // Calculate total duration
    const typingMs = promptText.length * CHAR_MS;
    const totalMs = INTRO_MS + typingMs + POST_TYPE_PAUSE + SHIMMER_MS + REVEAL_MS + holdMs + scrollMs + MIN_HOLD_MS + CTA_MS;

    // Set up MediaRecorder
    const stream = canvas.captureStream(FPS);
    const recorder = new MediaRecorder(stream, {
      mimeType: 'video/webm;codecs=vp9',
      videoBitsPerSecond: 8000000
    });
    const chunks = [];

    recorder.ondataavailable = function(e) {
      if (e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = function() {
      const blob = new Blob(chunks, { type: 'video/webm' });
      resolve(blob);
    };

    recorder.onerror = function(e) {
      reject(new Error('MediaRecorder error: ' + (e.error || e.message || 'unknown')));
    };

    const logoText = 'Ryvite';
    let startTime = null;
    let animFrameId = null;

    recorder.start();

    function drawFrame(timestamp) {
      if (!startTime) startTime = timestamp;
      const elapsed = timestamp - startTime;

      // Clear canvas
      ctx.clearRect(0, 0, fmt.width, fmt.height);

      // ── Background gradient ──
      const bgGrad = ctx.createLinearGradient(0, 0, 0, fmt.height);
      thm.bgGradient.forEach(function(color, i) {
        bgGrad.addColorStop(i / (thm.bgGradient.length - 1), color);
      });
      ctx.fillStyle = bgGrad;
      ctx.fillRect(0, 0, fmt.width, fmt.height);

      // ── Phase calculations ──
      const introEnd = INTRO_MS;
      const typeEnd = introEnd + typingMs;
      const pauseEnd = typeEnd + POST_TYPE_PAUSE;
      const shimmerEnd = pauseEnd + SHIMMER_MS;
      const revealEnd = shimmerEnd + REVEAL_MS;
      const holdEnd = revealEnd + holdMs;
      const scrollEnd = holdEnd + scrollMs;
      const finalHoldEnd = scrollEnd + MIN_HOLD_MS;

      // ── Logo (fades in during intro) ──
      const logoAlpha = Math.min(1, elapsed / INTRO_MS);
      ctx.save();
      ctx.globalAlpha = logoAlpha;
      ctx.font = 'bold ' + fmt.logoSize + 'px "Inter", "Helvetica Neue", Arial, sans-serif';
      ctx.fillStyle = thm.logoColor;
      ctx.textAlign = 'center';
      ctx.fillText(logoText, fmt.width / 2, fmt.logoY);

      // Subtitle
      ctx.font = fmt.labelFontSize + 'px "Inter", "Helvetica Neue", Arial, sans-serif';
      ctx.fillStyle = thm.subtextColor;
      ctx.fillText('AI-Powered Event Invitations', fmt.width / 2, fmt.labelY);
      ctx.restore();

      // ── Typing animation ──
      if (elapsed > INTRO_MS * 0.5) {
        const typeElapsed = Math.max(0, elapsed - introEnd);
        const charCount = Math.min(promptText.length, Math.floor(typeElapsed / CHAR_MS));
        const displayText = promptText.substring(0, charCount);

        // Opening quote
        ctx.save();
        ctx.font = 'italic ' + (fmt.promptFontSize * 0.6) + 'px "Inter", Arial, sans-serif';
        ctx.fillStyle = thm.subtextColor;
        ctx.globalAlpha = Math.min(1, (elapsed - INTRO_MS * 0.5) / 300);
        ctx.textAlign = 'left';
        const promptX = (fmt.width - fmt.promptMaxWidth) / 2;
        ctx.fillText('\u201c', promptX, fmt.promptAreaY);
        ctx.restore();

        // Typed text with word wrapping
        if (displayText.length > 0) {
          ctx.save();
          ctx.font = fmt.promptFontSize + 'px "Inter", "Helvetica Neue", Arial, sans-serif';
          ctx.fillStyle = thm.textColor;
          ctx.textAlign = 'left';

          const lines = wrapText(ctx, displayText, fmt.promptMaxWidth - 40);
          lines.forEach(function(line, i) {
            ctx.fillText(line, promptX + 20, fmt.promptAreaY + 10 + (i + 1) * fmt.promptLineHeight);
          });

          // Blinking cursor
          const cursorBlink = Math.sin(elapsed / 300 * Math.PI) > 0;
          if (charCount < promptText.length || (elapsed < pauseEnd && cursorBlink)) {
            const lastLine = lines[lines.length - 1] || '';
            const cursorX = promptX + 20 + ctx.measureText(lastLine).width + 4;
            const cursorY = fmt.promptAreaY + 10 + lines.length * fmt.promptLineHeight;
            ctx.fillStyle = thm.cursorColor;
            ctx.fillRect(cursorX, cursorY - fmt.promptFontSize + 4, 3, fmt.promptFontSize);
          }

          // Closing quote
          if (charCount >= promptText.length) {
            const lastLine = lines[lines.length - 1] || '';
            const quoteX = promptX + 20 + ctx.measureText(lastLine).width + 14;
            const quoteY = fmt.promptAreaY + 10 + lines.length * fmt.promptLineHeight;
            ctx.font = 'italic ' + (fmt.promptFontSize * 0.6) + 'px "Inter", Arial, sans-serif';
            ctx.fillStyle = thm.subtextColor;
            ctx.fillText('\u201d', quoteX, quoteY);
          }
          ctx.restore();
        }
      }

      // ── Phone mockup ──
      const phoneX = (fmt.width - fmt.phoneWidth) / 2;
      const phoneY = fmt.phoneY;

      // Phone frame (outer border)
      ctx.save();
      roundRect(ctx, phoneX, phoneY, fmt.phoneWidth, fmt.phoneHeight, fmt.phoneRadius);
      ctx.fillStyle = thm.phoneBorder;
      ctx.fill();

      // Phone inner background — only visible before invite loads
      roundRect(ctx, phoneX + 4, phoneY + 4, fmt.phoneWidth - 8, fmt.phoneHeight - 8, fmt.phoneRadius - 2);
      ctx.fillStyle = thm.phoneInner;
      ctx.fill();

      // Phone notch
      const notchW = 120;
      const notchH = 28;
      const notchX = phoneX + (fmt.phoneWidth - notchW) / 2;
      roundRect(ctx, notchX, phoneY, notchW, notchH, 14);
      ctx.fillStyle = thm.phoneBorder;
      ctx.fill();

      // ── Phone content area — flush with inner bezel, no padding ──
      const contentX = phoneX + 4;
      const contentY = phoneY + 32; // just below notch

      if (elapsed >= shimmerEnd) {
        // ── Invite is visible: reveal + scroll ──
        const revealProgress = Math.min(1, (elapsed - shimmerEnd) / REVEAL_MS);
        const eased = easeOutCubic(revealProgress);

        // Calculate scroll offset
        let scrollOffset = 0;
        if (elapsed >= holdEnd && scrollDistance > 0) {
          if (elapsed < scrollEnd) {
            // Scrolling phase — ease in-out for smooth motion
            const scrollProgress = (elapsed - holdEnd) / scrollMs;
            scrollOffset = easeInOutCubic(scrollProgress) * scrollDistance;
          } else {
            // Past scroll, hold at bottom
            scrollOffset = scrollDistance;
          }
        }

        // Reveal animation: slide up from below
        const slideOffset = (1 - eased) * contentH * 0.3;
        const revealAlpha = eased;

        ctx.save();
        // Clip to phone inner area (rounded corners at bottom)
        ctx.beginPath();
        roundRect(ctx, contentX, contentY, contentW, contentH, fmt.phoneRadius - 6);
        ctx.clip();

        ctx.globalAlpha = revealAlpha;

        // Draw the invite filling the entire phone screen, offset by scroll
        ctx.drawImage(
          inviteImg,
          contentX, contentY + slideOffset - scrollOffset,
          contentW, inviteDrawHeight
        );
        ctx.restore();
      } else if (elapsed >= pauseEnd) {
        // Shimmer effect
        const shimmerProgress = (elapsed - pauseEnd) / SHIMMER_MS;
        drawShimmer(ctx, contentX, contentY, contentW, contentH, shimmerProgress, thm);
      } else {
        // Empty phone placeholder
        if (elapsed > introEnd) {
          const dotAlpha = 0.3 + 0.2 * Math.sin(elapsed / 500 * Math.PI);
          ctx.globalAlpha = dotAlpha;
          for (let i = 0; i < 3; i++) {
            ctx.beginPath();
            ctx.arc(contentX + contentW / 2 - 30 + i * 30, contentY + contentH / 2, 6, 0, Math.PI * 2);
            ctx.fillStyle = thm.subtextColor;
            ctx.fill();
          }
          ctx.globalAlpha = 1;
        }
      }
      ctx.restore();

      // ── CTA ──
      if (elapsed >= finalHoldEnd) {
        const ctaProgress = Math.min(1, (elapsed - finalHoldEnd) / CTA_MS);
        const ctaEased = easeOutCubic(ctaProgress);

        ctx.save();
        ctx.globalAlpha = ctaEased;

        // CTA button
        const ctaW = 460;
        const ctaH = 64;
        const ctaX = (fmt.width - ctaW) / 2;
        roundRect(ctx, ctaX, fmt.ctaY, ctaW, ctaH, 32);
        ctx.fillStyle = thm.ctaBg;
        ctx.fill();

        ctx.font = 'bold ' + fmt.ctaFontSize + 'px "Inter", Arial, sans-serif';
        ctx.fillStyle = thm.ctaText;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Create Yours Free', fmt.width / 2, fmt.ctaY + ctaH / 2);

        // URL below button
        ctx.font = (fmt.ctaFontSize * 0.65) + 'px "Inter", Arial, sans-serif';
        ctx.fillStyle = thm.subtextColor;
        ctx.fillText('ryvite.com', fmt.width / 2, fmt.ctaY + ctaH + 30);

        ctx.restore();
      }

      // Update progress
      const progress = 20 + Math.min(75, (elapsed / totalMs) * 75);
      var phase = 'Processing...';
      if (elapsed < typeEnd) phase = 'Typing...';
      else if (elapsed < shimmerEnd) phase = 'Generating...';
      else if (elapsed < revealEnd) phase = 'Revealing...';
      else if (elapsed < scrollEnd && scrollDistance > 0) phase = 'Scrolling invite...';
      else if (elapsed < finalHoldEnd) phase = 'Finishing...';
      else phase = 'Rendering CTA...';
      onProgress(progress, phase);

      // Continue or stop
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

// ── Helper: Draw rounded rectangle ──
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

// ── Helper: Word wrap text ──
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

// ── Helper: Shimmer effect ──
function drawShimmer(ctx, x, y, w, h, progress, thm) {
  // Background
  ctx.fillStyle = thm.phoneInner;
  ctx.fillRect(x, y, w, h);

  // Shimmer sweep
  const shimmerX = x - w + progress * (w * 3);
  const grad = ctx.createLinearGradient(shimmerX, y, shimmerX + w * 0.6, y);
  grad.addColorStop(0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.4, 'rgba(255,255,255,0.08)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.15)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.08)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);

  // Placeholder bars
  const barColor = thm.textColor === '#ffffff' ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  ctx.fillStyle = barColor;
  const barY = y + h * 0.15;
  roundRect(ctx, x + 40, barY, w * 0.6, 20, 10); ctx.fill();
  roundRect(ctx, x + 60, barY + 40, w * 0.4, 16, 8); ctx.fill();
  roundRect(ctx, x + 30, barY + 100, w * 0.8, 120, 12); ctx.fill();
  roundRect(ctx, x + 50, barY + 250, w * 0.5, 16, 8); ctx.fill();

  // "Generating..." text
  const genAlpha = 0.5 + 0.3 * Math.sin(progress * Math.PI * 4);
  ctx.save();
  ctx.globalAlpha = genAlpha;
  ctx.font = '22px "Inter", Arial, sans-serif';
  ctx.fillStyle = thm.subtextColor;
  ctx.textAlign = 'center';
  ctx.fillText('Generating your invite...', x + w / 2, y + h / 2 + 60);
  ctx.restore();
}

// ── Helper: Easing ──
function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Trigger download of a Blob as a file
 */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 5000);
}

// Export for use in admin panel
window.AdVideoGenerator = {
  generate: generateAdVideo,
  download: downloadBlob,
  themes: VIDEO_THEMES,
  formats: FORMAT_CONFIGS
};
