// ============================================================
// Ryvite – Google Apps Script (Web App)
// Deploy as: Execute as ME, Anyone can access
// ============================================================

// ---- Sheet helpers ----
function getOrCreateSheet(name, headers) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers && headers.length) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
      sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold");
    }
  } else if (headers && headers.length) {
    var maxCol = Math.max(sheet.getLastColumn() || 1, headers.length);
    var existingHeaders = sheet.getRange(1, 1, 1, maxCol).getValues()[0];
    for (var h = 0; h < headers.length; h++) {
      if (String(existingHeaders[h] || "").trim() !== headers[h]) {
        sheet.getRange(1, h + 1).setValue(headers[h]).setFontWeight("bold");
      }
    }
  }
  return sheet;
}

// ---- One-time migration: run this manually to add missing columns ----
function migrateSettingsColumns() {
  var sheet = getOrCreateSheet("Settings", SETTINGS_HEADERS);
  Logger.log("Settings sheet now has headers: " + SETTINGS_HEADERS.join(", "));
  Logger.log("Done! You can delete this function after running it.");
}

function normalizePhone(str) {
  var digits = (str || "").replace(/[^0-9]/g, "");
  if (digits.length === 11 && digits.charAt(0) === "1") {
    digits = digits.substring(1);
  }
  return digits;
}

