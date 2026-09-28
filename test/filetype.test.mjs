import { test } from "node:test";
import assert from "node:assert/strict";

import { sniffFile, withExtension } from "../lib/filetype.js";

const bytes = (s) => Buffer.from(s, "latin1");

test("identifies book formats from their magic bytes", () => {
  assert.equal(sniffFile(bytes("%PDF-1.7\n...")).ext, "pdf");
  assert.equal(sniffFile(bytes("PK\x03\x04" + "\0".repeat(26) + "mimetypeapplication/epub+zip")).ext, "epub");
  assert.equal(sniffFile(bytes("PK\x03\x04" + "\0".repeat(26) + "other.txt")).ext, "zip");
  assert.equal(sniffFile(bytes("\0".repeat(60) + "BOOKMOBI")).ext, "mobi");
  assert.equal(sniffFile(bytes("AT&TFORM\0\0")).ext, "djvu");
  assert.equal(sniffFile(bytes('<?xml version="1.0"?><FictionBook>')).ext, "fb2");
});

test("flags error pages and empty files as invalid", () => {
  assert.equal(sniffFile(bytes("<!DOCTYPE html><html>")).valid, false);
  assert.equal(sniffFile(bytes('{"error":"No downloads left"}')).valid, false);
  assert.equal(sniffFile(Buffer.alloc(0)).valid, false);
});

test("withExtension replaces a known extension or appends one", () => {
  assert.equal(withExtension("Book.pdf", "epub"), "Book.epub");
  assert.equal(withExtension("Vol. I", "pdf"), "Vol. I.pdf");
  assert.equal(withExtension("abc123", "mobi"), "abc123.mobi");
});
