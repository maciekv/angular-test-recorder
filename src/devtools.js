// Utwórz panel DevTools o nazwie "Angular Test Recorder"
// i załaduj do niego nasz UI z panel.html
chrome.devtools.panels.create(
  "Angular Test Recorder",
  "icon16.png",
  "panel.html",
  function(panel) {
    // opcjonalnie: console.log('Panel created');
  }
);
