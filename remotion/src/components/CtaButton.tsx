import React from 'react';
import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { FormatConfig } from '../lib/formats';
import type { VideoTheme } from '../lib/themes';

interface CtaButtonProps {
  fmt: FormatConfig;
  theme: VideoTheme;
  /** 0→1 CTA fade-in progress */
  progress: number;
}

/**
 * "Create Yours Free" CTA button with spring entrance animation.
 */
export const CtaButton: React.FC<CtaButtonProps> = ({ fmt, theme, progress }) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();

  const opacity = interpolate(progress, [0, 0.5, 1], [0, 0.7, 1], { extrapolateRight: 'clamp' });
  const slideY = interpolate(progress, [0, 1], [20, 0], { extrapolateRight: 'clamp' });
  const scale = interpolate(progress, [0, 0.6, 1], [0.9, 1.02, 1], { extrapolateRight: 'clamp' });

  const ctaW = Math.min(460, fmt.width * 0.44);
  const ctaH = 64;

  return (
    <div
      style={{
        position: 'absolute',
        top: fmt.ctaY,
        left: (fmt.width - ctaW) / 2,
        width: ctaW,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        opacity,
        transform: `translateY(${slideY}px) scale(${scale})`,
      }}
    >
      {/* Button */}
      <div
        style={{
          width: ctaW,
          height: ctaH,
          borderRadius: 32,
          backgroundColor: theme.ctaBg,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 6px 20px rgba(233,69,96,0.4)',
        }}
      >
        <span
          style={{
            fontFamily: '"Inter", Arial, sans-serif',
            fontWeight: 'bold',
            fontSize: fmt.ctaFontSize,
            color: theme.ctaText,
          }}
        >
          Create Yours Free
        </span>
      </div>

      {/* URL below button */}
      <span
        style={{
          fontFamily: '"Inter", Arial, sans-serif',
          fontSize: fmt.ctaFontSize * 0.65,
          color: theme.subtextColor,
          marginTop: 14,
        }}
      >
        ryvite.com
      </span>
    </div>
  );
};
