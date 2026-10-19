# Sources

What each source holds, what it needs, and how to set it up. `litfetch sources`
shows which ones are active right now. Settings go in `.env` (see `.env.example`).

## Implemented

| id | Holds | Searches by | Needs | Pace per host | Default |
| --- | --- | --- | --- | --- | --- |
| `web` | Any URL, and the page a DOI resolves to; metadata and PDF link from `citation_*` meta tags, plus DOI-only PDF URLs of Springer, Wiley, Taylor & Francis and SAGE | URL, DOI | none | 1/s | on |
| `crossref` | DOI metadata, retractions, CC-licensed publisher PDFs | DOI, citation | `LITFETCH_EMAIL` recommended | 1/s; about 3/s with email | on |
| `openalex` | 250M works, OA locations, retraction flags | DOI, PMID, PMCID, title | `OPENALEX_API_KEY` | 10/s | on |
| `unpaywall` | Legal OA copies of a DOI | DOI | `LITFETCH_EMAIL` | 10/s, 100k/day | on |
| `arxiv` | Preprints (physics, maths, CS and more) | arXiv id, title | none | 1 per 3 s | on |
| `europepmc` | Life sciences, PMC open-access PDFs | DOI, PMID, PMCID, title | none | 5/s | on |
| `semanticscholar` | 200M+ papers, OA PDF links | DOI, arXiv, PMID, title | `SEMANTIC_SCHOLAR_API_KEY` optional | about 1/s | on |
| `core` | Repository full texts, theses, reports | DOI, arXiv, title | `CORE_API_KEY` optional | 1 per 2 s; 1/s with key | on |
| `hal` | French open archive: papers, theses, reports | DOI, title | none | 2/s | on |
| `zenodo` | Reports, deliverables, preprints (with md5) | DOI, title | none | 30/min | on |
| `worldbank` | World Bank documents and reports | title | none | 2/s | on |
| `dspace` | DSpace 7+ repositories (WHO IRIS, World Bank OKR, FAO, universities) | DOI, title | `DSPACE_REPOSITORIES` | 1/s per repository | on |
| `unods` | Official UN documents | `symbol: A/RES/70/1` | none | 1/s | on |
| `cellar` | EU law, Official Journal, EU publications | `celex: 32016R0679` | none | 1/s | on |
| `openaire` | EU research graph, project reports and deliverables | DOI, title | none | 60/hour anonymous | opt-in |
| `annas` | Anna's Archive: books, papers, magazines | DOI, ISBN, md5, title | `ANNAS_KEY` (paid membership) | 1 per 1.5 s; daily credit quota | opt-in |
| `libgen` | Library Genesis: books, articles | DOI, ISBN, md5, title | none | 1 per 2 s | opt-in |

To opt in, add the id to `LITFETCH_SOURCES`. The order of that list is the
priority for metadata and files. The pace applies to every request to a host,
downloads included; `LITFETCH_PACE` overrides it per host.

## Setting up credentials

**Contact email** (`LITFETCH_EMAIL`): any address you read. Unpaywall rejects
requests without one, and Crossref gives requests with one a faster lane. No
sign-up needed.

**OpenAlex** (`OPENALEX_API_KEY`), free. Required since February 2026.
1. Create an account at <https://openalex.org>.
2. Copy the key from <https://openalex.org/settings/api>.

The free key comes with a daily budget of $1. Single-record lookups such as
DOI lookups cost nothing. A search costs $0.001, so 1,000 title searches a day
fit in the budget.

**Semantic Scholar** (`SEMANTIC_SCHOLAR_API_KEY`), free and optional.
1. Use "Request API key" at <https://www.semanticscholar.org/product/api>.
2. Describe your use and the volume you expect. The key arrives by email after
   a manual review.

Without a key, requests share one anonymous pool and often get rate-limited.

**CORE** (`CORE_API_KEY`), free for individuals and public research, optional.
1. Register at <https://core.ac.uk/services/api>.
2. The key arrives by email.

Without a key you get 5 requests per 10 seconds. Commercial use needs a
licence from CORE.

**DSpace repositories** (`DSPACE_REPOSITORIES`): a comma-separated list of base
URLs of DSpace 7 or later sites. A site qualifies if
`<base>/server/api/discover/search/objects?query=test` returns JSON. No
account needed for public items.

**Anna's Archive** (`ANNAS_KEY`, `ANNAS_MIRRORS`), paid.
1. Register at `/account/` on a current mirror. Live domains as of October
   2026: `annas-archive.gl`, `.pk` and `.gd`. The `.org`, `.li`, `.se` and
   `.pm` domains were lost and must not be used.
