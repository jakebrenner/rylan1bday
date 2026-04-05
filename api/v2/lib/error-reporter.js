/**
 * API Error Reporter — logs errors, notifies admins, creates support tickets,
 * and generates Claude Code fix prompts.
 *
 * Usage in any API handler's catch block:
 *   await reportApiError({ endpoint, action, error, requestBody, req }).catch(() => {});
 */
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'support@ryvite.com';
const PROD_URL = 'https://ryvite.com';

// Lazy-init to avoid module-level crashes if env vars are missing
let _supabase = null;
function getSupabase() {
  if (!_supabase) {
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return null;
    _supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  }
  return _supabase;
}

let _resend = null;
function getResend() {
  if (!_resend) {
    if (!process.env.RESEND_API_KEY) return null;
    _resend = new Resend(process.env.RESEND_API_KEY);
  }
  return _resend;
}

/**
 * Sanitize request body — strip sensitive fields before logging.
 */
function sanitizeBody(body) {
  if (!body || typeof body !== 'object') return body;
  const sanitized = { ...body };
  const sensitiveKeys = ['password', 'token', 'accessToken', 'refreshToken', 'secret', 'apiKey'];
  for (const key of sensitiveKeys) {
    if (key in sanitized) sanitized[key] = '[REDACTED]';
  }
  return sanitized;
}

/**
 * Extract request metadata for logging.
 */
function extractRequestMeta(req) {
  if (!req) return {};
  return {
    method: req.method,
    url: req.url,
    ip: req.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || req.headers?.['x-real-ip'] || '',
    userAgent: req.headers?.['user-agent'] || '',
    origin: req.headers?.origin || '',
    referer: req.headers?.referer || '',
    geo: {
      country: req.headers?.['x-vercel-ip-country'] || '',
      region: req.headers?.['x-vercel-ip-country-region'] || '',
      city: req.headers?.['x-vercel-ip-city'] || ''
    }
  };
}

/**
 * Build a Claude Code prompt for debugging this specific error.
 * @param {object} options
 * @param {object} [options.diagnostics] - Endpoint-specific debugging data (raw response snippets, parser state, etc.)
 */
function buildClaudePrompt({ endpoint, action, errorMessage, errorStack, requestMeta, diagnostics }) {
  let diagnosticsBlock = '';
  if (diagnostics && typeof diagnostics === 'object' && Object.keys(diagnostics).length > 0) {
    const entries = Object.entries(diagnostics).map(([key, value]) => {
      const displayValue = typeof value === 'object' ? JSON.stringify(value) : String(value);
      return `- ${key}: ${displayValue}`;
    }).join('\n');
    diagnosticsBlock = `\n**Diagnostics (endpoint-specific):**\n${entries}\n`;
  }

  return `Fix a 500 error in the Ryvite API.

**Endpoint:** ${endpoint}?action=${action}
**Error:** ${errorMessage}
**Stack trace:**
\`\`\`
${errorStack || 'No stack trace available'}
\`\`\`

**Request context:**
- Method: ${requestMeta?.method || 'unknown'}
- Origin: ${requestMeta?.origin || 'unknown'}
- User-Agent: ${requestMeta?.userAgent || 'unknown'}
- IP: ${requestMeta?.ip || 'unknown'}
- Geo: ${requestMeta?.geo?.city || ''}, ${requestMeta?.geo?.region || ''}, ${requestMeta?.geo?.country || ''}
${diagnosticsBlock}
**Steps to reproduce:**
1. Go to ${PROD_URL}/v2/create/
2. Trigger the ${action} action
3. The server returns a 500 error

**Instructions:**
1. Read the file that contains the endpoint handler (look in api/v2/ for the file matching "${endpoint}")
2. Find the code path that handles action="${action}"
3. Identify what throws: "${errorMessage}"
4. Use the diagnostics above to understand exactly what the AI model returned and how the parser handled it
5. Fix the root cause, not just the symptom
6. Add proper error handling if missing
7. Commit and push the fix`;
}

/**
 * Report an API error: log to DB, email admins, create support ticket.
 *
 * @param {object} options
 * @param {string} options.endpoint - API path (e.g., '/api/v2/auth')
 * @param {string} options.action - Query action (e.g., 'quickSignup')
 * @param {Error} options.error - The caught error object
 * @param {object} [options.requestBody] - The request body (will be sanitized)
 * @param {object} [options.req] - The Vercel request object
 * @param {object} [options.diagnostics] - Endpoint-specific debugging data (raw response snippets, parser state, model info, etc.)
 */
