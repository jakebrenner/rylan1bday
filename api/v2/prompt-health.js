import Anthropic from '@anthropic-ai/sdk';
import { createClient } from '@supabase/supabase-js';
import { reportApiError } from './lib/error-reporter.js';
import { DEFAULT_CREATIVE_DIRECTION } from './lib/prompt-defaults.js';

const client = new Anthropic();
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const FOUNDER_EMAIL = 'jake@getmrkt.com';

const AI_MODEL_PRICING = {
  'claude-haiku-4-5-20251001': { input: 1.00, output: 5.00 },
  'claude-sonnet-4-6':         { input: 3.00, output: 15.00 },
  'claude-opus-4-6':           { input: 15.00, output: 75.00 },
};

function calcCost(model, inputTokens, outputTokens) {
  const pricing = AI_MODEL_PRICING[model] || { input: 3.00, output: 15.00 };
  const raw = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
  return Math.round(raw * 100 * 10000) / 10000;
}

async function verifyAdmin(req) {
  // Skip auth on Vercel preview deployments
  if (process.env.VERCEL_ENV === 'preview') {
    return { user: { id: 'preview', email: 'preview-admin@localhost' } };
  }

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return { error: 'no_token' };
  const token = authHeader.slice(7);
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
  const { data: { user }, error } = await supabase.auth.getUser();
  if (error || !user) return { error: 'invalid_token' };
  const email = user.email.toLowerCase();
  if (email === FOUNDER_EMAIL) return { user };
  const { data } = await supabaseAdmin.from('app_config').select('value').eq('key', 'admin_emails').single();
  if (data?.value) {
    const adminList = data.value.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    if (adminList.includes(email)) return { user };
  }
  return { error: 'not_admin' };
}

// ═══════════════════════════════════════════════════════════════════
// Gather all quality data for AI analysis
// ═══════════════════════════════════════════════════════════════════
async function gatherAnalysisData() {
  const results = await Promise.allSettled([
    // 1. Active prompt version
    supabaseAdmin.from('prompt_versions').select('id, version, name, creative_direction, design_dna').eq('is_active', true).single(),
    // 2. Quality incident summary (view)
    supabaseAdmin.from('quality_incident_summary').select('*'),
    // 3. Root cause patterns (view)
    supabaseAdmin.from('quality_root_cause_patterns').select('*'),
    // 4. GTP / generation satisfaction (view)
    supabaseAdmin.from('generation_satisfaction').select('*'),
    // 5. Admin theme quality (view)
    supabaseAdmin.from('admin_theme_quality').select('*'),
    // 6. Recent user feedback with text
    supabaseAdmin.from('invite_ratings').select('rating, feedback, rater_type, created_at').not('feedback', 'is', null).order('created_at', { ascending: false }).limit(50),
    // 7. Production model performance (view)
    supabaseAdmin.from('production_model_performance').select('*'),
    // 8. Recent quality incidents with diagnosis
    supabaseAdmin.from('quality_incidents').select('trigger_type, trigger_data, ai_diagnosis, resolution_type, created_at').not('ai_diagnosis', 'is', null).order('created_at', { ascending: false }).limit(20),
    // 9. Auto-score summary (view) — may not exist yet
    supabaseAdmin.from('auto_score_summary').select('*'),
    // 10. Overall generation stats (last 30 days)
    supabaseAdmin.from('generation_log').select('model, event_type, status, latency_ms, created_at').gte('created_at', new Date(Date.now() - 30 * 86400000).toISOString()).order('created_at', { ascending: false }).limit(500),
  ]);

  const extract = (idx) => {
    const r = results[idx];
    if (r.status === 'fulfilled') return r.value?.data || null;
    return null;
  };

  return {
    activePromptVersion: extract(0),
    incidentSummary: extract(1),
    rootCausePatterns: extract(2),
    generationSatisfaction: extract(3),
    adminThemeQuality: extract(4),
    userFeedback: extract(5),
    modelPerformance: extract(6),
    recentIncidents: extract(7),
    autoScoreSummary: extract(8),
    recentGenerations: extract(9),
  };
}

