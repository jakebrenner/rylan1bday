const GAS_URL = process.env.GAS_URL;

export default async function handler(req, res) {
  if (!GAS_URL) {
    return res.status(500).json({ error: 'GAS_URL not configured' });
  }

  try {
    let gasResponse;

    if (req.method === 'GET') {
      const params = new URLSearchParams(req.query).toString();
      const url = GAS_URL + (params ? '?' + params : '');
      gasResponse = await fetch(url, { redirect: 'follow' });
    } else if (req.method === 'POST') {
      gasResponse = await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
        redirect: 'follow',
      });
    } else {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    const text = await gasResponse.text();

    // Try to parse as JSON
    try {
      const data = JSON.parse(text);
      return res.status(200).json(data);
    } catch {
      // GAS might return HTML error page or unexpected format
      console.error('GAS non-JSON response:', text.substring(0, 500));
      return res.status(200).json({ status: 'ok', raw: text.substring(0, 200) });
    }
  } catch (error) {
    console.error('GAS proxy error:', error.message || error);
    return res.status(502).json({ error: 'Failed to reach backend', detail: error.message });
  }
}
