import React from 'react';
import { Composition } from 'remotion';
import { AdVideo } from './AdVideo';
import type { AdVideoProps } from './AdVideo';
import { FORMAT_CONFIGS } from './lib/formats';
import { FPS, computeTimeline } from './lib/timing';
import { getScreenArea } from './lib/formats';

/**
 * Calculate total duration dynamically based on input props.
 * This ensures each video is exactly as long as it needs to be.
 */
function calculateDuration(props: AdVideoProps) {
  const fmt = FORMAT_CONFIGS[props.format] || FORMAT_CONFIGS.reels_9x16;
  const screen = getScreenArea(fmt);
  const inviteDrawHeight = (props.inviteHeight / props.inviteWidth) * screen.contentW;
  const scrollDistance = Math.max(0, inviteDrawHeight - screen.contentH);
  const tl = computeTimeline(props.promptText.length, scrollDistance);
  return tl.totalFrames;
}

/** Default props for preview/testing */
const defaultProps: AdVideoProps = {
  inviteImageUrl: 'https://placehold.co/786x2400/FFFAF5/1A1A2E?text=Invite+Preview',
  promptText: 'Design a magical unicorn birthday party invite for Emma turning 5',
  format: 'reels_9x16',
  theme: 'dark_gradient',
  inviteWidth: 786,
  inviteHeight: 2400,
};

export const Root: React.FC = () => {
  const reelsFmt = FORMAT_CONFIGS.reels_9x16;
  const feedFmt = FORMAT_CONFIGS.feed_1x1;

  return (
    <>
      {/* Reels (9:16) composition */}
      <Composition
        id="AdVideo-Reels"
        component={AdVideo}
        fps={FPS}
        width={reelsFmt.width}
        height={reelsFmt.height}
        durationInFrames={calculateDuration({ ...defaultProps, format: 'reels_9x16' })}
        defaultProps={{ ...defaultProps, format: 'reels_9x16' }}
        calculateMetadata={async ({ props }) => {
          const dur = calculateDuration(props);
          return { durationInFrames: dur, fps: FPS, width: reelsFmt.width, height: reelsFmt.height };
        }}
      />

      {/* Feed (1:1) composition */}
      <Composition
        id="AdVideo-Feed"
        component={AdVideo}
        fps={FPS}
        width={feedFmt.width}
        height={feedFmt.height}
        durationInFrames={calculateDuration({ ...defaultProps, format: 'feed_1x1' })}
        defaultProps={{ ...defaultProps, format: 'feed_1x1' }}
        calculateMetadata={async ({ props }) => {
          const dur = calculateDuration(props);
          return { durationInFrames: dur, fps: FPS, width: feedFmt.width, height: feedFmt.height };
        }}
      />

      {/* Generic composition (format from props) */}
      <Composition
        id="AdVideo"
        component={AdVideo}
        fps={FPS}
        width={reelsFmt.width}
        height={reelsFmt.height}
        durationInFrames={calculateDuration(defaultProps)}
        defaultProps={defaultProps}
        calculateMetadata={async ({ props }) => {
          const fmt = FORMAT_CONFIGS[props.format] || FORMAT_CONFIGS.reels_9x16;
          const dur = calculateDuration(props);
          return { durationInFrames: dur, fps: FPS, width: fmt.width, height: fmt.height };
        }}
      />
    </>
  );
};
