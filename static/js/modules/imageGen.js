import { readStream, log, clearLog, bus } from '../utils.js';

let currentPrompt = '';
let currentAspect = '2:3';
let currentNsfw = true;
let loadedUrls = new Set();
let isLoading = false;

let batchMode = false;
const batchSelected = new Set();
const imageDataMap = new Map();
const imageCardMap = new Map();

export function initImageGen() {
    document.getElementById('btn-generate').onclick = startGeneration;
    document.getElementById('btn-load-more').onclick = loadMore;

    const batchModeBtn = document.getElementById('btn-image-batch-mode');
    const selectAllBtn = document.getElementById('btn-image-select-all');
    const downloadSelectedBtn = document.getElementById('btn-image-download-selected');

    if (batchModeBtn) batchModeBtn.onclick = toggleBatchMode;
    if (selectAllBtn) selectAllBtn.onclick = toggleSelectAllBatch;
    if (downloadSelectedBtn) downloadSelectedBtn.onclick = downloadSelectedImages;

    // Hide load more initially
    toggleLoadMore(false);
    setBatchMode(false);
}

async function startGeneration() {
    const prompt = document.getElementById('input-prompt').value.trim();
    if (!prompt) return alert('请输入提示词');

    currentPrompt = prompt;
    currentAspect = document.getElementById('select-aspect').value;
    currentNsfw = document.getElementById('select-nsfw').value === 'true';
    const count = parseInt(document.getElementById('input-count').value) || 10;

    // Reset UI and state
    const grid = document.getElementById('image-grid');
    grid.innerHTML = '';
    loadedUrls.clear();
    batchSelected.clear();
    imageDataMap.clear();
    imageCardMap.clear();
    clearLog('gen-log');
    toggleLoadMore(false);
    setBatchMode(false);
    setLoading(true, '正在生成...');

    log('gen-log', `生成中: "${prompt}" [目标: ${count}张]`);

    await readStream('/api/imagine/generate', {
        prompt: currentPrompt,
        aspect_ratio: currentAspect,
        enable_nsfw: currentNsfw,
        count: count
    }, {
        onProgress: (data) => {
            updateProgress(data.percentage);
            if (data.status) log('gen-log', `状态: ${data.status}`);
        },
        onData: (data) => {
            if (data.type === 'image' && !loadedUrls.has(data.url)) {
                loadedUrls.add(data.url);
                addImageCard(data);
            }
        },
        onInfo: (data) => log('gen-log', `信息: ${data.message}`),
        onError: (msg) => log('gen-log', `错误: ${msg}`, 'error'),
        onDone: () => {
            setLoading(false);
            toggleLoadMore(true);
            log('gen-log', '生成完成', 'success');
        }
    });
}

async function loadMore() {
    if (isLoading) return;

    setLoading(true, '加载更多...');
    toggleLoadMore(false);
    log('gen-log', '正在加载更多结果...');

    await readStream('/api/imagine/scroll', {
        prompt: currentPrompt,
        aspect_ratio: currentAspect,
        enable_nsfw: currentNsfw,
        max_pages: 1
    }, {
        onData: (data) => {
            if (data.type === 'image' && !loadedUrls.has(data.url)) {
                loadedUrls.add(data.url);
                addImageCard(data);
            }
        },
        onError: (msg) => log('gen-log', `错误: ${msg}`, 'error'),
        onDone: () => {
            setLoading(false);
            toggleLoadMore(true);
            log('gen-log', '加载完成', 'success');
        }
    });
}

function addImageCard(data) {
    const grid = document.getElementById('image-grid');
    const card = document.createElement('div');
    card.className = 'image-card';
    card.dataset.imageKey = data.url;

    const imgSrc = data.image_src || data.url;
    card.innerHTML = `
        <img src="${imgSrc}" loading="lazy" alt="${escapeHtml(data.prompt || '')}">
        <div class="image-info">
            <div class="image-prompt" title="${escapeHtml(data.prompt || '')}">${escapeHtml(data.prompt || '')}</div>
            <div style="margin-top:5px; font-size:0.8em; color:#666;">
                ${data.width}x${data.height} | ID: ${data.job_id}
            </div>
            <div class="image-actions">
                <button class="btn btn-secondary btn-sm image-download-btn">下载图片</button>
            </div>
        </div>
    `;

    imageDataMap.set(data.url, data);
    imageCardMap.set(data.url, card);
    applyBatchModeStyle(card);

    const downloadBtn = card.querySelector('.image-download-btn');
    if (downloadBtn) {
        downloadBtn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            await downloadOneImage(data, card);
        });
    }

    card.addEventListener('click', () => {
        if (batchMode) {
            toggleBatchSelection(card);
            return;
        }

        // Default behavior: single-select for video generation
        document.querySelectorAll('.image-card.selected').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        bus.emit('image-selected', data);
    });

    grid.appendChild(card);
}

