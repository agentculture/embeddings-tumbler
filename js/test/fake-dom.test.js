"use strict";
// The fake DOM is what the viewer and shell tests run on, so its modern tree methods must
// behave as a browser's do, and its guard rails must still hold.
const test = require("node:test");
const assert = require("node:assert/strict");
const { makeFakeDom } = require("./helpers/fake-dom.js");

function tree() {
  const dom = makeFakeDom();
  const doc = dom.document;
  const parent = doc.createElement("div");
  const a = doc.createElement("span");
  const b = doc.createElement("span");
  const c = doc.createElement("span");
  a.id = "a";
  b.id = "b";
  c.id = "c";
  parent.append(a, b, c);
  doc.body.appendChild(parent);
  return { dom, doc, parent, a, b, c };
}

const ids = (el) => el.childNodes.map((n) => (n.nodeType === 1 ? n.id : "#" + n.data));

test("remove() detaches an element and is a no-op when detached", () => {
  const { parent, b } = tree();
  b.remove();
  assert.deepEqual(ids(parent), ["a", "c"]);
  assert.equal(b.parentNode, null);
  b.remove();
  assert.equal(b.parentNode, null);
});

test("before(), after() and replaceWith() place nodes and turn strings into text", () => {
  const { doc, parent, a, b, c } = tree();
  const x = doc.createElement("i");
  x.id = "x";
  b.before(x, "t1");
  assert.deepEqual(ids(parent), ["a", "x", "#t1", "b", "c"]);
  b.after(c, "t2");
  assert.deepEqual(ids(parent), ["a", "x", "#t1", "b", "c", "#t2"]);
  a.after(a, b);
  assert.deepEqual(ids(parent), ["a", "b", "x", "#t1", "c", "#t2"]);
  x.replaceWith("y");
  assert.deepEqual(ids(parent), ["a", "b", "#y", "#t1", "c", "#t2"]);
  assert.equal(x.parentNode, null);
  assert.equal(a.nextSibling, b);
  assert.equal(b.previousSibling, a);
  assert.equal(b.nextElementSibling, c);
  assert.equal(c.previousElementSibling, b, "text nodes are skipped");
  assert.equal(a.previousElementSibling, null);
});

test("append(), prepend() and replaceChildren() keep order and move existing nodes", () => {
  const { doc, parent, a, b, c } = tree();
  parent.prepend(c, "t");
  assert.deepEqual(ids(parent), ["c", "#t", "a", "b"]);
  parent.append(c);
  assert.deepEqual(ids(parent), ["#t", "a", "b", "c"]);
  parent.replaceChildren(b, a);
  assert.deepEqual(ids(parent), ["b", "a"]);
  assert.equal(c.parentNode, null);
  parent.replaceChildren();
  assert.equal(parent.childNodes.length, 0);
  assert.equal(a.parentNode, null);
  const frag = doc.createDocumentFragment();
  frag.append(a, b);
  parent.appendChild(frag);
  assert.deepEqual(ids(parent), ["a", "b"]);
  assert.equal(frag.childNodes.length, 0);
});

test("insertBefore() and replaceChild() check the reference node", () => {
  const { doc, parent, a, c } = tree();
  const x = doc.createElement("i");
  x.id = "x";
  assert.equal(parent.insertBefore(x, c), x); // returns the inserted node
  assert.deepEqual(ids(parent), ["a", "b", "x", "c"]);
  assert.throws(() => parent.insertBefore(doc.createElement("i"), doc.body), /not a child/);
  assert.equal(parent.replaceChild(c, a), a); // returns the replaced node
  assert.deepEqual(ids(parent), ["c", "b", "x"]);
  assert.throws(() => a.appendChild(a), /hierarchy/);
});

test("isConnected follows the tree", () => {
  const { doc, b } = tree();
  assert.equal(b.isConnected, true);
  b.remove();
  assert.equal(b.isConnected, false);
  assert.equal(doc.createTextNode("t").isConnected, false);
});

test("dataset reflects data-* attributes both ways", () => {
  const { a } = tree();
  a.dataset.fooBar = 7;
  assert.equal(a.getAttribute("data-foo-bar"), "7");
  a.setAttribute("data-mode-name", "tumble");
  assert.equal(a.dataset.modeName, "tumble");
  assert.ok("modeName" in a.dataset);
  assert.deepEqual(Object.keys(a.dataset), ["fooBar", "modeName"]);
  assert.deepEqual({ ...a.dataset }, { fooBar: "7", modeName: "tumble" });
  delete a.dataset.fooBar;
  assert.equal(a.hasAttribute("data-foo-bar"), false);
  assert.equal(a.dataset.fooBar, undefined);
  assert.equal(a.dataset, a.dataset);
});

