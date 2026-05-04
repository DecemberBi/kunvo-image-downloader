// Service Worker — Side Panel 协调 + 消息中转

// 点击扩展图标时打开侧边栏
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

// 点击图标时如果侧边栏已打开则不做额外操作（setPanelBehavior 已处理）
chrome.action.onClicked.addListener(() => {
  // sidePanel.setPanelBehavior 已自动处理打开/切换
});

// 中转 content script 消息到侧边栏（侧边栏未打开时自然丢弃）
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'IMAGES_EXTRACTED' || msg.type === 'NEW_IMAGES') {
    // 附加发送者 tab 信息，侧边栏用于判断是否显示
    chrome.runtime.sendMessage({
      ...msg,
      _tabId: sender.tab ? sender.tab.id : null,
      _tabUrl: sender.tab ? sender.tab.url : null,
      _tabTitle: sender.tab ? sender.tab.title : null,
    }).catch(() => {});
  }
});