function setLoading(loading, text = '') {
    isLoading = loading;
    const btn = document.getElementById('btn-generate');
    const loadMoreBtn = document.getElementById('btn-load-more');
    const progress = document.getElementById('gen-progress');
    const label = document.getElementById('gen-status-text');

    btn.disabled = loading;
    if (loadMoreBtn) loadMoreBtn.disabled = loading;

    progress.style.display = loading ? 'block' : 'none';
    if (loading) {
        label.textContent = text;
        progress.querySelector('.progress-fill').style.width = '0%';
    } else {
        label.textContent = '';
    }
}

function updateProgress(percent) {
    const bar = document.querySelector('#gen-progress .progress-fill');
    if (bar) bar.style.width = percent + '%';
}

function toggleLoadMore(show) {
    const btn = document.getElementById('btn-load-more');
    if (btn) {
        btn.style.display = show ? 'inline-flex' : 'none';
        btn.disabled = false;
    }
}

function toggleBatchMode() {
    setBatchMode(!batchMode);
}

function setBatchMode(enabled) {
    batchMode = enabled;

    const modeBtn = document.getElementById('btn-image-batch-mode');
    const toolbar = document.getElementById('image-batch-toolbar');

    if (!enabled) {
        batchSelected.clear();
        document.querySelectorAll('.image-card.batch-selected').forEach(card => {
            card.classList.remove('batch-selected');
        });
    }

    document.querySelectorAll('.image-card').forEach(card => applyBatchModeStyle(card));
    updateBatchToolbar();

    if (modeBtn) {
        modeBtn.textContent = enabled ? '退出选择' : '批量选择';
    }
    if (toolbar) {
        toolbar.classList.toggle('active', enabled);
    }
}

function applyBatchModeStyle(card) {
    card.classList.toggle('batch-mode', batchMode);
}

function toggleBatchSelection(card) {
    const key = card.dataset.imageKey;
    if (!key) return;

    if (batchSelected.has(key)) {
        batchSelected.delete(key);
        card.classList.remove('batch-selected');
    } else {
        batchSelected.add(key);
        card.classList.add('batch-selected');
    }

    updateBatchToolbar();
}

function toggleSelectAllBatch() {
    if (!batchMode) return;

    const cards = Array.from(document.querySelectorAll('.image-card'));
    const allSelected = cards.length > 0 && batchSelected.size === cards.length;

    if (allSelected) {
        batchSelected.clear();
        cards.forEach(card => card.classList.remove('batch-selected'));
    } else {
        batchSelected.clear();
        cards.forEach(card => {
            const key = card.dataset.imageKey;
            if (!key) return;
            batchSelected.add(key);
            card.classList.add('batch-selected');
        });
    }

    updateBatchToolbar();
}

function updateBatchToolbar() {
    const countEl = document.getElementById('image-selected-count');
    const downloadBtn = document.getElementById('btn-image-download-selected');
    const selectAllBtn = document.getElementById('btn-image-select-all');

    if (countEl) countEl.textContent = String(batchSelected.size);
    if (downloadBtn) downloadBtn.disabled = batchSelected.size === 0;
    if (selectAllBtn) {
        const total = document.querySelectorAll('.image-card').length;
        const allSelected = total > 0 && batchSelected.size === total;
        selectAllBtn.textContent = allSelected ? '取消全选' : '全选';
    }
}

