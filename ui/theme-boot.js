// Set the theme class on <html> before first paint (external file: the CSP allows no inline script).
(function () {
  var t = 'fusion-theme';
  try {
    if (localStorage.getItem('fmv.theme') === 'dark') t = 'dark-theme';
  } catch (e) {}
  document.documentElement.className = t;
})();
