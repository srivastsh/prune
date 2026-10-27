// Clicking the toolbar icon opens (or focuses) the Prune dashboard.
const DASH = chrome.runtime.getURL('src/dashboard.html');

chrome.action.onClicked.addListener(async () => {
  const [existing] = await chrome.tabs.query({ url: DASH });
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
    await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: DASH });
  }
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === 'install') chrome.tabs.create({ url: DASH });
});
