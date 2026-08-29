(function () {
  // Copy buttons.
  document.querySelectorAll('.code .copy').forEach(function (b) {
    b.addEventListener('click', function () {
      var code = b.parentElement.querySelector('code');
      if (!code || !navigator.clipboard) return;
      navigator.clipboard.writeText(code.innerText).then(function () {
        b.textContent = 'Copied';
        setTimeout(function () { b.textContent = 'Copy'; }, 1400);
      });
    });
  });

  // Collapsible contents on narrow screens.
  var toggle = document.getElementById('tocToggle');
  var body = document.getElementById('tocBody');
  function narrow() { return window.matchMedia('(max-width: 960px)').matches; }
  function sync() {
    if (narrow()) {
      body.hidden = toggle.getAttribute('aria-expanded') !== 'true';
    } else {
      body.hidden = false;
    }
  }
  toggle.addEventListener('click', function () {
    toggle.setAttribute('aria-expanded', toggle.getAttribute('aria-expanded') === 'true' ? 'false' : 'true');
    sync();
  });
  window.addEventListener('resize', sync);
  sync();
  body.addEventListener('click', function (e) {
    if (e.target.tagName === 'A' && narrow()) { toggle.setAttribute('aria-expanded', 'false'); sync(); }
  });

  // Highlight the section currently on screen.
  var links = {};
  document.querySelectorAll('.toc a[href^="#"]').forEach(function (a) { links[a.getAttribute('href').slice(1)] = a; });
  var targets = Object.keys(links).map(function (id) { return document.getElementById(id); }).filter(Boolean);
  if ('IntersectionObserver' in window && targets.length) {
    var seen = {};
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { seen[e.target.id] = e.isIntersecting; });
      var active = targets.filter(function (t) { return seen[t.id]; })[0];
      if (!active) return;
      Object.keys(links).forEach(function (id) { links[id].classList.toggle('active', id === active.id); });
    }, { rootMargin: '-72px 0px -70% 0px' });
    targets.forEach(function (t) { io.observe(t); });
  }
})();
