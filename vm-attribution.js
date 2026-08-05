(function () {
  var ATTR_KEYS = [
    'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
    'fbclid', 'fbp', 'gclid', 'gbraid', 'wbraid', 'msclkid'
  ];
  var STORE = 'vm_attr';
  var FIRST_STORE = 'vm_first_touch';
  var IP_STORE = 'vm_client_ip';
  var IP_TIMEOUT_MS = 1200;

  function cleanUrl(value) {
    if (!value) return '';
    try {
      var u = new URL(value, window.location.href);
      u.hash = '';
      return u.toString();
    } catch (e) {
      return String(value).split('#')[0];
    }
  }

  function readCookie(name) {
    var match = document.cookie.match('(^|;)\\s*' + name + '\\s*=\\s*([^;]+)');
    return match ? decodeURIComponent(match.pop()) : '';
  }

  function readJson(key) {
    try {
      return JSON.parse(sessionStorage.getItem(key) || '{}') || {};
    } catch (e) {
      return {};
    }
  }

  function writeJson(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}
  }

  function readStoredIp() {
    try {
      return sessionStorage.getItem(IP_STORE) || '';
    } catch (e) {
      return '';
    }
  }

  function writeStoredIp(ip) {
    try {
      if (ip) sessionStorage.setItem(IP_STORE, ip);
    } catch (e) {}
  }

  function sanitizeIp(value) {
    if (!value) return '';
    value = String(value).trim();
    return /^[0-9a-fA-F:.]{3,45}$/.test(value) ? value : '';
  }

  function withTimeout(promise, ms) {
    return Promise.race([
      promise,
      new Promise(function (resolve) {
        setTimeout(function () { resolve(''); }, ms);
      })
    ]);
  }

  function getIpFromCloudflare() {
    return fetch('/cdn-cgi/trace', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.text() : ''; })
      .then(function (txt) {
        var match = txt && txt.match(/^ip=(.*)$/m);
        return sanitizeIp(match ? match[1] : '');
      })
      .catch(function () { return ''; });
  }

  function getIpFromIpify() {
    return fetch('https://api.ipify.org?format=json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { return sanitizeIp(d && d.ip ? d.ip : ''); })
      .catch(function () { return ''; });
  }

  function resolveClientIp() {
    var stored = sanitizeIp(readStoredIp());
    if (stored) return Promise.resolve(stored);

    return withTimeout(
      getIpFromCloudflare().then(function (ip) {
        return ip || getIpFromIpify();
      }),
      IP_TIMEOUT_MS
    ).then(function (ip) {
      ip = sanitizeIp(ip);
      if (ip) writeStoredIp(ip);
      return ip || '';
    });
  }

  function collectAttribution() {
    var url = new URLSearchParams(window.location.search);
    var saved = readJson(STORE);
    var firstTouch = readJson(FIRST_STORE);
    var currentPage = cleanUrl(window.location.href);
    var referrer = cleanUrl(document.referrer || '');

    if (!firstTouch.first_landing_page) firstTouch.first_landing_page = currentPage;
    if (!firstTouch.first_referrer && referrer) firstTouch.first_referrer = referrer;
    writeJson(FIRST_STORE, firstTouch);

    ATTR_KEYS.forEach(function (key) {
      var value = url.get(key);
      if (value && !saved[key]) saved[key] = value;
    });
    writeJson(STORE, saved);

    var values = {};
    ATTR_KEYS.forEach(function (key) {
      if (saved[key]) values[key] = saved[key];
      var currentValue = url.get(key);
      if (currentValue) values[key] = currentValue;
    });

    var fbp = readCookie('_fbp');
    if (fbp) values.fbp = fbp;

    if (navigator.userAgent) values.ua = navigator.userAgent;

    var ip = sanitizeIp(readStoredIp() || url.get('ip'));
    if (ip) values.ip = ip;

    values.referrer = referrer || url.get('referrer') || '';
    values.first_referrer = firstTouch.first_referrer || url.get('first_referrer') || '';
    values.first_landing_page = firstTouch.first_landing_page || url.get('first_landing_page') || currentPage;
    values.landing_page = values.first_landing_page;
    values.current_page = currentPage;

    window.VM_ATTR_VALUES = values;
    return values;
  }

  function valuesToParams(values) {
    var params = new URLSearchParams();
    Object.keys(values).forEach(function (key) {
      if (values[key]) params.set(key, values[key]);
    });
    return params;
  }

  function appendParams(rawUrl, params) {
    if (!rawUrl || !params || !params.toString()) return rawUrl;

    var hash = '';
    var hashIndex = rawUrl.indexOf('#');
    if (hashIndex > -1) {
      hash = rawUrl.slice(hashIndex);
      rawUrl = rawUrl.slice(0, hashIndex);
    }

    var path = rawUrl;
    var query = '';
    var queryIndex = rawUrl.indexOf('?');
    if (queryIndex > -1) {
      path = rawUrl.slice(0, queryIndex);
      query = rawUrl.slice(queryIndex + 1);
    }

    var merged = new URLSearchParams(query);
    params.forEach(function (value, key) {
      if (value && !merged.has(key)) merged.set(key, value);
    });

    var search = merged.toString();
    return path + (search ? '?' + search : '') + hash;
  }

  function syncTallyConfig(values) {
    if (!window.TallyConfig || !window.TallyConfig.popup) return;
    window.TallyConfig.popup.hiddenFields = Object.assign(
      {},
      window.TallyConfig.popup.hiddenFields || {},
      values
    );
  }

  function applyAttribution() {
    var values = collectAttribution();
    syncTallyConfig(values);

    var params = valuesToParams(values);
    if (!params.toString()) return;

    document.querySelectorAll('a[href*="form"]').forEach(function (link) {
      var href = link.getAttribute('href');
      link.setAttribute('href', appendParams(href, params));
    });

    document.querySelectorAll('iframe[data-tally-src], iframe[src*="tally.so"]').forEach(function (frame) {
      var attr = frame.hasAttribute('data-tally-src') ? 'data-tally-src' : 'src';
      var src = frame.getAttribute(attr);
      var next = appendParams(src, params);
      if (next && next !== src) frame.setAttribute(attr, next);
    });
  }

  window.VM_ATTR_VALUES = collectAttribution();
  window.VM_ATTR_APPLY = applyAttribution;
  window.VM_ATTR_READY = resolveClientIp().then(function () {
    applyAttribution();
    return window.VM_ATTR_VALUES || {};
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyAttribution);
  } else {
    applyAttribution();
  }

  setTimeout(applyAttribution, 500);
  setTimeout(applyAttribution, 1500);
})();
