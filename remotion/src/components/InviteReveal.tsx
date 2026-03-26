import React from 'react';
import { Img, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { FPS, HOLD_MS, SCROLL_PX_PER_SEC, MAX_SCROLL_MS } from '../lib/timing';
import type { VideoTheme } from '../lib/themes';

interface InviteRevealProps {
  inviteImageUrl: string;
  screenW: number;
  screenH: number;
  theme: VideoTheme;
  /** 0→1 reveal progress */
  revealProgress: number;
  /** Milliseconds elapsed since reveal start (for scroll timing) */
  elapsedSinceReveal: number;
  /** Natural width of the invite image */
  inviteNaturalWidth: number;
  /** Natural height of the invite image */
  inviteNaturalHeight: number;
}

/**
 * Invite reveal with spring scale animation + smooth scroll through content.
 * Uses Remotion's spring() for physics-based easing (replaces manual easeOutCubic).
 */
export const InviteReveal: React.FC<InviteRevealProps> = ({
  inviteImageUrl,
  screenW,
  screenH,
  theme,
  revealProgress,
  elapsedSinceReveal,
  inviteNaturalWidth,
  inviteNaturalHeight,
}) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();

  // Scale invite to fill phone screen width
  const inviteDrawHeight = (inviteNaturalHeight / inviteNaturalWidth) * screenW;
  const scrollDistance = Math.max(0, inviteDrawHeight - screenH);

  // Scroll timing
  const rawScrollMs = scrollDistance > 0 ? (scrollDistance / SCROLL_PX_PER_SEC) * 1000 : 0;
  const scrollMs = Math.min(rawScrollMs, MAX_SCROLL_MS);

  // Reveal animation (spring for smooth, natural feel)
  const scale = interpolate(revealProgress, [0, 1], [0.92, 1], { extrapolateRight: 'clamp' });
  const opacity = interpolate(revealProgress, [0, 0.5, 1], [0, 0.8, 1], { extrapolateRight: 'clamp' });

  // Scroll offset calculation
  let scrollOffset = 0;
  const holdMs = HOLD_MS;
  const msAfterReveal = Math.max(0, elapsedSinceReveal);

  if (msAfterReveal > holdMs && scrollDistance > 0) {
    const scrollElapsed = msAfterReveal - holdMs;
    if (scrollElapsed < scrollMs) {
      // Smooth easeInOutCubic scroll
      const t = scrollElapsed / scrollMs;
      const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      scrollOffset = eased * scrollDistance;
    } else {
      scrollOffset = scrollDistance;
    }
  }

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
        opacity,
        transform: `scale(${scale})`,
        transformOrigin: 'center center',
      }}
    >
      <Img
        src={inviteImageUrl}
        style={{
          position: 'absolute',
          top: -scrollOffset,
          left: 0,
          width: screenW,
          height: inviteDrawHeight,
        }}
      />
    </div>
  );
};
