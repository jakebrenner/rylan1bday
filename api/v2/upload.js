import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const BUCKET = 'event-photos';
const MAX_SIZE = 5 * 1024 * 1024; // 5MB

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Authenticate
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization' });
  }
  const token = authHeader.split(' ')[1];
  const userClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
  const { data: { user }, error: authError } = await userClient.auth.getUser();
  if (authError || !user) return res.status(401).json({ error: 'Invalid token' });

  try {
    const { base64, eventId, filename } = req.body || {};
    if (!base64) return res.status(400).json({ error: 'Missing base64 image data' });

    // Decode and validate size
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > MAX_SIZE) {
      return res.status(413).json({ error: 'Image too large (max 5MB)' });
    }

    // Ensure bucket exists (will silently fail if already exists)
    await supabase.storage.createBucket(BUCKET, {
      public: true,
      fileSizeLimit: MAX_SIZE,
      allowedMimeTypes: ['image/jpeg', 'image/png', 'image/webp']
    }).catch(() => {});

    // Upload with unique path
    const ext = 'jpg';
    const path = `${user.id}/${eventId || 'general'}/${randomUUID()}.${ext}`;

    const { data, error } = await supabase.storage
      .from(BUCKET)
      .upload(path, buffer, {
        contentType: 'image/jpeg',
        upsert: false
      });

    if (error) {
      console.error('Upload error:', error);
      return res.status(500).json({ error: 'Failed to upload image', message: error.message });
    }

    // Get public URL
    const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(path);
    const publicUrl = urlData?.publicUrl;

    if (!publicUrl) {
      return res.status(500).json({ error: 'Failed to get public URL' });
    }

    return res.status(200).json({ success: true, url: publicUrl, path });
  } catch (err) {
    console.error('Upload handler error:', err);
    return res.status(500).json({ error: 'Upload failed', message: err.message });
  }
}
