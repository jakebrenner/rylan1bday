import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function getUserSupabase(token) {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
}

function generateSlug(title) {
  const slug = (title || 'event')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 50);
  const suffix = Math.random().toString(36).substring(2, 6);
  return `${slug}-${suffix}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    // ---- Public actions (no auth required) ----

    if (action === 'getPublic') {
      const { slug, eventId } = req.query;

      let query = supabaseAdmin
        .from('events')
        .select('*')
        .eq('status', 'published');

      if (slug) query = query.eq('slug', slug);
      else if (eventId) query = query.eq('id', eventId);
      else return res.status(400).json({ success: false, error: 'slug or eventId required' });

      const { data: event, error } = await query.single();

      if (error || !event) return res.status(404).json({ success: false, error: 'Event not found' });

      // Fetch active theme
      const { data: theme } = await supabaseAdmin
        .from('event_themes')
        .select('html, css, config')
        .eq('event_id', event.id)
        .eq('is_active', true)
        .single();

      // Fetch custom fields
      const { data: customFields } = await supabaseAdmin
        .from('event_custom_fields')
        .select('*')
        .eq('event_id', event.id)
        .order('sort_order', { ascending: true });

      return res.status(200).json({
        success: true,
        event: formatEvent(event, theme, customFields)
      });
    }

    if (action === 'rsvp') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { eventId, name, status, email, phone, responseData, plusOnes, notes } = req.body || {};

      if (!eventId || !name || !status) {
        return res.status(400).json({ success: false, error: 'eventId, name, and status are required' });
      }

      // Map frontend status values to enum
      const statusMap = { yes: 'attending', no: 'declined', maybe: 'maybe' };
      const guestStatus = statusMap[status] || status;

      const { data, error } = await supabaseAdmin
        .from('guests')
        .insert({
          event_id: eventId,
          name,
          email: email || null,
          phone: phone || null,
          status: guestStatus,
          response_data: responseData || {},
          plus_ones: plusOnes || 0,
          notes: notes || null,
          responded_at: new Date().toISOString()
        })
        .select()
        .single();

      if (error) return res.status(400).json({ success: false, error: error.message });

      // Fire Zapier webhook if configured
      const { data: event } = await supabaseAdmin
        .from('events')
        .select('zapier_webhook, user_id')
        .eq('id', eventId)
        .single();

      if (event?.zapier_webhook) {
        fetch(event.zapier_webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventId, name, status: guestStatus, email, phone, responseData })
        }).catch(() => {}); // fire and forget
      }

      // Auto-capture RSVP to host's contact book
      if (event?.user_id) {
        autoCapture(event.user_id, eventId, data.id, { name, email, phone, responseData }).catch(() => {});
      }

      return res.status(200).json({ success: true, guestId: data.id });
    }

    // ---- Authenticated actions ----

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const token = authHeader.slice(7);
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !user) {
      return res.status(401).json({ success: false, error: 'Invalid session' });
    }

    const supabase = getUserSupabase(token);

    if (action === 'create') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { title, description, eventDate, endDate, locationName, locationAddress, locationUrl, dressCode, eventType, timezone, settings } = req.body || {};

      if (!title) return res.status(400).json({ success: false, error: 'Title is required' });

      // Check plan limits
      const { checkUserLimits } = await import('./billing.js');
      const limits = await checkUserLimits(user.id);
      if (!limits.hasActivePlan) {
        return res.status(403).json({ success: false, error: 'You need an active plan to create events. Visit the pricing page to get started.', needsPlan: true });
      }
      if (!limits.canCreateEvent) {
        return res.status(403).json({ success: false, error: limits.reason || 'Event limit reached for your plan.', limitReached: true });
      }

      // Ensure profile exists (may not have been created by trigger)
      const { data: existingProfile } = await supabaseAdmin
        .from('profiles')
        .select('id')
        .eq('id', user.id)
        .single();

      if (!existingProfile) {
        await supabaseAdmin
          .from('profiles')
          .insert({
            id: user.id,
            email: user.email || '',
            display_name: user.user_metadata?.display_name || '',
            phone: user.user_metadata?.phone || null
          });
      }

      const slug = generateSlug(title);

      // Use admin client to bypass RLS — user is already authenticated
      const { data, error } = await supabaseAdmin
        .from('events')
        .insert({
          user_id: user.id,
          title,
          description: description || null,
          event_date: eventDate || null,
          end_date: endDate || null,
          location_name: locationName || null,
          location_address: locationAddress || null,
          location_url: locationUrl || null,
          dress_code: dressCode || null,
          event_type: eventType || null,
          timezone: timezone || 'America/New_York',
          slug,
          status: 'draft',
          settings: settings || { creation_step: 1 }
        })
        .select()
        .single();

      if (error) return res.status(400).json({ success: false, error: error.message });

      return res.status(200).json({ success: true, eventId: data.id, slug: data.slug });
    }

    if (action === 'update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { eventId, ...updates } = req.body || {};

      if (!eventId) return res.status(400).json({ success: false, error: 'eventId is required' });

      // Map camelCase to snake_case for events table
      const dbUpdates = {};
      if (updates.title !== undefined) dbUpdates.title = updates.title;
      if (updates.description !== undefined) dbUpdates.description = updates.description;
      if (updates.eventDate !== undefined) dbUpdates.event_date = updates.eventDate || null;
      if (updates.endDate !== undefined) dbUpdates.end_date = updates.endDate || null;
      if (updates.locationName !== undefined) dbUpdates.location_name = updates.locationName;
      if (updates.locationAddress !== undefined) dbUpdates.location_address = updates.locationAddress;
      if (updates.locationUrl !== undefined) dbUpdates.location_url = updates.locationUrl;
      if (updates.dressCode !== undefined) dbUpdates.dress_code = updates.dressCode;
      if (updates.eventType !== undefined) dbUpdates.event_type = updates.eventType;
      if (updates.timezone !== undefined) dbUpdates.timezone = updates.timezone;
      if (updates.maxGuests !== undefined) dbUpdates.max_guests = updates.maxGuests;
      if (updates.rsvpDeadline !== undefined) dbUpdates.rsvp_deadline = updates.rsvpDeadline || null;
      if (updates.zapierWebhook !== undefined) dbUpdates.zapier_webhook = updates.zapierWebhook;
      // Settings: merge with existing instead of overwrite
      if (updates.settings !== undefined) {
        const newSettings = typeof updates.settings === 'string' ? JSON.parse(updates.settings) : updates.settings;
        // Fetch current settings to merge
        const { data: currentRow } = await supabaseAdmin.from('events').select('settings').eq('id', eventId).single();
        dbUpdates.settings = { ...(currentRow?.settings || {}), ...newSettings };
      }

      // Status: frontend sends "Published"/"Draft"/"Archived" — normalize to lowercase enum
      if (updates.status !== undefined) dbUpdates.status = updates.status.toLowerCase();

      // Track generations-to-publish when first published
      if (dbUpdates.status === 'published') {
        try {
          // Only compute if not already published (first publish)
          const { data: currentEvent } = await supabaseAdmin
            .from('events')
            .select('published_at')
            .eq('id', eventId)
            .single();
          if (!currentEvent?.published_at) {
            // Count successful generations for this event
            const { count: genCount } = await supabaseAdmin
              .from('generation_log')
              .select('*', { count: 'exact', head: true })
              .eq('event_id', eventId)
              .eq('status', 'success');
            dbUpdates.generations_to_publish = genCount || 1;
            dbUpdates.published_at = new Date().toISOString();
          }
        } catch {} // Don't block publish if tracking fails
      }

      const { data, error } = await supabaseAdmin
        .from('events')
        .update(dbUpdates)
        .eq('id', eventId)
        .eq('user_id', user.id)
        .select()
        .single();

      if (error) return res.status(400).json({ success: false, error: error.message });

      // Fetch active theme for the response
      const { data: theme } = await supabaseAdmin
        .from('event_themes')
        .select('html, css, config')
        .eq('event_id', eventId)
        .eq('is_active', true)
        .single();

      return res.status(200).json({ success: true, event: formatEvent(data, theme) });
    }

    if (action === 'list') {
      // Fetch user's own events
      const { data, error } = await supabaseAdmin
        .from('events')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });

      if (error) return res.status(400).json({ success: false, error: error.message });

      // Fetch events where user is a collaborator
      const { data: collabs } = await supabaseAdmin
        .from('event_collaborators')
        .select('event_id, role')
        .eq('user_id', user.id);

      let sharedEvents = [];
      if (collabs?.length) {
        const collabEventIds = collabs.map(c => c.event_id);
        const { data: shared } = await supabaseAdmin
          .from('events')
          .select('*')
          .in('id', collabEventIds)
          .order('created_at', { ascending: false });
        sharedEvents = shared || [];
      }

      // Fetch active themes for all events in one query
      const allEvents = [...(data || []), ...sharedEvents];
      const eventIds = allEvents.map(e => e.id);
      const { data: themes } = eventIds.length > 0
        ? await supabaseAdmin
            .from('event_themes')
            .select('event_id, html, css, config')
            .in('event_id', eventIds)
            .eq('is_active', true)
        : { data: [] };

      const themeMap = {};
      (themes || []).forEach(t => { themeMap[t.event_id] = t; });

      // Build collaborator role map
      const collabRoleMap = {};
      (collabs || []).forEach(c => { collabRoleMap[c.event_id] = c.role; });

      return res.status(200).json({
        success: true,
        events: (data || []).map(e => formatEvent(e, themeMap[e.id])),
        sharedEvents: sharedEvents.map(e => {
          const formatted = formatEvent(e, themeMap[e.id]);
          formatted.collaboratorRole = collabRoleMap[e.id] || 'viewer';
          return formatted;
        })
      });
    }

    if (action === 'get') {
      const { eventId } = req.query;
      if (!eventId) return res.status(400).json({ success: false, error: 'eventId required' });

      const access = await checkEventAccess(user.id, eventId, 'viewer');
      if (!access.allowed) return res.status(404).json({ success: false, error: 'Event not found' });

      const { data, error } = await supabaseAdmin
        .from('events')
        .select('*')
        .eq('id', eventId)
        .single();

      if (error || !data) return res.status(404).json({ success: false, error: 'Event not found' });

      const { data: theme } = await supabaseAdmin
        .from('event_themes')
        .select('html, css, config')
        .eq('event_id', eventId)
        .eq('is_active', true)
        .single();

      const { data: allThemes } = await supabaseAdmin
        .from('event_themes')
        .select('id, version, html, css, config, is_active')
        .eq('event_id', eventId)
        .order('version', { ascending: true });

      const { data: customFields } = await supabaseAdmin
        .from('event_custom_fields')
        .select('*')
        .eq('event_id', eventId)
        .order('sort_order', { ascending: true });

      const formatted = formatEvent(data, theme, customFields);
      formatted.themeVersions = (allThemes || []).map(t => ({
        id: t.id, version: t.version, html: t.html, css: t.css, config: t.config, isActive: t.is_active
      }));

      return res.status(200).json({ success: true, event: formatted });
    }

    if (action === 'rsvps') {
      const { eventId } = req.query;
      if (!eventId) return res.status(400).json({ success: false, error: 'eventId required' });

      // Verify ownership or collaborator access
      const access = await checkEventAccess(user.id, eventId, 'viewer');
      if (!access.allowed) return res.status(404).json({ success: false, error: 'Event not found' });

      const { data, error } = await supabaseAdmin
        .from('guests')
        .select('*')
        .eq('event_id', eventId)
        .order('created_at', { ascending: false });

      if (error) return res.status(400).json({ success: false, error: error.message });

      return res.status(200).json({
        success: true,
        rsvps: (data || []).map(g => ({
          id: g.id,
          eventId: g.event_id,
          name: g.name,
          email: g.email,
          phone: g.phone,
          status: g.status,
          responseData: g.response_data,
          plusOnes: g.plus_ones,
          notes: g.notes,
          respondedAt: g.responded_at,
          createdAt: g.created_at
        }))
      });
    }

    if (action === 'saveFields') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { eventId, fields } = req.body || {};
      if (!eventId || !Array.isArray(fields)) {
        return res.status(400).json({ success: false, error: 'eventId and fields array required' });
      }

      // Verify ownership
      const { data: event } = await supabaseAdmin
        .from('events')
        .select('id')
        .eq('id', eventId)
        .eq('user_id', user.id)
        .single();

      if (!event) return res.status(404).json({ success: false, error: 'Event not found' });

      // Delete existing custom fields for this event
      await supabaseAdmin
        .from('event_custom_fields')
        .delete()
        .eq('event_id', eventId);

      // Insert new fields
      if (fields.length > 0) {
        const rows = fields.map((f, i) => ({
          event_id: eventId,
          field_key: f.field_key,
          label: f.label,
          field_type: f.field_type || 'text',
          is_required: f.is_required || false,
          options: f.options || null,
          placeholder: f.placeholder || null,
          sort_order: f.sort_order !== undefined ? f.sort_order : i
        }));

        const { error } = await supabaseAdmin
          .from('event_custom_fields')
          .insert(rows);

        if (error) return res.status(400).json({ success: false, error: error.message });
      }

      return res.status(200).json({ success: true });
    }

    // ---- ACTIVATE THEME VERSION ----
    if (action === 'activateTheme') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
      const { eventId, themeId } = req.body || {};
      if (!eventId || !themeId) return res.status(400).json({ error: 'eventId and themeId required' });

      // Verify ownership
      const { data: ev } = await supabaseAdmin.from('events').select('id').eq('id', eventId).eq('user_id', user.id).single();
      if (!ev) return res.status(403).json({ error: 'Not your event' });

      // Deactivate all, activate selected
      await supabaseAdmin.from('event_themes').update({ is_active: false }).eq('event_id', eventId);
      await supabaseAdmin.from('event_themes').update({ is_active: true }).eq('id', themeId).eq('event_id', eventId);

      return res.status(200).json({ success: true });
    }

    // ---- ADD GUESTS FROM CONTACTS ----
    if (action === 'addGuests') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { eventId, contactIds } = req.body || {};
      if (!eventId || !contactIds?.length) {
        return res.status(400).json({ success: false, error: 'eventId and contactIds required' });
      }

      const access = await checkEventAccess(user.id, eventId, 'editor');
      if (!access.allowed) return res.status(403).json({ success: false, error: 'Not authorized' });

      // Fetch contacts
      const { data: contacts } = await supabaseAdmin
        .from('contacts')
        .select('id, name, email, phone')
        .in('id', contactIds)
        .eq('user_id', user.id);

      if (!contacts?.length) return res.status(400).json({ success: false, error: 'No valid contacts found' });

      // Check for existing guests to skip duplicates
      const { data: existingGuests } = await supabaseAdmin
        .from('guests')
        .select('contact_id')
        .eq('event_id', eventId)
        .not('contact_id', 'is', null);

      const existingContactIds = new Set((existingGuests || []).map(g => g.contact_id));

      const newGuests = contacts
        .filter(c => !existingContactIds.has(c.id))
        .map(c => ({
          event_id: eventId,
          contact_id: c.id,
          name: c.name,
          email: c.email || null,
          phone: c.phone || null,
          status: 'invited',
          invited_at: new Date().toISOString()
        }));

      if (newGuests.length === 0) {
        return res.status(200).json({ success: true, added: 0, skipped: contacts.length });
      }

      const { error } = await supabaseAdmin.from('guests').insert(newGuests);
      if (error) return res.status(400).json({ success: false, error: error.message });

      return res.status(200).json({
        success: true,
        added: newGuests.length,
        skipped: contacts.length - newGuests.length
      });
    }

    // ---- ADD GUESTS BY TAG ----
    if (action === 'addGuestsByTag') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { eventId, tagId } = req.body || {};
      if (!eventId || !tagId) {
        return res.status(400).json({ success: false, error: 'eventId and tagId required' });
      }

      const access = await checkEventAccess(user.id, eventId, 'editor');
      if (!access.allowed) return res.status(403).json({ success: false, error: 'Not authorized' });

      // Get all contacts with this tag
      const { data: assignments } = await supabaseAdmin
        .from('contact_tag_assignments')
        .select('contact_id')
        .eq('tag_id', tagId);

      const contactIds = (assignments || []).map(a => a.contact_id);
      if (!contactIds.length) return res.status(200).json({ success: true, added: 0, skipped: 0 });

      // Fetch contacts
      const { data: contacts } = await supabaseAdmin
        .from('contacts')
        .select('id, name, email, phone')
        .in('id', contactIds)
        .eq('user_id', user.id);

      // Check existing
      const { data: existingGuests } = await supabaseAdmin
        .from('guests')
        .select('contact_id')
        .eq('event_id', eventId)
        .not('contact_id', 'is', null);

      const existingContactIds = new Set((existingGuests || []).map(g => g.contact_id));

      const newGuests = (contacts || [])
        .filter(c => !existingContactIds.has(c.id))
        .map(c => ({
          event_id: eventId,
          contact_id: c.id,
          name: c.name,
          email: c.email || null,
          phone: c.phone || null,
          status: 'invited',
          invited_at: new Date().toISOString()
        }));

      if (newGuests.length > 0) {
        const { error } = await supabaseAdmin.from('guests').insert(newGuests);
        if (error) return res.status(400).json({ success: false, error: error.message });
      }

      return res.status(200).json({
        success: true,
        added: newGuests.length,
        skipped: (contacts || []).length - newGuests.length
      });
    }

    // ---- ADD GUESTS FROM ANOTHER EVENT ----
    if (action === 'addGuestsFromEvent') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { eventId, sourceEventId, statusFilter } = req.body || {};
      if (!eventId || !sourceEventId) {
        return res.status(400).json({ success: false, error: 'eventId and sourceEventId required' });
      }

      const access = await checkEventAccess(user.id, eventId, 'editor');
      if (!access.allowed) return res.status(403).json({ success: false, error: 'Not authorized' });

      // Verify source event ownership
      const sourceAccess = await checkEventAccess(user.id, sourceEventId, 'viewer');
      if (!sourceAccess.allowed) return res.status(403).json({ success: false, error: 'Cannot access source event' });

      // Fetch guests from source event
      let sourceQuery = supabaseAdmin
        .from('guests')
        .select('name, email, phone, contact_id')
        .eq('event_id', sourceEventId);

      if (statusFilter) sourceQuery = sourceQuery.eq('status', statusFilter);

      const { data: sourceGuests } = await sourceQuery;
      if (!sourceGuests?.length) return res.status(200).json({ success: true, added: 0, skipped: 0 });

      // Check existing guests in target event
      const { data: existingGuests } = await supabaseAdmin
        .from('guests')
        .select('email, phone, contact_id')
        .eq('event_id', eventId);

      const existingEmails = new Set((existingGuests || []).filter(g => g.email).map(g => g.email.toLowerCase()));
      const existingContactIds = new Set((existingGuests || []).filter(g => g.contact_id).map(g => g.contact_id));

      const newGuests = sourceGuests
        .filter(g => {
          if (g.contact_id && existingContactIds.has(g.contact_id)) return false;
          if (g.email && existingEmails.has(g.email.toLowerCase())) return false;
          return true;
        })
        .map(g => ({
          event_id: eventId,
          contact_id: g.contact_id || null,
          name: g.name,
          email: g.email || null,
          phone: g.phone || null,
          status: 'invited',
          invited_at: new Date().toISOString()
        }));

      if (newGuests.length > 0) {
        const { error } = await supabaseAdmin.from('guests').insert(newGuests);
        if (error) return res.status(400).json({ success: false, error: error.message });
      }

      return res.status(200).json({
        success: true,
        added: newGuests.length,
        skipped: sourceGuests.length - newGuests.length
      });
    }

    // ---- REMOVE GUESTS ----
    if (action === 'removeGuests') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { eventId, guestIds } = req.body || {};
      if (!eventId || !guestIds?.length) {
        return res.status(400).json({ success: false, error: 'eventId and guestIds required' });
      }

      const access = await checkEventAccess(user.id, eventId, 'editor');
      if (!access.allowed) return res.status(403).json({ success: false, error: 'Not authorized' });

      const { error } = await supabaseAdmin
        .from('guests')
        .delete()
        .in('id', guestIds)
        .eq('event_id', eventId);

      if (error) return res.status(400).json({ success: false, error: error.message });

      return res.status(200).json({ success: true, removed: guestIds.length });
    }

    // ---- SAVE RSVP TO CONTACTS ----
    if (action === 'saveGuestToContacts') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { guestId } = req.body || {};
      if (!guestId) return res.status(400).json({ success: false, error: 'guestId required' });

      // Fetch guest
      const { data: guest } = await supabaseAdmin
        .from('guests')
        .select('*, events(user_id)')
        .eq('id', guestId)
        .single();

      if (!guest || guest.events?.user_id !== user.id) {
        return res.status(404).json({ success: false, error: 'Guest not found' });
      }

      if (guest.contact_id) {
        return res.status(200).json({ success: true, contactId: guest.contact_id, alreadySaved: true });
      }

      // Try auto-capture
      const contactId = await autoCapture(user.id, guest.event_id, guest.id, {
        name: guest.name,
        email: guest.email,
        phone: guest.phone,
        responseData: guest.response_data
      });

      return res.status(200).json({ success: true, contactId, alreadySaved: false });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Events API error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

// Check if a user has access to an event (owner or collaborator)
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

// Auto-capture an RSVP guest to the host's contact book
async function autoCapture(hostUserId, eventId, guestId, { name, email, phone, responseData }) {
  try {
    let contactId = null;

    // Check for existing contact by email
    if (email) {
      const { data: existing } = await supabaseAdmin
        .from('contacts')
        .select('id, metadata')
        .eq('user_id', hostUserId)
        .ilike('email', email)
        .single();

      if (existing) {
        contactId = existing.id;
        // Merge new info
        const mergeUpdates = {};
        if (phone && !existing.phone) mergeUpdates.phone = phone;
        if (responseData && Object.keys(responseData).length > 0) {
          mergeUpdates.metadata = { ...(existing.metadata || {}), ...responseData };
        }
        if (Object.keys(mergeUpdates).length > 0) {
          await supabaseAdmin.from('contacts').update(mergeUpdates).eq('id', existing.id);
        }
      }
    }

    // Check by phone if no email match
    if (!contactId && phone) {
      const digits = phone.replace(/\D/g, '');
      const normalized = digits.length >= 10 ? digits.slice(-10) : null;
      if (normalized) {
        const { data: phoneContacts } = await supabaseAdmin
          .from('contacts')
          .select('id, phone')
          .eq('user_id', hostUserId)
          .not('phone', 'is', null);

        const match = (phoneContacts || []).find(c => {
          const cd = c.phone.replace(/\D/g, '');
          return cd.length >= 10 && cd.slice(-10) === normalized;
        });

        if (match) contactId = match.id;
      }
    }

    // Create new contact if no match
    if (!contactId) {
      const { data: newContact } = await supabaseAdmin
        .from('contacts')
        .insert({
          user_id: hostUserId,
          name,
          email: email || null,
          phone: phone || null,
          metadata: responseData || {},
          source: 'rsvp',
          source_event_id: eventId
        })
        .select('id')
        .single();

      if (newContact) contactId = newContact.id;
    }

    // Link guest to contact
    if (contactId) {
      await supabaseAdmin
        .from('guests')
        .update({ contact_id: contactId })
        .eq('id', guestId);
    }

    return contactId;
  } catch (err) {
    console.error('Auto-capture error:', err);
    return null;
  }
}

function formatEvent(row, theme, customFields) {
  // Status: DB stores lowercase enum, frontend expects capitalized
  const statusDisplay = row.status ? row.status.charAt(0).toUpperCase() + row.status.slice(1) : 'Draft';

  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    description: row.description || '',
    eventDate: row.event_date || '',
    endDate: row.end_date || '',
    timezone: row.timezone || 'America/New_York',
    locationName: row.location_name || '',
    locationAddress: row.location_address || '',
    locationUrl: row.location_url || '',
    dressCode: row.dress_code || '',
    eventType: row.event_type || '',
    maxGuests: row.max_guests,
    rsvpDeadline: row.rsvp_deadline || '',
    slug: row.slug || '',
    status: statusDisplay,
    settings: row.settings || {},
    zapierWebhook: row.zapier_webhook || '',
    // Theme from event_themes table
    themeHtml: theme?.html || '',
    themeCss: theme?.css || '',
    themeConfig: theme?.config || {},
    // Custom fields from event_custom_fields table
    customFields: (customFields || []).map(f => ({
      id: f.id,
      key: f.field_key,
      label: f.label,
      type: f.field_type,
      required: f.is_required,
      options: f.options,
      placeholder: f.placeholder,
      sortOrder: f.sort_order
    })),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
