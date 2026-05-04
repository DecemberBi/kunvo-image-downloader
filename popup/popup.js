// DOM
const grid = document.getElementById('grid');
const counterText = document.getElementById('counter-text');
const emptyState = document.getElementById('empty-state');
const btnSelectAll = document.getElementById('btn-select-all');
const btnDownload = document.getElementById('btn-download');
const btnRefresh = document.getElementById('btn-refresh');
const sizeFilter = document.getElementById('size-filter');
const dedupFilter = document.getElementById('dedup-filter');
const btnSettings = document.getElementById('btn-settings');
const settingsPanel = document.getElementById('settings-panel');
const subfolderInput = document.getElementById('subfolder');
const namingRule = document.getElementById('naming-rule');
const prefixRow = document.getElementById('prefix-row');
const prefixInput = document.getElementById('prefix-input');

// State
const state = {
  images: [],
  selected: new Set(),
  minSize: 200,
  dedupThreshold: 4,
  dupeRemoved: 0,
  pageTitle: '',
  tabId: null,
  // 下载设置
  subfolder: '',
  naming: 'original',
  prefix: 'image',
};

// === Settings Persistence (localStorage — 同步，不会因弹窗关闭丢失) ===
const STORAGE_KEY = 'img_downloader_prefs';

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const prefs = JSON.parse(raw);
      if (prefs.subfolder != null) {
        state.subfolder = prefs.subfolder;
        subfolderInput.value = prefs.subfolder;
      }
      if (prefs.naming != null) {
        state.naming = prefs.naming;
        namingRule.value = prefs.naming;
        prefixRow.style.display = prefs.naming === 'prefix' ? '' : 'none';
      }
      if (prefs.prefix != null) {
        state.prefix = prefs.prefix;
        prefixInput.value = prefs.prefix;
      }
      if (prefs.dedupThreshold != null) {
        state.dedupThreshold = prefs.dedupThreshold;
        dedupFilter.value = prefs.dedupThreshold === 0 ? 'off' : String(prefs.dedupThreshold);
      }
    }
  } catch {
    // 数据损坏或解析失败，忽略
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      subfolder: state.subfolder,
      naming: state.naming,
      prefix: state.prefix,
      dedupThreshold: state.dedupThreshold,
    }));
  } catch {
    // 存储满或其他异常
  }
}

function hammingDistance(h1, h2) {
  if (!h1 || !h2 || h1.length !== h2.length) return 999;
  let dist = 0;
  for (let i = 0; i < h1.length; i++) {
    const xor = parseInt(h1[i], 16) ^ parseInt(h2[i], 16);
    dist += (xor & 1) + ((xor >> 1) & 1) + ((xor >> 2) & 1) + ((xor >> 3) & 1);
  }
  return dist;
}

function getFilteredImages() {
  let images = state.images;
  // 尺寸筛选
  if (state.minSize > 0) {
    images = images.filter(img => img.width >= state.minSize && img.height >= state.minSize);
  }
  // 去重
  state.dupeRemoved = 0;
  if (state.dedupThreshold > 0 && images.length > 1) {
    // 贪心聚类：按面积降序，每个图片与已保留的比对
    const sorted = [...images].sort((a, b) => (b.width * b.height) - (a.width * a.height));
    const kept = [];
    for (const img of sorted) {
      const isDupe = kept.some(k => hammingDistance(k.hash, img.hash) <= state.dedupThreshold);
      if (!isDupe) {
        kept.push(img);
      }
    }
    state.dupeRemoved = images.length - kept.length;
    return kept;
  }
  return images;
}

// === Filename Generation ===
function getExtension(url) {
  try {
    const pathname = new URL(url).pathname;
    const ext = pathname.split('.').pop().toLowerCase();
    if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif'].includes(ext)) {
      return '.' + ext;
    }
  } catch {}
  return '.jpg';
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*]/g, '_').replace(/\s+/g, '_').substring(0, 80);
}

function pad(num, len) {
  return String(num).padStart(len, '0');
}

