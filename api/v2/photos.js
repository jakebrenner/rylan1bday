import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { Resend } from 'resend';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const PROD_URL = 'https://ryvite.com';
const BUCKET = 'event-photos';
const MAX_SIZE = 10 * 1024 * 1024; // 10MB
const NOTIFICATION_COOLDOWN_MS = 15 * 60 * 1000; // 15 minutes

// ---- Helpers (duplicated — Vercel isolates functions) ----

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function toE164(phone) {
  const digits = normalizePhone(phone);
  return digits ? `+1${digits}` : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const action = req.query.action || (req.body && req.body.action);

  try {
    // ---- Public actions (no auth) ----

    if (action === 'upload' && req.method === 'POST') {
      const { eventId, uploaderName, base64, caption, width, height } = req.body || {};

      if (!eventId || !uploaderName || !base64) {
        return res.status(400).json({ error: 'Missing eventId, uploaderName, or base64' });
      }

      // Verify event exists and has photos enabled
      const { data: event, error: eventErr } = await supabaseAdmin
        .from('events')
        .select('id, user_id, title, slug, photos_enabled, status')
        .eq('id', eventId)
        .single();

      if (eventErr || !event) {
        return res.status(404).json({ error: 'Event not found' });
      }
      if (!event.photos_enabled) {
        return res.status(403).json({ error: 'Photo sharing is not enabled for this event' });
      }
      if (event.status !== 'published') {
        return res.status(403).json({ error: 'Event is not published' });
      }

      // Decode and validate size
      const buffer = Buffer.from(base64, 'base64');
      if (buffer.length > MAX_SIZE) {
        return res.status(413).json({ error: 'Image too large (max 10MB)' });
      }

      // Upload to Supabase Storage
      const path = `${eventId}/${randomUUID()}.jpg`;

      const { error: uploadErr } = await supabaseAdmin.storage
        .from(BUCKET)
        .upload(path, buffer, { contentType: 'image/jpeg', upsert: false });

      if (uploadErr) {
        console.error('Photo upload error:', uploadErr);
        return res.status(500).json({ error: 'Failed to upload photo' });
      }

      const { data: urlData } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
      const photoUrl = urlData?.publicUrl;

      if (!photoUrl) {
        return res.status(500).json({ error: 'Failed to get public URL' });
      }

      // Insert photo record
      const { data: photo, error: insertErr } = await supabaseAdmin
        .from('event_photos')
        .insert({
          event_id: eventId,
          uploader_name: uploaderName.slice(0, 100),
          photo_url: photoUrl,
          storage_path: path,
          caption: caption ? caption.slice(0, 500) : null,
          width: width || null,
          height: height || null
        })
        .select('id')
        .single();

      if (insertErr) {
        console.error('Photo insert error:', insertErr);
        return res.status(500).json({ error: 'Failed to save photo record' });
      }

      // Fire-and-forget: send notification to host
      sendPhotoNotification(event).catch(err => {
        console.error('Photo notification error:', err);
      });

      return res.status(200).json({ success: true, photoId: photo.id, url: photoUrl });
    }

    if (action === 'list' && req.method === 'GET') {
      const { eventId, limit, offset } = req.query;
      if (!eventId) return res.status(400).json({ error: 'Missing eventId' });

      // Verify photos are enabled
      const { data: event } = await supabaseAdmin
        .from('events')
        .select('photos_enabled, status')
        .eq('id', eventId)
        .single();

      if (!event || !event.photos_enabled || event.status !== 'published') {
        return res.status(403).json({ error: 'Photos not available' });
      }

      const pageLimit = Math.min(parseInt(limit) || 50, 100);
      const pageOffset = parseInt(offset) || 0;

      const { data: photos, error, count } = await supabaseAdmin
        .from('event_photos')
        .select('id, uploader_name, photo_url, caption, width, height, created_at', { count: 'exact' })
        .eq('event_id', eventId)
        .order('created_at', { ascending: false })
        .range(pageOffset, pageOffset + pageLimit - 1);

      if (error) {
        console.error('Photo list error:', error);
        return res.status(500).json({ error: 'Failed to load photos' });
      }

      return res.status(200).json({ photos: photos || [], total: count || 0 });
    }

    // ---- Download All (auth via query param for direct link) ----

    if (action === 'downloadAll' && req.method === 'GET') {
      const { eventId } = req.query;
      if (!eventId) return res.status(400).json({ error: 'Missing eventId' });

      // Auth via query param token (direct link download)
      const dlToken = req.query.token || (req.headers.authorization || '').slice(7);
      if (!dlToken) return res.status(401).json({ error: 'Unauthorized' });
      const { data: { user: dlUser }, error: dlAuthErr } = await supabaseAdmin.auth.getUser(dlToken);
      if (dlAuthErr || !dlUser) return res.status(401).json({ error: 'Invalid session' });

      const hasAccess = await checkEventAccess(dlUser.id, eventId);
      if (!hasAccess) return res.status(403).json({ error: 'Not authorized' });

      // Get event title for filename
      const { data: dlEvent } = await supabaseAdmin
        .from('events')
        .select('title')
        .eq('id', eventId)
        .single();

      // Fetch all photos
      const { data: photos, error: photosErr } = await supabaseAdmin
        .from('event_photos')
        .select('photo_url, storage_path, uploader_name, created_at')
        .eq('event_id', eventId)
        .order('created_at', { ascending: true });

      if (photosErr || !photos || photos.length === 0) {
        return res.status(404).json({ error: 'No photos found' });
      }

      // Build zip using JSZip
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      const folderName = (dlEvent?.title || 'event').replace(/[^a-zA-Z0-9 _-]/g, '').substring(0, 50) || 'photos';
      const folder = zip.folder(folderName);

      for (let i = 0; i < photos.length; i++) {
        try {
          const { data: fileData, error: dlErr } = await supabaseAdmin.storage
            .from(BUCKET)
            .download(photos[i].storage_path);
          if (dlErr || !fileData) continue;
          const buffer = Buffer.from(await fileData.arrayBuffer());
          const uploaderSlug = (photos[i].uploader_name || 'photo').replace(/[^a-zA-Z0-9]/g, '_').substring(0, 30);
          folder.file(`${uploaderSlug}_${i + 1}.jpg`, buffer);
        } catch (e) {
          console.error('Error fetching photo for zip:', e);
        }
      }

      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
      const safeTitle = (dlEvent?.title || 'event').replace(/[^a-zA-Z0-9 _-]/g, '').substring(0, 50);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${safeTitle}_photos.zip"`);
      res.setHeader('Content-Length', zipBuffer.length);
      return res.send(zipBuffer);
    }

    // ---- Authenticated actions (host/editor) ----

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.slice(7);
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    if (action === 'delete' && req.method === 'POST') {
      const { photoId } = req.body || {};
      if (!photoId) return res.status(400).json({ error: 'Missing photoId' });

      // Get photo and verify ownership
      const { data: photo } = await supabaseAdmin
        .from('event_photos')
        .select('id, event_id, storage_path')
        .eq('id', photoId)
        .single();

      if (!photo) return res.status(404).json({ error: 'Photo not found' });

      // Verify user owns the event or is editor
      const isOwner = await checkEventAccess(user.id, photo.event_id);
      if (!isOwner) return res.status(403).json({ error: 'Not authorized' });

      // Delete from storage
      await supabaseAdmin.storage.from(BUCKET).remove([photo.storage_path]);

      // Delete record
      await supabaseAdmin.from('event_photos').delete().eq('id', photoId);

      return res.status(200).json({ success: true });
    }

    if (action === 'toggle' && req.method === 'POST') {
      const { eventId, enabled } = req.body || {};
      if (!eventId || typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'Missing eventId or enabled' });
      }

      const isOwner = await checkEventAccess(user.id, eventId);
      if (!isOwner) return res.status(403).json({ error: 'Not authorized' });

      const { error } = await supabaseAdmin
        .from('events')
        .update({ photos_enabled: enabled })
        .eq('id', eventId);

      if (error) {
        console.error('Toggle photos error:', error);
        return res.status(500).json({ error: 'Failed to update' });
      }

      return res.status(200).json({ success: true, photos_enabled: enabled });
    }

    if (action === 'count' && req.method === 'GET') {
      const { eventId } = req.query;
      if (!eventId) return res.status(400).json({ error: 'Missing eventId' });

      const isOwner = await checkEventAccess(user.id, eventId);
      if (!isOwner) return res.status(403).json({ error: 'Not authorized' });

      const { count } = await supabaseAdmin
        .from('event_photos')
        .select('id', { count: 'exact', head: true })
        .eq('event_id', eventId);

      return res.status(200).json({ count: count || 0 });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (err) {
    console.error('Photos handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// Check if user owns the event or is editor/owner collaborator
async function checkEventAccess(userId, eventId) {
  const { data: event } = await supabaseAdmin
    .from('events')
    .select('user_id')
    .eq('id', eventId)
    .single();

  if (event?.user_id === userId) return true;

  const { data: collab } = await supabaseAdmin
    .from('event_collaborators')
    .select('role')
    .eq('event_id', eventId)
    .eq('user_id', userId)
    .single();

  return collab?.role === 'owner' || collab?.role === 'editor';
}

// Send batched photo notification to host (throttled to once per 15 min)
async function sendPhotoNotification(event) {
  // Check notification prefs
  const { data: prefs } = await supabaseAdmin
    .from('event_notification_prefs')
    .select('notify_on_rsvp, notify_mode, notify_phone')
    .eq('event_id', event.id)
    .single();

  // Re-use RSVP notification prefs — if host wants RSVP notifications, they'll want photo ones too
  if (!prefs?.notify_on_rsvp || prefs.notify_mode !== 'instant') return;

  // Check cooldown — don't send more than once per 15 minutes per event
  const { data: recentNotif } = await supabaseAdmin
    .from('notification_log')
    .select('id')
    .eq('event_id', event.id)
    .eq('channel', 'sms')
    .eq('status', 'photo_upload')
    .gte('sent_at', new Date(Date.now() - NOTIFICATION_COOLDOWN_MS).toISOString())
    .limit(1)
    .single();

  if (recentNotif) return; // Already notified recently

  // Count recent photos (since last notification)
  const { count: photoCount } = await supabaseAdmin
    .from('event_photos')
    .select('id', { count: 'exact', head: true })
    .eq('event_id', event.id);

  const galleryUrl = `${PROD_URL}/v2/event/${event.slug}/photos`;
  const photoLabel = photoCount === 1 ? '1 photo has' : `${photoCount} photos have`;

  // Send SMS
  const phone = prefs.notify_phone;
  if (phone) {
    const e164 = toE164(phone);
    if (e164) {
      const body = `${photoLabel} been shared to ${event.title || 'your event'}! View them: ${galleryUrl}`;

      const CLICKSEND_USERNAME = process.env.CLICKSEND_USERNAME;
      const CLICKSEND_API_KEY = process.env.CLICKSEND_API_KEY;
      if (CLICKSEND_USERNAME && CLICKSEND_API_KEY) {
        const credentials = Buffer.from(`${CLICKSEND_USERNAME}:${CLICKSEND_API_KEY}`).toString('base64');
        await fetch('https://rest.clicksend.com/v3/sms/send', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Basic ${credentials}`
          },
          body: JSON.stringify({
            messages: [{ to: e164, body, source: 'ryvite-photos' }]
          })
        });
      }
    }
  }

  // Log the notification for cooldown tracking
  await supabaseAdmin.from('notification_log').insert({
    event_id: event.id,
    channel: 'sms',
    recipient: phone || 'host',
    status: 'photo_upload',
    sent_at: new Date().toISOString()
  }).catch(() => {});

  // Send email to host
  if (resend) {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('email, display_name')
      .eq('id', event.user_id)
      .single();

    if (profile?.email) {
      const firstName = profile.display_name ? profile.display_name.split(' ')[0] : 'there';
      await resend.emails.send({
        from: 'Ryvite <hello@ryvite.com>',
        to: profile.email,
        subject: `New photos shared to ${event.title || 'your event'}!`,
        html: buildPhotoNotificationEmail(firstName, event.title, photoCount, galleryUrl)
      }).catch(err => console.error('Photo email error:', err));
    }
  }
}

function buildPhotoNotificationEmail(firstName, eventTitle, photoCount, galleryUrl) {
  const photoLabel = photoCount === 1 ? '1 photo' : `${photoCount} photos`;
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin: 0; padding: 0; font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif; background-color: #f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color: #f5f5f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%;">
          <tr>
            <td style="background-color: #1A1A2E; padding: 32px 40px; border-radius: 16px 16px 0 0; text-align: center;">
              <h1 style="margin: 0; font-family: 'Playfair Display', Georgia, serif; color: #FFFAF5; font-size: 28px; font-weight: 700;">
                New Photos Shared!
              </h1>
            </td>
          </tr>
          <tr>
            <td style="background-color: #FFFAF5; padding: 40px;">
              <p style="margin: 0 0 16px; color: #1A1A2E; font-size: 16px; line-height: 1.6;">
                Hey ${firstName},
              </p>
              <p style="margin: 0 0 24px; color: #1A1A2E; font-size: 16px; line-height: 1.6;">
                Your guests have been sharing memories! <strong>${photoLabel}</strong> ${photoCount === 1 ? 'has' : 'have'} been uploaded to <strong>${eventTitle || 'your event'}</strong>.
              </p>
              <div style="text-align: center; margin: 32px 0;">
                <a href="${galleryUrl}" style="display: inline-block; background-color: #E94560; color: #ffffff; text-decoration: none; padding: 14px 32px; border-radius: 50px; font-size: 16px; font-weight: 600;">
                  View Photos
                </a>
              </div>
              <p style="margin: 0; color: #6B7280; font-size: 14px; line-height: 1.6; text-align: center;">
                You can manage photos from your dashboard.
              </p>
            </td>
          </tr>
          <tr>
            <td style="background-color: #1A1A2E; padding: 20px 40px; border-radius: 0 0 16px 16px; text-align: center;">
              <p style="margin: 0; color: #6B7280; font-size: 12px;">Built with love for Rylan</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}
