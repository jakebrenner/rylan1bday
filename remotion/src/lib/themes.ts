export interface VideoTheme {
  name: string;
  bgGradient: string[];
  bgGradientAlt: string[];
  textColor: string;
  subtextColor: string;
  accentColor: string;
  cursorColor: string;
  ctaBg: string;
  ctaText: string;
  logoColor: string;
  particleColor: string;
  particleColor2: string;
  glowColor: string;
}

export const VIDEO_THEMES: Record<string, VideoTheme> = {
  dark_gradient: {
    name: 'Dark Gradient',
    bgGradient: ['#1a0a2e', '#16213e', '#0f3460'],
    bgGradientAlt: ['#0f3460', '#1a0a2e', '#16213e'],
    textColor: '#ffffff',
    subtextColor: '#b8b8d0',
    accentColor: '#E94560',
    cursorColor: '#E94560',
    ctaBg: '#E94560',
    ctaText: '#ffffff',
    logoColor: '#ffffff',
    particleColor: 'rgba(233,69,96,0.6)',
    particleColor2: 'rgba(184,184,208,0.4)',
    glowColor: 'rgba(233,69,96,0.3)',
  },
  light_clean: {
    name: 'Light Clean',
    bgGradient: ['#f0f2f5', '#ffffff', '#e8eaf0'],
    bgGradientAlt: ['#e8eaf0', '#f0f2f5', '#ffffff'],
    textColor: '#1a1a2e',
    subtextColor: '#666680',
    accentColor: '#E94560',
    cursorColor: '#E94560',
    ctaBg: '#E94560',
    ctaText: '#ffffff',
    logoColor: '#1a1a2e',
    particleColor: 'rgba(233,69,96,0.35)',
    particleColor2: 'rgba(100,100,140,0.2)',
    glowColor: 'rgba(233,69,96,0.15)',
  },
  ryvite_brand: {
    name: 'Ryvite Brand',
    bgGradient: ['#0a0a1a', '#111133', '#1a1a3e'],
    bgGradientAlt: ['#1a1a3e', '#0a0a1a', '#111133'],
    textColor: '#ffffff',
    subtextColor: '#a8a8c0',
    accentColor: '#E94560',
    cursorColor: '#E94560',
    ctaBg: '#E94560',
    ctaText: '#ffffff',
    logoColor: '#E94560',
    particleColor: 'rgba(233,69,96,0.7)',
    particleColor2: 'rgba(168,168,192,0.4)',
    glowColor: 'rgba(233,69,96,0.4)',
  },
  warm_sunset: {
    name: 'Warm Sunset',
    bgGradient: ['#ffecd2', '#fcb69f', '#ff9a9e'],
    bgGradientAlt: ['#ff9a9e', '#ffecd2', '#fcb69f'],
    textColor: '#3d1f00',
    subtextColor: '#6b4226',
    accentColor: '#E94560',
    cursorColor: '#E94560',
    ctaBg: '#E94560',
    ctaText: '#ffffff',
    logoColor: '#3d1f00',
    particleColor: 'rgba(233,69,96,0.5)',
    particleColor2: 'rgba(255,154,158,0.4)',
    glowColor: 'rgba(233,69,96,0.2)',
  },
};
