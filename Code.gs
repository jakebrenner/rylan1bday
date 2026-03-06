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
// Sheet columns: eventId | eventName | zapierWebhook | invitePageUrl | customFields
//
// customFields is a JSON string defining RSVP form fields, e.g.:
// [{"key":"adults","label":"Adults","type":"number"},{"key":"kids","label":"Kids","type":"number"}]
//
// Supported field types: text, number, select, checkbox

var SETTINGS_HEADERS = ["eventId", "eventName", "zapierWebhook", "invitePageUrl", "customFields"];

function handleGetSettings() {
  var sheet = getOrCreateSheet("Settings", SETTINGS_HEADERS);
  if (sheet.getLastRow() < 2) return {};

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

  var values = [[
    data.eventId       || "",
    data.eventName     || "",
    data.zapierWebhook || "",
    data.invitePageUrl || "",
    customFields
  ]];
  sheet.getRange("A2:E2").setValues(values);

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
