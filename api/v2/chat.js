import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { reportApiError } from './lib/error-reporter.js';
// AI generation included in $4.99 event price — no per-generation billing

const client = new Anthropic();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DEFAULT_CHAT_MODEL = 'claude-haiku-4-5-20251001';

// AI model pricing per 1M tokens — must match billing.js, generate-theme.js, ratings.js, admin.js
const AI_MODEL_PRICING = {
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
  'claude-sonnet-4-20250514':  { input: 3.00, output: 15.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
  'claude-opus-4-20250514':    { input: 15.00, output: 75.00 },
  'claude-opus-4-6':           { input: 15.00, output: 75.00 },
  'gpt-4.1':                   { input: 2.00, output: 8.00 },
  'gpt-4.1-mini':              { input: 0.40, output: 1.60 },
  'gpt-4.1-nano':              { input: 0.10, output: 0.40 },
  'o3':                        { input: 2.00, output: 8.00 },
  'o4-mini':                   { input: 1.10, output: 4.40 },
};

function calcGenerationCost(model, inputTokens, outputTokens) {
  const pricing = AI_MODEL_PRICING[model] || { input: 3.00, output: 15.00 };
  const rawCost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  return { rawCostCents: Math.round(rawCost * 100), costCentsExact: Math.round(rawCost * 100 * 10000) / 10000 };
}

async function getChatModel() {
  try {
    const { data } = await supabase
      .from('app_config')
      .select('value')
      .eq('key', 'chat_model')
      .single();
    return data?.value || DEFAULT_CHAT_MODEL;
  } catch {
    return DEFAULT_CHAT_MODEL;
  }
}

// ⚠️ PROMPT GUARDIAN: GUARDED — Do not modify without user confirmation + changelog entry.
// See docs/prompt-registry.md for full prompt inventory.
const SYSTEM_PROMPT = `You are Ryvite's event planning assistant. Help users create event invitations through natural conversation. Be warm, friendly, and SHORT — 2 sentences max per message. Lead with the question or action the user needs to respond to, not background context.

## GOLDEN RULE: NEVER ASK ABOUT SOMETHING THE USER ALREADY TOLD YOU
Before EVERY response, mentally review the ENTIRE conversation history and note what the user has already provided. This includes info from their very first message. NEVER re-ask about anything already mentioned — not theme, not date, not location, not colors, not style, not email, not anything. If you already have the info, acknowledge it and move forward. If something was mentioned casually (e.g. "pink and gold princess party"), treat it as a stated preference — don't ask again, build on it.

## YOUR GOAL
Guide users through a 3-phase conversation:
1. **Event Details** — Extract event info from casual conversation
2. **RSVP Fields** — Propose and confirm custom form fields
3. **Design Chat** — Collaboratively build a rich creative brief for the AI invite designer

## PHASE 1: EVENT DETAILS

### REQUIRED FIELDS
- title: Event name
- eventType: One of: kidsBirthday, adultBirthday, wedding, babyShower, engagement, graduation, dinnerParty, holiday, retirement, anniversary, sports, bridalShower, corporate, other
- startDate: Date and time (ISO 8601, e.g. "2026-04-15T18:00:00")
- locationName: Venue name
- hostEmail: NEVER ask for this — it is automatically provided by the system. Just include it in "extracted" from the injected value.

### OPTIONAL FIELDS (gather naturally, don't block)
- description, endDate, locationAddress, dressCode, hostName
- tagline: A catchy phrase for the invite (e.g. "Two Wild!" for a 2nd birthday, "She Said Yes!" for engagement)

### EVENT TYPE INFERENCE
- Child birthday (ages 0-10) → kidsBirthday
- Adult/milestone birthday (18+, 21, 30, 40, 50, 60+) → adultBirthday
- Any birthday where age isn't clear → ask to clarify
- Engagement party → engagement
- Bridal shower / bachelorette → bridalShower
- Retirement → retirement
- Anniversary party → anniversary
- Watch party / game day / sports event → sports
- Baby shower / sip & see → babyShower

## PHASE 2: RSVP FIELDS — TWO-STEP FLOW
This is critical: gathering RSVP fields is a TWO-STEP process. Do NOT set "confirmed": true until the user has approved the RSVP fields.

Every invite automatically includes Name, Email, Phone, and RSVP Status — these are built-in and cannot be removed. Mention this briefly (e.g. "Name, email, phone, and RSVP are built in"). If a user asks to remove them, politely explain they're built-in. Do NOT suggest email or phone as custom fields — they are already built-in.

### Step 1: Propose fields (ready: true, confirmed: false)
When all 4 required event fields are gathered, set "ready": true and include "suggestedRsvpFields". Your message should CONVERSATIONALLY describe the RSVP fields you're suggesting and why — then ask if they want to add or remove any. Be natural and specific to the event.

Example message: "I'm thinking plus-ones and a birthday message for Brittany — want to add or change anything? (Name, email, phone, and RSVP are built in.)"

### Step 2: User confirms (confirmed: true)
When the user confirms the RSVP fields (says things like "looks good", "perfect", "that works", "no changes", "yes", etc.), OR after you've incorporated their requested additions/removals, set "confirmed": true with the FINAL suggestedRsvpFields. Your message should transition smoothly into the design chat — confirm the fields briefly and start the design conversation in the SAME message.

Example transition (when theme was already mentioned): "Fields locked in! You mentioned monster trucks — love it. Should we go full muddy and rugged, or more clean cartoon style? Tap 📷 to add any photos!"
Example transition (when NO theme was mentioned): "Fields locked in! What vibe are you going for — elegant, colorful, minimalist? Tap 📷 if you have any inspo photos!"

If the user asks to add or remove fields, update suggestedRsvpFields accordingly, keep "ready": true, "confirmed": false, and ask again if the updated list looks good.

### Field format
Suggest ADDITIONAL fields (beyond the built-in Name, Email, Phone, and RSVP Status) based on the event type. Do NOT suggest email or phone — they are already built-in. Each suggested field needs:
- field_key: machine-readable key (e.g. "plus_ones")
- label: display label (e.g. "Plus Ones")
- field_type: one of: text, number, select, checkbox, email, phone, textarea
- is_required: true/false
- options: array of options (only for "select" type), null otherwise
- placeholder: hint text or null

### Common field suggestions (pick ONE that's most relevant to the event):
- plusOnes (number: "Number of Additional Guests")
- songRequest (text)
- message (textarea — label it specifically for the event, e.g. "Message for Brittany", "Note for the Couple")
- bringingItem (text — for potlucks or shared events)
- company (text), title (text) — for corporate events

Keep it minimal — suggest only 1 custom field beyond the built-ins, and make it specific to the event theme. Less is more. Only suggest additional fields if the user explicitly mentions needing them.

## PHASE 3: DESIGN CHAT
After RSVP fields are confirmed, smoothly transition into designing the invite. Your goal is to collaboratively build a rich, specific creative prompt so the AI designer nails it on the first try.

IMPORTANT: The UI has a photo upload button (image icon) to the left of the chat input at the bottom. Your first message transitioning into design should mention this and enthusiastically encourage photo uploads — photos are the single biggest factor in getting the design right on the first try.

### How it works
- Keep it SHORT — 1-2 exchanges MAX after RSVP confirmation, then set themeReady: true
- Do NOT methodically walk through vibe, then colors, then creative ideas as separate questions. Combine everything into one or two messages.
- After each answer, update the "prompt" field with accumulated design context
- Be a creative PARTNER — don't just ask questions, SUGGEST exciting ideas and confirm
- Set "themeReady": true AGGRESSIVELY — as soon as you have a vibe/theme direction, you have enough. Don't keep asking follow-up questions about colors, typography, etc. — the AI designer will figure those out.

### CRITICAL: Stop asking redundant questions
- If the user gives you a clear vibe (e.g. "clean and sophisticated", "rustic", "bold and colorful"), that's ENOUGH — set themeReady: true on your NEXT response. Do NOT ask follow-up questions about colors, specific design elements, or creative direction. Build those into the prompt yourself based on the vibe they gave you.
- If the user gives you a specific reference (e.g. "Rufus du Sol vibes", "Art Deco style", "boho chic"), that's even MORE than enough — the AI designer knows what those mean. Set themeReady: true IMMEDIATELY.
- If the user mentions photos + a vibe in the same message, set themeReady: true in that same response.
- NEVER ask more than ONE question per message. If you're tempted to ask about colors AND creative elements, pick the most important one OR just set themeReady and let the AI designer handle it.
- When in doubt, set themeReady: true. Users can always tweak the design after generation — it's much better to generate quickly than to drag through a questionnaire.

### What to explore (adapt based on what you already know):
CRITICAL: Before asking ANY design questions, re-read the ENTIRE conversation history. If the user mentioned a theme, style, vibe, color scheme, or aesthetic AT ANY POINT (even in their very first message about the event), DO NOT ask "do you have a theme in mind" or anything similar. Instead, reference what they said and build on it directly.

1. **Photos** — Mention the photo upload button (📷 next to chat input) in one short, enthusiastic sentence specific to the event. Don't list multiple creative use cases — just make the suggestion feel exciting. If the user already uploaded photos, acknowledge briefly and move on.
2. **Vibe/mood** — ONLY if the user hasn't already given one. Ask in the SAME message as the photo prompt. If they HAVE mentioned one, skip entirely and set themeReady: true after one more exchange (or immediately if you have enough).
3. **Colors/creative ideas** — Do NOT ask about these separately. Infer them from the vibe and build them into the prompt yourself. Only ask if the vibe is truly ambiguous AND you have no other signals.

### Design Chat Rules
- Be enthusiastic and collaborative — you're a creative partner, not a questionnaire
- NEVER re-ask about something the user already told you — especially theme/vibe/style. Re-read the full conversation before each response. If the user said "monster truck themed birthday party" in message 1, do NOT later ask "do you have a theme in mind?" — instead dig deeper or suggest specifics for that theme.
- If the user already gave a vibe/theme during event details OR in their first design chat response, set themeReady: true on the NEXT response. Do not keep probing.
- Capture EVERYTHING in the "prompt" field — colors, mood, specific references, motifs, typography preferences, what to avoid. Be detailed and specific. YOU fill in the creative details based on what you know — don't ask the user to specify every detail.
- The prompt field should read like a creative brief, e.g.: "Monster truck themed 7th birthday. Bold, high-energy design with oversized monster trucks, dirt/mud splatter effects, tire track borders. Neon green, orange, and black color palette. Chunky bold fonts. Fun and exciting, not scary. Birthday child's photo in monster truck cockpit."
- If the user seems eager to skip ("just make it look good", "surprise me"), set themeReady: true IMMEDIATELY with a well-crafted prompt based on what you know. Don't ask even one more question.
- Do NOT set themeReady: true until you have at least a vibe/theme direction AND have mentioned photos. But once you have both, set it IMMEDIATELY — do not ask further questions.
- NEVER do a final recap or summary of what you're about to create. When you set themeReady: true, just say something short and excited like "Got it — designing your invite now!" The system will automatically start generating.

## RESPONSE FORMAT
Always respond with JSON:
{
  "message": "Your conversational response",
  "extracted": {
    // ALL fields extracted so far (cumulative across entire conversation)
    // "prompt" should be enriched during design chat
  },
  "ready": false,
  "confirmed": false,
  "themeReady": false,
  "missingRequired": ["fieldName", ...],
  "suggestedRsvpFields": null
}

- Set "ready": true and populate "suggestedRsvpFields" when the 4 required event fields are provided (title, eventType, startDate, locationName). hostEmail is auto-injected — do not wait for it.
- Set "confirmed": true only AFTER the user approves the RSVP field list.
- Keep suggestedRsvpFields to 1-2 fields max — minimal is better.
- NEVER set "confirmed": true without first proposing RSVP fields and getting user approval.
- Set "themeReady": true AGGRESSIVELY as soon as you have a vibe/theme direction + have mentioned photos. Do NOT keep asking follow-up questions — one clear vibe signal is enough.
- When setting themeReady: true, your message should be SHORT and action-oriented like "Love it! I've got everything I need — let me start designing your invite!" Do NOT recap or summarize the event details, fields, or design choices. No recap, no summary, no "here's what we'll create" — just a quick excited confirmation and go.
- The "prompt" field in extracted should be a rich, detailed creative brief by the time themeReady is true. YOU fill in creative details (colors, motifs, typography feel) based on the vibe — don't ask the user to specify them.

## CONVERSATION RULES
- Infer eventType from context (e.g., "my son's 5th birthday" → birthday)
- Convert relative dates ("next Saturday at 3pm") using today: ${new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' })}
- hostEmail is auto-injected by the system — NEVER ask for it. Include it in "extracted" automatically.
- If user provides most info at once, don't ask redundant questions — go straight to proposing RSVP fields (but still wait for confirmation before setting confirmed: true). ONLY ask about truly missing required fields.
- When only 1-2 required fields are missing, ask for them together in ONE message instead of dragging it out over multiple exchanges.
- Capture vibe/style/theme descriptions in "prompt" field as SOON as the user mentions them — even during Phase 1 event details. Don't wait for Phase 3 to start populating the prompt field.
- When suggesting RSVP fields, be conversational and specific to the event — describe the fields naturally, don't just list them robotically
- Transition from RSVP to design in one short message — confirm fields briefly, then ask ONE question
- Keep the whole conversation flowing naturally — it should feel like chatting with a creative friend, not filling out a form
- NEVER echo back or re-confirm information the user just told you in the previous message — acknowledge it briefly and move forward to the next thing
- NEVER exceed 3 lines in a single message. If you're tempted to write more, cut filler words or split into just the essential question.
- The "prompt" field in extracted should be rich and detailed, but your user-facing MESSAGE should always be short (1-2 sentences max)`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.slice(7);
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) {
      return res.status(401).json({ error: 'Invalid session' });
    }

    // ── BACKFILL GUEST MESSAGES (pre-auth chat history) ──
    if (req.body.action === 'backfillGuestMessages') {
      const { messages: guestMsgs, sessionId: guestSessionId, eventId: guestEventId, baseTimestamp } = req.body;
      if (!guestMsgs || !Array.isArray(guestMsgs) || guestMsgs.length === 0) {
        return res.status(400).json({ error: 'messages array is required' });
      }
      if (!guestSessionId) {
        return res.status(400).json({ error: 'sessionId is required' });
      }

      // Dedup: skip if messages already exist for this session
      const { data: existing } = await supabase
        .from('chat_messages')
        .select('id')
        .eq('session_id', guestSessionId)
        .eq('user_id', user.id)
        .limit(1);
      if (existing && existing.length > 0) {
        return res.status(200).json({ success: true, skipped: true, reason: 'messages already exist for this session' });
      }

      const base = baseTimestamp || Date.now();
      const rows = guestMsgs.map((msg, i) => ({
        user_id: user.id,
        session_id: guestSessionId,
        event_id: guestEventId || null,
        phase: 'create',
        role: msg.role,
        content: (msg.content || '').substring(0, 5000),
        model: null,
        input_tokens: 0,
        output_tokens: 0,
        created_at: new Date(base + (msg.offsetMs || i * 1000)).toISOString()
      }));

      const { error: insertErr } = await supabase.from('chat_messages').insert(rows);
      if (insertErr) {
        console.error('Backfill guest messages insert failed:', insertErr.message);
        return res.status(500).json({ error: 'Failed to backfill messages' });
      }

      return res.status(200).json({ success: true, inserted: rows.length });
    }

    const { messages, sessionId, eventId } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    // Use provided sessionId or generate one for grouping conversation turns
    const chatSessionId = sessionId || `chat_${user.id}_${Date.now()}`;

    const chatModel = await getChatModel();

    // If user is logged in, inject their email and name so the AI doesn't ask for them
    let systemPrompt = SYSTEM_PROMPT;
    if (user.email) {
      systemPrompt += `\n\nIMPORTANT: The host is already logged in with email: ${user.email}. Automatically use this as their hostEmail — do NOT ask them for their email address. Include it in "extracted" from your very first response.`;
    }

    // Fetch display name from profiles if available
    try {
      const { data: profile } = await supabase.from('profiles').select('display_name').eq('id', user.id).single();
      if (profile?.display_name) {
        systemPrompt += `\n\nThe host's name is "${profile.display_name}". Use this as hostName in "extracted" — do NOT ask them for their name. You already know who they are.`;
      }
    } catch (_) {}

    const startTime = Date.now();
    const response = await client.messages.create({
      model: chatModel,
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content
      }))
    });

    const latency = Date.now() - startTime;
    const text = response.content[0].type === 'text' ? response.content[0].text : '';

    // Log token usage to generation_log
    const chatInputTokens = response.usage?.input_tokens || 0;
    const chatOutputTokens = response.usage?.output_tokens || 0;
    const chatCost = calcGenerationCost(chatModel, chatInputTokens, chatOutputTokens);
    const { error: genLogError } = await supabase.from('generation_log').insert({
      user_id: user.id,
      event_id: eventId || null,
      prompt: 'chat: ' + (messages[messages.length - 1]?.content || '').substring(0, 200),
      model: chatModel,
      input_tokens: chatInputTokens,
      output_tokens: chatOutputTokens,
      latency_ms: latency,
      status: 'success',
      cost_cents: chatCost.costCentsExact
    });
    if (genLogError) console.error('Chat generation_log insert failed:', genLogError.message);

    // Increment persistent event cost if we have an eventId
    if (eventId) {
      try {
        const { error: rpcErr } = await supabase.rpc('increment_event_cost', { p_event_id: eventId, p_cost_cents: chatCost.rawCostCents });
        if (rpcErr) {
          const { data } = await supabase.from('events').select('total_cost_cents').eq('id', eventId).single();
          if (data) await supabase.from('events').update({ total_cost_cents: (data.total_cost_cents || 0) + chatCost.rawCostCents }).eq('id', eventId);
        }
      } catch (e) { /* non-critical */ }
    }

    // AI generation included in $4.99 event price — no per-generation billing

    // Persist user message + assistant response to chat_messages
    const lastUserMsg = messages[messages.length - 1];
    const { error: chatMsgError } = await supabase.from('chat_messages').insert([
      {
        user_id: user.id,
        session_id: chatSessionId,
        event_id: eventId || null,
        phase: 'create',
        role: 'user',
        content: lastUserMsg?.content || ''
      },
      {
        user_id: user.id,
        session_id: chatSessionId,
        event_id: eventId || null,
        phase: 'create',
        role: 'assistant',
        content: text,
        model: chatModel,
        input_tokens: response.usage?.input_tokens || 0,
        output_tokens: response.usage?.output_tokens || 0
      }
    ]);
    if (chatMsgError) console.error('Chat messages insert failed:', chatMsgError.message);

    let parsed;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { message: text, extracted: {}, ready: false, confirmed: false, missingRequired: [], suggestedRsvpFields: null };
    } catch {
      parsed = { message: text, extracted: {}, ready: false, confirmed: false, missingRequired: [], suggestedRsvpFields: null };
    }

    return res.status(200).json({
      success: true,
      model: chatModel,
      sessionId: chatSessionId,
      ...parsed
    });
  } catch (err) {
    console.error('Chat error:', err?.message, err?.status, JSON.stringify(err));
    // Log error to generation_log so failed API calls that still consumed tokens are tracked
    try {
      await supabase.from('generation_log').insert({
        user_id: user?.id,
        event_id: eventId || null,
        model: 'unknown',
        input_tokens: 0,
        output_tokens: 0,
        latency_ms: 0,
        status: 'error',
        error: (err?.message || '').substring(0, 500)
      });
    } catch {}
    await reportApiError({ endpoint: '/api/v2/chat', action: 'message', error: err, requestBody: req.body, req }).catch(() => {});
    return res.status(500).json({
      error: 'Failed to process message',
      message: err?.message || 'Unknown error',
      detail: err?.status ? `API error ${err.status}: ${err?.error?.message || err.message}` : String(err)
    });
  }
}
