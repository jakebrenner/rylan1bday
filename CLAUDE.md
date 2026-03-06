# Ryvite - Project Guide

## External Scripts (Google Apps Script, SQL, etc.)

Whenever Code.gs or any other external script (SQL migrations, cloud functions, etc.) is modified:

1. **Always paste the FULL updated script** in your response so the user can copy-paste it directly into the external editor (Google Apps Script, database console, etc.)
2. **Never** assume the user will find it in GitHub — they need it right in the chat
3. After pasting, remind the user of any deployment steps required (e.g., "Deploy > Manage deployments > New version" for Google Apps Script)

### Current Google Apps Script (Code.gs)

The backend lives in Google Apps Script and is **not auto-deployed** from this repo. The file `Code.gs` in the repo is the source of truth. When it changes, the user must manually paste it into their Apps Script editor and deploy a new version.

**Deployment steps for Google Apps Script:**
1. Open the Apps Script editor
2. Replace the entire Code.gs contents with the updated version
3. Save (Ctrl+S)
4. Deploy > Manage deployments > Edit (pencil icon) > Version: **New version** > Deploy

**Schema notes:**
- Settings sheet columns (A-F): `eventId | eventName | zapierWebhook | invitePageUrl | customFields | smsMessage`
- Invites sheet columns (A-G): `Timestamp | EventID | InviteID | Name | Phone | Status | ResponseData`
- Admins sheet columns (A-E): `phone | eventId | adminFirst | adminLast | addedAt`
- `getOrCreateSheet()` auto-migrates missing header columns, so adding new columns to `*_HEADERS` arrays is safe
- Always use explicit column counts (`SETTINGS_HEADERS.length`) when reading ranges — never rely on `getDataRange()` for sheets that may have empty trailing columns

## Architecture

- **Frontend**: Static HTML/JS in `admin/`, `invite/`, `login/`
- **API proxy**: `api/sheets.js` — Vercel serverless function that proxies requests to Google Apps Script (avoids CORS/redirect issues)
- **Backend**: Google Apps Script web app (Code.gs) reading/writing Google Sheets
- **Environment variable**: `GAS_URL` — the deployed Google Apps Script web app URL

## Development Notes

- Phone numbers are normalized to 10-digit US format (strip +1 prefix)
- Custom fields config is stored as JSON string in the `customFields` column
- RSVP response data is stored as JSON string in the `ResponseData` column
- The API proxy sends POST bodies as `Content-Type: text/plain` to avoid GAS redirect issues
