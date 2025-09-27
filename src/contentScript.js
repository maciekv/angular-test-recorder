// --- singleton guard: zapobiega wielokrotnemu podpinaniu listenerów ---
if (window.__ATR_CONTENT_SCRIPT_LOADED__) {
  // już wpięty – nie podpinaj kolejny raz
} else {
  window.__ATR_CONTENT_SCRIPT_LOADED__ = true;
  (function () {
    let isRecording = true;
    let selectionMode = false;
    let pendingScreenshotIndex = null;

    // ---------- Helpers ----------
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
    const DEV_LOG = false; // true = dodatkowe logi

    async function waitForSelector(sel, timeout = 8000) {
      const start = performance.now();
      while (performance.now() - start < timeout) {
        const el = document.querySelector(sel);
        if (el) return el;
        await sleep(100);
      }
      throw new Error('Element not found: ' + sel);
    }

    async function angularStableIfAny(timeout = 8000) {
      try {
        const has = typeof window.getAllAngularTestabilities === 'function';
        if (!has) return;
        const start = performance.now();
        while (performance.now() - start < timeout) {
          const all = window.getAllAngularTestabilities();
          const stable = !all || all.every(t => t.isStable());
          if (stable) return;
          await sleep(50);
        }
      } catch { }
    }

    function dispatch(el, type) {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
    }

    async function clickBackdropIfPresent() {
      const backdrop = document.querySelector('.cdk-overlay-backdrop');
      if (backdrop) {
        // najpierw spróbuj native click:
        try { backdrop.click?.(); } catch {}
        // a potem sekwencję mouse eventów
        for (const ev of ['pointerdown','mousedown','pointerup','mouseup','click']) {
          try { backdrop.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window })); } catch {}
        }
        await sleep(50);
      }
    }

    async function waitOverlayGone(innerSelector, maxMs = 3000, tryBackdropAtMs = 600) {
      const overlaySel = `.cdk-overlay-pane ${innerSelector}`;
      const start = performance.now();
      let triedBackdrop = false;
      while (performance.now() - start < maxMs) {
        const stillThere = !!document.querySelector(overlaySel);
        if (!stillThere) return true;
        // jeżeli długo wisi – spróbuj „stuknąć” w tło, żeby zamknąć
        if (!triedBackdrop && (performance.now() - start) > tryBackdropAtMs) {
          triedBackdrop = true;
          await clickBackdropIfPresent();
        }
        await sleep(50);
      }
      return !document.querySelector(overlaySel);
    }

    // ---------- CLICK: najpierw native click, potem sztuczne eventy ----------
    async function clickDom(sel) {
      const el = await waitForSelector(sel);
      if (!el) return;

      el.scrollIntoView?.({ block: 'center', inline: 'center' });
      await sleep(10);

      // 1) spróbuj prawdziwego .click() (lepsze dla Angular Material / SVG z <button>)
      try { el.click?.(); } catch {}

      // 2) dopełnij sekwencją eventów (by pokryć nietypowe przypadki)
      for (const ev of ['pointerdown','mousedown','pointerup','mouseup','click']) {
        try { el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window })); } catch {}
      }

      // --- POST-CLICK: specjalne traktowanie overlay'ów Angular Material ---
      // a) Datepicker – klik w komórkę dnia w overlay'u
      if (sel.startsWith('.cdk-overlay-pane ') && sel.includes('[aria-label="')) {
        await waitOverlayGone('mat-datepicker-content', 3500, 500);
      }
      // b) Select option – klik w #mat-option-... w overlay'u
      if (sel.startsWith('.cdk-overlay-pane ') && /#mat-option-\d+/.test(sel)) {
        await waitOverlayGone('.mat-mdc-select-panel', 2500, 300);
      }

      await angularStableIfAny();
      await sleep(20);
    }

    async function fillDom(sel, value) {
      const el = await waitForSelector(sel);
      if (!el) return;

      // contenteditable
      const isEditable = el.getAttribute && (el.getAttribute('contenteditable') === '' || el.getAttribute('contenteditable') === 'true');
      if (isEditable) {
        el.focus?.();
        el.textContent = value == null ? '' : String(value);
        dispatch(el, 'input');
        dispatch(el, 'change');
        await angularStableIfAny();
        await sleep(30);
        return;
      }

      el.focus?.();
      if ('value' in el) {
        // @ts-ignore
        el.value = value;
      } else {
        try { el.setAttribute('value', value); } catch { }
      }
      dispatch(el, 'input');
      dispatch(el, 'change');
      await angularStableIfAny();
      await sleep(30);
    }

    async function selectDom(sel, value) {
      const el = await waitForSelector(sel);
      if (!el) return;

      if (el.tagName === 'SELECT') {
        let matched = false;
        const opts = el.querySelectorAll('option');
        for (const opt of opts) {
          if (opt.value === value || opt.textContent === value) {
            opt.selected = true; matched = true; break;
          }
        }
        if (!matched && value != null) { /* @ts-ignore */ el.value = value; }
        dispatch(el, 'input'); dispatch(el, 'change');
        await angularStableIfAny();
      } else {
        try { el.setAttribute('value', value); } catch {}
        dispatch(el, 'input'); dispatch(el, 'change');
        await angularStableIfAny();
      }
    }

    async function checkDom(sel, shouldBeChecked) {
      const el = await waitForSelector(sel);
      if (!el) return;

      const isCheckable = (el.type === 'checkbox' || el.type === 'radio');
      if (isCheckable) {
        // @ts-ignore
        if (!!el.checked !== !!shouldBeChecked) {
          // @ts-ignore
          el.checked = !!shouldBeChecked;
          for (const ev of ['pointerdown','mousedown','pointerup','mouseup','click']) {
            try { el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window })); } catch {}
          }
          dispatch(el, 'input'); dispatch(el, 'change');
        }
        await angularStableIfAny();
      } else {
        await clickDom(sel);
      }
    }

    // ---------- Generator selektorów ----------
    function getSelector(el) {
      if (!el) return '';
      if (el.getAttribute && el.getAttribute('data-testid')) {
        return `[data-testid="${el.getAttribute('data-testid')}"]`;
      }
      if (el.id) return '#' + el.id;
      if (el.getAttribute && el.getAttribute('aria-label')) {
        return `[aria-label="${el.getAttribute('aria-label')}"]`;
      }
      const tag = el.tagName?.toLowerCase?.() || '';
      if (!el.parentElement || !tag) return tag || '';
      const siblings = el.parentElement.children;
      let sameTagCount = 0, index = 0;
      for (let i = 0; i < siblings.length; i++) {
        if (siblings[i].tagName?.toLowerCase?.() === tag) {
          sameTagCount++;
          if (siblings[i] === el) index = sameTagCount;
        }
      }
      const parentSelector = getSelector(el.parentElement);
      if (sameTagCount === 1) return `${parentSelector} > ${tag}`;
      return `${parentSelector} > ${tag}:nth-child(${index})`;
    }

    // ---------- Playback ----------
    async function playRecordedSteps(steps) {
      const prev = isRecording;
      isRecording = false; // nie nagrywaj w trakcie odtwarzania

      try {
        for (let i = 0; i < steps.length; i++) {
          const s = String(steps[i]).trim();
          if (!s || s.startsWith('//') || s.includes('waitForFunction(')) continue;

          // await page.waitForSelector('SELECTOR', { state: 'detached' });
          {
            const m = s.match(/^await\s+page\.waitForSelector\('([^']+)'\s*,\s*\{\s*state:\s*'detached'\s*\}\s*\);?$/);
            if (m) {
              const sel = m[1];
              const timeout = 8000;
              const start = performance.now();
              while (performance.now() - start < timeout) {
                const el = document.querySelector(sel);
                if (!el) break;
                await sleep(100);
              }
              await angularStableIfAny();
              continue;
            }
          }

          // await page.waitForSelector('SELECTOR', { state: 'visible' });
          {
            const m = s.match(/^await\s+page\.waitForSelector\('([^']+)'\s*,\s*\{\s*state:\s*'visible'\s*\}\s*\);?$/);
            if (m) {
              const sel = m[1];
              const start = performance.now();
              const timeout = 8000;
              while (performance.now() - start < timeout) {
                const el = document.querySelector(sel);
                if (el) {
                  const style = window.getComputedStyle(el);
                  const visible = style && style.visibility !== 'hidden' && style.display !== 'none';
                  if (visible) break;
                }
                await sleep(100);
              }
              await angularStableIfAny();
              continue;
            }
          }

          // await page.locator('SELECTOR').nth(NUM).click();
          {
            const m = s.match(/^await\s+page\.locator\('([^']+)'\)\.nth\((\d+)\)\.click\(\);?$/);
            if (m) {
              const sel = m[1];
              const n = parseInt(m[2], 10);
              const list = document.querySelectorAll(sel);
              const el = list[n];
              if (el) {
                el.scrollIntoView?.({ block: 'center', inline: 'center' });
                try { el.click?.(); } catch {}
                for (const ev of ['pointerdown','mousedown','pointerup','mouseup','click']) {
                  try { el.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window })); } catch {}
                }
                await angularStableIfAny();
                await sleep(50);
              } else {
                console.warn('locator().nth(): element not found', sel, n);
              }
              continue;
            }
          }

          // await page.goto('URL')
          {
            const m = s.match(/^await\s+page\.goto\('([^']+)'\);?$/);
            if (m) {
              const url = m[1];
              const remaining = steps.slice(i + 1);
              chrome.runtime.sendMessage({ type: 'queueForResume', remainingSteps: remaining });
              window.location.assign(url);
              return; // dalsze kroki wznowi background
            }
          }

          // await page.click('selector')
          {
            const m = s.match(/^await\s+page\.click\('([^']+)'\);?$/);
            if (m) { await clickDom(m[1]); continue; }
          }

          // await page.fill('selector', value)
          {
            const m = s.match(/^await\s+page\.fill\('([^']+)'\s*,\s*(.+)\);?$/);
            if (m) {
              let val = m[2].trim();
              if (val.endsWith(';')) val = val.slice(0, -1);
              try { val = JSON.parse(val); } catch { }
              await fillDom(m[1], val);
              continue;
            }
          }

          // await page.selectOption('selector','value')
          {
            const m = s.match(/^await\s+page\.selectOption\('([^']+)'\s*,\s*'([^']+)'\);?$/);
            if (m) { await selectDom(m[1], m[2]); continue; }
          }

          // await page.check / uncheck
          {
            const m1 = s.match(/^await\s+page\.check\('([^']+)'\);?$/);
            if (m1) { await checkDom(m1[1], true); continue; }
            const m2 = s.match(/^await\s+page\.uncheck\('([^']+)'\);?$/);
            if (m2) { await checkDom(m2[1], false); continue; }
          }

          // expect(...).toMatchSnapshot(...) – pomijamy
          if (s.includes('.toMatchSnapshot(')) continue;

          // Fallback – spróbuj kliknąć pierwszy znaleziony selektor
          const mSel = s.match(/'([^']+)'/);
          if (mSel) {
            try { await clickDom(mSel[1]); } catch (e) {
              if (DEV_LOG) console.warn('fallback click failed', mSel[1], e);
            }
          }
        }
      } finally {
        isRecording = prev;
        try { chrome.runtime.sendMessage({ type: 'playbackDone' }); } catch { }
      }
    }

    // ---------- Start: powiadom panel czy Angular jest dostępny ----------
    const hasAngular = (typeof window.getAllAngularTestabilities === 'function');
    chrome.runtime.sendMessage({ type: 'angularDetected', value: hasAngular });

    // ---------- Messaging z background/panel ----------
    chrome.runtime.onMessage.addListener(msg => {
      if (msg.command === 'stopRecording') {
        isRecording = false;
        document.removeEventListener('click', handleClick, true);
        document.removeEventListener('change', handleChange, true);
      }

      if (msg.command === 'enableSelectionMode') {
        selectionMode = true;
        pendingScreenshotIndex = msg.screenshotIndex;
        document.addEventListener('mouseover', hoverHighlight, true);
        document.addEventListener('mouseout', removeHighlight, true);
      }

      if (msg.command === 'playSteps' && Array.isArray(msg.steps)) {
        playRecordedSteps(msg.steps);
      }
    });

    // ---------- Highlight do wyboru elementu ----------
    function hoverHighlight(e) { e.target.style.outline = '2px solid red'; }
    function removeHighlight(e) { e.target.style.outline = ''; }

    // ---------- Nagrywanie klików / inputów ----------
    function handleClick(e) {
      if (!isRecording) return;

      if (selectionMode) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        document.removeEventListener('mouseover', hoverHighlight, true);
        document.removeEventListener('mouseout', removeHighlight, true);
        selectionMode = false;

        const el = e.target;
        const selector = getSelector(el);
        const rect = el.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const left = rect.left, top = rect.top;
        const width = rect.width, height = rect.height;

        chrome.runtime.sendMessage({ cmd: 'captureElement' }, response => {
          if (response && response.imgSrc) {
            const image = new Image();
            image.src = response.imgSrc;
            image.onload = () => {
              const canvas = document.createElement('canvas');
              canvas.width = width * dpr;
              canvas.height = height * dpr;
              const ctx = canvas.getContext('2d');
              ctx.drawImage(
                image,
                left * dpr, top * dpr, width * dpr, height * dpr,
                0, 0, width * dpr, height * dpr
              );
              const croppedDataUrl = canvas.toDataURL('image/png');
              chrome.runtime.sendMessage({
                cmd: 'saveScreenshot',
                index: pendingScreenshotIndex,
                selector: selector,
                dataUrl: croppedDataUrl
              });
            };
          }
        });
        return;
      }

      // --- Tryb normalny: rejestruj klik, ale wybierz "klikowalny" przodek ---
      const raw = e.target;
      const clickable = raw.closest?.(
        'button, [role="button"], .mat-datepicker-toggle, .mat-mdc-select-trigger, .mat-select-trigger, ' +
        'a, input, textarea, select, [contenteditable="true"]'
      ) || raw;

      const selector = getSelector(clickable);

      // policz dopasowania i index bieżącego – żeby rozróżnić np. 2 datepickery
      let multiIndex = null;
      try {
        const all = Array.from(document.querySelectorAll(selector));
        const idx = all.indexOf(clickable);
        if (idx >= 0 && all.length > 1) multiIndex = idx;
      } catch (_) { /* noop */ }

      // link href (nawigacja)
      let href = null;
      const anchor = clickable.closest && clickable.closest('a');
      if (anchor && anchor.href && (!anchor.target || anchor.target === "_self")) {
        href = anchor.href;
      }

      chrome.runtime.sendMessage({
        type: 'click',
        selector,
        href,
        multiIndex
      });
    }

    function handleChange(e) {
      if (!isRecording) return;
      const target = e.target;
      if (!target || !target.tagName) return;
      const tag = target.tagName.toUpperCase();
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
        const selector = getSelector(target);
        const value = target.value;
        chrome.runtime.sendMessage({
          type: 'input',
          selector: selector,
          value: value
        });
      }
    }

    document.addEventListener('click', handleClick, true);
    document.addEventListener('change', handleChange, true);
  })();
}
