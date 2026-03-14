import { ImageResponse } from '@vercel/og';

export const config = {
  runtime: 'edge',
};

// Load Playfair Display for the wordmark
const playfairFontPromise = fetch(
  'https://fonts.gstatic.com/s/playfairdisplay/v37/nuFvD-vYSZviVYUb_rj3ij__anPXJzDwcbmjWBN2PKdFvXDTbtPY_Q.woff'
).then(res => res.arrayBuffer()).catch(() => null);

export default async function handler(req) {
  const url = new URL(req.url);
  const variant = url.searchParams.get('variant') || 'light';
  const isDark = variant === 'dark';

  const iconColor = isDark ? '#FFB74D' : '#E94560';
  const textColor = isDark ? '#FFFFFF' : '#1A1A2E';

  const fontData = await playfairFontPromise;

  return new ImageResponse(
    {
      type: 'div',
      props: {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '100%',
          height: '100%',
          background: 'transparent',
        },
        children: {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
            },
            children: [
              // Circle envelope icon using SVG (same paths as nav bar logo)
              {
                type: 'svg',
                props: {
                  viewBox: '0 0 64 64',
                  width: '40',
                  height: '40',
                  xmlns: 'http://www.w3.org/2000/svg',
                  children: [
                    // Circle
                    {
                      type: 'circle',
                      props: { cx: '32', cy: '32', r: '22', fill: 'none', stroke: iconColor, strokeWidth: '2.2' },
                    },
                    // Envelope flap (V shape)
                    {
                      type: 'path',
                      props: {
                        d: 'M18 24 L32 36 L46 24',
                        fill: 'none',
                        stroke: iconColor,
                        strokeWidth: '2.2',
                        strokeLinecap: 'round',
                        strokeLinejoin: 'round',
                      },
                    },
                    // Envelope bottom line
                    {
                      type: 'path',
                      props: {
                        d: 'M18 42 L46 42',
                        fill: 'none',
                        stroke: iconColor,
                        strokeWidth: '1.8',
                        strokeLinecap: 'round',
                      },
                    },
                  ],
                },
              },
              // Wordmark in Playfair Display
              {
                type: 'div',
                props: {
                  style: {
                    fontFamily: '"Playfair Display", serif',
                    fontSize: '28px',
                    fontWeight: 700,
                    color: textColor,
                    letterSpacing: '-0.5px',
                    lineHeight: 1,
                  },
                  children: 'Ryvite',
                },
              },
            ],
          },
        },
      },
    },
    {
      width: 200,
      height: 56,
      fonts: fontData ? [
        {
          name: 'Playfair Display',
          data: fontData,
          style: 'normal',
          weight: 700,
        },
      ] : [],
    }
  );
}
