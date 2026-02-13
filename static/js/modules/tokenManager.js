import { api, log, clearLog, bus } from '../utils.js';

const PAGE_SIZE = 100;
let allTokens = [];
let currentPage = 1;

export async function initTokenManager() {
    // Initial Load
    await loadTokens();
    await loadGlobalCfClearance();

    // Event Listeners
    document.getElementById('btn-import-tokens').onclick = importTokens;
    document.getElementById('btn-clear-tokens').onclick = clearAllTokens;
    document.getElementById('btn-nsfw-all').onclick = enableNsfwAll;
    document.getElementById('btn-export-tokens').onclick = exportTokens;
    document.getElementById('btn-save-global-cf').onclick = saveGlobalCfClearance;

    // Listen for refresh requests
    bus.on('refresh-tokens', loadTokens);
}

async function loadTokens() {
    try {
        const data = await api('/api/tokens');
        allTokens = data.tokens || [];
        updateStats(data);
        currentPage = 1;
        renderCurrentPage();
    } catch (e) {
        console.error('加载令牌失败', e);
    }
}

async function loadGlobalCfClearance() {
    try {
        const data = await api('/api/settings/cf-clearance');
        const input = document.getElementById('global-cf-clearance');
        if (input) {
            input.value = data.cf_clearance || '';
        }
    } catch (e) {
        console.error('加载全局 cf_clearance 失败', e);
    }
}

function updateStats(data) {
    document.getElementById('stat-total').textContent = data.total;
    document.getElementById('stat-active').textContent = data.active;
}

function renderCurrentPage() {
    const totalPages = Math.ceil(allTokens.length / PAGE_SIZE);
    const start = (currentPage - 1) * PAGE_SIZE;
    const end = start + PAGE_SIZE;
    const pageTokens = allTokens.slice(start, end);

    renderTokenList(pageTokens);
    renderPagination(totalPages);
}

function renderTokenList(tokens) {
    const list = document.getElementById('token-list');
    if (!tokens || tokens.length === 0) {
        list.innerHTML = '<div class="empty-state">暂无令牌，请先导入</div>';
        return;
    }

    list.innerHTML = tokens.map(t => `
        <div class="token-item">
            <div class="token-info">
                <div class="token-name">
                    ${t.name}
                    ${t.nsfw_enabled ? '<span class="status-badge active" style="font-size: 0.6em; padding: 2px 5px; margin-left: 5px;">NSFW</span>' : ''}
                </div>
                <div class="token-meta">
                    使用次数: ${t.use_count}
                </div>
            </div>
            <span class="status-badge ${t.status}">${t.status === 'active' ? '活跃' : t.status}</span>
            <button class="btn btn-secondary btn-sm" onclick="window.deleteToken('${t.id}')">删除</button>
        </div>
    `).join('');
}

function renderPagination(totalPages) {
    const container = document.getElementById('token-pagination');

    if (totalPages <= 1) {
        container.innerHTML = '';
        return;
    }

    let html = '';

    // Previous button
    html += `<button class="btn btn-sm ${currentPage === 1 ? '' : 'btn-secondary'}"
        ${currentPage === 1 ? 'disabled' : ''}
        onclick="window.goToTokenPage(${currentPage - 1})">上一页</button>`;

    // Page numbers
    const maxVisiblePages = 5;
    let startPage = Math.max(1, currentPage - Math.floor(maxVisiblePages / 2));
    let endPage = Math.min(totalPages, startPage + maxVisiblePages - 1);

    if (endPage - startPage < maxVisiblePages - 1) {
        startPage = Math.max(1, endPage - maxVisiblePages + 1);
    }

    if (startPage > 1) {
        html += `<button class="btn btn-sm btn-secondary" onclick="window.goToTokenPage(1)">1</button>`;
        if (startPage > 2) {
            html += `<span style="padding: 0 5px;">...</span>`;
        }
    }

    for (let i = startPage; i <= endPage; i++) {
        if (i === currentPage) {
            html += `<button class="btn btn-sm" disabled style="background:var(--color-accent);color:white;">${i}</button>`;
        } else {
            html += `<button class="btn btn-sm btn-secondary" onclick="window.goToTokenPage(${i})">${i}</button>`;
        }
    }

    if (endPage < totalPages) {
        if (endPage < totalPages - 1) {
            html += `<span style="padding: 0 5px;">...</span>`;
        }
        html += `<button class="btn btn-sm btn-secondary" onclick="window.goToTokenPage(${totalPages})">${totalPages}</button>`;
    }

    // Next button
    html += `<button class="btn btn-sm ${currentPage === totalPages ? '' : 'btn-secondary'}"
        ${currentPage === totalPages ? 'disabled' : ''}
        onclick="window.goToTokenPage(${currentPage + 1})">下一页</button>`;

    // Page info
    const start = (currentPage - 1) * PAGE_SIZE + 1;
    const end = Math.min(currentPage * PAGE_SIZE, allTokens.length);
    html += `<span style="margin-left:15px; font-size:0.9rem; color:#666;">
        显示 ${start}-${end} / 共 ${allTokens.length} 个
    </span>`;

    container.innerHTML = html;
}

