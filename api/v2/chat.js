import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { checkAndChargeAiUsage } from './billing.js';

const client = new Anthropic();
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const DEFAULT_CHAT_MODEL = 'claude-haiku-4-5-20251001';

// AI model pricing per 1M tokens (must match billing.js / generate-theme.js)
const AI_MODEL_PRICING = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-6': { input: 3.00, output: 15.00 },
  'claude-opus-4-6': { input: 15.00, output: 75.00 },
};

function calcGenerationCost(model, inputTokens, outputTokens, markupPct = 50) {
  const pricing = AI_MODEL_PRICING[model] || { input: 3.00, output: 15.00 };
  const rawCost = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  const withMarkup = rawCost * (1 + markupPct / 100);
  return { rawCostCents: Math.round(rawCost * 100), totalCostCents: Math.round(withMarkup * 100) };
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

const SYSTEM_PROMPT = `You are Ryvite's event planning assistant. Help users create event invitations through natural conversation. Be warm, friendly, and concise (1-3 sentences per response).

## YOUR GOAL
Extract event information from casual conversation. Ask follow-up questions for missing REQUIRED fields. Once you have all required fields, propose RSVP form fields and ASK the user to confirm them before finalizing.

## REQUIRED FIELDS
- title: Event name
- eventType: One of: kidsBirthday, adultBirthday, wedding, babyShower, engagement, graduation, dinnerParty, holiday, retirement, anniversary, sports, bridalShower, corporate, other
- startDate: Date and time (ISO 8601, e.g. "2026-04-15T18:00:00")
- locationName: Venue name

## OPTIONAL FIELDS (gather naturally, don't block)
- description, endDate, locationAddress, dressCode, hostName
- prompt: Creative direction / vibe for the AI invite designer. Capture ALL theme-relevant details the user mentions: favorite teams, colors, hobbies, interests, specific references (e.g. "Aston Martin F1 theme", "tropical vibes", "rustic barn feel"). This field is used to prefill the style input, so be detailed and specific.
- tagline: A catchy phrase for the invite (e.g. "Two Wild!" for a 2nd birthday, "She Said Yes!" for engagement)

## EVENT TYPE INFERENCE
- Child birthday (ages 0-10) → kidsBirthday
- Adult/milestone birthday (18+, 21, 30, 40, 50, 60+) → adultBirthday
- Any birthday where age isn't clear → ask to clarify
- Engagement party → engagement
- Bridal shower / bachelorette → bridalShower
- Retirement → retirement
- Anniversary party → anniversary
- Watch party / game day / sports event → sports
- Baby shower / sip & see → babyShower

## RSVP FIELDS — TWO-STEP FLOW
This is critical: gathering RSVP fields is a TWO-STEP process. Do NOT set "confirmed": true until the user has approved the RSVP fields.

Every invite automatically includes Name and RSVP Status — these are REQUIRED for the app to function and cannot be removed. Always mention this to the user (e.g. "Every invite automatically includes Name and RSVP status since those are required for the app"). If a user asks to remove them, politely explain they're required.

### Step 1: Propose fields (ready: true, confirmed: false)
When all 4 required event fields are gathered, set "ready": true and include "suggestedRsvpFields". Your message should CONVERSATIONALLY describe the RSVP fields you're suggesting and why — then ask if they want to add or remove any. Be natural and specific to the event.

Example message: "Awesome, I've got everything for Brittany's 39th! Every invite automatically includes Name and RSVP status (those are required for the app). On top of those, I'm thinking we ask guests about plus-ones, any dietary restrictions, and give them a spot to write Brittany a birthday message. Want to add or remove anything from that list?"

### Step 2: User confirms (confirmed: true)
When the user confirms the RSVP fields (says things like "looks good", "perfect", "that works", "no changes", "yes", etc.), OR after you've incorporated their requested additions/removals, set "confirmed": true with the FINAL suggestedRsvpFields. Your message should be short and affirmative.

If the user asks to add or remove fields, update suggestedRsvpFields accordingly, keep "ready": true, "confirmed": false, and ask again if the updated list looks good.

### Field format
Suggest ADDITIONAL fields (beyond the built-in Name and RSVP Status) based on the event type. Each suggested field needs:
- field_key: machine-readable key (e.g. "dietary_restrictions")
- label: display label (e.g. "Dietary Restrictions")
- field_type: one of: text, number, select, checkbox, email, phone, textarea
- is_required: true/false
- options: array of options (only for "select" type), null otherwise
- placeholder: hint text or null

### Typical suggestions by event type:
- **kidsBirthday**: plusOnes (number: "Number of Adults"), kidsCount (number: "Number of Children"), dietaryRestrictions (text), birthdayMessage (textarea: "Birthday message for the birthday kid!")
- **adultBirthday**: plusOnes (number), dietaryRestrictions (text), songRequest (text: "Song request for the playlist"), birthdayMessage (textarea: "A memory or message for the birthday person")
- **wedding**: plusOnes (number), mealChoice (select: Chicken/Fish/Vegetarian/Vegan), dietaryRestrictions (text), songRequest (text), coupleWish (textarea: "A wish for the couple")
- **babyShower**: plusOnes (number), adviceForParents (textarea: "Advice for the new parents"), dietaryRestrictions (text)
- **engagement**: plusOnes (number), dietaryRestrictions (text), coupleMessage (textarea: "Message for the happy couple")
- **graduation**: plusOnes (number), dietaryRestrictions (text), gradMessage (textarea: "Message for the graduate")
- **dinnerParty**: dietaryRestrictions (text), allergies (text), drinkPreference (select: Wine/Beer/Cocktails/Non-alcoholic)
- **holiday**: plusOnes (number), bringingDish (text: "What dish are you bringing?")
- **retirement**: plusOnes (number), dietaryRestrictions (text), memoryMessage (textarea: "A favorite memory or message")
- **anniversary**: plusOnes (number), dietaryRestrictions (text), coupleMessage (textarea: "A message for the happy couple")
- **sports**: plusOnes (number), bringingItem (text: "What are you bringing?"), boldPrediction (text: "Your bold prediction for the game")
- **bridalShower**: plusOnes (number), dietaryRestrictions (text), brideMessage (textarea: "A message for the bride")
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
  "confirmed": false,
  "missingRequired": ["fieldName", ...],
  "suggestedRsvpFields": null
}

- Set "ready": true and populate "suggestedRsvpFields" when all 4 required fields are provided.
- Set "confirmed": true only AFTER the user approves the RSVP field list.
- Keep suggestedRsvpFields to 2-4 fields — don't overwhelm.
- NEVER set "confirmed": true without first proposing RSVP fields and getting user approval.

## CONVERSATION RULES
- Infer eventType from context (e.g., "my son's 5th birthday" → birthday)
- Convert relative dates ("next Saturday at 3pm") using today: ${new Date().toISOString().split('T')[0]}
- If user provides most info at once, don't ask redundant questions — go straight to proposing RSVP fields (but still wait for confirmation before setting confirmed: true)
- Capture vibe/style descriptions in "prompt" field — be detailed and specific
- When suggesting RSVP fields, be conversational and specific to the event — describe the fields naturally, don't just list them robotically`;

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

    const { messages, sessionId, eventId } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'Messages array is required' });
    }

    // Use provided sessionId or generate one for grouping conversation turns
    const chatSessionId = sessionId || `chat_${user.id}_${Date.now()}`;

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

    // Log token usage to generation_log
    const chatInputTokens = response.usage?.input_tokens || 0;
    const chatOutputTokens = response.usage?.output_tokens || 0;
    const chatCost = calcGenerationCost(chatModel, chatInputTokens, chatOutputTokens);
    try {
      await supabase.from('generation_log').insert({
        user_id: user.id,
        event_id: eventId || null,
        prompt: messages[messages.length - 1]?.content || '',
        model: chatModel,
        input_tokens: chatInputTokens,
        output_tokens: chatOutputTokens,
        latency_ms: latency,
        status: 'success'
      });
    } catch {}

    // Increment persistent event cost if we have an eventId
    if (eventId) {
      supabase.rpc('increment_event_cost', { p_event_id: eventId, p_cost_cents: chatCost.totalCostCents })
        .catch(() => {
          supabase.from('events').select('total_cost_cents').eq('id', eventId).single()
            .then(({ data }) => {
              if (data) supabase.from('events')
                .update({ total_cost_cents: (data.total_cost_cents || 0) + chatCost.totalCostCents })
                .eq('id', eventId).catch(() => {});
            }).catch(() => {});
        });
    }

    // Check if usage-based AI billing threshold is reached
    checkAndChargeAiUsage(user.id).catch(e => console.error('AI billing check error:', e.message));

    // Persist user message + assistant response to chat_messages
    const lastUserMsg = messages[messages.length - 1];
    try {
      await supabase.from('chat_messages').insert([
        {
          user_id: user.id,
          session_id: chatSessionId,
          role: 'user',
          content: lastUserMsg?.content || ''
        },
        {
          user_id: user.id,
          session_id: chatSessionId,
          role: 'assistant',
          content: text,
          model: chatModel,
          input_tokens: response.usage?.input_tokens || 0,
          output_tokens: response.usage?.output_tokens || 0
        }
      ]);
    } catch {}

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
    return res.status(500).json({
      error: 'Failed to process message',
      message: err?.message || 'Unknown error',
      detail: err?.status ? `API error ${err.status}: ${err?.error?.message || err.message}` : String(err)
    });
  }
}
