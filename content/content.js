// 智能图片提取：过滤图标/logo/广告/埋点等非内容图片
// 支持增量提取：翻页/无限滚动后自动检测新图片

const MIN_SIZE = 100; // 最小宽高下限（弹窗内可进一步筛选）

// URL 关键词黑名单
const EXCLUDE_PATTERNS = [
  'icon', 'logo', 'avatar', 'emoji', 'pixel', 'tracking',
  'analytics', '1x1', 'spacer', 'blank', 'placeholder',
  'badge', 'button', 'banner', 'ad-', '/ad/', '-ad-',
  'favicon', 'facebook', 'twitter', 'share', 'wechat',
  'pixel.gif', 'beacon', 'count', 'stat', 'score',
];

// 内容容器优先级选择器（匹配这些容器的图片排在前面）
const CONTENT_SELECTORS = [
  'article', 'main', '[role="main"]',
  '.post', '.article', '.content', '.entry', '.body',
  '.post-content', '.article-content', '.entry-content',
  '.detail', '.news', '.story', '#content', '#article',
  '.main-content', '.page-content',
];

// 已提取过的 URL（持久化，用于增量提取去重）
const extractedUrls = new Set();

// MutationObserver 实例
let observer = null;
let watchDebounceTimer = null;

function isVisible(img) {
  const style = getComputedStyle(img);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  if (parseFloat(style.opacity) === 0) return false;
  if (img.offsetWidth === 0 || img.offsetHeight === 0) return false;
  const rect = img.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  return true;
}

function isExcludedByUrl(src) {
  const lower = src.toLowerCase();
  return EXCLUDE_PATTERNS.some(p => lower.includes(p));
}

function getImageDimensions(img, trustNatural) {
  if (trustNatural && img.naturalWidth > 0 && img.naturalHeight > 0) {
    return { width: img.naturalWidth, height: img.naturalHeight };
  }
  const rect = img.getBoundingClientRect();
  if (rect.width > 0 && rect.height > 0) {
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  }
  if (img.width > 0 && img.height > 0) {
    return { width: img.width, height: img.height };
  }
  return { width: 0, height: 0 };
}

function isLargeEnough(img, trustNatural) {
  const dims = getImageDimensions(img, trustNatural);
  if (dims.width === 0 && dims.height === 0) return true;
  return dims.width >= MIN_SIZE && dims.height >= MIN_SIZE;
}

function getPriority(img) {
  for (let i = 0; i < CONTENT_SELECTORS.length; i++) {
    if (img.closest(CONTENT_SELECTORS[i])) {
      return i;
    }
  }
  return CONTENT_SELECTORS.length;
}

// 感知哈希 (aHash)：16×16 灰度，256-bit hex
function computeImageHash(img) {
  const dims = getImageDimensions(img, !!img.src);
  const w = dims.width || img.width || 100;
  const h = dims.height || img.height || 100;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 16;
    canvas.height = 16;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, 16, 16);
    const imageData = ctx.getImageData(0, 0, 16, 16);
    if (imageData.data.length === 0) throw new Error('empty');
    const gray = [];
    let sum = 0;
    for (let i = 0; i < imageData.data.length; i += 4) {
      const v = Math.round(imageData.data[i] * 0.299 + imageData.data[i + 1] * 0.587 + imageData.data[i + 2] * 0.114);
      gray.push(v);
      sum += v;
    }
    const avg = sum / gray.length;
    let hash = '';
    for (const v of gray) {
      const byte = v >= avg ? 1 : 0;
      if (hash.length % 4 === 0) hash += byte.toString(16);
      else hash = hash.slice(0, -1) + (parseInt(hash.slice(-1), 16) * 2 + byte).toString(16);
    }
    return hash;
  } catch {
    // Canvas 跨域污染 或 绘制失败 → 回退到文件名签名
    try {
      const pathname = new URL(img.src || '').pathname;
      const basename = pathname.split('/').pop() || 'unknown';
      return basename + '_' + w + 'x' + h;
    } catch {
      return 'sig_' + w + 'x' + h;
    }
  }
}

// 处理单张图片：提取 src、过滤、获取尺寸；返回结果对象或 null
function processImage(img, seen, checkSeen) {
  const srcFromDataAttr = !img.src;
  let src = img.src || img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
  if (!src) return null;
  if (src.startsWith('data:')) return null;
  if (!src.startsWith('http')) {
    try { src = new URL(src, location.href).href; }
    catch { return null; }
  }
  if (checkSeen && seen.has(src)) return null;
  if (isExcludedByUrl(src)) return null;
  if (!isVisible(img)) return null;
  if (!isLargeEnough(img, !srcFromDataAttr)) return null;

  const dims = getImageDimensions(img, !srcFromDataAttr);
  seen.add(src);

  return {
    src,
    alt: img.alt || '',
    naturalWidth: dims.width,
    naturalHeight: dims.height,
    priority: getPriority(img),
    hash: computeImageHash(img),
  };
}

function sortResults(results) {
  results.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    const areaB = b.naturalWidth * b.naturalHeight;
    const areaA = a.naturalWidth * a.naturalHeight;
    return areaB - areaA;
  });
}

function toOutput(results) {
  return results.map(({ src, alt, naturalWidth, naturalHeight, hash }) => ({
    src,
    alt,
    width: naturalWidth,
    height: naturalHeight,
    hash,
  }));
}

// 全量提取：清空已提取记录，扫描所有图片
function extractImages() {
  extractedUrls.clear();
  const imgs = document.querySelectorAll('img');
  const results = [];
  for (const img of imgs) {
    const item = processImage(img, extractedUrls, false);
    if (item) results.push(item);
  }
  sortResults(results);
  return toOutput(results);
}

// 增量提取：只返回尚未提取过的新图片
function extractNewImages() {
  const imgs = document.querySelectorAll('img');
  const results = [];
  for (const img of imgs) {
    const item = processImage(img, extractedUrls, true);
    if (item) results.push(item);
  }
  sortResults(results);
  return toOutput(results);
}

// === DOM 变化监听：翻页/无限滚动后自动检测新图片 ===
function startWatching() {
  if (observer) return;

  observer = new MutationObserver(() => {
    clearTimeout(watchDebounceTimer);
    watchDebounceTimer = setTimeout(() => {
      const newImages = extractNewImages();
      if (newImages.length > 0) {
        chrome.runtime.sendMessage({
          type: 'NEW_IMAGES',
          images: newImages,
        }).catch(() => {});
      }
    }, 300);
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

function stopWatching() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  clearTimeout(watchDebounceTimer);
}

// 响应 popup 消息
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'EXTRACT_IMAGES':
      sendResponse({ images: extractImages() });
      break;
    case 'START_WATCHING':
      startWatching();
      break;
    case 'STOP_WATCHING':
      stopWatching();
      break;
    case 'POLL_NEW_IMAGES':
      sendResponse({ images: extractNewImages() });
      break;
  }
});

// 页面加载后自动提取图片并推送（侧边栏接收），翻页后自动触发
const autoImages = extractImages();
if (autoImages.length > 0) {
  chrome.runtime.sendMessage({
    type: 'IMAGES_EXTRACTED',
    images: autoImages,
  }).catch(() => {});
}
