export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  const webhookUrl = body.webhookUrl;

  if (!webhookUrl || !webhookUrl.startsWith('https://hooks.zapier.com/')) {
    return res.status(400).json({ error: 'Invalid or missing Zapier webhook URL' });
  }

  // Strip webhookUrl from the payload before forwarding
  const { webhookUrl: _, ...payload } = body;

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    return res.status(response.ok ? 200 : 502).json({
      status: response.ok ? 'ok' : 'error',
      detail: text.substring(0, 500),
    });
  } catch (error) {
    console.error('Webhook proxy error:', error.message || error);
    return res.status(502).json({ error: 'Failed to reach webhook', detail: error.message });
  }
}
