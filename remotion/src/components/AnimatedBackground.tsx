import React, { useMemo } from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import type { VideoTheme } from '../lib/themes';
import { FPS, BG_CYCLE_MS } from '../lib/timing';

interface AnimatedBackgroundProps {
  width: number;
  height: number;
  theme: VideoTheme;
  particleCount: number;
}

interface Particle {
  x: number;
  y: number;
  size: number;
  speed: number;
  phase: number;
  twinkleSpeed: number;
  drift: number;
  type: 'star' | 'dot';
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result
    ? { r: parseInt(result[1], 16), g: parseInt(result[2], 16), b: parseInt(result[3], 16) }
    : { r: 0, g: 0, b: 0 };
}

function lerpColor(c1: string, c2: string, t: number): string {
  const a = hexToRgb(c1);
  const b = hexToRgb(c2);
  const r = Math.round(a.r + (b.r - a.r) * t);
  const g = Math.round(a.g + (b.g - a.g) * t);
  const bl = Math.round(a.b + (b.b - a.b) * t);
  return `rgb(${r},${g},${bl})`;
}

/** Seeded random for deterministic particles */
function seededRandom(seed: number): number {
  const x = Math.sin(seed * 12.9898 + seed * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

export const AnimatedBackground: React.FC<AnimatedBackgroundProps> = ({ width, height, theme, particleCount }) => {
  const frame = useCurrentFrame();
  const elapsed = (frame / FPS) * 1000;

  // Gradient blend oscillation
  const cycle = (elapsed % BG_CYCLE_MS) / BG_CYCLE_MS;
  const blend = (Math.sin(cycle * Math.PI * 2) + 1) / 2;

  // Interpolate gradient stops
  const stops = theme.bgGradient.map((color, i) => {
    const altColor = theme.bgGradientAlt[i];
    return lerpColor(color, altColor, blend);
  });

  const gradientCss = `linear-gradient(180deg, ${stops.map((s, i) => `${s} ${(i / (stops.length - 1)) * 100}%`).join(', ')})`;

  // Deterministic particles (seeded so they're stable across frames)
  const particles = useMemo<Particle[]>(() => {
    return Array.from({ length: particleCount }, (_, i) => ({
      x: seededRandom(i * 7 + 1) * width,
      y: seededRandom(i * 7 + 2) * height,
      size: 1.5 + seededRandom(i * 7 + 3) * 3,
      speed: 0.15 + seededRandom(i * 7 + 4) * 0.4,
      phase: seededRandom(i * 7 + 5) * Math.PI * 2,
      twinkleSpeed: 1.5 + seededRandom(i * 7 + 6) * 3,
      drift: (seededRandom(i * 7 + 7) - 0.5) * 0.3,
      type: seededRandom(i * 7 + 8) > 0.6 ? 'star' as const : 'dot' as const,
    }));
  }, [particleCount, width, height]);

  return (
    <AbsoluteFill>
      {/* Animated gradient background */}
      <div style={{ width, height, background: gradientCss }} />

      {/* Particles */}
      {particles.map((p, i) => {
        const sec = elapsed / 1000;
        const twinkle = 0.3 + 0.7 * Math.abs(Math.sin(sec * p.twinkleSpeed + p.phase));
        const y = ((p.y - sec * p.speed * 30) % (height + 40) + height + 40) % (height + 40) - 20;
        const x = p.x + Math.sin(sec * 0.5 + p.phase) * 20 * p.drift;
        const color = i % 2 === 0 ? theme.particleColor : theme.particleColor2;

        if (p.type === 'star') {
          // 4-point star sparkle
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: x - p.size,
                top: y - p.size,
                width: p.size * 2,
                height: p.size * 2,
                opacity: twinkle,
                pointerEvents: 'none',
              }}
            >
              <svg width={p.size * 2} height={p.size * 2} viewBox="0 0 20 20">
                <path
                  d="M10 0 L12 8 L20 10 L12 12 L10 20 L8 12 L0 10 L8 8 Z"
                  fill={color}
                />
              </svg>
            </div>
          );
        }

        // Dot particle with glow
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: x - p.size / 2,
              top: y - p.size / 2,
              width: p.size,
              height: p.size,
              borderRadius: '50%',
              backgroundColor: color,
              opacity: twinkle,
              boxShadow: `0 0 ${p.size * 2}px ${color}`,
              pointerEvents: 'none',
            }}
          />
        );
      })}
    </AbsoluteFill>
  );
};
