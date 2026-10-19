import * as store from "../../src/store.js";

const MAX_LENGTH = 1000;
const text = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_LENGTH) : undefined);

/** POST { input, title?, authors? }: queue a work for the next `litfetch run`. */
export default async function handler(req, res) {
  const input = text(req.body?.input);
  if (!input) {
    res.status(400).json({ error: "input is required" });
    return;
  }
  const hints = {};
  const title = text(req.body.title);
  const authors = Array.isArray(req.body.authors) ? req.body.authors.map(text).filter(Boolean) : [];
  if (title) hints.title = title;
  if (authors.length) hints.authors = authors;

  try {
    const { work, created } = await store.add(input, hints);
    await store.writeIndex();
    res.status(created ? 201 : 200).json({ id: work.id, status: work.status, created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}
