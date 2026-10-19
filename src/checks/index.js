/**
 * Check one downloaded file: read it, apply the rules, and let model triage
 * settle an uncertain identity check when enabled.
 */

import { readDocument } from "./file.js";
import { confirmIdentity } from "./llm.js";
import { evaluate, verdictOf } from "./rules.js";

/**
 * @param path        file on disk
 * @param file        { md5, sha256, bytes } from the download
 * @param expected    the candidate file entry (may carry a reference md5)
 * @param meta        merged metadata of the work
 * @param kind        "book", "article", "report" or "other"
 * @param language    ISO 639-1 code the work must be in, or undefined
 * @param candidates  everything the sources returned for the work
 * @param duplicates  Map sha256 -> id of another work holding that file
 */
export async function checkFile({ path, file, expected, meta, kind, language, candidates, duplicates }) {
  const doc = await readDocument(path);
  const ctx = { doc, file, expected, meta, kind, language, candidates, duplicates };
  const checks = evaluate(ctx);

  const identity = checks.find((c) => c.name === "identity");
  if (identity?.status === "warn" && doc.pageTexts.length) {
    const opening = [doc.title, ...doc.pageTexts].filter(Boolean).join("\n");
    const answer = await confirmIdentity(meta, opening).catch((err) => {
      identity.detail += `; triage error: ${err.message}`;
      return null;
    });
    if (answer && answer.verdict !== "unsure") {
      identity.status = answer.verdict === "match" ? "pass" : "fail";
      identity.detail += `; ${answer.model}: ${answer.verdict} (${answer.reason})`;
    }
  }

  return { checks, verdict: verdictOf(checks), format: doc.format };
}