// ---- UUID generator ----
function generateUUID() {
  var chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  var sections = [8, 4, 4, 4, 12];
  var uuid = [];
  for (var s = 0; s < sections.length; s++) {
    var part = "";
    for (var i = 0; i < sections[s]; i++) {
      part += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    uuid.push(part);
  }
  return uuid.join("-");
}

// ---- Slug generator ----
function generateSlug(title) {
  var slug = (title || "event").toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .substring(0, 50);
  // Add short random suffix for uniqueness
  var suffix = Math.random().toString(36).substring(2, 6);
  return slug + "-" + suffix;
}

// ---- HMAC-SHA256 signing ----
function hmacSign(data, secret) {
  var signature = Utilities.computeHmacSha256Signature(data, secret);
  return Utilities.base64EncodeWebSafe(signature);
}

function generateAuthToken(userId, email) {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty("AUTH_SECRET") || "ryvite-default-secret";
  var payload = JSON.stringify({
    userId: userId,
    email: email,
    exp: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
  });
  var encoded = Utilities.base64EncodeWebSafe(payload);
  var sig = hmacSign(encoded, secret);
  return encoded + "." + sig;
}

function verifyAuthToken(token) {
  var props = PropertiesService.getScriptProperties();
  var secret = props.getProperty("AUTH_SECRET") || "ryvite-default-secret";

  var parts = token.split(".");
  if (parts.length !== 2) return null;

  var encoded = parts[0];
  var sig = parts[1];
  var expectedSig = hmacSign(encoded, secret);

  if (sig !== expectedSig) return null;

  try {
    var decoded = Utilities.newBlob(Utilities.base64DecodeWebSafe(encoded)).getDataAsString();
    var payload = JSON.parse(decoded);
    if (new Date(payload.exp) < new Date()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

// ---- Send magic link email via Resend ----
function sendMagicLinkEmail(email, displayName, token) {
  var props = PropertiesService.getScriptProperties();
  var resendApiKey = props.getProperty("RESEND_API_KEY");
  var vercelDomain = props.getProperty("VERCEL_DOMAIN") || "ryvite.com";

  if (!resendApiKey) {
    Logger.log("RESEND_API_KEY not set — skipping email send");
    return false;
  }

  var loginUrl = "https://" + vercelDomain + "/login/?token=" + encodeURIComponent(token);
  var greeting = displayName ? ("Hi " + displayName + ",") : "Hi there,";

  var htmlBody = '<div style="font-family: Inter, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">'
    + '<h1 style="font-family: Playfair Display, serif; color: #1A1A2E; font-size: 28px;">Ryvite</h1>'
    + '<p style="color: #333; font-size: 16px; margin-top: 24px;">' + greeting + '</p>'
    + '<p style="color: #666; font-size: 14px;">Click the button below to sign in to your Ryvite account:</p>'
    + '<a href="' + loginUrl + '" style="display: inline-block; background: #E94560; color: white; padding: 14px 32px; border-radius: 6px; text-decoration: none; font-weight: 600; font-size: 14px; margin: 24px 0;">Sign In to Ryvite</a>'
    + '<p style="color: #999; font-size: 12px; margin-top: 24px;">This link expires in 7 days. If you didn\'t request this, you can safely ignore this email.</p>'
    + '</div>';

  var payload = {
    from: "Ryvite <noreply@" + vercelDomain + ">",
    to: [email],
    subject: "Your Ryvite Login Link",
    html: htmlBody
  };

  var options = {
    method: "post",
    headers: {
      "Authorization": "Bearer " + resendApiKey,
      "Content-Type": "application/json"
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    var response = UrlFetchApp.fetch("https://api.resend.com/emails", options);
    var code = response.getResponseCode();
    if (code >= 200 && code < 300) {
      return true;
    }
    Logger.log("Resend error: " + response.getContentText());
    return false;
  } catch (e) {
    Logger.log("Email send error: " + e.message);
    return false;
  }
}

// ---- GET handler (JSONP) ----
function doGet(e) {
  var action = (e.parameter.action || "").trim();
  var callback = e.parameter.callback || "callback";

  var result = {};

  if (action === "getSettings") {
    result = handleGetSettings(e.parameter.eventId);
  } else if (action === "guestList") {
    var eventId = e.parameter.eventId || "";
    result = handleGuestList(eventId);
  } else if (action === "adminLogin") {
    var phone = e.parameter.phone || "";
    result = handleAdminLogin(phone);
  } else if (action === "getAdmins") {
    var eventId = e.parameter.eventId || "";
    result = handleGetAdmins(eventId);
  } else {
    result = { error: "Unknown action: " + action };
  }

  var output = callback + "(" + JSON.stringify(result) + ")";
  return ContentService.createTextOutput(output)
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

// ---- POST handler ----
function doPost(e) {
  var rawContents = e.postData.contents;
  var contentType = e.postData.type || "";
  var data;

  // Support both JSON body and URL-encoded form data
  if (contentType.indexOf("application/x-www-form-urlencoded") >= 0 || contentType.indexOf("text/plain") >= 0) {
    try {
      // Try parsing as JSON first (text/plain from api proxy)
      data = JSON.parse(rawContents);
    } catch (err) {
      // Parse URL-encoded form: action=xxx&data=yyy
      var params = {};
      var pairs = rawContents.split("&");
      for (var p = 0; p < pairs.length; p++) {
        var kv = pairs[p].split("=");
        params[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || "");
      }
      if (params.action && params.data) {
        data = JSON.parse(params.data);
        data.action = params.action;
      } else if (params.action) {
        data = params;
      } else {
        return jsonResponse({ success: false, error: "Invalid request format" });
      }
    }
  } else {
    try {
      data = JSON.parse(rawContents);
    } catch (err) {
      return jsonResponse({ status: "error", message: "Invalid JSON" });
    }
  }

  var action = (data.action || "").trim();

  // V1 actions
  if (action === "saveSettings") {
    return handleSaveSettings(data);
  } else if (action === "invite") {
    return handleInvite(data);
  } else if (action === "rsvp") {
    return handleRsvp(data);
  } else if (action === "addAdmin") {
    return handleAddAdmin(data);
  } else if (action === "removeAdmin") {
    return handleRemoveAdmin(data);
  }
  // V2 actions
  else if (action === "signup") {
    return handleSignup(data);
  } else if (action === "login") {
    return handleLogin(data);
  } else if (action === "verifyToken") {
    return handleVerifyToken(data);
  } else if (action === "createEvent") {
    return handleCreateEvent(data);
  } else if (action === "updateEvent") {
    return handleUpdateEvent(data);
  } else if (action === "getEvent") {
    return handleGetEvent(data);
  } else if (action === "getUserEvents") {
    return handleGetUserEvents(data);
  } else if (action === "logGeneration") {
    return handleLogGeneration(data);
  } else if (action === "addInvite") {
    return handleAddInviteV2(data);
  } else {
    return jsonResponse({ status: "error", message: "Unknown action: " + action });
  }
}

// ---- JSON response helper ----
function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// V2 Sheet Headers
// ============================================================

var USERS_HEADERS = ["id", "email", "phone", "displayName", "authToken", "tokenExpiry", "createdAt"];
var EVENTS_HEADERS = ["id", "userId", "title", "description", "eventDate", "endDate", "locationName", "locationAddress", "dressCode", "eventType", "slug", "status", "prompt", "themeHtml", "themeCss", "themeConfig", "zapierWebhook", "customFields", "createdAt", "updatedAt"];
var GENERATION_LOG_HEADERS = ["id", "eventId", "userId", "prompt", "model", "inputTokens", "outputTokens", "latencyMs", "status", "error", "createdAt"];

// ============================================================
// V2: Auth Actions
// ============================================================

function handleSignup(data) {
  var email = (data.email || "").trim().toLowerCase();
  var displayName = (data.displayName || "").trim();
  var phone = normalizePhone(data.phone || "");

  if (!email) {
    return jsonResponse({ success: false, error: "Email is required" });
  }

  var sheet = getOrCreateSheet("Users", USERS_HEADERS);
  var numCols = USERS_HEADERS.length;

  // Check if user already exists
  if (sheet.getLastRow() >= 2) {
    var existing = sheet.getRange(1, 1, sheet.getLastRow(), numCols).getValues();
    for (var i = 1; i < existing.length; i++) {
      if (String(existing[i][1]).toLowerCase() === email) {
        // User exists — send a new magic link instead
        var userId = String(existing[i][0]);
        var token = generateAuthToken(userId, email);
        var expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        sheet.getRange(i + 1, 5).setValue(token);  // authToken
        sheet.getRange(i + 1, 6).setValue(expiry.toISOString());  // tokenExpiry

        sendMagicLinkEmail(email, String(existing[i][3]) || displayName, token);

        return jsonResponse({ success: true, message: "Check your email for login link" });
      }
    }
  }

  // Create new user
  var userId = generateUUID();
  var token = generateAuthToken(userId, email);
  var expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  sheet.appendRow([
    userId,
    email,
    phone,
    displayName,
    token,
    expiry.toISOString(),
    new Date().toISOString()
  ]);

  sendMagicLinkEmail(email, displayName, token);

  return jsonResponse({ success: true, message: "Check your email for login link" });
}

function handleLogin(data) {
  var email = (data.email || "").trim().toLowerCase();

  if (!email) {
    return jsonResponse({ success: false, error: "Email is required" });
  }

  var sheet = getOrCreateSheet("Users", USERS_HEADERS);
  var numCols = USERS_HEADERS.length;

  // Find user by email
  if (sheet.getLastRow() >= 2) {
    var existing = sheet.getRange(1, 1, sheet.getLastRow(), numCols).getValues();
    for (var i = 1; i < existing.length; i++) {
      if (String(existing[i][1]).toLowerCase() === email) {
        var userId = String(existing[i][0]);
        var displayName = String(existing[i][3] || "");
        var token = generateAuthToken(userId, email);
        var expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

        sheet.getRange(i + 1, 5).setValue(token);
        sheet.getRange(i + 1, 6).setValue(expiry.toISOString());

        sendMagicLinkEmail(email, displayName, token);

        return jsonResponse({ success: true, message: "Check your email for login link" });
      }
    }
  }

  // User not found — auto-create (login doubles as signup for convenience)
  var userId = generateUUID();
  var token = generateAuthToken(userId, email);
  var expiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  sheet.appendRow([
    userId,
    email,
    "",
    "",
    token,
    expiry.toISOString(),
    new Date().toISOString()
  ]);

  sendMagicLinkEmail(email, "", token);

  return jsonResponse({ success: true, message: "Check your email for login link" });
}

function handleVerifyToken(data) {
  var token = (data.token || "").trim();

  if (!token) {
    return jsonResponse({ success: false, error: "Token is required" });
  }

  // Verify HMAC signature and expiry
  var payload = verifyAuthToken(token);
  if (!payload) {
    return jsonResponse({ success: false, error: "Invalid or expired token" });
  }

  // Find user by ID
  var sheet = getOrCreateSheet("Users", USERS_HEADERS);
  var numCols = USERS_HEADERS.length;

  if (sheet.getLastRow() >= 2) {
    var users = sheet.getRange(1, 1, sheet.getLastRow(), numCols).getValues();
    for (var i = 1; i < users.length; i++) {
      if (String(users[i][0]) === payload.userId) {
        return jsonResponse({
          success: true,
          user: {
            id: String(users[i][0]),
            email: String(users[i][1]),
            phone: String(users[i][2] || ""),
            displayName: String(users[i][3] || "")
          }
        });
      }
    }
  }

  return jsonResponse({ success: false, error: "User not found" });
}

// ============================================================
// V2: Event Actions
// ============================================================

function handleCreateEvent(data) {
  var userId = (data.userId || "").trim();
  var title = (data.title || "").trim();

  if (!userId || !title) {
    return jsonResponse({ success: false, error: "userId and title are required" });
  }

  var eventId = generateUUID();
  var slug = generateSlug(title);
  var now = new Date().toISOString();

  var sheet = getOrCreateSheet("Events", EVENTS_HEADERS);
  sheet.appendRow([
    eventId,
    userId,
    title,
    data.description || "",
    data.eventDate || "",
    data.endDate || "",
    data.locationName || "",
    data.locationAddress || "",
    data.dressCode || "",
    data.eventType || "",
    slug,
    "Draft",
    data.prompt || "",
    "",  // themeHtml
    "",  // themeCss
    "",  // themeConfig
    data.zapierWebhook || "",
    data.customFields ? (typeof data.customFields === "string" ? data.customFields : JSON.stringify(data.customFields)) : "",
    now,
    now
  ]);

  return jsonResponse({ success: true, eventId: eventId, slug: slug });
}

function handleUpdateEvent(data) {
  var eventId = (data.eventId || "").trim();
  var userId = (data.userId || "").trim();

  if (!eventId) {
    return jsonResponse({ success: false, error: "eventId is required" });
  }

  var sheet = getOrCreateSheet("Events", EVENTS_HEADERS);
  var numCols = EVENTS_HEADERS.length;

  if (sheet.getLastRow() < 2) {
    return jsonResponse({ success: false, error: "Event not found" });
  }

  var events = sheet.getRange(1, 1, sheet.getLastRow(), numCols).getValues();

  for (var i = 1; i < events.length; i++) {
    if (String(events[i][0]) === eventId) {
      // Validate ownership if userId provided
      if (userId && String(events[i][1]) !== userId) {
        return jsonResponse({ success: false, error: "Unauthorized" });
      }

      // Update each field if provided, keeping existing values otherwise
      var updatedRow = events[i].slice();

      if (data.title !== undefined) updatedRow[2] = data.title;
      if (data.description !== undefined) updatedRow[3] = data.description;
      if (data.eventDate !== undefined) updatedRow[4] = data.eventDate;
      if (data.endDate !== undefined) updatedRow[5] = data.endDate;
      if (data.locationName !== undefined) updatedRow[6] = data.locationName;
      if (data.locationAddress !== undefined) updatedRow[7] = data.locationAddress;
      if (data.dressCode !== undefined) updatedRow[8] = data.dressCode;
      if (data.eventType !== undefined) updatedRow[9] = data.eventType;
      if (data.status !== undefined) updatedRow[11] = data.status;
      if (data.prompt !== undefined) updatedRow[12] = data.prompt;
      if (data.themeHtml !== undefined) updatedRow[13] = data.themeHtml;
      if (data.themeCss !== undefined) updatedRow[14] = data.themeCss;
      if (data.themeConfig !== undefined) {
        updatedRow[15] = typeof data.themeConfig === "string" ? data.themeConfig : JSON.stringify(data.themeConfig);
      }
      if (data.zapierWebhook !== undefined) updatedRow[16] = data.zapierWebhook;
      if (data.customFields !== undefined) {
        updatedRow[17] = typeof data.customFields === "string" ? data.customFields : JSON.stringify(data.customFields);
      }
      updatedRow[19] = new Date().toISOString(); // updatedAt

      sheet.getRange(i + 1, 1, 1, numCols).setValues([updatedRow]);

      return jsonResponse({ success: true, event: buildEventObj(updatedRow) });
    }
  }

  return jsonResponse({ success: false, error: "Event not found" });
}

function handleGetEvent(data) {
  var eventId = (data.eventId || "").trim();
  var slug = (data.slug || "").trim();

  if (!eventId && !slug) {
    return jsonResponse({ success: false, error: "eventId or slug is required" });
  }

  var sheet = getOrCreateSheet("Events", EVENTS_HEADERS);
  var numCols = EVENTS_HEADERS.length;

  if (sheet.getLastRow() < 2) {
    return jsonResponse({ success: false, error: "Event not found" });
  }

  var events = sheet.getRange(1, 1, sheet.getLastRow(), numCols).getValues();

  for (var i = 1; i < events.length; i++) {
    if ((eventId && String(events[i][0]) === eventId) || (slug && String(events[i][10]) === slug)) {
      return jsonResponse({ success: true, event: buildEventObj(events[i]) });
    }
  }

  return jsonResponse({ success: false, error: "Event not found" });
}

function handleGetUserEvents(data) {
  var userId = (data.userId || "").trim();

  if (!userId) {
    return jsonResponse({ success: false, error: "userId is required" });
  }

  var sheet = getOrCreateSheet("Events", EVENTS_HEADERS);
  var numCols = EVENTS_HEADERS.length;

  if (sheet.getLastRow() < 2) {
    return jsonResponse({ success: true, events: [] });
  }

  var allEvents = sheet.getRange(1, 1, sheet.getLastRow(), numCols).getValues();
  var userEvents = [];

  for (var i = 1; i < allEvents.length; i++) {
    if (String(allEvents[i][1]) === userId) {
      userEvents.push(buildEventObj(allEvents[i]));
    }
  }

  // Sort by createdAt DESC
  userEvents.sort(function(a, b) {
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  return jsonResponse({ success: true, events: userEvents });
}

function buildEventObj(row) {
  var themeConfig = {};
  try { themeConfig = JSON.parse(row[15] || "{}"); } catch (e) { themeConfig = {}; }
  var customFields = [];
  try { customFields = JSON.parse(row[17] || "[]"); } catch (e) { customFields = []; }

  return {
    id: String(row[0] || ""),
    userId: String(row[1] || ""),
    title: String(row[2] || ""),
    description: String(row[3] || ""),
    eventDate: String(row[4] || ""),
    endDate: String(row[5] || ""),
    locationName: String(row[6] || ""),
    locationAddress: String(row[7] || ""),
    dressCode: String(row[8] || ""),
    eventType: String(row[9] || ""),
    slug: String(row[10] || ""),
    status: String(row[11] || "Draft"),
    prompt: String(row[12] || ""),
    themeHtml: String(row[13] || ""),
    themeCss: String(row[14] || ""),
    themeConfig: themeConfig,
    zapierWebhook: String(row[16] || ""),
    customFields: customFields,
    createdAt: String(row[18] || ""),
    updatedAt: String(row[19] || "")
  };
}

// ============================================================
// V2: Generation Log
// ============================================================

function handleLogGeneration(data) {
  var sheet = getOrCreateSheet("GenerationLog", GENERATION_LOG_HEADERS);

  sheet.appendRow([
    generateUUID(),
    data.eventId || "",
    data.userId || "",
    data.prompt || "",
    data.model || "",
    data.inputTokens || 0,
    data.outputTokens || 0,
    data.latencyMs || 0,
    data.status || "",
    data.error || "",
    new Date().toISOString()
  ]);

  return jsonResponse({ success: true });
}

// ============================================================
// V2: Rate Limiting
// ============================================================

function checkRateLimit(userId) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("GenerationLog");
  if (!sheet || sheet.getLastRow() < 2) return true;

  var data = sheet.getDataRange().getValues();
  var oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  var count = 0;

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][2]) === userId && new Date(data[i][10]) > oneHourAgo && String(data[i][8]) === "success") {
      count++;
    }
  }

  return count < 5;
}

// ============================================================
// V2: RSVP (for dynamic event pages)
// ============================================================

function handleAddInviteV2(data) {
  var eventId = (data.eventId || "").trim();
  var inviteId = data.inviteId || generateUUID();
  var name = (data.name || "").trim();
  var statusVal = (data.status || "").trim();

  if (!eventId || !name) {
    return jsonResponse({ success: false, error: "eventId and name are required" });
  }

  var attending;
  if (statusVal === "yes") attending = "Attending";
  else if (statusVal === "no") attending = "Not Attending";
  else if (statusVal === "maybe") attending = "Maybe";
  else attending = statusVal;

  var sheet = getOrCreateSheet("Invites", INVITES_HEADERS);

  // Check if inviteId already exists and update
  if (inviteId && sheet.getLastRow() >= 2) {
    var existing = sheet.getDataRange().getValues();
    for (var i = 1; i < existing.length; i++) {
      if (String(existing[i][2]) === inviteId) {
        if (name) sheet.getRange(i + 1, 4).setValue(name);
        sheet.getRange(i + 1, 6).setValue(attending);
        if (data.responseData) {
          sheet.getRange(i + 1, 7).setValue(JSON.stringify(data.responseData));
        }
        return jsonResponse({ success: true, inviteId: inviteId });
      }
    }
  }

  sheet.appendRow([
    new Date(),
    eventId,
    inviteId,
    name,
    data.phone || "",
    attending,
    data.responseData ? JSON.stringify(data.responseData) : ""
  ]);

  return jsonResponse({ success: true, inviteId: inviteId });
}

// ============================================================
// V1: Admins (unchanged)
// ============================================================

var ADMINS_HEADERS = ["phone", "eventId", "adminFirst", "adminLast", "addedAt"];

function handleAdminLogin(rawPhone) {
  var phone = normalizePhone(rawPhone);
  if (phone.length < 10) {
    return { error: "Invalid phone number" };
  }

  var sheet = getOrCreateSheet("Admins", ADMINS_HEADERS);
  if (sheet.getLastRow() < 2) {
    return { events: [] };
  }

  var data = sheet.getDataRange().getValues();
  var eventIds = [];
  var seen = {};

  for (var i = 1; i < data.length; i++) {
    var rowPhone = normalizePhone(String(data[i][0]));
    if (rowPhone === phone) {
      var eventId = String(data[i][1] || "");
      if (eventId && !seen[eventId]) {
        seen[eventId] = true;
        eventIds.push(eventId);
      }
    }
  }

  var events = [];
  if (eventIds.length > 0) {
    var settingsSheet = getOrCreateSheet("Settings", SETTINGS_HEADERS);
    var settingsMap = {};
    if (settingsSheet.getLastRow() >= 2) {
      var sData = settingsSheet.getDataRange().getValues();
      for (var j = 1; j < sData.length; j++) {
        settingsMap[String(sData[j][0])] = String(sData[j][1] || "");
      }
    }
    for (var k = 0; k < eventIds.length; k++) {
      events.push({
        eventId: eventIds[k],
        eventName: settingsMap[eventIds[k]] || eventIds[k]
      });
    }
  }

  return { events: events };
}

function handleAddAdmin(data) {
  var phone = normalizePhone(data.phone || "");
  var eventId = (data.eventId || "").trim();
  var adminFirst = (data.adminFirst || "").trim();
  var adminLast = (data.adminLast || "").trim();

  if (phone.length < 10) {
    return jsonResponse({ status: "error", message: "Invalid phone number" });
  }
  if (!eventId) {
    return jsonResponse({ status: "error", message: "Missing eventId" });
  }

  var sheet = getOrCreateSheet("Admins", ADMINS_HEADERS);

  if (sheet.getLastRow() >= 2) {
    var existing = sheet.getDataRange().getValues();
    for (var i = 1; i < existing.length; i++) {
      if (normalizePhone(String(existing[i][0])) === phone && String(existing[i][1]) === eventId) {
        return jsonResponse({ status: "ok", message: "Already an admin" });
      }
    }
  }

  sheet.appendRow([phone, eventId, adminFirst, adminLast, new Date()]);

  return jsonResponse({ status: "ok" });
}

function handleRemoveAdmin(data) {
  var phone = normalizePhone(data.phone || "");
  var eventId = (data.eventId || "").trim();

  if (!phone || !eventId) {
    return jsonResponse({ status: "error", message: "Missing phone or eventId" });
  }

  var sheet = getOrCreateSheet("Admins", ADMINS_HEADERS);
  if (sheet.getLastRow() < 2) {
    return jsonResponse({ status: "not_found" });
  }

  var data_range = sheet.getDataRange().getValues();
  for (var i = data_range.length - 1; i >= 1; i--) {
    if (normalizePhone(String(data_range[i][0])) === phone && String(data_range[i][1]) === eventId) {
      sheet.deleteRow(i + 1);
      return jsonResponse({ status: "ok" });
    }
  }

  return jsonResponse({ status: "not_found" });
}

function handleGetAdmins(eventId) {
  if (!eventId) return { admins: [] };

  var sheet = getOrCreateSheet("Admins", ADMINS_HEADERS);
  if (sheet.getLastRow() < 2) return { admins: [] };

  var data = sheet.getDataRange().getValues();
  var admins = [];

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][1]) === eventId) {
      var first = String(data[i][2] || "");
      var last = String(data[i][3] || "");
      admins.push({
        phone: String(data[i][0] || ""),
        adminFirst: first,
        adminLast: last,
        name: (first + " " + last).trim(),
        addedAt: data[i][4] ? new Date(data[i][4]).toISOString() : ""
      });
    }
  }

  return { admins: admins };
}

