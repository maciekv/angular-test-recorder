// background.js - service worker
const recordedTabs = new Set();       // karty, na których nagrywamy / aktywny CS
const playQueue = new Map();          // tabId -> steps[] (reszta do wznowienia po goto)
const playingTabs = new Set();        // karty aktualnie w trybie Play

// -- Helpers --------------------------------------------------------
function injectContentScript(tabId, cb) {
  chrome.scripting.executeScript(
    { target: { tabId }, files: ['contentScript.js'] },
    () => { cb && cb(); }
  );
}

function safeSendToContent(tabId, payload) {
  chrome.tabs.sendMessage(tabId, payload, () => {
    if (chrome.runtime.lastError) {
      // CS nie żyje – wstrzyknij i spróbuj ponownie
      injectContentScript(tabId, () => chrome.tabs.sendMessage(tabId, payload));
    }
  });
}

// -- Messaging z panelu DevTools / CS -------------------------------
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // START RECORD
  if (request.cmd === 'start-record') {
    recordedTabs.add(request.tabId);
    injectContentScript(request.tabId, () => sendResponse({ started: true }));
    return true; // async sendResponse
  }

  // STOP RECORD
  if (request.cmd === 'stop-record') {
    recordedTabs.delete(request.tabId);
    safeSendToContent(request.tabId, { command: 'stopRecording' });
    playingTabs.delete(request.tabId);
    return;
  }

  // START SELECTION (micro-screenshot)
  if (request.cmd === 'start-selection') {
    if (!recordedTabs.has(request.tabId)) recordedTabs.add(request.tabId);
    injectContentScript(request.tabId, () => {
      safeSendToContent(request.tabId, {
        command: 'enableSelectionMode',
        screenshotIndex: request.index
      });
    });
    return;
  }

  // EXPORT TEST
  if (request.cmd === 'exportTest') {
    const blob = new Blob([request.content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({ url, filename: 'recorded-test.spec.ts' });
    return;
  }

  // SAVE SCREENSHOT
  if (request.cmd === 'saveScreenshot') {
    chrome.downloads.download({
      url: request.dataUrl,
      filename: `element-${request.index}.png`
    }, () => {
      chrome.runtime.sendMessage({
        type: 'screenshotSaved',
        tabId: sender.tab?.id,
        selector: request.selector,
        index: request.index
      });
    });
    return;
  }

  // CAPTURE VISIBLE TAB (dla micro-screenshota)
  if (request.cmd === 'captureElement') {
    const tabId = sender.tab.id;
    chrome.tabs.get(tabId, (tab) => {
      chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (dataUrl) => {
        sendResponse({ imgSrc: dataUrl });
      });
    });
    return true; // async sendResponse
  }

  // ------ PLAYBACK ------
  if (request.cmd === 'playSteps') {
    const tabId = request.tabId;
    playingTabs.add(tabId); // wchodzimy w tryb Play
    safeSendToContent(tabId, { command: 'playSteps', steps: request.steps || [] });
    return;
  }

  // CS informuje: zaraz robi goto – zapisz resztę kroków do wznowienia
  if (request.type === 'queueForResume') {
    const tabId = sender.tab?.id;
    if (tabId) {
      playQueue.set(tabId, request.remainingSteps || []);
      playingTabs.add(tabId); // pozostajemy w trybie Play
    }
    return;
  }

  // CS informuje: odtwarzanie zakończone
  if (request.type === 'playbackDone') {
    const tabId = sender.tab?.id;
    if (tabId) playingTabs.delete(tabId);
    chrome.runtime.sendMessage({ type: 'playbackDone', tabId });
    return;
  }
});

// -- Nawigacje ------------------------------------------------------
// Po załadowaniu DOM głównej ramki: upewnij się, że CS działa
// i ewentualnie wznowienie play z kolejki (po page.goto)
chrome.webNavigation.onDOMContentLoaded.addListener(details => {
  if (details.frameId !== 0) return;

  const hasResume = (playQueue.get(details.tabId)?.length || 0) > 0;
  const needsCs =
    recordedTabs.has(details.tabId) || hasResume || playingTabs.has(details.tabId);
  if (!needsCs) return;

  injectContentScript(details.tabId, () => {
    const rest = playQueue.get(details.tabId);
    if (rest && rest.length) {
      // wznowienie odtwarzania po goto
      chrome.tabs.sendMessage(details.tabId, { command: 'playSteps', steps: rest }, () => {
        if (chrome.runtime.lastError) {
          safeSendToContent(details.tabId, { command: 'playSteps', steps: rest });
        }
      });
      playQueue.delete(details.tabId);
      playingTabs.add(details.tabId); // nadal jesteśmy w trybie Play
    }
  });
});

// Wysyłaj do panelu info o nawigacjach TYLKO gdy nagrywamy i nie odtwarzamy
chrome.webNavigation.onCommitted.addListener(details => {
  if (details.frameId !== 0) return;
  if (!recordedTabs.has(details.tabId)) return;
  if (playingTabs.has(details.tabId)) return;
  chrome.runtime.sendMessage({
    type: 'navigation',
    tabId: details.tabId,
    url: details.url
  });
});
