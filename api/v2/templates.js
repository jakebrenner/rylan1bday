import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Event type labels and SEO-friendly slugs
const EVENT_TYPES = {
  wedding:       { label: 'Wedding',           slug: 'wedding-invitations' },
  kidsBirthday:  { label: 'Kids Birthday',     slug: 'birthday-invitations' },
  adultBirthday: { label: 'Adult Birthday',    slug: 'adult-birthday-invitations' },
  babyShower:    { label: 'Baby Shower',        slug: 'baby-shower-invitations' },
  bridalShower:  { label: 'Bridal Shower',      slug: 'bridal-shower-invitations' },
  engagement:    { label: 'Engagement Party',   slug: 'engagement-party-invitations' },
  anniversary:   { label: 'Anniversary',        slug: 'anniversary-invitations' },
  graduation:    { label: 'Graduation',         slug: 'graduation-invitations' },
  corporate:     { label: 'Corporate Event',    slug: 'corporate-event-invitations' },
  holiday:       { label: 'Holiday Party',      slug: 'holiday-party-invitations' },
  dinnerParty:   { label: 'Dinner Party',       slug: 'dinner-party-invitations' },
  retirement:    { label: 'Retirement',         slug: 'retirement-party-invitations' },
  sports:        { label: 'Sports / Watch Party', slug: 'sports-party-invitations' },
  other:         { label: 'Other',              slug: 'other-invitations' },
};

// Reverse lookup: slug → event type key
const SLUG_TO_TYPE = {};
for (const [key, val] of Object.entries(EVENT_TYPES)) {
  SLUG_TO_TYPE[val.slug] = key;
}

// Type-specific dummy data for privacy protection
const DUMMY_DATA = {
  wedding: {
    title: 'Sarah & James',
    datetime: 'Saturday, September 20th<br>5:00 PM',
    location: 'The Grand Ballroom<br>123 Celebration Ave, New York, NY',
    dresscode: 'Black Tie Optional',
    host: 'The Miller & Thompson Families'
  },
  kidsBirthday: {
    title: "Mia's 5th Birthday Party!",
    datetime: 'Saturday, July 12th<br>2:00 \u2013 5:00 PM',
    location: 'Sunshine Park Pavilion<br>456 Oak Street, Austin, TX',
    host: 'The Garcia Family'
  },
  adultBirthday: {
    title: "Jake's 30th Birthday Bash",
    datetime: 'Friday, August 15th<br>8:00 PM',
    location: 'The Rooftop Lounge<br>789 Broadway, Brooklyn, NY',
    host: 'Hosted by Emma & Friends'
  },
  babyShower: {
    title: 'Baby Shower for Emily',
    datetime: 'Sunday, March 9th<br>1:00 PM',
    location: 'The Garden Room<br>321 Rose Lane, Savannah, GA',
    host: 'Hosted by Rachel & Claire'
  },
  bridalShower: {
    title: "Lauren's Bridal Shower",
    datetime: 'Saturday, May 3rd<br>11:00 AM',
    location: 'Rosewood Tea House<br>88 Blossom Way, Charleston, SC',
    host: 'Hosted by the Bridesmaids'
  },
  engagement: {
    title: 'Alex & Taylor are Engaged!',
    datetime: 'Saturday, June 7th<br>6:00 PM',
    location: 'The Vineyard Estate<br>200 Hillcrest Dr, Napa, CA',
    host: 'The Roberts & Chen Families'
  },
  anniversary: {
    title: 'David & Maria\u2019s 25th Anniversary',
    datetime: 'Saturday, October 18th<br>7:00 PM',
    location: 'The Lake House<br>50 Shore Drive, Lake Tahoe, CA',
    host: 'Hosted by Their Children'
  },
  graduation: {
    title: "Ryan's Graduation Party",
    datetime: 'Sunday, May 25th<br>3:00 PM',
    location: 'The Backyard<br>742 Elm Street, Portland, OR',
    host: 'The Johnson Family'
  },
  corporate: {
    title: 'Q4 Innovation Summit',
    datetime: 'Thursday, November 6th<br>9:00 AM \u2013 5:00 PM',
    location: 'Grand Hyatt Conference Center<br>200 Park Ave, New York, NY',
    host: 'Acme Corp'
  },
  holiday: {
    title: 'Annual Holiday Celebration',
    datetime: 'Saturday, December 13th<br>7:00 PM',
    location: 'The Winter Lodge<br>15 Snowfall Lane, Aspen, CO',
    host: 'The Petersons'
  },
  dinnerParty: {
    title: 'An Evening to Remember',
    datetime: 'Friday, April 11th<br>7:30 PM',
    location: 'The Private Dining Room<br>55 Mercer St, SoHo, NY',
    host: 'Hosted by Olivia & Marcus'
  },
  retirement: {
    title: "Cheers to Tom's Retirement",
    datetime: 'Friday, September 5th<br>5:00 PM',
    location: 'Harbor View Club<br>100 Marina Blvd, San Francisco, CA',
    host: 'The Whole Team'
  },
  sports: {
    title: 'Super Bowl Watch Party',
    datetime: 'Sunday, February 8th<br>4:00 PM',
    location: "Mike's Place<br>33 Victory Lane, Dallas, TX",
    host: 'Hosted by Mike & Kevin'
  },
  other: {
    title: "You're Invited!",
    datetime: 'Saturday, August 16th<br>6:00 PM',
    location: 'The Venue<br>789 Main Street, Chicago, IL',
    host: 'Your Hosts'
  }
};

