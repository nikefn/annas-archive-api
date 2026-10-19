/**
 * EU Publications Office (CELLAR): EU law, the Official Journal and EU
 * publications, by CELEX number (e.g. "celex: 32016R0679"). Title and date
 * come from the public SPARQL endpoint; the PDF by content negotiation.
 * (EUR-Lex itself answers scripts with a bot challenge; CELLAR serves the same documents.)
 */

import { client } from "../http.js";
import { yearOf } from "./meta.js";

const SPARQL = "https://publications.europa.eu/webapi/rdf/sparql";
const http = client({ minIntervalMs: 1000 });

const titleQuery = (celex) => `
PREFIX cdm: <http://publications.europa.eu/ontology/cdm#>
SELECT ?title ?date WHERE {
  ?work cdm:resource_legal_id_celex "${celex}"^^<http://www.w3.org/2001/XMLSchema#string> .
  OPTIONAL { ?work cdm:work_date_document ?date }
  ?expr cdm:expression_belongs_to_work ?work ;
        cdm:expression_uses_language <http://publications.europa.eu/resource/authority/language/ENG> ;
        cdm:expression_title ?title .
} LIMIT 1`;

export default {
  id: "cellar",
  name: "EU Publications Office (CELLAR)",
  missing: () => [],

  async find(q) {
    if (!q.celex || !/^[0-9A-Z()]+$/.test(q.celex)) return [];
    const meta = { celex: q.celex, publisher: "Publications Office of the European Union" };
    try {
      const params = new URLSearchParams({ query: titleQuery(q.celex), format: "application/sparql-results+json" });
      const row = (await http.json(`${SPARQL}?${params}`)).results?.bindings?.[0];
      meta.title = row?.title?.value;
      meta.year = yearOf(row?.date?.value);
    } catch {
      // Metadata is a bonus; the document itself is fetched either way.
    }
    return [
      {
        meta,
        files: [
          {
            url: `http://publications.europa.eu/resource/celex/${q.celex}`,
            headers: { Accept: "application/pdf", "Accept-Language": "en" },
          },
        ],
      },
    ];
  },
};
