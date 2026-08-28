/**
 * 数据管家 (Data Manager) — SillyTavern 第三方 UI 扩展
 *
 * 一个面板批量管理：预设 / 世界书 / 角色卡 / 用户设定(面具) / 聊天记录 / 主题美化 / 背景图片。
 * 功能：搜索筛选、多选批量删除、重命名、JSON 编辑、删除前自动备份、一键撤销、
 *       持久化删除历史（IndexedDB，可下载/还原）、新建面具自动备份、可切换配色主题。
 *
 * 面板用酒馆内置 Popup 承载，手机端全屏；写操作走官方接口或前端设置对象，不直接碰文件系统。
 */

const EXT_NAME = '数据管家';

function ctx() {
    // eslint-disable-next-line no-undef
    return SillyTavern.getContext();
}

function headers() {
    try {
        const c = ctx();
        if (typeof c.getRequestHeaders === 'function') return c.getRequestHeaders();
    } catch { /* 忽略 */ }
    return { 'Content-Type': 'application/json' };
}

function multipartHeaders() {
    const h = { ...headers() };
    delete h['Content-Type'];
    delete h['content-type'];
    return h;
}

async function post(url, body) {
    const res = await fetch(url, { method: 'POST', headers: headers(), body: JSON.stringify(body ?? {}) });
    if (!res.ok) throw new Error(`${url} 返回 ${res.status}`);
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
}

function toast(msg, type = 'info') {
    try {
        // eslint-disable-next-line no-undef
        toastr[type](msg, EXT_NAME);
    } catch {
        console.log(`[${EXT_NAME}] ${msg}`);
    }
}

function downloadText(filename, text) {
    downloadBlob(filename, new Blob([text], { type: 'application/json' }));
}

function downloadBlob(filename, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

function blobToDataURL(blob) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(blob);
    });
}

function dataURLToBlob(dataURL) {
    const [meta, b64] = String(dataURL).split(',');
    const mime = (meta.match(/:(.*?);/) || [])[1] || 'application/octet-stream';
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
}

function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function fmtTime(v) {
    const d = new Date(v);
    if (isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ------------------------------------------------------------------ *
 *  IndexedDB —— 持久化删除历史
 * ------------------------------------------------------------------ */

const DB_NAME = 'stdm_data_manager';
const DB_STORE = 'history';
const HISTORY_MAX = 60;
// 回收站过期天数,默认 7 天
const RECYCLE_EXPIRE_DAYS = 7;
const RECYCLE_EXPIRE_MS = RECYCLE_EXPIRE_DAYS * 24 * 60 * 60 * 1000;

function openDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function dbPut(rec) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).put(rec);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function dbGetAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readonly');
        const r = tx.objectStore(DB_STORE).getAll();
        r.onsuccess = () => resolve(r.result || []);
        r.onerror = () => reject(r.error);
    });
}