// ============================================================
// V1: Settings (unchanged)
// ============================================================

var SETTINGS_HEADERS = ["eventId", "eventName", "zapierWebhook", "invitePageUrl", "customFields", "smsMessage", "eventDate", "eventTime", "eventLocation", "eventDescription"];

function handleGetSettings(eventId) {
  var numCols = SETTINGS_HEADERS.length;
  var sheet = getOrCreateSheet("Settings", SETTINGS_HEADERS);
  if (sheet.getLastRow() < 2) return {};

  var lastRow = sheet.getLastRow();
  var data = sheet.getRange(1, 1, lastRow, numCols).getValues();

  if (eventId) {
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === eventId) {
        var customFields = [];
        try { customFields = JSON.parse(data[i][4] || "[]"); } catch (e) { customFields = []; }
        return {
          eventId:          String(data[i][0] || ""),
          eventName:        String(data[i][1] || ""),
          zapierWebhook:    String(data[i][2] || ""),
          invitePageUrl:    String(data[i][3] || ""),
          customFields:     customFields,
          smsMessage:       String(data[i][5] || ""),
          eventDate:        String(data[i][6] || ""),
          eventTime:        String(data[i][7] || ""),
          eventLocation:    String(data[i][8] || ""),
          eventDescription: String(data[i][9] || "")
        };
      }
    }
    return {};
  }

  var row = data[1];
  var customFields = [];
  try { customFields = JSON.parse(row[4] || "[]"); } catch (e) { customFields = []; }

  return {
    eventId:          String(row[0] || ""),
    eventName:        String(row[1] || ""),
    zapierWebhook:    String(row[2] || ""),
    invitePageUrl:    String(row[3] || ""),
    customFields:     customFields,
    smsMessage:       String(row[5] || ""),
    eventDate:        String(row[6] || ""),
    eventTime:        String(row[7] || ""),
    eventLocation:    String(row[8] || ""),
    eventDescription: String(row[9] || "")
  };
}

