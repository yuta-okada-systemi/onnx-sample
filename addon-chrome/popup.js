const DB_NAME = "GitHubIssueSearchDB";
const DB_VERSION = 1;
const STORE_NAME = "issues";
const SEARCH_DEBOUNCE_MS = 350;
const SEARCH_LIMIT = 10;
const RRF_K = 60;
const TITLE_LEXICAL_WEIGHT = 3;
const BODY_LEXICAL_WEIGHT = 1;
const MAX_LEXICAL_RRF_BOOST = 0.08;
const CHUNK_CHAR_LIMIT = 900;
const CHUNK_OVERLAP = 160;
const BM25_K1 = 1.5;
const BM25_B = 0.75;

const elements = {
  repoInput: document.getElementById("repoInput"),
  tokenInput: document.getElementById("tokenInput"),
  syncButton: document.getElementById("syncButton"),
  clearButton: document.getElementById("clearButton"),
  exportButton: document.getElementById("exportButton"),
  syncStatus: document.getElementById("syncStatus"),
  searchInput: document.getElementById("searchInput"),
  searchStatus: document.getElementById("searchStatus"),
  results: document.getElementById("results"),
  dbCount: document.getElementById("dbCount"),
  resultCount: document.getElementById("resultCount"),
  progressBar: document.getElementById("progressBar"),
  modelStatus: document.getElementById("modelStatus")
};

let searchTimer = null;
let isSyncing = false;

document.addEventListener("DOMContentLoaded", async () => {
  await restoreSettings();
  await refreshIssueCount();

  elements.syncButton.addEventListener("click", handleSync);
  elements.clearButton.addEventListener("click", handleClear);
  elements.exportButton.addEventListener("click", handleExport);
  elements.searchInput.addEventListener("input", handleSearchInput);
  elements.repoInput.addEventListener("change", saveSettings);
  elements.tokenInput.addEventListener("change", saveSettings);
});

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function withStore(mode, callback) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    const result = callback(store);

    transaction.oncomplete = () => {
      db.close();
      resolve(result);
    };
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
    transaction.onabort = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

async function putIssue(issue) {
  return withStore("readwrite", (store) => store.put(issue));
}

async function getAllIssues() {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

async function clearIssues() {
  return withStore("readwrite", (store) => store.clear());
}

async function countIssues() {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.count();

    request.onsuccess = () => resolve(request.result || 0);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => {
      db.close();
      reject(transaction.error);
    };
  });
}

async function restoreSettings() {
  const saved = await chrome.storage.local.get(["repo", "token"]);
  elements.repoInput.value = saved.repo || "";
  elements.tokenInput.value = saved.token || "";
}

async function saveSettings() {
  await chrome.storage.local.set({
    repo: elements.repoInput.value.trim(),
    token: elements.tokenInput.value.trim()
  });
}

async function refreshIssueCount() {
  const count = await countIssues();
  elements.dbCount.textContent = `${count} saved`;
}

function setStatus(element, message, type = "") {
  element.textContent = message;
  element.className = `status${type ? ` ${type}` : ""}`;
}

function setProgress(current, total) {
  if (!total) {
    elements.progressBar.style.width = "0%";
    return;
  }

  const percent = Math.max(0, Math.min(100, Math.round((current / total) * 100)));
  elements.progressBar.style.width = `${percent}%`;
}

function parseRepository(input) {
  const value = input.trim();
  if (!value) {
    throw new Error("Enter a repository.");
  }

  const shorthand = value.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (shorthand) {
    return { owner: shorthand[1], repo: shorthand[2] };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter owner/repo or a GitHub repository URL.");
  }

  if (!/github\.com$/i.test(url.hostname)) {
    throw new Error("Enter a GitHub repository URL.");
  }

  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo) {
    throw new Error("Could not parse owner/repo from the repository URL.");
  }

  return { owner, repo: repo.replace(/\.git$/i, "") };
}
function parseNextLink(linkHeader) {
  if (!linkHeader) {
    return null;
  }

  const links = linkHeader.split(",").map((part) => part.trim());
  for (const link of links) {
    const match = link.match(/^<([^>]+)>;\s*rel="([^"]+)"$/);
    if (match && match[2] === "next") {
      return match[1];
    }
  }

  return null;
}