async function downloadSelectedImages() {
    if (batchSelected.size === 0) {
        alert('请先选择图片');
        return;
    }

    const button = document.getElementById('btn-image-download-selected');
    if (button) {
        button.disabled = true;
        button.textContent = '打包中...';
    }

    try {
        if (window.JSZip) {
            await downloadSelectedAsZip();
        } else {
            await downloadSelectedOneByOne();
        }
        log('gen-log', `批量下载完成: ${batchSelected.size} 张`, 'success');
    } catch (error) {
        log('gen-log', `批量下载失败: ${error?.message || String(error)}`, 'error');
        alert('批量下载失败，请重试');
    } finally {
        if (button) {
            button.disabled = batchSelected.size === 0;
            button.innerHTML = `下载已选 <span id="image-selected-count" class="image-selected-count">${batchSelected.size}</span>`;
        }
    }
}

async function downloadSelectedAsZip() {
    const zip = new window.JSZip();
    const folder = zip.folder('images');
    let index = 1;
    let addedCount = 0;

    for (const key of batchSelected) {
        const data = imageDataMap.get(key);
        if (!data) continue;

        const blob = await getImageBlob(data);
        if (!blob) continue;

        const ext = getBlobExtension(blob, data.url);
        const filename = buildImageFilename(data, index, ext);
        folder.file(filename, blob);
        index += 1;
        addedCount += 1;

        const button = document.getElementById('btn-image-download-selected');
        if (button) {
            button.textContent = `打包中...(${addedCount}/${batchSelected.size})`;
        }
    }

    if (addedCount === 0) {
        throw new Error('没有可下载的图片数据');
    }

    const content = await zip.generateAsync({ type: 'blob' });
    triggerBlobDownload(content, `grok-images-${new Date().toISOString().slice(0, 10)}.zip`);
}

async function downloadSelectedOneByOne() {
    let index = 1;
    for (const key of batchSelected) {
        const data = imageDataMap.get(key);
        if (!data) continue;
        await downloadOneImage(data, imageCardMap.get(key), index);
        index += 1;
        await sleep(80);
    }
}

async function downloadOneImage(data, card, fallbackIndex = 1) {
    try {
        const blob = await getImageBlob(data, card);
        if (!blob) throw new Error('图片数据为空');
        const ext = getBlobExtension(blob, data.url);
        const filename = buildImageFilename(data, fallbackIndex, ext);
        triggerBlobDownload(blob, filename);
        return true;
    } catch (error) {
        const link = document.createElement('a');
        link.href = data.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.click();
        return false;
    }
}

async function getImageBlob(data, card) {
    const imageEl = card?.querySelector?.('img');
    const imageSrc = data.image_src || imageEl?.src || data.url;

    if (typeof imageSrc === 'string' && imageSrc.startsWith('data:')) {
        return dataUrlToBlob(imageSrc);
    }

    if (typeof imageSrc === 'string' && imageSrc.startsWith('blob:')) {
        const res = await fetch(imageSrc);
        if (!res.ok) return null;
        return await res.blob();
    }

    try {
        const res = await fetch(data.url);
        if (!res.ok) return null;
        return await res.blob();
    } catch {
        return null;
    }
}

function dataUrlToBlob(dataUrl) {
    try {
        const [header, payload] = dataUrl.split(',');
        if (!header || !payload) return null;

        const mimeMatch = header.match(/data:(.*?);base64/);
        const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
        const binary = atob(payload);
        const len = binary.length;
        const bytes = new Uint8Array(len);

        for (let i = 0; i < len; i++) {
            bytes[i] = binary.charCodeAt(i);
        }

        return new Blob([bytes], { type: mime });
    } catch {
        return null;
    }
}

function buildImageFilename(data, index, ext) {
    const rawPrompt = String(data.prompt || '').trim();
    const safePrompt = rawPrompt
        .slice(0, 24)
        .replace(/[^a-zA-Z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '');
    const promptPart = safePrompt || 'image';
    const idPart = String(data.job_id || index);
    return `grok-${promptPart}-${idPart}.${ext}`;
}

function getBlobExtension(blob, fallbackUrl = '') {
    const t = String(blob?.type || '').toLowerCase();
    if (t.includes('png')) return 'png';
    if (t.includes('webp')) return 'webp';
    if (t.includes('gif')) return 'gif';
    if (t.includes('jpeg') || t.includes('jpg')) return 'jpg';

    const m = String(fallbackUrl).match(/\.([a-zA-Z0-9]+)(?:$|\?)/);
    if (m && m[1]) return m[1].toLowerCase();
    return 'jpg';
}

function triggerBlobDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
