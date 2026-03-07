import { ImageResponse } from '@vercel/og';

export const config = {
  runtime: 'edge',
};

export default function handler() {
  return new ImageResponse(
    {
      type: 'div',
      props: {
        style: {
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'linear-gradient(135deg, #1A1A2E 0%, #0f3460 100%)',
          fontFamily: 'sans-serif',
        },
        children: [
          // Logo circle with envelope icon
          {
            type: 'div',
            props: {
              style: {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: '32px',
              },
              children: {
                type: 'svg',
                props: {
                  viewBox: '0 0 120 120',
                  width: '120',
                  height: '120',
                  xmlns: 'http://www.w3.org/2000/svg',
                  children: [
                    {
                      type: 'circle',
                      props: { cx: '60', cy: '60', r: '40', fill: 'none', stroke: '#FFB74D', strokeWidth: '2.5' },
                    },
                    {
                      type: 'path',
                      props: { d: 'M35 45 L60 62 L85 45', fill: 'none', stroke: '#FFB74D', strokeWidth: '2.5', strokeLinecap: 'round', strokeLinejoin: 'round' },
                    },
                    {
                      type: 'path',
                      props: { d: 'M35 75 L85 75', fill: 'none', stroke: '#FFB74D', strokeWidth: '2', strokeLinecap: 'round' },
                    },
                    {
                      type: 'circle',
                      props: { cx: '60', cy: '30', r: '6', fill: '#E94560', opacity: '0.85' },
                    },
                    {
                      type: 'circle',
                      props: { cx: '48', cy: '34', r: '4', fill: '#FF6B6B', opacity: '0.6' },
                    },
                    {
                      type: 'circle',
                      props: { cx: '72', cy: '33', r: '4', fill: '#FFB74D', opacity: '0.6' },
                    },
                    {
                      type: 'circle',
                      props: { cx: '42', cy: '42', r: '3', fill: '#A78BFA', opacity: '0.5' },
                    },
                    {
                      type: 'circle',
                      props: { cx: '78', cy: '40', r: '3', fill: '#4ECDC4', opacity: '0.5' },
                    },
                  ],
                },
              },
            },
          },
          // "Ryvite" text
          {
            type: 'div',
            props: {
              style: {
                fontSize: '72px',
                fontWeight: '700',
                color: 'white',
                letterSpacing: '-1px',
                marginBottom: '8px',
              },
              children: 'Ryvite',
            },
          },
          // Tagline
          {
            type: 'div',
            props: {
              style: {
                fontSize: '32px',
                fontWeight: '600',
                background: 'linear-gradient(135deg, #E94560, #FF6B6B)',
                backgroundClip: 'text',
                color: '#E94560',
                marginBottom: '16px',
              },
              children: 'Prompt to Party',
            },
          },
          // Description
          {
            type: 'div',
            props: {
              style: {
                fontSize: '22px',
                color: 'rgba(255, 255, 255, 0.6)',
                maxWidth: '600px',
                textAlign: 'center',
              },
              children: 'Beautiful, AI-powered invitations. Free for now. Beautiful forever.',
            },
          },
        ],
      },
    },
    {
      width: 1200,
      height: 630,
    }
  );
}
