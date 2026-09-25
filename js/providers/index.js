// TABot.providers: the one interface app code uses to reach any provider.
//
// How adapters are found. In node each adapter is require()d below. In the
// browser each adapter file is a classic script that must load BEFORE this
// one and registers itself as TABot.provider<Name> (groq.js sets
// TABot.providerGroq). This file then assembles TABot.providers, so the page
// reaches an adapter as TABot.providers.groq or TABot.providers.get('groq').
// Adding a provider = one adapter file, one line in ADAPTERS, one script tag.
(function (root, factory) {
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.TABot = root.TABot || {}; root.TABot.providers = api; }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var inNode = typeof module === 'object' && module.exports;

  function load(nodePath, browserName) {
    var adapter = inNode ? require(nodePath) : (root.TABot && root.TABot[browserName]);
    if (!adapter) {
      throw new Error('TABot: ' + nodePath.replace('./', 'js/providers/') + ' must load before js/providers/index.js');
    }
    return adapter;
  }

  var ADAPTERS = [load('./groq.js', 'providerGroq')];
  var registry = {};
  ADAPTERS.forEach(function (adapter) { registry[adapter.id] = adapter; });

  // -> the adapter, or null for an id no adapter claims.
  function get(id) {
    return Object.prototype.hasOwnProperty.call(registry, id) ? registry[id] : null;
  }

  function list() {
    return ADAPTERS.slice();
  }

  function ascending(a, b) {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function uniqueIds(ids) {
    var seen = {};
    return (ids || []).filter(function (id) {
      if (typeof id !== 'string' || !id || Object.prototype.hasOwnProperty.call(seen, id)) return false;
      seen[id] = true;
      return true;
    });
  }

  function isVerdict(v) {
    return !!v && typeof v === 'object' && typeof v.vision === 'boolean';
  }

  // The probe cache may be a plain object {[id]: verdict} that the caller
  // saves afterwards, or anything with get(id)/set(id, verdict) (a Map, or a
  // store.js wrapper that persists each verdict as it lands).
  //
  // prune(keep) deletes every cached id for which keep(id) is false. It
  // lists ids through keys() (a Map) or all() (the store.js wrapper), and
  // deletes through delete(id) or remove(id); a cache with all() and clear()
  // but no delete is rewritten without the doomed ids. A get/set cache that
  // cannot list its ids is left as it is.
  function cacheAccess(cache) {
    if (cache && typeof cache.get === 'function' && typeof cache.set === 'function') {
      return {
        get: function (id) { return cache.get(id); },
        set: function (id, verdict) { return cache.set(id, verdict); },
        prune: function (keep) { pruneObjectCache(cache, keep); }
      };
    }
    var map = cache && typeof cache === 'object' ? cache : {};
    return {
      get: function (id) { return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined; },
      set: function (id, verdict) { map[id] = verdict; },
      prune: function (keep) {
        Object.keys(map).forEach(function (id) { if (!keep(id)) delete map[id]; });
      }
    };
  }

  function pruneObjectCache(cache, keep) {
    var snapshot = null;
    var ids;
    if (typeof cache.keys === 'function') {
      ids = Array.from(cache.keys());
    } else if (typeof cache.all === 'function') {
      snapshot = cache.all();
      ids = snapshot && typeof snapshot === 'object' ? Object.keys(snapshot) : [];
    } else {
      return;
    }
    var doomed = ids.filter(function (id) { return !keep(id); });
    if (!doomed.length) return;
    var remove = typeof cache.delete === 'function' ? 'delete' : typeof cache.remove === 'function' ? 'remove' : null;
    if (remove) {
      doomed.forEach(function (id) { cache[remove](id); });
    } else if (snapshot && typeof cache.clear === 'function') {
      cache.clear();
      Object.keys(snapshot).forEach(function (id) {
        if (keep(id) && isVerdict(snapshot[id])) cache.set(id, snapshot[id]);
      });
    }
  }

  function isoNow(now) {
    var t = now();
    if (typeof t === 'string') return t;
    return (t instanceof Date ? t : new Date(t)).toISOString();
  }

  // Browser only: a 64x64 mid-gray JPEG with a dark diagonal line. Not 1x1,
  // because a vision encoder with a minimum patch size may reject a 1x1 image
  // and the probe would then call a vision model blind.
  function makeProbeImage() {
    var doc = root.document;
    if (!doc || typeof doc.createElement !== 'function') {
      throw new Error('TABot: no probe image outside the browser; pass probeImage as a data URL');
    }
    var canvas = doc.createElement('canvas');
    canvas.width = 64;
    canvas.height = 64;
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 64, 64);
    ctx.strokeStyle = '#202020';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(64, 64);
    ctx.stroke();
    var dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    canvas.width = 0;
    canvas.height = 0;
    return dataUrl;
  }

  // -> {visionModels, probed, unknown}. visionModels are in ascending id
  // order. Each listed model without a cached verdict is probed once, one at
  // a time; a verdict is cached as {vision, checkedAt}. A 401 stops the whole
  // check (bad key). Any other provider error leaves that model unknown and
  // uncached, so the next check tries it again. probed counts probe calls.
  // Cached ids missing from the fresh list are deleted from the cache, so a
  // retired model is never restored from it.
  // recheck: true (an explicit Check key) probes every cached false verdict
  // again, since a refusal can end (terms accepted, access granted); a probe
  // that errors then leaves the old verdict in place and the id unknown.
  // Cached true verdicts are trusted either way.
  // Optional: onProgress(done, total) after each model; now() for checkedAt;
  // signal (an AbortSignal) is handed to listModels and every probe.
  async function resolveVisionModels(opts) {
    opts = opts || {};
    var provider = typeof opts.provider === 'string' ? get(opts.provider) : opts.provider;
    if (!provider || typeof provider.listModels !== 'function' || typeof provider.probeVision !== 'function') {
      throw new TypeError('resolveVisionModels needs a provider adapter or a known provider id');
    }
    var cache = cacheAccess(opts.cache);
    var now = opts.now || function () { return new Date(); };
    var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};
    var probeImage = opts.probeImage || null;
    var recheck = opts.recheck === true;

    var listArgs = { key: opts.key, fetch: opts.fetch };
    if (opts.signal) listArgs.signal = opts.signal;
    var models = await provider.listModels(listArgs);
    var ids = uniqueIds(models.map(function (m) { return m && m.id; })).sort(ascending);
    var listed = {};
    ids.forEach(function (id) { listed[id] = true; });
    cache.prune(function (id) { return Object.prototype.hasOwnProperty.call(listed, id); });
    var visionModels = [];
    var unknown = [];
    var probed = 0;
    onProgress(0, ids.length);

    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var cached = cache.get(id);
      var trusted = isVerdict(cached) && (cached.vision || !recheck);
      if (trusted) {
        if (cached.vision) visionModels.push(id);
      } else {
        if (!probeImage) probeImage = makeProbeImage();
        probed++;
        var probeArgs = { key: opts.key, fetch: opts.fetch, model: id, probeImage: probeImage };
        if (opts.signal) probeArgs.signal = opts.signal;
        try {
          var vision = await provider.probeVision(probeArgs);
          cache.set(id, { vision: vision === true, checkedAt: isoNow(now) });
          if (vision === true) visionModels.push(id);
        } catch (err) {
          // No numeric status means a bug, not a provider answer: surface it.
          if (!err || typeof err.status !== 'number' || err.status === 401) throw err;
          unknown.push(id);
        }
      }
      onProgress(i + 1, ids.length);
    }
    return { visionModels: visionModels, probed: probed, unknown: unknown };
  }

  // -> the chosen model first (when it is still a vision model), then the
  // rest in ascending id order: the order app.js falls back through.
  function rankModels(visionModels, chosen) {
    var ids = uniqueIds(visionModels);
    var rest = ids.filter(function (id) { return id !== chosen; }).sort(ascending);
    return ids.indexOf(chosen) >= 0 ? [chosen].concat(rest) : rest;
  }

  var api = {
    get: get,
    list: list,
    resolveVisionModels: resolveVisionModels,
    rankModels: rankModels,
    makeProbeImage: makeProbeImage
  };
  ADAPTERS.forEach(function (adapter) { api[adapter.id] = adapter; });
  return api;
});