async function fetchAllIssues(owner, repo, token) {
  const allIssues = [];
  let page = 1;
  let nextUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=all&per_page=100&page=1`;

  while (nextUrl) {
    setStatus(elements.syncStatus, `Fetching page ${page}...`);

    const response = await fetch(nextUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28"
      }
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub API error ${response.status}: ${body || response.statusText}`);
    }

    const pageItems = await response.json();
    allIssues.push(...pageItems.filter((issue) => !issue.pull_request));

    nextUrl = parseNextLink(response.headers.get("Link"));
    page += 1;
  }

  return allIssues;
}

function requestEmbedding(text) {
  elements.modelStatus.textContent = "Model running";

  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "EMBED_TEXT", text }, (response) => {
      elements.modelStatus.textContent = "Model ready";

      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!response?.ok) {
        reject(new Error(response?.error || "Embedding generation failed."));
        return;
      }

      resolve(response.embedding);
    });
  });
}

async function handleSync() {
  if (isSyncing) {
    return;
  }

  isSyncing = true;
  elements.syncButton.disabled = true;
  elements.clearButton.disabled = true;
  elements.exportButton.disabled = true;
  setProgress(0, 0);

  try {
    await saveSettings();
    const { owner, repo } = parseRepository(elements.repoInput.value);
    const token = elements.tokenInput.value.trim();

    if (!token) {
      throw new Error("Enter a GitHub PAT.");
    }

    const issues = await fetchAllIssues(owner, repo, token);
    const total = issues.length;

    if (!total) {
      setStatus(elements.syncStatus, "No issues found.", "success");
      await refreshIssueCount();
      setProgress(0, 0);
      return;
    }

    for (let index = 0; index < total; index += 1) {
      const issue = issues[index];
      const combinedText = `Title: ${issue.title || ""} \n\n Body: ${issue.body || ""}`;
      const labels = (issue.labels || []).map((label) => ({
        name: label.name,
        color: label.color
      }));
      const chunks = buildIssueChunks({
        owner,
        repo,
        issue,
        labels,
        combinedText
      });

      setStatus(
        elements.syncStatus,
        `Embedding issue ${index + 1}/${total}... #${issue.number} (${chunks.length} chunks)`
      );

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        setStatus(
          elements.syncStatus,
          `Embedding issue ${index + 1}/${total}, chunk ${chunkIndex + 1}/${chunks.length}... #${issue.number}`
        );
        chunks[chunkIndex].embedding = await requestEmbedding(chunks[chunkIndex].text);
      }

      await putIssue({
        id: `${owner}/${repo}#${issue.number}`,
        title: issue.title || "",
        html_url: issue.html_url,
        number: issue.number,
        state: issue.state || "",
        labels,
        combined_text: combinedText,
        embedding: chunks[0]?.embedding || [],
        chunks
      });

      setProgress(index + 1, total);
    }

    await refreshIssueCount();
    setStatus(elements.syncStatus, `${total} issues synced.`, "success");
    runSearch();
  } catch (error) {
    setStatus(
      elements.syncStatus,
      error instanceof Error ? error.message : String(error),
      "error"
    );
  } finally {
    isSyncing = false;
    elements.syncButton.disabled = false;
    elements.clearButton.disabled = false;
    elements.exportButton.disabled = false;
  }
}

