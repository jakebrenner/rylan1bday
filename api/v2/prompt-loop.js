import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';

const client = new Anthropic();
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FOUNDER_EMAIL = 'jake@getmrkt.com';

async function verifyAdmin(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return null;
  const email = user.email.toLowerCase();
  if (email === FOUNDER_EMAIL) return user;
  const { data } = await supabaseAdmin
    .from('app_config')
    .select('value')
    .eq('key', 'admin_emails')
    .single();
  if (data?.value) {
    const adminList = data.value.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    if (adminList.includes(email)) return user;
  }
  return null;
}

// ── Cost estimation per million tokens ──
const COST_PER_M_IN = { 'claude-haiku-4-5-20251001': 1.00, 'claude-sonnet-4-20250514': 3.00, 'claude-sonnet-4-6': 3.00, 'claude-opus-4-20250514': 15.00, 'claude-opus-4-6': 15.00 };
const COST_PER_M_OUT = { 'claude-haiku-4-5-20251001': 5.00, 'claude-sonnet-4-20250514': 15.00, 'claude-sonnet-4-6': 15.00, 'claude-opus-4-20250514': 75.00, 'claude-opus-4-6': 75.00 };

function estimateCostCents(model, inputTokens, outputTokens) {
  const inRate = COST_PER_M_IN[model] || 3;
  const outRate = COST_PER_M_OUT[model] || 15;
  return ((inputTokens * inRate + outputTokens * outRate) / 1_000_000) * 100;
}

// ── Event type labels (matches prompt-test.js DESIGN_DNA) ──
const EVENT_TYPE_LABELS = {
  kidsBirthday: 'Kids Birthday (Ages 0-10)', adultBirthday: 'Adult / Milestone Birthday',
  babyShower: 'Baby Shower / Sip & See', engagement: 'Engagement Party',
  wedding: 'Wedding / Reception', graduation: 'Graduation Party',
  holiday: 'Holiday Party', dinnerParty: 'Dinner Party / Cocktail Hour',
  retirement: 'Retirement Party', anniversary: 'Anniversary Party',
  sports: 'Sports / Watch Party', bridalShower: 'Bridal Shower',
  corporate: 'Corporate Event', other: 'Custom Event'
};

// ── AI-as-Judge evaluation prompt ──
const EVAL_SYSTEM_PROMPT = `You are an expert UI design evaluator for event invitation pages. You will receive the HTML and CSS of a generated invite theme and score it on multiple dimensions.

Score each dimension from 1-5:
- 1 = Broken/unusable
- 2 = Poor quality, major issues
- 3 = Acceptable but unremarkable
- 4 = Good quality, minor issues only
- 5 = Excellent, professional quality

## SCORING DIMENSIONS

1. **visual_design** (1-5): Overall aesthetic quality, use of color, typography choices, visual hierarchy, whitespace usage. Does it look like a professional designer made it?

2. **text_contrast** (1-5): Is ALL text readable against its background? Check: hero text on dark/light bg, detail labels, RSVP section text, button text. 5 = perfect contrast everywhere, 1 = unreadable text present.

3. **layout_structure** (1-5): Proper section ordering (header→hero→details→RSVP), appropriate spacing, mobile-friendly layout (393px max), no overflow issues evident in CSS.

4. **theme_coherence** (1-5): Does the design match the event type? Are fonts, colors, and decorative elements appropriate for the occasion? Does it feel cohesive?

5. **animation_quality** (1-5): Are CSS animations present and well-executed? Appropriate timing, not distracting, enhance the design. 1 = no animations at all.

6. **completeness** (1-5): Does it include all required sections (header, hero, details-slot, rsvp-slot, thank-you page)? Are data attributes present? Is theme_config complete?

7. **overall** (1-5): Your holistic assessment. Would you be proud to send this invite?

## OUTPUT FORMAT — JSON ONLY
Return ONLY a JSON object:
{
  "visual_design": <1-5>,
  "text_contrast": <1-5>,
  "layout_structure": <1-5>,
  "theme_coherence": <1-5>,
  "animation_quality": <1-5>,
  "completeness": <1-5>,
  "overall": <1-5>,
  "issues": ["issue 1", "issue 2"],
  "strengths": ["strength 1", "strength 2"]
}

Keep issues and strengths to 2-3 items each, concise (under 15 words each).`;

