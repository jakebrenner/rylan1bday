import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const resend = new Resend(process.env.RESEND_API_KEY);

const PROD_URL = 'https://ryvite.com';

function getBaseUrl(req) {
  const origin = req.headers.origin;
  if (origin) return origin;
  return process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : PROD_URL;
}

async function getUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

async function checkEventAccess(userId, eventId, requiredRole = 'viewer') {
  const { data: event } = await supabaseAdmin
    .from('events')
    .select('user_id')
    .eq('id', eventId)
    .single();

  if (!event) return { allowed: false, role: null };
  if (event.user_id === userId) return { allowed: true, role: 'owner' };

  const { data: collab } = await supabaseAdmin
    .from('event_collaborators')
    .select('role')
    .eq('event_id', eventId)
    .eq('user_id', userId)
    .single();

  if (!collab) return { allowed: false, role: null };

  const hierarchy = { owner: 3, editor: 2, viewer: 1 };
  return {
    allowed: (hierarchy[collab.role] || 0) >= (hierarchy[requiredRole] || 0),
    role: collab.role
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    // ---- Public actions (no auth required) ----

    if (action === 'getInvitation') {
      const { token } = req.query;
      if (!token) return res.status(400).json({ success: false, error: 'Token required' });

      const { data: invite, error } = await supabaseAdmin
        .from('cohost_invitations')
        .select('*, events(id, title, event_date, location_name, location_address, slug), inviter:invited_by(display_name, email)')
        .eq('token', token)
        .single();

      if (error || !invite) {
        return res.status(404).json({ success: false, error: 'Invitation not found' });
      }

      if (invite.status !== 'pending') {
        return res.status(200).json({
          success: true,
          invitation: {
            status: invite.status,
            eventTitle: invite.events?.title,
            eventSlug: invite.events?.slug
          }
        });
      }

      // Check expiration
      if (new Date(invite.expires_at) < new Date()) {
        await supabaseAdmin
          .from('cohost_invitations')
          .update({ status: 'expired' })
          .eq('id', invite.id);

        return res.status(200).json({
          success: true,
          invitation: { status: 'expired', eventTitle: invite.events?.title }
        });
      }

      return res.status(200).json({
        success: true,
        invitation: {
          id: invite.id,
          status: invite.status,
          role: invite.role,
          email: invite.email,
          eventId: invite.event_id,
          eventTitle: invite.events?.title,
          eventDate: invite.events?.event_date,
          eventLocation: invite.events?.location_name,
          eventAddress: invite.events?.location_address,
          eventSlug: invite.events?.slug,
          inviterName: invite.inviter?.display_name || invite.inviter?.email || 'Someone',
          expiresAt: invite.expires_at
        }
      });
    }

    // ---- Authenticated actions ----

    const user = await getUser(req);
    if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

    // ---- INVITE CO-HOST ----
    if (action === 'invite') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { eventId, email, role } = req.body || {};
      if (!eventId || !email) {
        return res.status(400).json({ success: false, error: 'eventId and email required' });
      }

      // Only owners can invite co-hosts
      const access = await checkEventAccess(user.id, eventId, 'owner');
      if (!access.allowed || access.role !== 'owner') {
        return res.status(403).json({ success: false, error: 'Only event owners can invite co-hosts' });
      }

      // Check if already a collaborator
      const { data: existingUser } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .ilike('email', email)
        .single();

      if (existingUser) {
        const { data: existingCollab } = await supabaseAdmin
          .from('event_collaborators')
          .select('id')
          .eq('event_id', eventId)
          .eq('user_id', existingUser.id)
          .single();

        if (existingCollab) {
          return res.status(409).json({ success: false, error: 'This person is already a co-host' });
        }
      }

      // Can't invite yourself
      if (user.email && email.toLowerCase() === user.email.toLowerCase()) {
        return res.status(400).json({ success: false, error: 'You cannot invite yourself' });
      }

      const validRole = (role === 'editor' || role === 'viewer') ? role : 'editor';

      // Create or update invitation
      const { data: invite, error } = await supabaseAdmin
        .from('cohost_invitations')
        .upsert({
          event_id: eventId,
          email: email.toLowerCase(),
          role: validRole,
          invited_by: user.id,
          status: 'pending',
          expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
        }, { onConflict: 'event_id,email' })
        .select()
        .single();

      if (error) return res.status(400).json({ success: false, error: error.message });

      // Fetch event details for the email
      const { data: event } = await supabaseAdmin
        .from('events')
        .select('title, event_date, location_name')
        .eq('id', eventId)
        .single();

      // Fetch inviter's name
      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('display_name')
        .eq('id', user.id)
        .single();

      const inviterName = profile?.display_name || user.email;
      const baseUrl = getBaseUrl(req);
      const acceptUrl = `${baseUrl}/v2/cohost/?token=${invite.token}`;
      const eventDate = event?.event_date
        ? new Date(event.event_date).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
        : '';
      const roleName = validRole === 'editor' ? 'Co-Host' : 'Viewer';

      // Send email via Resend
      try {
        await resend.emails.send({
          from: 'Ryvite <noreply@ryvite.com>',
          to: email,
          subject: `${inviterName} invited you to co-host "${event?.title || 'an event'}" on Ryvite`,
          html: `
            <div style="font-family: 'Inter', Arial, sans-serif; max-width: 520px; margin: 0 auto; padding: 32px 24px; background: #FFFAF5; border-radius: 16px;">
              <div style="text-align: center; margin-bottom: 24px;">
                <span style="font-family: 'Playfair Display', Georgia, serif; font-size: 28px; font-weight: 700; color: #1A1A2E;">Ryvite</span>
              </div>
              <div style="background: white; border-radius: 12px; padding: 28px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
                <h2 style="font-size: 20px; color: #1A1A2E; margin: 0 0 16px;">You're invited to co-host!</h2>
                <p style="color: #555; font-size: 15px; line-height: 1.6; margin: 0 0 16px;">
                  <strong>${inviterName}</strong> has invited you as a <strong>${roleName}</strong> for:
                </p>
                <div style="background: #f8f4f0; border-radius: 8px; padding: 16px; margin-bottom: 20px;">
                  <div style="font-size: 18px; font-weight: 600; color: #1A1A2E; margin-bottom: 6px;">${event?.title || 'Event'}</div>
                  ${eventDate ? `<div style="font-size: 14px; color: #666;">${eventDate}</div>` : ''}
                  ${event?.location_name ? `<div style="font-size: 14px; color: #666;">${event.location_name}</div>` : ''}
                </div>
                <div style="text-align: center;">
                  <a href="${acceptUrl}" style="display: inline-block; background: #E94560; color: white; padding: 14px 32px; border-radius: 8px; font-weight: 600; font-size: 15px; text-decoration: none;">View Invitation</a>
                </div>
                <p style="color: #999; font-size: 12px; margin-top: 20px; text-align: center;">
                  This invitation expires in 7 days.
                </p>
              </div>
            </div>
          `
        });
      } catch (emailErr) {
        console.error('Failed to send co-host invitation email:', emailErr);
        // Don't fail the request - the invitation was still created
      }

      return res.status(200).json({ success: true, invitationId: invite.id });
    }

    // ---- ACCEPT INVITATION ----
    if (action === 'accept') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { token } = req.body || {};
      if (!token) return res.status(400).json({ success: false, error: 'Token required' });

      const { data: invite } = await supabaseAdmin
        .from('cohost_invitations')
        .select('*')
        .eq('token', token)
        .eq('status', 'pending')
        .single();

      if (!invite) {
        return res.status(404).json({ success: false, error: 'Invitation not found or already used' });
      }

      // Check expiration
      if (new Date(invite.expires_at) < new Date()) {
        await supabaseAdmin
          .from('cohost_invitations')
          .update({ status: 'expired' })
          .eq('id', invite.id);
        return res.status(400).json({ success: false, error: 'Invitation has expired' });
      }

      // Verify email matches
      if (user.email && invite.email.toLowerCase() !== user.email.toLowerCase()) {
        return res.status(403).json({
          success: false,
          error: 'This invitation was sent to a different email address'
        });
      }

      // Create collaborator row
      const { error: collabError } = await supabaseAdmin
        .from('event_collaborators')
        .upsert({
          event_id: invite.event_id,
          user_id: user.id,
          role: invite.role,
          invited_by: invite.invited_by,
          accepted_at: new Date().toISOString()
        }, { onConflict: 'event_id,user_id' });

      if (collabError) return res.status(400).json({ success: false, error: collabError.message });

      // Update invitation status
      await supabaseAdmin
        .from('cohost_invitations')
        .update({ status: 'accepted' })
        .eq('id', invite.id);

      // Get event slug for redirect
      const { data: event } = await supabaseAdmin
        .from('events')
        .select('slug')
        .eq('id', invite.event_id)
        .single();

      return res.status(200).json({
        success: true,
        eventId: invite.event_id,
        eventSlug: event?.slug,
        role: invite.role
      });
    }

    // ---- DECLINE INVITATION ----
    if (action === 'decline') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { token } = req.body || {};
      if (!token) return res.status(400).json({ success: false, error: 'Token required' });

      const { error } = await supabaseAdmin
        .from('cohost_invitations')
        .update({ status: 'declined' })
        .eq('token', token)
        .eq('status', 'pending');

      if (error) return res.status(400).json({ success: false, error: error.message });

      return res.status(200).json({ success: true });
    }

    // ---- LIST CO-HOSTS FOR AN EVENT ----
    if (action === 'list') {
      const { eventId } = req.query;
      if (!eventId) return res.status(400).json({ success: false, error: 'eventId required' });

      const access = await checkEventAccess(user.id, eventId, 'viewer');
      if (!access.allowed) return res.status(403).json({ success: false, error: 'Not authorized' });

      // Fetch collaborators
      const { data: collabs } = await supabaseAdmin
        .from('event_collaborators')
        .select('*, profiles(display_name, email, avatar_url)')
        .eq('event_id', eventId)
        .order('created_at', { ascending: true });

      // Fetch pending invitations
      const { data: pending } = await supabaseAdmin
        .from('cohost_invitations')
        .select('id, email, role, status, created_at, expires_at')
        .eq('event_id', eventId)
        .eq('status', 'pending');

      return res.status(200).json({
        success: true,
        cohosts: (collabs || []).map(c => ({
          id: c.id,
          userId: c.user_id,
          role: c.role,
          name: c.profiles?.display_name || c.profiles?.email || 'Unknown',
          email: c.profiles?.email,
          avatarUrl: c.profiles?.avatar_url,
          acceptedAt: c.accepted_at,
          createdAt: c.created_at
        })),
        pendingInvitations: (pending || []).map(p => ({
          id: p.id,
          email: p.email,
          role: p.role,
          createdAt: p.created_at,
          expiresAt: p.expires_at
        }))
      });
    }

    // ---- REMOVE CO-HOST ----
    if (action === 'remove') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { eventId, collaboratorId, invitationId } = req.body || {};
      if (!eventId) return res.status(400).json({ success: false, error: 'eventId required' });

      // Only owners can remove co-hosts
      const access = await checkEventAccess(user.id, eventId, 'owner');
      if (!access.allowed || access.role !== 'owner') {
        return res.status(403).json({ success: false, error: 'Only owners can remove co-hosts' });
      }

      if (collaboratorId) {
        const { error } = await supabaseAdmin
          .from('event_collaborators')
          .delete()
          .eq('id', collaboratorId)
          .eq('event_id', eventId);

        if (error) return res.status(400).json({ success: false, error: error.message });
      }

      if (invitationId) {
        const { error } = await supabaseAdmin
          .from('cohost_invitations')
          .delete()
          .eq('id', invitationId)
          .eq('event_id', eventId);

        if (error) return res.status(400).json({ success: false, error: error.message });
      }

      return res.status(200).json({ success: true });
    }

    // ---- MY PENDING INVITATIONS ----
    if (action === 'myInvitations') {
      const { data: invitations } = await supabaseAdmin
        .from('cohost_invitations')
        .select('*, events(id, title, event_date, location_name, slug), inviter:invited_by(display_name, email)')
        .ilike('email', user.email)
        .eq('status', 'pending')
        .gt('expires_at', new Date().toISOString())
        .order('created_at', { ascending: false });

      return res.status(200).json({
        success: true,
        invitations: (invitations || []).map(i => ({
          id: i.id,
          token: i.token,
          role: i.role,
          eventId: i.event_id,
          eventTitle: i.events?.title,
          eventDate: i.events?.event_date,
          eventLocation: i.events?.location_name,
          eventSlug: i.events?.slug,
          inviterName: i.inviter?.display_name || i.inviter?.email || 'Someone',
          expiresAt: i.expires_at
        }))
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Cohost API error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}
