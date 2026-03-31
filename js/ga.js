/**
 * Ryvite Google Analytics 4 Helper
 * Initializes GA4 and provides tracking helpers.
 */
(function() {
  var GA_MEASUREMENT_ID = 'G-PXHNPDR9E6';

  // Inject gtag.js async script
  var script = document.createElement('script');
  script.async = true;
  script.src = 'https://www.googletagmanager.com/gtag/js?id=' + GA_MEASUREMENT_ID;
  document.head.appendChild(script);

  // Initialize dataLayer and gtag
  window.dataLayer = window.dataLayer || [];
  function gtag() { dataLayer.push(arguments); }
  gtag('js', new Date());
  gtag('config', GA_MEASUREMENT_ID);

  /**
   * Track a GA4 event.
   * @param {string} eventName - GA4 event name (e.g. 'sign_up', 'purchase')
   * @param {object} [params] - Event parameters
   */
  function trackEvent(eventName, params) {
    gtag('event', eventName, params || {});
  }

  /**
   * Set user properties for segmentation.
   * @param {object} props - User properties (e.g. { plan_type: 'free' })
   */
  function setUserProperties(props) {
    gtag('set', 'user_properties', props || {});
  }

  /**
   * Set user ID for cross-device tracking (call after login).
   * @param {string} userId
   */
  function setUserId(userId) {
    if (userId) {
      gtag('config', GA_MEASUREMENT_ID, { user_id: userId });
    }
  }

  // Expose global namespace
  window.RyviteGA = {
    trackEvent: trackEvent,
    setUserProperties: setUserProperties,
    setUserId: setUserId,
    GA_MEASUREMENT_ID: GA_MEASUREMENT_ID
  };
})();
