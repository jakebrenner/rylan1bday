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
              fontFamily: 'sans-serif',
              fontSize: '28px',
              fontWeight: 700,
              color: '#1A1A2E',
              letterSpacing: '-0.5px',
            },
            children: [
              // Envelope icon
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '28px',
                    height: '28px',
                    background: '#E94560',
                    borderRadius: '6px',
                    marginRight: '8px',
                    fontSize: '16px',
                    color: '#FFFFFF',
                  },
                  children: 'R',
                },
              },
              'yvite',
            ],
          },
        },
      },
    },
    {
      width: 160,
      height: 48,
    }
  );
}
