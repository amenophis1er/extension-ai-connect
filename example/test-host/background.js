import { registerAiHandlers } from './lib/background/index.js';

registerAiHandlers({ prefix: 'testhost', settingsHint: 'Add one on the test page.' });

// The toolbar button opens the test page in a tab (a popup would close, and
// stop polling, as soon as the connect page opens).
chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('page.html') });
});