function handleSaveSettings(data) {
  var numCols = SETTINGS_HEADERS.length;
  var sheet = getOrCreateSheet("Settings", SETTINGS_HEADERS);

  var customFields = "";
  if (data.customFields) {
    customFields = typeof data.customFields === "string"
      ? data.customFields
      : JSON.stringify(data.customFields);
  }

  var eventId = data.eventId || "";
  var smsMessage = data.smsMessage || "";
  var values = [
    eventId,
    data.eventName        || "",
    data.zapierWebhook    || "",
    data.invitePageUrl    || "",
    customFields,
    smsMessage,
    data.eventDate        || "",
    data.eventTime        || "",
    data.eventLocation    || "",
    data.eventDescription || ""
  ];

  if (eventId && sheet.getLastRow() >= 2) {
    var existing = sheet.getRange(1, 1, sheet.getLastRow(), numCols).getValues();
    for (var i = 1; i < existing.length; i++) {
      if (String(existing[i][0]) === eventId) {
        sheet.getRange(i + 1, 1, 1, numCols).setValues([values]);
        return jsonResponse({
          status: "ok",
          savedColumns: numCols,
          smsMessageReceived: smsMessage.substring(0, 50),
          row: i + 1
        });
      }
    }
  }

  sheet.appendRow(values);

  return jsonResponse({
    status: "ok",
    savedColumns: numCols,
    smsMessageReceived: smsMessage.substring(0, 50),
    row: "appended"
  });
}