function generateFilename(img, index, total) {
  const ext = getExtension(img.src);
  const numLen = total > 99 ? 3 : total > 9 ? 2 : 1;

  let name;
  switch (state.naming) {
    case 'prefix':
      name = sanitizeFilename(state.prefix || 'image') + '_' + pad(index + 1, numLen);
      break;
    case 'pagetitle':
      name = sanitizeFilename(state.pageTitle || 'image') + '_' + pad(index + 1, numLen);
      break;
    case 'date': {
      const now = new Date();
      const date = now.getFullYear()
        + pad(now.getMonth() + 1, 2)
        + pad(now.getDate(), 2);
      name = date + '_' + pad(index + 1, numLen);
      break;
    }
    default: { // original
      try {
        const parts = new URL(img.src).pathname.split('/');
        const raw = parts[parts.length - 1] || 'image';
        name = sanitizeFilename(raw.split('.')[0] || raw);
      } catch {
        name = 'image_' + pad(index + 1, numLen);
      }
      // If duplicate names possible (e.g. all same original name), append number
      if (total > 1) {
        name = name + '_' + pad(index + 1, numLen);
      }
    }
  }

  return name + ext;
}

function buildDownloadPath(img, index, total) {
  const filename = generateFilename(img, index, total);
  if (state.subfolder.trim()) {
    return state.subfolder.trim().replace(/[/\\]+$/, '') + '/' + filename;
  }
  return filename;
}

// === Init ===
(async function init() {
  loadSettings();
  // 同步去重下拉框展示（首次使用 localStorage 无值时也显示 state 中的默认值）
  dedupFilter.value = state.dedupThreshold === 0 ? 'off' : String(state.dedupThreshold);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) {
    showEmpty('无法获取当前页面');
    return;
  }

  state.tabId = tab.id;
  state.pageTitle = tab.title || '';

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_IMAGES' });
    if (res && res.images && res.images.length > 0) {
      state.images = res.images;
      render();
      chrome.tabs.sendMessage(tab.id, { type: 'START_WATCHING' }).catch(() => {});
      tabPollTimer = setInterval(checkTabSwitch, 2500);
      autoPollTimer = setInterval(pollNewImages, 5000);
    } else {
      showEmpty('当前页面没有找到主要图片');
    }
  } catch (e) {
    showEmpty('无法分析此页面（可能需要刷新页面后重试）');
  }
})();

// === Render ===
function render() {
  grid.innerHTML = '';
  emptyState.classList.add('hidden');
  grid.style.display = 'grid';

  const filtered = getFilteredImages();

  if (filtered.length === 0) {
    grid.style.display = 'none';
    emptyState.classList.remove('hidden');
    emptyState.querySelector('p').textContent = '没有符合筛选条件的图片';
    counterText.textContent = `全部 ${state.images.length} 张，符合条件 0 张`;
    btnDownload.disabled = true;
    btnSelectAll.disabled = true;
    return;
  }

  filtered.forEach((img) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.src = img.src;

    if (state.selected.has(img.src)) {
      card.classList.add('selected');
    }

    card.innerHTML = `
      <img src="${escapeHtml(img.src)}" alt="${escapeHtml(img.alt)}" loading="lazy">
      <div class="overlay"></div>
      <div class="check">&#10003;</div>
      <button class="delete" title="移除">&times;</button>
    `;

    const imgEl = card.querySelector('img');
    imgEl.addEventListener('error', () => {
      card.style.display = 'none';
    });

    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('delete')) return;
      toggleSelect(img.src);
      card.classList.toggle('selected', state.selected.has(img.src));
      updateUI();
    });

    card.querySelector('.delete').addEventListener('click', (e) => {
      e.stopPropagation();
      removeImage(img.src);
    });

    grid.appendChild(card);
  });

  updateUI();
}

// === Actions ===
function toggleSelect(src) {
  if (state.selected.has(src)) {
    state.selected.delete(src);
  } else {
    state.selected.add(src);
  }
}

