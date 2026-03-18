/**
 * Ryvite Meta Pixel Helper
 * Initializes Meta Pixel and provides tracking helpers with CAPI dedup support.
 */
(function() {
  var PIXEL_ID = '1854308178620853';

  // ---- Meta Pixel base code ----
  !function(f,b,e,v,n,t,s){
    if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};
    if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
    n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t,s)
  }(window, document,'script','https://connect.facebook.net/en_US/fbevents.js');

  // Init with advanced matching from localStorage if available
  var storedData = {};
  try {
    var raw = localStorage.getItem('rvt_meta_ud');
    if (raw) storedData = JSON.parse(raw);
  } catch(e) {}

  if (storedData.em) {
    fbq('init', PIXEL_ID, {
      em: storedData.em,
      ph: storedData.ph || '',
      fn: storedData.fn || '',
      ln: storedData.ln || ''
    });
  } else {
    fbq('init', PIXEL_ID);
  }
  fbq('track', 'PageView');

  // ---- Helpers ----

  function generateEventId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // Fallback UUID v4
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      var r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? decodeURIComponent(match[2]) : '';
  }

  function getFbCookies() {
    return {
      fbp: getCookie('_fbp'),
      fbc: getCookie('_fbc')
    };
  }

  function getMetaContext() {
    var cookies = getFbCookies();
    return {
      fbp: cookies.fbp,
      fbc: cookies.fbc,
      eventSourceUrl: window.location.href
    };
  }

  // SHA-256 hash using Web Crypto API (async)
  function hashPII(value) {
    if (!value) return Promise.resolve('');
    var normalized = String(value).trim().toLowerCase();
    if (!normalized) return Promise.resolve('');
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      var encoder = new TextEncoder();
      return crypto.subtle.digest('SHA-256', encoder.encode(normalized)).then(function(buf) {
        return Array.from(new Uint8Array(buf)).map(function(b) { return b.toString(16).padStart(2, '0'); }).join('');
      });
    }
    // Fallback: return raw (Meta pixel accepts unhashed for client-side advanced matching)
    return Promise.resolve(normalized);
  }

  // Store user data for advanced matching persistence across pages
  function storeUserData(userData) {
    if (!userData) return;
    try {
      var data = {};
      if (userData.em) data.em = userData.em;
      if (userData.ph) data.ph = userData.ph.replace(/\D/g, '').slice(-10);
      if (userData.fn) data.fn = userData.fn;
      if (userData.ln) data.ln = userData.ln;
      localStorage.setItem('rvt_meta_ud', JSON.stringify(data));
    } catch(e) {}
  }

  // Re-initialize pixel with user data (call after login/signup)
  function reinitWithUserData(userData) {
    if (!userData) return;
    storeUserData(userData);
    fbq('init', PIXEL_ID, {
      em: userData.em || '',
      ph: (userData.ph || '').replace(/\D/g, '').slice(-10),
      fn: userData.fn || '',
      ln: userData.ln || ''
    });
  }

  /**
   * Track a standard Meta event with dedup support.
   * @param {string} eventName - Standard event name (e.g. 'Purchase', 'Lead')
   * @param {object} params - Event parameters (value, currency, content_name, etc.)
   * @param {object} [userData] - Optional PII for advanced matching {em, ph, fn, ln}
   * @param {string} [preGeneratedEventId] - Optional pre-generated event ID for dedup
   * @returns {string} The event ID used (for passing to server)
   */
  function trackEvent(eventName, params, userData, preGeneratedEventId) {
    var eventId = preGeneratedEventId || generateEventId();
    if (userData) {
      storeUserData(userData);
    }
    fbq('track', eventName, params || {}, { eventID: eventId });
    return eventId;
  }

  /**
   * Track a custom event.
   * @param {string} eventName - Custom event name
   * @param {object} params - Event parameters
   * @returns {string} The event ID used
   */
  function trackCustom(eventName, params) {
    var eventId = generateEventId();
    fbq('trackCustom', eventName, params || {}, { eventID: eventId });
    return eventId;
  }

  // Expose global namespace
  window.RyvitePixel = {
    trackEvent: trackEvent,
    trackCustom: trackCustom,
    generateEventId: generateEventId,
    hashPII: hashPII,
    getFbCookies: getFbCookies,
    getMetaContext: getMetaContext,
    reinitWithUserData: reinitWithUserData,
    storeUserData: storeUserData,
    PIXEL_ID: PIXEL_ID
  };
})();
