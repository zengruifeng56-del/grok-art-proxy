import { readStream, log, clearLog, bus } from '../utils.js';

export function initVideoGen() {
    document.getElementById('btn-video-gen').onclick = generateVideo;

    // Listen for image selection
    bus.on('image-selected', (data) => {
        // Switch tab
        const tab = document.querySelector('.tab-btn[data-tab="video"]');
        if (tab) tab.click();

        // Update form
        document.getElementById('video-url').value = data.url;
        document.getElementById('video-post-id').value = data.job_id;

        // Update preview
        const preview = document.getElementById('video-preview');
        const imgSrc = data.image_src || data.url;
        preview.innerHTML = `
            <img src="${imgSrc}" alt="已选择">
            <div>
                <h3>已选择图片</h3>
                <p><strong>提示词:</strong> ${escapeHtml(data.prompt || '')}</p>
                <p><strong>尺寸:</strong> ${data.width}x${data.height}</p>
                <p><strong>ID:</strong> ${data.job_id}</p>
            </div>
        `;
        preview.style.display = 'flex';
    });
}

async function generateVideo() {
    const imageUrl = document.getElementById('video-url').value.trim();
    const postId = document.getElementById('video-post-id').value.trim();
    const prompt = document.getElementById('video-prompt').value.trim();

    if (!imageUrl || !postId) return alert('请先选择一张图片');
    if (!prompt) return alert('请输入动作提示词');

    const btn = document.getElementById('btn-video-gen');
    const progress = document.getElementById('video-progress');
    const result = document.getElementById('video-result');

    btn.disabled = true;
    progress.style.display = 'block';
    result.innerHTML = '';
    clearLog('video-log');

    log('video-log', `正在生成视频: "${prompt}"`);

    await readStream('/api/video/generate', {
        image_url: imageUrl,
        parent_post_id: postId,
        prompt: prompt,
        video_length: parseInt(document.getElementById('video-len').value),
        resolution: document.getElementById('video-res').value,
        mode: document.getElementById('video-mode').value
    }, {
        onProgress: (data) => {
            progress.querySelector('.progress-fill').style.width = data.progress + '%';
            log('video-log', `进度: ${data.progress}%`);
        },
        onData: (data) => {
            if (data.type === 'complete') {
                showResult(data.video_url);
                log('video-log', '视频生成完成', 'success');
            }
        },
        onInfo: (data) => log('video-log', `信息: ${data.message}`),
        onError: (msg) => log('video-log', `错误: ${msg}`, 'error'),
        onDone: () => {
            btn.disabled = false;
            progress.style.display = 'none';
        }
    });
}

function showResult(url) {
    const result = document.getElementById('video-result');
    result.innerHTML = `
        <h3 style="color:var(--color-success); margin-bottom:15px;">生成成功</h3>
        <video controls autoplay loop src="${url}"></video>
        <div style="margin-top:20px; display:flex; justify-content:center; gap:10px; flex-wrap:wrap;">
            <button id="btn-video-download" class="btn btn-secondary">下载视频</button>
            <a href="${url}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary">新窗口播放</a>
        </div>
    `;

    const downloadBtn = document.getElementById('btn-video-download');
    if (downloadBtn) {
        downloadBtn.addEventListener('click', () => {
            downloadVideo(url);
        });
    }
}

async function downloadVideo(url) {
    const downloadBtn = document.getElementById('btn-video-download');
    if (downloadBtn) {
        downloadBtn.disabled = true;
        downloadBtn.textContent = '下载中...';
    }

    try {
        const res = await fetch(url);
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }

        const blob = await res.blob();
        const ext = getVideoExtension(blob, url);
        const fileName = `grok-video-${Date.now()}.${ext}`;
        triggerBlobDownload(blob, fileName);
        log('video-log', '视频下载已开始', 'success');
    } catch (error) {
        log('video-log', `视频下载失败: ${error?.message || String(error)}`, 'error');
        window.open(url, '_blank', 'noopener,noreferrer');
    } finally {
        if (downloadBtn) {
            downloadBtn.disabled = false;
            downloadBtn.textContent = '下载视频';
        }
    }
}

function getVideoExtension(blob, fallbackUrl = '') {
    const t = String(blob?.type || '').toLowerCase();
    if (t.includes('mp4')) return 'mp4';
    if (t.includes('webm')) return 'webm';
    if (t.includes('quicktime') || t.includes('mov')) return 'mov';

    const m = String(fallbackUrl).match(/\.([a-zA-Z0-9]+)(?:$|\?)/);
    if (m && m[1]) return m[1].toLowerCase();
    return 'mp4';
}

function triggerBlobDownload(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
