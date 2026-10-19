import assert from "node:assert/strict";
import { test } from "node:test";

import { detectLanguage, titleMatch, volumeOf } from "../src/text.js";

test("volume and part numbers, Arabic or Roman, tell works apart", () => {
  assert.equal(volumeOf("The History of Sexuality, Vol. 1"), 1);
  assert.equal(volumeOf("Capital, Volume III"), 3);
  assert.equal(volumeOf("Gesammelte Werke Band 12"), 12);
  assert.equal(volumeOf("Bookkeeping basics"), null);
  assert.equal(titleMatch("The History of Sexuality, Vol. 1", "The History of Sexuality, Vol. 2: The Use of Pleasure"), null);
  assert.equal(titleMatch("Part I", "Part II"), null);
});

test("match tiers", () => {
  assert.equal(titleMatch("Being and Time", "Being and Time: A Translation of Sein und Zeit"), "same");
  assert.equal(titleMatch("Being and Time: A Translation", "Being and Time: Revised Edition"), "other-edition");
  assert.equal(titleMatch("Being and Time", "Basic Writings: Being and Time and Other Essays"), "contained-in");
  assert.equal(titleMatch("Lima A (2020) Groundwater recharge in semi-arid basins. J Hydrol", "Groundwater Recharge in Semi-Arid Basins"), "same");
  assert.equal(titleMatch("Being and Time", "Time and Free Will"), null);
});

test("language detection needs a clear majority", () => {
  assert.equal(detectLanguage("the cat and the dog of the house is in the garden with the owner that was there ".repeat(3)), "en");
  assert.equal(detectLanguage("der Hund und die Katze sind nicht im Haus, das ist mit dem Garten auf der Straße ".repeat(3)), "de");
  assert.equal(detectLanguage("x y z"), null);
});
