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
  }
  return sheet;
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
// Sheet columns: Phone | EventID | EventName | Name | AddedAt
//
// Each row maps one phone number to one event they can admin.
// A phone can appear in multiple rows (one per event).

var ADMINS_HEADERS = ["Phone", "EventID", "EventName", "Name", "AddedAt"];

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
  var events = [];
  var seen = {};

  for (var i = 1; i < data.length; i++) {
    var rowPhone = normalizePhone(String(data[i][0]));
    if (rowPhone === phone) {
      var eventId = String(data[i][1] || "");
      if (eventId && !seen[eventId]) {
        seen[eventId] = true;
        events.push({
          eventId: eventId,
          eventName: String(data[i][2] || eventId)
        });
      }
    }
  }

  return { events: events };
}

function handleAddAdmin(data) {
  var phone = normalizePhone(data.phone || "");
  var eventId = (data.eventId || "").trim();
  var eventName = (data.eventName || "").trim();
  var name = (data.name || "").trim();

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

  sheet.appendRow([phone, eventId, eventName, name, new Date()]);

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
      admins.push({
        phone: String(data[i][0] || ""),
        name: String(data[i][3] || ""),
        addedAt: data[i][4] ? new Date(data[i][4]).toISOString() : ""
      });
    }
  }

  return { admins: admins };
}

// ============================================================
// Settings
// ============================================================
// Sheet columns: eventId | eventName | zapierWebhook | invitePageUrl | customFields
//
// customFields is a JSON string defining RSVP form fields, e.g.:
// [{"key":"adults","label":"Adults","type":"number"},{"key":"kids","label":"Kids","type":"number"}]
//
// Supported field types: text, number, select, checkbox

var SETTINGS_HEADERS = ["eventId", "eventName", "zapierWebhook", "invitePageUrl", "customFields"];

function handleGetSettings(eventId) {
  var sheet = getOrCreateSheet("Settings", SETTINGS_HEADERS);
  if (sheet.getLastRow() < 2) return {};

  // If eventId provided, search for matching row
  if (eventId) {
    var data = sheet.getDataRange().getValues();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][0]) === eventId) {
        var customFields = [];
        try { customFields = JSON.parse(data[i][4] || "[]"); } catch (e) { customFields = []; }
        return {
          eventId:        data[i][0] || "",
          eventName:      data[i][1] || "",
          zapierWebhook:  data[i][2] || "",
          invitePageUrl:  data[i][3] || "",
          customFields:   customFields
        };
      }
    }
    return {};
  }

  // Fallback: return first row (backwards compat)
  var row = sheet.getRange("A2:E2").getValues()[0];
  var customFields = [];
  try { customFields = JSON.parse(row[4] || "[]"); } catch (e) { customFields = []; }

  return {
    eventId:        row[0] || "",
    eventName:      row[1] || "",
    zapierWebhook:  row[2] || "",
    invitePageUrl:  row[3] || "",
    customFields:   customFields
  };
}

function handleSaveSettings(data) {
  var sheet = getOrCreateSheet("Settings", SETTINGS_HEADERS);

  var customFields = "";
  if (data.customFields) {
    customFields = typeof data.customFields === "string"
      ? data.customFields
      : JSON.stringify(data.customFields);
  }

  var eventId = data.eventId || "";
  var values = [
    eventId,
    data.eventName     || "",
    data.zapierWebhook || "",
    data.invitePageUrl || "",
    customFields
  ];

  // Search for existing row with this eventId
  if (eventId && sheet.getLastRow() >= 2) {
    var existing = sheet.getDataRange().getValues();
    for (var i = 1; i < existing.length; i++) {
      if (String(existing[i][0]) === eventId) {
        sheet.getRange(i + 1, 1, 1, 5).setValues([values]);
        return ContentService.createTextOutput(JSON.stringify({ status: "ok" }))
          .setMimeType(ContentService.MimeType.JSON);
      }
    }
  }

  // No existing row — append new one
  sheet.appendRow(values);

  return ContentService.createTextOutput(JSON.stringify({ status: "ok" }))
    .setMimeType(ContentService.MimeType.JSON);
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
  if (!inviteId) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Missing inviteId" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Find the row by InviteID (column C)
  var dataRange = sheet.getDataRange();
  var values = dataRange.getValues();
  var found = false;

  for (var i = 1; i < values.length; i++) {
    if (values[i][2] === inviteId) {
      var status = data.attending ? "Attending" : "Not Attending";
      sheet.getRange(i + 1, 6).setValue(status);

      // Store all custom field responses as JSON in ResponseData (column G)
      var responseData = {};
      if (data.responseData && typeof data.responseData === "object") {
        responseData = data.responseData;
      }
      sheet.getRange(i + 1, 7).setValue(JSON.stringify(responseData));

      found = true;
      break;
    }
  }

  return ContentService.createTextOutput(JSON.stringify({
    status: found ? "ok" : "not_found"
  })).setMimeType(ContentService.MimeType.JSON);
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
