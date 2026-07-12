(function () {
  "use strict";

  var prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var targets = document.querySelectorAll(
    ".wcard, .cv-section, .writeup-infobox, .writeup-body > h2, .writeup-body > h3, " +
    ".writeup-body > p, .writeup-body > ul, .writeup-body > ol, .writeup-body > pre, " +
    ".writeup-body > blockquote, .writeup-body > table, .writeup-body > img"
  );

  if (prefersReduced || !("IntersectionObserver" in window)) {
    targets.forEach(function (el) { el.classList.add("in-view"); });
    return;
  }

  targets.forEach(function (el, i) {
    el.classList.add("reveal");
    el.style.transitionDelay = Math.min(i % 4, 3) * 60 + "ms";
  });

  var observer = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in-view");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: "0px 0px -40px 0px" }
  );

  targets.forEach(function (el) { observer.observe(el); });
})();
