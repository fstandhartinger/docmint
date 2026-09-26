/* Theme toggle for the public pages. The inline script in <head> applies a
   stored choice before first paint; this only handles the button. */
(function () {
  var btn = document.getElementById('themeToggle');
  if (!btn) return;
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  function current() {
    var t = root.getAttribute('data-theme');
    if (t === 'light' || t === 'dark') return t;
    return mq && mq.matches ? 'dark' : 'light';
  }
  function label() {
    var next = current() === 'dark' ? 'light' : 'dark';
    btn.setAttribute('aria-label', 'Switch to ' + next + ' theme');
    btn.setAttribute('title', 'Switch to ' + next + ' theme');
  }
  btn.addEventListener('click', function () {
    var next = current() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('mint-theme', next); } catch (e) { /* private mode */ }
    label();
  });
  if (mq && mq.addEventListener) mq.addEventListener('change', label);
  label();
})();
