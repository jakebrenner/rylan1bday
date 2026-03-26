import React from 'react';
import { AbsoluteFill, Sequence, useCurrentFrame, useVideoConfig, staticFile, delayRender, continueRender } from 'remotion';
import { AnimatedBackground } from './components/AnimatedBackground';
import { PhoneFrame } from './components/PhoneFrame';
import { TypingPrompt } from './components/TypingPrompt';
import { ShimmerEffect } from './components/ShimmerEffect';
import { InviteReveal } from './components/InviteReveal';
import { Logo } from './components/Logo';
import { CtaButton } from './components/CtaButton';
import { VIDEO_THEMES } from './lib/themes';
import { FORMAT_CONFIGS, getScreenArea } from './lib/formats';
import {
  FPS, INTRO_MS, CHAR_MS, POST_TYPE_PAUSE, DISSOLVE_MS,
  SHIMMER_MS, REVEAL_MS, HOLD_MS, END_HOLD_MS, CTA_MS,
  MAX_SCROLL_MS, SCROLL_PX_PER_SEC, msToFrames, computeTimeline,
} from './lib/timing';

export interface AdVideoProps {
  /** URL of the pre-rendered invite image (full-height screenshot) */
  inviteImageUrl: string;
  /** Prompt text for the typing animation */
  promptText: string;
  /** Video format */
  format: 'reels_9x16' | 'feed_1x1';
  /** Visual theme */
  theme: 'dark_gradient' | 'light_clean' | 'ryvite_brand' | 'warm_sunset';
  /** Natural width of the invite image (pixels) */
  inviteWidth: number;
  /** Natural height of the invite image (pixels) */
  inviteHeight: number;
}

/**
 * Main ad video composition.
 *
 * Timeline:
 * 1. Intro (logo fade + phone slide-in)
 * 2. Typing prompt on phone screen
 * 3. Dissolve prompt card
 * 4. Shimmer / AI generation effect
 * 5. Reveal invite with spring scale
 * 6. Hold at top → smooth scroll → hold at bottom
 * 7. CTA button entrance
 */
export const AdVideo: React.FC<AdVideoProps> = ({
  inviteImageUrl,
  promptText,
  format,
  theme,
  inviteWidth,
  inviteHeight,
}) => {
  const { fps, durationInFrames } = useVideoConfig();
  const frame = useCurrentFrame();

  const fmt = FORMAT_CONFIGS[format] || FORMAT_CONFIGS.reels_9x16;
  const thm = VIDEO_THEMES[theme] || VIDEO_THEMES.dark_gradient;
  const screen = getScreenArea(fmt);

  // Compute scroll distance for the invite inside the phone
  const inviteDrawHeight = (inviteHeight / inviteWidth) * screen.contentW;
  const scrollDistance = Math.max(0, inviteDrawHeight - screen.contentH);

  // Full timeline
  const tl = computeTimeline(promptText.length, scrollDistance);

  // Current elapsed time in ms
  const elapsed = (frame / fps) * 1000;

  // Phase progress helpers
  const introProgress = Math.min(1, elapsed / INTRO_MS);

  // Typing: frames relative to intro end
  const typingElapsed = Math.max(0, elapsed - tl.introEnd);

  // Dissolve progress
  const dissolveProgress = elapsed >= tl.pauseEnd
    ? Math.min(1, (elapsed - tl.pauseEnd) / DISSOLVE_MS)
    : 0;

  // Shimmer progress
  const shimmerProgress = elapsed >= tl.dissolveEnd
    ? Math.min(1, (elapsed - tl.dissolveEnd) / SHIMMER_MS)
    : 0;

  // Reveal progress
  const revealProgress = elapsed >= tl.shimmerEnd
    ? Math.min(1, (elapsed - tl.shimmerEnd) / REVEAL_MS)
    : 0;

  // Time elapsed since reveal started (for scroll timing)
  const elapsedSinceReveal = Math.max(0, elapsed - tl.revealEnd);

  // CTA progress
  const ctaProgress = elapsed >= tl.endHoldEnd
    ? Math.min(1, (elapsed - tl.endHoldEnd) / CTA_MS)
    : 0;

  // Determine which phase is active for phone screen content
  const showTyping = elapsed < tl.dissolveEnd;
  const showShimmer = elapsed >= tl.dissolveEnd && elapsed < tl.shimmerEnd;
  const showInvite = elapsed >= tl.shimmerEnd;

  return (
    <AbsoluteFill style={{ width: fmt.width, height: fmt.height, overflow: 'hidden' }}>
      {/* Layer 1: Animated gradient background + particles */}
      <AnimatedBackground
        width={fmt.width}
        height={fmt.height}
        theme={thm}
        particleCount={fmt.particleCount}
      />

      {/* Layer 2: Logo + subtitle */}
      <Logo fmt={fmt} theme={thm} introProgress={introProgress} />

      {/* Layer 3: Phone frame with screen content */}
      <PhoneFrame
        fmt={fmt}
        phoneX={screen.phoneX}
        phoneY={screen.phoneY}
        introProgress={introProgress}
      >
        {/* Phone screen content — switches between phases */}

        {/* Typing prompt (visible until dissolve completes) */}
        {showTyping && (
          <TypingPrompt
            promptText={promptText}
            fmt={fmt}
            screenW={screen.contentW}
            screenH={screen.contentH}
            dissolveProgress={dissolveProgress}
          />
        )}

        {/* Shimmer effect (AI generating...) */}
        {showShimmer && (
          <ShimmerEffect
            screenW={screen.contentW}
            screenH={screen.contentH}
            theme={thm}
            progress={shimmerProgress}
          />
        )}

        {/* Invite reveal + scroll */}
        {showInvite && (
          <InviteReveal
            inviteImageUrl={inviteImageUrl}
            screenW={screen.contentW}
            screenH={screen.contentH}
            theme={thm}
            revealProgress={revealProgress}
            elapsedSinceReveal={elapsedSinceReveal}
            inviteNaturalWidth={inviteWidth}
            inviteNaturalHeight={inviteHeight}
          />
        )}
      </PhoneFrame>

      {/* Layer 4: CTA button (appears at end) */}
      {ctaProgress > 0 && (
        <CtaButton fmt={fmt} theme={thm} progress={ctaProgress} />
      )}
    </AbsoluteFill>
  );
};
