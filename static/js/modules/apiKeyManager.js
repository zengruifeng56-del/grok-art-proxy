import { api } from '../utils.js';

let allKeys = [];
let allModels = [];

export async function initApiKeyManager() {
    await loadApiKeys();

    document.getElementById('btn-create-apikey').onclick = createApiKey;
    document.getElementById('btn-copy-apikey').onclick = copyNewKey;

    const btnModelRefresh = document.getElementById('btn-model-refresh');
    const btnModelResolve = document.getElementById('btn-model-resolve');
    const btnModelChatTest = document.getElementById('btn-model-chat-test');
    const modelTypeFilter = document.getElementById('model-type-filter');
    const modelSelect = document.getElementById('model-select');
    const modelResolveInput = document.getElementById('model-resolve-input');
    const modelTestKeyword = document.getElementById('model-test-keyword');

    if (
        btnModelRefresh &&
        btnModelResolve &&
        btnModelChatTest &&
        modelTypeFilter &&
        modelSelect &&
        modelResolveInput &&
        modelTestKeyword
    ) {
        btnModelRefresh.onclick = () => loadModelCatalog(true);
        btnModelResolve.onclick = resolveModelMapping;
        btnModelChatTest.onclick = testModelConnectivity;
        modelTypeFilter.onchange = () => loadModelCatalog(false);
        modelSelect.onchange = () => {
            modelResolveInput.value = modelSelect.value || '';
        };
        modelResolveInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                resolveModelMapping();
            }
        });

        await loadModelCatalog(true);
    }
}

async function loadApiKeys() {
    try {
        const data = await api('/api/keys');
        allKeys = data.keys || [];
        updateStats(data);
        renderKeyList(allKeys);
    } catch (e) {
        console.error('加载 API 密钥失败', e);
    }
}

function updateStats(data) {
    document.getElementById('apikey-stat-total').textContent = data.total || 0;
    document.getElementById('apikey-stat-enabled').textContent = data.enabled || 0;
}

function renderKeyList(keys) {
    const list = document.getElementById('apikey-list');
    if (!keys || keys.length === 0) {
        list.innerHTML = '<div class="empty-state">暂无 API 密钥，请创建一个</div>';
        return;
    }

    list.innerHTML = keys.map(k => `
        <div class="token-item">
            <div class="token-info">
                <div class="token-name">
                    ${k.name || '未命名密钥'}
                </div>
                <div class="token-meta">
                    密钥: ${k.key} | 调用次数: ${k.usage_count} | 今日: ${k.daily_usage}${k.rate_limit > 0 ? '/' + k.rate_limit : ''}
                </div>
                <div class="token-meta" style="font-size:0.75rem; color:#888;">
                    创建于: ${formatDate(k.created_at)}${k.last_used_at ? ' | 最后使用: ' + formatDate(k.last_used_at) : ''}
                </div>
            </div>
            <span class="status-badge ${k.enabled ? 'active' : 'inactive'}">${k.enabled ? '启用' : '禁用'}</span>
            <button class="btn btn-secondary btn-sm" onclick="window.toggleApiKey('${k.id}', ${!k.enabled})">${k.enabled ? '禁用' : '启用'}</button>
            <button class="btn btn-danger btn-sm" onclick="window.deleteApiKey('${k.id}')">删除</button>
        </div>
    `).join('');
}

function formatDate(isoString) {
    if (!isoString) return '-';
    const d = new Date(isoString);
    return d.toLocaleDateString('zh-CN') + ' ' + d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
}

function getModelTypeFilter() {
    const el = document.getElementById('model-type-filter');
    const value = el ? String(el.value || 'all') : 'all';
    if (value === 'text' || value === 'image' || value === 'video') {
        return value;
    }
    return 'all';
}

async function loadModelCatalog(forceSync = false) {
    const btn = document.getElementById('btn-model-refresh');
    const modelSelect = document.getElementById('model-select');
    const modelResolveInput = document.getElementById('model-resolve-input');
    const resultEl = document.getElementById('model-resolve-result');

    if (!modelSelect || !modelResolveInput || !resultEl) return;

    if (btn) {
        btn.disabled = true;
        btn.textContent = '刷新中...';
    }

    try {
        const type = getModelTypeFilter();
        const query = new URLSearchParams();
        if (type !== 'all') {
            query.set('type', type);
        }
        if (forceSync) {
            query.set('sync', '1');
        }

        const url = query.size > 0 ? `/api/models?${query.toString()}` : '/api/models';
        const data = await api(url);
        allModels = Array.isArray(data.models) ? data.models : [];

        renderModelOptions(allModels);

        if (allModels.length > 0) {
            const current = modelSelect.value;
            if (!current) {
                modelSelect.value = allModels[0].id;
            }
            if (!modelResolveInput.value.trim()) {
                modelResolveInput.value = modelSelect.value || allModels[0].id;
            }
        } else {
            modelResolveInput.value = '';
        }

        const hint = {
            type,
            total: allModels.length,
            example: allModels[0]?.id || 'grok-4*',
            xai: data.xai || null,
        };
        resultEl.textContent = JSON.stringify(hint, null, 2);
    } catch (e) {
        if (resultEl) {
            resultEl.textContent = `加载模型目录失败: ${e.message || e}`;
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '刷新模型';
        }
    }
}

