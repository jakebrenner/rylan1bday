import { createClient } from '@supabase/supabase-js';
import { reportApiError } from './lib/error-reporter.js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  try {
    const { data, error } = await supabase
      .from('featured_showcases')
      .select('id, prompt_text, html, css, config, event_title, event_type, display_order')
      .order('display_order', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });

    return res.status(200).json({ showcases: data || [] });
  } catch (err) {
    console.error('Showcases API error:', err);
    await reportApiError({ endpoint: '/api/v2/showcases', action: 'list', error: err, requestBody: null, req }).catch(() => {});
    return res.status(500).json({ error: 'Server error' });
  }
}
