/** Animation timing constants — matches original ad-video-generator.js */

export const FPS = 30;

// Phase durations (milliseconds)
export const CHAR_MS = 55;
export const INTRO_MS = 800;
export const POST_TYPE_PAUSE = 600;
export const DISSOLVE_MS = 500;
export const SHIMMER_MS = 1200;
export const REVEAL_MS = 1200;
export const SCROLL_PX_PER_SEC = 100;
export const MAX_SCROLL_MS = 6000;
export const HOLD_MS = 2000;
export const END_HOLD_MS = 1500;
export const CTA_MS = 1500;
export const BG_CYCLE_MS = 12000;

/** Convert milliseconds to frames at FPS */
export function msToFrames(ms: number): number {
  return Math.round((ms / 1000) * FPS);
}

/** Compute the full timeline given prompt length and scroll distance */
export function computeTimeline(promptLength: number, scrollDistance: number) {
  const typingMs = promptLength * CHAR_MS;
  const rawScrollMs = scrollDistance > 0 ? (scrollDistance / SCROLL_PX_PER_SEC) * 1000 : 0;
  const scrollMs = Math.min(rawScrollMs, MAX_SCROLL_MS);
  const displayMs = HOLD_MS + (scrollMs || HOLD_MS) + END_HOLD_MS;
  const totalMs = INTRO_MS + typingMs + POST_TYPE_PAUSE + DISSOLVE_MS + SHIMMER_MS + REVEAL_MS + displayMs + CTA_MS;

  return {
    typingMs,
    scrollMs,
    displayMs,
    totalMs,
    // Phase start times (ms)
    introEnd: INTRO_MS,
    typeEnd: INTRO_MS + typingMs,
    pauseEnd: INTRO_MS + typingMs + POST_TYPE_PAUSE,
    dissolveEnd: INTRO_MS + typingMs + POST_TYPE_PAUSE + DISSOLVE_MS,
    shimmerEnd: INTRO_MS + typingMs + POST_TYPE_PAUSE + DISSOLVE_MS + SHIMMER_MS,
    revealEnd: INTRO_MS + typingMs + POST_TYPE_PAUSE + DISSOLVE_MS + SHIMMER_MS + REVEAL_MS,
    holdEnd: INTRO_MS + typingMs + POST_TYPE_PAUSE + DISSOLVE_MS + SHIMMER_MS + REVEAL_MS + HOLD_MS,
    scrollEnd: INTRO_MS + typingMs + POST_TYPE_PAUSE + DISSOLVE_MS + SHIMMER_MS + REVEAL_MS + HOLD_MS + (scrollMs || HOLD_MS),
    endHoldEnd: INTRO_MS + typingMs + POST_TYPE_PAUSE + DISSOLVE_MS + SHIMMER_MS + REVEAL_MS + HOLD_MS + (scrollMs || HOLD_MS) + END_HOLD_MS,
    // Frame equivalents
    totalFrames: msToFrames(totalMs),
  };
}
