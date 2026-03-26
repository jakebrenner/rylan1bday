import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { PHONE } from '../lib/formats';
import type { FormatConfig } from '../lib/formats';

interface PhoneFrameProps {
  fmt: FormatConfig;
  phoneX: number;
  phoneY: number;
  /** 0→1 intro progress for slide-up animation */
  introProgress: number;
  /** Content to render inside the phone screen */
  children: React.ReactNode;
}

/**
 * Premium iPhone mockup with metallic bezel, dynamic island, home bar, drop shadow.
 * Uses SVG for crisp rendering at any resolution (replaces Canvas path operations).
 */
export const PhoneFrame: React.FC<PhoneFrameProps> = ({ fmt, phoneX, phoneY, introProgress, children }) => {
  const frame = useCurrentFrame();
  const bw = PHONE.bezelWidth;
  const fr = PHONE.frameRadius;
  const sr = PHONE.screenRadius;
  const w = fmt.phoneWidth;
  const h = fmt.phoneHeight;

  // Slide-up animation
  const slideOffset = interpolate(introProgress, [0, 1], [80, 0], { extrapolateRight: 'clamp' });
  const opacity = interpolate(introProgress, [0, 0.3, 1], [0, 0.5, 1], { extrapolateRight: 'clamp' });

  // Screen dimensions
  const screenX = bw;
  const screenY = bw;
  const screenW = w - bw * 2;
  const screenH = h - bw * 2 - 12;

  // Dynamic island
  const notchW = w * PHONE.notchWidthRatio;
  const notchH = PHONE.notchHeight;
  const notchX = (w - notchW) / 2;
  const notchY = screenY + 8;

  // Home bar
  const homeBarW = PHONE.homeBarWidth;
  const homeBarH = PHONE.homeBarHeight;
  const homeBarX = (w - homeBarW) / 2;
  const homeBarY = h - bw - 16;

  // Glow pulse (subtle after reveal)
  const glowPulse = Math.sin(frame / 30 * Math.PI) * 0.5 + 0.5;
  const glowOpacity = interpolate(glowPulse, [0, 1], [0.05, 0.15]);

  return (
    <div
      style={{
        position: 'absolute',
        left: phoneX,
        top: phoneY + slideOffset,
        width: w,
        height: h,
        opacity,
      }}
    >
      {/* Drop shadow layer */}
      <div
        style={{
          position: 'absolute',
          inset: -20,
          borderRadius: fr + 20,
          boxShadow: `0 ${PHONE.shadowOffsetY}px ${PHONE.shadowBlur}px rgba(0,0,0,${PHONE.shadowAlpha})`,
          pointerEvents: 'none',
        }}
      />

      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: 'absolute', top: 0, left: 0 }}>
        <defs>
          {/* Metallic bezel gradient */}
          <linearGradient id="bezelGrad" x1="0%" y1="0%" x2="40%" y2="100%">
            <stop offset="0%" stopColor="#3a3a3e" />
            <stop offset="30%" stopColor="#2a2a2e" />
            <stop offset="70%" stopColor="#1a1a1e" />
            <stop offset="100%" stopColor="#222226" />
          </linearGradient>

          {/* Rim highlight */}
          <linearGradient id="rimGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.15)" />
            <stop offset="50%" stopColor="rgba(255,255,255,0.02)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0.08)" />
          </linearGradient>

          {/* Screen clip path */}
          <clipPath id="screenClip">
            <rect x={screenX} y={screenY} width={screenW} height={screenH} rx={sr} ry={sr} />
          </clipPath>
        </defs>

        {/* Outer bezel */}
        <rect x={0} y={0} width={w} height={h} rx={fr} ry={fr} fill="url(#bezelGrad)" />

        {/* Rim highlight */}
        <rect x={0.5} y={0.5} width={w - 1} height={h - 1} rx={fr} ry={fr} fill="none" stroke="url(#rimGrad)" strokeWidth={1} />

        {/* Screen background (black) */}
        <rect x={screenX} y={screenY} width={screenW} height={screenH} rx={sr} ry={sr} fill="#000000" />

        {/* Dynamic island (pill notch) */}
        <rect x={notchX} y={notchY} width={notchW} height={notchH} rx={PHONE.notchRadius} ry={PHONE.notchRadius} fill="#000000" />

        {/* Home bar indicator */}
        <rect x={homeBarX} y={homeBarY} width={homeBarW} height={homeBarH} rx={homeBarH / 2} fill="rgba(255,255,255,0.25)" />
      </svg>

      {/* Screen content area (clipped to screen bounds) */}
      <div
        style={{
          position: 'absolute',
          left: screenX,
          top: screenY,
          width: screenW,
          height: screenH,
          borderRadius: sr,
          overflow: 'hidden',
        }}
      >
        {children}
      </div>

      {/* Subtle glow around phone */}
      <div
        style={{
          position: 'absolute',
          inset: -30,
          borderRadius: fr + 30,
          boxShadow: `0 0 60px 20px rgba(233,69,96,${glowOpacity})`,
          pointerEvents: 'none',
        }}
      />
    </div>
  );
};