// ============================================================
// V1: Invites (unchanged)
// ============================================================

var INVITES_HEADERS = ["Timestamp", "EventID", "InviteID", "Name", "Phone", "Status", "ResponseData"];

function handleInvite(data) {
  var sheet = getOrCreateSheet("Invites", INVITES_HEADERS);

  sheet.appendRow([
    new Date(),
    data.eventId  || "",
    data.inviteId || "",
    data.name     || "",
    data.phone    || "",
    "Sent",
    ""
  ]);

  return jsonResponse({ status: "ok" });
}

// ============================================================
// V1: RSVP (unchanged)
// ============================================================

function handleRsvp(data) {
  var sheet = getOrCreateSheet("Invites", INVITES_HEADERS);

  var inviteId = data.inviteId || data.id || "";
  var status = data.attending === true ? "Attending" : "Not Attending";
  var responseData = {};
  if (data.responseData && typeof data.responseData === "object") {
    responseData = data.responseData;
  }
  var responseJson = JSON.stringify(responseData);

  if (inviteId) {
    var dataRange = sheet.getDataRange();
    var values = dataRange.getValues();

    for (var i = 1; i < values.length; i++) {
      if (values[i][2] === inviteId) {
        if (data.name) sheet.getRange(i + 1, 4).setValue(data.name);
        if (data.phone) sheet.getRange(i + 1, 5).setValue(data.phone);
        sheet.getRange(i + 1, 6).setValue(status);
        sheet.getRange(i + 1, 7).setValue(responseJson);

        return jsonResponse({ status: "ok" });
      }
    }
  }

  sheet.appendRow([
    new Date(),
    data.eventId  || "",
    inviteId,
    data.name     || "",
    data.phone    || "",
    status,
    responseJson
  ]);

  return jsonResponse({ status: "ok" });
}

// ============================================================
// V1: Guest List (unchanged)
// ============================================================

function handleGuestList(eventId) {
  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Invites");
  if (!sheet || sheet.getLastRow() < 2) return { guests: [] };

  var data = sheet.getDataRange().getValues();
  var guests = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    if (eventId && row[1] !== eventId) continue;

    var responseData = {};
    try { responseData = JSON.parse(row[6] || "{}"); } catch (e) { responseData = {}; }

    guests.push({
      timestamp:    row[0] ? new Date(row[0]).toISOString() : "",
      inviteId:     row[2] || "",
      name:         row[3] || "",
      phone:        row[4] || "",
      status:       row[5] || "",
      responseData: responseData
    });
  }

  return { guests: guests };
}