// ── Programmatic structural checks (0-100 score) ──
function runStructuralChecks(html, css, config, thankyouHtml) {
  const issues = [];
  let score = 100;

  // Check required slots
  if (!html || !html.includes('rsvp-slot')) { issues.push('Missing .rsvp-slot'); score -= 20; }
  if (!html || !html.includes('details-slot')) { issues.push('Missing .details-slot'); score -= 15; }

  // Check rsvp-slot is empty
  if (html) {
    const rsvpMatch = html.match(/<div[^>]*class="[^"]*rsvp-slot[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (rsvpMatch && rsvpMatch[1].trim().length > 0) {
      issues.push('rsvp-slot is not empty — contains content');
      score -= 15;
    }
  }

  // Check details-slot is empty
  if (html) {
    const detailsMatch = html.match(/<div[^>]*class="[^"]*details-slot[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    if (detailsMatch && detailsMatch[1].trim().length > 0) {
      issues.push('details-slot is not empty — contains content');
      score -= 10;
    }
  }

  // Check data-field="title"
  if (!html || !html.includes('data-field="title"')) { issues.push('Missing data-field="title"'); score -= 10; }

  // Check thank-you page
  if (!thankyouHtml || thankyouHtml.length < 50) { issues.push('Missing or minimal thank-you page'); score -= 10; }
  if (thankyouHtml && !thankyouHtml.includes('thankyou-page')) { issues.push('Thank-you missing .thankyou-page class'); score -= 5; }
  if (thankyouHtml && !thankyouHtml.includes('thankyou-hero')) { issues.push('Thank-you missing .thankyou-hero class'); score -= 5; }

  // Check theme_config completeness
  if (!config || typeof config !== 'object') { issues.push('Missing theme_config'); score -= 10; }
  else {
    const required = ['primaryColor', 'fontHeadline', 'fontBody', 'mood'];
    for (const key of required) {
      if (!config[key]) { issues.push(`Config missing ${key}`); score -= 3; }
    }
  }

  // Check CSS has animation
  if (css && !css.includes('@keyframes') && !css.includes('animation')) {
    issues.push('No CSS animations found');
    score -= 5;
  }

  // Check Google Fonts
  if (css && !css.includes('fonts.googleapis.com') && (!config || !config.googleFontsImport)) {
    issues.push('No Google Fonts import');
    score -= 5;
  }

  // Check for JavaScript (forbidden)
  if (html && (html.includes('<script') || html.includes('onclick='))) {
    issues.push('Contains JavaScript (forbidden)');
    score -= 15;
  }

  return {
    structural_score: Math.max(0, score),
    structural_issues: issues,
    structural_passed: score >= 60
  };
}

// ── AI evaluation using Haiku ──
async function evaluateTheme(html, css, config, thankyouHtml, eventType) {
  const evalModel = 'claude-haiku-4-5-20251001';
  const startTime = Date.now();

  const userContent = `Evaluate this ${EVENT_TYPE_LABELS[eventType] || eventType} invite theme:

HTML:
\`\`\`html
${(html || '').substring(0, 8000)}
\`\`\`

CSS:
\`\`\`css
${(css || '').substring(0, 4000)}
\`\`\`

Config: ${JSON.stringify(config || {}).substring(0, 500)}

Thank-you page present: ${thankyouHtml ? 'Yes (' + thankyouHtml.length + ' chars)' : 'No'}`;

  try {
    const response = await client.messages.create({
      model: evalModel,
      max_tokens: 512,
      system: EVAL_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }]
    });

    const text = response.content[0].text;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in eval response');
    const scores = JSON.parse(jsonMatch[0]);

    return {
      ...scores,
      eval_model: evalModel,
      eval_tokens_in: response.usage?.input_tokens || 0,
      eval_tokens_out: response.usage?.output_tokens || 0,
      eval_latency_ms: Date.now() - startTime,
      eval_cost_cents: estimateCostCents(evalModel, response.usage?.input_tokens || 0, response.usage?.output_tokens || 0)
    };
  } catch (err) {
    console.error('Eval failed:', err.message);
    return {
      visual_design: null, text_contrast: null, layout_structure: null,
      theme_coherence: null, animation_quality: null, completeness: null, overall: null,
      issues: ['Evaluation failed: ' + err.message], strengths: [],
      eval_model: evalModel, eval_tokens_in: 0, eval_tokens_out: 0,
      eval_latency_ms: Date.now() - startTime, eval_cost_cents: 0
    };
  }
}

