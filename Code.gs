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
    // Ensure all expected headers exist (handles schema migrations)
    // Check each position individually — fills in missing intermediate headers too
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
// Open Apps Script editor > Run > migrateSettingsColumns
function migrateSettingsColumns() {
  var sheet = getOrCreateSheet("Settings", SETTINGS_HEADERS);
  Logger.log("Settings sheet now has headers: " + SETTINGS_HEADERS.join(", "));
  Logger.log("Done! You can delete this function after running it.");
}

function normalizePhone(str) {
  var digits = (str || "").replace(/[^0-9]/g, "");
  // Strip leading "1" country code if 11 digits
  if (digits.length === 11 && digits.charAt(0) === "1") {
    digits = digits.substring(1);
  }
  return digits;
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
  var data;
  try {
    data = JSON.parse(e.postData.contents);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Invalid JSON" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var action = (data.action || "").trim();

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
  } else {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Unknown action: " + action }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================================
// Admins
// ============================================================
// Sheet columns: phone | eventId | adminFirst | adminLast | addedAt
//
// Each row maps one phone number to one event they can admin.
// A phone can appear in multiple rows (one per event).
// eventName is resolved via the Settings table join on eventId.

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

  // Resolve eventName from Settings table
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
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Invalid phone number" }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  if (!eventId) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Missing eventId" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var sheet = getOrCreateSheet("Admins", ADMINS_HEADERS);

  // Check for duplicate
  if (sheet.getLastRow() >= 2) {
    var existing = sheet.getDataRange().getValues();
    for (var i = 1; i < existing.length; i++) {
      if (normalizePhone(String(existing[i][0])) === phone && String(existing[i][1]) === eventId) {
        return ContentService.createTextOutput(JSON.stringify({ status: "ok", message: "Already an admin" }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }
  }

  sheet.appendRow([phone, eventId, adminFirst, adminLast, new Date()]);

  return ContentService.createTextOutput(JSON.stringify({ status: "ok" }))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleRemoveAdmin(data) {
  var phone = normalizePhone(data.phone || "");
  var eventId = (data.eventId || "").trim();

  if (!phone || !eventId) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Missing phone or eventId" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var sheet = getOrCreateSheet("Admins", ADMINS_HEADERS);
  if (sheet.getLastRow() < 2) {
    return ContentService.createTextOutput(JSON.stringify({ status: "not_found" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var data_range = sheet.getDataRange().getValues();
  for (var i = data_range.length - 1; i >= 1; i--) {
    if (normalizePhone(String(data_range[i][0])) === phone && String(data_range[i][1]) === eventId) {
      sheet.deleteRow(i + 1);
      return ContentService.createTextOutput(JSON.stringify({ status: "ok" }))
        .setMimeType(ContentService.MimeType.JSON);
    }
  }

  return ContentService.createTextOutput(JSON.stringify({ status: "not_found" }))
    .setMimeType(ContentService.MimeType.JSON);
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
// Settings
// ============================================================
// Sheet columns: eventId | eventName | zapierWebhook | invitePageUrl | customFields | smsMessage | eventDate | eventTime | eventLocation | eventDescription
//
// customFields is a JSON string defining RSVP form fields, e.g.:
// [{"key":"adults","label":"Adults","type":"number"},{"key":"kids","label":"Kids","type":"number"}]
//
// Supported field types: text, number, select, checkbox

var SETTINGS_HEADERS = ["eventId", "eventName", "zapierWebhook", "invitePageUrl", "customFields", "smsMessage", "eventDate", "eventTime", "eventLocation", "eventDescription"];

function handleGetSettings(eventId) {
  var numCols = SETTINGS_HEADERS.length;
  var sheet = getOrCreateSheet("Settings", SETTINGS_HEADERS);
  if (sheet.getLastRow() < 2) return {};

  // Always read the exact number of columns we expect (avoids getDataRange cutting short)
  var lastRow = sheet.getLastRow();
  var data = sheet.getRange(1, 1, lastRow, numCols).getValues();

  // If eventId provided, search for matching row
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

  // Fallback: return first row (backwards compat)
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

  // Search for existing row with this eventId
  if (eventId && sheet.getLastRow() >= 2) {
    var existing = sheet.getRange(1, 1, sheet.getLastRow(), numCols).getValues();
    for (var i = 1; i < existing.length; i++) {
      if (String(existing[i][0]) === eventId) {
        sheet.getRange(i + 1, 1, 1, numCols).setValues([values]);
        return ContentService.createTextOutput(JSON.stringify({
          status: "ok",
          savedColumns: numCols,
          smsMessageReceived: smsMessage.substring(0, 50),
          row: i + 1
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }
  }

  // No existing row — append new one
  sheet.appendRow(values);

  return ContentService.createTextOutput(JSON.stringify({
    status: "ok",
    savedColumns: numCols,
    smsMessageReceived: smsMessage.substring(0, 50),
    row: "appended"
  })).setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// Invites
// ============================================================
// Sheet columns: Timestamp | EventID | InviteID | Name | Phone | Status | ResponseData
//
// ResponseData is a JSON string holding all RSVP custom field values, e.g.:
// {"adults":2,"kids":1,"dietaryRestrictions":"none","songRequest":"Baby Shark"}

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

  return ContentService.createTextOutput(JSON.stringify({ status: "ok" }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// RSVP
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

  // If we have an inviteId, try to find and update the existing row
  if (inviteId) {
    var dataRange = sheet.getDataRange();
    var values = dataRange.getValues();

    for (var i = 1; i < values.length; i++) {
      if (values[i][2] === inviteId) {
        // Update name and phone if provided
        if (data.name) sheet.getRange(i + 1, 4).setValue(data.name);
        if (data.phone) sheet.getRange(i + 1, 5).setValue(data.phone);
        sheet.getRange(i + 1, 6).setValue(status);
        sheet.getRange(i + 1, 7).setValue(responseJson);

        return ContentService.createTextOutput(JSON.stringify({ status: "ok" }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }
  }

  // No existing invite row found — create a new one
  sheet.appendRow([
    new Date(),
    data.eventId  || "",
    inviteId,
    data.name     || "",
    data.phone    || "",
    status,
    responseJson
  ]);

  return ContentService.createTextOutput(JSON.stringify({ status: "ok" }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// Guest List (read)
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
