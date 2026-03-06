const GAS_URL = process.env.GAS_URL;

export default async function handler(req, res) {
  if (!GAS_URL) {
    return res.status(500).json({ error: 'GAS_URL not configured' });
  }

  try {
    if (req.method === 'GET') {
      // Forward query params to GAS
      const params = new URLSearchParams(req.query).toString();
      const url = GAS_URL + (params ? '?' + params : '');
      const response = await fetch(url, { redirect: 'follow' });
      const data = await response.json();
      return res.status(200).json(data);
    }

    if (req.method === 'POST') {
      // Forward POST body to GAS
      const response = await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
        redirect: 'follow',
      });
      const text = await response.text();
      try {
        return res.status(200).json(JSON.parse(text));
      } catch {
        return res.status(200).json({ status: 'ok', raw: text });
      }
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('GAS proxy error:', error);
    return res.status(502).json({ error: 'Failed to reach backend' });
  }
}
