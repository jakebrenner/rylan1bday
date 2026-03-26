import React from 'react';
import { interpolate } from 'remotion';
import type { FormatConfig } from '../lib/formats';
import type { VideoTheme } from '../lib/themes';

interface LogoProps {
  fmt: FormatConfig;
  theme: VideoTheme;
  /** 0→1 intro progress */
  introProgress: number;
}

/**
 * Ryvite logo (envelope icon + wordmark) + subtitle.
 * Fades in with a slight upward slide during intro.
 */
export const Logo: React.FC<LogoProps> = ({ fmt, theme, introProgress }) => {
  const opacity = interpolate(introProgress, [0, 0.3, 1], [0, 0.5, 1], { extrapolateRight: 'clamp' });
  const slideY = interpolate(introProgress, [0, 1], [-15, 0], { extrapolateRight: 'clamp' });

  const iconSize = fmt.logoSize * 1.1;

  return (
    <div
      style={{
        position: 'absolute',
        top: fmt.logoY + slideY,
        left: 0,
        right: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        opacity,
      }}
    >
      {/* Logo row: envelope icon + "Ryvite" text */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {/* Envelope icon in circle */}
        <svg width={iconSize} height={iconSize} viewBox="0 0 40 40">
          <circle cx={20} cy={20} r={18} fill="none" stroke={theme.logoColor} strokeWidth={2.5} />
          {/* Envelope flap */}
          <polyline
            points="9,14 20,22 31,14"
            fill="none"
            stroke={theme.logoColor}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* Envelope bottom */}
          <line
            x1={9}
            y1={27}
            x2={31}
            y2={27}
            stroke={theme.logoColor}
            strokeWidth={2}
            strokeLinecap="round"
          />
        </svg>

        <span
          style={{
            fontFamily: '"Playfair Display", "Georgia", serif',
            fontWeight: 600,
            fontSize: fmt.logoSize,
            color: theme.logoColor,
          }}
        >
          Ryvite
        </span>
      </div>

      {/* Subtitle */}
      <div
        style={{
          fontFamily: '"Inter", "Helvetica Neue", Arial, sans-serif',
          fontSize: fmt.labelFontSize,
          color: theme.subtextColor,
          marginTop: 8,
          opacity: interpolate(introProgress, [0.3, 1], [0, 1], { extrapolateRight: 'clamp' }),
        }}
      >
        AI-Powered Event Invitations
      </div>
    </div>
  );
};
