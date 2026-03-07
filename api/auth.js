import crypto from 'crypto';

const GAS_URL = process.env.GAS_URL;
const AUTH_SECRET = process.env.AUTH_SECRET;

function createSessionToken(userId, email) {
  const sessionData = {
    userId,
    email,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
  };
  const payload = Buffer.from(JSON.stringify(sessionData)).toString('base64');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}

export function verifySessionToken(token) {
  if (!token || !AUTH_SECRET) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [payload, sig] = parts;
  const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  if (sig !== expectedSig) return null;

  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
    if (decoded.exp < Date.now()) return null;
    return decoded;
  } catch {
    return null;
  }
}

async function callGAS(action, data) {
  const response = await fetch(GAS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify({ action, ...data }),
    redirect: 'follow'
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/^[a-zA-Z_]\w*\(([\s\S]+)\)$/);
    if (match) return JSON.parse(match[1]);
    throw new Error('Invalid GAS response');
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!GAS_URL) {
    return res.status(500).json({ error: 'GAS_URL not configured' });
  }

  const { action } = req.query;

  try {
    if (action === 'signup') {
      const { email, displayName, phone } = req.body || {};
      if (!email) return res.status(400).json({ error: 'Email is required' });

      const result = await callGAS('signup', { email, displayName, phone });
      return res.status(200).json(result);
    }

    if (action === 'login') {
      const { email } = req.body || {};
      if (!email) return res.status(400).json({ error: 'Email is required' });

      const result = await callGAS('login', { email });
      return res.status(200).json(result);
    }

    if (action === 'verify') {
      const { token } = req.query;
      if (!token) return res.status(400).json({ error: 'Token is required' });

      const result = await callGAS('verifyToken', { token });

      if (result.success && result.user) {
        const sessionToken = createSessionToken(result.user.id, result.user.email);
        return res.status(200).json({
          success: true,
          sessionToken,
          user: result.user
        });
      }

      return res.status(401).json({ success: false, error: result.error || 'Invalid token' });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Auth error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
