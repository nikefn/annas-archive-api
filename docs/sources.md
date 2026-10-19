# Sources

What each source holds, what it needs, and how to set it up. `litfetch sources`
shows which ones are active. Settings go in `.env` (see `.env.example`).
litfetch spaces its own requests per host (pace table in `src/config.js`); the
last column gives each service's published limit.

| id | Holds | Searches by | Needs | Published limit | Default |
| --- | --- | --- | --- | --- | --- |
| `web` | any URL, and the page a DOI resolves to; metadata and PDF link from `citation_*` meta tags; PDF URLs that follow from the DOI for Springer, Wiley, Taylor & Francis and SAGE | URL, DOI | nothing | none | on |
| `crossref` | DOI metadata, retraction notices, PDFs of openly licensed articles | DOI, citation | `LITFETCH_EMAIL` recommended | 5/s per record, 1/s for searches; 10/s and 3/s with an email | on |
| `openalex` | 250M works with open-access locations and retraction flags | DOI, PMID, PMCID, title | `OPENALEX_API_KEY` | $1 of requests a day with a free key | on |
| `unpaywall` | legal open-access copies of a DOI | DOI | `LITFETCH_EMAIL` | 100,000 a day | on |
| `openlibrary` | book metadata with ISBN lists; scans of public-domain books | ISBN, title | nothing | none | on |
| `arxiv` | preprints in physics, mathematics, computer science and nearby fields | arXiv ID, title | nothing | 1 request per 3 s | on |
| `europepmc` | life sciences; open-access PDFs from PubMed Central | DOI, PMID, PMCID, title | nothing | none | on |
| `semanticscholar` | 200M+ papers with open-access PDF links | DOI, arXiv ID, PMID, title | `SEMANTIC_SCHOLAR_API_KEY` optional | shared anonymous pool; 1/s with a key | on |
| `core` | full texts from repositories: papers, theses, reports | DOI, arXiv ID, title | `CORE_API_KEY` optional | 5 per 10 s without a key | on |
| `hal` | French open archive: papers, theses, reports | DOI, title | nothing | none | on |
| `zenodo` | reports, deliverables and preprints, with md5 sums | DOI, title | nothing | 30 a minute | on |
| `worldbank` | World Bank documents and reports | title | nothing | none | on |
| `dspace` | DSpace 7+ repositories: WHO IRIS, World Bank and FAO Open Knowledge, universities | DOI, title | `DSPACE_REPOSITORIES` (has defaults) | none | on |
| `unods` | official UN documents | `symbol: A/RES/70/1` | nothing | none | on |
| `cellar` | EU law, the Official Journal and EU publications | `celex: 32016R0679` | nothing | none | on |
| `openaire` | EU research graph: publications, project reports and deliverables | DOI, title | nothing | 60 an hour without an account | opt-in |
| `annas` | Anna's Archive: books, papers, magazines | DOI, ISBN, md5, title | `ANNAS_KEY` (paid membership) | daily download credits | opt-in |
| `libgen` | Library Genesis: books, papers | DOI, ISBN, md5, title | nothing | none | opt-in |

To opt in, add the id to `LITFETCH_SOURCES`. The order of that list is the
priority for metadata and files.

## Contact email

`LITFETCH_EMAIL`: an address you read. Unpaywall refuses requests without one,
and Crossref serves requests with one from a faster pool. No sign-up.

## OpenAlex

`OPENALEX_API_KEY`, free, required since February 2026.

1. Create an account at <https://openalex.org>.
2. Copy the key from <https://openalex.org/settings/api>.

The free key comes with a daily budget of $1. Looking up a single record, such
as a DOI, costs nothing; a search costs $0.001, so 1,000 title searches a day
fit in the budget.

## Semantic Scholar

`SEMANTIC_SCHOLAR_API_KEY`, free, optional.

1. Use "Request API key" at <https://www.semanticscholar.org/product/api>.
2. Describe the use and the expected volume. The key arrives by email after a
   manual review.

Without a key, requests share one anonymous pool and are often refused with 429.

## CORE

`CORE_API_KEY`, free for individuals and public research, optional.

1. Register at <https://core.ac.uk/services/api>.
2. The key arrives by email.

Commercial use needs a licence from CORE.

## DSpace repositories

`DSPACE_REPOSITORIES`: comma-separated base URLs of DSpace 7 or later sites,
by default WHO IRIS, World Bank Open Knowledge and FAO Open Knowledge. A site
qualifies if `<base>/server/api/discover/search/objects?query=test` returns
JSON. Public items need no account.

## Anna's Archive

`ANNAS_KEY`, paid; `ANNAS_MIRRORS` lists the domains the key may be sent to.

1. Register at `/account/` on a current domain. In October 2026 those were
   `annas-archive.gl`, `.pk` and `.gd`; `.org`, `.li`, `.se` and `.pm` had been
   lost and must not be used.
2. The key is shown once. It is the whole login, so keep it like a password.

Search results, file records (name, size, content type, IPFS IDs) and SciDB
pages for DOIs are free. litfetch tries the free routes first: SciDB, then up
to three IPFS gateways (`IPFS_GATEWAYS`), then a credited link, at most
`ANNAS_MAX_PER_WORK` per work and run. With no credits left it stops asking,
and the works wait until the credits return.

## Library Genesis

`LIBGEN_MIRRORS`: no account. The `libgen.li` family (`.li`, `.vg`, `.gl`,
`.bz`, `.la`) works; the older `.rs`, `.is` and `.st` mirrors no longer answer
reliably. The mirror that answered last is tried first.

## Model triage

`ANTHROPIC_API_KEY` and `LITFETCH_LLM_MODELS`, pay-per-use, off by default.
Create a key at <https://console.anthropic.com>. What triage does and what it
sends is described in the README under "Quality checks".

## Not used, and why

| Source | Reason, or what to use instead |
| --- | --- |
| UN Digital Library | answers scripts with an AWS WAF challenge; `unods` fetches the same documents by symbol |
| EUR-Lex | the same challenge; `cellar` serves the same CELEX documents |
| BASE (Bielefeld) | needs a key and an approved IP address, for non-commercial use only |
| ReliefWeb | accepts only approved application names since November 2025 |
| govinfo.gov, Congress.gov | need an api.data.gov key, and searching takes POST requests; their PDF links work through `web` |
| OECD, IMF, UNESCO, ILO, UNHCR, UNDP, SSRN | no public search API; their landing pages usually work through `web` |
| OAI-PMH endpoints | a harvesting protocol without search; repositories that offer it usually also have a DSpace, EPrints or HAL search |
| DOAJ | links to landing pages; Unpaywall and OpenAlex already cover open-access journals |
| Sci-Hub | adds nothing new since 2020 and is blocked in several countries; Anna's Archive and Library Genesis serve its files by DOI |
| Zotero Web API | `litfetch export` writes RIS with file paths, which Zotero desktop imports with the files attached (File, Import) |
