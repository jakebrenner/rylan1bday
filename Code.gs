// ============================================================
// Ryvite – Google Apps Script (Web App)
// Deploy as: Execute as ME, Anyone can access
// ============================================================

var SPREADSHEET_ID = SpreadsheetApp.getActiveSpreadsheet().getId();

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

// ---- GET handler (JSONP) ----
function doGet(e) {
  var action = (e.parameter.action || "").trim();
  var callback = e.parameter.callback || "callback";

  var result = {};

  if (action === "getSettings") {
    result = handleGetSettings();
  } else if (action === "guestList") {
    var eventId = e.parameter.eventId || "";
    result = handleGuestList(eventId);
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
  } else {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Unknown action: " + action }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ============================================================
// Settings
// ============================================================
// Sheet columns: eventId | eventName | zapierWebhook | invitePageUrl

function handleGetSettings() {
  var sheet = getOrCreateSheet("Settings", ["eventId", "eventName", "zapierWebhook", "invitePageUrl"]);
  if (sheet.getLastRow() < 2) return {};

  var row = sheet.getRange("A2:D2").getValues()[0];
  return {
    eventId:        row[0] || "",
    eventName:      row[1] || "",
    zapierWebhook:  row[2] || "",
    invitePageUrl:  row[3] || ""
  };
}

function handleSaveSettings(data) {
  var sheet = getOrCreateSheet("Settings", ["eventId", "eventName", "zapierWebhook", "invitePageUrl"]);

  // Always write to row 2 (single-event setup)
  var values = [[
    data.eventId       || "",
    data.eventName     || "",
    data.zapierWebhook || "",
    data.invitePageUrl || ""
  ]];
  sheet.getRange("A2:D2").setValues(values);

  return ContentService.createTextOutput(JSON.stringify({ status: "ok" }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// Invites
// ============================================================
// Sheet columns: Timestamp | EventUUID | InviteUUID | Name | Phone | Status | Adults | Kids

function handleInvite(data) {
  var sheet = getOrCreateSheet("Invites", [
    "Timestamp", "EventUUID", "InviteUUID", "Name", "Phone", "Status", "Adults", "Kids"
  ]);

  sheet.appendRow([
    new Date(),
    data.eventUuid  || "",
    data.inviteUuid || "",
    data.name       || "",
    data.phone      || "",
    "Sent",
    "",
    ""
  ]);

  return ContentService.createTextOutput(JSON.stringify({ status: "ok" }))
    .setMimeType(ContentService.MimeType.JSON);
}

// ============================================================
// RSVP
// ============================================================

function handleRsvp(data) {
  var sheet = getOrCreateSheet("Invites", [
    "Timestamp", "EventUUID", "InviteUUID", "Name", "Phone", "Status", "Adults", "Kids"
  ]);

  var inviteUuid = data.inviteUuid || data.id || "";
  if (!inviteUuid) {
    return ContentService.createTextOutput(JSON.stringify({ status: "error", message: "Missing inviteUuid" }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Find the row by InviteUUID (column C)
  var dataRange = sheet.getDataRange();
  var values = dataRange.getValues();
  var found = false;

  for (var i = 1; i < values.length; i++) {
    if (values[i][2] === inviteUuid) {
      var status = data.attending ? "Attending" : "Not Attending";
      sheet.getRange(i + 1, 6).setValue(status);               // Status
      sheet.getRange(i + 1, 7).setValue(data.adults || "");     // Adults
      sheet.getRange(i + 1, 8).setValue(data.kids || "");       // Kids
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
  var headers = data[0];
  var guests = [];

  for (var i = 1; i < data.length; i++) {
    var row = data[i];
    // If eventId filter is provided, only include matching rows
    if (eventId && row[1] !== eventId) continue;

    guests.push({
      timestamp: row[0] ? new Date(row[0]).toISOString() : "",
      uuid:      row[2] || "",
      name:      row[3] || "",
      phone:     row[4] || "",
      status:    row[5] || "",
      adults:    row[6] ? String(row[6]) : "",
      kids:      row[7] ? String(row[7]) : ""
    });
  }

  return { guests: guests };
}