// ═══════════════════════════════════════════════════════════════════
// Build the analysis prompt from gathered data
// ═══════════════════════════════════════════════════════════════════
function buildAnalysisMessage(data) {
  const sections = [];

  // Active prompt
  if (data.activePromptVersion) {
    const pv = data.activePromptVersion;
    sections.push(`## ACTIVE PROMPT VERSION: v${pv.version} — ${pv.name}\n\nCreative Direction (first 3000 chars):\n${(pv.creative_direction || '').substring(0, 3000)}\n\nDesign DNA event types: ${Object.keys(pv.design_dna || {}).join(', ')}`);
  } else {
    sections.push('## ACTIVE PROMPT VERSION: Hardcoded Default (no DB version active)');
  }

  // GTP metrics
  if (data.generationSatisfaction?.length) {
    sections.push('## GENERATION SATISFACTION (Generations-to-Publish by Event Type)\n' +
      data.generationSatisfaction.map(r => `${r.event_type}: avg GTP=${r.avg_gtp}, first-try=${r.first_try_pct}%, total events=${r.total_events || r.event_count || 'N/A'}`).join('\n'));
  }

  // Quality incidents
  if (data.incidentSummary?.length) {
    sections.push('## QUALITY INCIDENTS (Last 30 Days)\n' +
      data.incidentSummary.map(r => `${r.trigger_type}: ${r.incident_count} incidents, ${r.auto_healed_count || 0} auto-healed, ${r.unresolved_count || 0} unresolved`).join('\n'));
  }

  // Root cause patterns
  if (data.rootCausePatterns?.length) {
    sections.push('## RECURRING ROOT CAUSES (≥3 incidents in 30 days)\n' +
      data.rootCausePatterns.map(r => `${r.root_cause} (${r.trigger_type}): ${r.total_incidents} total, ${r.last_7_days || 0} last 7d, heal strategy: ${r.most_common_heal || 'none'}`).join('\n'));
  }

  // Admin theme quality
  if (data.adminThemeQuality?.length) {
    sections.push('## ADMIN THEME QUALITY RATINGS\n' +
      data.adminThemeQuality.map(r => `model=${r.model}, prompt=${r.prompt_version_id || 'default'}: avg=${r.avg_admin_rating}, rated=${r.rated_count}/${r.total_themes}, high(≥4)=${r.high_quality_count}, low(≤2)=${r.low_quality_count}`).join('\n'));
  }

  // Auto-score summary
  if (data.autoScoreSummary?.length) {
    sections.push('## AUTO-SCORE SUMMARY (AI Quality Ratings)\n' +
      data.autoScoreSummary.map(r => `model=${r.model}, prompt=v${r.prompt_version}–${r.prompt_name}: avg=${r.avg_auto_score}, scored=${r.scored_count}, high(≥4)=${r.high_quality_count}, low(≤2)=${r.low_quality_count}, flagged=${r.flagged_for_review}`).join('\n'));
  }

  // Model performance
  if (data.modelPerformance?.length) {
    sections.push('## PRODUCTION MODEL PERFORMANCE\n' +
      data.modelPerformance.map(r => `${r.model} (${r.event_type}): ${r.total_generations} generations, avg latency=${r.avg_latency_ms}ms, error rate=${r.error_rate_pct}%`).join('\n'));
  }

  // User feedback
  if (data.userFeedback?.length) {
    sections.push('## RECENT USER FEEDBACK (last 50 with text)\n' +
      data.userFeedback.map(r => `[${r.rater_type}, ${r.rating}/5]: "${(r.feedback || '').substring(0, 200)}"`).join('\n'));
  }

  // Recent incidents with diagnosis
  if (data.recentIncidents?.length) {
    sections.push('## RECENT AI-DIAGNOSED INCIDENTS\n' +
      data.recentIncidents.map(r => `[${r.trigger_type}] ${r.ai_diagnosis?.substring(0, 300) || 'No diagnosis'} → ${r.resolution_type}`).join('\n'));
  }

  // Generation volume
  if (data.recentGenerations?.length) {
    const total = data.recentGenerations.length;
    const errors = data.recentGenerations.filter(g => g.status === 'error').length;
    const byType = {};
    data.recentGenerations.forEach(g => { byType[g.event_type] = (byType[g.event_type] || 0) + 1; });
    sections.push(`## GENERATION VOLUME (Last 30 Days, sample of ${total})\nErrors: ${errors}/${total} (${total > 0 ? Math.round(errors/total*100) : 0}%)\nBy event type: ${Object.entries(byType).map(([t,c]) => `${t}=${c}`).join(', ')}`);
  }

  return sections.join('\n\n');
}

