import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { FPS, CHAR_MS } from '../lib/timing';
import type { FormatConfig } from '../lib/formats';

interface TypingPromptProps {
  promptText: string;
  fmt: FormatConfig;
  screenW: number;
  screenH: number;
  /** 0→1 dissolve progress (1 = fully dissolved) */
  dissolveProgress: number;
}

/**
 * Typing animation on the phone screen.
 * White card with "YOUR PROMPT" label, character-by-character text reveal, blinking cursor.
 */
export const TypingPrompt: React.FC<TypingPromptProps> = ({ promptText, fmt, screenW, screenH, dissolveProgress }) => {
  const frame = useCurrentFrame();
  const elapsed = (frame / FPS) * 1000;

  // Character count based on elapsed time within typing phase
  const charCount = Math.min(promptText.length, Math.floor(elapsed / CHAR_MS));
  const displayText = promptText.substring(0, charCount);

  // Blinking cursor
  const cursorBlink = Math.sin(elapsed / 400 * Math.PI) > 0;
  const showCursor = charCount < promptText.length || cursorBlink;

  // Card dimensions
  const cardPadSide = 24;
  const cardPadTop = 50;
  const cardPadBottom = 30;
  const cardW = screenW - cardPadSide * 2;

  // Dissolve fade
  const opacity = interpolate(dissolveProgress, [0, 1], [1, 0], { extrapolateRight: 'clamp' });

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        opacity,
      }}
    >
      <div
        style={{
          width: cardW,
          backgroundColor: '#ffffff',
          borderRadius: 18,
          padding: `${cardPadTop}px ${cardPadSide}px ${cardPadBottom}px`,
          boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
          border: '1px solid rgba(0,0,0,0.06)',
          transform: 'translateY(-20px)',
        }}
      >
        {/* Label */}
        <div
          style={{
            position: 'absolute',
            top: 20,
            left: 0,
            right: 0,
            textAlign: 'center',
            fontFamily: '"Inter", sans-serif',
            fontWeight: 700,
            fontSize: fmt.promptLabelSize || 16,
            color: '#E94560',
            letterSpacing: '0.05em',
          }}
        >
          YOUR PROMPT
        </div>

        {/* Typed text */}
        <div
          style={{
            fontFamily: '"Inter", "Helvetica Neue", Arial, sans-serif',
            fontSize: fmt.promptFontSize,
            lineHeight: `${fmt.promptLineHeight}px`,
            color: '#1a1a2e',
            textAlign: 'center',
            minHeight: fmt.promptLineHeight,
            wordBreak: 'break-word',
          }}
        >
          {displayText}
          {showCursor && (
            <span
              style={{
                display: 'inline-block',
                width: 2,
                height: fmt.promptFontSize - 4,
                backgroundColor: '#E94560',
                marginLeft: 4,
                verticalAlign: 'middle',
                transform: 'translateY(-2px)',
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
};
