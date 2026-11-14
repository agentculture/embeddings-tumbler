"use strict";
// The order Array#sort uses when it is given no compare function, for strings: by UTF-16
// code units (not by locale). Tests pass it explicitly so the intent is visible.
function byCodeUnits(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

module.exports = { byCodeUnits };
