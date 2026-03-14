import { ImageResponse } from '@vercel/og';

export const config = {
  runtime: 'edge',
};

// Load Playfair Display for the wordmark
const playfairFontPromise = fetch(
  'https://fonts.gstatic.com/s/playfairdisplay/v37/nuFvD-vYSZviVYUb_rj3ij__anPXJzDwcbmjWBN2PKdFvXDTbtPY_Q.woff'
).then(res => res.arrayBuffer()).catch(() => null);

// Build the circle-envelope SVG as a data URI (Satori doesn't support SVG child elements in JSX)
function buildIconDataUri(color) {
  const svg = `<svg viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg"><circle cx="32" cy="32" r="22" fill="none" stroke="${color}" stroke-width="2.2"/><path d="M18 24 L32 36 L46 24" fill="none" stroke="${color}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 42 L46 42" fill="none" stroke="${color}" stroke-width="1.8" stroke-linecap="round"/></svg>`;
  // Edge runtime: use btoa for base64 encoding
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

export default async function handler(req) {
  const url = new URL(req.url);
  const variant = url.searchParams.get('variant') || 'light';
  const isDark = variant === 'dark';

  const iconColor = isDark ? '#FFB74D' : '#E94560';
  const textColor = isDark ? '#FFFFFF' : '#1A1A2E';
  const iconDataUri = buildIconDataUri(iconColor);

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
              // Circle envelope icon as data URI image
              {
                type: 'img',
                props: {
                  src: iconDataUri,
                  width: 40,
                  height: 40,
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