// Sanitize theme HTML: blank any text inside data-field elements to prevent PII leakage.
// The frontend injection script overwrites these anyway, but this is belt-and-suspenders.
function sanitizeHtml(html) {
  if (!html) return html;
  // Blank data-field text content (will be injected at runtime)
  html = html.replace(
    /(<[^>]+data-field="[^"]*"[^>]*>)([\s\S]*?)(<\/)/g,
    function(match, open, content, close) {
      if (!content.includes('<')) return open + '' + close;
      return match;
    }
  );
  // Strip baked-in form inputs from .rsvp-slot — platform injects these at runtime.
  // Preserve only the RSVP button inside the slot.
  html = html.replace(
    /(<div[^>]*class="[^"]*rsvp-slot[^"]*"[^>]*>)([\s\S]*?)(<\/div>)/gi,
    function(match, openTag, content, closeTag) {
      // Extract just the button (if present)
      var btnMatch = content.match(/<button[^>]*class="[^"]*rsvp-button[^"]*"[^>]*>[\s\S]*?<\/button>/i);
      return openTag + (btnMatch ? btnMatch[0] : '') + closeTag;
    }
  );
  return html;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Cache gallery responses for 5 minutes
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const action = req.query?.action || 'list';

  // ── LIST GALLERY TEMPLATES ──
  if (action === 'list') {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 24, 48);
    const offset = (page - 1) * limit;
    const eventTypeFilter = req.query.eventType;

    let query = supabase
      .from('gallery_templates')
      .select('id, html, css, config, admin_rating, model, created_at, event_type, source', { count: 'exact' });

    if (eventTypeFilter) {
      query = query.eq('event_type', eventTypeFilter);
    }

    query = query.order('admin_rating', { ascending: false })
                 .order('created_at', { ascending: false })
                 .range(offset, offset + limit - 1);

    const { data, error, count } = await query;
    if (error) return res.status(400).json({ error: error.message });

    // Deduplicate by HTML content — same design can appear from multiple sources
    // or from independently-rated identical generations
    const seenHtml = new Set();
    const templates = [];
    for (const t of (data || [])) {
      // Use first 500 chars of HTML as fingerprint (enough to identify identical designs)
      const fingerprint = (t.html || '').substring(0, 500);
      if (seenHtml.has(fingerprint)) continue;
      seenHtml.add(fingerprint);
      const eventType = t.event_type || 'other';
      const typeInfo = EVENT_TYPES[eventType] || EVENT_TYPES.other;
      const dummyData = DUMMY_DATA[eventType] || DUMMY_DATA.other;
      templates.push({
        id: t.id,
        eventType,
        eventTypeLabel: typeInfo.label,
        eventTypeSlug: typeInfo.slug,
        html: sanitizeHtml(t.html),
        css: t.css || '',
        config: t.config,
        adminRating: t.admin_rating,
        source: t.source,
        dummyData
      });
    }

    // Get event types with counts for the filter bar (deduplicated)
    const { data: typeCounts, error: typeErr } = await supabase
      .from('gallery_templates')
      .select('event_type, html');

    let eventTypes = [];
    if (!typeErr && typeCounts) {
      const counts = {};
      const seenCountHtml = new Set();
      typeCounts.forEach(r => {
        const fp = (r.html || '').substring(0, 500);
        if (seenCountHtml.has(fp)) return;
        seenCountHtml.add(fp);
        const et = r.event_type || 'other';
        counts[et] = (counts[et] || 0) + 1;
      });
      eventTypes = Object.entries(counts)
        .map(([key, cnt]) => ({
          key,
          label: (EVENT_TYPES[key] || EVENT_TYPES.other).label,
          slug: (EVENT_TYPES[key] || EVENT_TYPES.other).slug,
          count: cnt
        }))
        .sort((a, b) => b.count - a.count);
    }

    return res.status(200).json({
      success: true,
      templates,
      total: count || 0,
      page,
      limit,
      eventTypes
    });
  }

  // ── GET SINGLE TEMPLATE ──
  if (action === 'get') {
    const templateId = req.query.templateId;
    if (!templateId) return res.status(400).json({ error: 'templateId required' });

    const { data, error } = await supabase
      .from('gallery_templates')
      .select('id, html, css, config, admin_rating, model, created_at, event_type, source')
      .eq('id', templateId)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'Design not found' });
    }

    const eventType = data.event_type || 'other';
    const typeInfo = EVENT_TYPES[eventType] || EVENT_TYPES.other;
    const dummyData = DUMMY_DATA[eventType] || DUMMY_DATA.other;

    return res.status(200).json({
      success: true,
      template: {
        id: data.id,
        eventType,
        eventTypeLabel: typeInfo.label,
        eventTypeSlug: typeInfo.slug,
        html: sanitizeHtml(data.html),
        css: data.css || '',
        config: data.config,
        adminRating: data.admin_rating,
        source: data.source,
        dummyData
      }
    });
  }

  // ── LIST EVENT TYPES WITH GALLERY COUNTS ──
  if (action === 'eventTypes') {
    const { data, error } = await supabase
      .from('gallery_templates')
      .select('event_type');

    if (error) return res.status(400).json({ error: error.message });

    const counts = {};
    (data || []).forEach(r => {
      const et = r.event_type || 'other';
      counts[et] = (counts[et] || 0) + 1;
    });

    const eventTypes = Object.entries(counts)
      .map(([key, cnt]) => ({
        key,
        label: (EVENT_TYPES[key] || EVENT_TYPES.other).label,
        slug: (EVENT_TYPES[key] || EVENT_TYPES.other).slug,
        count: cnt
      }))
      .sort((a, b) => b.count - a.count);

    return res.status(200).json({ success: true, eventTypes, total: (data || []).length });
  }

  return res.status(400).json({ error: 'Unknown action: ' + action });
}
