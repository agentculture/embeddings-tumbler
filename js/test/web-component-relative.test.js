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
  assert.deepStrictEqual(plain(el.handle.relativeSettings()), { relative: false, showOrigin: false });
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
  assert.deepStrictEqual(plain(el.handle.relativeSettings()), { relative: true, showOrigin: false });
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

// ---------- t22 (deviation d9): relative-rest is gone ----------

test("relative-rest is not watched, relativeRest is no property, and neither reaches the viewer", () => {
  const env = makeShellEnv();
  const cls = env.root.customElements.get("embeddings-tumbler");
  assert.deepStrictEqual(Array.from(cls.observedAttributes), ["src", "mode", "seed", "relative", "show-origin"]);
  assert.ok(!("relativeRest" in cls.prototype));
  // An attribute left in old markup: mounted as if it were not there.
  const el = env.connect(env.create({ relative: "", "relative-rest": "faint" }));
  assert.ok(!("relativeRest" in env.calls.mount[0][1]));
  assert.ok(!("rest" in env.calls.mount[0][1]));
  assert.deepStrictEqual(plain(el.handle.relativeSettings()), { relative: true, showOrigin: false });
  const count = () => [env.calls.mount.length, env.calls.update.length, env.calls.destroy.length];
  const before = count();
  let told = 0;
  const setRelative = el.handle.setRelative;
  el.handle.setRelative = (patch) => {
    told++;
    return setRelative(patch);
  };
  el.setAttribute("relative-rest", "visible");
  el.removeAttribute("relative-rest");
  // A plain property a host sets is its own business: it reflects to nothing.
  el.relativeRest = "faint";
  assert.strictEqual(el.getAttribute("relative-rest"), null);
  assert.deepStrictEqual(count(), before, "no call to the core");
  assert.strictEqual(told, 0, "and none to the handle");
  el.showOrigin = true; // the spy does see a setting the shell still forwards
  assert.strictEqual(told, 1);
  assert.deepStrictEqual(plain(el.handle.relativeSettings()), { relative: true, showOrigin: true });
});

// ---------- review of pull request 13, finding 2: the viewer's setting is reflected back ----------

// Tick or untick one of the panel's two checkboxes, as a visitor does.
function tick(el, cls, on) {
  const box = el.querySelector("." + cls).querySelector("input");
  box.checked = on;
  box.dispatchEvent({ type: "change" });
}

const BOXES = { relative: "tumbler-search-relative", "show-origin": "tumbler-search-origin" };

for (const [attr, prop] of PAIRS) {
  const key = prop;

  test("review 2: " + attr + ": the panel's checkbox is reflected to the attribute and the property", () => {
    const env = makeShellEnv();
    const el = env.connect(env.create());
    tick(el, BOXES[attr], true);
    assert.strictEqual(el.handle.relativeSettings()[key], true, "the checkbox reached the viewer");
    assert.strictEqual(el[prop], true);
    assert.strictEqual(el.getAttribute(attr), "");
    tick(el, BOXES[attr], false);
    assert.strictEqual(el[prop], false);
    assert.strictEqual(el.getAttribute(attr), null);
  });

  test("review 2: " + attr + ": handle.setRelative is reflected, and the host can then turn it off by the property", () => {
    const env = makeShellEnv();
    const el = env.connect(env.create());
    el.handle.setRelative({ [key]: true });
    assert.strictEqual(el[prop], true);
    assert.strictEqual(el.getAttribute(attr), "");
    el[prop] = false;
    assert.strictEqual(el.handle.relativeSettings()[key], false, "setting the property takes effect");
    assert.strictEqual(el.getAttribute(attr), null);
    assert.strictEqual(el[prop], false);
  });

  test("review 2: " + attr + ": reflecting calls the viewer once, with no loop and no remount", () => {
    const env = makeShellEnv();
    const el = env.connect(env.create());
    let told = 0;
    const real = el.handle.setRelative;
    el.handle.setRelative = (patch) => (told++, real(patch));
    el.handle.setRelative({ [key]: true });
    assert.strictEqual(told, 1, "the reflected attribute is not sent back to the viewer");
    el[prop] = false;
    assert.strictEqual(told, 2);
    el.setAttribute(attr, "false"); // off written another way: nothing to tell
    el.handle.setRelative({ [key]: true });
    assert.strictEqual(el.getAttribute(attr), "", "on over a \"false\" attribute makes it present");
    assert.strictEqual(env.calls.mount.length, 1);
    assert.strictEqual(env.calls.update.length, 0);
  });

  test("review 2: " + attr + ": an attribute of \"false\" is left as it is while the viewer is off", () => {
    const env = makeShellEnv();
    const el = env.connect(env.create({ [attr]: "false" }));
    const other = attr === "relative" ? "showOrigin" : "relative";
    el.handle.setRelative({ [other]: true }); // a report in which this setting is still off
    assert.strictEqual(el.getAttribute(attr), "false");
    assert.strictEqual(el[prop], false);
  });
}

test("review 2: a viewer that was destroyed no longer writes to the element", () => {
  const env = makeShellEnv();
  const el = env.connect(env.create());
  const report = env.calls.mount[0][1].onSearchChange;
  assert.strictEqual(typeof report, "function", "the shell listens to the viewer's report");
  env.disconnect(el);
  report({ relative: { relative: true, showOrigin: true } });
  assert.strictEqual(el.getAttribute("relative"), null);
  env.connect(el);
  report({ relative: { relative: true, showOrigin: true } }); // the old viewer's report
  assert.strictEqual(el.relative, false);
  // a report without the two booleans changes nothing
  const now = env.calls.mount[1][1].onSearchChange;
  now(null);
  now({});
  now({ relative: { relative: "1", showOrigin: 1 } });
  assert.strictEqual(el.relative, false);
  assert.strictEqual(el.showOrigin, false);
});
