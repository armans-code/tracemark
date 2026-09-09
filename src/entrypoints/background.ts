import { browser, defineBackground } from "#imports";
import type { Browser } from "wxt/browser";

export default defineBackground(() => {
  async function handleActionClick(tab: Browser.tabs.Tab) {
    const tabId = tab.id;
    if (!tabId) return;
    await browser.scripting.executeScript({
      target: { tabId },
      files: ["/overlay.js"],
    });
  }

  browser.action.onClicked.addListener(handleActionClick);

  browser.runtime.onMessage.addListener((message, sender) => {
    if (message?.type !== "CAPTURE_VISIBLE_TAB") return;

    const windowId = sender.tab?.windowId;
    if (windowId != null) {
      return browser.tabs.captureVisibleTab(windowId, { format: "png" });
    }
    return browser.tabs.captureVisibleTab({ format: "png" });
  });
});
