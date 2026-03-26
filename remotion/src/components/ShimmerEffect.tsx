import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { FPS } from '../lib/timing';
import type { VideoTheme } from '../lib/themes';

interface ShimmerEffectProps {
  screenW: number;
  screenH: number;
  theme: VideoTheme;
  /** 0→1 progress through shimmer phase */
  progress: number;
}

/**
 * AI generation shimmer effect — sweep gradient, orbiting dots, pulsing star, loading text.
 * GPU-accelerated via CSS transforms (replaces Canvas drawShimmer).
 */
export const ShimmerEffect: React.FC<ShimmerEffectProps> = ({ screenW, screenH, theme, progress }) => {
  const frame = useCurrentFrame();

  // Sweep gradient position
  const sweepX = interpolate(progress, [0, 1], [-screenW, screenW * 2]);

  // Orbiting dots (8 dots in a circle)
  const numDots = 8;
  const orbitR = Math.min(screenW, screenH) * 0.15;
  const centerX = screenW / 2;
  const centerY = screenH / 2;

  // Pulsing star
  const pulseScale = 0.8 + 0.2 * Math.sin(progress * Math.PI * 8);

  // Loading dots animation
  const dotCount = Math.floor(progress * 12) % 4;
  const dots = '.'.repeat(dotCount);

  // Text bounce
  const textBounce = Math.sin(progress * Math.PI * 6) * 3;

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        backgroundColor: '#f0f0f0',
        overflow: 'hidden',
      }}
    >
      {/* Shimmer sweep */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: sweepX,
          width: screenW * 0.6,
          height: '100%',
          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.6), transparent)',
          pointerEvents: 'none',
        }}
      />

      {/* Orbiting dots */}
      {Array.from({ length: numDots }, (_, i) => {
        const angle = (i / numDots) * Math.PI * 2 + progress * Math.PI * 6;
        const dotX = centerX + Math.cos(angle) * orbitR;
        const dotY = centerY + Math.sin(angle) * orbitR;
        const dotOpacity = 0.3 + 0.7 * ((i + 1) / numDots);

        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: dotX - 4,
              top: dotY - 4,
              width: 8,
              height: 8,
              borderRadius: '50%',
              backgroundColor: theme.accentColor,
              opacity: dotOpacity,
              boxShadow: `0 0 8px ${theme.accentColor}`,
            }}
          />
        );
      })}

      {/* Central pulsing star */}
      <div
        style={{
          position: 'absolute',
          left: centerX - 20,
          top: centerY - 20,
          width: 40,
          height: 40,
          transform: `scale(${pulseScale})`,
        }}
      >
        <svg width={40} height={40} viewBox="0 0 40 40">
          <path
            d="M20 0 L24 16 L40 20 L24 24 L20 40 L16 24 L0 20 L16 16 Z"
            fill={theme.accentColor}
            opacity={0.8}
          />
          <path
            d="M20 6 L22.5 16.5 L33 20 L22.5 23.5 L20 33 L17.5 23.5 L7 20 L17.5 16.5 Z"
            fill="white"
            opacity={0.4}
          />
        </svg>
      </div>

      {/* "Creating your invite..." text */}
      <div
        style={{
          position: 'absolute',
          bottom: centerY - orbitR - 60,
          left: 0,
          right: 0,
          textAlign: 'center',
          fontFamily: '"Inter", sans-serif',
          fontSize: 18,
          fontWeight: 600,
          color: theme.accentColor,
          transform: `translateY(${textBounce}px)`,
        }}
      >
        Creating your invite{dots}
      </div>
    </div>
  );
};
