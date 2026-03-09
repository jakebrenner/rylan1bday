import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const client = new Anthropic();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DEFAULT_CHAT_MODEL = 'claude-haiku-4-5-20251001';

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

const SYSTEM_PROMPT = `You are Ryvite's event planning assistant. Help users create event invitations through natural conversation. Be warm, friendly, and concise (1-3 sentences per response).

## YOUR GOAL
Extract event information from casual conversation. Ask follow-up questions for missing REQUIRED fields. Once you have all required fields, suggest RSVP form fields tailored to the event type.

## REQUIRED FIELDS
- title: Event name
- eventType: One of: birthday, wedding, babyShower, graduation, dinnerParty, holiday, corporate, other
- startDate: Date and time (ISO 8601, e.g. "2026-04-15T18:00:00")
- locationName: Venue name

## OPTIONAL FIELDS (gather naturally, don't block)
- description, endDate, locationAddress, dressCode
- prompt: Creative direction / vibe for the AI designer

## RSVP FIELDS
When all required fields are gathered, suggest RSVP form fields. Every event gets these DEFAULT fields (don't list these — they're automatic):
- Name (text, required)
- RSVP Status (attending/declined/maybe, required)

Suggest ADDITIONAL fields based on the event type. Each suggested field needs:
- field_key: machine-readable key (e.g. "dietary_restrictions")
- label: display label (e.g. "Dietary Restrictions")
- field_type: one of: text, number, select, checkbox, email, phone, textarea
- is_required: true/false
- options: array of options (only for "select" type), null otherwise
- placeholder: hint text or null

### Typical suggestions by event type:
- **birthday**: plusOnes (number), dietaryRestrictions (text)
- **wedding**: plusOnes (number), mealChoice (select: Chicken/Fish/Vegetarian/Vegan), dietaryRestrictions (text), songRequest (text)
- **babyShower**: plusOnes (number), giftRegistryNote (text)
- **graduation**: plusOnes (number), dietaryRestrictions (text)
- **dinnerParty**: dietaryRestrictions (text), allergies (text), drinkPreference (select: Wine/Beer/Cocktails/Non-alcoholic)
- **holiday**: plusOnes (number), bringingDish (text)
- **corporate**: company (text), title (text), dietaryRestrictions (text)
- **other**: plusOnes (number), notes (textarea)

Tailor suggestions to context. If someone mentions "potluck" add a "bringing" field. If it's a pool party, skip meal choice.

## RESPONSE FORMAT
Always respond with JSON:
{
  "message": "Your conversational response",
  "extracted": {
    // ALL fields extracted so far (cumulative across entire conversation)
  },
  "ready": false,
  "missingRequired": ["fieldName", ...],
  "suggestedRsvpFields": null
}

Set "ready": true and populate "suggestedRsvpFields" ONLY when all 4 required fields are provided. Example:
{
  "message": "Here's what I've got for Mike's 30th! I've also suggested some RSVP fields — feel free to adjust.",
  "extracted": { "title": "Mike's 30th Birthday Bash", "eventType": "birthday", ... },
  "ready": true,
  "missingRequired": [],
  "suggestedRsvpFields": [
    { "field_key": "plus_ones", "label": "Number of Plus Ones", "field_type": "number", "is_required": false, "options": null, "placeholder": "0" },
    { "field_key": "dietary_restrictions", "label": "Dietary Restrictions", "field_type": "text", "is_required": false, "options": null, "placeholder": "Any allergies or dietary needs?" }
  ]
}

## CONVERSATION RULES
- Infer eventType from context (e.g., "my son's 5th birthday" → birthday)
- Convert relative dates ("next Saturday at 3pm") using today: ${new Date().toISOString().split('T')[0]}
- If user provides most info at once, don't ask redundant questions — go straight to ready
- Capture vibe/style descriptions in "prompt" field
- Keep suggestedRsvpFields to 2-4 fields — don't overwhelm`;

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

    const { messages } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    const chatModel = await getChatModel();
    const startTime = Date.now();
    const response = await client.messages.create({
      model: chatModel,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: messages.map(m => ({
        role: m.role,
        content: m.content
      }))
    });

    const latency = Date.now() - startTime;
    const text = response.content[0].type === 'text' ? response.content[0].text : '';

    // Log token usage (event_id null = chat, non-null = theme)
    try {
      await supabase.from('generation_log').insert({
        user_id: user.id,
        prompt: messages[messages.length - 1]?.content || '',
        model: chatModel,
        input_tokens: response.usage?.input_tokens || 0,
        output_tokens: response.usage?.output_tokens || 0,
        latency_ms: latency,
        status: 'success'
      });
    } catch {}

    let parsed;
    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { message: text, extracted: {}, ready: false, missingRequired: [], suggestedRsvpFields: null };
    } catch {
      parsed = { message: text, extracted: {}, ready: false, missingRequired: [], suggestedRsvpFields: null };
    }

    return res.status(200).json({
      success: true,
      model: chatModel,
      ...parsed
    });
  } catch (err) {
    console.error('Chat error:', err?.message, err?.status, JSON.stringify(err));
    return res.status(500).json({
      error: 'Failed to process message',
      message: err?.message || 'Unknown error',
      detail: err?.status ? `API error ${err.status}: ${err?.error?.message || err.message}` : String(err)
    });
  }
}