// ── Generate dummy event data ──
async function generateDummyData(eventType) {
  const diversitySeed = Math.floor(Math.random() * 10000);
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: `You generate fictional dummy event data for testing. Return ONLY valid JSON. Use diverse cultural names, varied US locations. For the design "prompt" field: be HIGHLY SPECIFIC and DIVERSE — avoid generic themes.`,
    messages: [{
      role: 'user',
      content: `Generate fictional test data for a "${EVENT_TYPE_LABELS[eventType] || eventType}" event. Seed: ${diversitySeed}. Return JSON:
{"title":"Creative title","startDate":"2026-04-15T14:00","endDate":"2026-04-15T17:00","locationName":"Fictional venue","locationAddress":"Full address","hostName":"Fictional host","dressCode":"Dress code","tagline":"Catchy tagline","prompt":"2-3 sentence SPECIFIC design direction. Be bold."}`
    }]
  });

  const text = response.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in dummy data response');
  const eventDetails = JSON.parse(jsonMatch[0]);
  eventDetails.eventType = eventType;

  return {
    eventDetails,
    tokens_in: response.usage?.input_tokens || 0,
    tokens_out: response.usage?.output_tokens || 0
  };
}

// Active loop tracking (in-memory — single instance per serverless invocation)
let cancelledLoops = new Set();

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const admin = await verifyAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Unauthorized' });

  const action = req.query.action;

  // ── CANCEL ──
  if (action === 'cancel') {
    const { loopRunId } = req.body || {};
    if (!loopRunId) return res.status(400).json({ error: 'loopRunId required' });
    cancelledLoops.add(loopRunId);
    await supabaseAdmin.from('loop_runs').update({ status: 'cancelled', completed_at: new Date().toISOString() }).eq('id', loopRunId);
    return res.status(200).json({ success: true });
  }

  // ── START ──
  if (action !== 'start') return res.status(400).json({ error: 'Unknown action. Use ?action=start or ?action=cancel' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

  const { promptVersionIds, models, eventTypes, runsPerCombo, maxBudgetCents, autoDraft } = req.body;
  if (!promptVersionIds?.length || !models?.length || !eventTypes?.length) {
    return res.status(400).json({ error: 'promptVersionIds, models, and eventTypes are required arrays' });
  }

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const sendSSE = (data) => {
    try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch (e) { /* client disconnected */ }
  };

  // Keepalive interval
  const keepalive = setInterval(() => {
    try { res.write(`: keepalive\n\n`); } catch (e) { clearInterval(keepalive); }
  }, 3000);

  // Create loop run ID
  const loopRunId = 'loop_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);

  // Build the matrix of all combos
  const runs = (runsPerCombo || 1);
  const combos = [];
  for (const pvId of promptVersionIds) {
    for (const modelId of models) {
      for (const eventType of eventTypes) {
        for (let r = 0; r < runs; r++) {
          combos.push({ promptVersionId: pvId === 'active' ? null : pvId, model: modelId, eventType });
        }
      }
    }
  }

  const totalGenerations = combos.length;
  const budget = maxBudgetCents || 500;

  // Create loop_run record
  await supabaseAdmin.from('loop_runs').insert({
    id: loopRunId,
    config: { promptVersionIds, models, eventTypes, runsPerCombo: runs, autoDraft: !!autoDraft },
    status: 'running',
    total_generations: totalGenerations,
    max_budget_cents: budget,
    created_by: admin.email
  });

  sendSSE({ type: 'started', loopRunId, total: totalGenerations });

  // Load prompt versions we'll need
  const pvCache = {};
  for (const pvId of promptVersionIds) {
    if (pvId === 'active') {
      const { data } = await supabaseAdmin.from('prompt_versions').select('id, creative_direction, design_dna, version, name').eq('is_active', true).single();
      if (data) pvCache['active'] = data;
    } else {
      const { data } = await supabaseAdmin.from('prompt_versions').select('id, creative_direction, design_dna, version, name').eq('id', pvId).single();
      if (data) pvCache[pvId] = data;
    }
  }

  let completed = 0;
  let failed = 0;
  let totalCostCents = 0;
  let allScores = [];

  try {
    for (let i = 0; i < combos.length; i++) {
      // Check cancellation
      if (cancelledLoops.has(loopRunId)) {
        sendSSE({ type: 'cancelled', completed, total: totalGenerations });
        break;
      }

      // Check budget
      if (totalCostCents >= budget) {
        sendSSE({ type: 'budget_exceeded', completed, total: totalGenerations, costCents: totalCostCents });
        break;
      }

      const combo = combos[i];
      const pvKey = combo.promptVersionId || 'active';
      const pv = pvCache[pvKey];

      try {
        // Step 1: Generate dummy event data
        const dummyResult = await generateDummyData(combo.eventType);
        const dummyCost = estimateCostCents('claude-haiku-4-5-20251001', dummyResult.tokens_in, dummyResult.tokens_out);
        totalCostCents += dummyCost;

        // Step 2: Generate theme via prompt-test API (internal fetch)
        const genBody = {
          model: combo.model,
          eventDetails: dummyResult.eventDetails,
          promptVersionId: pv?.id || undefined
        };

        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const host = req.headers.host;
        const baseUrl = `${protocol}://${host}`;

        const genResponse = await fetch(`${baseUrl}/api/v2/prompt-test`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': req.headers.authorization
          },
          body: JSON.stringify(genBody)
        });

        if (!genResponse.ok) {
          throw new Error(`Generation API returned ${genResponse.status}: ${await genResponse.text()}`);
        }

        const genData = await genResponse.json();
        if (!genData.success) throw new Error(genData.error || 'Generation failed');

        const theme = genData.theme;
        const metadata = genData.metadata;
        const genCost = estimateCostCents(combo.model, metadata.tokens?.input || 0, metadata.tokens?.output || 0);
        totalCostCents += genCost;

        // Step 3: Run structural checks
        const structural = runStructuralChecks(theme.html, theme.css, theme.config, theme.thankyouHtml);

        // Step 4: AI evaluation
        const evalResult = await evaluateTheme(theme.html, theme.css, theme.config, theme.thankyouHtml, combo.eventType);
        totalCostCents += evalResult.eval_cost_cents || 0;

        // Step 5: Save test run to prompt_test_runs
        const { data: testRunData, error: testRunError } = await supabaseAdmin.from('prompt_test_runs').insert({
          prompt_version_id: pv?.id || null,
          model: combo.model,
          event_type: combo.eventType,
          event_details: dummyResult.eventDetails,
          result_html: theme.html,
          result_css: theme.css,
          result_config: theme.config,
          result_thankyou_html: theme.thankyouHtml || '',
          input_tokens: metadata.tokens?.input || 0,
          output_tokens: metadata.tokens?.output || 0,
          latency_ms: metadata.latencyMs || 0,
          score: evalResult.overall || null,
          notes: `Auto-eval: ${(evalResult.strengths || []).join(', ')}`,
          created_by: admin.email,
          test_session_id: loopRunId
        }).select('id').single();

        if (testRunError) throw new Error('Failed to save test run: ' + testRunError.message);

        // Step 6: Save eval scores to auto_eval_scores
        await supabaseAdmin.from('auto_eval_scores').insert({
          test_run_id: testRunData.id,
          visual_design: evalResult.visual_design,
          text_contrast: evalResult.text_contrast,
          layout_structure: evalResult.layout_structure,
          theme_coherence: evalResult.theme_coherence,
          animation_quality: evalResult.animation_quality,
          completeness: evalResult.completeness,
          overall: evalResult.overall,
          issues: evalResult.issues || [],
          strengths: evalResult.strengths || [],
          eval_model: evalResult.eval_model,
          eval_tokens_in: evalResult.eval_tokens_in,
          eval_tokens_out: evalResult.eval_tokens_out,
          eval_latency_ms: evalResult.eval_latency_ms,
          eval_cost_cents: evalResult.eval_cost_cents,
          structural_score: structural.structural_score,
          structural_issues: structural.structural_issues,
          structural_passed: structural.structural_passed,
          loop_run_id: loopRunId
        });

        completed++;
        if (evalResult.overall) allScores.push(evalResult.overall);

        sendSSE({
          type: 'progress',
          loopRunId,
          completed,
          failed,
          total: totalGenerations,
          costCents: Math.round(totalCostCents),
          eventType: combo.eventType,
          model: combo.model,
          lastScore: evalResult.overall || '?',
          lastStructural: structural.structural_score
        });

        // Update loop_run progress
        await supabaseAdmin.from('loop_runs').update({
          completed_generations: completed,
          failed_generations: failed,
          total_cost_cents: Math.round(totalCostCents * 100) / 100,
          avg_overall_score: allScores.length > 0 ? Math.round((allScores.reduce((a, b) => a + b, 0) / allScores.length) * 100) / 100 : null
        }).eq('id', loopRunId);

      } catch (genErr) {
        console.error(`Loop generation ${i + 1} failed:`, genErr.message);
        failed++;
        sendSSE({
          type: 'progress',
          loopRunId,
          completed,
          failed,
          total: totalGenerations,
          costCents: Math.round(totalCostCents),
          eventType: combo.eventType,
          model: combo.model,
          error: genErr.message
        });
      }
    }

    // ── Loop complete — generate insights ──
    const avgOverall = allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : null;
    const insights = await generateInsights(loopRunId);

    // Update loop_run as completed
    await supabaseAdmin.from('loop_runs').update({
      status: cancelledLoops.has(loopRunId) ? 'cancelled' : (failed === totalGenerations ? 'failed' : 'completed'),
      completed_generations: completed,
      failed_generations: failed,
      total_cost_cents: Math.round(totalCostCents * 100) / 100,
      avg_overall_score: avgOverall ? Math.round(avgOverall * 100) / 100 : null,
      avg_structural_score: null, // computed from view
      insights_report: insights,
      completed_at: new Date().toISOString()
    }).eq('id', loopRunId);

    sendSSE({
      type: 'done',
      loopRunId,
      completed,
      failed,
      total: totalGenerations,
      totalCostCents: Math.round(totalCostCents),
      avgOverall: avgOverall ? Math.round(avgOverall * 100) / 100 : null,
      insights
    });

  } catch (err) {
    console.error('Loop fatal error:', err);
    await supabaseAdmin.from('loop_runs').update({
      status: 'failed',
      completed_generations: completed,
      failed_generations: failed,
      total_cost_cents: Math.round(totalCostCents * 100) / 100,
      completed_at: new Date().toISOString()
    }).eq('id', loopRunId);

    sendSSE({ type: 'error', message: err.message, loopRunId });
  } finally {
    clearInterval(keepalive);
    cancelledLoops.delete(loopRunId);
    res.end();
  }
}

