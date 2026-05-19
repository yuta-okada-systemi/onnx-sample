import { env, pipeline } from "./vendor/transformers/transformers.min.js";

env.allowLocalModels = false;
env.allowRemoteModels = true;
env.useBrowserCache = true;
env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL("vendor/transformers/");
env.backends.onnx.wasm.numThreads = 1;

let extractorPromise = null;

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel?.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  }
});

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline(
      "feature-extraction",
      "Xenova/paraphrase-multilingual-MiniLM-L12-v2"
    );
  }

  return extractorPromise;
}

async function embedText(text) {
  const extractor = await getExtractor();
  const output = await extractor(text || "", {
    pooling: "mean",
    normalize: true
  });

  return Array.from(output.data);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "EMBED_TEXT") {
    return false;
  }

  embedText(message.text)
    .then((embedding) => {
      sendResponse({ ok: true, embedding });
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  return true;
});
