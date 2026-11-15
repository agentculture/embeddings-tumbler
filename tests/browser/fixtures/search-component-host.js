// Search host fixture 2: the web-component form. The one assignment that adds search: the
// element's embed property is set to the embed callback of search-embed.js, which asks this
// page's own server. Nothing else is done here; the element loads its own data.
(function () {
  "use strict";
  document.getElementById("space").embed = window.__searchEmbed;
})();