async function handleExport() {
  try {
    const issues = await getAllIssues();
    const exportedAt = new Date().toISOString();
    const payload = {
      database: DB_NAME,
      store: STORE_NAME,
      exported_at: exportedAt,
      count: issues.length,
      issues
    };
    const json = JSON.stringify(payload, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const timestamp = exportedAt.replace(/[:.]/g, "-");

    anchor.href = url;
    anchor.download = `github-issue-search-export-${timestamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);

    setStatus(elements.syncStatus, `Exported ${issues.length} issues.`, "success");
  } catch (error) {
    setStatus(
      elements.syncStatus,
      error instanceof Error ? error.message : String(error),
      "error"
    );
  }
}

async function handleClear() {
  await clearIssues();
  await refreshIssueCount();
  setProgress(0, 0);
  elements.results.innerHTML = '<div class="empty">No results yet.</div>';
  elements.resultCount.textContent = "0 results";
  setStatus(elements.searchStatus, "Local issue data cleared.", "success");
}

function handleSearchInput() {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
}

function buildIssueChunks({ owner, repo, issue, labels, combinedText }) {
  const issueId = `${owner}/${repo}#${issue.number}`;
  const labelText = labels.map((label) => label.name).filter(Boolean).join(", ");
  const titleText = issue.title || "";
  const bodyText = issue.body || "";
  const context = [
    `Issue: ${issueId}`,
    `State: ${issue.state || ""}`,
    `Title: ${titleText}`,
    `Labels: ${labelText}`
  ].join("\n");
  const bodyChunks = splitTextIntoChunks(bodyText, CHUNK_CHAR_LIMIT, CHUNK_OVERLAP);
  const chunks = [
    {
      id: `${issueId}:title`,
      issue_id: issueId,
      kind: "title",
      index: 0,
      text: context,
      embedding: []
    }
  ];

  if (!bodyChunks.length) {
    chunks[0].text = combinedText;
    return chunks;
  }

  for (let index = 0; index < bodyChunks.length; index += 1) {
    chunks.push({
      id: `${issueId}:body:${index}`,
      issue_id: issueId,
      kind: "body",
      index: index + 1,
      text: `${context}\n\n${bodyChunks[index]}`,
      embedding: []
    });
  }

  return chunks;
}

function splitTextIntoChunks(text, limit, overlap) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) {
    return [];
  }

  const sections = normalized
    .split(/(?=^#{1,6}\s+)/gm)
    .flatMap((section) => section.split(/\n{2,}/))
    .map((section) => section.trim())
    .filter(Boolean);
  const chunks = [];
  let current = "";

  for (const section of sections) {
    if (section.length > limit) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitLongText(section, limit, overlap));
      continue;
    }

    if (current && `${current}\n\n${section}`.length > limit) {
      chunks.push(current);
      current = current.slice(Math.max(0, current.length - overlap));
    }

    current = current ? `${current}\n\n${section}` : section;
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitLongText(text, limit, overlap) {
  const chunks = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(text.length, start + limit);
    chunks.push(text.slice(start, end));
    if (end === text.length) {
      break;
    }
    start = Math.max(0, end - overlap);
  }

  return chunks;
}

async function runSearch() {
  const query = elements.searchInput.value.trim();

  if (!query) {
    elements.results.innerHTML = '<div class="empty">No results yet.</div>';
    elements.resultCount.textContent = "0 results";
    setStatus(elements.searchStatus, "Type to search saved issues.");
    return;
  }

  try {
    setStatus(elements.searchStatus, "Embedding search query...");
    const [queryEmbedding, issues] = await Promise.all([
      requestEmbedding(query),
      getAllIssues()
    ]);

    if (!issues.length) {
      elements.results.innerHTML = '<div class="empty">No saved issues. Sync a repository first.</div>';
      elements.resultCount.textContent = "0 results";
      setStatus(elements.searchStatus, "No local data.");
      return;
    }

    const ranked = rankIssues(query, queryEmbedding, issues).slice(0, SEARCH_LIMIT);

    renderResults(ranked);
    elements.resultCount.textContent = `${ranked.length} results`;
    const lexicalHits = ranked.filter((item) => item.lexicalScore > 0).length;
    setStatus(
      elements.searchStatus,
      `Showing ${ranked.length} of ${issues.length} saved issues. BM25 hits in results: ${lexicalHits}.`,
      "success"
    );
    return;
  } catch (error) {
    setStatus(
      elements.searchStatus,
      error instanceof Error ? error.message : String(error),
      "error"
    );
  }
}

function rankIssues(query, queryEmbedding, issues) {
  const chunks = buildSearchChunks(issues);
  const semanticItems = chunks
    .map((chunk) => ({
      chunk,
      score: cosineSimilarity(queryEmbedding, chunk.embedding)
    }))
    .sort((a, b) => b.score - a.score);
  const lexicalScores = computeBm25Scores(query, chunks);
  const lexicalItems = chunks
    .map((chunk, index) => ({
      chunk,
      score: lexicalScores[index] + exactMatchBoost(query, chunk)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const semanticRanks = buildChunkRankMap(semanticItems);
  const lexicalRanks = buildChunkRankMap(lexicalItems);
  const issueResults = new Map();

  for (const chunk of chunks) {
    const semanticRank = semanticRanks.get(chunk.id);
    const lexicalRank = lexicalRanks.get(chunk.id);
    const semanticScore = semanticItems[semanticRank - 1]?.score || 0;
    const lexicalScore = lexicalItems[lexicalRank - 1]?.score || 0;
    const exactTier = exactMatchTier(query, chunk);
    const chunkScore =
      reciprocalRank(semanticRank) +
      reciprocalRank(lexicalRank) +
      lexicalRrfBoost(lexicalScore);
    const existing = issueResults.get(chunk.issue.id);

    if (
      !existing ||
      exactTier > existing.exactTier ||
      (exactTier === existing.exactTier && chunkScore > existing.score)
    ) {
      issueResults.set(chunk.issue.id, {
        issue: chunk.issue,
        score: chunkScore,
        semanticScore,
        lexicalScore,
        exactTier,
        semanticRank,
        lexicalRank,
        chunk
      });
    }
  }

  return [...issueResults.values()].sort((a, b) => {
    if (b.exactTier !== a.exactTier) {
      return b.exactTier - a.exactTier;
    }

    if (b.score !== a.score) {
      return b.score - a.score;
    }

    return b.lexicalScore - a.lexicalScore || b.semanticScore - a.semanticScore;
  });
}

function buildSearchChunks(issues) {
  return issues.flatMap((issue) => {
    if (Array.isArray(issue.chunks) && issue.chunks.length) {
      return issue.chunks
        .filter((chunk) => Array.isArray(chunk.embedding) && chunk.embedding.length)
        .map((chunk) => ({
          ...chunk,
          issue,
          text: chunk.text || issue.combined_text || issue.title || ""
        }));
    }

    return [
      {
        id: `${issue.id}:legacy`,
        issue_id: issue.id,
        kind: "legacy",
        index: 0,
        issue,
        text: issue.combined_text || issue.title || "",
        embedding: issue.embedding || []
      }
    ];
  });
}

function buildChunkRankMap(items) {
  const ranks = new Map();

  items.forEach((item, index) => {
    ranks.set(item.chunk.id, index + 1);
  });

  return ranks;
}

function reciprocalRank(rank) {
  return rank ? 1 / (RRF_K + rank) : 0;
}

function lexicalRrfBoost(lexicalScore) {
  if (lexicalScore <= 0) {
    return 0;
  }

  return Math.min(MAX_LEXICAL_RRF_BOOST, lexicalScore / 1000);
}

function exactMatchTier(query, chunk) {
  const queryText = compactSearchText(query);
  if (!queryText) {
    return 0;
  }

  const title = compactSearchText(chunk.issue.title);
  const text = compactSearchText(chunk.text);
  const labels = compactSearchText((chunk.issue.labels || []).map((label) => label.name || "").join(" "));

  if (title.includes(queryText)) {
    return 3;
  }

  if (`${text}${labels}`.includes(queryText)) {
    return 2;
  }

  return 0;
}

function exactMatchBoost(query, chunk) {
  return exactMatchTier(query, chunk) * 100;
}

function computeBm25Scores(query, chunks) {
  const queryTokens = getSearchTokens(query);
  if (!queryTokens.length || !chunks.length) {
    return chunks.map(() => 0);
  }

  const tokenizedChunks = chunks.map((chunk) => {
    const titleTokens = getSearchTokens(chunk.issue.title);
    const bodyTokens = getSearchTokens(chunk.text);
    const labelTokens = getSearchTokens((chunk.issue.labels || []).map((label) => label.name || "").join(" "));

    return [
      ...repeatTokens(titleTokens, TITLE_LEXICAL_WEIGHT),
      ...repeatTokens(bodyTokens, BODY_LEXICAL_WEIGHT),
      ...labelTokens
    ];
  });
  const averageLength =
    tokenizedChunks.reduce((sum, tokens) => sum + tokens.length, 0) / tokenizedChunks.length || 1;
  const documentFrequency = new Map();

  for (const tokens of tokenizedChunks) {
    for (const token of new Set(tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) || 0) + 1);
    }
  }

  return tokenizedChunks.map((tokens) => {
    if (!tokens.length) {
      return 0;
    }

    const termFrequency = new Map();
    for (const token of tokens) {
      termFrequency.set(token, (termFrequency.get(token) || 0) + 1);
    }

    let score = 0;
    for (const token of queryTokens) {
      const frequency = termFrequency.get(token) || 0;
      if (!frequency) {
        continue;
      }

      const docsWithToken = documentFrequency.get(token) || 0;
      const idf = Math.log(1 + (chunks.length - docsWithToken + 0.5) / (docsWithToken + 0.5));
      const denominator =
        frequency + BM25_K1 * (1 - BM25_B + BM25_B * (tokens.length / averageLength));
      score += idf * ((frequency * (BM25_K1 + 1)) / denominator);
    }

    return score;
  });
}

function repeatTokens(tokens, count) {
  return Array.from({ length: count }, () => tokens).flat();
}

function normalizeSearchText(value) {
  return String(value || "").toLocaleLowerCase().normalize("NFKC");
}

function compactSearchText(value) {
  return normalizeSearchText(value).replace(/[\s\p{P}\p{S}]+/gu, "");
}

function getSearchTokens(value) {
  const text = normalizeSearchText(value);
  const compact = compactSearchText(text);
  const latinTokens = text.match(/[a-z0-9][a-z0-9._-]*/gi) || [];
  const japaneseTokens = text.match(/[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]{2,}/g) || [];
  const hasJapanese = /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u.test(compact);
  const ngramTokens = hasJapanese
    ? [2, 3].flatMap((size) => getNgrams(compact, size))
    : [];

  return [...new Set([...latinTokens, ...japaneseTokens, ...ngramTokens])]
    .map((token) => compactSearchText(token))
    .filter((token) => token.length >= 2);
}

function getNgrams(value, size) {
  const grams = [];

  for (let index = 0; index <= value.length - size; index += 1) {
    grams.push(value.slice(index, index + size));
  }

  return [...new Set(grams)];
}
function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }

  if (!normA || !normB) {
    return 0;
  }

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function renderResults(items) {
  if (!items.length) {
    elements.results.innerHTML = '<div class="empty">No matching issues.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of items) {
    fragment.appendChild(createIssueElement(item));
  }

  elements.results.replaceChildren(fragment);
}

function createIssueElement(item) {
  const { issue } = item;
  const article = document.createElement("article");
  article.className = "issue";

  const head = document.createElement("div");
  head.className = "issue-head";

  const link = document.createElement("a");
  link.className = "issue-title";
  link.href = issue.html_url;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = issue.title || "(untitled)";

  const scoreElement = document.createElement("span");
  scoreElement.className = "score";
  scoreElement.textContent = `rrf ${item.score.toFixed(3)}`;

  head.append(link, scoreElement);

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent =
    `#${issue.number} · ${issue.state || "unknown"} · ${issue.id} · ` +
    `vec #${item.semanticRank || "-"} · bm25 #${item.lexicalRank || "-"} · ` +
    `${item.chunk?.kind || "chunk"} ${item.chunk?.index ?? ""}`;

  const labels = document.createElement("div");
  labels.className = "labels";

  for (const label of issue.labels || []) {
    labels.appendChild(createLabelElement(label));
  }

  article.append(head, meta);
  if (labels.childElementCount) {
    article.appendChild(labels);
  }

  return article;
}

function createLabelElement(label) {
  const badge = document.createElement("span");
  const color = normalizeHexColor(label.color);
  badge.className = "label";
  badge.textContent = label.name || "";
  badge.style.backgroundColor = `#${color}`;
  badge.style.color = getReadableTextColor(color);

  return badge;
}

function normalizeHexColor(color) {
  const value = String(color || "").replace(/^#/, "");
  return /^[0-9a-f]{6}$/i.test(value) ? value : "d0d7de";
}

function getReadableTextColor(hexColor) {
  const red = parseInt(hexColor.slice(0, 2), 16);
  const green = parseInt(hexColor.slice(2, 4), 16);
  const blue = parseInt(hexColor.slice(4, 6), 16);
  const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;

  return luminance > 0.58 ? "#24292f" : "#ffffff";
}