async function dbDelete(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).delete(id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function dbClear() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(DB_STORE, 'readwrite');
        tx.objectStore(DB_STORE).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

let __idCounter = 0;
function genId() { return Date.now() * 1000 + ((__idCounter++) % 1000); }

async function trimHistory() {
    const all = await dbGetAll();
    const now = Date.now();
    // 先清掉过期的回收站条目(非 auto 的才算回收站,auto 的是自动备份不过期)
    for (const r of all) {
        if (!r.auto && r.time) {
            const t = new Date(r.time).getTime();
            if (!isNaN(t) && now - t > RECYCLE_EXPIRE_MS) {
                await dbDelete(r.id);
                try { await ttStoreDelete(r.id); } catch { /* 忽略 */ }
            }
        }
    }
    // 再按数量上限清理
    const remain = await dbGetAll();
    if (remain.length > HISTORY_MAX) {
        remain.sort((a, b) => a.id - b.id);
        for (const r of remain.slice(0, remain.length - HISTORY_MAX)) {
            await dbDelete(r.id);
            try { await ttStoreDelete(r.id); } catch { /* 忽略 */ }
        }
    }
}

async function saveHistory(tab, entries, opts = {}) {
    const rec = {
        id: genId(),
        time: new Date().toISOString(),
        tab,
        label: adapters[tab].label,
        count: entries.length,
        names: entries.map(e => e.name),
        auto: !!opts.auto,
        entries,
    };
    // 双写:TauriTavern extension.store(优先,跨设备)+ IndexedDB(fallback)
    try { await ttStoreSet(rec.id, rec); } catch { /* 忽略 */ }
    try { await dbPut(rec); await trimHistory(); }
    catch (e) { console.warn('[数据管家] 写入历史失败', e); }
}

/* ------------------------------------------------------------------ *
 *  数据适配层
 * ------------------------------------------------------------------ */

const PRESET_KINDS = [
    { apiId: 'openai', label: '聊天补全预设 (OpenAI/Claude 等)', namesKey: 'openai_setting_names', dataKey: 'openai_settings' },
    { apiId: 'textgenerationwebui', label: '文本补全预设 (TextGen)', namesKey: 'textgenerationwebui_preset_names', dataKey: 'textgenerationwebui_presets' },
    { apiId: 'novel', label: 'NovelAI 预设', namesKey: 'novelai_setting_names', dataKey: 'novelai_settings' },
    { apiId: 'kobold', label: 'KoboldAI 预设', namesKey: 'koboldai_setting_names', dataKey: 'koboldai_settings' },
    { apiId: 'instruct', label: '指令模板 (Instruct)', objectsKey: 'instruct' },
    { apiId: 'context', label: '上下文模板 (Context)', objectsKey: 'context' },
    { apiId: 'sysprompt', label: '系统提示词 (SysPrompt)', objectsKey: 'sysprompt' },
    { apiId: 'reasoning', label: '推理格式 (Reasoning)', objectsKey: 'reasoning' },
];

let settingsCache = null;
async function getSettings(force = false) {
    if (!settingsCache || force) settingsCache = await post('/api/settings/get', {});
    return settingsCache;
}

const adapters = {
    presets: {
        label: '预设',
        editable: true,
        renamable: true,
        async load() {
            const s = await getSettings(true);
            const items = [];
            // 默认折叠除"聊天补全预设(apiId=openai)"外的所有分组,用 apiId 判断,不受界面语言影响
            const DEFAULT_OPEN_API_ID = 'openai';
            state.collapsedGroups = new Set();
            for (const kind of PRESET_KINDS) {
                if (kind.apiId !== DEFAULT_OPEN_API_ID) state.collapsedGroups.add(kind.label);
                if (kind.objectsKey) {
                    const arr = Array.isArray(s?.[kind.objectsKey]) ? s[kind.objectsKey] : [];
                    for (const obj of arr) {
                        if (!obj?.name) continue;
                        items.push({ id: `${kind.apiId}::${obj.name}`, name: obj.name, group: kind.label, apiId: kind.apiId, inline: obj });
                    }
                } else {
                    const names = Array.isArray(s?.[kind.namesKey]) ? s[kind.namesKey] : [];
                    const datas = Array.isArray(s?.[kind.dataKey]) ? s[kind.dataKey] : [];
                    names.forEach((name, i) => {
                        let parsed = null;
                        try { parsed = JSON.parse(datas[i]); } catch { /* 忽略 */ }
                        items.push({ id: `${kind.apiId}::${name}`, name, group: kind.label, apiId: kind.apiId, inline: parsed });
                    });
                }
            }
            state.collapseEnabled = true;
            return items;
        },
        async read(item) { return item.inline ?? {}; },
        async write(item, data) { await post('/api/presets/save', { name: item.name, apiId: item.apiId, preset: data }); },
        async remove(item) { await post('/api/presets/delete', { name: item.name, apiId: item.apiId }); },
        async rename(item, newName) {
            const data = await this.read(item);
            await post('/api/presets/save', { name: newName, apiId: item.apiId, preset: data });
            await post('/api/presets/delete', { name: item.name, apiId: item.apiId });
        },
        async restore(backup) { await post('/api/presets/save', { name: backup.name, apiId: backup.apiId, preset: backup.data }); },
        backupOf(item, data) { return { name: item.name, apiId: item.apiId, data }; },
    },

    worlds: {
        label: '世界书',
        editable: true,
        renamable: true,
        async load() {
            // 优先走前端 context 的 getWorldInfoNames(官方 ST 与 TauriTavern 都支持;
            // TauriTavern 没有 /api/worldinfo/list 接口,直接调会 404)
            try {
                const c = ctx();
                if (typeof c.getWorldInfoNames === 'function') {
                    const names = c.getWorldInfoNames();
                    if (Array.isArray(names)) {
                        return names.map(n => ({ id: n, name: n, group: '世界书 / 知识书', meta: '' }));
                    }
                }
            } catch (e) { console.warn('[数据管家] getWorldInfoNames 读取失败', e); }
            // 其次用 settings 里的 world_names(兼容没有 getWorldInfoNames 的旧版)
            try {
                const s = await getSettings(true);
                if (s && Array.isArray(s.world_names)) {
                    return s.world_names.map(n => ({ id: n, name: n, group: '世界书 / 知识书', meta: '' }));
                }
            } catch (e) { console.warn('[数据管家] world_names 读取失败,改用 list 接口', e); }
            const list = await post('/api/worldinfo/list', {});
            const arr = Array.isArray(list) ? list : [];
            return arr.map(w => ({
                id: w.file_id,
                name: w.file_id,
                group: '世界书 / 知识书',
                meta: w.name && w.name !== w.file_id ? `内部名: ${w.name}` : '',
            }));
        },
        async read(item) {
            try {
                return await post('/api/worldinfo/get', { name: item.name });
            } catch (e) {
                // 极老版本没有 /api/worldinfo/get,fallback 到 context 的 loadWorldInfo
                const c = ctx();
                if (typeof c.loadWorldInfo === 'function') {
                    console.warn('[数据管家] /api/worldinfo/get 失败,fallback 到 loadWorldInfo', e);
                    return await c.loadWorldInfo(item.name);
                }
                throw e;
            }
        },
        async write(item, data) {
            try {
                await post('/api/worldinfo/edit', { name: item.name, data });
            } catch (e) {
                const c = ctx();
                if (typeof c.saveWorldInfo === 'function') {
                    console.warn('[数据管家] /api/worldinfo/edit 失败,fallback 到 saveWorldInfo', e);
                    await c.saveWorldInfo(item.name, data, true);
                    return;
                }
                throw e;
            }
        },
        async remove(item) { await post('/api/worldinfo/delete', { name: item.name }); },
        async rename(item, newName) {
            const data = await this.read(item);
            await post('/api/worldinfo/edit', { name: newName, data });
            await post('/api/worldinfo/delete', { name: item.name });
        },
        async restore(backup) { await post('/api/worldinfo/edit', { name: backup.name, data: backup.data }); },
        backupOf(item, data) { return { name: item.name, data }; },
    },

    characters: {
        label: '角色卡',
        editable: false,
        renamable: false,
        isCharacter: true,
        async load() {
            const all = await post('/api/characters/all', { shallow: true });
            const arr = Array.isArray(all) ? all : [];
            return arr.map(c => ({
                id: c.avatar,
                name: c.name || c.avatar,
                group: '角色卡',
                avatar: c.avatar,
                meta: c.create_date ? String(c.create_date).split('@')[0] : '',
                thumb: `/thumbnail?type=avatar&file=${encodeURIComponent(c.avatar)}`,
            }));
        },
        async fetchCardBlob(item) {
            const res = await fetch('/api/characters/export', {
                method: 'POST', headers: headers(),
                body: JSON.stringify({ format: 'png', avatar_url: item.avatar }),
            });
            if (!res.ok) throw new Error(`导出接口返回 ${res.status}`);
            return await res.blob();
        },
        async read(item) { const blob = await this.fetchCardBlob(item); return { png: await blobToDataURL(blob) }; },
        async exportBlob(item) { const blob = await this.fetchCardBlob(item); return { blob, filename: item.avatar }; },
        backupOf(item, data) { return { name: item.name, avatar: item.avatar, png: data.png }; },
        async restore(backup) {
            const blob = dataURLToBlob(backup.png);
            const fd = new FormData();
            fd.append('avatar', blob, backup.avatar || `${backup.name || 'character'}.png`);
            fd.append('file_type', 'png');
            const res = await fetch('/api/characters/import', { method: 'POST', headers: multipartHeaders(), body: fd });
            if (!res.ok) throw new Error(`导入返回 ${res.status}`);
        },
        async remove(item, opts = {}) {
            await post('/api/characters/delete', { avatar_url: item.avatar, delete_chats: !!opts.deleteChats });
        },
    },

    personas: {
        label: '用户设定 / 面具',
        editable: false,
        renamable: true,
        isPersona: true,
        _pu() { return ctx().powerUserSettings || {}; },
        async load() {
            const pu = this._pu();
            const personas = pu.personas || {};
            const descs = pu.persona_descriptions || {};
            return Object.keys(personas).map(id => ({
                id, name: personas[id] || id, avatar: id,
                group: '用户设定 / 面具 (Persona)',
                thumb: `/thumbnail?type=persona&file=${encodeURIComponent(id)}`,
                meta: descs[id] && descs[id].description ? '含描述' : '',
            }));
        },
        async fetchBlob(item) {
            const res = await fetch(`/thumbnail?type=persona&file=${encodeURIComponent(item.avatar)}`);
            if (!res.ok) throw new Error(`读取头像失败 ${res.status}`);
            return await res.blob();
        },
        async read(item) {
            const pu = this._pu();
            let png = null;
            try { png = await blobToDataURL(await this.fetchBlob(item)); }
            catch (e) { console.warn('[数据管家] persona 头像读取失败', e); }
            return { id: item.id, name: item.name, desc: pu.persona_descriptions ? pu.persona_descriptions[item.id] || null : null, png };
        },
        backupOf(item, data) { return { id: item.id, name: item.name, desc: data.desc, png: data.png }; },
        async rename(item, newName) {
            const pu = ctx().powerUserSettings;
            if (!pu) throw new Error('无法访问设置');
            pu.personas = pu.personas || {};
            pu.personas[item.id] = newName;
            ctx().saveSettingsDebounced();
        },
        async remove(item) {
            try { await post('/api/avatars/delete', { avatar: item.id }); }
            catch (e) { console.warn('[数据管家] 删除头像文件失败（可能已不存在）', e); }
            const pu = ctx().powerUserSettings;
            if (pu) {
                if (pu.personas) delete pu.personas[item.id];
                if (pu.persona_descriptions) delete pu.persona_descriptions[item.id];
                if (pu.default_persona === item.id) pu.default_persona = null;
                ctx().saveSettingsDebounced();
            }
        },
        async restore(backup) {
            if (backup.png) {
                try {
                    const blob = dataURLToBlob(backup.png);
                    const fd = new FormData();
                    fd.append('avatar', blob, backup.id);
                    fd.append('overwrite_name', backup.id);
                    await fetch('/api/avatars/upload', { method: 'POST', headers: multipartHeaders(), body: fd });
                } catch (e) { console.warn('[数据管家] persona 头像上传失败', e); }
            }
            const pu = ctx().powerUserSettings;
            if (!pu) throw new Error('无法访问设置');
            pu.personas = pu.personas || {};
            pu.personas[backup.id] = backup.name;
            if (backup.desc) {
                pu.persona_descriptions = pu.persona_descriptions || {};
                pu.persona_descriptions[backup.id] = backup.desc;
            }
            ctx().saveSettingsDebounced();
        },
    },

    chats: {
        label: '聊天记录',
        editable: true,
        renamable: true,
        // needsCharacter 不再是 true:支持"全部聊天"模式
        needsCharacter: false,
        async load(st) {
            // st.avatar 为空字符串 = 全部;否则按角色筛选
            // 兼容:旧版酒馆 /api/chats/search 必须传 avatar_url,否则会 400,这时 fallback 到第一个角色
            let avatar = st.avatar;
            if (!avatar && state.characters?.length) {
                // 尝试"全部"模式;若失败下面 catch 会 fallback
                avatar = '';
            }
            const filter = avatar ? { avatar_url: avatar } : {};
            let list;
            try {
                list = await post('/api/chats/search', filter);
            } catch (e) {
                // 旧版酒馆"全部"模式不支持,fallback 到第一个角色
                if (!avatar && state.characters?.length) {
                    console.warn('[数据管家] 当前版本不支持列出全部聊天,fallback 到第一个角色', e);
                    avatar = state.characters[0].avatar;
                    list = await post('/api/chats/search', { avatar_url: avatar });
                } else {
                    throw e;
                }
            }
            const arr = Array.isArray(list) ? list : [];
            // 建一个 avatar -> 角色名 的映射,便于显示
            const nameMap = new Map();
            for (const c of state.characters || []) nameMap.set(c.avatar, c.name || c.avatar);
            return arr.map(c => {
                // TauriTavern 搜索结果会带 character_name / character_id / avatar_url 之一
                const itemAvatar = c.avatar_url || c.character_id || c.avatar || avatar || '';
                const charName = c.character_name || nameMap.get(itemAvatar) || itemAvatar || '';
                const title = charName ? `${charName} · ${c.file_name}` : c.file_name;
                return {
                    id: `${itemAvatar}::${c.file_name}`,
                    name: title,
                    fileName: c.file_name,
                    group: charName ? `聊天记录 — ${charName}` : '聊天记录',
                    avatar: itemAvatar,
                    meta: `${c.message_count ?? '?'} 条 · ${c.file_size ?? ''}`,
                };
            });
        },
        async read(item) { return await post('/api/chats/get', { avatar_url: item.avatar, file_name: item.fileName }); },
        async write(item, data) { await post('/api/chats/save', { avatar_url: item.avatar, file_name: item.fileName, chat: data, force: true }); },
        async remove(item) { await post('/api/chats/delete', { avatar_url: item.avatar, chatfile: `${item.fileName}.jsonl` }); },
        async rename(item, newName) {
            await post('/api/chats/rename', { avatar_url: item.avatar, original_file: `${item.fileName}.jsonl`, renamed_file: `${newName}.jsonl` });
        },
        async restore(backup) { await post('/api/chats/save', { avatar_url: backup.avatar, file_name: backup.fileName || backup.name, chat: backup.data, force: true }); },
        backupOf(item, data) { return { name: item.name, fileName: item.fileName, avatar: item.avatar, data }; },
    },

    themes: {
        label: '主题美化',
        editable: true,
        renamable: true,
        async load() {
            const s = await getSettings(true);
            const arr = Array.isArray(s?.themes) ? s.themes : [];
            return arr.map(t => ({
                id: t.name, name: t.name, group: '主题 / 美化方案', inline: t,
                meta: t.custom_css ? '含自定义 CSS' : '',
            }));
        },
        async read(item) { return item.inline ?? { name: item.name }; },
        async write(item, data) { await post('/api/themes/save', { ...data, name: item.name }); },
        async remove(item) { await post('/api/themes/delete', { name: item.name }); },
        async rename(item, newName) {
            const data = await this.read(item);
            await post('/api/themes/save', { ...data, name: newName });
            await post('/api/themes/delete', { name: item.name });
        },
        async restore(backup) { await post('/api/themes/save', { ...backup.data, name: backup.name }); },
        backupOf(item, data) { return { name: item.name, data }; },
    },

    backgrounds: {
        label: '背景图片',
        editable: false,
        renamable: true,
        isBackground: true,
        async load() {
            const r = await post('/api/backgrounds/all', {});
            let files = [];
            if (Array.isArray(r)) files = r.map(x => (typeof x === 'string' ? x : x.filename));
            else if (r && Array.isArray(r.images)) files = r.images.map(x => (typeof x === 'string' ? x : x.filename));
            return files.filter(Boolean).map(f => ({
                id: f, name: f, avatar: f,
                group: '背景图片',
                thumb: `/thumbnail?type=bg&file=${encodeURIComponent(f)}`,
            }));
        },
        async fetchBlob(item) {
            let res = await fetch(`/backgrounds/${encodeURIComponent(item.id)}`);
            if (!res.ok) res = await fetch(`/thumbnail?type=bg&file=${encodeURIComponent(item.id)}`);
            if (!res.ok) throw new Error(`读取背景失败 ${res.status}`);
            return await res.blob();
        },
        async read(item) { return { name: item.name, img: await blobToDataURL(await this.fetchBlob(item)) }; },
        async exportBlob(item) { return { blob: await this.fetchBlob(item), filename: item.id }; },
        backupOf(item, data) { return { name: item.name, img: data.img }; },
        async rename(item, newName) {
            let nn = newName;
            const dot = item.id.lastIndexOf('.');
            if (dot > -1 && !/\.[a-z0-9]+$/i.test(nn)) nn += item.id.slice(dot);
            await post('/api/backgrounds/rename', { old_bg: item.id, new_bg: nn });
        },
        async remove(item) { await post('/api/backgrounds/delete', { bg: item.id }); },
        async restore(backup) {
            const blob = dataURLToBlob(backup.img);
            const fd = new FormData();
            fd.append('file', blob, backup.name);
            const res = await fetch('/api/backgrounds/upload', { method: 'POST', headers: multipartHeaders(), body: fd });
            if (!res.ok) throw new Error(`上传返回 ${res.status}`);
        },
    },
};

/* ------------------------------------------------------------------ *
 *  自动备份新建的用户设定 / 面具
 * ------------------------------------------------------------------ */

let knownPersonas = null;

function autoPersonaEnabled() {
    try { return localStorage.getItem('stdm_auto_persona') !== '0'; } catch { return true; }
}

function personaSnapshot() {
    try { return new Set(Object.keys(ctx().powerUserSettings?.personas || {})); }
    catch { return new Set(); }
}

async function autoBackupPersona(id) {
    try {
        const pu = ctx().powerUserSettings || {};
        const name = (pu.personas && pu.personas[id]) || id;
        const item = { id, name, avatar: id };
        const data = await adapters.personas.read(item);
        const entry = adapters.personas.backupOf(item, data);
        await saveHistory('personas', [entry], { auto: true });
        toast(`已自动备份新面具：${name}`, 'success');
    } catch (e) { console.warn('[数据管家] 自动备份 persona 失败', e); }
}

function watchPersonas() {
    if (watchPersonas._done) return;
    try {
        const c = ctx();
        const es = c.eventSource;
        const et = c.eventTypes || c.event_types;
        if (!es || !et) return;
        watchPersonas._done = true;
        knownPersonas = personaSnapshot();
        const check = async () => {
            if (!autoPersonaEnabled()) { knownPersonas = personaSnapshot(); return; }
            const cur = personaSnapshot();
            if (knownPersonas) {
                for (const id of cur) if (!knownPersonas.has(id)) await autoBackupPersona(id);
            }
            knownPersonas = cur;
        };
        for (const name of ['PERSONA_CREATED', 'PERSONA_CHANGED', 'SETTINGS_UPDATED']) {
            if (et[name]) { try { es.on(et[name], check); } catch { /* 忽略 */ } }
        }
        console.log('[数据管家] 面具自动备份已启用');
    } catch (e) { console.debug('[数据管家] persona 监听初始化失败', e); }
}

/* ------------------------------------------------------------------ *
 *  配色主题
 * ------------------------------------------------------------------ */

const THEMES = [
    { id: 'claude', name: '默认' },
    { id: 'sage', name: '鼠尾草' },
    { id: 'ocean', name: '海蓝' },
    { id: 'lavender', name: '薰衣草' },
    { id: 'rose', name: '蔷薇' },
    { id: 'amber', name: '琥珀' },
    { id: 'mono', name: '单色' },
];

function loadTheme() {
    try {
        const t = localStorage.getItem('stdm_data_manager_theme');
        if (t && THEMES.some(x => x.id === t)) return t;
    } catch { /* 忽略 */ }
    return 'claude';
}

/* ------------------------------------------------------------------ *
 *  状态
 * ------------------------------------------------------------------ */

const state = {
    tab: 'presets',
    items: [],
    filter: '',
    selected: new Set(),
    avatar: '',
    charName: '',
    characters: [],
    lastBatch: null,
    autoDownload: true,
    theme: loadTheme(),
    // 记录被折叠的分组名(Set)
    collapsedGroups: new Set(),
    // 是否需要按分组折叠(仅预设 tab 用)
    collapseEnabled: false,
    // 全局搜索模式:false=仅名称,true=名称+内容
    searchContent: false,
};

let currentPopup = null;
let rootEl = null;
let topWrapEl = null;

// 顶部工具区悬浮在列表上方,收起/展开只是 translateY 滑出滑入(class 切换),
// 不参与布局 — 条目位置与滚动完全解耦,不可能因收起而抖动或跳动。
function setCollapsed(collapsed) {
    if (rootEl) rootEl.classList.toggle('stdm_collapsed_top', collapsed);
}

// 列表滚动内容顶部放一个与工具区等高的占位块(不用 padding:Chrome 的 sticky
// 吸附基准会被 padding-top 顶到留白下缘,收起后顶部会留一条空洞)。
// 展开时占位块正好被悬浮工具区盖住;分组头 sticky top:0 可正常钉到列表顶。
function syncTopPadding() {
    if (!topWrapEl) return;
    const listEl = $('#stdm_list');
    if (!listEl) return;
    let pad = listEl.querySelector('.stdm_top_pad');
    if (!pad) {
        pad = document.createElement('div');
        pad.className = 'stdm_top_pad';
        listEl.insertBefore(pad, listEl.firstChild);
    }
    pad.style.height = topWrapEl.offsetHeight + 'px';
}

function $(sel) { return rootEl ? rootEl.querySelector(sel) : null; }

function applyTheme(name) {
    state.theme = name;
    try { localStorage.setItem('stdm_data_manager_theme', name); } catch { /* 忽略 */ }
    if (rootEl) rootEl.dataset.theme = name;
    document.querySelectorAll('.stdm-popup').forEach(el => { el.dataset.theme = name; });
}

function markPopup(popup) {
    try {
        const dlg = popup.dlg || popup.popup;
        if (dlg && dlg.classList) { dlg.classList.add('stdm-popup'); dlg.dataset.theme = state.theme; }
    } catch { /* 忽略 */ }
}

/* ------------------------------------------------------------------ *
 *  构建面板
 * ------------------------------------------------------------------ */

function buildContent() {
    const root = document.createElement('div');
    root.id = 'stdm_modal';
    root.className = 'stdm-root';
    root.dataset.theme = state.theme;
    root.innerHTML = `
        <div class="stdm_top_wrap">
            <div id="stdm_header">
                <span class="stdm_title">${EXT_NAME}</span>
                <select id="stdm_theme" class="stdm_theme_sel" title="配色主题"></select>
                <label class="stdm_flexrow">
                    <input type="checkbox" id="stdm_autodl" checked> 删除时下载备份
                </label>
                <button class="stdm_btn" id="stdm_history" title="回收站"><i class="fa-solid fa-trash-can"></i> 回收站</button>
                <button class="stdm_btn" id="stdm_undo" disabled title="撤销上次删除"><i class="fa-solid fa-rotate-left"></i> 撤销</button>
            </div>
            <div id="stdm_tabs"></div>
            <div id="stdm_toolbar">
                <select id="stdm_charpick" style="display:none;"></select>
                <input type="text" id="stdm_search" placeholder="搜索名称...">
                <button class="stdm_btn" id="stdm_search_mode" title="切换:仅名称 / 名称+内容"><i class="fa-solid fa-magnifying-glass"></i></button>
                <button class="stdm_btn" id="stdm_selall" title="全选"><i class="fa-solid fa-check-double"></i></button>
                <button class="stdm_btn" id="stdm_selnone" title="清空选择"><i class="fa-solid fa-xmark"></i></button>
                <button class="stdm_btn" id="stdm_refresh" title="刷新列表"><i class="fa-solid fa-rotate"></i></button>
                <button class="stdm_btn" id="stdm_batch_rename" title="批量重命名"><i class="fa-solid fa-i-cursor"></i></button>
                <span class="stdm_spacer"></span>
                <button class="stdm_btn" id="stdm_delete"><i class="fa-solid fa-trash-can"></i> 删除选中 (0)</button>
            </div>
        </div>
        <div id="stdm_list"></div>
        <div id="stdm_status"></div>`;

    rootEl = root;

    const tabsEl = root.querySelector('#stdm_tabs');
    for (const [key, ad] of Object.entries(adapters)) {
        const b = document.createElement('div');
        b.className = 'stdm_tab';
        b.dataset.tab = key;
        b.textContent = ad.label;
        b.addEventListener('click', () => switchTab(key));
        tabsEl.appendChild(b);
    }

    root.querySelector('#stdm_search').addEventListener('input', (e) => {
        state.filter = e.target.value.trim().toLowerCase();
        renderList();
    });
    root.querySelector('#stdm_search_mode').addEventListener('click', async () => {
        state.searchContent = !state.searchContent;
        const btn = root.querySelector('#stdm_search_mode');
        btn.style.color = state.searchContent ? 'var(--stdm-accent-text)' : '';
        btn.title = state.searchContent ? '当前:名称+内容(点击切换为仅名称)' : '当前:仅名称(点击切换为名称+内容)';
        toast(state.searchContent ? '搜索范围:名称 + 内容' : '搜索范围:仅名称');
        // 切到内容搜索时重新走一遍 renderList(visibleItems 会自动按内容过滤)
        renderList();
    });
    root.querySelector('#stdm_selall').addEventListener('click', () => {
        visibleItems().forEach(i => state.selected.add(i.id));
        renderList();
    });
    root.querySelector('#stdm_selnone').addEventListener('click', () => { state.selected.clear(); renderList(); });
    root.querySelector('#stdm_refresh').addEventListener('click', () => reload());
    root.querySelector('#stdm_batch_rename').addEventListener('click', openBatchRename);
    root.querySelector('#stdm_delete').addEventListener('click', deleteSelected);
    root.querySelector('#stdm_history').addEventListener('click', openHistory);
    root.querySelector('#stdm_undo').addEventListener('click', undoLast);
    root.querySelector('#stdm_autodl').addEventListener('change', (e) => { state.autoDownload = e.target.checked; });
    root.querySelector('#stdm_charpick').addEventListener('change', (e) => {
        const opt = e.target.selectedOptions[0];
        state.avatar = e.target.value;
        state.charName = opt ? opt.textContent : '';
        reload();
    });

    // 顶部工具区悬浮(absolute),列表内容顶部有等高占位块(见 syncTopPadding)。
    // 显示/收起完全由滚动位置自动决定:滚过约一个工具区高度才滑出 — 此时占位块
    // 已完全滚出屏幕,收起不会露出空白;滚回接近顶部自动滑回,无需二次下拉手势。
    // 条目位置与滚动始终解耦,不存在跳动/抖动。±8px 迟滞防止在临界点来回闪烁。
    topWrapEl = root.querySelector('.stdm_top_wrap');
    const listEl = root.querySelector('#stdm_list');
    listEl.addEventListener('scroll', () => {
        const h = topWrapEl.offsetHeight;
        if (listEl.scrollTop > h + 8) setCollapsed(true);
        else if (listEl.scrollTop < h - 8) setCollapsed(false);
    }, { passive: true });

    // 弹窗拉伸/窄屏换行导致工具区高度变化时,同步列表顶部占位块
    if (typeof ResizeObserver === 'function') new ResizeObserver(syncTopPadding).observe(topWrapEl);
    syncTopPadding();

    const themeSel = root.querySelector('#stdm_theme');
    for (const t of THEMES) {
        const o = document.createElement('option');
        o.value = t.id; o.textContent = t.name;
        themeSel.appendChild(o);
    }
    themeSel.value = state.theme;
    themeSel.addEventListener('change', (e) => applyTheme(e.target.value));

    return root;
}

function setStatus(msg) { const el = $('#stdm_status'); if (el) el.textContent = msg; }

function visibleItems() {
    if (!state.filter) return state.items;
    const kw = state.filter;
    return state.items.filter(i => {
        // 名称匹配
        if (i.name.toLowerCase().includes(kw) || (i.group || '').toLowerCase().includes(kw)) return true;
        // 内容匹配(开启后):世界书/预设/聊天/主题 尝试搜内容
        if (state.searchContent) {
            const inline = i.inline;
            if (inline) {
                try { if (JSON.stringify(inline).toLowerCase().includes(kw)) return true; } catch { /* 忽略 */ }
            }
        }
        return false;
    });
}

function updateDeleteButton() {
    const btn = $('#stdm_delete');
    if (!btn) return;
    const n = state.selected.size;
    btn.innerHTML = `<i class="fa-solid fa-trash-can"></i> 删除选中 (${n})`;
    btn.disabled = n === 0;
}

function renderList() {
    const list = $('#stdm_list');
    if (!list) return;
    // 记录当前滚动位置,渲染完后恢复
    const prevScroll = list.scrollTop;
    list.innerHTML = '';
    syncTopPadding();
    const items = visibleItems();
    if (!items.length) {
        list.innerHTML = '<div style="opacity:.6;padding:20px;text-align:center;">没有条目</div>';
        updateDeleteButton();
        return;
    }
    const ad = adapters[state.tab];

    // 预设页:过滤掉空分组
    let groupsToShow = null;
    if (state.collapseEnabled) {
        const groupCounts = new Map();
        for (const it of items) groupCounts.set(it.group, (groupCounts.get(it.group) || 0) + 1);
        groupsToShow = new Set([...groupCounts.entries()].filter(([, n]) => n > 0).map(([g]) => g));
    }

    const mkRow = (item) => {
        const row = document.createElement('div');
        row.className = 'stdm_row';

        // 第一行:checkbox + avatar + name + meta
        const main = document.createElement('div');
        main.className = 'stdm_row-main';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = state.selected.has(item.id);
        const syncSelected = () => {
            if (cb.checked) state.selected.add(item.id); else state.selected.delete(item.id);
            row.classList.toggle('stdm_selected', cb.checked);
            updateDeleteButton();
        };
        row.classList.toggle('stdm_selected', cb.checked);
        cb.addEventListener('change', syncSelected);
        main.appendChild(cb);

        if (item.thumb) {
            const img = document.createElement('img');
            img.className = 'stdm_avatar';
            img.src = item.thumb;
            img.loading = 'lazy';
            img.onerror = () => img.remove();
            main.appendChild(img);
        }

        const name = document.createElement('div');
        name.className = 'stdm_name';
        name.textContent = item.name;
        name.title = item.name;
        main.appendChild(name);

        if (item.meta) {
            const meta = document.createElement('div');
            meta.className = 'stdm_meta';
            meta.textContent = item.meta;
            main.appendChild(meta);
        }
        row.appendChild(main);

        // 第二行:操作按钮,右对齐,图标化
        const actions = document.createElement('div');
        actions.className = 'stdm_rowactions';
        const mkIconBtn = (icon, tip, cls, fn) => {
            const b = document.createElement('button');
            b.className = `stdm_btn stdm_icon ${cls || ''}`.trim();
            b.title = tip;
            // 图标 + 隐藏文字,Font Awesome 不可用时至少还有文字提示
            b.innerHTML = `<i class="fa-solid ${icon}"></i><span class="stdm_icon_fallback">${tip}</span>`;
            b.addEventListener('click', fn);
            return b;
        };
        if (ad.renamable) actions.appendChild(mkIconBtn('fa-pen', '改名', '', () => renameItem(item)));
        if (ad.editable) actions.appendChild(mkIconBtn('fa-pen-to-square', '编辑', '', () => editItem(item)));
        actions.appendChild(mkIconBtn('fa-download', '导出', '', () => exportItem(item)));
        actions.appendChild(mkIconBtn('fa-trash-can', '删除', 'stdm_danger', () => { state.selected.clear(); state.selected.add(item.id); deleteSelected(); }));

        row.appendChild(actions);
        return row;
    };

    // 折叠模式:按分组渲染,每组一个标题 + 一个条目容器,点击就地切换
    if (state.collapseEnabled) {
        const byGroup = new Map();
        for (const item of items) {
            if (groupsToShow && !groupsToShow.has(item.group)) continue;
            if (!byGroup.has(item.group)) byGroup.set(item.group, []);
            byGroup.get(item.group).push(item);
        }
        for (const [groupName, groupItems] of byGroup) {
            const g = document.createElement('div');
            g.className = 'stdm_group stdm_group-collapsible';
            const isCollapsed = state.collapsedGroups.has(groupName);
            g.classList.toggle('stdm_collapsed', isCollapsed);
            g.innerHTML = `<i class="fa-solid fa-chevron-down stdm_group_arrow"></i><span>${groupName}</span><span class="stdm_group_count">${groupItems.length}</span>`;
            list.appendChild(g);

            const container = document.createElement('div');
            container.className = 'stdm_group_body';
            if (isCollapsed) container.style.display = 'none';
            for (const item of groupItems) container.appendChild(mkRow(item));
            list.appendChild(container);

            // 就地切换,不重建列表,不抽搐不跳位置
            g.addEventListener('click', () => {
                const nowCollapsed = container.style.display === 'none';
                container.style.display = nowCollapsed ? '' : 'none';
                g.classList.toggle('stdm_collapsed', !nowCollapsed);
                if (nowCollapsed) state.collapsedGroups.delete(groupName);
                else state.collapsedGroups.add(groupName);
            });
        }
        list.scrollTop = prevScroll;
        updateDeleteButton();
        return;
    }

    // 普通模式(其他 tab):原有平铺渲染
    let currentGroup = null;
    for (const item of items) {
        if (item.group !== currentGroup) {
            currentGroup = item.group;
            const g = document.createElement('div');
            g.className = 'stdm_group';
            g.textContent = currentGroup;
            list.appendChild(g);
        }
        list.appendChild(mkRow(item));
    }
    list.scrollTop = prevScroll;
    updateDeleteButton();
}

async function populateCharacterPicker() {
    const pick = $('#stdm_charpick');
    if (!pick) return;
    const all = await post('/api/characters/all', { shallow: true });
    state.characters = Array.isArray(all) ? all : [];
    pick.innerHTML = '';
    // 默认"全部聊天" — 不过滤,列出所有角色的聊天
    const allOpt = document.createElement('option');
    allOpt.value = '';
    allOpt.textContent = '— 全部聊天 —';
    pick.appendChild(allOpt);
    for (const c of state.characters) {
        const o = document.createElement('option');
        o.value = c.avatar; o.textContent = c.name || c.avatar;
        pick.appendChild(o);
    }
    const valid = ['', ...state.characters.map(c => c.avatar)];
    if (!valid.includes(state.avatar)) state.avatar = '';
    pick.value = state.avatar;
}

async function switchTab(key) {
    state.tab = key;
    state.selected.clear();
    if (rootEl) rootEl.querySelectorAll('.stdm_tab').forEach(t => t.classList.toggle('stdm_active', t.dataset.tab === key));
    const pick = $('#stdm_charpick');
    const ad = adapters[key];
    // 聊天记录:即使 needsCharacter=false 也显示选择器(提供"全部"选项,默认全部)
    const showPick = !!ad.needsCharacter || key === 'chats';
    if (pick) pick.style.display = showPick ? '' : 'none';
    // 立即清空旧列表 + 显示加载占位,避免旧 tab 内容残留
    state.items = [];
    const list = $('#stdm_list');
    if (list) {
        list.innerHTML = '<div class="stdm-empty">加载中…</div>';
        list.scrollTop = 0;
        syncTopPadding();
    }
    // 切 tab 时把顶部展开(scrollTop 归零),方便直接用搜索框
    if (rootEl) rootEl.classList.remove('stdm_collapsed_top');
    if (showPick) { await populateCharacterPicker(); }
    await reload();
}

async function reload() {
    const ad = adapters[state.tab];
    setStatus('加载中...');
    try {
        // 除预设外,其他 tab 不折叠分组
        state.collapseEnabled = (state.tab === 'presets');
        state.items = await ad.load(state);
        state.selected.clear();
        renderList();
        setStatus(`共 ${state.items.length} 条`);
    } catch (err) {
        console.error(err);
        setStatus(`加载失败:${err.message}`);
        toast(`加载失败:${err.message}`, 'error');
    }
}

/* ---------------- 操作 ---------------- */

async function exportItem(item) {
    const ad = adapters[state.tab];
    try {
        if (typeof ad.exportBlob === 'function') {
            const { blob, filename } = await ad.exportBlob(item);
            downloadBlob(filename, blob);
        } else {
            const data = await ad.read(item);
            downloadText(`${item.name}.json`, JSON.stringify(data, null, 2));
        }
        toast(`已导出 ${item.name}`, 'success');
    } catch (err) { toast(`导出失败：${err.message}`, 'error'); }
}

async function renameItem(item) {
    const ad = adapters[state.tab];
    const newName = prompt(`把「${item.name}」改名为：`, item.name);
    if (!newName || newName === item.name) return;
    if (/[\\/:*?"<>|]/.test(newName)) { toast('名称不能包含 \\ / : * ? " < > | 这些字符', 'warning'); return; }
    try {
        setStatus('改名中…');
        await ad.rename(item, newName);
        toast(`已改名为 ${newName}`, 'success');
        await reload();
    } catch (err) { toast(`改名失败：${err.message}`, 'error'); setStatus(`改名失败：${err.message}`); }
}

async function editItem(item) {
    const ad = adapters[state.tab];
    const c = ctx();
    let data;
    try { data = await ad.read(item); }
    catch (err) { toast(`读取失败：${err.message}`, 'error'); return; }

    const box = document.createElement('div');
    box.className = 'stdm-root stdm-editor-wrap';
    box.dataset.theme = state.theme;
    const ta = document.createElement('textarea');
    ta.className = 'stdm_editor_text';
    ta.spellcheck = false;
    ta.value = JSON.stringify(data, null, 2);
    box.appendChild(ta);
    const hint = document.createElement('div');
    hint.className = 'stdm_editor_hint';
    hint.textContent = '直接编辑 JSON，保存前会校验格式；格式错误不会写入。';
    box.appendChild(hint);

    if (c.Popup && c.POPUP_TYPE) {
        const p = new c.Popup(box, c.POPUP_TYPE.CONFIRM, '', { okButton: '保存', cancelButton: '取消', wide: true, large: true, allowVerticalScrolling: false });
        markPopup(p);
        const result = await p.show();
        const affirmative = c.POPUP_RESULT ? c.POPUP_RESULT.AFFIRMATIVE : 1;
        if (result !== affirmative) return;
        let parsed;
        try { parsed = JSON.parse(ta.value); }
        catch (e) { toast(`JSON 格式错误：${e.message}`, 'error'); return; }
        try { await ad.write(item, parsed); toast('已保存', 'success'); await reload(); }
        catch (err) { toast(`保存失败：${err.message}`, 'error'); }
        return;
    }
    const edited = prompt('编辑 JSON：', ta.value);
    if (edited == null) return;
    let parsed;
    try { parsed = JSON.parse(edited); }
    catch (e) { toast(`JSON 格式错误：${e.message}`, 'error'); return; }
    try { await ad.write(item, parsed); toast('已保存', 'success'); await reload(); }
    catch (err) { toast(`保存失败：${err.message}`, 'error'); }
}

/** 把一批备份打包成单个文件下载（避免浏览器多文件拦截） */
async function downloadArchive(tab, entries) {
    const label = adapters[tab] ? adapters[tab].label : tab;
    if (tab === 'characters' || tab === 'backgrounds') {
        const pick = (e, i) => tab === 'characters'
            ? { name: e.avatar || `${e.name || 'character'}_${i}.png`, url: e.png }
            : { name: e.name || `bg_${i}.png`, url: e.img };
        const JSZipRef = (typeof window !== 'undefined' && window.JSZip) || ctx()?.JSZip || null;
        if (JSZipRef) {
            try {
                const zip = new JSZipRef();
                entries.forEach((e, i) => { const f = pick(e, i); if (f.url) zip.file(f.name, dataURLToBlob(f.url)); });
                const blob = await zip.generateAsync({ type: 'blob' });
                downloadBlob(`备份_${label}_${stamp()}.zip`, blob);
                return;
            } catch (err) { console.warn('[数据管家] zip 打包失败，改用 JSON 备份', err); }
        }
        downloadText(`备份_${label}_${stamp()}.json`, JSON.stringify({ tab, time: new Date().toISOString(), entries }, null, 2));
        return;
    }
    downloadText(`备份_${label}_${stamp()}.json`, JSON.stringify({ tab, time: new Date().toISOString(), entries }, null, 2));
}

async function restoreEntries(tab, entries) {
    const ad = adapters[tab];
    if (!ad || typeof ad.restore !== 'function') { toast('该类型不支持自动还原，请手动导入备份文件', 'warning'); return; }
    let ok = 0, fail = 0;
    for (const entry of entries) {
        try { await ad.restore(entry); ok++; } catch (e) { console.error(e); fail++; }
    }
    toast(`还原完成：成功 ${ok} 项${fail ? `，失败 ${fail} 项` : ''}`, fail ? 'warning' : 'success');
    if (state.tab === tab) await reload();
}

async function deleteSelected() {
    const ad = adapters[state.tab];
    const targets = state.items.filter(i => state.selected.has(i.id));
    if (!targets.length) return;

    const names = targets.slice(0, 8).map(t => `· ${t.name}`).join('\n');
    const more = targets.length > 8 ? `\n…以及另外 ${targets.length - 8} 项` : '';
    let deleteChats = false;

    if (ad.isCharacter) {
        const note = state.autoDownload
            ? `删除前会把这些卡打包成一个备份文件下载到本地,并移入回收站(${RECYCLE_EXPIRE_DAYS} 天内可还原)。`
            : `你已关闭「删除时下载备份」,不会保存备份文件;但仍会移入回收站(${RECYCLE_EXPIRE_DAYS} 天内可还原)。`;
        if (!confirm(`确定删除 ${targets.length} 个角色卡?\n\n${names}${more}\n\n${note}`)) return;
        deleteChats = confirm('同时删除这些角色的聊天记录吗?\n\n确定 = 一并删除;取消 = 保留聊天记录。');
    } else {
        if (!confirm(`确定删除 ${targets.length} 项?\n\n${names}${more}\n\n删除前会移入回收站(${RECYCLE_EXPIRE_DAYS} 天内可还原)。`)) return;
    }

    const canBackup = typeof ad.read === 'function' && typeof ad.backupOf === 'function';
    const entries = [];
    let ok = 0, fail = 0, skipped = 0;

    for (let n = 0; n < targets.length; n++) {
        const item = targets[n];
        setStatus(`正在处理 ${n + 1}/${targets.length}：${item.name}`);
        try {
            if (canBackup) {
                let data;
                try { data = await ad.read(item); }
                catch (e) {
                    console.error('备份失败，跳过删除', item.name, e);
                    skipped++;
                    toast(`「${item.name}」备份失败，已跳过删除`, 'warning');
                    continue;
                }
                entries.push(ad.backupOf(item, data));
            }
            await ad.remove(item, { deleteChats });
            ok++;
        } catch (err) { console.error(err); fail++; toast(`删除「${item.name}」失败：${err.message}`, 'error'); }
    }

    if (entries.length) {
        state.lastBatch = { tab: state.tab, entries };
        const undo = $('#stdm_undo');
        if (undo) { undo.disabled = false; undo.innerHTML = `<i class="fa-solid fa-rotate-left"></i> 撤销 (${entries.length})`; }
        await saveHistory(state.tab, entries);
        if (state.autoDownload) {
            try { await downloadArchive(state.tab, entries); }
            catch (e) { console.warn('备份文件下载失败', e); toast('备份文件下载失败，但已存入历史，可从历史下载', 'warning'); }
        }
    }

    const parts = [`成功 ${ok} 项`];
    if (skipped) parts.push(`跳过 ${skipped} 项(备份失败)`);
    if (fail) parts.push(`失败 ${fail} 项`);
    const summary = parts.join('，');
    setStatus(`完成：${summary}`);
    toast(`删除完成：${summary}`, (fail || skipped) ? 'warning' : 'success');
    await reload();
}

async function undoLast() {
    if (!state.lastBatch) { toast('没有可撤销的删除', 'info'); return; }
    const { tab, entries } = state.lastBatch;
    if (!confirm(`还原 ${entries.length} 项到「${adapters[tab].label}」？`)) return;
    await restoreEntries(tab, entries);
    state.lastBatch = null;
    const undo = $('#stdm_undo');
    if (undo) { undo.disabled = true; undo.innerHTML = '<i class="fa-solid fa-rotate-left"></i> 撤销'; }
}

/* ------------------------------------------------------------------ *
 *  TauriTavern 专属 API 绑定(可选,自动检测)
 * ------------------------------------------------------------------ */

let __ttApiCache = null;
async function getTauriApi() {
    if (__ttApiCache) return __ttApiCache;
    try {
        if (typeof window === 'undefined') return null;
        const host = window.__TAURITAVERN__;
        if (!host) return null;
        if (host.ready) await host.ready;
        __ttApiCache = host.api || null;
        return __ttApiCache;
    } catch { return null; }
}

// 回收站数据优先存 TauriTavern extension.store(跨设备可迁移),fallback 到 IndexedDB
async function ttStoreSet(key, value) {
    const api = await getTauriApi();
    if (!api?.extension?.store) return false;
    try {
        await api.extension.store.setJson({ namespace: 'st-data-manager', table: 'recycle', key: String(key), value });
        return true;
    } catch (e) { console.warn('[数据管家] extension.store 写入失败', e); return false; }
}
async function ttStoreGetAll() {
    const api = await getTauriApi();
    if (!api?.extension?.store) return null;
    try {
        const keys = await api.extension.store.listKeys({ namespace: 'st-data-manager', table: 'recycle' });
        const out = [];
        for (const k of keys) {
            const v = await api.extension.store.getJson({ namespace: 'st-data-manager', table: 'recycle', key: String(k) });
            if (v) out.push(v);
        }
        return out;
    } catch (e) { console.warn('[数据管家] extension.store 读取失败', e); return null; }
}
async function ttStoreDelete(key) {
    const api = await getTauriApi();
    if (!api?.extension?.store) return false;
    try {
        await api.extension.store.deleteJson({ namespace: 'st-data-manager', table: 'recycle', key: String(key) });
        return true;
    } catch { return false; }
}

function applyRenameRule(name, rule) {
    switch (rule.type) {
        case 'prefix': return rule.value + name;
        case 'suffix': return name + rule.value;
        case 'replace': return name.split(rule.find).join(rule.value);
        case 'regex': {
            try { return name.replace(new RegExp(rule.find, 'g'), rule.value); }
            catch { return name; }
        }
        default: return name;
    }
}

async function openBatchRename() {
    const ad = adapters[state.tab];
    if (typeof ad.rename !== 'function') { toast('当前类型不支持改名', 'warning'); return; }
    const targets = state.items.filter(i => state.selected.has(i.id));
    if (!targets.length) { toast('先勾选要批量改名的条目', 'warning'); return; }

    const c = ctx();
    const box = document.createElement('div');
    box.className = 'stdm-root stdm-editor-wrap';
    box.dataset.theme = state.theme;
    box.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:10px;padding:4px;">
            <div style="font-size:13px;color:var(--stdm-text-2);">对选中的 ${targets.length} 项应用重命名规则:</div>
            <select id="stdm_rn_type" class="stdm_theme_sel" style="width:100%;">
                <option value="prefix">加前缀</option>
                <option value="suffix">加后缀</option>
                <option value="replace">查找替换(普通文本)</option>
                <option value="regex">正则替换</option>
            </select>
            <input type="text" id="stdm_rn_find" class="stdm_theme_sel" placeholder="查找内容(仅替换/正则)" style="display:none;width:100%;">
            <input type="text" id="stdm_rn_value" class="stdm_theme_sel" placeholder="前缀/后缀/替换为..." style="width:100%;">
            <div id="stdm_rn_preview" style="font-size:12px;color:var(--stdm-text-3);max-height:120px;overflow-y:auto;border:1px solid var(--stdm-border);border-radius:6px;padding:8px;"></div>
        </div>
    `;
    const typeSel = box.querySelector('#stdm_rn_type');
    const findInput = box.querySelector('#stdm_rn_find');
    const valueInput = box.querySelector('#stdm_rn_value');
    const preview = box.querySelector('#stdm_rn_preview');

    const refreshPreview = () => {
        const rule = { type: typeSel.value, find: findInput.value, value: valueInput.value };
        findInput.style.display = (typeSel.value === 'replace' || typeSel.value === 'regex') ? '' : 'none';
        const samples = targets.slice(0, 6).map(t => {
            const nn = applyRenameRule(t.name, rule);
            return `${t.name} → ${nn}`;
        });
        preview.innerHTML = samples.join('<br>') + (targets.length > 6 ? `<br>...等 ${targets.length} 项` : '');
    };
    typeSel.addEventListener('change', refreshPreview);
    findInput.addEventListener('input', refreshPreview);
    valueInput.addEventListener('input', refreshPreview);
    refreshPreview();

    if (c.Popup && c.POPUP_TYPE) {
        const p = new c.Popup(box, c.POPUP_TYPE.CONFIRM, '', { okButton: '应用', cancelButton: '取消', wide: true, allowVerticalScrolling: false });
        markPopup(p);
        const result = await p.show();
        const affirmative = c.POPUP_RESULT ? c.POPUP_RESULT.AFFIRMATIVE : 1;
        if (result !== affirmative) return;
    } else {
        if (!confirm(`对 ${targets.length} 项应用重命名规则?`)) return;
    }

    const rule = { type: typeSel.value, find: findInput.value, value: valueInput.value };
    let ok = 0, fail = 0, skip = 0;
    for (const item of targets) {
        const newName = applyRenameRule(item.name, rule);
        if (!newName || newName === item.name) { skip++; continue; }
        if (/[\\/:*?"<>|]/.test(newName)) { fail++; console.warn('非法字符,跳过', newName); continue; }
        try { await ad.rename(item, newName); ok++; }
        catch (e) { console.error(e); fail++; }
    }
    toast(`批量改名完成:成功 ${ok},失败 ${fail},跳过 ${skip}`, ok ? 'success' : 'warning');
    await reload();
}

/* ------------------------------------------------------------------ *
 *  删除历史面板
 * ------------------------------------------------------------------ */

async function renderHistory(container) {
    const listEl = container.querySelector('.stdm-hist-list');
    if (!listEl) return;
    listEl.textContent = '加载中…';
    let all;
    // 优先 TauriTavern extension.store,fallback IndexedDB
    try { all = await ttStoreGetAll(); } catch { all = null; }
    if (!all) {
        try { all = await dbGetAll(); }
        catch (e) { listEl.textContent = '读取回收站失败：' + e.message; return; }
    }
    all.sort((a, b) => b.id - a.id);
    listEl.innerHTML = '';
    if (!all.length) {
        const empty = document.createElement('div');
        empty.className = 'stdm-empty';
        empty.textContent = '回收站为空';
        listEl.appendChild(empty);
        return;
    }
    for (const rec of all) {
        const row = document.createElement('div');
        row.className = 'stdm-hist-row';
        const info = document.createElement('div');
        info.className = 'stdm-hist-info';
        const top = document.createElement('div');
        top.className = 'stdm-hist-top';
        const badge = document.createElement('span');
        badge.className = 'stdm-badge';
        badge.textContent = rec.label;
        top.append(badge);
        if (rec.auto) {
            const autoTag = document.createElement('span');
            autoTag.className = 'stdm-badge stdm-badge-auto';
            autoTag.textContent = '自动';
            top.append(autoTag);
        }
        const count = document.createElement('span');
        count.className = 'stdm-hist-count';
        count.textContent = `${rec.count} 项`;
        const time = document.createElement('span');
        time.className = 'stdm-hist-time';
        time.textContent = fmtTime(rec.time || Math.floor(rec.id / 1000));
        top.append(count, time);

        // 回收站条目显示剩余过期天数(auto 自动备份不过期)
        if (!rec.auto && rec.time) {
            const t = new Date(rec.time).getTime();
            if (!isNaN(t)) {
                const leftMs = RECYCLE_EXPIRE_MS - (Date.now() - t);
                const leftDays = Math.max(0, Math.ceil(leftMs / (24 * 60 * 60 * 1000)));
                const expire = document.createElement('span');
                expire.className = 'stdm-hist-time';
                expire.style.color = leftDays <= 1 ? 'var(--stdm-danger)' : '';
                expire.textContent = leftDays > 0 ? `${leftDays} 天后过期` : '即将过期';
                top.append(expire);
            }
        }

        const nm = document.createElement('div');
        nm.className = 'stdm-hist-names';
        const namesArr = Array.isArray(rec.names) ? rec.names : [];
        nm.textContent = namesArr.slice(0, 5).join('、') + (namesArr.length > 5 ? ` …等 ${namesArr.length} 项` : '');
        nm.title = namesArr.join('\n');

        info.append(top, nm);
        row.appendChild(info);

        const acts = document.createElement('div');
        acts.className = 'stdm-hist-actions';
        const dl = document.createElement('button');
        dl.className = 'stdm_btn'; dl.textContent = '下载备份';
        dl.addEventListener('click', async () => {
            try { await downloadArchive(rec.tab, rec.entries); toast('已下载备份', 'success'); }
            catch (e) { toast('下载失败：' + e.message, 'error'); }
        });
        const rs = document.createElement('button');
        rs.className = 'stdm_btn'; rs.textContent = '还原';
        rs.addEventListener('click', async () => {
            if (!confirm(`把这 ${rec.count} 项还原到「${rec.label}」？`)) return;
            await restoreEntries(rec.tab, rec.entries);
        });
        const rm = document.createElement('button');
        rm.className = 'stdm_btn stdm_danger'; rm.textContent = '删除记录';
        rm.addEventListener('click', async () => {
            if (!confirm('删除这条历史记录？其中的备份内容会一并移除，不可恢复。')) return;
            try { await dbDelete(rec.id); try { await ttStoreDelete(rec.id); } catch { /* 忽略 */ } await renderHistory(container); }
            catch (e) { toast('删除失败：' + e.message, 'error'); }
        });
        acts.append(dl, rs, rm);
        row.appendChild(acts);
        listEl.appendChild(row);
    }
}

async function openHistory() {
    const c = ctx();
    const box = document.createElement('div');
    box.className = 'stdm-root stdm-history';
    box.dataset.theme = state.theme;

    const head = document.createElement('div');
    head.className = 'stdm-hist-head';
    const title = document.createElement('span');
    title.className = 'stdm-hist-title';
    title.textContent = `回收站(保留 ${RECYCLE_EXPIRE_DAYS} 天)`;
    const clear = document.createElement('button');
    clear.className = 'stdm_btn stdm_danger';
    clear.textContent = '清空全部';
    clear.addEventListener('click', async () => {
        if (!confirm('清空全部删除历史？所有备份内容将一并移除，不可恢复。')) return;
        try { await dbClear(); await renderHistory(box); toast('已清空历史', 'success'); }
        catch (e) { toast('清空失败：' + e.message, 'error'); }
    });
    head.append(title, clear);

    const list = document.createElement('div');
    list.className = 'stdm-hist-list';
    const foot = document.createElement('div');
    foot.className = 'stdm-hist-foot';
    foot.textContent = '历史与备份保存在本浏览器（IndexedDB），换设备或清理浏览器数据会丢失。';
    box.append(head, list, foot);

    if (c.Popup && c.POPUP_TYPE) {
        const p = new c.Popup(box, c.POPUP_TYPE.TEXT, '', { okButton: '关闭', wide: true, large: true, allowVerticalScrolling: false });
        p.show();
        markPopup(p);
    } else {
        box.classList.add('stdm-fallback');
        document.body.appendChild(box);
    }
    await renderHistory(box);
}

/* ------------------------------------------------------------------ *
 *  打开主面板
 * ------------------------------------------------------------------ */

async function openModal() {
    const c = ctx();
    const content = buildContent();
    if (c.Popup && c.POPUP_TYPE) {
        currentPopup = new c.Popup(content, c.POPUP_TYPE.TEXT, '', {
            okButton: '关闭', wide: true, large: true, allowVerticalScrolling: false,
            onClose: () => { rootEl = null; currentPopup = null; },
        });
        currentPopup.show();
        markPopup(currentPopup);
        await switchTab(state.tab);
    } else {
        content.classList.add('stdm-fallback');
        content.dataset.theme = state.theme;
        document.body.appendChild(content);
        await switchTab(state.tab);
    }
}

/* ------------------------------------------------------------------ *
 *  挂载入口
 * ------------------------------------------------------------------ */

function mount() {
    const menu = document.getElementById('extensionsMenu');
    if (menu && !document.getElementById('stdm_menu_entry')) {
        const entry = document.createElement('div');
        entry.id = 'stdm_menu_entry';
        entry.className = 'list-group-item flex-container flexGap5 interactable';
        entry.tabIndex = 0;
        entry.innerHTML = '<div class="fa-solid fa-folder-tree extensionsMenuExtensionButton"></div><span>数据管家</span>';
        entry.addEventListener('click', openModal);
        menu.appendChild(entry);
    }

    const settings = document.getElementById('extensions_settings') || document.getElementById('extensions_settings2');
    if (settings && !document.getElementById('stdm_settings_block')) {
        const block = document.createElement('div');
        block.id = 'stdm_settings_block';
        block.className = 'inline-drawer';
        block.innerHTML = `
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>数据管家</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <p style="font-size:.85em;opacity:.8;">批量管理预设、世界书、角色卡、用户设定(面具)、聊天记录、主题美化和背景图片。删除前自动备份，可一键撤销或从历史还原。</p>
            <label class="checkbox_label" style="margin:6px 0;">
                <input type="checkbox" id="stdm_auto_persona_chk">
                <span>新建用户设定(面具)时自动备份</span>
            </label>
            <div class="menu_button menu_button_icon" id="stdm_open_btn">
                <i class="fa-solid fa-folder-tree"></i><span>打开数据管家</span>
            </div>
        </div>`;
        settings.appendChild(block);
        block.querySelector('#stdm_open_btn').addEventListener('click', openModal);
        const apc = block.querySelector('#stdm_auto_persona_chk');
        apc.checked = autoPersonaEnabled();
        apc.addEventListener('change', (e) => {
            try { localStorage.setItem('stdm_auto_persona', e.target.checked ? '1' : '0'); } catch { /* 忽略 */ }
            if (e.target.checked) knownPersonas = personaSnapshot();
            toast(e.target.checked ? '已开启：新建面具时自动备份' : '已关闭面具自动备份', 'info');
        });
    }
}

function registerSlashCommand() {
    try {
        const c = ctx();
        const SlashCommand = c.SlashCommand;
        const parser = c.SlashCommandParser;
        if (!SlashCommand || !parser) return;
        parser.addCommandObject(SlashCommand.fromProps({
            name: 'datamanager',
            aliases: ['dm', '数据管家'],
            helpString: '打开数据管家面板',
            callback: () => { openModal(); return ''; },
        }));
    } catch (e) { console.debug('[数据管家] 斜杠命令注册跳过', e); }
}

function initPersonaWatch() {
    try {
        const c = ctx();
        const et = c.eventTypes || c.event_types;
        if (c.eventSource && et && et.APP_READY) c.eventSource.on(et.APP_READY, watchPersonas);
    } catch { /* 忽略 */ }
    setTimeout(watchPersonas, 4000);
    setTimeout(watchPersonas, 12000);
}

(function init() {
    const start = () => {
        mount();
        registerSlashCommand();
        initPersonaWatch();
        setTimeout(mount, 3000);
        console.log('[数据管家] 已加载');
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
