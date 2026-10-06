/* Shear redesign — FAQ accordion + Continuity settlement cards.
   Nav chrome is owned by shared/shear-chrome.js. */
(function () {
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {
    document.querySelectorAll('.faq-q').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var item = btn.closest('.faq-item');
        if (!item) return;
        var wasOpen = item.classList.contains('open');
        var root = item.parentElement;
        if (root) {
          root.querySelectorAll('.faq-item.open').forEach(function (el) {
            el.classList.remove('open');
            var q = el.querySelector('.faq-q');
            if (q) q.setAttribute('aria-expanded', 'false');
          });
        }
        if (!wasOpen) {
          item.classList.add('open');
          btn.setAttribute('aria-expanded', 'true');
        }
      });
    });
  });

  /* Continuity / ADMITv2 cards from /api/stats + /api/wallet/fluxset. */
  var NANOS = 100000000000;

  function setText(id, text) {
    var el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function fmtShe(n) {
    var v = Number(n) || 0;
    if (!Number.isFinite(v)) return '0 SHE';
    if (Math.abs(v - Math.round(v)) < 1e-9) {
      return Math.round(v).toLocaleString('en-GB') + ' SHE';
    }
    return v.toFixed(8).replace(/0+$/, '').replace(/\.$/, '') + ' SHE';
  }

  function fmtSecs(ms) {
    var s = Number(ms) / 1000;
    if (!Number.isFinite(s) || s <= 0) return '—';
    return s.toFixed(1) + ' s';
  }

  function fmtCirc(nanos) {
    var n = Math.round(Number(nanos) || 0);
    if (!Number.isFinite(n) || n <= 0) return '—';
    var whole = Math.floor(n / NANOS);
    var frac = n % NANOS;
    var head = whole.toLocaleString('en-GB');
    if (!frac) return head + ' SHE';
    var tail = String(frac).padStart(11, '0').replace(/0+$/, '');
    return head + '.' + tail + ' SHE';
  }

  function fmtCount(n) {
    var v = Number(n);
    if (!Number.isFinite(v) || v < 0) return '—';
    return Math.round(v).toLocaleString('en-GB');
  }

  function apiBase() {
    var h = '';
    try {
      h = (location && location.hostname) || '';
    } catch (e) {}
    if (h === 'shear.digital' || h === 'www.shear.digital' || h === 'pool.shear.digital') {
      return '';
    }
    if (h === '127.0.0.1' || h === 'localhost') {
      return 'https://shear.digital';
    }
    return 'https://shear.digital';
  }

  function paintContinuity(j) {
    if (!j || j.ok === false) return;
    var pot = Number(j.blockSubsidyNanos) / NANOS;
    if (!Number.isFinite(pot) || pot <= 0) pot = 1;
    var targetMs = Number(j.targetBlockIntervalMs) || 90000;
    var observed = j.networkAvgBlockTimeMs || j.avgBlockTimeMs;
    setText('nc-quantum', fmtShe(pot));
    setText('nc-flux', fmtShe(pot) + ' / ' + Math.round(targetMs / 1000) + ' s');
    /* Flux is the protocol target. Observed never says the ~90s target is met while n < 288. */
    var observedText = fmtSecs(observed);
    var gate = j.interval;
    if (gate && gate.soaking) {
      observedText += ' · soaking n=' + gate.sealedSamples + ' — ~90s not certified';
    } else if (gate && gate.certified90s) {
      observedText += ' · n=' + gate.sealedSamples + ' ~90s certified';
    } else if (gate) {
      observedText += ' · observational n=' + gate.sealedSamples;
    } else if (observedText !== '—') {
      observedText += ' · ~90s not certified';
    }
    setText('nc-observed', observedText);
    var circNanos = Number(j.circulatingNanos);
    var supplyWord = j.supplyStatus === 'verified' ? 'verified' : (j.supplyStatus ? 'mismatch' : '');
    if (j.supplyStatus === 'mismatch') {
      setText('nc-integral', (Number.isFinite(circNanos) ? fmtCirc(circNanos) : '—') + ' · mismatch');
    } else if (Number.isFinite(circNanos) && circNanos > 0) {
      setText('nc-integral', fmtCirc(circNanos) + (supplyWord ? ' · ' + supplyWord : ''));
    } else if (supplyWord) {
      setText('nc-integral', '0 · ' + supplyWord);
    } else {
      setText('nc-integral', '—');
    }
    /* Nodes online: all live peers reported by the pool. */
    if (j.nodesOnline != null) {
      setText('nc-nodes', fmtCount(j.nodesOnline));
    }
  }

  function paintFluxset(j) {
    if (!j || j.ok === false) return;
    /* Sealed notes: live ADMITv2 membership / usable outputs. */
    if (j.noteCount != null) {
      setText('nc-notes', fmtCount(j.noteCount));
    }
  }

  function hasContinuityCards() {
    return !!(
      document.getElementById('nc-observed') ||
      document.getElementById('nc-integral') ||
      document.getElementById('nc-nodes') ||
      document.getElementById('nc-notes')
    );
  }

  function tickContinuity() {
    if (!hasContinuityCards()) return;
    var base = apiBase();
    var q = '?_=' + Date.now();
    fetch(base + '/api/stats' + q, { cache: 'no-store' })
      .then(function (r) {
        return r.ok ? r.json() : Promise.reject();
      })
      .then(paintContinuity)
      .catch(function () {});
    fetch(base + '/api/wallet/fluxset' + q, { cache: 'no-store' })
      .then(function (r) {
        return r.ok ? r.json() : Promise.reject();
      })
      .then(paintFluxset)
      .catch(function () {});
  }

  ready(function () {
    tickContinuity();
    if (hasContinuityCards()) {
      setInterval(tickContinuity, 5000);
    }
  });
})();

  /* Home Continuum panels: blur / ease out as the page scrolls (Beam-like motion). */
  ready(function () {
    var visuals = document.getElementById('scroll-hero-visuals');
    var hero = document.getElementById('scroll-hero');
    if (!visuals || !hero) return;
    var reduce = false;
    try {
      reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {}
    if (reduce) return;

    var ticking = false;
    function paint() {
      ticking = false;
      var rect = hero.getBoundingClientRect();
      var h = Math.max(rect.height, 1);
      /* 0 at top of hero in view; 1 once hero mostly scrolled away */
      var progress = Math.min(1, Math.max(0, (-rect.top) / (h * 0.72)));
      var blur = (progress * 18).toFixed(2);
      var opacity = (1 - progress * 0.92).toFixed(3);
      var scale = (1 + progress * 0.08).toFixed(4);
      var lift = (-progress * 48).toFixed(1);
      visuals.style.filter = 'blur(' + blur + 'px)';
      visuals.style.opacity = opacity;
      visuals.style.transform = 'translate3d(0,' + lift + 'px,0) scale(' + scale + ')';
    }
    function onScroll() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(paint);
    }
    paint();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
  });
