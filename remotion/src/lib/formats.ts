export interface FormatConfig {
  width: number;
  height: number;
  logoY: number;
  logoSize: number;
  labelFontSize: number;
  labelY: number;
  phoneWidth: number;
  phoneHeight: number;
  phoneY: number;
  promptFontSize: number;
  promptLineHeight: number;
  promptLabelSize: number;
  ctaY: number;
  ctaFontSize: number;
  particleCount: number;
}

export const FORMAT_CONFIGS: Record<string, FormatConfig> = {
  reels_9x16: {
    width: 1080,
    height: 1920,
    logoY: 60,
    logoSize: 46,
    labelFontSize: 22,
    labelY: 118,
    phoneWidth: 460,
    phoneHeight: 998,
    phoneY: 200,
    promptFontSize: 28,
    promptLineHeight: 42,
    promptLabelSize: 16,
    ctaY: 1760,
    ctaFontSize: 32,
    particleCount: 30,
  },
  feed_1x1: {
    width: 1440,
    height: 1440,
    logoY: 45,
    logoSize: 46,
    labelFontSize: 22,
    labelY: 105,
    phoneWidth: 490,
    phoneHeight: 1062,
    phoneY: 160,
    promptFontSize: 28,
    promptLineHeight: 42,
    promptLabelSize: 16,
    ctaY: 1290,
    ctaFontSize: 32,
    particleCount: 25,
  },
};

// Phone frame constants (iPhone 15 styling)
export const PHONE = {
  bezelGradient: ['#2a2a2e', '#1a1a1e'] as const,
  bezelAngle: 145,
  frameRadius: 52,
  screenRadius: 44,
  bezelWidth: 12,
  notchWidthRatio: 0.3,
  notchHeight: 24,
  notchRadius: 12,
  homeBarWidth: 100,
  homeBarHeight: 5,
  shadowBlur: 64,
  shadowOffsetY: 24,
  shadowAlpha: 0.35,
};

/** Compute the phone screen content area dimensions */
export function getScreenArea(fmt: FormatConfig) {
  const bw = PHONE.bezelWidth;
  const screenW = fmt.phoneWidth - bw * 2;
  const screenH = fmt.phoneHeight - bw * 2 - 12;
  const contentH = screenH - PHONE.notchHeight - 4;
  return {
    phoneX: (fmt.width - fmt.phoneWidth) / 2,
    phoneY: fmt.phoneY,
    screenX: (fmt.width - fmt.phoneWidth) / 2 + bw,
    screenY: fmt.phoneY + bw,
    screenW,
    screenH,
    contentX: (fmt.width - fmt.phoneWidth) / 2 + bw,
    contentY: fmt.phoneY + bw + PHONE.notchHeight + 2,
    contentW: screenW,
    contentH,
  };
}