2. The secret key is shown once. It is the whole login, so store it like a
   password.
3. Buy a membership at `/donate`. Fast downloads per day by tier: 25, 50, 200
   or 1000. A link uses quota when it is issued, not when the file is fetched,
   and used quota returns over a rolling window (`ANNAS_WINDOW_H`, 18 hours
   for most tiers).

The key is sent only to the mirrors in `ANNAS_MIRRORS`. Search results, file
records (name, size, content type, IPFS ids) and SciDB pages for DOIs cost no
quota. litfetch tries free routes first: SciDB, then up to three IPFS gateways
(`IPFS_GATEWAYS`), and only then a fast-download link, at most
`ANNAS_MAX_PER_WORK` per work and run. When the quota is used up it stops
asking and the works wait for the refill.

**Library Genesis** (`LIBGEN_MIRRORS`): no account. The `libgen.li` family
(`.li`, `.vg`, `.gl`, `.bz`, `.la`) works; the old `.rs`, `.is` and `.st`
mirrors are effectively dead. The mirror that answered last is tried first.

**Model triage** (`ANTHROPIC_API_KEY`, `LITFETCH_LLM_MODELS`), optional and
pay-per-use. Create a key at <https://console.anthropic.com> and list the models
to ask, cheapest first. Triage only runs on files whose identity check warned,
and their opening pages are sent to the Anthropic API.

## Considered, not implemented

| Source | Why not, or how to use it instead |
| --- | --- |
| UN Digital Library (digitallibrary.un.org) | Sends scripts an AWS WAF challenge (HTTP 202). Fetch documents by symbol through `unods`. |
| EUR-Lex | Same WAF challenge. `cellar` serves the same CELEX documents. The SOAP web service needs registration and approval. |
| BASE (Bielefeld) | Needs a key and a whitelisted IP, requested by form, and is limited to non-commercial use. |
| ReliefWeb | Since November 2025 only approved `appname` values are accepted (apply by form). |
| govinfo.gov / Congress.gov | Free api.data.gov key. Searches are POST requests; PDFs are at `govinfo.gov/content/pkg/<id>/pdf/<id>.pdf`. A candidate for a new adapter. |
| OECD, IMF, UNESCO, ILO, UNHCR, UNDP, SSRN | No public search API. A landing-page URL often works through `web` (`citation_*` tags). |
| OAI-PMH endpoints | A harvesting protocol with no search, so it doesn't fit look-up-by-work. Repositories that speak it usually also have a DSpace, EPrints or HAL search API. |
| DOAJ | Its links point to landing pages, and Unpaywall and OpenAlex already cover OA journals. |
| Sci-Hub | Nothing new added since 2020, and blocked in several countries. Anna's Archive and LibGen serve its corpus by DOI. |
| Zotero Web API (pyzotero) | `litfetch export` writes RIS with `L1` file paths. Zotero desktop (File, Import) imports items with their PDFs attached, with no API key needed. |
| Zotero translation-server | Resolves landing pages to metadata. Most repositories already expose `citation_*` tags, which `web` reads. |

## Related open-source tools

| Tool | Language | Notes |
| --- | --- | --- |
| [pyalex](https://github.com/J535D165/pyalex) | Python | OpenAlex client. Covered here by `openalex`. |
| [unpywall](https://github.com/unpywall/unpywall), [roadoi](https://github.com/ropensci/roadoi) | Python, R | Unpaywall clients. Covered here by `unpaywall`. |
| [arxiv.py](https://github.com/lukasschwab/arxiv.py) | Python | arXiv client. Version 4 dropped `download_pdf`; use `pdf_url`. Covered here by `arxiv`. |
| [paperfetcher](https://github.com/paperfetcher/paperfetcher) | Python | Systematic-review search through Crossref and OpenCitations. It produces DOI lists, not PDFs. |
| [libgen-downloader](https://github.com/obsfx/libgen-downloader) | TypeScript | Terminal UI for LibGen with mirror health ranking. |
| [libgen-api-enhanced](https://github.com/onurhanak/libgen-api-enhanced) | Python | Maintained libgen.li wrapper. |
| [pyzotero](https://github.com/urschrei/pyzotero) | Python | Zotero Web API client, now with a CLI. |
| Anna's Archive source code | Python | Hosted on the project's own GitLab (`software.annas-archive.*`). It covers the site, data imports and the bulk AAC metadata format. |
| [legal-sources](https://github.com/worldwidelaw/legal-sources) | Python (AGPL) | Harvesters for the World Bank, UN ODS, WHO IRIS and EU CELLAR. Read it for patterns; its licence restricts copying code. |
