// Test-only embed callback for the search host fixtures (tests/browser/fixtures/). NOT shipped.
//
// window.__searchEmbed(text) is what a host's embed callback is told to be
// (docs/search-interface.md, "Callback contracts"): it asks the page's OWN server for the
// answer and returns { vector, model }. Here the "server" is a file the test writes beside
// the page, search-queries.json, a table from query text to the answer; its address is fixed,
// so no text typed into a search is ever put in a request. A text the table does not hold
// makes the callback throw, as a failing embedder would. Every call is recorded in
// window.__searchCalls.
(function () {
  "use strict";
  const TABLE_FILE = "search-queries.json";
  const calls = (window.__searchCalls = []);
  window.__searchEmbed = async function (text) {
    calls.push(text);
    const res = await fetch(TABLE_FILE, { cache: "no-store" });
    if (!res.ok) throw new Error(TABLE_FILE + ": " + res.status);
    const table = await res.json();
    const entry = Object.hasOwn(table.queries, text) ? table.queries[text] : null;
    if (!entry) throw new Error("the table holds no answer for this text");
    return { vector: entry.vector, model: entry.model };
  };
})();