// Global function for pagination
window.goToTokenPage = (page) => {
    const totalPages = Math.ceil(allTokens.length / PAGE_SIZE);
    if (page < 1 || page > totalPages) return;
    currentPage = page;
    renderCurrentPage();
    // Scroll to top of token list
    document.getElementById('token-list').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

// Global scope for inline onclick handlers
window.deleteToken = async (id) => {
    if (!confirm('确定删除此令牌？此操作不可撤销')) return;
    try {
        await api(`/api/tokens/${id}`, 'DELETE');
        loadTokens();
    } catch (e) {
        alert('删除失败: ' + e.message);
    }
};

async function importTokens() {
    const text = document.getElementById('input-tokens').value.trim();
    if (!text) return alert('请输入内容');

    const btn = document.getElementById('btn-import-tokens');
    btn.disabled = true;
    btn.textContent = '导入中...';

    try {
        const res = await api('/api/tokens/import', 'POST', { text });
        if (res.success) {
            alert(`成功导入 ${res.imported} 个令牌`);
            document.getElementById('input-tokens').value = '';
            loadTokens();
        } else {
            alert(res.error || '导入失败');
        }
    } catch (e) {
        alert('导入失败: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '导入数据';
    }
}

async function saveGlobalCfClearance() {
    const input = document.getElementById('global-cf-clearance');
    const btn = document.getElementById('btn-save-global-cf');
    const cfClearance = (input?.value || '').trim();

    btn.disabled = true;
    btn.textContent = '保存中...';

    try {
        const res = await api('/api/settings/cf-clearance', 'POST', {
            cf_clearance: cfClearance,
        });
        if (res.success) {
            alert('全局 cf_clearance 已保存');
        } else {
            alert(res.error || '保存失败');
        }
    } catch (e) {
        alert('保存失败: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save cf_clearance';
    }
}

async function exportTokens() {
    if (allTokens.length === 0) {
        return alert('暂无令牌可导出');
    }

    try {
        // 调用后端导出 API 获取完整数据
        const data = await api('/api/tokens/export');

        if (!data.tokens || data.tokens.length === 0) {
            return alert('暂无令牌可导出');
        }

        // 导出为 JSON 数组格式
        const exportData = JSON.stringify(data.tokens, null, 2);

        // Create and download file
        const blob = new Blob([exportData], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `grok-tokens-${new Date().toISOString().slice(0,10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        alert(`已导出 ${data.tokens.length} 个令牌`);
    } catch (e) {
        alert('导出失败: ' + e.message);
    }
}

async function clearAllTokens() {
    if (!confirm('确定清空所有令牌？')) return;
    try {
        await api('/api/tokens', 'DELETE');
        loadTokens();
    } catch (e) {
        alert('操作失败: ' + e.message);
    }
}

async function enableNsfwAll() {
    if (!confirm('确定为所有令牌启用 NSFW？')) return;

    const progress = document.getElementById('nsfw-progress');
    const bar = progress.querySelector('.progress-fill');
    const logId = 'nsfw-log';

    progress.style.display = 'block';
    bar.style.width = '0%';
    document.getElementById(logId).style.display = 'block';
    clearLog(logId);
    log(logId, '开始批量启用 NSFW...');

    let offset = 0;
    let totalSuccess = 0;
    let totalFail = 0;

    try {
        while (true) {
            const response = await fetch('/api/tokens/enable-nsfw', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ offset })
            });

            const data = await response.json();

            if (!data.success) {
                log(logId, `错误: ${data.error || '未知错误'}`, 'error');
                break;
            }

            // Log results for this batch
            if (data.results) {
                for (const r of data.results) {
                    if (r.success) {
                        log(logId, `[成功] ${r.name}`, 'success');
                    } else {
                        log(logId, `[失败] ${r.name}: ${r.message}`, 'error');
                    }
                }
            }

            totalSuccess += data.success_count || 0;
            totalFail += data.fail_count || 0;

            // Update progress
            const percentage = data.total > 0 ? (data.processed / data.total) * 100 : 100;
            bar.style.width = percentage + '%';

            if (data.done) {
                log(logId, `批量完成! 成功: ${totalSuccess}, 失败: ${totalFail}`, 'success');
                loadTokens();
                break;
            }

            // Continue with next batch
            offset = data.next_offset;
            log(logId, `已处理 ${data.processed}/${data.total}，继续下一批...`);

            // Minimal delay between batches (just for UI responsiveness)
            await new Promise(r => setTimeout(r, 100));
        }
    } catch (e) {
        log(logId, '错误: ' + e.message, 'error');
    } finally {
        setTimeout(() => progress.style.display = 'none', 2000);
    }
}