function selectAll() {
  const filtered = getFilteredImages();
  const allFilteredSelected = filtered.every(img => state.selected.has(img.src));

  if (allFilteredSelected) {
    filtered.forEach(img => state.selected.delete(img.src));
  } else {
    filtered.forEach(img => state.selected.add(img.src));
  }

  document.querySelectorAll('.card').forEach(card => {
    card.classList.toggle('selected', state.selected.has(card.dataset.src));
  });
  updateUI();
}

function removeImage(src) {
  state.selected.delete(src);
  state.images = state.images.filter(img => img.src !== src);

  if (state.images.length === 0) {
    showEmpty('当前页面没有找到主要图片');
    return;
  }
  render();
}

async function downloadSelected() {
  if (state.selected.size === 0) return;

  const filtered = getFilteredImages();
  const selected = filtered.filter(img => state.selected.has(img.src));
  if (selected.length === 0) return;

  btnDownload.textContent = '下载中...';
  btnDownload.disabled = true;

  // 并发发起全部下载
  const tasks = selected.map((img, i) =>
    chrome.downloads.download({
      url: img.src,
      filename: buildDownloadPath(img, i, selected.length),
      conflictAction: 'uniquify',
      saveAs: false,
    }).then(() => 'ok').catch(() => 'fail')
  );

  const results = await Promise.all(tasks);
  const count = results.filter(r => r === 'ok').length;

  btnDownload.disabled = false;
  updateUI();
  showToast(`已开始下载 ${count} 张图片`);
}

// === UI Helpers ===
function updateUI() {
  const filtered = getFilteredImages();
  const selectedCount = filtered.filter(img => state.selected.has(img.src)).length;
  const filteredCount = filtered.length;
  const total = state.images.length;

  const dupeInfo = state.dupeRemoved > 0 ? `，去除 ${state.dupeRemoved} 张重复` : '';

  if (state.minSize > 0 && filteredCount < total) {
    counterText.textContent = selectedCount > 0
      ? `已选 ${selectedCount} / ${filteredCount} 张（共 ${total} 张${dupeInfo}）`
      : `${filteredCount} 张可见（共 ${total} 张${dupeInfo}）`;
  } else {
    counterText.textContent = selectedCount > 0
      ? `已选 ${selectedCount} / ${total} 张${dupeInfo}`
      : `${total} 张图片${dupeInfo}`;
  }

  btnDownload.disabled = selectedCount === 0;
  btnDownload.innerHTML = selectedCount > 0
    ? '<span id="download-icon">&#8595;</span> 下载 (' + selectedCount + ')'
    : '<span id="download-icon">&#8595;</span> 下载';

  const allSelected = filteredCount > 0 && filtered.every(img => state.selected.has(img.src));
  btnSelectAll.textContent = allSelected ? '取消全选' : '全选';
}

function showEmpty(msg) {
  grid.style.display = 'none';
  emptyState.classList.remove('hidden');
  emptyState.querySelector('p').textContent = msg;
  counterText.textContent = '';
  btnDownload.disabled = true;
  btnSelectAll.disabled = true;
}

function showToast(msg) {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2000);
}

// === Settings Panel ===
function toggleSettings() {
  const isOpen = settingsPanel.classList.contains('expanded');
  if (isOpen) {
    settingsPanel.classList.remove('expanded');
    settingsPanel.classList.add('collapsed');
  } else {
    settingsPanel.classList.remove('collapsed');
    settingsPanel.classList.add('expanded');
  }
}

// === 增量更新：翻页/滚动后自动接收新图片 ===
chrome.runtime.onMessage.addListener((msg) => {
  // 只处理来自当前 tab 的消息
  if (msg._tabId && msg._tabId !== state.tabId) return;

  if (msg.type === 'IMAGES_EXTRACTED' && msg.images && msg.images.length > 0) {
    // 页面跳转后的全量提取：替换当前图片列表
    if (msg._tabTitle) state.pageTitle = msg._tabTitle;
    state.images = msg.images;
    if (msg._tabId) state.tabId = msg._tabId;
    render();
    showToast(`新页面，共 ${msg.images.length} 张图片`);
    // 重新启动 DOM 监听（旧 content script 已随页面卸载）
    chrome.tabs.sendMessage(state.tabId, { type: 'START_WATCHING' }).catch(() => {});
  }

  if (msg.type === 'NEW_IMAGES' && msg.images && msg.images.length > 0) {
    const existingUrls = new Set(state.images.map(img => img.src));
    const trulyNew = msg.images.filter(img => !existingUrls.has(img.src));
    if (trulyNew.length > 0) {
      state.images.push(...trulyNew);
      render();
      showToast(`发现 ${trulyNew.length} 张新图片`);
    }
  }
});