// ⚠️ PROMPT GUARDIAN: STANDARD — See docs/prompt-registry.md
const ANALYSIS_SYSTEM_PROMPT = `You are a senior AI prompt engineer analyzing the performance of an invite design generation system called Ryvite. You have access to comprehensive quality data spanning ratings, user feedback, quality incidents, and production metrics.

Your job is to identify the most impactful improvements to the system's creative direction prompt — the prompt that guides AI to generate beautiful, event-appropriate HTML invite designs.

Analyze the data carefully. Look for:
- Event types with consistently low scores or high GTP (generations-to-publish)
- Recurring quality incidents and their root causes
- User feedback patterns (what do users complain about?)
- Model performance differences
- Gaps between auto-scores and admin ratings (calibration issues)

Be specific and actionable. Every suggestion must cite the data that supports it.

Return a JSON object with this exact structure:
{
  "overallHealthScore": 7,
  "summary": "2-3 sentence executive summary of current prompt health",
  "topWeaknesses": [
    {
      "title": "short name",
      "severity": "critical, major, or minor",
      "evidence": "what data points reveal this",
      "affectedEventTypes": ["event types"],
      "suggestedFix": "specific text to add or modify in creative_direction",
      "expectedImpact": "what improvement to expect"
    }
  ],
  "patterns": [
    {
      "observation": "interesting pattern",
      "dataPoints": "what data revealed this"
    }
  ],
  "promptSuggestions": [
    {
      "type": "add, modify, or remove",
      "section": "creative_direction or design_dna",
      "eventType": null,
      "currentText": "text to change, if modify/remove",
      "suggestedText": "new or replacement text",
      "rationale": "why, citing specific data"
    }
  ],
  "regressionRisks": ["things currently working well that should NOT be changed"]
}

Return ONLY the JSON object — no markdown fences, no commentary before or after.

If there is insufficient data for a meaningful analysis (e.g., no rated themes, no incidents), return a health score of 5 and note the data gaps in the summary.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const authResult = await verifyAdmin(req);
    if (authResult.error) return res.status(authResult.error === 'not_admin' ? 403 : 401).json({ error: authResult.error });
    const admin = authResult.user;

    const action = req.query?.action || '';

    // ═══════════════════════════════════════════════════════════════
    // ANALYZE — Run AI analysis on all quality data
    // ═══════════════════════════════════════════════════════════════
    if (action === 'analyze') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      // Use SSE to keep mobile connections alive during long AI analysis
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const keepalive = setInterval(() => {
        try { res.write(': keepalive\n\n'); } catch (_) {}
      }, 3000);

      const analysisModel = 'claude-haiku-4-5-20251001';
      const startTime = Date.now();

      try {
        // Gather all data
        res.write('data: {"status":"gathering"}\n\n');
        const data = await gatherAnalysisData();
        const message = buildAnalysisMessage(data);

        // Call Haiku for analysis (fast: ~5-10s vs Sonnet's 30-60s)
        res.write('data: {"status":"analyzing"}\n\n');
        const resp = await client.messages.create({
          model: analysisModel,
          max_tokens: 16384,
          system: ANALYSIS_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: message + '\n\nRespond with ONLY the JSON object, starting with { and ending with }. No other text.' }]
        });

        const tokens = { input: resp.usage?.input_tokens || 0, output: resp.usage?.output_tokens || 0 };
        const stopReason = resp.stop_reason || '';
        let text = (resp.content?.[0]?.text || '').trim();

        // If truncated, try to close the JSON
        if (stopReason === 'max_tokens' || stopReason === 'end_turn') {
          // Check if JSON is actually incomplete
          const trimmed = text.trim();
          const lastChar = trimmed[trimmed.length - 1];
          const needsRepair = lastChar !== '}' || (() => {
            try { JSON.parse(trimmed.replace(/^```(?:json)?\s*\n?/g, '').replace(/\n?\s*```\s*$/g, '')); return false; } catch(e) { return true; }
          })();

          if (needsRepair) {
            console.warn('[prompt-health] Response may be truncated (stop: ' + stopReason + '). Attempting JSON repair.');
            // Determine if we're inside a string by tracking quote state
            let inString = false, escaped = false;
            for (const ch of text) {
              if (escaped) { escaped = false; continue; }
              if (ch === '\\') { escaped = true; continue; }
              if (ch === '"') { inString = !inString; }
            }
            // If truncated inside a string, close it
            if (inString) {
              text += '"';
            }
            // Strip any trailing incomplete key-value pair
            text = text.replace(/,\s*"[^"]*"\s*:\s*"[^"]*$/, '');
            text = text.replace(/,\s*"[^"]*"\s*:\s*$/, '');
            text = text.replace(/,\s*"[^"]*$/, '');
            text = text.replace(/,\s*$/, '');
            // Recount open structures after repair
            let openBraces = 0, openBrackets = 0;
            inString = false; escaped = false;
            for (const ch of text) {
              if (escaped) { escaped = false; continue; }
              if (ch === '\\') { escaped = true; continue; }
              if (ch === '"') { inString = !inString; continue; }
              if (inString) continue;
              if (ch === '{') openBraces++;
              else if (ch === '}') openBraces--;
              else if (ch === '[') openBrackets++;
              else if (ch === ']') openBrackets--;
            }
            // Close open structures
            while (openBrackets > 0) { text += ']'; openBrackets--; }
            while (openBraces > 0) { text += '}'; openBraces--; }
          }
        }

        let analysis;
        try {
          let cleaned = text;
          // Strip markdown fences
          cleaned = cleaned.replace(/^```(?:json)?\s*\n?/g, '').replace(/\n?\s*```\s*$/g, '');
          // Extract JSON object
          const jsonStart = cleaned.indexOf('{');
          const jsonEnd = cleaned.lastIndexOf('}');
          if (jsonStart >= 0 && jsonEnd > jsonStart) {
            cleaned = cleaned.substring(jsonStart, jsonEnd + 1);
          }
          // Fix common JSON issues: trailing commas before } or ]
          cleaned = cleaned.replace(/,\s*([\]}])/g, '$1');
          // Fix unescaped newlines inside strings
          cleaned = cleaned.replace(/(?<=":[ ]*"[^"]*)\n/g, '\\n');
          analysis = JSON.parse(cleaned);
        } catch (e) {
          console.error('[prompt-health] JSON parse failed. Error:', e.message, 'Raw text (first 2000):', text.substring(0, 2000));
          clearInterval(keepalive);
          // Safely encode the raw text for debugging
          const safeRaw = text.substring(0, 800).replace(/[\n\r]/g, ' ').replace(/[^\x20-\x7E]/g, '');
          res.write('data: ' + JSON.stringify({ error: 'AI returned invalid JSON: ' + e.message, raw: safeRaw, stopReason }) + '\n\n');
          return res.end();
        }

        const costCents = calcCost(analysisModel, tokens.input, tokens.output);

        // Save analysis
        res.write('data: {"status":"saving"}\n\n');
        const { data: saved, error: saveErr } = await supabaseAdmin
          .from('prompt_health_analyses')
          .insert({
            prompt_version_id: data.activePromptVersion?.id || null,
            analysis_model: analysisModel,
            health_score: analysis.overallHealthScore || 5,
            summary: analysis.summary || '',
            full_result: analysis,
            data_snapshot: {
              incidentCount: data.incidentSummary?.length || 0,
              rootCauseCount: data.rootCausePatterns?.length || 0,
              feedbackCount: data.userFeedback?.length || 0,
              generationSample: data.recentGenerations?.length || 0,
              hasAutoScores: (data.autoScoreSummary?.length || 0) > 0
            },
            input_tokens: tokens.input,
            output_tokens: tokens.output,
            cost_cents: costCents,
            created_by: admin.email
          })
          .select()
          .single();

        if (saveErr) {
          console.error('Failed to save analysis:', saveErr.message);
        }

        // Save individual recommendations
        if (saved) {
          const recs = [
            ...(analysis.topWeaknesses || []).map(w => ({
              analysis_id: saved.id,
              type: 'modify',
              section: 'creative_direction',
              event_type: w.affectedEventTypes?.[0] || null,
              severity: w.severity || 'minor',
              title: w.title,
              suggested_text: w.suggestedFix || '',
              rationale: w.evidence || '',
              expected_impact: w.expectedImpact || ''
            })),
            ...(analysis.promptSuggestions || []).map(s => ({
              analysis_id: saved.id,
              type: s.type || 'modify',
              section: s.section || 'creative_direction',
              event_type: s.eventType || null,
              severity: 'minor',
              title: (s.type === 'add' ? 'Add: ' : s.type === 'remove' ? 'Remove: ' : 'Modify: ') + (s.suggestedText || '').substring(0, 80),
              current_text: s.currentText || null,
              suggested_text: s.suggestedText || '',
              rationale: s.rationale || ''
            }))
          ];

          if (recs.length > 0) {
            const { error: recErr } = await supabaseAdmin.from('prompt_health_recommendations').insert(recs);
            if (recErr) console.error('Failed to save recommendations:', recErr.message);
          }
        }

        // Log cost to generation_log
        await supabaseAdmin.from('generation_log').insert({
          prompt: 'prompt-health analysis',
          model: analysisModel,
          input_tokens: tokens.input,
          output_tokens: tokens.output,
          latency_ms: Date.now() - startTime,
          status: 'success',
          is_tweak: false,
          cost_cents: costCents
        });

        clearInterval(keepalive);
        res.write('data: ' + JSON.stringify({
          success: true,
          analysisId: saved?.id || null,
          analysis,
          cost: costCents,
          tokens,
          latencyMs: Date.now() - startTime
        }) + '\n\n');
        return res.end();
      } catch (analyzeErr) {
        clearInterval(keepalive);
        console.error('[prompt-health] Analysis error:', analyzeErr);
        res.write('data: ' + JSON.stringify({ error: analyzeErr.message || 'Analysis failed' }) + '\n\n');
        return res.end();
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // HISTORY — Past analyses
    // ═══════════════════════════════════════════════════════════════
    if (action === 'history') {
      const limit = Math.min(parseInt(req.query.limit) || 10, 50);
      const { data, error } = await supabaseAdmin
        .from('prompt_health_analyses')
        .select('id, prompt_version_id, analysis_model, health_score, summary, input_tokens, output_tokens, cost_cents, created_by, created_at')
        .order('created_at', { ascending: false })
        .limit(limit);

      if (error) return res.status(400).json({ error: error.message });
      return res.status(200).json({ success: true, analyses: data || [] });
    }

    // ═══════════════════════════════════════════════════════════════
    // GET ANALYSIS — Full analysis with recommendations
    // ═══════════════════════════════════════════════════════════════
    if (action === 'getAnalysis') {
      const analysisId = req.query.analysisId;
      if (!analysisId) return res.status(400).json({ error: 'analysisId required' });

      const [analysisRes, recsRes] = await Promise.all([
        supabaseAdmin.from('prompt_health_analyses').select('*').eq('id', analysisId).single(),
        supabaseAdmin.from('prompt_health_recommendations').select('*').eq('analysis_id', analysisId).order('severity', { ascending: true })
      ]);

      if (analysisRes.error) return res.status(404).json({ error: 'Analysis not found' });
      return res.status(200).json({ success: true, analysis: analysisRes.data, recommendations: recsRes.data || [] });
    }

    // ═══════════════════════════════════════════════════════════════
    // APPLY RECOMMENDATION — Create draft prompt version
    // ═══════════════════════════════════════════════════════════════
    if (action === 'applyRecommendation') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { recommendationId } = req.body;
      if (!recommendationId) return res.status(400).json({ error: 'recommendationId required' });

      // Fetch recommendation
      const { data: rec, error: recErr } = await supabaseAdmin
        .from('prompt_health_recommendations')
        .select('*')
        .eq('id', recommendationId)
        .single();

      if (recErr || !rec) return res.status(404).json({ error: 'Recommendation not found' });

      // Fetch active prompt version
      const { data: activePV } = await supabaseAdmin
        .from('prompt_versions')
        .select('*')
        .eq('is_active', true)
        .single();

      let creativeDirection = activePV?.creative_direction || DEFAULT_CREATIVE_DIRECTION;
      let designDna = activePV?.design_dna || {};

      // Apply the suggestion
      if (rec.section === 'creative_direction') {
        if (rec.type === 'add') {
          creativeDirection += '\n\n' + rec.suggested_text;
        } else if (rec.type === 'modify' && rec.current_text) {
          creativeDirection = creativeDirection.replace(rec.current_text, rec.suggested_text || '');
        } else if (rec.type === 'remove' && rec.current_text) {
          creativeDirection = creativeDirection.replace(rec.current_text, '');
        } else if (rec.type === 'modify' && !rec.current_text) {
          // No specific text to replace — append as new section
          creativeDirection += '\n\n' + rec.suggested_text;
        }
      } else if (rec.section === 'design_dna' && rec.event_type) {
        if (!designDna[rec.event_type]) designDna[rec.event_type] = {};
        if (rec.type === 'add' || rec.type === 'modify') {
          // Add/update the "consider" guidance for this event type
          if (!designDna[rec.event_type].consider) designDna[rec.event_type].consider = {};
          designDna[rec.event_type].consider.aiSuggested = rec.suggested_text;
        }
      }

      // Get next version number
      const { data: latest } = await supabaseAdmin
        .from('prompt_versions')
        .select('version')
        .order('version', { ascending: false })
        .limit(1);

      const nextVersion = (latest?.length > 0) ? latest[0].version + 1 : 1;

      // Build a descriptive name from the recommendation title
      const shortTitle = (rec.title || 'AI tweak').substring(0, 60);
      const sectionTag = rec.section === 'design_dna' && rec.event_type
        ? ` [${rec.event_type}]` : '';

      // Create new inactive version
      const { data: newPV, error: pvErr } = await supabaseAdmin
        .from('prompt_versions')
        .insert({
          version: nextVersion,
          name: `v${nextVersion} — ${shortTitle}${sectionTag}`,
          description: `AI Health Analyst: ${rec.title}. ${(rec.rationale || '').substring(0, 200)}`,
          creative_direction: creativeDirection,
          design_dna: designDna,
          is_active: false,
          created_by: admin.email
        })
        .select()
        .single();

      if (pvErr) return res.status(500).json({ error: 'Failed to create version: ' + pvErr.message });

      // Update recommendation status
      await supabaseAdmin.from('prompt_health_recommendations').update({
        status: 'applied',
        applied_version_id: newPV.id,
        reviewed_by: admin.email,
        reviewed_at: new Date().toISOString()
      }).eq('id', recommendationId);

      return res.status(200).json({ success: true, newVersionId: newPV.id, version: nextVersion });
    }

    // ═══════════════════════════════════════════════════════════════
    // DISMISS RECOMMENDATION
    // ═══════════════════════════════════════════════════════════════
    if (action === 'dismissRecommendation') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });
      const { recommendationId } = req.body;
      if (!recommendationId) return res.status(400).json({ error: 'recommendationId required' });

      await supabaseAdmin.from('prompt_health_recommendations').update({
        status: 'dismissed',
        reviewed_by: admin.email,
        reviewed_at: new Date().toISOString()
      }).eq('id', recommendationId);

      return res.status(200).json({ success: true });
    }

    // ═══════════════════════════════════════════════════════════════
    // COMBINE RECOMMENDATIONS — Preview or create a combined draft
    // ═══════════════════════════════════════════════════════════════
    if (action === 'combineRecommendations') {
      if (req.method !== 'POST') return res.status(405).json({ error: 'POST required' });

      const { recommendationIds, confirm } = req.body;
      if (!Array.isArray(recommendationIds) || recommendationIds.length < 2) {
        return res.status(400).json({ error: 'At least 2 recommendationIds required' });
      }

      // Fetch all requested recommendations
      const { data: recs, error: recsErr } = await supabaseAdmin
        .from('prompt_health_recommendations')
        .select('*')
        .in('id', recommendationIds);

      if (recsErr || !recs || recs.length === 0) {
        return res.status(404).json({ error: 'Recommendations not found' });
      }

      // Fetch active prompt version as base
      const { data: activePV } = await supabaseAdmin
        .from('prompt_versions')
        .select('*')
        .eq('is_active', true)
        .single();

      let creativeDirection = activePV?.creative_direction || DEFAULT_CREATIVE_DIRECTION;
      let designDna = activePV?.design_dna || {};
      // Deep clone design_dna so mutations don't affect the original
      designDna = JSON.parse(JSON.stringify(designDna));

      // Sort: remove first, then modify, then add (deterministic ordering)
      const typeOrder = { remove: 0, modify: 1, add: 2 };
      const sorted = recs.slice().sort((a, b) => (typeOrder[a.type] || 1) - (typeOrder[b.type] || 1));

      const applied = [];
      const conflicts = [];

      for (const rec of sorted) {
        if (rec.section === 'creative_direction') {
          if (rec.type === 'remove' && rec.current_text) {
            if (creativeDirection.includes(rec.current_text)) {
              creativeDirection = creativeDirection.replace(rec.current_text, '');
              applied.push({ id: rec.id, title: rec.title, type: rec.type, section: rec.section });
            } else {
              conflicts.push({ id: rec.id, title: rec.title, reason: 'Text to remove not found (may have been changed by another recommendation)' });
            }
          } else if (rec.type === 'modify' && rec.current_text) {
            if (creativeDirection.includes(rec.current_text)) {
              creativeDirection = creativeDirection.replace(rec.current_text, rec.suggested_text || '');
              applied.push({ id: rec.id, title: rec.title, type: rec.type, section: rec.section });
            } else {
              conflicts.push({ id: rec.id, title: rec.title, reason: 'Text to modify not found (may have been changed by another recommendation)' });
            }
          } else if (rec.type === 'add' || (rec.type === 'modify' && !rec.current_text)) {
            creativeDirection += '\n\n' + rec.suggested_text;
            applied.push({ id: rec.id, title: rec.title, type: rec.type, section: rec.section });
          }
        } else if (rec.section === 'design_dna' && rec.event_type) {
          if (!designDna[rec.event_type]) designDna[rec.event_type] = {};
          if (!designDna[rec.event_type].consider) designDna[rec.event_type].consider = {};
          designDna[rec.event_type].consider.aiSuggested = rec.suggested_text;
          applied.push({ id: rec.id, title: rec.title, type: rec.type, section: rec.section, event_type: rec.event_type });
        }
      }

      // Preview mode: return combined result without creating version
      if (!confirm) {
        return res.status(200).json({
          success: true,
          preview: { creative_direction: creativeDirection, design_dna: designDna, applied, conflicts }
        });
      }

      // Confirm mode: create the draft version
      const { data: latest } = await supabaseAdmin
        .from('prompt_versions')
        .select('version')
        .order('version', { ascending: false })
        .limit(1);

      const nextVersion = (latest?.length > 0) ? latest[0].version + 1 : 1;

      // Build name from applied rec titles
      const combinedName = applied.map(r => r.title).join(', ');
      const truncatedName = combinedName.length > 70 ? combinedName.substring(0, 67) + '...' : combinedName;

      const { data: newPV, error: pvErr } = await supabaseAdmin
        .from('prompt_versions')
        .insert({
          version: nextVersion,
          name: `v${nextVersion} — Combined: ${truncatedName}`,
          description: `AI Health Analyst: Combined ${applied.length} recommendations. ${applied.map(r => r.title).join('; ')}`.substring(0, 500),
          creative_direction: creativeDirection,
          design_dna: designDna,
          is_active: false,
          created_by: admin.email
        })
        .select()
        .single();

      if (pvErr) return res.status(500).json({ error: 'Failed to create version: ' + pvErr.message });

      // Mark all applied recs as applied, pointing to same version
      const appliedIds = applied.map(r => r.id);
      if (appliedIds.length > 0) {
        await supabaseAdmin.from('prompt_health_recommendations').update({
          status: 'applied',
          applied_version_id: newPV.id,
          reviewed_by: admin.email,
          reviewed_at: new Date().toISOString()
        }).in('id', appliedIds);
      }

      return res.status(200).json({
        success: true,
        newVersionId: newPV.id,
        version: nextVersion,
        applied,
        conflicts
      });
    }

    // ═══════════════════════════════════════════════════════════════
    // PENDING COUNT — Quick count of pending recommendations
    // ═══════════════════════════════════════════════════════════════
    if (action === 'pendingCount') {
      const { count } = await supabaseAdmin
        .from('prompt_health_recommendations')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending');

      return res.status(200).json({ success: true, count: count || 0 });
    }

    return res.status(400).json({ error: 'Unknown action: ' + action });
  } catch (err) {
    console.error('[prompt-health] Error:', err);
    await reportApiError({ endpoint: '/api/v2/prompt-health', action: req.query?.action, error: err, req }).catch(() => {});
    return res.status(500).json({ error: 'Internal error' });
  }
}
