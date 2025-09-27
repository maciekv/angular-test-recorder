(() => {
  // Id inspekowanej karty
  const tabId = chrome.devtools.inspectedWindow.tabId;

  // UI
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const snapshotBtn = document.getElementById('snapshotBtn');
  const exportBtn = document.getElementById('exportBtn');
  const thresholdInput = document.getElementById('thresholdInput');
  const stepsList = document.getElementById('stepsList');
  const playBtn = document.getElementById('playBtn');

  // Stan
  let angularDetected = false;
  let lastClickHref = null;
  let screenshotCounter = 0;
  const recordedSteps = [];
  let isPlaying = false;

  function addStep(text) {
    recordedSteps.push(text);
    if (!stepsList) return;
    const li = document.createElement('li');
    li.textContent = text;
    stepsList.appendChild(li);
  }

  function setPlayState(playing) {
    isPlaying = playing;
    if (playBtn) playBtn.disabled = !!playing;
  }

  // Odbiór zdarzeń z background/content-script
  chrome.runtime.onMessage.addListener((message) => {
    // filtruj wiadomości innych kart
    if (message.tabId && message.tabId !== tabId) return;

    // jeśli trwa odtwarzanie, ignorujemy eventy nagrywania
    if (isPlaying && message.type !== 'playbackDone' && message.type !== 'screenshotSaved') {
      return;
    }

    switch (message.type) {
      case 'angularDetected':
        angularDetected = !!message.value;
        break;

      case 'click': {
        const sel = message.selector;
        const idx = (typeof message.multiIndex === 'number') ? message.multiIndex : null;

        // Heurystyki do Angular Material
        const isMatOption   = /^#mat-option-\d+/.test(sel);
        const isDateCell    = /\[aria-label=".+\d{4}"\]/.test(sel);
        const isSelectTrigger =
          /\.mat-(mdc-)?select-trigger/.test(sel) || /#mat-select-value-/.test(sel) || /mat-select/.test(sel);
        const isDateToggle  =
          /\[aria-label="Open calendar"\]/.test(sel) || /mat-datepicker-toggle/.test(sel);

        // --- 1) Najpierw klikamy TRIGGER (select/datepicker) ---
        if (isSelectTrigger || isDateToggle) {
          if (idx !== null) {
            addStep(`await page.locator('${sel}').nth(${idx}).click();`);
          } else {
            addStep(`await page.click('${sel}');`);
          }
          // ... i dopiero potem czekamy na overlay
          addStep(`await page.waitForSelector('.cdk-overlay-pane .mat-mdc-select-panel, .cdk-overlay-pane mat-datepicker-content', { state: 'visible' });`);
        }
        // --- 2) Klik na OPCJĘ w select'cie: zawsze w overlay'u + czekamy aż zniknie ---
        else if (isMatOption) {
          addStep(`await page.waitForSelector('.cdk-overlay-pane .mat-mdc-select-panel', { state: 'visible' });`);
          addStep(`await page.click('.cdk-overlay-pane ${sel}');`);
          addStep(`await page.waitForSelector('.cdk-overlay-pane .mat-mdc-select-panel', { state: 'detached' });`);
        }
        // --- 3) Klik na DZIEŃ w datepickerze: w overlay'u, bez wymuszania zamknięcia ---
        else if (isDateCell) {
          addStep(`await page.waitForSelector('.cdk-overlay-pane mat-datepicker-content', { state: 'visible' });`);
          addStep(`await page.click('.cdk-overlay-pane ${sel}');`);
          // UWAGA: nie czekamy na 'detached' – to psuło range pickery.
          // Gdy użytkownik zamknie/wybierze drugi dzień, kolejne kroki pójdą dalej.
        }
        // --- 4) Pozostałe kliki jak dotąd (z obsługą nth) ---
        else {
          if (idx !== null) {
            addStep(`await page.locator('${sel}').nth(${idx}).click();`);
          } else {
            addStep(`await page.click('${sel}');`);
          }
        }

        lastClickHref = message.href ? message.href : null;

        if (angularDetected) {
          addStep(`await page.waitForFunction(() => {
  const t = window.getAllAngularTestabilities;
  return !t || Array.from(t()).every(tt => tt.isStable());
});`);
        }
        break;
      }

      case 'input': {
        const val = JSON.stringify(message.value);
        addStep(`await page.fill('${message.selector}', ${val});`);
        if (angularDetected) {
          addStep(`await page.waitForFunction(() => {
  const t = window.getAllAngularTestabilities;
  return !t || Array.from(t()).every(tt => tt.isStable());
});`);
        }
        break;
      }

      case 'navigation':
        if (lastClickHref && message.url === lastClickHref) {
          lastClickHref = null;
        } else {
          addStep(`await page.goto('${message.url}');`);
        }
        break;

      case 'screenshotSaved': {
        const thr = Math.max(0, Math.min(1, parseFloat(thresholdInput?.value) || 0.1));
        addStep(`expect(await page.locator('${message.selector}').screenshot()).toMatchSnapshot('element-${message.index}.png', { threshold: ${thr} });`);
        break;
      }

      case 'playbackDone':
        setPlayState(false);
        break;
    }
  });

  // Start
  startBtn?.addEventListener('click', () => {
    setPlayState(false);
    recordedSteps.length = 0;
    if (stepsList) stepsList.innerHTML = '';

    chrome.runtime.sendMessage({ cmd: 'start-record', tabId }, () => {
      chrome.devtools.inspectedWindow.eval('location.href', (href) => {
        if (href) addStep(`await page.goto('${href}');`);
      });
    });

    if (startBtn) startBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = false;
  });

  // Stop
  stopBtn?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ cmd: 'stop-record', tabId });
    setPlayState(false);
    if (startBtn) startBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
  });

  // Screenshot (wybór elementu na stronie)
  snapshotBtn?.addEventListener('click', () => {
    screenshotCounter += 1;
    chrome.runtime.sendMessage({ cmd: 'start-selection', tabId, index: screenshotCounter });
  });

  // Eksport
  exportBtn?.addEventListener('click', () => {
    let content = "import { test, expect } from '@playwright/test';\n\n";
    content += "test('Recorded test', async ({ page }) => {\n";
    for (const s of recordedSteps) content += "  " + s + "\n";
    content += "});\n";

    chrome.runtime.sendMessage({ cmd: 'exportTest', tabId, content });
  });

  // Play
  playBtn?.addEventListener('click', () => {
    if (!recordedSteps.length) return;
    setPlayState(true);
    chrome.runtime.sendMessage({
      cmd: 'playSteps',
      tabId,
      steps: recordedSteps
    });
  });
})();