// 弹窗关闭时停止页面监听和所有轮询
let tabPollTimer = null;
let autoPollTimer = null;

window.addEventListener('beforeunload', () => {
  if (state.tabId) {
    chrome.tabs.sendMessage(state.tabId, { type: 'STOP_WATCHING' }).catch(() => {});
  }
  clearInterval(tabPollTimer);
  clearInterval(autoPollTimer);
});

// Tab 切换检测：每 2.5 秒检查当前活跃 tab 是否变化
async function checkTabSwitch() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;
    if (tab.id === state.tabId) return;

    // Tab 已切换：停止旧 tab 的监听
    chrome.tabs.sendMessage(state.tabId, { type: 'STOP_WATCHING' }).catch(() => {});

    // 切换到新 tab
    state.tabId = tab.id;
    state.pageTitle = tab.title || '';

    const res = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_IMAGES' });
    if (res && res.images) {
      state.images = res.images;
      state.selected.clear();
      render();
      chrome.tabs.sendMessage(tab.id, { type: 'START_WATCHING' }).catch(() => {});
      clearInterval(autoPollTimer);
      autoPollTimer = setInterval(pollNewImages, 5000);
    } else {
      showEmpty('当前页面没有找到主要图片');
    }
  } catch {
    // 新 tab 可能没有 content script（如 chrome:// 页面），忽略
  }
}

// 定期增量轮询：捕捉延迟加载的图片
async function pollNewImages() {
  if (!state.tabId) return;
  try {
    const res = await chrome.tabs.sendMessage(state.tabId, { type: 'POLL_NEW_IMAGES' });
    if (res && res.images && res.images.length > 0) {
      const existingUrls = new Set(state.images.map(img => img.src));
      const trulyNew = res.images.filter(img => !existingUrls.has(img.src));
      if (trulyNew.length > 0) {
        state.images.push(...trulyNew);
        render();
      }
    }
  } catch {
    // 忽略（页面可能正在导航中）
  }
}

// 手动刷新：重新全量提取
async function refreshImages() {
  if (!state.tabId) return;
  btnRefresh.classList.add('spinning');
  try {
    const res = await chrome.tabs.sendMessage(state.tabId, { type: 'EXTRACT_IMAGES' });
    if (res && res.images) {
      state.images = res.images;
      render();
      showToast(`已刷新，共 ${res.images.length} 张图片`);
    }
  } catch {
    showToast('刷新失败，请重试');
  } finally {
    btnRefresh.classList.remove('spinning');
  }
}

// === Event Listeners ===
btnRefresh.addEventListener('click', refreshImages);
btnSelectAll.addEventListener('click', selectAll);
btnDownload.addEventListener('click', downloadSelected);

sizeFilter.addEventListener('change', () => {
  state.minSize = parseInt(sizeFilter.value);
  render();
});

dedupFilter.addEventListener('change', () => {
  const val = dedupFilter.value;
  state.dedupThreshold = val === 'off' ? 0 : parseInt(val);
  saveSettings();
  render();
});

btnSettings.addEventListener('click', toggleSettings);

namingRule.addEventListener('change', () => {
  state.naming = namingRule.value;
  prefixRow.style.display = state.naming === 'prefix' ? '' : 'none';
  saveSettings();
});

subfolderInput.addEventListener('change', () => {
  state.subfolder = subfolderInput.value;
  saveSettings();
});

prefixInput.addEventListener('change', () => {
  state.prefix = prefixInput.value;
  saveSettings();
});

// === Utils ===
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

