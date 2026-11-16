"use strict";
// The relative and show-origin attributes and properties of <embeddings-tumbler> (task t11).
// The shell only forwards the setting to the handle and reflects it back.
const test = require("node:test");
const assert = require("node:assert");
const { makeShellEnv } = require("./helpers/fake-elements.js");

const PAIRS = [
  ["relative", "relative"],
  ["show-origin", "showOrigin"],
];

test("both attributes are watched", () => {
  const env = makeShellEnv();
  const watched = env.root.customElements.get("embeddings-tumbler").observedAttributes;
  assert.ok(watched.includes("relative") && watched.includes("show-origin"));
});

test("off by default: the properties are false and mount gets false", () => {
  const env = makeShellEnv();
  const el = env.connect(env.create());
  assert.strictEqual(el.relative, false);
  assert.strictEqual(el.showOrigin, false);
  assert.ok(!("relative" in env.calls.mount[0][1]) && !("showOrigin" in env.calls.mount[0][1]));
  assert.deepStrictEqual(plain(el.handle.relativeSettings()), { relative: false, showOrigin: false, rest: "bright" });
});

function plain(v) {
  return JSON.parse(JSON.stringify(v));
}

test("attributes present before mount are mount options; \"false\" is off", () => {
  const env = makeShellEnv();
  const el = env.connect(env.create({ relative: "", "show-origin": "false" }));
  assert.strictEqual(env.calls.mount[0][1].relative, true);
  assert.ok(!("showOrigin" in env.calls.mount[0][1]));
  assert.strictEqual(el.relative, true);
  assert.strictEqual(el.showOrigin, false);
  assert.deepStrictEqual(plain(el.handle.relativeSettings()), { relative: true, showOrigin: false, rest: "bright" });
});

for (const [attr, prop] of PAIRS) {
  const key = prop;
  const other = prop === "relative" ? "showOrigin" : "relative";

  test(attr + ": setting and removing the attribute reaches the handle and the property", () => {
    const env = makeShellEnv();
    const el = env.connect(env.create());
    el.setAttribute(attr, "");
    assert.strictEqual(el[prop], true);
    assert.strictEqual(el.handle.relativeSettings()[key], true);
    assert.strictEqual(el.handle.relativeSettings()[other], false, "the other setting is untouched");
    el.setAttribute(attr, "false");
    assert.strictEqual(el[prop], false);
    assert.strictEqual(el.handle.relativeSettings()[key], false);
    el.setAttribute(attr, "yes");
    assert.strictEqual(el.handle.relativeSettings()[key], true);
    el.removeAttribute(attr);
    assert.strictEqual(el[prop], false);
    assert.strictEqual(el.handle.relativeSettings()[key], false);
  });

  test(attr + ": setting the property reaches the handle and reflects to the attribute", () => {
    const env = makeShellEnv();
    const el = env.connect(env.create());
    el[prop] = true;
    assert.strictEqual(el.getAttribute(attr), "");
    assert.strictEqual(el.handle.relativeSettings()[key], true);
    el[prop] = false;
    assert.strictEqual(el.getAttribute(attr), null);
    assert.strictEqual(el.handle.relativeSettings()[key], false);
    el[prop] = "truthy";
    assert.strictEqual(el[prop], true);
    el.setAttribute(attr, "false");
    el[prop] = true;
    assert.strictEqual(el.getAttribute(attr), "", "true over a false attribute makes it present");
    assert.strictEqual(el.handle.relativeSettings()[key], true);
  });

  test(attr + ": a property set before the element connects is a mount option and an attribute", () => {
    const env = makeShellEnv();
    const el = env.create();
    el[prop] = true;
    assert.strictEqual(el.getAttribute(attr), "");
    assert.strictEqual(env.calls.mount.length, 0);
    env.connect(el);
    assert.strictEqual(env.calls.mount[0][1][key], true);
    assert.strictEqual(el.handle.relativeSettings()[key], true);
  });

  test(attr + ": a change after mount calls handle.setRelative with that key only", () => {
    const env = makeShellEnv();
    const el = env.connect(env.create());
    const seen = [];
    const real = el.handle.setRelative;
    el.handle.setRelative = (patch) => (seen.push(plain(patch)), real(patch));
    el[prop] = true;
    el.removeAttribute(attr);
    assert.deepStrictEqual(seen, [{ [key]: true }, { [key]: false }]);
    assert.strictEqual(env.calls.mount.length, 1, "no remount");
  });

  test(attr + ": the setting survives a move of the element", () => {
    const env = makeShellEnv();
    const el = env.connect(env.create());
    el[prop] = true;
    env.disconnect(el);
    env.connect(el);
    assert.strictEqual(env.calls.mount[1][1][key], true);
    assert.strictEqual(el.handle.relativeSettings()[key], true);
  });
}

test("changing an attribute while disconnected is kept for the next mount", () => {
  const env = makeShellEnv();
  const el = env.connect(env.create());
  env.disconnect(el);
  el.relative = true;
  env.connect(el);
  assert.strictEqual(env.calls.mount[1][1].relative, true);
  assert.strictEqual(el.handle.relativeSettings().relative, true);
});

// ---------- t19 (deviation d6): relative-rest ----------

test("relative-rest: watched; absent is bright and passes no mount option", () => {
  const env = makeShellEnv();
  assert.ok(env.root.customElements.get("embeddings-tumbler").observedAttributes.includes("relative-rest"));
  const el = env.connect(env.create());
  assert.strictEqual(el.relativeRest, "bright");
  assert.ok(!("relativeRest" in env.calls.mount[0][1]));
  assert.strictEqual(el.handle.relativeSettings().rest, "bright");
});

test("relative-rest: an attribute before mount is the mount option; changes reach the handle; unknown is ignored", () => {
  const env = makeShellEnv();
  const el = env.connect(env.create({ "relative-rest": "faint" }));
  assert.strictEqual(env.calls.mount[0][1].relativeRest, "faint");
  assert.strictEqual(el.relativeRest, "faint");
  assert.strictEqual(el.handle.relativeSettings().rest, "faint");
  el.setAttribute("relative-rest", "visible");
  assert.strictEqual(el.handle.relativeSettings().rest, "visible");
  el.relativeRest = "bright";
  assert.strictEqual(el.getAttribute("relative-rest"), "bright");
  assert.strictEqual(el.handle.relativeSettings().rest, "bright");
  el.relativeRest = "dazzling";
  assert.strictEqual(el.getAttribute("relative-rest"), "bright", "an unknown value is ignored");
  el.setAttribute("relative-rest", "faint");
  el.removeAttribute("relative-rest");
  assert.strictEqual(el.relativeRest, "bright");
  assert.strictEqual(el.handle.relativeSettings().rest, "bright", "removed: the default");
  // a property set before connecting
  const other = env.create();
  other.relativeRest = "visible";
  env.connect(other);
  assert.strictEqual(env.calls.mount.at(-1)[1].relativeRest, "visible");
});