// ── Generate insights report from loop results ──
async function generateInsights(loopRunId) {
  try {
    // Fetch all eval scores grouped by combo
    const { data: evals } = await supabaseAdmin
      .from('auto_eval_scores')
      .select('*, prompt_test_runs!inner(prompt_version_id, model, event_type)')
      .eq('loop_run_id', loopRunId);

    if (!evals || evals.length === 0) return null;

    // Group by prompt×model combo
    const combos = {};
    const byEventType = {};
    for (const ev of evals) {
      const ptr = ev.prompt_test_runs;
      const key = (ptr.prompt_version_id || 'active') + '|' + ptr.model;
      if (!combos[key]) combos[key] = { pvId: ptr.prompt_version_id, model: ptr.model, scores: [] };
      combos[key].scores.push(ev.overall);

      if (!byEventType[ptr.event_type]) byEventType[ptr.event_type] = [];
      byEventType[ptr.event_type].push(ev.overall);
    }

    // Find best combo
    let bestKey = null, bestAvg = 0;
    for (const [key, combo] of Object.entries(combos)) {
      const avg = combo.scores.filter(Boolean).reduce((a, b) => a + b, 0) / combo.scores.filter(Boolean).length;
      if (avg > bestAvg) { bestAvg = avg; bestKey = key; }
    }

    // Find weakest event types (avg < 3.5)
    const weakestEventTypes = [];
    for (const [type, scores] of Object.entries(byEventType)) {
      const valid = scores.filter(Boolean);
      if (valid.length > 0) {
        const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
        if (avg < 3.5) weakestEventTypes.push(type);
      }
    }

    const bestCombo = bestKey ? `${combos[bestKey].model} (avg: ${bestAvg.toFixed(1)})` : null;

    // Simple recommendations
    const recommendations = [];
    if (weakestEventTypes.length > 0) {
      recommendations.push(`Event types needing improvement: ${weakestEventTypes.join(', ')}`);
    }
    if (bestAvg >= 4) {
      recommendations.push('Top combo is performing well (4+). Consider activating this prompt version.');
    } else if (bestAvg < 3) {
      recommendations.push('All combos scoring below 3. Consider revising creative direction.');
    }

    return { bestCombo, weakestEventTypes, recommendations };
  } catch (err) {
    console.error('Insights generation failed:', err.message);
    return null;
  }
}
