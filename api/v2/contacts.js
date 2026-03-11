import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function getUser(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) return null;
  return user;
}

function normalizePhone(phone) {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { action } = req.query;

  try {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ success: false, error: 'Unauthorized' });

    // ================================================================
    // CONTACT CRUD
    // ================================================================

    if (action === 'list') {
      const { tagId, search, householdId, source, eventId } = req.query;

      let query = supabaseAdmin
        .from('contacts')
        .select('*, contact_tag_assignments(tag_id)')
        .eq('user_id', user.id)
        .order('name', { ascending: true });

      if (source) query = query.eq('source', source);

      const { data: contacts, error } = await query;
      if (error) return res.status(400).json({ success: false, error: error.message });

      let results = contacts || [];

      // Filter by tag
      if (tagId) {
        results = results.filter(c =>
          c.contact_tag_assignments?.some(a => a.tag_id === tagId)
        );
      }

      // Search by name, email, or phone
      if (search) {
        const s = search.toLowerCase();
        results = results.filter(c =>
          (c.name && c.name.toLowerCase().includes(s)) ||
          (c.email && c.email.toLowerCase().includes(s)) ||
          (c.phone && c.phone.includes(s))
        );
      }

      // Filter by household
      if (householdId) {
        const { data: members } = await supabaseAdmin
          .from('household_members')
          .select('contact_id')
          .eq('household_id', householdId);
        const memberIds = new Set((members || []).map(m => m.contact_id));
        results = results.filter(c => memberIds.has(c.id));
      }

      // Filter by event (contacts who were guests at this event)
      if (eventId) {
        const { data: guests } = await supabaseAdmin
          .from('guests')
          .select('contact_id')
          .eq('event_id', eventId)
          .not('contact_id', 'is', null);
        const guestContactIds = new Set((guests || []).map(g => g.contact_id));
        results = results.filter(c => guestContactIds.has(c.id));
      }

      // Fetch all tags for response formatting
      const { data: allTags } = await supabaseAdmin
        .from('contact_tags')
        .select('id, name, color')
        .eq('user_id', user.id);
      const tagMap = {};
      (allTags || []).forEach(t => { tagMap[t.id] = t; });

      return res.status(200).json({
        success: true,
        contacts: results.map(c => formatContact(c, tagMap))
      });
    }

    if (action === 'get') {
      const { contactId } = req.query;
      if (!contactId) return res.status(400).json({ success: false, error: 'contactId required' });

      const { data: contact, error } = await supabaseAdmin
        .from('contacts')
        .select('*, contact_tag_assignments(tag_id)')
        .eq('id', contactId)
        .eq('user_id', user.id)
        .single();

      if (error || !contact) return res.status(404).json({ success: false, error: 'Contact not found' });

      // Fetch tags
      const { data: allTags } = await supabaseAdmin
        .from('contact_tags')
        .select('id, name, color')
        .eq('user_id', user.id);
      const tagMap = {};
      (allTags || []).forEach(t => { tagMap[t.id] = t; });

      // Fetch household membership
      const { data: householdMembership } = await supabaseAdmin
        .from('household_members')
        .select('household_id, role, households(id, name, notes, metadata)')
        .eq('contact_id', contactId);

      // Fetch event history (which events this contact appeared in)
      const { data: guestAppearances } = await supabaseAdmin
        .from('guests')
        .select('event_id, status, responded_at, events(title, event_date, slug)')
        .eq('contact_id', contactId);

      const formatted = formatContact(contact, tagMap);
      formatted.household = householdMembership?.[0] ? {
        id: householdMembership[0].households.id,
        name: householdMembership[0].households.name,
        role: householdMembership[0].role,
        notes: householdMembership[0].households.notes,
        metadata: householdMembership[0].households.metadata
      } : null;
      formatted.eventHistory = (guestAppearances || []).map(g => ({
        eventId: g.event_id,
        title: g.events?.title,
        eventDate: g.events?.event_date,
        slug: g.events?.slug,
        status: g.status,
        respondedAt: g.responded_at
      }));

      return res.status(200).json({ success: true, contact: formatted });
    }

    if (action === 'create') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { name, email, phone, notes, metadata, source, sourceEventId, tagIds } = req.body || {};
      if (!name) return res.status(400).json({ success: false, error: 'Name is required' });

      // Dedup check by email
      if (email) {
        const { data: existing } = await supabaseAdmin
          .from('contacts')
          .select('id')
          .eq('user_id', user.id)
          .ilike('email', email)
          .single();

        if (existing) {
          return res.status(409).json({
            success: false,
            error: 'A contact with this email already exists',
            existingContactId: existing.id
          });
        }
      }

      // Dedup check by phone
      if (phone && !email) {
        const normalized = normalizePhone(phone);
        if (normalized) {
          const { data: phoneContacts } = await supabaseAdmin
            .from('contacts')
            .select('id, phone')
            .eq('user_id', user.id)
            .not('phone', 'is', null);

          const match = (phoneContacts || []).find(c => normalizePhone(c.phone) === normalized);
          if (match) {
            return res.status(409).json({
              success: false,
              error: 'A contact with this phone number already exists',
              existingContactId: match.id
            });
          }
        }
      }

      const { data, error } = await supabaseAdmin
        .from('contacts')
        .insert({
          user_id: user.id,
          name,
          email: email || null,
          phone: phone || null,
          notes: notes || null,
          metadata: metadata || {},
          source: source || 'manual',
          source_event_id: sourceEventId || null
        })
        .select()
        .single();

      if (error) return res.status(400).json({ success: false, error: error.message });

      // Assign tags if provided
      if (tagIds && tagIds.length > 0) {
        await supabaseAdmin
          .from('contact_tag_assignments')
          .insert(tagIds.map(tagId => ({ contact_id: data.id, tag_id: tagId })));
      }

      return res.status(200).json({ success: true, contact: data });
    }

    if (action === 'update') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { contactId, ...updates } = req.body || {};
      if (!contactId) return res.status(400).json({ success: false, error: 'contactId required' });

      const dbUpdates = {};
      if (updates.name !== undefined) dbUpdates.name = updates.name;
      if (updates.email !== undefined) dbUpdates.email = updates.email || null;
      if (updates.phone !== undefined) dbUpdates.phone = updates.phone || null;
      if (updates.notes !== undefined) dbUpdates.notes = updates.notes || null;

      // Merge metadata rather than overwrite
      if (updates.metadata !== undefined) {
        const { data: current } = await supabaseAdmin
          .from('contacts')
          .select('metadata')
          .eq('id', contactId)
          .eq('user_id', user.id)
          .single();
        dbUpdates.metadata = { ...(current?.metadata || {}), ...updates.metadata };
      }

      const { data, error } = await supabaseAdmin
        .from('contacts')
        .update(dbUpdates)
        .eq('id', contactId)
        .eq('user_id', user.id)
        .select()
        .single();

      if (error) return res.status(400).json({ success: false, error: error.message });

      return res.status(200).json({ success: true, contact: data });
    }

    if (action === 'delete') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { contactIds } = req.body || {};
      if (!contactIds || !contactIds.length) {
        return res.status(400).json({ success: false, error: 'contactIds array required' });
      }

      const { error } = await supabaseAdmin
        .from('contacts')
        .delete()
        .in('id', contactIds)
        .eq('user_id', user.id);

      if (error) return res.status(400).json({ success: false, error: error.message });

      return res.status(200).json({ success: true, deleted: contactIds.length });
    }

    if (action === 'bulkCreate') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { contacts: inputContacts, tagId, source } = req.body || {};
      if (!inputContacts || !Array.isArray(inputContacts)) {
        return res.status(400).json({ success: false, error: 'contacts array required' });
      }

      // Fetch existing contacts for dedup
      const { data: existing } = await supabaseAdmin
        .from('contacts')
        .select('id, email, phone, name, metadata')
        .eq('user_id', user.id);

      const existingByEmail = {};
      const existingByPhone = {};
      (existing || []).forEach(c => {
        if (c.email) existingByEmail[c.email.toLowerCase()] = c;
        if (c.phone) {
          const norm = normalizePhone(c.phone);
          if (norm) existingByPhone[norm] = c;
        }
      });

      let created = 0, updated = 0, skipped = 0;
      const newContacts = [];
      const updateOps = [];

      for (const input of inputContacts) {
        if (!input.name) { skipped++; continue; }

        const emailKey = input.email ? input.email.toLowerCase() : null;
        const phoneKey = input.phone ? normalizePhone(input.phone) : null;

        const match = (emailKey && existingByEmail[emailKey]) ||
                      (phoneKey && existingByPhone[phoneKey]);

        if (match) {
          // Merge: enrich existing contact with new info
          const mergeUpdates = {};
          if (!match.email && input.email) mergeUpdates.email = input.email;
          if (!match.phone && input.phone) mergeUpdates.phone = input.phone;
          if (input.metadata) {
            mergeUpdates.metadata = { ...(match.metadata || {}), ...input.metadata };
          }

          if (Object.keys(mergeUpdates).length > 0) {
            updateOps.push({ id: match.id, ...mergeUpdates });
            updated++;
          } else {
            skipped++;
          }
        } else {
          newContacts.push({
            user_id: user.id,
            name: input.name,
            email: input.email || null,
            phone: input.phone || null,
            notes: input.notes || null,
            metadata: input.metadata || {},
            source: source || 'import'
          });
          created++;
          // Track for dedup within batch
          if (emailKey) existingByEmail[emailKey] = { email: input.email };
          if (phoneKey) existingByPhone[phoneKey] = { phone: input.phone };
        }
      }

      // Batch insert new contacts
      let insertedIds = [];
      if (newContacts.length > 0) {
        const { data: inserted, error } = await supabaseAdmin
          .from('contacts')
          .insert(newContacts)
          .select('id');

        if (error) return res.status(400).json({ success: false, error: error.message });
        insertedIds = (inserted || []).map(c => c.id);
      }

      // Batch update existing contacts
      for (const op of updateOps) {
        const { id, ...fields } = op;
        await supabaseAdmin.from('contacts').update(fields).eq('id', id);
      }

      // Assign tag if provided
      if (tagId && insertedIds.length > 0) {
        await supabaseAdmin
          .from('contact_tag_assignments')
          .insert(insertedIds.map(cid => ({ contact_id: cid, tag_id: tagId })));
      }

      return res.status(200).json({ success: true, created, updated, skipped });
    }

    // ================================================================
    // TAG OPERATIONS
    // ================================================================

    if (action === 'listTags') {
      const { data: tags, error } = await supabaseAdmin
        .from('contact_tags')
        .select('*')
        .eq('user_id', user.id)
        .order('name', { ascending: true });

      if (error) return res.status(400).json({ success: false, error: error.message });

      // Get counts per tag
      const { data: assignments } = await supabaseAdmin
        .from('contact_tag_assignments')
        .select('tag_id')
        .in('tag_id', (tags || []).map(t => t.id));

      const countMap = {};
      (assignments || []).forEach(a => {
        countMap[a.tag_id] = (countMap[a.tag_id] || 0) + 1;
      });

      return res.status(200).json({
        success: true,
        tags: (tags || []).map(t => ({
          id: t.id,
          name: t.name,
          color: t.color,
          count: countMap[t.id] || 0,
          createdAt: t.created_at
        }))
      });
    }

    if (action === 'createTag') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { name, color } = req.body || {};
      if (!name) return res.status(400).json({ success: false, error: 'Tag name required' });

      const { data, error } = await supabaseAdmin
        .from('contact_tags')
        .insert({ user_id: user.id, name, color: color || null })
        .select()
        .single();

      if (error) {
        if (error.code === '23505') {
          return res.status(409).json({ success: false, error: 'A tag with this name already exists' });
        }
        return res.status(400).json({ success: false, error: error.message });
      }

      return res.status(200).json({ success: true, tag: data });
    }

    if (action === 'updateTag') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { tagId, name, color } = req.body || {};
      if (!tagId) return res.status(400).json({ success: false, error: 'tagId required' });

      const updates = {};
      if (name !== undefined) updates.name = name;
      if (color !== undefined) updates.color = color;

      const { data, error } = await supabaseAdmin
        .from('contact_tags')
        .update(updates)
        .eq('id', tagId)
        .eq('user_id', user.id)
        .select()
        .single();

      if (error) return res.status(400).json({ success: false, error: error.message });

      return res.status(200).json({ success: true, tag: data });
    }

    if (action === 'deleteTag') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { tagId } = req.body || {};
      if (!tagId) return res.status(400).json({ success: false, error: 'tagId required' });

      const { error } = await supabaseAdmin
        .from('contact_tags')
        .delete()
        .eq('id', tagId)
        .eq('user_id', user.id);

      if (error) return res.status(400).json({ success: false, error: error.message });

      return res.status(200).json({ success: true });
    }

    if (action === 'tagContacts') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { tagId, contactIds } = req.body || {};
      if (!tagId || !contactIds?.length) {
        return res.status(400).json({ success: false, error: 'tagId and contactIds required' });
      }

      // Verify tag ownership
      const { data: tag } = await supabaseAdmin
        .from('contact_tags')
        .select('id')
        .eq('id', tagId)
        .eq('user_id', user.id)
        .single();

      if (!tag) return res.status(404).json({ success: false, error: 'Tag not found' });

      const { error } = await supabaseAdmin
        .from('contact_tag_assignments')
        .upsert(
          contactIds.map(cid => ({ contact_id: cid, tag_id: tagId })),
          { onConflict: 'contact_id,tag_id' }
        );

      if (error) return res.status(400).json({ success: false, error: error.message });

      return res.status(200).json({ success: true });
    }

    if (action === 'untagContacts') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { tagId, contactIds } = req.body || {};
      if (!tagId || !contactIds?.length) {
        return res.status(400).json({ success: false, error: 'tagId and contactIds required' });
      }

      const { error } = await supabaseAdmin
        .from('contact_tag_assignments')
        .delete()
        .eq('tag_id', tagId)
        .in('contact_id', contactIds);

      if (error) return res.status(400).json({ success: false, error: error.message });

      return res.status(200).json({ success: true });
    }

    // ================================================================
    // HOUSEHOLD OPERATIONS
    // ================================================================

    if (action === 'listHouseholds') {
      const { data: households, error } = await supabaseAdmin
        .from('households')
        .select('*, household_members(contact_id, role, contacts(id, name, email, phone, metadata))')
        .eq('user_id', user.id)
        .order('name', { ascending: true });

      if (error) return res.status(400).json({ success: false, error: error.message });

      return res.status(200).json({
        success: true,
        households: (households || []).map(h => ({
          id: h.id,
          name: h.name,
          notes: h.notes,
          metadata: h.metadata,
          members: (h.household_members || []).map(m => ({
            contactId: m.contact_id,
            role: m.role,
            name: m.contacts?.name,
            email: m.contacts?.email,
            phone: m.contacts?.phone,
            metadata: m.contacts?.metadata
          })),
          createdAt: h.created_at
        }))
      });
    }

    if (action === 'createHousehold') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { name, notes, metadata, members } = req.body || {};
      if (!name) return res.status(400).json({ success: false, error: 'Household name required' });

      const { data: household, error } = await supabaseAdmin
        .from('households')
        .insert({
          user_id: user.id,
          name,
          notes: notes || null,
          metadata: metadata || {}
        })
        .select()
        .single();

      if (error) return res.status(400).json({ success: false, error: error.message });

      // Add members if provided
      if (members && members.length > 0) {
        const { error: memberError } = await supabaseAdmin
          .from('household_members')
          .insert(members.map(m => ({
            household_id: household.id,
            contact_id: m.contactId,
            role: m.role || 'adult'
          })));

        if (memberError) {
          // Clean up household if member insertion fails
          await supabaseAdmin.from('households').delete().eq('id', household.id);
          return res.status(400).json({ success: false, error: memberError.message });
        }
      }

      return res.status(200).json({ success: true, household });
    }

    if (action === 'updateHousehold') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { householdId, name, notes, metadata, members } = req.body || {};
      if (!householdId) return res.status(400).json({ success: false, error: 'householdId required' });

      const updates = {};
      if (name !== undefined) updates.name = name;
      if (notes !== undefined) updates.notes = notes;
      if (metadata !== undefined) {
        const { data: current } = await supabaseAdmin
          .from('households')
          .select('metadata')
          .eq('id', householdId)
          .eq('user_id', user.id)
          .single();
        updates.metadata = { ...(current?.metadata || {}), ...metadata };
      }

      if (Object.keys(updates).length > 0) {
        const { error } = await supabaseAdmin
          .from('households')
          .update(updates)
          .eq('id', householdId)
          .eq('user_id', user.id);

        if (error) return res.status(400).json({ success: false, error: error.message });
      }

      // Replace members if provided
      if (members !== undefined) {
        await supabaseAdmin
          .from('household_members')
          .delete()
          .eq('household_id', householdId);

        if (members.length > 0) {
          const { error: memberError } = await supabaseAdmin
            .from('household_members')
            .insert(members.map(m => ({
              household_id: householdId,
              contact_id: m.contactId,
              role: m.role || 'adult'
            })));

          if (memberError) return res.status(400).json({ success: false, error: memberError.message });
        }
      }

      return res.status(200).json({ success: true });
    }

    if (action === 'deleteHousehold') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { householdId } = req.body || {};
      if (!householdId) return res.status(400).json({ success: false, error: 'householdId required' });

      const { error } = await supabaseAdmin
        .from('households')
        .delete()
        .eq('id', householdId)
        .eq('user_id', user.id);

      if (error) return res.status(400).json({ success: false, error: error.message });

      return res.status(200).json({ success: true });
    }

    // ================================================================
    // IMPORT FROM EVENT
    // ================================================================

    if (action === 'importFromEvent') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { sourceEventId, statusFilter, tagId } = req.body || {};
      if (!sourceEventId) return res.status(400).json({ success: false, error: 'sourceEventId required' });

      // Verify event ownership
      const { data: event } = await supabaseAdmin
        .from('events')
        .select('id')
        .eq('id', sourceEventId)
        .eq('user_id', user.id)
        .single();

      if (!event) return res.status(404).json({ success: false, error: 'Event not found' });

      // Fetch guests from that event
      let guestQuery = supabaseAdmin
        .from('guests')
        .select('name, email, phone, status, response_data')
        .eq('event_id', sourceEventId);

      if (statusFilter) guestQuery = guestQuery.eq('status', statusFilter);

      const { data: guests } = await guestQuery;

      if (!guests || guests.length === 0) {
        return res.status(200).json({ success: true, created: 0, updated: 0, skipped: 0 });
      }

      // Use bulkCreate logic via internal call
      const contactInputs = guests.map(g => ({
        name: g.name,
        email: g.email,
        phone: g.phone,
        metadata: g.response_data || {}
      }));

      // Fetch existing contacts for dedup
      const { data: existing } = await supabaseAdmin
        .from('contacts')
        .select('id, email, phone, metadata')
        .eq('user_id', user.id);

      const existingByEmail = {};
      const existingByPhone = {};
      (existing || []).forEach(c => {
        if (c.email) existingByEmail[c.email.toLowerCase()] = c;
        if (c.phone) {
          const norm = normalizePhone(c.phone);
          if (norm) existingByPhone[norm] = c;
        }
      });

      let created = 0, updated = 0, skipped = 0;
      const newContacts = [];

      for (const input of contactInputs) {
        if (!input.name) { skipped++; continue; }

        const emailKey = input.email ? input.email.toLowerCase() : null;
        const phoneKey = input.phone ? normalizePhone(input.phone) : null;

        const match = (emailKey && existingByEmail[emailKey]) ||
                      (phoneKey && existingByPhone[phoneKey]);

        if (match) {
          skipped++;
        } else {
          newContacts.push({
            user_id: user.id,
            name: input.name,
            email: input.email || null,
            phone: input.phone || null,
            metadata: input.metadata || {},
            source: 'rsvp',
            source_event_id: sourceEventId
          });
          created++;
          if (emailKey) existingByEmail[emailKey] = { email: input.email };
          if (phoneKey) existingByPhone[phoneKey] = { phone: input.phone };
        }
      }

      let insertedIds = [];
      if (newContacts.length > 0) {
        const { data: inserted, error } = await supabaseAdmin
          .from('contacts')
          .insert(newContacts)
          .select('id');

        if (error) return res.status(400).json({ success: false, error: error.message });
        insertedIds = (inserted || []).map(c => c.id);
      }

      // Assign tag if provided
      if (tagId && insertedIds.length > 0) {
        await supabaseAdmin
          .from('contact_tag_assignments')
          .insert(insertedIds.map(cid => ({ contact_id: cid, tag_id: tagId })));
      }

      return res.status(200).json({ success: true, created, updated, skipped });
    }

    // ================================================================
    // STATS (for dashboard summary card)
    // ================================================================

    if (action === 'stats') {
      const { data: contacts, error } = await supabaseAdmin
        .from('contacts')
        .select('id, created_at, source')
        .eq('user_id', user.id);

      if (error) return res.status(400).json({ success: false, error: error.message });

      const total = (contacts || []).length;
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const recentlyAdded = (contacts || []).filter(c => c.created_at > thirtyDaysAgo).length;

      const { data: tags } = await supabaseAdmin
        .from('contact_tags')
        .select('id, name, color')
        .eq('user_id', user.id)
        .order('name', { ascending: true })
        .limit(5);

      return res.status(200).json({
        success: true,
        stats: { total, recentlyAdded },
        topTags: tags || []
      });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch (err) {
    console.error('Contacts API error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
}

function formatContact(row, tagMap) {
  const tags = (row.contact_tag_assignments || [])
    .map(a => tagMap[a.tag_id])
    .filter(Boolean)
    .map(t => ({ id: t.id, name: t.name, color: t.color }));

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    phone: row.phone,
    notes: row.notes,
    metadata: row.metadata || {},
    source: row.source,
    sourceEventId: row.source_event_id,
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}
