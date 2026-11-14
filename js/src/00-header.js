(function (root) {
  "use strict";

  // Shared internal namespace. Every later module adds its functions here
  // (ET.math = {...}, ET.contract = {...}) and reads earlier modules' from it.
  var ET = {};
  ET.version = "@@VERSION@@";
  // The public API object. Only 50-viewer.js fills this (mount, update, destroy).
  ET.api = {};