function renderModelOptions(models) {
    const modelSelect = document.getElementById('model-select');
    if (!modelSelect) return;

    modelSelect.innerHTML = '';

    if (!models || models.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = '(no models)';
        modelSelect.appendChild(opt);
        return;
    }

    for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = `[${m.type}] ${m.id} -> ${m.grok_model} / ${m.model_mode}`;
        modelSelect.appendChild(opt);
    }
}

async function resolveModelMapping() {
    const inputEl = document.getElementById('model-resolve-input');
    const resultEl = document.getElementById('model-resolve-result');
    const btn = document.getElementById('btn-model-resolve');

    if (!inputEl || !resultEl) return;

    const model = String(inputEl.value || '').trim();
    if (!model) {
        alert('请输入模型名称或通配符');
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.textContent = '解析中...';
    }

    try {
        const type = getModelTypeFilter();
        const query = new URLSearchParams();
        query.set('model', model);
        if (type !== 'all') {
            query.set('type', type);
        }

        const data = await api(`/api/models/resolve?${query.toString()}`);
        const output = {
            requested: data.requested,
            resolved: data.resolved,
            candidates: data.candidates || [],
        };
        resultEl.textContent = JSON.stringify(output, null, 2);
    } catch (e) {
        resultEl.textContent = `模型映射失败: ${e.message || e}`;
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '测试映射';
        }
    }
}

async function testModelConnectivity() {
    const modelResolveInput = document.getElementById('model-resolve-input');
    const modelSelect = document.getElementById('model-select');
    const keywordInput = document.getElementById('model-test-keyword');
    const resultEl = document.getElementById('model-chat-test-result');
    const btn = document.getElementById('btn-model-chat-test');

    if (!modelResolveInput || !modelSelect || !keywordInput || !resultEl) return;

    const model = String(modelResolveInput.value || modelSelect.value || '').trim();
    const keyword = String(keywordInput.value || '').trim() || 'MODEL_OK';

    if (!model) {
        alert('请先选择或输入模型');
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.textContent = '测试中...';
    }
    resultEl.textContent = '正在发送短消息进行连通检测...';

    try {
        const data = await api('/api/models/test', 'POST', { model, keyword });
        resultEl.textContent = JSON.stringify(data, null, 2);
    } catch (e) {
        resultEl.textContent = `模型连通测试失败: ${e.message || e}`;
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '测试模型对话连通';
        }
    }
}

async function createApiKey() {
    const nameInput = document.getElementById('apikey-name');
    const name = nameInput.value.trim();
    const btn = document.getElementById('btn-create-apikey');

    btn.disabled = true;
    btn.textContent = '创建中...';

    try {
        const res = await api('/api/keys', 'POST', { name });
        if (res.success && res.key) {
            const display = document.getElementById('new-apikey-display');
            const valueEl = document.getElementById('new-apikey-value');
            valueEl.textContent = res.key.key;
            display.style.display = 'block';

            nameInput.value = '';
            await loadApiKeys();
        } else {
            alert('创建失败: ' + (res.error || '未知错误'));
        }
    } catch (e) {
        alert('创建失败: ' + e.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '创建密钥';
    }
}

function copyNewKey() {
    const keyValue = document.getElementById('new-apikey-value').textContent;
    navigator.clipboard.writeText(keyValue).then(() => {
        const btn = document.getElementById('btn-copy-apikey');
        btn.textContent = '已复制';
        setTimeout(() => {
            btn.textContent = '复制密钥';
        }, 2000);
    }).catch(e => {
        alert('复制失败: ' + e.message);
    });
}

window.deleteApiKey = async (id) => {
    if (!confirm('确定删除此 API 密钥？删除后使用该密钥的服务将无法访问')) return;
    try {
        await api(`/api/keys/${id}`, 'DELETE');
        await loadApiKeys();
    } catch (e) {
        alert('删除失败: ' + e.message);
    }
};

window.toggleApiKey = async (id, enabled) => {
    try {
        await api(`/api/keys/${id}`, 'PATCH', { enabled });
        await loadApiKeys();
    } catch (e) {
        alert('操作失败: ' + e.message);
    }
};