export async function reportApiError({ endpoint, action, error, requestBody, req, diagnostics }) {
  const errorMessage = error?.message || String(error) || 'Unknown error';
  const errorStack = error?.stack || '';
  const requestMeta = extractRequestMeta(req);
  const sanitizedBody = sanitizeBody(requestBody);
  const claudePrompt = buildClaudePrompt({ endpoint, action, errorMessage, errorStack, requestMeta, diagnostics });
  const timestamp = new Date().toISOString();

  // 1. Log to Supabase api_error_log table
  let errorLogId = null;
  const sb = getSupabase();
  if (sb) {
    try {
      const insertPayload = {
        endpoint,
        action,
        error_message: errorMessage,
        error_stack: errorStack,
        request_body: sanitizedBody,
        request_meta: requestMeta,
        claude_prompt: claudePrompt,
        created_at: timestamp
      };
      // Store diagnostics if provided (new JSONB column — insert won't fail if column doesn't exist yet)
      if (diagnostics && Object.keys(diagnostics).length > 0) {
        insertPayload.diagnostics = diagnostics;
      }
      const { data } = await sb.from('api_error_log').insert(insertPayload).select('id').single();
      errorLogId = data?.id;
    } catch (logErr) {
      console.error('Error reporter — failed to log to DB:', logErr.message);
    }
  }

  // 2. Create a support ticket (category: 'api_error', priority: 'urgent')
  let ticketNumber = null;
  if (sb) {
    try {
      const { data: ticket } = await sb.from('support_tickets').insert({
        subject: `API Error: ${endpoint}?action=${action} — ${errorMessage.slice(0, 100)}`,
        category: 'bug_report',
        priority: 'urgent',
        status: 'open'
      }).select('id, ticket_number').single();

      if (ticket) {
        ticketNumber = ticket.ticket_number;
        // Add error details as the first message
        await sb.from('support_messages').insert({
          ticket_id: ticket.id,
          sender_type: 'system',
          message: `**Auto-generated API error report**\n\n` +
            `**Endpoint:** \`${endpoint}?action=${action}\`\n` +
            `**Error:** ${errorMessage}\n` +
            `**Time:** ${timestamp}\n` +
            `**IP:** ${requestMeta.ip || 'unknown'}\n` +
            `**Geo:** ${requestMeta.geo?.city || ''}, ${requestMeta.geo?.region || ''}, ${requestMeta.geo?.country || ''}\n\n` +
            `**Stack trace:**\n\`\`\`\n${errorStack}\n\`\`\`\n\n` +
            `**Request body:**\n\`\`\`json\n${JSON.stringify(sanitizedBody, null, 2)}\n\`\`\`\n\n` +
            `**Claude Code fix prompt:**\n\`\`\`\n${claudePrompt}\n\`\`\``
        }).catch(() => {});
      }
    } catch (ticketErr) {
      console.error('Error reporter — failed to create ticket:', ticketErr.message);
    }
  }

  // 3. Fetch additional error alert email recipients from app_config
  let extraEmails = [];
  if (sb) {
    try {
      const { data: configRow } = await sb
        .from('app_config')
        .select('value')
        .eq('key', 'error_alert_emails')
        .maybeSingle();
      if (configRow?.value) {
        const parsed = JSON.parse(configRow.value);
        if (Array.isArray(parsed)) extraEmails = parsed.filter(e => e && typeof e === 'string');
      }
    } catch (_) { /* no config row yet — that's fine */ }
  }

  // 4. Email admins with full error details + Claude Code prompt
  const resend = getResend();
  if (resend) {
    try {
      const ticketLine = ticketNumber ? `<tr><td style="color:#6B7280;font-size:13px;border-bottom:1px solid #FFE8CC;padding:12px 16px;">Support Ticket</td><td style="color:#1A1A2E;font-size:14px;font-weight:600;border-bottom:1px solid #FFE8CC;padding:12px 16px;">#${ticketNumber}</td></tr>` : '';
      const errorLogLine = errorLogId ? `<tr><td style="color:#6B7280;font-size:13px;border-bottom:1px solid #FFE8CC;padding:12px 16px;">Error Log ID</td><td style="color:#1A1A2E;font-size:14px;font-family:monospace;border-bottom:1px solid #FFE8CC;padding:12px 16px;">${errorLogId}</td></tr>` : '';

      const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background-color:#f5f5f5;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#f5f5f5;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
        <tr>
          <td style="background-color:#7F1D1D;padding:32px 40px;border-radius:16px 16px 0 0;text-align:center;">
            <h1 style="margin:0;font-family:'Playfair Display',Georgia,serif;color:#FFFAF5;font-size:24px;font-weight:700;">API Error Alert</h1>
            <p style="margin:8px 0 0;color:#FCA5A5;font-size:14px;">${endpoint}?action=${action}</p>
          </td>
        </tr>
        <tr>
          <td style="background-color:#FFFAF5;padding:40px;">
            <p style="margin:0 0 24px;color:#1A1A2E;font-size:16px;line-height:1.6;">
              A 500 error occurred in production. Details below.
            </p>
            <table width="100%" cellpadding="12" cellspacing="0" style="background-color:#FEF2F2;border-radius:12px;margin-bottom:24px;">
              <tr>
                <td style="color:#6B7280;font-size:13px;border-bottom:1px solid #FECACA;padding:12px 16px;">Error</td>
                <td style="color:#991B1B;font-size:14px;font-weight:600;border-bottom:1px solid #FECACA;padding:12px 16px;">${errorMessage}</td>
              </tr>
              <tr>
                <td style="color:#6B7280;font-size:13px;border-bottom:1px solid #FECACA;padding:12px 16px;">Endpoint</td>
                <td style="color:#1A1A2E;font-size:14px;font-family:monospace;border-bottom:1px solid #FECACA;padding:12px 16px;">${endpoint}?action=${action}</td>
              </tr>
              <tr>
                <td style="color:#6B7280;font-size:13px;border-bottom:1px solid #FECACA;padding:12px 16px;">Time</td>
                <td style="color:#1A1A2E;font-size:14px;border-bottom:1px solid #FECACA;padding:12px 16px;">${timestamp}</td>
              </tr>
              <tr>
                <td style="color:#6B7280;font-size:13px;border-bottom:1px solid #FECACA;padding:12px 16px;">IP / Geo</td>
                <td style="color:#1A1A2E;font-size:14px;border-bottom:1px solid #FECACA;padding:12px 16px;">${requestMeta.ip || 'unknown'} — ${requestMeta.geo?.city || ''}, ${requestMeta.geo?.region || ''}, ${requestMeta.geo?.country || ''}</td>
              </tr>
              ${ticketLine}
              ${errorLogLine}
            </table>

            <p style="margin:0 0 8px;color:#1A1A2E;font-size:14px;font-weight:600;">Stack Trace:</p>
            <pre style="background-color:#1A1A2E;color:#E5E7EB;padding:16px;border-radius:8px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;margin:0 0 24px;">${errorStack || 'No stack trace'}</pre>

            ${diagnostics && Object.keys(diagnostics).length > 0 ? `
            <p style="margin:0 0 8px;color:#1A1A2E;font-size:14px;font-weight:600;">Diagnostics:</p>
            <table width="100%" cellpadding="8" cellspacing="0" style="background-color:#EFF6FF;border-radius:8px;margin-bottom:24px;border:1px solid #BFDBFE;">
              ${Object.entries(diagnostics).map(([key, value]) => {
                const displayValue = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
                const isLong = displayValue.length > 200;
                return `<tr>
                  <td style="color:#1E40AF;font-size:12px;font-weight:600;vertical-align:top;white-space:nowrap;border-bottom:1px solid #DBEAFE;padding:8px 12px;width:160px;">${key}</td>
                  <td style="color:#1A1A2E;font-size:12px;font-family:monospace;border-bottom:1px solid #DBEAFE;padding:8px 12px;${isLong ? 'white-space:pre-wrap;word-break:break-all;' : ''}">${displayValue.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</td>
                </tr>`;
              }).join('')}
            </table>` : ''}

            <p style="margin:0 0 8px;color:#1A1A2E;font-size:14px;font-weight:600;">Claude Code Fix Prompt:</p>
            <div style="background-color:#F0F0FF;border-left:4px solid #A78BFA;border-radius:8px;padding:16px;margin-bottom:24px;">
              <pre style="margin:0;font-size:12px;white-space:pre-wrap;word-break:break-all;color:#1A1A2E;">${claudePrompt}</pre>
            </div>

            <p style="margin:0 0 8px;color:#1A1A2E;font-size:14px;font-weight:600;">Request Body:</p>
            <pre style="background-color:#F3F4F6;color:#1A1A2E;padding:16px;border-radius:8px;font-size:12px;overflow-x:auto;white-space:pre-wrap;word-break:break-all;margin:0 0 24px;">${JSON.stringify(sanitizedBody, null, 2) || 'empty'}</pre>

            ${ticketNumber ? `<div style="text-align:center;margin:32px 0;">
              <a href="${PROD_URL}/v2/admin/#support" style="display:inline-block;background-color:#E94560;color:#ffffff;text-decoration:none;padding:14px 32px;border-radius:50px;font-size:16px;font-weight:600;">
                View Support Ticket #${ticketNumber}
              </a>
            </div>` : ''}
          </td>
        </tr>
        <tr>
          <td style="background-color:#7F1D1D;padding:20px 40px;border-radius:0 0 16px 16px;text-align:center;">
            <p style="margin:0;color:#FCA5A5;font-size:12px;">Ryvite API Error Alerts</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

      await resend.emails.send({
        from: 'Ryvite Alerts <alerts@ryvite.com>',
        to: [...new Set([ADMIN_EMAIL, ...extraEmails])],
        subject: `[API ERROR] ${endpoint}?action=${action} — ${errorMessage.slice(0, 80)}`,
        html
      });
    } catch (emailErr) {
      console.error('Error reporter — failed to send email:', emailErr.message);
    }
  }

  return { errorLogId, ticketNumber };
}