test("toggleAttribute() honours force and className / hidden / id reflect attributes", () => {
  const { a } = tree();
  assert.equal(a.toggleAttribute("hidden"), true);
  assert.equal(a.hidden, true);
  assert.equal(a.toggleAttribute("hidden", true), true);
  assert.equal(a.hasAttribute("hidden"), true);
  assert.equal(a.toggleAttribute("hidden"), false);
  assert.equal(a.hidden, false);
  a.hidden = true;
  assert.equal(a.getAttribute("hidden"), "");
  a.className = "p q";
  assert.equal(a.getAttribute("class"), "p q");
  a.setAttribute("class", "r");
  assert.equal(a.className, "r");
  assert.equal(a.getAttribute("id"), "a");
  assert.deepEqual(a.getAttributeNames().sort((x, y) => x.localeCompare(y)), [
    "class",
    "hidden",
    "id",
  ]);
});

test("classList supports several tokens, toggle with force, replace and iteration", () => {
  const { a } = tree();
  a.classList.add("p", "q", "p");
  assert.equal(a.className, "p q");
  assert.equal(a.classList.toggle("r"), true);
  assert.equal(a.classList.toggle("r", true), true);
  assert.equal(a.className, "p q r");
  assert.equal(a.classList.toggle("p"), false);
  assert.equal(a.classList.toggle("q", false), false);
  assert.equal(a.className, "r");
  assert.equal(a.classList.replace("r", "s"), true);
  assert.equal(a.classList.replace("zz", "s"), false);
  a.classList.add("t");
  a.classList.remove("s", "nope");
  assert.deepEqual([...a.classList], ["t"]);
  assert.equal(a.classList.length, 1);
  assert.equal(a.classList.item(0), "t");
  assert.equal(a.classList.contains("t"), true);
});

test("matches(), closest() and #id selectors", () => {
  const { parent, b } = tree();
  parent.className = "box";
  assert.equal(b.matches("#b"), true);
  assert.equal(b.closest(".box"), parent);
  assert.equal(b.closest(".none"), null);
  assert.equal(parent.querySelector("#c").id, "c");
});

test("pointer capture is tracked per pointer id", () => {
  const { a } = tree();
  a.setPointerCapture(3);
  assert.equal(a.hasPointerCapture(3), true);
  a.releasePointerCapture(4);
  assert.equal(a.hasPointerCapture(3), true);
  a.releasePointerCapture(3);
  assert.equal(a.hasPointerCapture(3), false);
});

test("guard rails still hold", () => {
  const { a } = tree();
  assert.throws(() => {
    a.innerHTML = "<b>x</b>";
  }, /innerHTML/);
  assert.throws(() => a.innerHTML, /innerHTML/);
  assert.throws(() => {
    a.outerHTML = "<b>x</b>";
  }, /outerHTML/);
  assert.throws(() => a.insertAdjacentHTML("beforeend", "<b>x</b>"), /insertAdjacentHTML/);
  assert.throws(() => a.setAttribute("style", "color:red"), /style attribute/);
  assert.throws(() => a.toggleAttribute("style"), /style attribute/);
  assert.throws(() => a.toggleAttribute("onclick"), /event-handler/);
  a.append("<b>x</b>");
  assert.equal(a.children.length, 0);
  assert.equal(a.textContent, "<b>x</b>");
});

// One failed equality assertion on two nodes once used more than 40 GB: node printed and
// diffed everything each node reaches. The helper makes such a failure one short line.
test("a failed equality assertion on fake nodes is one short line, for both assert modules", () => {
  const { dom, a, b } = tree();
  // Something large reachable from every node, as the viewer and its vectors are.
  dom.document.body.heavy = Array.from({ length: 2000 }, (_, i) => ({ i, text: "x".repeat(200) }));
  const loose = require("node:assert");
  const started = Date.now();
  for (const mod of [assert, loose]) {
    for (const name of ["equal", "strictEqual", "deepEqual", "deepStrictEqual"]) {
      mod[name](a, a);
      mod[name]([a, b], [a, b]);
      let err = null;
      try {
        mod[name](a, b);
      } catch (e) {
        err = e;
      }
      assert.ok(err instanceof loose.AssertionError, name);
      assert.equal(err.message, "expected <span#b>, got <span#a>");
      assert.equal(err.actual, undefined);
      assert.equal(err.expected, undefined);
      assert.throws(() => mod[name](a, null, "told"), { message: "told (expected null, got <span#a>)" });
      assert.throws(() => mod[name]([a], [b]), { message: "expected [<span#b>], got [<span#a>]" });
    }
    for (const name of ["notEqual", "notStrictEqual", "notDeepEqual", "notDeepStrictEqual"]) {
      mod[name](a, b);
      assert.throws(() => mod[name](a, a), { message: "expected something other than <span#a>" });
    }
  }
  assert.ok(Date.now() - started < 2000);
  // Values that are not nodes go to node's own assertions unchanged.
  assert.throws(() => assert.strictEqual(1, 2), { actual: 1, expected: 2 });
  assert.throws(() => assert.deepStrictEqual({ a: 1 }, { a: 2 }), { code: "ERR_ASSERTION" });
});
