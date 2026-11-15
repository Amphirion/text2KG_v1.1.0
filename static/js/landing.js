/* ==========================================================================
   Landing Page · 轻量交互
   1. 渲染统一线性图标
   2. 锚点滚动（避开 sticky 导航）
   3. 首屏渐入与滚动出现（尊重 prefers-reduced-motion）
   ========================================================================== */

(function () {
  'use strict';

  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  document.documentElement.style.scrollPaddingTop = '84px';

  /* 滚动时给常驻导航加一层极轻的阴影/加深底色，强化层次 */
  var siteNav = document.querySelector('.site-nav');
  if (siteNav) {
    var navTicking = false;
    var syncNav = function () {
      siteNav.classList.toggle('is-scrolled', window.scrollY > 8);
      navTicking = false;
    };
    syncNav();
    window.addEventListener('scroll', function () {
      if (navTicking) return;
      navTicking = true;
      window.requestAnimationFrame(syncNav);
    }, { passive: true });
  }

  if (window.Icons) {
    window.Icons.render(document);
  }

  /* 首屏内容淡入 */
  var heroPieces = document.querySelectorAll(
    '.hero__eyebrow, .hero__title, .hero__subtitle, .hero__actions, .hero__note'
  );
  heroPieces.forEach(function (el, index) {
    if (reduceMotion) return;
    el.style.opacity = '0';
    el.style.transform = 'translateY(10px)';
    el.style.transition = 'opacity 520ms cubic-bezier(.4,0,.2,1), transform 520ms cubic-bezier(.4,0,.2,1)';
    el.style.transitionDelay = (90 * index) + 'ms';
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';
      });
    });
  });

  /* 滚动出现 */
  var revealItems = document.querySelectorAll('.reveal');
  if (reduceMotion || !('IntersectionObserver' in window)) {
    revealItems.forEach(function (el) { el.classList.add('is-visible'); });
    return;
  }

  var observer = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      var siblings = Array.prototype.slice.call(
        entry.target.parentElement.querySelectorAll(':scope > .reveal')
      );
      var delay = Math.max(0, siblings.indexOf(entry.target)) * 90;
      entry.target.style.transitionDelay = delay + 'ms';
      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });

  revealItems.forEach(function (el) { observer.observe(el); });
})();
