// litfetch web UI: search Anna's Archive through this server, download or queue a result.
// Settings live in localStorage. The page builds its DOM with textContent only.

const $ = (id) => document.getElementById(id);
const store = {
  get: (name) => localStorage.getItem(`litfetch.${name}`) || "",
  set: (name, value) => (value ? localStorage.setItem(`litfetch.${name}`, value) : localStorage.removeItem(`litfetch.${name}`)),
};
const SETTINGS = ["key", "tld", "token"];

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter(Boolean));
  return node;
}

function setStatus(text, isError = false) {
  $("status").textContent = text;
  $("status").className = isError ? "error" : "";
}

async function api(path, options = {}) {
  const resp = await fetch(path, options);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw Object.assign(new Error(data.error || `HTTP ${resp.status}`), { status: resp.status });
  return data;
}

const keyHeader = () => (store.get("key") ? { Authorization: `Bearer ${store.get("key")}` } : {});
const withMirror = (params) => (store.get("tld") ? { ...params, tld: store.get("tld") } : params);

const formatSize = (bytes) => (bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : "");

function card(book) {
  const meta = [book.format?.toUpperCase(), formatSize(book.size), book.downloads != null && `${book.downloads} downloads`]
    .filter(Boolean)
    .join(" · ");
  const download = el("button", { type: "button", textContent: "Download" });
  download.addEventListener("click", () => fetchLink(book, download));
  const queue = el("button", { type: "button", textContent: "Queue" });
  queue.addEventListener("click", () => addToQueue(book, queue));
  return el(
    "li",
    {},
    book.cover_url ? el("img", { src: book.cover_url, alt: "", loading: "lazy", referrerPolicy: "no-referrer" }) : el("img", { alt: "" }),
    el(
      "div",
      { className: "body" },
      el("a", { className: "title", href: book.url, target: "_blank", rel: "noopener noreferrer", textContent: book.title || "Untitled" }),
      book.author && el("div", { textContent: book.author }),
      el("div", { className: "meta", textContent: meta }),
      el("div", { className: "actions" }, download, queue)
    )
  );
}

async function search(event) {
  event.preventDefault();
  $("results").replaceChildren();
  setStatus("Searching...");
  try {
    const params = new URLSearchParams(withMirror({ query: $("query").value.trim(), limit: $("limit").value }));
    const data = await api(`/api/search?${params}`, { headers: keyHeader() });
    $("results").replaceChildren(...data.results.map(card));
    setStatus(data.count ? `${data.count} results` : "No results.");
  } catch (err) {
    setStatus(err.message, true);
    if (err.status === 401) $("settings").hidden = false;
  }
}

async function fetchLink(book, button) {
  button.disabled = true;
  try {
    const data = await api(`/api/download?${new URLSearchParams(withMirror({ md5: book.md5 }))}`, { headers: keyHeader() });
    window.open(data.download_url, "_blank", "noopener");
    button.textContent = "Download";
  } catch (err) {
    button.textContent = err.message.slice(0, 40);
    button.classList.add("error");
  } finally {
    button.disabled = false;
  }
}

async function addToQueue(book, button) {
  button.disabled = true;
  try {
    const data = await api("/api/queue", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Litfetch-Token": store.get("token") },
      body: JSON.stringify({ input: `md5:${book.md5}`, title: book.title || undefined, authors: book.author ? [book.author] : undefined }),
    });
    button.textContent = data.created ? "Queued" : "Already queued";
  } catch (err) {
    button.textContent = err.message.slice(0, 40);
    button.classList.add("error");
    button.disabled = false;
  }
}

$("search").addEventListener("submit", search);
$("settings-toggle").addEventListener("click", () => ($("settings").hidden = !$("settings").hidden));
$("save").addEventListener("click", () => {
  for (const name of SETTINGS) store.set(name, $(name).value.trim());
  $("settings").hidden = true;
});
for (const name of SETTINGS) $(name).value = store.get(name);
