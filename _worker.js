/**
 * NeuronGate
 * 一个反向代理：把 Cloudflare Workers AI 转换成 OpenAI 兼容的接口格式，
 * 支持多账号负载均衡、故障自动切换重试，还自带一个可视化管理面板。
 */

// 默认模型映射表（左边是客户端请求的模型名，右边是 Cloudflare 上对应的真实模型）
const DEFAULT_MODEL_MAP = {
	// 对话 / 文本生成模型
	'glm-5.2': '@cf/zai-org/glm-5.2',
	'glm-4.7-flash': '@cf/zai-org/glm-4.7-flash',
	'kimi-k2.7-code': '@cf/moonshotai/kimi-k2.7-code',
	'kimi-k2.6': '@cf/moonshotai/kimi-k2.6', // 就是一坨屎，别吃
	'gemma-4-26b-a4b-it': '@cf/google/gemma-4-26b-a4b-it',
	'nemotron-3-120b-a12b': '@cf/nvidia/nemotron-3-120b-a12b',
	'gpt-oss-20b': '@cf/openai/gpt-oss-20b',
	'gpt-oss-120b': '@cf/openai/gpt-oss-120b',

	// 向量嵌入（Embeddings）模型
	'embeddinggemma-300m': '@cf/google/embeddinggemma-300m',
	'qwen3-embedding-0.6b': '@cf/qwen/qwen3-embedding-0.6b',
	'bge-m3': '@cf/baai/bge-m3'
};

// 已知的收费模型（CF 属性 require_workers_paid=true，需付费 Workers 计划才能调用）。
// 仅作为「模型目录」尚未从 CF 同步时的兜底判定；同步后以实时目录为准。
const KNOWN_PAID_MODELS = new Set([
	'@cf/moonshotai/kimi-k2.7-code',
	'@cf/zai-org/glm-5.3',
	'@cf/zai-org/glm-5.3-flash',
	'@cf/moonshotai/kimi-k2.6',
	'@cf/deepseek-ai/deepseek-v4-flash-0731',
	'@cf/zai-org/glm-5.2',
	'@cf/deepseek-ai/deepseek-v4-pro-0813',
]);

// API 密钥的模型分组权限取值
const MODEL_GROUPS = ['all', 'free', 'paid'];

// ----------------------------------------------------
// Neuron Console —— 统一设计系统覆盖层
// 作为共享 CSS 注入到全部页面（登录页 / 控制台 / 错误页），
// 追加在各页 <style> 末尾，凭层叠顺序覆盖旧的紫粉玻璃拟态主题。
// 设计语言：墨底中性面 + 单一琥珀信号色 + 等宽数据读数（仪表台质感）。
// ----------------------------------------------------
const NEURON_THEME = `
/* ===== Neuron Console 设计令牌 ===== */
:root{
	--bg-color:#0E1116;
	--sidebar-bg:#12161C;
	--card-bg:#161B22;
	--section-item-bg:#1A2029;
	--border-color:#262D38;
	--text-main:#E6EAF0;
	--text-muted:#8A93A3;
	--accent-color:#FF8A3D;
	--accent-soft:rgba(255,138,61,0.14);
	--primary-gradient:linear-gradient(135deg,#FF8A3D 0%,#FB923C 55%,#F59E0B 100%);
	--success-color:#34D399;
	--warning-color:#FBBF24;
	--danger-color:#FB7185;
	--input-bg:#0E1116;
	--input-border:#2A313C;
	--input-text:#E6EAF0;
	--table-header-bg:rgba(255,255,255,0.02);
	--btn-secondary-bg:rgba(255,255,255,0.04);
	--btn-secondary-hover:rgba(255,255,255,0.08);
	--btn-secondary-text:#E6EAF0;
	--modal-overlay-bg:rgba(6,8,12,0.72);
	--section-item-bg:#1A2029;
	--card-shadow:0 1px 0 rgba(255,255,255,0.02), 0 10px 26px -14px rgba(0,0,0,0.66);
	--glass-blur:0px;
	--sidebar-menu-hover:rgba(255,255,255,0.035);
	--code-bg:rgba(255,138,61,0.08);
	--code-color:#FFB784;
	--code-border:rgba(255,138,61,0.16);
	--orb-1-color:transparent;
	--orb-2-color:transparent;
	--nc-radius-sm:8px;
	--nc-radius-md:12px;
	--nc-radius-lg:16px;
}
:root[data-theme="light"]{
	--bg-color:#F5F6F8;
	--sidebar-bg:#FFFFFF;
	--card-bg:#FFFFFF;
	--section-item-bg:#F5F6F8;
	--border-color:#E3E7EC;
	--text-main:#141922;
	--text-muted:#5B6472;
	--accent-color:#E0691E;
	--accent-soft:rgba(224,105,30,0.12);
	--primary-gradient:linear-gradient(135deg,#F97316 0%,#EA8A2E 55%,#D97706 100%);
	--success-color:#059669;
	--warning-color:#D97706;
	--danger-color:#E11D48;
	--input-bg:#FFFFFF;
	--input-border:#D9DEE5;
	--input-text:#141922;
	--table-header-bg:rgba(0,0,0,0.02);
	--btn-secondary-bg:rgba(0,0,0,0.03);
	--btn-secondary-hover:rgba(0,0,0,0.06);
	--btn-secondary-text:#141922;
	--modal-overlay-bg:rgba(240,242,245,0.72);
	--card-shadow:0 1px 2px rgba(16,24,40,0.04), 0 10px 26px -16px rgba(16,24,40,0.2);
	--sidebar-menu-hover:rgba(0,0,0,0.03);
	--code-bg:rgba(224,105,30,0.08);
	--code-color:#B45309;
	--code-border:rgba(224,105,30,0.18);
	--orb-1-color:transparent;
	--orb-2-color:transparent;
}
/* ===== 字体层级：Space Grotesk 展示 / Inter 正文 / JetBrains Mono 数据 ===== */
body{ font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif; font-variant-numeric:tabular-nums; }
h1,h2,h3,.logo-text,.section-title,.stat-value{ font-family:'Space Grotesk','Outfit',sans-serif; letter-spacing:-0.01em; }
.stat-value,code,.nc-mono{ font-family:'JetBrains Mono',ui-monospace,'SFMono-Regular',monospace; }
/* ===== 关闭旧装饰：光球 + 赛博扫描线 ===== */
.bg-orbs-container{ display:none !important; }
.tab-content.active::before{ display:none !important; }
.tab-content.active{ animation:ncFade .34s ease both; }
@keyframes ncFade{ from{opacity:0; transform:translateY(6px);} to{opacity:1; transform:none;} }
/* ===== 侧栏导航：信号色左标，取代霓虹光晕 ===== */
.nav-item{ border-radius:var(--nc-radius-sm); }
.nav-item::after{ display:none !important; }
.nav-item:hover{ transform:none; background:var(--sidebar-menu-hover); color:var(--text-main); }
.nav-item.active{ background:var(--sidebar-menu-hover); color:var(--text-main); box-shadow:none; }
.nav-item.active::before{ content:''; position:absolute; left:0; top:9px; bottom:9px; width:3px; border-radius:0 3px 3px 0; background:var(--accent-color); }
.logo-icon{ background:var(--accent-soft); border:1px solid rgba(255,138,61,0.32); color:var(--accent-color); box-shadow:none; border-radius:11px; }
.logo-icon svg{ width:62%; height:62%; }
:root[data-theme="light"] .logo-icon{ border-color:rgba(224,105,30,0.32); }
/* ===== 卡片：实心表面 + 发丝边框（去玻璃模糊） ===== */
.stat-card,.section-card,.modal-card,aside,.floating-btn,.access-endpoint-card{ backdrop-filter:none !important; -webkit-backdrop-filter:none !important; }
.stat-card,.section-card{ border-radius:var(--nc-radius-lg); }
.stat-card{ transition:border-color .2s ease, box-shadow .2s ease; }
.stat-card:hover{ transform:none; border-color:var(--accent-color); box-shadow:var(--card-shadow); }
.access-endpoint-card{ background:var(--section-item-bg); }
.access-endpoint-card:hover{ transform:none; border-color:var(--accent-color); box-shadow:none; }
.endpoint-badge{ background:var(--accent-soft); color:var(--accent-color); }
.endpoint-url{ text-decoration-color:rgba(255,138,61,0.5); }
.endpoint-url:hover{ color:var(--accent-color); }
/* ===== 仪表读数条：分段刻度 gauge ===== */
.progress-container{ height:8px; border-radius:3px; background:var(--section-item-bg); border:1px solid var(--border-color); position:relative; overflow:hidden; }
.progress-container::after{ content:''; position:absolute; inset:0; background-image:repeating-linear-gradient(90deg,transparent 0,transparent 9px,rgba(0,0,0,0.30) 9px,rgba(0,0,0,0.30) 10px); pointer-events:none; }
:root[data-theme="light"] .progress-container::after{ background-image:repeating-linear-gradient(90deg,transparent 0,transparent 9px,rgba(255,255,255,0.6) 9px,rgba(255,255,255,0.6) 10px); }
.progress-bar{ background:var(--primary-gradient); }
/* ===== 按钮 ===== */
.btn{ border-radius:var(--nc-radius-sm); }
.btn-primary{ background:var(--primary-gradient); color:#1a1206; box-shadow:none; }
.btn-primary:hover{ transform:translateY(-1px); box-shadow:0 6px 16px -6px var(--accent-color); opacity:1; }
.btn-secondary:hover{ transform:none; }
.floating-btn{ border-radius:var(--nc-radius-sm); }
.floating-btn:hover{ transform:translateY(-1px); border-color:var(--accent-color); box-shadow:none; }
/* ===== 徽章 ===== */
.badge{ border-radius:999px; padding:3px 10px; font-weight:600; letter-spacing:0.01em; }
.badge-success{ background:rgba(52,211,153,0.14); color:var(--success-color); }
.badge-warning{ background:rgba(251,191,36,0.14); color:var(--warning-color); }
.badge-danger{ background:rgba(251,113,133,0.14); color:var(--danger-color); }
.badge-info{ background:rgba(56,189,248,0.14); color:#38BDF8; }
/* ===== 表单 ===== */
input:focus,select:focus,textarea:focus{ border-color:var(--accent-color); box-shadow:0 0 0 3px var(--accent-soft); background:var(--input-bg); }
:root[data-theme="light"] input:focus,:root[data-theme="light"] select:focus{ background:#fff; }
select{ background-color:var(--input-bg); border:1px solid var(--input-border); color:var(--input-text); padding:12px 16px; border-radius:var(--nc-radius-sm); font-size:14px; outline:none; transition:all .2s ease; }
/* ===== 表格 ===== */
th{ text-transform:uppercase; letter-spacing:0.05em; font-size:12px; }
tr:hover td{ background:var(--sidebar-menu-hover); }
/* ===== a11y：可见键盘焦点 ===== */
a:focus-visible,button:focus-visible,input:focus-visible,select:focus-visible,.nav-item:focus-visible,.access-endpoint-card:focus-visible{ outline:2px solid var(--accent-color); outline-offset:2px; }
/* ===== 尊重减少动效偏好 ===== */
@media (prefers-reduced-motion: reduce){ *,*::before,*::after{ animation-duration:0.01ms !important; animation-iteration-count:1 !important; transition-duration:0.01ms !important; scroll-behavior:auto !important; } }
.login-header .logo-text, .logo-text{ -webkit-text-fill-color:var(--text-main); color:var(--text-main); background:none; }
#public-neurons{ -webkit-text-fill-color:var(--accent-color) !important; color:var(--accent-color) !important; background:none !important; }
/* ===== 模型页：统计读数 / 工具栏 / 统一模型列表 ===== */
.nc-dim{ font-size:12px; color:var(--text-muted); font-family:'JetBrains Mono',monospace; }
.nc-metrics{ display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin:2px 0 18px; }
@media (max-width:640px){ .nc-metrics{ grid-template-columns:repeat(2,1fr); } }
.nc-metric{ background:var(--section-item-bg); border:1px solid var(--border-color); border-radius:var(--nc-radius-md); padding:14px 16px; display:flex; flex-direction:column; gap:6px; }
.nc-metric-k{ font-size:12px; color:var(--text-muted); }
.nc-metric-v{ font-family:'JetBrains Mono',monospace; font-size:26px; font-weight:600; line-height:1; }
.nc-toolbar{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:14px; }
.nc-toolbar input{ flex:1; min-width:180px; }
.nc-toolbar select{ width:150px; flex:0 0 auto; }
.nc-addmap{ display:grid; grid-template-columns:1fr auto 1.4fr auto auto; gap:10px; align-items:center; background:var(--section-item-bg); border:1px dashed var(--border-color); border-radius:var(--nc-radius-md); padding:12px 14px; margin-bottom:14px; }
@media (max-width:820px){ .nc-addmap{ grid-template-columns:1fr; } .nc-addmap .nc-arrow{ display:none; } }
.nc-arrow{ color:var(--text-muted); text-align:center; }
.nc-vendors{ display:grid; grid-template-columns:repeat(auto-fill, minmax(230px, 1fr)); gap:12px; }
.nc-vendor{ background:var(--section-item-bg); border:1px solid var(--border-color); border-radius:var(--nc-radius-md); padding:16px; cursor:pointer; transition:border-color .15s ease, transform .15s ease; }
.nc-vendor:hover{ border-color:var(--accent-color); transform:translateY(-2px); }
.nc-vendor-top{ display:flex; align-items:center; gap:10px; margin-bottom:12px; }
.nc-vendor-logo{ width:34px; height:34px; border-radius:9px; background:var(--accent-soft); color:var(--accent-color); display:flex; align-items:center; justify-content:center; font-family:'Space Grotesk',sans-serif; font-weight:700; font-size:15px; flex-shrink:0; }
.nc-vendor-name{ font-weight:600; font-size:14px; line-height:1.25; }
.nc-vendor-sub{ font-size:11.5px; color:var(--text-muted); }
.nc-vendor-stats{ display:flex; gap:6px; flex-wrap:wrap; }
.nc-chip{ font-size:11px; padding:2px 8px; border-radius:999px; border:1px solid var(--border-color); color:var(--text-muted); }
.nc-chip.free{ color:var(--success-color); border-color:rgba(52,211,153,0.3); }
.nc-chip.paid{ color:var(--warning-color); border-color:rgba(251,191,36,0.3); }
/* 详情列表 */
.nc-detail{ display:flex; flex-direction:column; gap:10px; max-height:60vh; overflow-y:auto; }
.nc-mrow{ border:1px solid var(--border-color); border-radius:var(--nc-radius-md); padding:12px 14px; }
.nc-mrow-h{ display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; }
.nc-mrow-alias{ font-family:'JetBrains Mono',monospace; font-size:13px; color:var(--text-main); cursor:pointer; }
.nc-mrow-path{ font-family:'JetBrains Mono',monospace; font-size:11.5px; color:var(--text-muted); margin-top:3px; word-break:break-all; }
.nc-mrow-desc{ font-size:12.5px; color:var(--text-muted); margin-top:8px; line-height:1.6; }
.nc-caps{ display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
.nc-cap{ font-size:11px; padding:2px 8px; border-radius:6px; background:var(--accent-soft); color:var(--accent-color); }
@media (max-width:820px){ .nc-vendors{ grid-template-columns:repeat(auto-fill, minmax(160px, 1fr)); } }
/* ===== 聊天页 ===== */
.nc-chat-card{ display:flex; flex-direction:column; height:calc(100vh - 190px); min-height:440px; padding:0; overflow:hidden; }
.nc-chat-head{ display:flex; justify-content:space-between; align-items:center; gap:12px; padding:14px 18px; border-bottom:1px solid var(--border-color); flex-wrap:wrap; }
.nc-chat-model{ width:auto; min-width:220px; padding:8px 12px; }
.nc-chat-body{ flex:1; overflow-y:auto; padding:22px 18px; display:flex; flex-direction:column; gap:16px; scroll-behavior:smooth; }
.nc-msg{ display:flex; gap:10px; }
.nc-msg.user{ flex-direction:row-reverse; }
.nc-msg-col{ display:flex; flex-direction:column; gap:6px; min-width:0; align-items:flex-start; max-width:min(72ch, 82%); }
.nc-msg.user .nc-msg-col{ align-items:flex-end; }
.nc-acts{ display:flex; gap:4px; opacity:0; transition:opacity .15s ease; }
.nc-msg:hover .nc-acts{ opacity:1; }
.nc-act{ font-size:11px; padding:2px 9px; border-radius:6px; border:1px solid var(--border-color); background:var(--section-item-bg); color:var(--text-muted); cursor:pointer; transition:all .15s ease; }
.nc-act:hover{ color:var(--accent-color); border-color:var(--accent-color); }
.nc-edit-ta{ width:100%; min-height:72px; resize:vertical; padding:10px 12px; border-radius:10px; background:var(--input-bg); border:1px solid var(--input-border); color:var(--input-text); font-size:14px; font-family:inherit; outline:none; line-height:1.55; }
.nc-edit-ta:focus{ border-color:var(--accent-color); box-shadow:0 0 0 3px var(--accent-soft); }
.nc-edit-row{ display:flex; gap:8px; margin-top:8px; }
.nc-edit-row .btn{ padding:6px 12px; font-size:12px; }
@media (max-width:768px){ .nc-acts{ opacity:1; } }
.nc-msg-col .nc-bubble{ max-width:100%; }
.nc-avatar{ width:30px; height:30px; border-radius:9px; flex-shrink:0; display:flex; align-items:center; justify-content:center; font-size:11px; font-weight:700; font-family:'Space Grotesk',sans-serif; }
.nc-msg.user .nc-avatar{ background:var(--accent-soft); color:var(--accent-color); }
.nc-msg.assistant .nc-avatar{ background:var(--section-item-bg); color:var(--text-muted); border:1px solid var(--border-color); }
.nc-bubble{ padding:11px 15px; border-radius:12px; font-size:14px; line-height:1.68; white-space:pre-wrap; word-break:break-word; max-width:min(72ch, 82%); }
.nc-msg.user .nc-bubble{ background:var(--accent-soft); border:1px solid rgba(255,138,61,0.22); color:var(--text-main); }
.nc-msg.assistant .nc-bubble{ background:var(--section-item-bg); border:1px solid var(--border-color); }
.nc-chat-empty{ color:var(--text-muted); text-align:center; margin:auto; font-size:13px; display:flex; flex-direction:column; gap:14px; align-items:center; }
.nc-sugg{ display:flex; gap:8px; flex-wrap:wrap; justify-content:center; max-width:520px; }
.nc-sugg button{ font-size:12px; padding:7px 12px; border-radius:999px; border:1px solid var(--border-color); background:var(--section-item-bg); color:var(--text-muted); cursor:pointer; transition:all .15s ease; }
.nc-sugg button:hover{ color:var(--accent-color); border-color:var(--accent-color); }
.nc-chat-composer{ display:flex; gap:10px; padding:14px 18px; border-top:1px solid var(--border-color); align-items:flex-end; }
.nc-chat-composer textarea{ flex:1; resize:none; max-height:160px; padding:12px 14px; border-radius:10px; background:var(--input-bg); border:1px solid var(--input-border); color:var(--input-text); font-size:14px; font-family:inherit; outline:none; line-height:1.5; transition:border-color .2s ease, box-shadow .2s ease; }
.nc-chat-composer textarea:focus{ border-color:var(--accent-color); box-shadow:0 0 0 3px var(--accent-soft); }
.nc-cursor{ display:inline-block; width:7px; height:15px; background:var(--accent-color); margin-left:2px; animation:ncBlink 1s steps(1) infinite; vertical-align:-2px; }
@keyframes ncBlink{ 50%{ opacity:0; } }
@media (max-width:768px){ .nc-chat-card{ height:calc(100vh - 150px); } .nc-bubble{ max-width:88%; } }
/* ===== 移动端触控优化 ===== */
@media (max-width:768px){
	.btn{ min-height:42px; }
	.nav-item{ padding:14px 16px; }
	.modal-card{ max-width:calc(100vw - 32px); }
}
`;

export default {
	async fetch(request, env, ctx) {
		// 1. 检查是否绑定了 KV 存储
		if (!env.KV) {
			return handleKVError(request);
		}

		// 2. 检查是否配置了 ADMIN_PASSWORD 环境变量
		if (!env.ADMIN_PASSWORD) {
			return handlePasswordError(request);
		}

		// 处理跨域预检请求（OPTIONS）
		if (request.method === 'OPTIONS') {
			return new Response(null, {
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE',
					'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key'
				}
			});
		}

		const url = new URL(request.url);

		// 2. OpenAI 兼容的代理接口（/v1/ 开头）
		if (url.pathname.startsWith('/v1/')) {
			const response = await handleV1Proxy(request, env, ctx);
			return addCORSHeaders(response);
		}

		// 3. 后台管理面板的 API 接口（/api/ 开头）
		if (url.pathname.startsWith('/api/')) {
			const response = await handleDashboardApi(request, env, ctx);
			return addCORSHeaders(response);
		}

		// 4. 后台管理面板页面
		if (url.pathname === '/admin' || url.pathname === '/admin/') {
			const isLoggedIn = await verifyAdminCookie(request, env);
			if (isLoggedIn) {
				return handleAdminPage(request, env, ctx);
			} else {
				// 未登录则跳转到首页（登录页）
				return new Response(null, {
					status: 302,
					headers: { 'Location': '/' }
				});
			}
		}

		// 5. 首页 / 登录页
		if (url.pathname === '/') {
			return handleLandingPage(request, env, ctx);
		}

		// robots.txt 支持，用于屏蔽搜索引擎爬虫
		if (url.pathname === '/robots.txt') {
			return new Response('User-agent: *\nDisallow: /', {
				headers: { 'Content-Type': 'text/plain; charset=utf-8' }
			});
		}

		// 6. 其他路径一律返回 404
		return new Response('404 Not Found', { status: 404 });
	}
};

// 工具函数：给响应加上跨域（CORS）响应头
function addCORSHeaders(response) {
	const newResponse = new Response(response.body, response);
	newResponse.headers.set('Access-Control-Allow-Origin', '*');
	newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
	newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-api-key');
	return newResponse;
}

// 工具函数：计算字符串的 SHA-256 哈希值
async function sha256(message) {
	const msgBuffer = new TextEncoder().encode(message);
	const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// ----------------------------------------------------
// KV 读写相关工具函数
// （把所有配置合并存到一个 'config' 键里，一次读取就能拿到全部配置，省 KV 读次数）
// ----------------------------------------------------
const memoryCache = {
	config: null,
	configExpiry: 0
};
const CACHE_TTL_MS = 60000; // 内存缓存有效期：1 分钟

async function getAppConfig(env) {
	const now = Date.now();
	if (memoryCache.config && now < memoryCache.configExpiry) {
		return memoryCache.config;
	}

	const raw = await env.KV.get('config');
	let parsed = { accounts: [], apiKeys: [], customModelMap: {}, autoModelMap: {}, modelCatalog: null, modelCatalogUpdatedAt: 0 };

	if (raw) {
		try {
			const data = JSON.parse(raw);
			parsed = {
				accounts: data.accounts || [],
				apiKeys: data.apiKeys || [],
				customModelMap: data.customModelMap || {},
				autoModelMap: data.autoModelMap || {},
				modelCatalog: data.modelCatalog || null,
				modelCatalogUpdatedAt: data.modelCatalogUpdatedAt || 0
			};
		} catch (e) { }
	} else {
		// 仅在 KV 首次初始化时写入默认模型映射，避免覆盖已有配置。
		parsed.customModelMap = { ...DEFAULT_MODEL_MAP };
		await env.KV.put('config', JSON.stringify(parsed));
	}

	memoryCache.config = parsed;
	memoryCache.configExpiry = now + CACHE_TTL_MS;
	return parsed;
}

async function saveAppConfig(env, config) {
	await env.KV.put('config', JSON.stringify(config));
	memoryCache.config = config;
	memoryCache.configExpiry = Date.now() + CACHE_TTL_MS;
}

async function getAccounts(env) {
	const config = await getAppConfig(env);
	return config.accounts;
}

async function saveAccounts(env, accounts) {
	const config = await getAppConfig(env);
	config.accounts = accounts;
	await saveAppConfig(env, config);
	await env.KV.delete('cache_usage_summary'); // 清除用量统计的缓存
}

async function getApiKeys(env) {
	const config = await getAppConfig(env);
	return config.apiKeys;
}

async function saveApiKeys(env, keys) {
	const config = await getAppConfig(env);
	config.apiKeys = keys;
	await saveAppConfig(env, config);
}

async function getCustomModelMap(env) {
	const config = await getAppConfig(env);
	return config.customModelMap;
}

async function saveCustomModelMap(env, map) {
	const config = await getAppConfig(env);
	config.customModelMap = map;
	await saveAppConfig(env, config);
}

async function getAutoModelMap(env) {
	const config = await getAppConfig(env);
	return config.autoModelMap || {};
}

async function saveAutoModelMap(env, map) {
	const config = await getAppConfig(env);
	config.autoModelMap = map;
	await saveAppConfig(env, config);
}

// 解析某个客户端模型名时使用的完整映射：内置默认 < 自动同步 < 用户自定义（后者优先）
async function getCombinedModelMap(env) {
	const customMap = await getCustomModelMap(env);
	const autoMap = await getAutoModelMap(env);
	return { ...DEFAULT_MODEL_MAP, ...autoMap, ...customMap };
}

// ----------------------------------------------------
// 模型目录（从 Cloudflare 实时获取的模型清单 + 免费/收费分组）
// ----------------------------------------------------
async function getModelCatalog(env) {
	const config = await getAppConfig(env);
	return { catalog: config.modelCatalog, updatedAt: config.modelCatalogUpdatedAt || 0 };
}

async function saveModelCatalog(env, catalog) {
	const config = await getAppConfig(env);
	config.modelCatalog = catalog;
	config.modelCatalogUpdatedAt = Date.now();
	await saveAppConfig(env, config);
	return config.modelCatalogUpdatedAt;
}

// 从模型全路径解析出供应商（@cf/<vendor>/<model> -> vendor）
function vendorOf(name) {
	const parts = String(name).split('/');
	return parts.length >= 3 ? parts[1] : 'other';
}

// 从某个账号的 Cloudflare Token 拉取全部模型，归一化为统一结构
async function fetchCFModels(accountId, apiToken) {
	const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search?per_page=300`, {
		method: 'GET',
		headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' }
	});
	const data = await res.json();
	if (!res.ok || data.success === false) {
		const msg = data.errors?.[0]?.message || `HTTP ${res.status}`;
		throw new Error(msg);
	}
	const getProp = (m, pid) => {
		const p = (m.properties || []).find(x => x.property_id === pid);
		return p ? p.value : undefined;
	};
	const isTrue = (m, pid) => getProp(m, pid) === 'true';
	return (data.result || []).map(m => ({
		name: m.name,
		vendor: vendorOf(m.name),
		task: m.task?.name || 'Unknown',
		paid: isTrue(m, 'require_workers_paid'),
		beta: isTrue(m, 'beta'),
		description: m.description || '',
		contextWindow: getProp(m, 'context_window') ? Number(getProp(m, 'context_window')) : null,
		// 能力标记
		caps: {
			functionCalling: isTrue(m, 'function_calling'),
			vision: isTrue(m, 'vision'),
			reasoning: isTrue(m, 'reasoning'),
			realtime: isTrue(m, 'realtime'),
			lora: isTrue(m, 'lora'),
		}
	})).sort((a, b) => a.name.localeCompare(b.name));
}

// 判定某个 CF 模型路径属于 free 还是 paid，优先用已同步的目录，否则回退到内置清单
function classifyModel(cfModelPath, catalog) {
	if (catalog && Array.isArray(catalog.models)) {
		const hit = catalog.models.find(m => m.name === cfModelPath);
		if (hit) return hit.paid ? 'paid' : 'free';
	}
	return KNOWN_PAID_MODELS.has(cfModelPath) ? 'paid' : 'free';
}

// 密钥的分组权限是否允许调用某个 CF 模型
function isModelAllowedForGroup(cfModelPath, group, catalog) {
	if (!group || group === 'all') return true;
	const cls = classifyModel(cfModelPath, catalog);
	return cls === group;
}

// 从模型全路径派生一个简洁别名：取末段（@cf/openai/gpt-oss-120b -> gpt-oss-120b）。
// 若末段在本次清单里出现冲突，则回退用完整路径当别名，保证唯一。
function buildAutoModelMap(models, existingMap = {}) {
	const segCount = {};
	for (const m of models) {
		const seg = String(m.name).split('/').pop();
		segCount[seg] = (segCount[seg] || 0) + 1;
	}
	const autoMap = {};
	for (const m of models) {
		const seg = String(m.name).split('/').pop();
		const alias = segCount[seg] > 1 ? m.name : seg; // 冲突则用全路径
		autoMap[alias] = m.name;
	}
	return autoMap;
}

// ----------------------------------------------------
// 管理员身份验证（同时支持 Cookie 和 Authorization 请求头）
// ----------------------------------------------------
async function checkAdminAuth(request, env) {
	// 1. 先从 Cookie 里取登录令牌（浏览器访问时走这里）
	const cookies = request.headers.get('Cookie') || '';
	const cookieMatch = cookies.match(/admin_token=([^;]+)/);
	let token = cookieMatch ? cookieMatch[1] : null;

	// 2. Cookie 里没有的话，再从 Authorization 请求头里取（API 工具调用时走这里）
	if (!token) {
		const authHeader = request.headers.get('Authorization');
		if (authHeader && authHeader.startsWith('Bearer ')) {
			token = authHeader.substring(7);
		}
	}

	if (!token) return false;

	const expectedPassword = env.ADMIN_PASSWORD ? env.ADMIN_PASSWORD.trim() : '';

	if (!expectedPassword) return false; // 还没配置管理员密码

	const expectedHash = await sha256(expectedPassword);
	return token === expectedHash;
}

// 校验管理员的登录 Cookie（用于页面访问的权限判断）
async function verifyAdminCookie(request, env) {
	const cookies = request.headers.get('Cookie') || '';
	const cookieMatch = cookies.match(/admin_token=([^;]+)/);
	if (!cookieMatch) return false;

	const token = cookieMatch[1];

	const expectedPassword = env.ADMIN_PASSWORD ? env.ADMIN_PASSWORD.trim() : '';
	if (!expectedPassword) return false;

	const expectedHash = await sha256(expectedPassword);
	return token === expectedHash;
}

// ----------------------------------------------------
// 代理接口的鉴权工具函数
// 返回 { authed, key }：
//   authed=true 且 key=null   -> 未配置任何密钥，公开可用（无分组限制）
//   authed=true 且 key=对象    -> 命中某个密钥（可能带 group 分组限制）
//   authed=false              -> 鉴权失败
// ----------------------------------------------------
async function resolveProxyKey(request, env) {
	const apiKeys = await getApiKeys(env);
	if (apiKeys.length === 0) {
		return { authed: true, key: null }; // 没配置任何密钥 = 不校验，谁都能用
	}

	// 先检查 x-api-key 头
	const xApiKey = request.headers.get('x-api-key');
	if (xApiKey) {
		const hit = apiKeys.find(k => k.key === xApiKey);
		if (hit) return { authed: true, key: hit };
	}

	// 再检查 Authorization: Bearer ***
	const authHeader = request.headers.get('Authorization');
	if (authHeader && authHeader.startsWith('Bearer ')) {
		const token = authHeader.substring(7);
		const hit = apiKeys.find(k => k.key === token);
		if (hit) return { authed: true, key: hit };
	}

	return { authed: false, key: null };
}

// 兼容旧调用：仅返回布尔
async function checkProxyAuth(request, env) {
	const { authed } = await resolveProxyKey(request, env);
	return authed;
}

// ----------------------------------------------------
// 用量统计的缓存工具函数
// ----------------------------------------------------
async function getCachedSummary(env) {
	const cached = await env.KV.get('cache_usage_summary');
	if (cached) {
		try {
			const data = JSON.parse(cached);
			if (Date.now() - data.timestamp < 300000) { // 缓存有效期 5 分钟
				return data;
			}
		} catch (e) { }
	}
	return null;
}

async function setCachedSummary(env, summaryData) {
	const data = {
		...summaryData,
		timestamp: Date.now()
	};
	await env.KV.put('cache_usage_summary', JSON.stringify(data));
}

async function refreshAccountsUsage(env, accounts, limit = 20) {
	const cachedDetailsRaw = await env.KV.get('cache_usage_details');
	let cacheMap = {};
	if (cachedDetailsRaw) {
		try {
			cacheMap = JSON.parse(cachedDetailsRaw) || {};
		} catch (e) {
			cacheMap = {};
		}
	}

	// 按最后更新的时间戳升序排序（时间戳为 0 或不存在的最先更新）
	const sortedAccounts = [...accounts].sort((a, b) => {
		const tA = cacheMap[a.id]?.timestamp || 0;
		const tB = cacheMap[b.id]?.timestamp || 0;
		return tA - tB;
	});

	const accountsToUpdate = sortedAccounts.slice(0, limit);

	const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
	sevenDaysAgo.setUTCHours(0, 0, 0, 0);
	const startSevenDays = sevenDaysAgo.toISOString().split('.')[0] + 'Z';

	const todayUTC = new Date();
	todayUTC.setUTCHours(0, 0, 0, 0);
	const startToday = todayUTC.toISOString().split('.')[0] + 'Z';

	const promises = accountsToUpdate.map(async (account) => {
		try {
			const [todayGroups, historyGroups] = await Promise.all([
				queryGraphQL(account.accountId, account.apiToken, startToday),
				queryGraphQL(account.accountId, account.apiToken, startSevenDays)
			]);
			const todayParsed = processAnalytics(todayGroups);
			const historyParsed = processAnalytics(historyGroups);

			cacheMap[account.id] = {
				status: 'active',
				error: null,
				usageToday: todayParsed.todayTotalNeurons,
				modelsToday: todayParsed.todayModels,
				history: historyParsed.history,
				timestamp: Date.now()
			};
		} catch (e) {
			console.error(`Error querying GraphQL for ${account.name}:`, e);
			cacheMap[account.id] = {
				status: 'error',
				error: e.message,
				usageToday: cacheMap[account.id]?.usageToday || 0,
				modelsToday: cacheMap[account.id]?.modelsToday || [],
				history: cacheMap[account.id]?.history || [],
				timestamp: Date.now() // 即使出错也更新时间戳，以便其他账号轮转刷新
			};
		}
	});

	await Promise.all(promises);
	await env.KV.put('cache_usage_details', JSON.stringify(cacheMap));
	return cacheMap;
}

// ----------------------------------------------------
// Cloudflare GraphQL 用量分析查询
// ----------------------------------------------------
async function queryGraphQL(accountId, apiToken, startDateTime) {
	const query = `
		query GetAIUsage($accountId: String!, $start: String!) {
			viewer {
				accounts(filter: { accountTag: $accountId }) {
					aiInferenceAdaptiveGroups(
						filter: { datetime_geq: $start }
						limit: 1000
					) {
						count
						sum {
							totalNeurons
						}
						dimensions {
							date
							modelId
						}
					}
				}
			}
		}
	`;
	const response = await fetch(`https://api.cloudflare.com/client/v4/graphql`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${apiToken}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			query,
			variables: {
				accountId,
				start: startDateTime
			}
		})
	});

	if (!response.ok) {
		throw new Error(`GraphQL API error: ${response.statusText}`);
	}

	const result = await response.json();
	if (result.errors && result.errors.length > 0) {
		throw new Error(result.errors[0].message);
	}

	return result?.data?.viewer?.accounts?.[0]?.aiInferenceAdaptiveGroups || [];
}

function processAnalytics(groups) {
	const todayStr = new Date().toISOString().split('T')[0];

	let todayTotalNeurons = 0;
	const todayModelsMap = {};
	const historyMap = {};

	// 先把最近 7 天的历史数据全部初始化为 0
	for (let i = 6; i >= 0; i--) {
		const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
		const dStr = d.toISOString().split('T')[0];
		historyMap[dStr] = 0;
	}

	for (const group of groups) {
		const date = group.dimensions.date;
		const model = group.dimensions.modelId;
		const neurons = group.sum.totalNeurons || 0;
		const count = group.count || 0;

		if (date === todayStr) {
			todayTotalNeurons += neurons;
			if (!todayModelsMap[model]) {
				todayModelsMap[model] = { model, neurons: 0, requests: 0 };
			}
			todayModelsMap[model].neurons += neurons;
			todayModelsMap[model].requests += count;
		}

		if (historyMap[date] !== undefined) {
			historyMap[date] += neurons;
		}
	}

	const todayModels = Object.values(todayModelsMap).sort((a, b) => b.neurons - a.neurons);
	const history = Object.keys(historyMap)
		.sort()
		.map(date => ({ date, neurons: historyMap[date] }));

	return {
		todayTotalNeurons,
		todayModels,
		history
	};
}

// ----------------------------------------------------
// OpenAI 兼容代理接口（/v1/）的处理函数
// ----------------------------------------------------
async function handleV1Proxy(request, env, ctx) {
	const url = new URL(request.url);

	// 1. 校验调用密钥（API Key），并拿到命中的密钥（含分组权限）
	const { authed, key: proxyKey } = await resolveProxyKey(request, env);
	if (!authed) {
		// /v1/messages 返回 Anthropic 格式错误，其他路径返回 OpenAI 格式
		if (url.pathname === '/v1/messages') {
			return new Response(JSON.stringify({
				type: 'error',
				error: {
					type: 'authentication_error',
					message: 'Invalid x-api-key or Authorization header.'
				}
			}), { status: 401, headers: { 'Content-Type': 'application/json' } });
		}
		return new Response(JSON.stringify({
			error: {
				message: "Incorrect or missing API key. Configure keys in the dashboard.",
				type: "invalid_request_error",
				param: null,
				code: "invalid_api_key"
			}
		}), { status: 401, headers: { 'Content-Type': 'application/json' } });
	}

	// 当前密钥允许的模型分组：all（默认/公开）| free | paid
	const keyGroup = proxyKey && proxyKey.group ? proxyKey.group : 'all';

	// 2. 获取模型列表接口（/v1/models）——按密钥分组过滤可见模型
	if (url.pathname === '/v1/models' && request.method === 'GET') {
		const combinedMap = await getCombinedModelMap(env);
		const { catalog } = await getModelCatalog(env);

		const modelsData = Object.keys(combinedMap)
			.filter(id => isModelAllowedForGroup(combinedMap[id], keyGroup, catalog))
			.map(id => {
				const isEmbedding = id.includes('embedding');
				return {
					id,
					object: 'model',
					created: 1686935000,
					owned_by: isEmbedding ? 'openai' : 'meta'
				};
			});


		return new Response(JSON.stringify({
			object: 'list',
			data: modelsData
		}), { headers: { 'Content-Type': 'application/json' } });
	}

	// 3. 对话补全 / 文本补全 接口
	if ((url.pathname === '/v1/chat/completions' || url.pathname === '/v1/completions') && request.method === 'POST') {
		return handleCompletions(request, env, url.pathname, keyGroup);
	}

	// 4. Anthropic Messages API 接口（/v1/messages）
	if (url.pathname === '/v1/messages' && request.method === 'POST') {
		return handleMessages(request, env, keyGroup);
	}

	// 向量嵌入接口
	if (url.pathname === '/v1/embeddings' && request.method === 'POST') {
		return handleEmbeddings(request, env, keyGroup);
	}

	return new Response(JSON.stringify({
		error: { message: `Path not found: ${url.pathname}`, type: "invalid_request_error" }
	}), { status: 404, headers: { 'Content-Type': 'application/json' } });
}

// ----------------------------------------------------
// 可复用的核心 API 调用函数
// 将 OpenAI Chat Completions 格式的请求发送到 Cloudflare AI 网关，
// 支持多账号负载均衡和故障自动切换。
// 返回格式：{ success: true, data: cfJson } 或 { success: false, error: "..." }
// ----------------------------------------------------
async function callOpenAICompatibleAPI(cfPayload, env, stream) {
	const accounts = await getAccounts(env);
	const activeAccounts = accounts.filter(a => a.status === 'active');
	if (activeAccounts.length === 0) {
		return { success: false, error: "No active Cloudflare accounts configured. Add them in the WebUI." };
	}

	const shuffledAccounts = [...activeAccounts].sort(() => Math.random() - 0.5);
	let lastError = null;

	for (const account of shuffledAccounts) {
		try {
			const cfResponse = await fetch(
				`https://api.cloudflare.com/client/v4/accounts/${account.accountId}/ai/v1/chat/completions`,
				{
					method: 'POST',
					headers: {
						'Authorization': `Bearer ${account.apiToken}`,
						'Content-Type': 'application/json',
					},
					body: JSON.stringify(cfPayload),
				}
			);

			if (cfResponse.ok) {
				if (stream) {
					return { success: true, stream: cfResponse.body };
				} else {
					const cfJson = await cfResponse.json();
					return { success: true, data: cfJson };
				}
			} else {
				const errorText = await cfResponse.text();
				lastError = `CF API returned ${cfResponse.status}: ${errorText}`;
			}
		} catch (e) {
			lastError = `Connection error: ${e.message}`;
		}
	}

	return { success: false, error: `All Cloudflare accounts failed. Last error: ${lastError}` };
}

// 共享的模型名解析函数：根据用户传入的模型名，映射到 Cloudflare 实际模型
async function resolveModelName(model, env) {
	if (model.startsWith('@cf/')) return model;
	const combinedMap = await getCombinedModelMap(env);
	return combinedMap[model] || '@cf/zai-org/glm-4.7-flash';
}

// 分组权限拒绝时的统一响应（OpenAI 格式）
function modelGroupDeniedResponse(cfModel, group) {
	return new Response(JSON.stringify({
		error: {
			message: `Model '${cfModel}' is not allowed for this API key (group: ${group}). This key can only access ${group} models.`,
			type: "invalid_request_error",
			param: "model",
			code: "model_not_in_group"
		}
	}), { status: 403, headers: { 'Content-Type': 'application/json' } });
}

// 对话补全 / 文本补全 的代理处理函数
async function handleCompletions(request, env, pathname, keyGroup = 'all') {
	let body;
	try {
		body = await request.json();
	} catch (e) {
		return new Response(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }), { status: 400 });
	}

	const { model, messages, prompt, stream } = body;

	if (pathname === '/v1/chat/completions' && !messages) {
		return new Response(JSON.stringify({ error: { message: "messages field is required", type: "invalid_request_error" } }), { status: 400 });
	}
	if (pathname === '/v1/completions' && !prompt) {
		return new Response(JSON.stringify({ error: { message: "prompt field is required", type: "invalid_request_error" } }), { status: 400 });
	}

	// 解析模型名映射
	const cfModel = await resolveModelName(model, env);

	// 分组权限校验：指定 free/paid 分组的密钥只能调用对应分组的模型
	if (keyGroup && keyGroup !== 'all') {
		const { catalog } = await getModelCatalog(env);
		if (!isModelAllowedForGroup(cfModel, keyGroup, catalog)) {
			return modelGroupDeniedResponse(cfModel, keyGroup);
		}
	}

	// 构造发给 Cloudflare 的请求体
	const cfPayload = {
		model: cfModel,
		messages: pathname === '/v1/chat/completions' ? messages : [{ role: 'user', content: prompt }],
		stream: !!stream,
	};

	const passthroughFields = [
		'temperature', 'max_tokens', 'top_p', 'n',
		'stop', 'presence_penalty', 'frequency_penalty',
		'logprobs', 'top_logprobs', 'seed', 'user',
		'tools', 'tool_choice', 'parallel_tool_calls',
		'response_format',
	];
	for (const field of passthroughFields) {
		if (body[field] !== undefined) cfPayload[field] = body[field];
	}

	const result = await callOpenAICompatibleAPI(cfPayload, env, stream);

	if (!result.success) {
		return new Response(JSON.stringify({
			error: { message: result.error, type: "server_error" }
		}), { status: 502, headers: { 'Content-Type': 'application/json' } });
	}

	if (stream) {
		const transformedStream = passthroughStream(result.stream, model);
		return new Response(transformedStream, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
				'Transfer-Encoding': 'chunked',
			},
		});
	} else {
		const cfJson = result.data;
		if (cfJson.model !== undefined) cfJson.model = model;
		return new Response(JSON.stringify(cfJson), {
			headers: { 'Content-Type': 'application/json' },
		});
	}
}

// ----------------------------------------------------
// Anthropic Messages API → OpenAI Chat Completions 格式转换
// ----------------------------------------------------
function convertAnthropicToOpenAI(anthropicBody) {
	const openaiBody = {};

	// model 直接映射
	openaiBody.model = anthropicBody.model;

	// max_tokens 直接映射
	if (anthropicBody.max_tokens !== undefined) {
		openaiBody.max_tokens = anthropicBody.max_tokens;
	}

	// stream 直接映射
	if (anthropicBody.stream !== undefined) {
		openaiBody.stream = anthropicBody.stream;
	}

	// temperature 直接映射
	if (anthropicBody.temperature !== undefined) {
		openaiBody.temperature = anthropicBody.temperature;
	}

	// top_p 直接映射
	if (anthropicBody.top_p !== undefined) {
		openaiBody.top_p = anthropicBody.top_p;
	}

	// stop_sequences → stop
	if (anthropicBody.stop_sequences !== undefined) {
		openaiBody.stop = anthropicBody.stop_sequences;
	}

	// 构建 OpenAI 格式的 messages 数组
	const openaiMessages = [];

	// Anthropic system 字段 → OpenAI system role message (插入到 messages 最前面)
	if (anthropicBody.system) {
		let systemContent = '';
		if (typeof anthropicBody.system === 'string') {
			systemContent = anthropicBody.system;
		} else if (Array.isArray(anthropicBody.system)) {
			// system 为数组格式：[{type: "text", text: "..."}, ...]
			for (const block of anthropicBody.system) {
				if (block.type === 'text' && block.text) {
					systemContent += block.text + '\n';
				}
			}
			systemContent = systemContent.trim();
		}
		if (systemContent) {
			openaiMessages.push({ role: 'system', content: systemContent });
		}
	}

	// 转换 messages
	for (const msg of anthropicBody.messages) {
		const role = msg.role;
		const content = msg.content;

		// Anthropic 的 content 可能是字符串或数组
		if (typeof content === 'string') {
			openaiMessages.push({ role, content });
		} else if (Array.isArray(content)) {

			// assistant 消息：text 和 tool_use 需合并为一条消息（Bug #4）
			if (role === 'assistant') {
				let textContent = '';
				const toolCalls = [];

				for (const block of content) {
					if (block.type === 'text') {
						textContent += block.text || '';
					} else if (block.type === 'tool_use') {
						toolCalls.push({
							id: block.id,
							type: 'function',
							function: {
								name: block.name,
								arguments: JSON.stringify(block.input || {})
							}
						});
					}
				}

				const assistantMsg = { role: 'assistant', content: textContent || null };
				if (toolCalls.length > 0) {
					assistantMsg.tool_calls = toolCalls;
				}
				openaiMessages.push(assistantMsg);
				continue;
			}

			// user 消息：先处理 tool_result，再处理 text/image（Bug #5）
			if (role === 'user') {
				// 先处理 tool_result 块
				for (const block of content) {
					if (block.type === 'tool_result') {
						let resultContent = '';
						if (typeof block.content === 'string') {
							resultContent = block.content;
						} else if (Array.isArray(block.content)) {
							for (const c of block.content) {
								if (c.type === 'text' && c.text) {
									resultContent += c.text;
								}
							}
						}
						const toolMsg = {
							role: 'tool',
							tool_call_id: block.tool_use_id,
							content: resultContent
						};
						if (block.name) toolMsg.name = block.name;
						openaiMessages.push(toolMsg);
					}
				}

				// 再处理剩余的 text 和 image 块
				const openaiContentParts = [];
				for (const block of content) {
					if (block.type === 'text') {
						openaiContentParts.push({ type: 'text', text: block.text || '' });
					} else if (block.type === 'image') {
						// Anthropic image source → OpenAI image_url
						const source = block.source || {};
						let imageUrl = '';
						if (source.type === 'url' && source.url) {
							// URL 类型图片（Bug #3）
							imageUrl = source.url;
						} else if (source.data) {
							const mediaType = source.media_type || 'image/png';
							imageUrl = `data:${mediaType};base64,${source.data}`;
						}
						if (imageUrl) {
							openaiContentParts.push({
								type: 'image_url',
								image_url: { url: imageUrl }
							});
						}
					}
				}

				if (openaiContentParts.length > 0) {
					openaiMessages.push({ role: 'user', content: openaiContentParts });
				}
				continue;
			}

			// 兜底：其他角色只处理 text 块
			const openaiContentParts = [];
			for (const block of content) {
				if (block.type === 'text') {
					openaiContentParts.push({ type: 'text', text: block.text || '' });
				}
			}
			if (openaiContentParts.length > 0) {
				openaiMessages.push({ role, content: openaiContentParts });
			}
		}
	}

	// 确保第一条消息是 user（OpenAI 要求第一条消息必须是 user 或 system）
	// 如果第一条是 assistant（来自 Anthropic 的多轮 tool calling），在它前面插入一条占位 user 消息
	const firstNonSystemMsg = openaiMessages.find(m => m.role !== 'system');
	if (firstNonSystemMsg && firstNonSystemMsg.role === 'assistant') {
		// 找到 system 消息后的位置，插入一条空的 user 消息
		const systemCount = openaiMessages.filter(m => m.role === 'system').length;
		openaiMessages.splice(systemCount, 0, {
			role: 'user',
			content: '_'
		});
	}

	openaiBody.messages = openaiMessages;

	// tools 字段转换：Anthropic 格式 → OpenAI 格式
	if (anthropicBody.tools && Array.isArray(anthropicBody.tools)) {
		openaiBody.tools = anthropicBody.tools.map(tool => ({
			type: 'function',
			function: {
				name: tool.name,
				description: tool.description || '',
				parameters: tool.input_schema || {}
			}
		}));
	}

	// tool_choice 转换
	if (anthropicBody.tool_choice) {
		const tc = anthropicBody.tool_choice;
		if (tc.type === 'auto') {
			openaiBody.tool_choice = 'auto';
		} else if (tc.type === 'any') {
			openaiBody.tool_choice = 'required';
		} else if (tc.type === 'tool' && tc.name) {
			openaiBody.tool_choice = { type: 'function', function: { name: tc.name } };
		}
	}

	return openaiBody;
}

// ----------------------------------------------------
// OpenAI Chat Completion 响应 → Anthropic Messages 格式转换
// ----------------------------------------------------
function convertOpenAIToAnthropic(openaiResponse, originalModel) {
	const choice = openaiResponse.choices?.[0] || {};
	const message = choice.message || {};

	const anthropicResponse = {
		id: `msg_${crypto.randomUUID()}`,
		type: 'message',
		role: 'assistant',
		content: [],
		model: originalModel,
		stop_reason: null,
		stop_sequence: null,
		usage: {
			input_tokens: openaiResponse.usage?.prompt_tokens || 0,
			output_tokens: openaiResponse.usage?.completion_tokens || 0
		}
	};

	// 文本内容 → text block
	if (message.content) {
		anthropicResponse.content.push({
			type: 'text',
			text: message.content
		});
	}

	// tool_calls → tool_use blocks
	if (message.tool_calls && Array.isArray(message.tool_calls)) {
		for (const tc of message.tool_calls) {
			let inputObj = {};
			try {
				inputObj = typeof tc.function.arguments === 'string'
					? JSON.parse(tc.function.arguments)
					: tc.function.arguments;
			} catch (_) {
				inputObj = {};
			}
			anthropicResponse.content.push({
				type: 'tool_use',
				id: tc.id,
				name: tc.function.name,
				input: inputObj
			});
		}
	}

	// finish_reason → stop_reason 映射
	const finishReason = choice.finish_reason;
	if (finishReason === 'stop') {
		anthropicResponse.stop_reason = 'end_turn';
	} else if (finishReason === 'tool_calls') {
		anthropicResponse.stop_reason = 'tool_use';
	} else if (finishReason === 'length') {
		anthropicResponse.stop_reason = 'max_tokens';
	} else {
		anthropicResponse.stop_reason = finishReason || 'end_turn';
	}

	return anthropicResponse;
}

// ----------------------------------------------------
// OpenAI 错误响应 → Anthropic 错误格式转换
// ----------------------------------------------------
function convertOpenAIErrorToAnthropic(openaiError, statusCode) {
	return {
		type: 'error',
		error: {
			type: 'api_error',
			message: openaiError?.error?.message || openaiError?.message || 'Unknown error'
		}
	};
}

// ----------------------------------------------------
// Anthropic /v1/messages 路由处理函数
// ----------------------------------------------------
async function handleMessages(request, env, keyGroup = 'all') {
	// 认证由 handleV1Proxy 的 checkProxyAuth 统一处理（支持 x-api-key + Bearer）

	// 解析请求体
	let anthropicBody;
	try {
		anthropicBody = await request.json();
	} catch (e) {
		return new Response(JSON.stringify({
			type: 'error',
			error: { type: 'invalid_request_error', message: 'Invalid JSON body.' }
		}), { status: 400, headers: { 'Content-Type': 'application/json' } });
	}

	// 基本参数校验
	if (!anthropicBody.messages || !Array.isArray(anthropicBody.messages)) {
		return new Response(JSON.stringify({
			type: 'error',
			error: { type: 'invalid_request_error', message: 'messages field is required and must be an array.' }
		}), { status: 400, headers: { 'Content-Type': 'application/json' } });
	}
	if (!anthropicBody.max_tokens) {
		return new Response(JSON.stringify({
			type: 'error',
			error: { type: 'invalid_request_error', message: 'max_tokens is required.' }
		}), { status: 400, headers: { 'Content-Type': 'application/json' } });
	}

	// 解析模型名映射
	const model = anthropicBody.model;
	const cfModel = await resolveModelName(model, env);

	// 分组权限校验
	if (keyGroup && keyGroup !== 'all') {
		const { catalog } = await getModelCatalog(env);
		if (!isModelAllowedForGroup(cfModel, keyGroup, catalog)) {
			return new Response(JSON.stringify({
				type: 'error',
				error: { type: 'invalid_request_error', message: `Model '${cfModel}' is not allowed for this API key (group: ${keyGroup}).` }
			}), { status: 403, headers: { 'Content-Type': 'application/json' } });
		}
	}

	// Anthropic → OpenAI 格式转换
	const openaiBody = convertAnthropicToOpenAI(anthropicBody);
	openaiBody.model = cfModel;

	const stream = !!anthropicBody.stream;

	const result = await callOpenAICompatibleAPI(openaiBody, env, stream);

	if (!result.success) {
		// 尝试解析 CF 错误详情
		let errorDetail;
		try {
			if (result.error && result.error.includes('CF API returned')) {
				const match = result.error.match(/CF API returned \d+: (.+)/);
				if (match) {
					errorDetail = JSON.parse(match[1]);
				}
			}
		} catch (_) { }

		const anthropicError = convertOpenAIErrorToAnthropic(
			errorDetail || { message: result.error },
			502
		);
		return new Response(JSON.stringify(anthropicError), {
			status: 502,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	if (stream) {
		// 流式：转换流
		const transformedStream = anthropicStreamTransform(result.stream, model, anthropicBody.messages);
		return new Response(transformedStream, {
			headers: {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
				'Transfer-Encoding': 'chunked',
			},
		});
	} else {
		// 非流式：转换响应
		const openaiResponse = result.data;
		const anthropicResponse = convertOpenAIToAnthropic(openaiResponse, model);
		return new Response(JSON.stringify(anthropicResponse), {
			headers: { 'Content-Type': 'application/json' },
		});
	}
}

// ----------------------------------------------------
// Anthropic SSE 流式转换
// 将 OpenAI SSE 格式实时转换为 Anthropic SSE 格式
// ----------------------------------------------------
function anthropicStreamTransform(upstreamBody, modelName, originalMessages) {
	const reader = upstreamBody.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = '';
	let messageId = `msg_${crypto.randomUUID()}`;
	let contentBlockIndex = -1;  // 首次递增后从 0 开始（Bug #8）
	let currentToolCallId = null;
	let currentToolName = null;
	let currentToolArgs = '';
	let streamStarted = false;
	let blockStopSent = false;  // 跟踪最后一个 content block 是否已发送 stop（Bug #2）
	let inputTokens = 0;
	let outputTokens = 0;

	let enqueuedAny = false;

	return new ReadableStream({
		async pull(controller) {
			enqueuedAny = false;
			const originalEnqueue = controller.enqueue.bind(controller);
			controller.enqueue = (chunk) => {
				enqueuedAny = true;
				originalEnqueue(chunk);
			};

			while (true) {
				const { value, done } = await reader.read();
				if (done) {
					if (buffer.trim()) {
						buffer = processLines(buffer, controller);
					}
					controller.close();
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				buffer = processLines(buffer, controller);

				if (buffer.indexOf('\n') === -1) {
					if (enqueuedAny) {
						break;
					}
				}
			}
		},
		cancel() {
			reader.cancel();
		},
	});

	function processLines(data, controller) {
		const lines = data.split('\n');
		const remaining = lines.pop();

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			if (trimmed.startsWith('data: ')) {
				const dataStr = trimmed.slice(6);
				if (dataStr === '[DONE]') {
					// 发送最终事件
					sendFinalEvent(controller);
					continue;
				}

				try {
					const chunk = JSON.parse(dataStr);
					const choice = chunk.choices?.[0];
					if (!choice) continue;

					const delta = choice.delta || {};

					// 更新 usage
					if (chunk.usage) {
						inputTokens = chunk.usage.prompt_tokens || 0;
						outputTokens = chunk.usage.completion_tokens || 0;
					}

					// 处理 tool_calls delta
					if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
						// 首次发送任何数据前先发送 message_start（Bug #1）
						if (!streamStarted) {
							sendMessageStart(controller);
							streamStarted = true;
						}

						for (const tc of delta.tool_calls) {
							if (tc.id) {
								// 新的 tool_call 开始
								if (currentToolCallId) {
									// 先结束上一个
									sendContentBlockStop(controller);
									blockStopSent = true;
								}
								currentToolCallId = tc.id;
								currentToolName = tc.function?.name || '';
								currentToolArgs = '';
								contentBlockIndex++;
								blockStopSent = false;

								sendContentBlockStart(controller, 'tool_use');
							}

							if (tc.function?.arguments) {
								currentToolArgs += tc.function.arguments;
								// 发送 tool_use 的 input_json_delta
								sendToolUseDelta(controller, tc.function.arguments);
							}
						}
					} else if (delta.content) {
						// 文本内容 delta
						if (!streamStarted) {
							sendMessageStart(controller);
							contentBlockIndex++;
							sendContentBlockStart(controller, 'text');
							streamStarted = true;
							blockStopSent = false;
						}

						// 如果之前有 tool_call 在进行中，先结束
						if (currentToolCallId) {
							sendContentBlockStop(controller);
							blockStopSent = true;
							currentToolCallId = null;
							currentToolName = null;
							currentToolArgs = '';

							// 开始新的 text block
							contentBlockIndex++;
							sendContentBlockStart(controller, 'text');
							blockStopSent = false;
						}

						sendTextDelta(controller, delta.content);
					}

					// 检查 finish_reason
					if (choice.finish_reason) {
						if (currentToolCallId && currentToolArgs) {
							// 发送最终的 tool_use input
							sendToolUseFinalInput(controller);
						}
					}
				} catch (_) {
					// 忽略解析错误
				}
			}
		}
		return remaining;
	}

	function sendMessageStart(controller) {
		const event = {
			type: 'message_start',
			message: {
				id: messageId,
				type: 'message',
				role: 'assistant',
				content: [],
				model: modelName,
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: inputTokens, output_tokens: outputTokens }
			}
		};
		controller.enqueue(encoder.encode(`event: message_start\ndata: ${JSON.stringify(event)}\n\n`));
	}

	function sendContentBlockStart(controller, blockType) {
		const event = {
			type: 'content_block_start',
			index: contentBlockIndex,
			content_block: blockType === 'tool_use'
				? { type: 'tool_use', id: currentToolCallId, name: currentToolName, input: {} }
				: { type: 'text', text: '' }
		};
		controller.enqueue(encoder.encode(`event: content_block_start\ndata: ${JSON.stringify(event)}\n\n`));
	}

	function sendTextDelta(controller, text) {
		const event = {
			type: 'content_block_delta',
			index: contentBlockIndex,
			delta: { type: 'text_delta', text }
		};
		controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`));
	}

	function sendToolUseDelta(controller, argsDelta) {
		const event = {
			type: 'content_block_delta',
			index: contentBlockIndex,
			delta: { type: 'input_json_delta', partial_json: argsDelta }
		};
		controller.enqueue(encoder.encode(`event: content_block_delta\ndata: ${JSON.stringify(event)}\n\n`));
	}

	function sendToolUseFinalInput(controller) {
		// 发送最终的 content_block_stop
		controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({
			type: 'content_block_stop',
			index: contentBlockIndex
		})}\n\n`));
		blockStopSent = true;
	}

	function sendContentBlockStop(controller) {
		controller.enqueue(encoder.encode(`event: content_block_stop\ndata: ${JSON.stringify({
			type: 'content_block_stop',
			index: contentBlockIndex
		})}\n\n`));
	}

	function sendFinalEvent(controller) {
		// 如果 finish_reason 触发时已发送过 content_block_stop，跳过重复发送（Bug #2）
		if (!blockStopSent) {
			sendContentBlockStop(controller);
		}

		let stopReason = 'end_turn';
		if (currentToolCallId) {
			stopReason = 'tool_use';
		}

		const event = {
			type: 'message_delta',
			delta: {
				stop_reason: stopReason,
				stop_sequence: null
			},
			usage: { output_tokens: outputTokens || 0 }
		};
		controller.enqueue(encoder.encode(`event: message_delta\ndata: ${JSON.stringify(event)}\n\n`));

		controller.enqueue(encoder.encode(`event: message_stop\ndata: ${JSON.stringify({
			type: 'message_stop'
		})}\n\n`));
	}
}

// 向量嵌入（Embeddings）的代理处理函数
async function handleEmbeddings(request, env, keyGroup = 'all') {
	let body;
	try {
		body = await request.json();
	} catch (e) {
		return new Response(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }), { status: 400 });
	}

	const { model, input } = body;
	if (!input) {
		return new Response(JSON.stringify({ error: { message: "input is required", type: "invalid_request_error" } }), { status: 400 });
	}

	// 解析模型名映射
	let cfModel = model;
	if (!cfModel.startsWith('@cf/')) {
		const combinedMap = await getCombinedModelMap(env);
		cfModel = combinedMap[model];
		if (!cfModel) {
			cfModel = '@cf/baai/bge-m3'; // 找不到映射就用这个默认模型兜底
		}
	}

	// 分组权限校验
	if (keyGroup && keyGroup !== 'all') {
		const { catalog } = await getModelCatalog(env);
		if (!isModelAllowedForGroup(cfModel, keyGroup, catalog)) {
			return modelGroupDeniedResponse(cfModel, keyGroup);
		}
	}

	const textArray = Array.isArray(input) ? input : [input];
	const accounts = await getAccounts(env);
	const activeAccounts = accounts.filter(a => a.status === 'active');
	if (activeAccounts.length === 0) {
		return new Response(JSON.stringify({ error: { message: "No active accounts configured", type: "server_error" } }), { status: 503 });
	}

	const shuffledAccounts = [...activeAccounts].sort(() => Math.random() - 0.5);
	let lastError = null;

	for (const account of shuffledAccounts) {
		try {
			const cfResponse = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account.accountId}/ai/run/${cfModel}`, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${account.apiToken}`,
					'Content-Type': 'application/json'
				},
				body: JSON.stringify({ text: textArray })
			});

			if (cfResponse.ok) {
				const cfJson = await cfResponse.json();
				if (cfJson.success) {
					const embeddings = cfJson.result.data.map((emb, index) => ({
						object: "embedding",
						index: index,
						embedding: emb
					}));

					const responseObj = {
						object: "list",
						data: embeddings,
						model: model,
						usage: {
							prompt_tokens: textArray.reduce((acc, text) => acc + Math.ceil(text.length / 4), 0),
							total_tokens: textArray.reduce((acc, text) => acc + Math.ceil(text.length / 4), 0)
						}
					};
					return new Response(JSON.stringify(responseObj), { headers: { 'Content-Type': 'application/json' } });
				} else {
					lastError = `CF Run failed: ${JSON.stringify(cfJson.errors)}`;
				}
			} else {
				const errorText = await cfResponse.text();
				lastError = `CF API status ${cfResponse.status}: ${errorText}`;
			}
		} catch (e) {
			lastError = `Connection error: ${e.message}`;
		}
	}

	return new Response(JSON.stringify({
		error: { message: `All Cloudflare accounts failed. Last error: ${lastError}`, type: "server_error" }
	}), { status: 502, headers: { 'Content-Type': 'application/json' } });
}

// 粗略估算 token 数量（按每 4 个字符约 1 个 token 估算）
function estimateUsage(messages, answer) {
	let promptChars = 0;
	for (const msg of messages) {
		promptChars += (msg.content || '').length;
	}
	const completionChars = (answer || '').length;

	const promptTokens = Math.ceil(promptChars / 4);
	const completionTokens = Math.ceil(completionChars / 4);

	return {
		prompt_tokens: promptTokens,
		completion_tokens: completionTokens,
		total_tokens: promptTokens + completionTokens
	};
}

// 透传 CF /ai/v1/chat/completions 返回的 SSE 流
// CF 返回的本来就是标准 OpenAI 的 SSE 格式，我们只把模型名改一下，
// 这样 tool_calls、finish_reason、reasoning_content、usage 等字段都能原样保留。
function passthroughStream(upstreamBody, modelName) {
	const reader = upstreamBody.getReader();
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = '';

	return new ReadableStream({
		async pull(controller) {
			while (true) {
				const { value, done } = await reader.read();
				if (done) {
					// 把缓冲区里剩下的内容输出掉
					if (buffer.trim()) {
						buffer = processLines(buffer, controller);
					}
					controller.enqueue(encoder.encode('data: [DONE]\n\n'));
					controller.close();
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				buffer = processLines(buffer, controller);

				if (buffer.indexOf('\n') === -1) {
					break;
				}
			}
		},
		cancel() {
			reader.cancel();
		},
	});

	function processLines(data, controller) {
		const lines = data.split('\n');
		const remaining = lines.pop(); // 把最后可能不完整的一行留在缓冲区里

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			if (trimmed.startsWith('data: ')) {
				const dataStr = trimmed.slice(6);
				if (dataStr === '[DONE]') continue;

				try {
					const chunk = JSON.parse(dataStr);
					// 只改模型名，其他字段全部原样透传
					// 这样 tool_calls、finish_reason、usage、reasoning_content 都能保留下来
					if (chunk.model !== undefined) chunk.model = modelName;
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
				} catch (_) {
					// 解析不了的行，按原样转发
					controller.enqueue(encoder.encode(`${line}\n`));
				}
			} else {
				// 非 data 开头的 SSE 行（注释、事件等），原样转发
				controller.enqueue(encoder.encode(`${line}\n`));
			}
		}
		return remaining;
	}
}

// ----------------------------------------------------
// 后台管理面板的 API 接口处理函数
// ----------------------------------------------------
async function handleDashboardApi(request, env, ctx) {
	const url = new URL(request.url);
	const method = request.method;

	// 1. 查询初始化状态（密码通过环境变量配置，所以这里永远返回已初始化）
	if (url.pathname === '/api/auth/status' && method === 'GET') {
		return new Response(JSON.stringify({
			isSetup: true
		}), { headers: { 'Content-Type': 'application/json' } });
	}

	// 2. 设置首个管理员密码（已停用，改由环境变量 ADMIN_PASSWORD 配置）
	if (url.pathname === '/api/auth/setup' && method === 'POST') {
		return new Response(JSON.stringify({ error: 'Setup is handled via environment variable ADMIN_PASSWORD' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
	}

	// 3. 登录（直接比对密码，不读写 KV，既快又省钱）
	if (url.pathname === '/api/auth/login' && method === 'POST') {
		const { password } = await request.json();
		const expectedPassword = env.ADMIN_PASSWORD ? env.ADMIN_PASSWORD.trim() : '';
		if (password === expectedPassword) {
			const token = await sha256(password);
			return new Response(JSON.stringify({ success: true }), {
				headers: {
					'Content-Type': 'application/json',
					'Set-Cookie': `admin_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`
				}
			});
		} else {
			return new Response(JSON.stringify({ error: 'Incorrect password' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
		}
	}

	// 4. 退出登录
	if (url.pathname === '/api/auth/logout' && method === 'POST') {
		return new Response(JSON.stringify({ success: true }), {
			headers: {
				'Content-Type': 'application/json',
				'Set-Cookie': `admin_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
			}
		});
	}

	// 5. 公开的用量汇总（首页未登录时也能看到）
	if (url.pathname === '/api/usage/summary') {
		if (method === 'GET') {
			const cached = await getCachedSummary(env);
			if (cached) {
				return new Response(JSON.stringify(cached), { headers: { 'Content-Type': 'application/json' } });
			}

			const accounts = await getAccounts(env);
			if (accounts.length === 0) {
				return new Response(JSON.stringify({
					totalNeuronsToday: 0,
					totalAccounts: 0,
					totalLimit: 0,
					usagePercentage: 0,
					needUpdate: false
				}), { headers: { 'Content-Type': 'application/json' } });
			}

			// 读取缓存的卡片明细来检查更新时间
			const cachedDetailsRaw = await env.KV.get('cache_usage_details');
			let cacheMap = {};
			if (cachedDetailsRaw) {
				try {
					cacheMap = JSON.parse(cachedDetailsRaw) || {};
				} catch (e) { }
			}

			// 判断是否有任意一个账号的更新时间超过了 20 分钟 (20 * 60 * 1000)
			const now = Date.now();
			const hasOutdated = accounts.some(account => {
				const lastUpdated = cacheMap[account.id]?.timestamp || 0;
				return (now - lastUpdated) > 20 * 60 * 1000;
			});

			// 计算当前缓存中的汇总数据和模型占比
			let totalNeuronsToday = 0;
			let modelsToday = {};
			accounts.forEach(account => {
				const cachedItem = cacheMap[account.id];
				if (cachedItem) {
					if (cachedItem.usageToday) {
						totalNeuronsToday += cachedItem.usageToday;
					}
					if (cachedItem.modelsToday) {
						cachedItem.modelsToday.forEach(m => {
							modelsToday[m.model] = (modelsToday[m.model] || 0) + m.neurons;
						});
					}
				}
			});

			const formattedModelsToday = Object.keys(modelsToday).map(model => ({
				model,
				neurons: modelsToday[model]
			}));

			const totalLimit = accounts.length * 10000;
			const usagePercentage = totalLimit > 0 ? parseFloat(((totalNeuronsToday / totalLimit) * 100).toFixed(2)) : 0;

			const summary = {
				totalNeuronsToday,
				totalAccounts: accounts.length,
				totalLimit,
				usagePercentage,
				modelsToday: formattedModelsToday,
				needUpdate: hasOutdated
			};

			await setCachedSummary(env, summary);
			return new Response(JSON.stringify(summary), { headers: { 'Content-Type': 'application/json' } });
		}

		if (method === 'POST') {
			const accounts = await getAccounts(env);
			if (accounts.length === 0) {
				return new Response(JSON.stringify({
					totalNeuronsToday: 0,
					totalAccounts: 0,
					totalLimit: 0,
					usagePercentage: 0,
					modelsToday: [],
					needUpdate: false
				}), { headers: { 'Content-Type': 'application/json' } });
			}

			// 刷新最老数据的 20 个账号
			const cacheMap = await refreshAccountsUsage(env, accounts, 20);

			// 计算最新总量和模型占比
			let totalNeuronsToday = 0;
			let modelsToday = {};
			accounts.forEach(account => {
				const cachedItem = cacheMap[account.id];
				if (cachedItem) {
					if (cachedItem.usageToday) {
						totalNeuronsToday += cachedItem.usageToday;
					}
					if (cachedItem.modelsToday) {
						cachedItem.modelsToday.forEach(m => {
							modelsToday[m.model] = (modelsToday[m.model] || 0) + m.neurons;
						});
					}
				}
			});

			const formattedModelsToday = Object.keys(modelsToday).map(model => ({
				model,
				neurons: modelsToday[model]
			}));

			const totalLimit = accounts.length * 10000;
			const usagePercentage = totalLimit > 0 ? parseFloat(((totalNeuronsToday / totalLimit) * 100).toFixed(2)) : 0;

			const summary = {
				totalNeuronsToday,
				totalAccounts: accounts.length,
				totalLimit,
				usagePercentage,
				modelsToday: formattedModelsToday,
				needUpdate: false
			};

			await setCachedSummary(env, summary);
			return new Response(JSON.stringify(summary), { headers: { 'Content-Type': 'application/json' } });
		}
	}

	// --------------------------------------------------
	// 下面这些都是需要登录后才能访问的接口
	// --------------------------------------------------
	const isAuthorized = await checkAdminAuth(request, env);
	if (!isAuthorized) {
		return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
	}

	if (url.pathname === '/api/accounts') {
		if (method === 'GET') {
			const accounts = await getAccounts(env);
			return new Response(JSON.stringify(accounts), { headers: { 'Content-Type': 'application/json' } });
		}

		if (method === 'POST') {
			const { id, name, accountId, apiToken } = await request.json();
			if (!accountId || !apiToken) {
				return new Response(JSON.stringify({ error: 'AccountId and ApiToken are required' }), { status: 400 });
			}

			let accounts = await getAccounts(env);
			if (id) {
				// 编辑已有账号
				accounts = accounts.map(a => {
					if (a.id === id) {
						const updatedToken = (apiToken.includes('...') || apiToken === '********') ? a.apiToken : apiToken;
						return { ...a, name: name || a.name, accountId, apiToken: updatedToken };
					}
					return a;
				});
			} else {
				// 新增账号
				accounts.push({
					id: crypto.randomUUID(),
					name: name || 'CF Account',
					accountId,
					apiToken,
					status: 'active'
				});
			}
			await saveAccounts(env, accounts);
			return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
		}

		if (method === 'DELETE') {
			const { id } = await request.json();
			let accounts = await getAccounts(env);
			accounts = accounts.filter(a => a.id !== id);
			await saveAccounts(env, accounts);
			return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
		}
	}

	// 7. 测试账号是否能正常连接
	if (url.pathname === '/api/accounts/test' && method === 'POST') {
		const { id, accountId, apiToken } = await request.json();
		let targetAccountId = accountId;
		let targetApiToken = apiToken;

		if (id) {
			const accounts = await getAccounts(env);
			const acc = accounts.find(a => a.id === id);
			if (acc) {
				if (!targetAccountId) targetAccountId = acc.accountId;
				if (!targetApiToken || targetApiToken.includes('...') || targetApiToken === '********') {
					targetApiToken = acc.apiToken;
				}
			}
		}

		if (!targetAccountId || !targetApiToken) {
			return new Response(JSON.stringify({ success: false, error: 'Account info not found' }), { status: 400 });
		}

		const [readResult, editResult, analyticsResult] = await Promise.all([
			// 1. Workers AI > Read
			(async () => {
				try {
					const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${targetAccountId}/ai/models/search?limit=1`, {
						method: 'GET',
						headers: {
							'Authorization': `Bearer ${targetApiToken}`,
							'Content-Type': 'application/json'
						}
					});
					const data = await res.json();
					if (res.ok && data.success !== false) {
						return { success: true };
					}
					return { success: false, error: data.errors?.[0]?.message || `HTTP ${res.status}` };
				} catch (e) {
					return { success: false, error: e.message };
				}
			})(),
			// 2. Workers AI > Edit
			(async () => {
				try {
					const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${targetAccountId}/ai/run/@cf/google/embeddinggemma-300m`, {
						method: 'POST',
						headers: {
							'Authorization': `Bearer ${targetApiToken}`,
							'Content-Type': 'application/json'
						},
						body: JSON.stringify({ text: ['test'] })
					});
					const data = await res.json();
					if (res.ok && data.success !== false) {
						return { success: true };
					}
					return { success: false, error: data.errors?.[0]?.message || `HTTP ${res.status}` };
				} catch (e) {
					return { success: false, error: e.message };
				}
			})(),
			// 3. Account Analytics > Read
			(async () => {
				try {
					const query = `
						query GetAIUsage($accountId: String!, $start: String!) {
							viewer {
								accounts(filter: { accountTag: $accountId }) {
									aiInferenceAdaptiveGroups(
										filter: { datetime_geq: $start }
										limit: 1
									) {
										count
									}
								}
							}
						}
					`;
					const todayUTC = new Date();
					todayUTC.setUTCHours(0, 0, 0, 0);
					const startToday = todayUTC.toISOString().split('.')[0] + 'Z';

					const res = await fetch(`https://api.cloudflare.com/client/v4/graphql`, {
						method: 'POST',
						headers: {
							'Authorization': `Bearer ${targetApiToken}`,
							'Content-Type': 'application/json'
						},
						body: JSON.stringify({
							query,
							variables: {
								accountId: targetAccountId,
								start: startToday
							}
						})
					});
					const data = await res.json();
					if (res.ok && !data.errors && data.data?.viewer?.accounts) {
						return { success: true };
					}
					return { success: false, error: data.errors?.[0]?.message || `HTTP ${res.status}` };
				} catch (e) {
					return { success: false, error: e.message };
				}
			})()
		]);

		const allSuccess = readResult.success && editResult.success && analyticsResult.success;
		let overallError = null;
		if (!allSuccess) {
			const failedPerms = [];
			if (!readResult.success) failedPerms.push(`Workers AI > Read (${readResult.error})`);
			if (!editResult.success) failedPerms.push(`Workers AI > Edit (${editResult.error})`);
			if (!analyticsResult.success) failedPerms.push(`Account Analytics > Read (${analyticsResult.error})`);
			overallError = failedPerms.join('; ');
		}

		return new Response(JSON.stringify({
			success: allSuccess,
			error: overallError,
			permissions: {
				workersAiRead: readResult,
				workersAiEdit: editResult,
				accountAnalyticsRead: analyticsResult
			}
		}), { headers: { 'Content-Type': 'application/json' } });
	}

	// 8. 登录后看到的详细用量统计
	if (url.pathname === '/api/accounts/usage' && method === 'GET') {
		const accounts = await getAccounts(env);
		if (accounts.length === 0) {
			return new Response(JSON.stringify([]), { headers: { 'Content-Type': 'application/json' } });
		}

		// 刷新最老数据的20个账号
		const cacheMap = await refreshAccountsUsage(env, accounts, 20);

		// 构建完整结果列表，若没有缓存数据则标为 pending
		const results = accounts.map(account => {
			const cached = cacheMap[account.id];
			return {
				id: account.id,
				name: account.name,
				accountId: account.accountId,
				status: cached ? cached.status : 'pending',
				error: cached ? cached.error : undefined,
				usageToday: cached ? cached.usageToday : 0,
				modelsToday: cached ? cached.modelsToday : [],
				history: cached ? cached.history : [],
				lastUpdated: cached ? cached.timestamp : 0
			};
		});

		return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
	}

	// 9. 代理接口用的自定义 API 密钥管理
	if (url.pathname === '/api/keys') {
		if (method === 'GET') {
			const keys = await getApiKeys(env);
			return new Response(JSON.stringify(keys), { headers: { 'Content-Type': 'application/json' } });
		}

		if (method === 'POST') {
			const { name, key, group } = await request.json();
			if (!name) {
				return new Response(JSON.stringify({ error: 'Name is required' }), { status: 400 });
			}

			// 模型分组权限：all（默认，全部）| free（仅免费）| paid（仅收费）
			const keyGroup = MODEL_GROUPS.includes(group) ? group : 'all';

			const generatedKey = key || `sk-wa-${crypto.randomUUID().replace(/-/g, '')}`;
			const keys = await getApiKeys(env);
			keys.push({
				id: crypto.randomUUID(),
				name,
				key: generatedKey,
				group: keyGroup,
				createdAt: new Date().toISOString()
			});
			await saveApiKeys(env, keys);
			return new Response(JSON.stringify({ success: true, key: generatedKey, group: keyGroup }), { headers: { 'Content-Type': 'application/json' } });
		}

		if (method === 'DELETE') {
			const { id } = await request.json();
			let keys = await getApiKeys(env);
			keys = keys.filter(k => k.id !== id);
			await saveApiKeys(env, keys);
			return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
		}
	}

	// 10. 模型设置和映射
	if (url.pathname === '/api/settings') {
		if (method === 'GET') {
			const customMap = await getCustomModelMap(env);
			const autoMap = await getAutoModelMap(env);
			return new Response(JSON.stringify({ customModelMap: customMap, autoModelMap: autoMap }), { headers: { 'Content-Type': 'application/json' } });
		}

		if (method === 'POST') {
			const { customModelMap } = await request.json();
			if (!customModelMap || typeof customModelMap !== 'object') {
				return new Response(JSON.stringify({ error: 'Invalid customModelMap payload' }), { status: 400 });
			}
			await saveCustomModelMap(env, customModelMap);
			return new Response(JSON.stringify({ success: true }), { headers: { 'Content-Type': 'application/json' } });
		}
	}

	// 11. 模型目录：从 Cloudflare 实时获取全部模型 + 免费/收费分组
	if (url.pathname === '/api/models/available') {
		// GET：返回已缓存的目录（不打 CF）
		if (method === 'GET') {
			const { catalog, updatedAt } = await getModelCatalog(env);
			return new Response(JSON.stringify({ catalog: catalog || { models: [] }, updatedAt }), { headers: { 'Content-Type': 'application/json' } });
		}

		// POST：触发从 CF 同步一次，写入缓存后返回
		if (method === 'POST') {
			const accounts = await getAccounts(env);
			const activeAccounts = accounts.filter(a => a.status !== 'error');
			if (activeAccounts.length === 0 && accounts.length === 0) {
				return new Response(JSON.stringify({ error: '请先在「账号管理」添加至少一个 Cloudflare 账号' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
			}
			// 依次尝试各账号，任意一个成功即可（模型目录与账号无关，取一份即可）
			let models = null;
			let lastError = null;
			for (const acc of (activeAccounts.length ? activeAccounts : accounts)) {
				try {
					models = await fetchCFModels(acc.accountId, acc.apiToken);
					break;
				} catch (e) {
					lastError = e.message;
				}
			}
			if (!models) {
				return new Response(JSON.stringify({ error: `同步失败：${lastError || '未知错误'}` }), { status: 502, headers: { 'Content-Type': 'application/json' } });
			}
			const freeCount = models.filter(m => !m.paid).length;
			const paidCount = models.filter(m => m.paid).length;
			const catalog = { models, freeCount, paidCount };
			const updatedAt = await saveModelCatalog(env, catalog);

			// 自动映射：为每个 CF 模型生成简洁别名，写入 autoModelMap（不覆盖用户自定义）
			const autoMap = buildAutoModelMap(models);
			await saveAutoModelMap(env, autoMap);

			return new Response(JSON.stringify({
				success: true, catalog, updatedAt,
				autoMapped: Object.keys(autoMap).length
			}), { headers: { 'Content-Type': 'application/json' } });
		}
	}

	// 12. 聊天：管理员面板内直接对话（复用代理逻辑，无需 API Key）
	if (url.pathname === '/api/chat' && method === 'POST') {
		if (!await verifyAdminCookie(request, env)) {
			return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
		}
		let body;
		try { body = await request.json(); } catch (e) {
			return new Response(JSON.stringify({ error: 'Invalid JSON body' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
		}
		const messages = body.messages;
		if (!Array.isArray(messages) || messages.length === 0) {
			return new Response(JSON.stringify({ error: 'messages is required' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
		}
		const stream = !!body.stream;
		const cfModel = await resolveModelName(body.model || 'gpt-oss-20b', env);
		const result = await callOpenAICompatibleAPI({ model: cfModel, messages, stream }, env, stream);
		if (!result.success) {
			return new Response(JSON.stringify({ error: { message: result.error } }), { status: 502, headers: { 'Content-Type': 'application/json' } });
		}
		if (stream) {
			return new Response(passthroughStream(result.stream, body.model), {
				headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
			});
		}
		return new Response(JSON.stringify(result.data), { headers: { 'Content-Type': 'application/json' } });
	}

	return new Response(JSON.stringify({ error: 'Endpoint not found' }), { status: 404 });
}

// ----------------------------------------------------
// 前端页面处理函数（按页面拆分）
// ----------------------------------------------------

// 1. 首页 / 登录页
async function handleLandingPage(request, env, ctx) {
	const isLoggedIn = await verifyAdminCookie(request, env);

	let actionCardHtml = '';
	if (isLoggedIn) {
		actionCardHtml = `
			<div class="section-card" style="text-align: center;">
				<div class="section-title" style="justify-content: center; margin-bottom: 10px;">欢迎回来</div>
				<p style="font-size: 14px; color: var(--text-muted); margin-bottom: 20px;">您当前已登录管理员身份。</p>
				<a href="/admin" class="btn btn-primary" style="width: 100%; text-decoration: none; display: flex; align-items: center; justify-content: center;">进入后台管理面板</a>
				<button class="btn btn-secondary" onclick="submitLogout()" style="width: 100%; margin-top: 12px;">安全退出</button>
			</div>
		`;
	} else {
		actionCardHtml = `
			<div class="section-card" id="login-form-card">
				<div class="section-title">后台管理员登录</div>
				<div class="form-group" style="margin-top: 15px;">
					<label for="login-password">管理员密码</label>
					<input type="password" id="login-password" placeholder="请输入管理员密码" onkeydown="if(event.key==='Enter')submitLogin()">
				</div>
				<button class="btn btn-primary" onclick="submitLogin()" style="width: 100%; margin-top: 10px;">登录</button>
			</div>
		`;
	}

	const html = `<!DOCTYPE html>
<head>
	<meta charset="UTF-8">
	<meta name="robots" content="noindex, nofollow">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>NeuronGate · Cloudflare Workers AI 网关</title>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Outfit:wght@500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
	<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
	<style>
		:root {
			--bg-color: #0b0f19;
			--card-bg: rgba(30, 41, 59, 0.45);
			--border-color: rgba(255, 255, 255, 0.08);
			--text-main: #f8fafc;
			--text-muted: #94a3b8;
			--primary-gradient: linear-gradient(135deg, #6366f1 0%, #a855f7 50%, #ec4899 100%);
			--accent-color: #a855f7;
			--input-bg: rgba(15, 23, 42, 0.6);
			--input-border: rgba(255, 255, 255, 0.1);
			--input-text: #f8fafc;
			--btn-secondary-bg: rgba(255, 255, 255, 0.06);
			--btn-secondary-hover: rgba(255, 255, 255, 0.12);
			--btn-secondary-text: #f8fafc;
			--modal-overlay-bg: rgba(8, 10, 18, 0.6);
			--glass-blur: 20px;
			--card-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
			--orb-1-color: rgba(99, 102, 241, 0.15);
			--orb-2-color: rgba(236, 72, 153, 0.12);
		}

		:root[data-theme="light"] {
			--bg-color: #f1f5f9;
			--card-bg: rgba(255, 255, 255, 0.7);
			--border-color: rgba(0, 0, 0, 0.06);
			--text-main: #0f172a;
			--text-muted: #64748b;
			--primary-gradient: linear-gradient(135deg, #4f46e5 0%, #9333ea 50%, #db2777 100%);
			--accent-color: #9333ea;
			--input-bg: rgba(241, 245, 249, 0.8);
			--input-border: rgba(0, 0, 0, 0.08);
			--input-text: #0f172a;
			--btn-secondary-bg: rgba(0, 0, 0, 0.04);
			--btn-secondary-hover: rgba(0, 0, 0, 0.08);
			--btn-secondary-text: #0f172a;
			--modal-overlay-bg: rgba(241, 245, 249, 0.5);
			--glass-blur: 20px;
			--card-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.07);
			--orb-1-color: rgba(99, 102, 241, 0.08);
			--orb-2-color: rgba(236, 72, 153, 0.06);
		}

		* {
			box-sizing: border-box;
			margin: 0;
			padding: 0;
		}

		body {
			font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
			background-color: var(--bg-color);
			color: var(--text-main);
			min-height: 100vh;
			display: flex;
			flex-direction: column;
			justify-content: center;
			align-items: center;
			padding: 20px;
			overflow-x: hidden;
			position: relative;
		}

		h1, h2, h3 {
			font-family: 'Outfit', sans-serif;
		}

		/* Utility Hidden Class */
		.hidden {
			display: none !important;
		}

		/* Dynamic Background Orbs */
		.bg-orbs-container {
			position: fixed;
			top: 0;
			left: 0;
			width: 100%;
			height: 100%;
			z-index: -1;
			overflow: hidden;
			pointer-events: none;
		}

		.bg-orb {
			position: absolute;
			border-radius: 50%;
			filter: blur(100px);
			animation: float 25s infinite alternate ease-in-out;
		}

		.bg-orb-1 {
			top: -10%;
			left: -10%;
			width: 50vw;
			height: 50vw;
			background: var(--orb-1-color);
			animation-duration: 20s;
		}

		.bg-orb-2 {
			bottom: -10%;
			right: -10%;
			width: 60vw;
			height: 60vw;
			background: var(--orb-2-color);
			animation-duration: 30s;
			animation-delay: -5s;
		}

		@keyframes float {
			0% {
				transform: translate(0, 0) scale(1);
			}
			50% {
				transform: translate(5%, 10%) scale(1.1);
			}
			100% {
				transform: translate(-5%, -5%) scale(0.9);
			}
		}

		.action-btn-group {
			position: fixed;
			top: 20px;
			right: 20px;
			display: flex;
			flex-direction: row;
			gap: 12px;
			z-index: 1000;
		}

		.floating-btn {
			background-color: var(--card-bg);
			border: 1px solid var(--border-color);
			color: var(--text-main);
			width: 44px;
			height: 44px;
			border-radius: 12px;
			display: flex;
			align-items: center;
			justify-content: center;
			cursor: pointer;
			box-shadow: var(--card-shadow);
			backdrop-filter: blur(var(--glass-blur));
			-webkit-backdrop-filter: blur(var(--glass-blur));
			transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
			z-index: 1000;
			outline: none;
		}
		
		.floating-btn:hover {
			transform: translateY(-2px);
			border-color: rgba(168, 85, 247, 0.4);
			box-shadow: 0 8px 20px rgba(168, 85, 247, 0.15);
		}

		.dashboard-container {
			max-width: 900px;
			width: 100%;
			display: flex;
			flex-direction: column;
			gap: 28px;
			z-index: 10;
		}

		.dashboard-grid {
			display: grid;
			grid-template-columns: 1fr 2fr;
			gap: 20px;
			width: 100%;
		}

		.dashboard-grid.single-col {
			grid-template-columns: 1fr;
		}

		.public-chart-wrapper {
			position: relative;
			height: 190px;
			width: 100%;
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 40px;
			overflow: hidden;
		}

		.public-chart-wrapper canvas {
			max-width: 100% !important;
		}

		@media (max-width: 768px) {
			.dashboard-grid {
				grid-template-columns: 1fr !important;
			}
			.public-chart-wrapper {
				flex-direction: column !important;
				height: auto !important;
				padding: 10px 0;
				gap: 20px !important;
			}
			.public-chart-wrapper > div:first-child {
				width: 160px !important;
				height: 160px !important;
			}
			.public-chart-wrapper > div:nth-child(2) {
				width: 100% !important;
				height: auto !important;
				align-items: center !important;
			}
			#public-chart-legend {
				width: 100%;
				display: grid !important;
				grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
				gap: 8px !important;
				max-height: none !important;
			}
		}

		@keyframes fadeInUp {
			from {
				opacity: 0;
				transform: translateY(24px);
			}
			to {
				opacity: 1;
				transform: translateY(0);
			}
		}

		.animate-fade-in-up {
			opacity: 0;
			animation: fadeInUp 0.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
		}

		.delay-1 {
			animation-delay: 0.15s;
		}

		.delay-2 {
			animation-delay: 0.3s;
		}

		@keyframes spin {
			to { transform: rotate(360deg); }
		}

		.spinner {
			display: inline-block;
			width: 16px;
			height: 16px;
			border: 2px solid rgba(168, 85, 247, 0.2);
			border-radius: 50%;
			border-top-color: var(--accent-color);
			animation: spin 1s linear infinite;
		}

		#public-chart-legend {
			scrollbar-width: none;
			-ms-overflow-style: none;
		}
		#public-chart-legend::-webkit-scrollbar {
			display: none;
		}

		.login-header {
			display: flex;
			flex-direction: row;
			align-items: center;
			justify-content: center;
			gap: 16px;
			margin-bottom: 8px;
		}

		.logo-icon {
			width: 46px;
			height: 46px;
			border-radius: 12px;
			background: var(--primary-gradient);
			display: flex;
			align-items: center;
			justify-content: center;
			font-weight: bold;
			color: white;
			font-size: 22px;
			font-family: 'Outfit', sans-serif;
			box-shadow: 0 4px 14px rgba(168, 85, 247, 0.25);
		}

		.logo-text {
			font-size: 24px;
			font-weight: 700;
			letter-spacing: -0.5px;
			background: var(--primary-gradient);
			-webkit-background-clip: text;
			-webkit-text-fill-color: transparent;
		}

		.stat-card {
			background-color: var(--card-bg);
			border: 1px solid var(--border-color);
			border-radius: 18px;
			padding: 26px;
			display: flex;
			flex-direction: column;
			gap: 14px;
			box-shadow: var(--card-shadow);
			backdrop-filter: blur(var(--glass-blur));
			-webkit-backdrop-filter: blur(var(--glass-blur));
			transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s, border-color 0.3s;
			min-width: 0;
			overflow: hidden;
		}

		.stat-card:hover {
			transform: translateY(-4px);
			border-color: rgba(168, 85, 247, 0.3);
			box-shadow: 0 12px 30px rgba(168, 85, 247, 0.1);
		}

		.stat-title {
			font-size: 14px;
			color: var(--text-muted);
			font-weight: 500;
		}

		.stat-value {
			font-size: 36px;
			font-weight: 700;
			font-family: 'Outfit', sans-serif;
		}

		.progress-container {
			width: 100%;
			height: 8px;
			background-color: rgba(255, 255, 255, 0.06);
			border-radius: 4px;
			overflow: hidden;
			position: relative;
		}

		:root[data-theme="light"] .progress-container {
			background-color: rgba(0, 0, 0, 0.05);
		}

		.progress-bar {
			height: 100%;
			background: var(--primary-gradient);
			border-radius: 4px;
			width: 0%;
			transition: width 1.2s cubic-bezier(0.34, 1.56, 0.64, 1);
			position: relative;
			overflow: hidden;
		}

		.progress-bar::after {
			content: '';
			position: absolute;
			top: 0;
			left: 0;
			right: 0;
			bottom: 0;
			background: linear-gradient(
				90deg,
				rgba(255, 255, 255, 0) 0%,
				rgba(255, 255, 255, 0.2) 50%,
				rgba(255, 255, 255, 0) 100%
			);
			animation: progress-shimmer 2s infinite linear;
			background-size: 200% 100%;
		}

		@keyframes progress-shimmer {
			0% { background-position: -200% 0; }
			100% { background-position: 200% 0; }
		}

		.section-card {
			background-color: var(--card-bg);
			border: 1px solid var(--border-color);
			border-radius: 18px;
			padding: 28px;
			box-shadow: var(--card-shadow);
			backdrop-filter: blur(var(--glass-blur));
			-webkit-backdrop-filter: blur(var(--glass-blur));
			display: flex;
			flex-direction: column;
			gap: 20px;
		}

		.section-title {
			font-size: 18px;
			font-weight: 600;
			display: flex;
			align-items: center;
			gap: 8px;
		}

		.form-group {
			display: flex;
			flex-direction: column;
			gap: 8px;
		}

		.form-group label {
			font-size: 13px;
			font-weight: 500;
			color: var(--text-muted);
		}

		input {
			background-color: var(--input-bg);
			border: 1px solid var(--input-border);
			color: var(--input-text);
			padding: 12px 16px;
			border-radius: 10px;
			outline: none;
			font-size: 14px;
			transition: all 0.3s ease;
			backdrop-filter: blur(10px);
		}

		input:focus {
			border-color: var(--accent-color);
			box-shadow: 0 0 0 3px rgba(168, 85, 247, 0.2);
			background-color: rgba(15, 23, 42, 0.8);
		}

		:root[data-theme="light"] input:focus {
			background-color: rgba(255, 255, 255, 0.95);
		}

		.btn {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			padding: 12px 20px;
			border-radius: 10px;
			font-weight: 600;
			font-size: 14px;
			cursor: pointer;
			border: none;
			transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
			text-decoration: none;
		}

		.btn-primary {
			background: var(--primary-gradient);
			color: white;
			box-shadow: 0 4px 14px rgba(168, 85, 247, 0.3);
		}

		.btn-primary:hover {
			transform: translateY(-2px);
			box-shadow: 0 6px 20px rgba(168, 85, 247, 0.5);
			opacity: 0.95;
		}

		.btn-primary:active {
			transform: translateY(0);
		}

		.btn-secondary {
			background-color: var(--btn-secondary-bg);
			color: var(--btn-secondary-text);
			border: 1px solid var(--border-color);
		}

		.btn-secondary:hover {
			background-color: var(--btn-secondary-hover);
			transform: translateY(-1px);
		}

		/* Modal Styling */
		.modal-overlay {
			position: fixed;
			top: 0;
			left: 0;
			right: 0;
			bottom: 0;
			background-color: var(--modal-overlay-bg);
			backdrop-filter: blur(0px);
			-webkit-backdrop-filter: blur(0px);
			display: flex;
			align-items: center;
			justify-content: center;
			z-index: 1000;
			opacity: 0;
			pointer-events: none;
			transition: opacity 0.3s ease, backdrop-filter 0.3s ease, -webkit-backdrop-filter 0.3s ease;
		}

		.modal-overlay.active {
			opacity: 1;
			pointer-events: auto;
			backdrop-filter: blur(8px);
			-webkit-backdrop-filter: blur(8px);
		}

		.modal-card {
			background-color: var(--card-bg);
			border: 1px solid var(--border-color);
			border-radius: 20px;
			width: 100%;
			max-width: 400px;
			padding: 32px;
			box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
			display: flex;
			flex-direction: column;
			gap: 20px;
			transform: scale(0.9) translateY(20px);
			transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), background-color 0.3s;
			backdrop-filter: blur(var(--glass-blur));
			-webkit-backdrop-filter: blur(var(--glass-blur));
		}

		.modal-overlay.active .modal-card {
			transform: scale(1) translateY(0);
		}

		.modal-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			border-bottom: 1px solid var(--border-color);
			padding-bottom: 16px;
		}

		.modal-header h3 {
			font-size: 18px;
			font-weight: 600;
		}

		.close-btn {
			background: none;
			border: none;
			color: var(--text-muted);
			cursor: pointer;
			padding: 4px;
			display: flex;
			align-items: center;
			justify-content: center;
			outline: none;
			transition: color 0.2s;
		}

		.close-btn:hover {
			color: var(--text-main);
		}

		/* Toast Notification */
		.toast-container {
			position: fixed;
			top: 24px;
			right: 24px;
			display: flex;
			flex-direction: column;
			gap: 10px;
			z-index: 9999;
			pointer-events: none;
		}

		.toast {
			min-width: 260px;
			padding: 14px 20px;
			border-radius: 12px;
			box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
			font-size: 14px;
			font-weight: 600;
			display: flex;
			align-items: center;
			gap: 12px;
			backdrop-filter: blur(15px);
			-webkit-backdrop-filter: blur(15px);
			transform: translateY(-20px);
			opacity: 0;
			transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
			pointer-events: auto;
		}

		.toast.show {
			transform: translateY(0);
			opacity: 1;
		}

		.toast-icon {
			width: 20px;
			height: 20px;
			flex-shrink: 0;
		}

		.toast-success {
			background-color: #10b981 !important;
			color: #ffffff !important;
			border: none !important;
		}
		.toast-success .toast-icon, .toast-success span {
			color: #ffffff !important;
		}

		.toast-error {
			background-color: #ef4444 !important;
			color: #ffffff !important;
			border: none !important;
		}
		.toast-error .toast-icon, .toast-error span {
			color: #ffffff !important;
		}
		
		.toast-warning {
			background-color: #f59e0b !important;
			color: #ffffff !important;
			border: none !important;
		}
		.toast-warning .toast-icon, .toast-warning span {
			color: #ffffff !important;
		}
${NEURON_THEME}
	</style>
</head>
<body>

	<!-- Dynamic Background Orbs -->
	<div class="bg-orbs-container">
		<div class="bg-orb bg-orb-1"></div>
		<div class="bg-orb bg-orb-2"></div>
	</div>

	<!-- Floating Action Buttons -->
	<div class="action-btn-group">
		<button class="floating-btn" onclick="toggleTheme()" title="切换日间/夜间模式">
			<svg class="theme-icon-sun" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none; width: 20px; height: 20px;">
				<circle cx="12" cy="12" r="4" />
				<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
			</svg>
			<svg class="theme-icon-moon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 20px; height: 20px;">
				<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
			</svg>
		</button>
		<button class="floating-btn" onclick="openLoginModal()" title="${isLoggedIn ? '管理后台' : '管理员登录'}" style="background: var(--primary-gradient); color: white; border: none;">
			${isLoggedIn ? `
				<!-- User Check Icon -->
				<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 20px; height: 20px;">
					<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
					<circle cx="9" cy="7" r="4" />
					<polyline points="16 11 18 13 22 9" />
				</svg>
			` : `
				<!-- User Icon -->
				<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 20px; height: 20px;">
					<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
					<circle cx="12" cy="7" r="4" />
				</svg>
			`}
		</button>
	</div>

	<div class="dashboard-container">
		<div class="login-header animate-fade-in-up" style="margin-bottom: 8px;">
			<div class="logo-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v13"/><path d="M12 10.5V9"/><circle cx="12" cy="13.5" r="2.5"/></svg></div>
			<span class="logo-text">NeuronGate</span>
		</div>

		<div class="dashboard-grid">
			<!-- Public stats widget -->
			<div class="stat-card animate-fade-in-up delay-1" style="justify-content: space-between;">
				<div>
					<div class="stat-title" style="margin-bottom: 10px;">今日用量汇总</div>
					<div style="display: flex; align-items: baseline; gap: 4px;">
						<div class="stat-value" id="public-neurons" style="font-size: 42px; background: var(--primary-gradient); -webkit-background-clip: text; -webkit-text-fill-color: transparent; font-weight: 800; display: inline-block;">0</div>
						<span style="font-size: 14px; color: var(--text-muted); font-weight: 500; font-family: 'Outfit', sans-serif;">Neurons</span>
					</div>
				</div>
				
				<div style="margin-top: 16px;">
					<div class="progress-container">
						<div class="progress-bar" id="public-progress" style="width: 0%;"></div>
					</div>
					<div style="display: flex; justify-content: space-between; font-size: 12px; color: var(--text-muted); margin-top: 8px;">
						<span id="public-limit-desc">总限额: 0 Neurons</span>
						<span id="public-percent-desc" style="font-weight: 600; color: var(--accent-color);">0.00%</span>
					</div>
				</div>
			</div>
			<!-- Public model chart widget -->
			<div class="stat-card animate-fade-in-up delay-2" id="public-models-card" style="padding: 24px; display: flex; flex-direction: column; justify-content: center;">
				<!-- Chart and custom legend container -->
				<div class="public-chart-wrapper" id="public-chart-wrapper" style="display: none; height: 190px; width: 100%; flex-direction: row; align-items: center; justify-content: space-between; gap: 40px;">
					<!-- Left column: Chart (takes full height of wrapper, i.e., 190px) -->
					<div style="position: relative; height: 190px; width: 190px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;">
						<canvas id="publicModelsChart"></canvas>
					</div>
					<!-- Right column: Legend list -->
					<div style="flex: 1; display: flex; flex-direction: column; justify-content: center; min-width: 0; align-self: stretch; height: 190px;">
						<div id="public-chart-legend" style="flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; max-height: 180px; overflow-y: auto; padding-right: 4px;"></div>
					</div>
				</div>
				
				<!-- Loading / Empty Placeholder -->
				<div id="public-chart-placeholder" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 190px; width: 100%; color: var(--text-muted); font-size: 13px; gap: 12px;">
					<span class="spinner" style="width: 24px; height: 24px; border-width: 2.5px;"></span>
					<span>正在载入数据...</span>
				</div>
			</div>
		</div>
	</div>

	<!-- 弹窗：管理员登录 / 后台快捷入口 -->
	<div class="modal-overlay" id="login-modal">
		<div class="modal-card">
			<div class="modal-header">
				<h3 id="modal-title">${isLoggedIn ? '管理面板入口' : '管理员登录'}</h3>
				<button onclick="closeLoginModal()" class="close-btn">
					<svg style="width: 20px; height: 20px;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path>
					</svg>
				</button>
			</div>
			
			${isLoggedIn ? `
				<div style="text-align: center; display: flex; flex-direction: column; gap: 16px; margin-top: 10px;">
					<div style="font-size: 40px; margin-bottom: 8px;">🎉</div>
					<p style="font-size: 14px; color: var(--text-muted); line-height: 1.5;">您当前已登录管理员身份。</p>
					<a href="/admin" class="btn btn-primary" style="width: 100%; text-decoration: none; display: flex; align-items: center; justify-content: center; height: 42px;">进入后台管理面板</a>
					<button class="btn btn-secondary" onclick="submitLogout()" style="width: 100%; height: 42px;">安全退出</button>
				</div>
			` : `
				<div class="form-group" style="margin-top: 10px;">
					<label for="login-password">管理员密码</label>
					<input type="password" id="login-password" placeholder="请输入管理员密码" onkeydown="if(event.key==='Enter')submitLogin()">
				</div>
				<div class="modal-footer" style="margin-top: 10px; display: flex; gap: 12px; justify-content: flex-end; width: 100%;">
					<button class="btn btn-secondary" onclick="closeLoginModal()" style="height: 38px;">取消</button>
					<button class="btn btn-primary" onclick="submitLogin()" style="height: 38px;">登录</button>
				</div>
			`}
		</div>
	</div>

	<script>
		// Toast Helper
		function showToast(message, type = 'success') {
			let container = document.querySelector('.toast-container');
			if (!container) {
				container = document.createElement('div');
				container.className = 'toast-container';
				document.body.appendChild(container);
			}

			const toast = document.createElement('div');
			toast.className = \`toast toast-\${type}\`;
			
			let iconSvg = '';
			if (type === 'success') {
				iconSvg = \`<svg class="toast-icon" style="color: #ffffff;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>\`;
			} else if (type === 'error') {
				iconSvg = \`<svg class="toast-icon" style="color: #ffffff;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>\`;
			} else {
				iconSvg = \`<svg class="toast-icon" style="color: #ffffff;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>\`;
			}

			toast.innerHTML = \`\${iconSvg}<span>\${message}</span>\`;
			container.appendChild(toast);

			toast.offsetHeight; // trigger reflow
			toast.classList.add('show');

			setTimeout(() => {
				toast.classList.remove('show');
				setTimeout(() => toast.remove(), 400);
			}, 3000);
		}

		function initTheme() {
			const savedTheme = localStorage.getItem('theme');
			if (savedTheme) {
				document.documentElement.setAttribute('data-theme', savedTheme);
			} else {
				const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
				const defaultTheme = systemPrefersDark ? 'dark' : 'light';
				document.documentElement.setAttribute('data-theme', defaultTheme);
			}
			updateThemeIcons();
		}

		let publicModelsChartInstance = null;
		let lastPublicSummaryData = null;

		function toggleTheme() {
			const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
			const newTheme = currentTheme === 'light' ? 'dark' : 'light';
			document.documentElement.setAttribute('data-theme', newTheme);
			localStorage.setItem('theme', newTheme);
			updateThemeIcons();
			if (lastPublicSummaryData) {
				renderPublicSummary(lastPublicSummaryData);
			}
		}

		function updateThemeIcons() {
			const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
			const sunIcons = document.querySelectorAll('.theme-icon-sun');
			const moonIcons = document.querySelectorAll('.theme-icon-moon');
			if (currentTheme === 'light') {
				sunIcons.forEach(el => el.style.display = 'none');
				moonIcons.forEach(el => el.style.display = 'block');
			} else {
				sunIcons.forEach(el => el.style.display = 'block');
				moonIcons.forEach(el => el.style.display = 'none');
			}
		}

		function openLoginModal() {
			document.getElementById('login-modal').classList.add('active');
			const pwdInput = document.getElementById('login-password');
			if (pwdInput) {
				pwdInput.value = '';
				setTimeout(() => pwdInput.focus(), 100);
			}
		}

		function closeLoginModal() {
			document.getElementById('login-modal').classList.remove('active');
		}

		initTheme();

		window.onload = function() {
			loadPublicSummary();
		};

		async function loadPublicSummary() {
			try {
				const res = await fetch('/api/usage/summary');
				const data = await res.json();
				
				renderPublicSummary(data);

				// 如果后端认为需要更新，则继续发送 POST 请求触发静默更新并获取最新数据
				if (data.needUpdate) {
					const updateRes = await fetch('/api/usage/summary', { method: 'POST' });
					if (updateRes.ok) {
						const freshData = await updateRes.json();
						renderPublicSummary(freshData);
					}
				}
			} catch (e) {
				console.error(e);
			}
		}

		function animateNumber(id, end, duration = 1200) {
			const obj = document.getElementById(id);
			if (!obj) return;
			let start = parseInt(obj.innerText.replace(/,/g, ''), 10);
			if (isNaN(start) || start <= 0) {
				start = end > 100 ? 100 : 0;
			}
			const range = end - start;
			if (range === 0) {
				obj.innerText = end.toLocaleString();
				return;
			}
			const startTime = performance.now();
			function update(currentTime) {
				const elapsed = currentTime - startTime;
				const progress = Math.min(elapsed / duration, 1);
				const easeProgress = 1 - Math.pow(2, -10 * progress);
				const current = Math.ceil(start + range * easeProgress);
				obj.innerText = current.toLocaleString();
				if (progress < 1) {
					requestAnimationFrame(update);
				} else {
					obj.innerText = end.toLocaleString();
				}
			}
			requestAnimationFrame(update);
		}

		function renderPublicSummary(data) {
			lastPublicSummaryData = data;
			const percent = Number(data.usagePercentage).toFixed(2);
			const roundedNeurons = Math.ceil(data.totalNeuronsToday);
			
			// 触发数字滚动的动效
			animateNumber('public-neurons', roundedNeurons, 1000);
			
			document.getElementById('public-progress').style.width = percent + '%';
			document.getElementById('public-limit-desc').innerText = '总限额: ' + Number(data.totalLimit).toLocaleString() + ' Neurons';
			document.getElementById('public-percent-desc').innerText = percent + '%';

			const wrapper = document.getElementById('public-chart-wrapper');
			const placeholder = document.getElementById('public-chart-placeholder');
			const legendContainer = document.getElementById('public-chart-legend');

			if (data.modelsToday && data.modelsToday.length > 0) {
				if (wrapper) wrapper.style.display = 'flex';
				if (placeholder) placeholder.style.display = 'none';

				// 按 Neurons 消耗数从大到小排序
				const sortedModelsToday = [...data.modelsToday].sort((a, b) => b.neurons - a.neurons);

				const labels = sortedModelsToday.map(m => m.model.split('/').pop());
				const chartData = sortedModelsToday.map(m => m.neurons);
				
				const isLight = document.documentElement.getAttribute('data-theme') === 'light';
				const textColor = isLight ? '#64748b' : '#94a3b8';
				const borderColor = isLight ? '#ffffff' : '#1e293b';
				
				const ctx = document.getElementById('publicModelsChart').getContext('2d');
				if (publicModelsChartInstance) {
					publicModelsChartInstance.destroy();
				}
				
				// 清空旧的 HTML Legend 标签
				if (legendContainer) legendContainer.innerHTML = '';

				publicModelsChartInstance = new Chart(ctx, {
					type: 'doughnut',
					data: {
						labels: labels,
						datasets: [{
							data: chartData,
							backgroundColor: ['#FF8A3D', '#38BDF8', '#34D399', '#FBBF24', '#A78BFA', '#FB7185'],
							borderWidth: 2,
							borderColor: borderColor
						}]
					},
					options: {
						responsive: true,
						maintainAspectRatio: false,
						cutout: '70%',
						animation: {
							animateRotate: true,
							animateScale: true,
							duration: 1000,
							easing: 'easeOutQuart'
						},
						plugins: {
							legend: {
								display: false // 关闭原生图例，使用 HTML 图例
							}
						}
					}
				});

				// 动态且逐个淡入渲染模型说明 ID
				if (legendContainer) {
					const colors = ['#FF8A3D', '#38BDF8', '#34D399', '#FBBF24', '#A78BFA', '#FB7185'];
					const total = chartData.reduce((a, b) => a + b, 0);
					
					labels.forEach((label, index) => {
						const val = chartData[index];
						const color = colors[index % colors.length];
						const pct = total > 0 ? ((val / total) * 100).toFixed(1) : '0.0';
						
						const item = document.createElement('div');
						item.style.display = 'flex';
						item.style.alignItems = 'center';
						item.style.gap = '8px';
						item.style.fontSize = '12px';
						item.style.color = textColor;
						item.style.opacity = '0';
						item.style.transform = 'translateX(10px)';
						item.style.transition = 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)';
						
						item.innerHTML = '<span style="width: 8px; height: 8px; border-radius: 50%; background-color: ' + color + '; flex-shrink: 0; margin-right: 2px;"></span>' +
							'<span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; font-weight: 500;" title="' + label + '">' + label + '</span>' +
							'<span style="color: var(--text-muted); font-family: monospace; font-size: 11px; flex-shrink: 0; margin-left: 4px;">' + pct + '%</span>';
						
						legendContainer.appendChild(item);
						
						// 与环形图同时开始加载，依次淡入滑出
						setTimeout(() => {
							item.style.opacity = '1';
							item.style.transform = 'translateX(0)';
						}, index * 80);
					});
				}
			} else {
				if (wrapper) wrapper.style.display = 'none';
				if (placeholder) {
					placeholder.style.display = 'flex';
					placeholder.innerHTML = '<svg style="width: 32px; height: 32px; opacity: 0.5;" fill="none" stroke="currentColor" viewBox="0 0 24 24">' +
						'<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z"></path>' +
						'<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z"></path>' +
						'</svg><span>今日暂无消耗数据</span>';
				}
				if (publicModelsChartInstance) {
					publicModelsChartInstance.destroy();
					publicModelsChartInstance = null;
				}
			}
		}

		async function submitLogin() {
			const password = document.getElementById('login-password').value;
			const res = await fetch('/api/auth/login', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ password })
			});
			if (res.ok) {
				showToast('登录成功！跳转中...');
				setTimeout(() => {
					window.location.href = '/admin';
				}, 600);
			} else {
				const data = await res.json();
				showToast('登录失败: ' + (data.error || '密码不正确！'), 'error');
			}
		}

		async function submitLogout() {
			const res = await fetch('/api/auth/logout', { method: 'POST' });
			if (res.ok) {
				showToast('安全退出成功');
				setTimeout(() => {
					window.location.reload();
				}, 600);
			}
		}
	</script>
	<footer style="text-align: center; padding: 24px 0 20px; font-size: 12px; color: var(--text-muted); opacity: 0.6; z-index: 10;">
			<a href="https://github.com/salem-2007/NeuronGate" target="_blank" rel="noopener" style="color: inherit; text-decoration: underline; text-underline-offset: 2px;">NeuronGate</a>
	</footer>
</body>
</html>`;

	return new Response(html, {
		headers: { 'Content-Type': 'text/html; charset=utf-8' }
	});
}

// 2. 后台管理控制台页面
function handleAdminPage(request, env, ctx) {
	const html = `<!DOCTYPE html>
<head>
	<meta charset="UTF-8">
	<meta name="robots" content="noindex, nofollow">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>NeuronGate 控制台</title>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600&family=Outfit:wght@400;500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
	<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
	<style>
		:root {
			--bg-color: #0b0f19;
			--sidebar-bg: rgba(15, 23, 42, 0.6);
			--card-bg: rgba(30, 41, 59, 0.45);
			--border-color: rgba(255, 255, 255, 0.08);
			--text-main: #f8fafc;
			--text-muted: #94a3b8;
			--primary-gradient: linear-gradient(135deg, #6366f1 0%, #a855f7 50%, #ec4899 100%);
			--accent-color: #a855f7;
			--success-color: #10b981;
			--warning-color: #f59e0b;
			--danger-color: #ef4444;
			--sidebar-width: 260px;
			--sidebar-menu-hover: rgba(255, 255, 255, 0.04);
			--input-bg: rgba(15, 23, 42, 0.6);
			--input-border: rgba(255, 255, 255, 0.1);
			--input-text: #f8fafc;
			--table-header-bg: rgba(0, 0, 0, 0.2);
			--btn-secondary-bg: rgba(255, 255, 255, 0.06);
			--btn-secondary-hover: rgba(255, 255, 255, 0.12);
			--btn-secondary-text: #f8fafc;
			--modal-overlay-bg: rgba(8, 10, 18, 0.6);
			--section-item-bg: rgba(255, 255, 255, 0.02);
			--glass-blur: 20px;
			--card-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
			--orb-1-color: rgba(99, 102, 241, 0.12);
			--orb-2-color: rgba(236, 72, 153, 0.08);
			
			/* Theme aware code tag tokens */
			--code-bg: rgba(0, 0, 0, 0.25);
			--code-color: #e9d5ff;
			--code-border: rgba(255, 255, 255, 0.04);
		}

		:root[data-theme="light"] {
			--bg-color: #f1f5f9;
			--sidebar-bg: rgba(255, 255, 255, 0.6);
			--card-bg: rgba(255, 255, 255, 0.7);
			--border-color: rgba(0, 0, 0, 0.06);
			--text-main: #0f172a;
			--text-muted: #64748b;
			--primary-gradient: linear-gradient(135deg, #4f46e5 0%, #9333ea 50%, #db2777 100%);
			--accent-color: #9333ea;
			--success-color: #10b981;
			--warning-color: #f59e0b;
			--danger-color: #ef4444;
			--sidebar-menu-hover: rgba(0, 0, 0, 0.04);
			--input-bg: rgba(241, 245, 249, 0.8);
			--input-border: rgba(0, 0, 0, 0.08);
			--input-text: #0f172a;
			--table-header-bg: rgba(0, 0, 0, 0.03);
			--btn-secondary-bg: rgba(0, 0, 0, 0.04);
			--btn-secondary-hover: rgba(0, 0, 0, 0.08);
			--btn-secondary-text: #0f172a;
			--modal-overlay-bg: rgba(241, 245, 249, 0.5);
			--section-item-bg: rgba(0, 0, 0, 0.01);
			--glass-blur: 20px;
			--card-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.07);
			--orb-1-color: rgba(99, 102, 241, 0.06);
			--orb-2-color: rgba(236, 72, 153, 0.04);
			
			/* Theme aware code tag tokens */
			--code-bg: rgba(79, 70, 229, 0.07);
			--code-color: #4f46e5;
			--code-border: rgba(79, 70, 229, 0.15);
		}

		* {
			box-sizing: border-box;
			margin: 0;
			padding: 0;
		}

		body {
			font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
			background-color: var(--bg-color);
			color: var(--text-main);
			min-height: 100vh;
			display: flex;
			flex-direction: column;
			overflow-x: hidden;
			position: relative;
		}

		/* Utility Hidden Class */
		.hidden {
			display: none !important;
		}

		/* Tab Content Transition — Cyberpunk Terminal Reveal */
		.tab-content {
			display: none;
			position: relative;
		}
		.tab-content.active {
			display: block;
			animation: cyberReveal 0.55s cubic-bezier(0.22, 1, 0.36, 1) both;
		}
		/* Scanline sweep overlay */
		.tab-content.active::before {
			content: '';
			position: absolute;
			top: 0;
			left: 0;
			right: 0;
			height: 2px;
			background: linear-gradient(90deg,
				transparent 0%,
				rgba(168, 85, 247, 0.1) 15%,
				rgba(168, 85, 247, 0.65) 40%,
				rgba(236, 72, 153, 0.85) 50%,
				rgba(168, 85, 247, 0.65) 60%,
				rgba(168, 85, 247, 0.1) 85%,
				transparent 100%
			);
			z-index: 100;
			pointer-events: none;
			animation: scanlineDrop 0.45s cubic-bezier(0.16, 1, 0.3, 1) forwards;
			box-shadow:
				0 0 15px rgba(168, 85, 247, 0.45),
				0 0 40px rgba(99, 102, 241, 0.2);
		}
		@keyframes scanlineDrop {
			0%   { top: 0; opacity: 0; }
			8%   { opacity: 1; }
			92%  { opacity: 1; }
			100% { top: 100%; opacity: 0; }
		}
		@keyframes cyberReveal {
			0% {
				opacity: 0;
				transform: translateY(10px) scale(0.97);
				filter: brightness(2.5) blur(1px);
			}
			18% {
				opacity: 0.35;
				filter: brightness(1.5) blur(0.3px);
			}
			35% {
				opacity: 0.7;
				transform: translateY(3px) scale(0.99);
				filter: brightness(1.15) blur(0);
			}
			60% {
				opacity: 0.9;
				transform: translateY(1px) scale(1);
				filter: brightness(1.03);
			}
			100% {
				opacity: 1;
				transform: translateY(0) scale(1);
				filter: brightness(1);
			}
		}

		/* Nav item — flowing gradient border + neon glow */
		.nav-item::after {
			content: '';
			position: absolute;
			left: 0;
			right: 0;
			bottom: 0;
			height: 2px;
			background: linear-gradient(90deg,
				#6366f1,
				#a855f7 20%,
				#ec4899 50%,
				#a855f7 80%,
				#6366f1
			);
			background-size: 200% 100%;
			transform: scaleX(0);
			transform-origin: center;
			transition: transform 0.4s cubic-bezier(0.22, 1, 0.36, 1);
		}
		.nav-item.active::after {
			transform: scaleX(1);
			animation: borderFlow 3s linear infinite;
		}
		@keyframes borderFlow {
			0%   { background-position: 200% 0; }
			100% { background-position: 0% 0; }
		}
		:root[data-theme="light"] .nav-item::after {
			background: linear-gradient(90deg,
				#4f46e5,
				#7c3aed 20%,
				#db2777 50%,
				#7c3aed 80%,
				#4f46e5
			);
			background-size: 200% 100%;
		}

		/* Dynamic Background Orbs */
		.bg-orbs-container {
			position: fixed;
			top: 0;
			left: 0;
			width: 100%;
			height: 100%;
			z-index: -1;
			overflow: hidden;
			pointer-events: none;
		}

		.bg-orb {
			position: absolute;
			border-radius: 50%;
			filter: blur(100px);
			animation: float 25s infinite alternate ease-in-out;
		}

		.bg-orb-1 {
			top: -10%;
			left: -10%;
			width: 50vw;
			height: 50vw;
			background: var(--orb-1-color);
			animation-duration: 20s;
		}

		.bg-orb-2 {
			bottom: -10%;
			right: -10%;
			width: 60vw;
			height: 60vw;
			background: var(--orb-2-color);
			animation-duration: 30s;
			animation-delay: -5s;
		}

		@keyframes float {
			0% { transform: translate(0, 0) scale(1); }
			100% { transform: translate(5%, 5%) scale(1.05); }
		}

		/* Sidebar Layout */
		.app-container {
			display: flex;
			min-height: 100vh;
			position: relative;
		}

		aside {
			width: var(--sidebar-width);
			background-color: var(--sidebar-bg);
			border-right: 1px solid var(--border-color);
			display: flex;
			flex-direction: column;
			padding: 30px 20px;
			position: fixed;
			top: 0;
			bottom: 0;
			left: 0;
			z-index: 100;
			backdrop-filter: blur(var(--glass-blur));
			-webkit-backdrop-filter: blur(var(--glass-blur));
			transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
		}

		.logo-area {
			display: flex;
			align-items: center;
			gap: 12px;
			margin-bottom: 40px;
			padding-left: 8px;
		}

		.logo-icon {
			width: 38px;
			height: 38px;
			border-radius: 10px;
			background: var(--primary-gradient);
			display: flex;
			align-items: center;
			justify-content: center;
			font-weight: bold;
			color: white;
			font-size: 18px;
			font-family: 'Outfit', sans-serif;
			box-shadow: 0 4px 12px rgba(99, 102, 241, 0.2);
		}

		.logo-text {
			font-size: 18px;
			font-weight: 700;
			font-family: 'Outfit', sans-serif;
			letter-spacing: -0.5px;
			background: var(--primary-gradient);
			-webkit-background-clip: text;
			-webkit-text-fill-color: transparent;
		}

		.nav-menu {
			display: flex;
			flex-direction: column;
			gap: 8px;
			flex: 1;
		}

		.nav-item {
			display: flex;
			align-items: center;
			gap: 12px;
			padding: 12px 16px;
			border-radius: 10px;
			cursor: pointer;
			font-size: 14px;
			font-weight: 500;
			color: var(--text-muted);
			transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
			position: relative;
			overflow: hidden;
		}

		.nav-item:hover {
			color: var(--text-main);
			background-color: var(--sidebar-menu-hover);
			transform: translateX(4px);
		}

		.nav-item.active {
			color: white;
			background: var(--primary-gradient);
			box-shadow:
				0 0 18px rgba(168, 85, 247, 0.35),
				0 0 40px rgba(99, 102, 241, 0.15),
				inset 0 1px 0 rgba(255, 255, 255, 0.1);
		}

		.aside-footer {
			display: flex;
			flex-direction: column;
			gap: 12px;
			border-top: 1px solid var(--border-color);
			padding-top: 20px;
		}

		/* Main Content Area */
		main {
			flex: 1;
			margin-left: var(--sidebar-width);
			padding: 40px;
			min-width: 0;
			z-index: 10;
		}

		header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 30px;
		}

		/* Card Grid & Stats */
		.card-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
			gap: 20px;
		}

		.stat-card {
			background-color: var(--card-bg);
			border: 1px solid var(--border-color);
			border-radius: 18px;
			padding: 26px;
			display: flex;
			flex-direction: column;
			gap: 14px;
			box-shadow: var(--card-shadow);
			backdrop-filter: blur(var(--glass-blur));
			-webkit-backdrop-filter: blur(var(--glass-blur));
			transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s, border-color 0.3s;
		}

		.stat-card:hover {
			transform: translateY(-4px);
			border-color: rgba(168, 85, 247, 0.3);
			box-shadow: 0 12px 30px rgba(168, 85, 247, 0.1);
		}

		.stat-title {
			font-size: 14px;
			color: var(--text-muted);
			font-weight: 500;
		}

		.stat-value {
			font-size: 32px;
			font-weight: 700;
			font-family: 'Outfit', sans-serif;
		}

		.stat-desc {
			font-size: 12px;
			color: var(--text-muted);
		}

		.progress-container {
			width: 100%;
			height: 6px;
			background-color: rgba(255, 255, 255, 0.06);
			border-radius: 3px;
			overflow: hidden;
		}

		:root[data-theme="light"] .progress-container {
			background-color: rgba(0, 0, 0, 0.05);
		}

		.progress-bar {
			height: 100%;
			background: var(--primary-gradient);
			width: 0%;
			transition: width 1.2s cubic-bezier(0.34, 1.56, 0.64, 1);
		}

		/* Section Cards */
		.section-card {
			background-color: var(--card-bg);
			border: 1px solid var(--border-color);
			border-radius: 18px;
			padding: 30px;
			box-shadow: var(--card-shadow);
			backdrop-filter: blur(var(--glass-blur));
			-webkit-backdrop-filter: blur(var(--glass-blur));
			margin-bottom: 24px;
		}

		.section-note {
			margin-top: 6px;
			font-size: 13px;
			color: var(--text-muted);
			line-height: 1.5;
		}

		.access-endpoint-grid {
			display: grid;
			grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
			gap: 14px;
		}

		.access-endpoint-card {
			appearance: none;
			width: 100%;
			text-align: left;
			border: 1px solid var(--border-color);
			border-radius: 16px;
			padding: 18px 20px;
			background: linear-gradient(180deg, rgba(255, 255, 255, 0.04), rgba(255, 255, 255, 0.015));
			box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
			backdrop-filter: blur(14px);
			-webkit-backdrop-filter: blur(14px);
			transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), border-color 0.25s, box-shadow 0.25s, background 0.25s;
			cursor: default;
			color: inherit;
		}

		.access-endpoint-card:hover {
			transform: translateY(-2px);
			border-color: rgba(168, 85, 247, 0.28);
			box-shadow: 0 12px 30px rgba(168, 85, 247, 0.08);
		}

		.endpoint-badge {
			display: inline-flex;
			align-items: center;
			padding: 4px 10px;
			border-radius: 999px;
			background: rgba(168, 85, 247, 0.12);
			color: var(--accent-color);
			font-size: 12px;
			font-weight: 600;
			letter-spacing: 0.01em;
		}

		.endpoint-url {
			display: block;
			margin-top: 12px;
			font-size: 14px;
			line-height: 1.55;
			word-break: break-all;
			color: var(--text-main);
			text-decoration: underline;
			text-decoration-color: rgba(168, 85, 247, 0.5);
			text-underline-offset: 3px;
			cursor: pointer;
			background: transparent;
			border: none;
			padding: 0;
		}

		.endpoint-url:hover {
			color: var(--accent-color);
		}

		.endpoint-hint {
			margin-top: 10px;
			font-size: 12px;
			color: var(--text-muted);
		}

		.section-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			margin-bottom: 20px;
		}

		.section-title {
			font-size: 18px;
			font-weight: 600;
			font-family: 'Outfit', sans-serif;
			display: flex;
			align-items: center;
			gap: 8px;
		}

		/* Forms & Inputs */
		.form-group {
			display: flex;
			flex-direction: column;
			gap: 8px;
			margin-bottom: 16px;
		}

		.form-group label {
			font-size: 13px;
			font-weight: 500;
			color: var(--text-muted);
		}

		input {
			background-color: var(--input-bg);
			border: 1px solid var(--input-border);
			color: var(--input-text);
			padding: 12px 16px;
			border-radius: 10px;
			outline: none;
			font-size: 14px;
			transition: all 0.3s ease;
			backdrop-filter: blur(10px);
		}

		input:focus {
			border-color: var(--accent-color);
			box-shadow: 0 0 0 3px rgba(168, 85, 247, 0.2);
			background-color: rgba(15, 23, 42, 0.8);
		}

		:root[data-theme="light"] input:focus {
			background-color: rgba(255, 255, 255, 0.95);
		}

		/* Buttons */
		.btn {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			padding: 10px 18px;
			border-radius: 10px;
			font-weight: 600;
			font-size: 14px;
			cursor: pointer;
			border: none;
			transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
			gap: 8px;
		}

		.btn-primary {
			background: var(--primary-gradient);
			color: white;
			box-shadow: 0 4px 14px rgba(168, 85, 247, 0.3);
		}

		.btn-primary:hover {
			transform: translateY(-2px);
			box-shadow: 0 6px 20px rgba(168, 85, 247, 0.5);
			opacity: 0.95;
		}

		.btn-secondary {
			background-color: var(--btn-secondary-bg);
			color: var(--btn-secondary-text);
			border: 1px solid var(--border-color);
		}

		.btn-secondary:hover {
			background-color: var(--btn-secondary-hover);
			transform: translateY(-1px);
		}

		.btn-success {
			background-color: var(--success-color);
			color: white;
			box-shadow: 0 4px 14px rgba(16, 185, 129, 0.3);
		}

		.btn-success:hover {
			background-color: #059669;
			transform: translateY(-2px);
			box-shadow: 0 6px 20px rgba(16, 185, 129, 0.5);
			opacity: 0.95;
		}

		.btn:disabled {
			opacity: 0.6;
			cursor: not-allowed;
			transform: none !important;
			box-shadow: none !important;
		}

		@keyframes spinner-border {
			to { transform: rotate(360deg); }
		}

		.spinner {
			display: inline-block;
			width: 12px;
			height: 12px;
			vertical-align: text-bottom;
			border: 2px solid currentColor;
			border-right-color: transparent;
			border-radius: 50%;
			animation: spinner-border .75s linear infinite;
		}

		@keyframes flash-green {
			0% {
				border-color: rgba(16, 185, 129, 0.8);
				box-shadow: 0 0 20px rgba(16, 185, 129, 0.35);
			}
			100% {
				border-color: var(--border-color);
				box-shadow: var(--card-shadow);
			}
		}

		.card-update-flash {
			animation: flash-green 2s cubic-bezier(0.25, 1, 0.5, 1);
		}

		/* Tables */
		table {
			width: 100%;
			border-collapse: collapse;
			text-align: left;
			font-size: 14px;
		}

		th {
			background-color: var(--table-header-bg);
			font-weight: 600;
			color: var(--text-muted);
			padding: 16px 20px;
			border-bottom: 1px solid var(--border-color);
		}

		td {
			padding: 16px 20px;
			border-bottom: 1px solid var(--border-color);
			color: var(--text-main);
		}

		tr:hover td {
			background-color: rgba(255, 255, 255, 0.01);
		}

		code {
			font-family: monospace;
			background-color: var(--code-bg);
			padding: 4px 8px;
			border-radius: 6px;
			font-size: 13px;
			color: var(--code-color);
			border: 1px solid var(--code-border);
			transition: all 0.2s ease;
		}

		/* Badges */
		.badge {
			display: inline-flex;
			padding: 4px 8px;
			border-radius: 6px;
			font-size: 11px;
			font-weight: 600;
			white-space: nowrap;
		}

		.badge-success { background-color: rgba(16, 185, 129, 0.15); color: #10b981; }
		.badge-warning { background-color: rgba(245, 158, 11, 0.15); color: #f59e0b; }
		.badge-danger { background-color: rgba(239, 68, 68, 0.15); color: #ef4444; }
		.badge-info { background-color: rgba(59, 130, 246, 0.15); color: #3b82f6; }

		/* Charts */
		.charts-grid {
			display: grid;
			grid-template-columns: 1.5fr 1fr;
			gap: 20px;
		}

		.chart-container {
			position: relative;
			height: 300px;
			width: 100%;
		}

		@media (max-width: 900px) {
			.charts-grid {
				grid-template-columns: 1fr;
			}
		}

		/* Modals */
		.modal-overlay {
			position: fixed;
			top: 0;
			left: 0;
			right: 0;
			bottom: 0;
			background-color: var(--modal-overlay-bg);
			backdrop-filter: blur(0px);
			-webkit-backdrop-filter: blur(0px);
			display: flex;
			align-items: center;
			justify-content: center;
			z-index: 1000;
			opacity: 0;
			pointer-events: none;
			transition: opacity 0.3s ease, backdrop-filter 0.3s ease, -webkit-backdrop-filter 0.3s ease;
		}

		.modal-overlay.active {
			opacity: 1;
			pointer-events: auto;
			backdrop-filter: blur(8px);
			-webkit-backdrop-filter: blur(8px);
		}

		.modal-card {
			background-color: var(--card-bg);
			border: 1px solid var(--border-color);
			border-radius: 20px;
			width: 100%;
			max-width: 500px;
			padding: 32px;
			box-shadow: 0 20px 50px rgba(0, 0, 0, 0.4);
			display: flex;
			flex-direction: column;
			gap: 20px;
			transform: scale(0.9) translateY(20px);
			transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1), background-color 0.3s;
			backdrop-filter: blur(var(--glass-blur));
			-webkit-backdrop-filter: blur(var(--glass-blur));
		}

		.modal-overlay.active .modal-card {
			transform: scale(1) translateY(0);
		}

		.modal-header {
			display: flex;
			justify-content: space-between;
			align-items: center;
			border-bottom: 1px solid var(--border-color);
			padding-bottom: 16px;
		}

		.modal-header h3 {
			font-size: 18px;
			font-weight: 600;
		}

		.modal-footer {
			display: flex;
			justify-content: flex-end;
			gap: 12px;
			border-top: 1px solid var(--border-color);
			padding-top: 20px;
			margin-top: 10px;
		}

		/* Toast Notification (Green for success, Red for error, Orange for warning) */
		.toast-container {
			position: fixed;
			top: 24px;
			right: 24px;
			display: flex;
			flex-direction: column;
			gap: 10px;
			z-index: 9999;
			pointer-events: none;
		}

		.toast {
			min-width: 260px;
			padding: 14px 20px;
			border-radius: 12px;
			box-shadow: var(--card-shadow);
			font-size: 14px;
			font-weight: 600;
			display: flex;
			align-items: center;
			gap: 12px;
			backdrop-filter: blur(15px);
			-webkit-backdrop-filter: blur(15px);
			transform: translateY(-20px);
			opacity: 0;
			transition: all 0.4s cubic-bezier(0.16, 1, 0.3, 1);
			pointer-events: auto;
		}

		.toast.show {
			transform: translateY(0);
			opacity: 1;
		}

		.toast-icon {
			width: 20px;
			height: 20px;
			flex-shrink: 0;
		}

		.toast-success {
			background-color: #10b981 !important;
			color: #ffffff !important;
			border: none !important;
		}
		.toast-success .toast-icon, .toast-success span {
			color: #ffffff !important;
		}

		.toast-error {
			background-color: #ef4444 !important;
			color: #ffffff !important;
			border: none !important;
		}
		.toast-error .toast-icon, .toast-error span {
			color: #ffffff !important;
		}
		
		.toast-warning {
			background-color: #f59e0b !important;
			color: #ffffff !important;
			border: none !important;
		}
		.toast-warning .toast-icon, .toast-warning span {
			color: #ffffff !important;
		}

		/* Mobile Responsiveness */
		.mobile-header {
			display: none !important;
		}

		@media (max-width: 768px) {
			aside {
				transform: translateX(-100%);
			}
			aside.active {
				transform: translateX(0);
			}
			main {
				margin-left: 0;
				padding: 20px;
			}
			.mobile-header {
				display: flex !important;
			}
			.mobile-nav-toggle {
				background: none;
				border: none;
				color: var(--text-main);
				display: flex;
				align-items: center;
				gap: 6px;
				cursor: pointer;
				font-size: 14px;
				font-weight: 500;
			}
		}

		.public-chart-wrapper {
			position: relative;
			height: 190px;
			width: 100%;
			display: flex;
			align-items: center;
			justify-content: center;
			gap: 40px;
			overflow: hidden;
		}

		.public-chart-wrapper canvas {
			max-width: 100% !important;
		}

		#admin-chart-legend {
			scrollbar-width: none;
			-ms-overflow-style: none;
		}
		#admin-chart-legend::-webkit-scrollbar {
			display: none;
		}

		@media (max-width: 768px) {
			.public-chart-wrapper {
				flex-direction: column !important;
				height: auto !important;
				padding: 10px 0;
				gap: 20px !important;
			}
			.public-chart-wrapper > div:first-child {
				width: 160px !important;
				height: 160px !important;
			}
			.public-chart-wrapper > div:nth-child(2) {
				width: 100% !important;
				height: auto !important;
				align-items: center !important;
			}
			#admin-chart-legend {
				width: 100%;
				display: grid !important;
				grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
				gap: 8px !important;
				max-height: none !important;
			}
		}
${NEURON_THEME}
	</style>
</head>
<body>
	<!-- Dynamic Background Orbs -->
	<div class="bg-orbs-container">
		<div class="bg-orb bg-orb-1"></div>
		<div class="bg-orb bg-orb-2"></div>
	</div>

	<!-- App Header for Mobile Toggle -->
	<div style="display: flex; justify-content: space-between; align-items: center; padding: 15px 20px; background-color: var(--sidebar-bg); border-bottom: 1px solid var(--border-color); z-index: 90;" class="mobile-header">
		<div class="logo-area" style="margin-bottom: 0;">
			<div class="logo-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v13"/><path d="M12 10.5V9"/><circle cx="12" cy="13.5" r="2.5"/></svg></div>
			<span class="logo-text">NeuronGate</span>
		</div>
		<div style="display: flex; align-items: center; gap: 12px;">
			<button class="mobile-nav-toggle" onclick="toggleSidebar()">
				<svg style="width: 20px; height: 20px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path></svg>
				<span>菜单</span>
			</button>
		</div>
	</div>

	<div class="app-container">
		<!-- Sidebar -->
		<aside id="sidebar">
			<div class="logo-area">
				<div class="logo-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V7a3 3 0 0 1 3-3h10a3 3 0 0 1 3 3v13"/><path d="M12 10.5V9"/><circle cx="12" cy="13.5" r="2.5"/></svg></div>
				<span class="logo-text">NeuronGate</span>
			</div>
			
			<div class="nav-menu">
				<div class="nav-item active" id="menu-overview" onclick="switchTab('overview')">
					<svg style="width: 18px; height: 18px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"></path></svg>
					数据看板
				</div>
				<div class="nav-item" id="menu-chat" onclick="switchTab('chat')">
					<svg style="width: 18px; height: 18px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"></path></svg>
					聊天
				</div>
				<div class="nav-item" id="menu-accounts" onclick="switchTab('accounts')">
					<svg style="width: 18px; height: 18px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"></path></svg>
					账号管理
				</div>
				<div class="nav-item" id="menu-keys" onclick="switchTab('keys')">
					<svg style="width: 18px; height: 18px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z"></path></svg>
					API 密钥
				</div>
				<div class="nav-item" id="menu-settings" onclick="switchTab('settings')">
					<svg style="width: 18px; height: 18px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
					模型
				</div>
			</div>

			<div class="aside-footer">
				<button class="btn btn-secondary" onclick="toggleTheme()" title="切换日间/夜间模式" style="width: 100%; display: flex; justify-content: center; gap: 8px; align-items: center;">
					<svg class="theme-icon-sun" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none; width: 18px; height: 18px;">
						<circle cx="12" cy="12" r="4" />
						<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
					</svg>
					<svg class="theme-icon-moon" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px;">
						<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
					</svg>
					<span>切换主题</span>
				</button>
				<button class="btn btn-secondary" onclick="logout()">退出登录</button>
				<div style="text-align: center; font-size: 11px; color: var(--text-muted); opacity: 0.55; padding-top: 4px;">
						<a href="https://github.com/salem-2007/NeuronGate" target="_blank" rel="noopener" style="color: inherit; text-decoration: underline; text-underline-offset: 2px;">NeuronGate</a>
				</div>
			</div>
		</aside>

		<!-- Main Workspace -->
		<main>
			<div id="auth-views" style="display: flex; flex-direction: column; gap: 30px; width: 100%;">
				
				<!-- Header -->
				<header>
					<div>
						<h1 style="font-size: 26px; font-weight: 700;" id="view-title">数据看板</h1>
						<p id="view-subtitle" style="color: var(--text-muted); font-size: 14px; margin-top: 4px;">实时监控 Cloudflare AI 账号与接口状态</p>
					</div>
					<div class="user-profile">
						<span class="badge badge-success">系统正常运行</span>
					</div>
				</header>

				<!-- TAB: Overview -->
				<div id="tab-overview" class="tab-content active">
					<div class="card-grid">
						<div class="stat-card">
							<div style="display: flex; justify-content: space-between; align-items: flex-start;">
								<div class="stat-title">今日总消耗量</div>
								<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" style="width: 22px; height: 22px; color: var(--accent-color); opacity: 0.85;">
									<path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
								</svg>
							</div>
							<div class="stat-value" id="stat-total-neurons">0</div>
							<div class="progress-container">
								<div class="progress-bar" id="stat-neurons-progress" style="width: 0%;"></div>
							</div>
							<div class="stat-desc" id="stat-neurons-desc">0 / 0 Neurons (0.00%)</div>
						</div>
						<div class="stat-card">
							<div style="display: flex; justify-content: space-between; align-items: flex-start;">
								<div class="stat-title">已绑定账号</div>
								<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" style="width: 22px; height: 22px; color: var(--accent-color); opacity: 0.85;">
									<path stroke-linecap="round" stroke-linejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
								</svg>
							</div>
							<div class="stat-value" id="stat-accounts-count">0</div>
							<div class="stat-desc">活跃中的 Cloudflare 账号数</div>
						</div>
						<div class="stat-card">
							<div style="display: flex; justify-content: space-between; align-items: flex-start;">
								<div class="stat-title">代理 API 密钥</div>
								<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" style="width: 22px; height: 22px; color: var(--accent-color); opacity: 0.85;">
									<path stroke-linecap="round" stroke-linejoin="round" d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
								</svg>
							</div>
							<div class="stat-value" id="stat-keys-count">0</div>
							<div class="stat-desc">已配额调用 Key数</div>
						</div>
						<div class="stat-card">
							<div style="display: flex; justify-content: space-between; align-items: flex-start;">
								<div class="stat-title">节省成本 (估算)</div>
								<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" style="width: 22px; height: 22px; color: var(--accent-color); opacity: 0.85;">
									<path stroke-linecap="round" stroke-linejoin="round" d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
								</svg>
							</div>
							<div class="stat-value" id="stat-cost-saving">$0.00</div>
							<div class="stat-desc">对比 OpenAI completions 同等额度价格</div>
						</div>
					</div>

					<!-- Charts -->
					<div class="charts-grid" style="margin-top: 24px;">
						<div class="section-card">
							<div class="section-title">过去 7 日消耗走势 (Neurons)</div>
							<div class="chart-container">
								<canvas id="historyChart"></canvas>
							</div>
						</div>
						<div class="section-card">
							<div class="section-title">今日模型消耗占比</div>
							<div class="chart-container public-chart-wrapper" id="admin-chart-wrapper" style="display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 30px; height: 300px; padding: 10px 0;">
								<!-- Left: Chart -->
								<div id="admin-canvas-wrapper" style="position: relative; height: 220px; width: 220px; flex-shrink: 0; display: flex; align-items: center; justify-content: center;">
									<canvas id="modelsChart"></canvas>
								</div>
								<!-- Right: Legend -->
								<div id="admin-legend-wrapper" style="flex: 1; display: flex; flex-direction: column; justify-content: center; min-width: 0; align-self: stretch; height: 100%;">
									<div id="admin-chart-legend" style="flex: 1; display: flex; flex-direction: column; gap: 6px; min-width: 0; max-height: 260px; overflow-y: auto; padding-right: 4px;"></div>
								</div>
								<!-- Empty Placeholder -->
								<div id="admin-chart-placeholder" style="display: none; flex-direction: column; align-items: center; justify-content: center; height: 100%; width: 100%; color: var(--text-muted); font-size: 13px; gap: 12px; margin: auto;">
									<svg style="width: 32px; height: 32px; opacity: 0.5;" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z"></path>
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z"></path>
									</svg>
									<span>今日暂无消耗数据</span>
								</div>
							</div>
						</div>
					</div>

					<!-- Detailed Accounts Usage Grid -->
					<div class="section-card" style="margin-top: 24px;">
						<div class="section-header">
							<div class="section-title">账号用量明细</div>
							<div style="display: flex; align-items: center; gap: 12px;">
								<span id="txt-last-updated" style="font-size: 12px; color: var(--text-muted); font-family: monospace;"></span>
								<button class="btn btn-secondary" id="btn-refresh-usage" onclick="loadUsageDetails(true)">刷新用量</button>
							</div>
						</div>
						<div id="accounts-usage-list" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px;">
							<!-- Individual account progress item -->
						</div>
					</div>
				</div>

				<!-- TAB: Chat -->
				<div id="tab-chat" class="tab-content">
					<div class="section-card nc-chat-card">
						<div class="nc-chat-head">
							<div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
								<select id="chat-model" class="nc-chat-model"></select>
								<span class="nc-dim" id="chat-status"></span>
							</div>
							<button class="btn btn-secondary" onclick="clearChat()">清空对话</button>
						</div>
						<div id="chat-messages" class="nc-chat-body"></div>
						<div class="nc-chat-composer">
							<textarea id="chat-input" rows="1" placeholder="输入消息，Enter 发送，Shift+Enter 换行"></textarea>
							<button class="btn btn-primary" id="chat-send" onclick="sendChat()">发送</button>
						</div>
					</div>
				</div>

				<!-- TAB: Accounts -->
				<div id="tab-accounts" class="tab-content">
					<div class="section-card">
						<div class="section-header">
							<div class="section-title">账号配置</div>
							<div style="display:flex; align-items:center; gap:12px;">
								<span id="acct-cards-updated" style="font-size: 12px; color: var(--text-muted); font-family: monospace;"></span>
								<button class="btn btn-secondary" id="btn-refresh-acct-cards" onclick="loadAccountCards(true)">刷新余量</button>
								<button class="btn btn-primary" onclick="openAddAccountModal()">
									<svg style="width: 16px; height: 16px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
									添加账号
								</button>
							</div>
						</div>

						<div id="accounts-cards" style="display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; margin-top: 4px;">
							<!-- Account cards render here -->
						</div>
					</div>
				</div>

				<!-- TAB: API Keys -->
				<div id="tab-keys" class="tab-content">
					<!-- Proxy URL Info -->
					<div class="section-card" style="margin-bottom: 24px;">
						<div class="section-title">接入信息</div>
						<div class="section-note">OpenAI SDK 和 Anthropic Messages 都可直接接入，点击 URL 即可复制。</div>
						<div class="access-endpoint-grid" style="margin-top: 18px;">
							<div class="access-endpoint-card">
								<div class="endpoint-badge">OpenAI 兼容格式</div>
								<button type="button" class="endpoint-url" id="openai-endpoint-url" data-endpoint-url="" onclick="copyEndpointUrl(this.dataset.endpointUrl)">https://domain/v1/chat/completions</button>
							</div>
							<div class="access-endpoint-card">
								<div class="endpoint-badge">Anthropic 兼容格式</div>
								<button type="button" class="endpoint-url" id="anthropic-endpoint-url" data-endpoint-url="" onclick="copyEndpointUrl(this.dataset.endpointUrl)">https://domain/v1/messages</button>
							</div>
						</div>
					</div>

					<div class="section-card">
						<div class="section-header">
							<div class="section-title">API 密钥管理</div>
							<button class="btn btn-primary" onclick="openAddKeyModal()">
								<svg style="width: 16px; height: 16px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"></path></svg>
								生成新密钥
							</button>
						</div>
						
						<div style="background-color: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.2); padding: 16px; border-radius: 12px; font-size: 13px; color: var(--warning-color); line-height: 1.5; margin-bottom: 10px;" id="no-key-warning" class="hidden">
							<strong>提示：</strong> 目前未配置任何 API 密钥。反代 API (/v1/...) 处于公开可被任何人调用的状态。建议点击“生成新密钥”为您的接口加上调用凭证鉴权。
						</div>

						<table>
							<thead>
								<tr>
									<th>密钥描述</th>
									<th>API Key</th>
									<th>模型分组</th>
									<th>创建时间</th>
									<th>操作</th>
								</tr>
							</thead>
							<tbody id="keys-table-body">
								<!-- Keys rows -->
							</tbody>
						</table>
					</div>
				</div>

				<!-- TAB: 模型（目录 + 映射合并） -->
				<div id="tab-settings" class="tab-content">
					<div class="section-card">
						<div class="section-header">
							<div>
								<div class="section-title">模型</div>
								<div class="section-note">从 Cloudflare 同步模型目录后，会自动为每个模型生成简洁别名，请求时直接用别名即可（如 <code>gpt-oss-20b</code>）。手动添加的映射优先级最高，可覆盖自动别名。</div>
							</div>
							<div style="display:flex; align-items:center; gap:12px; flex-shrink:0;">
								<span id="catalog-updated" class="nc-dim"></span>
								<button class="btn btn-primary" id="btn-sync-models" onclick="syncModels()">从 Cloudflare 同步</button>
							</div>
						</div>

						<div class="nc-metrics">
							<div class="nc-metric"><span class="nc-metric-k">免费模型</span><span class="nc-metric-v" id="catalog-free-count" style="color:var(--success-color)">-</span></div>
							<div class="nc-metric"><span class="nc-metric-k">收费模型</span><span class="nc-metric-v" id="catalog-paid-count" style="color:var(--warning-color)">-</span></div>
							<div class="nc-metric"><span class="nc-metric-k">总计</span><span class="nc-metric-v" id="catalog-total-count">-</span></div>
							<div class="nc-metric"><span class="nc-metric-k">已映射别名</span><span class="nc-metric-v" id="catalog-mapped-count" style="color:var(--accent-color)">-</span></div>
						</div>

						<div class="nc-toolbar">
							<input type="text" id="catalog-filter" placeholder="搜索模型 / 别名..." oninput="renderCatalog()">
							<select id="catalog-group-filter" onchange="renderCatalog()">
								<option value="all">全部分组</option>
								<option value="free">仅免费</option>
								<option value="paid">仅收费</option>
								<option value="custom">仅自定义</option>
							</select>
							<button class="btn btn-secondary" id="btn-toggle-list" onclick="toggleCatalogCollapse()">收起列表</button>
						</div>

						<div id="catalog-collapse">
							<div class="nc-addmap">
								<input type="text" id="map-source" placeholder="别名，如 my-gpt">
								<span class="nc-arrow">→</span>
								<input type="text" id="map-target" placeholder="@cf/openai/gpt-oss-20b">
								<button class="btn btn-primary" onclick="addMapping()">添加映射</button>
								<button class="btn btn-secondary" onclick="restorePresetMappings()">恢复预设</button>
							</div>

							<div id="catalog-list" class="nc-vendors">
								<div style="color: var(--text-muted); font-size:13px; padding:20px; grid-column:1/-1;">尚未同步模型目录，点击右上角「从 Cloudflare 同步」。</div>
							</div>
						</div>
					</div>
				</div>

			</div>
		</main>
	</div>

	<!-- Modal: Add Cloudflare Account -->
	<div class="modal-overlay" id="account-modal">
		<div class="modal-card">
			<div class="modal-header">
				<h3 id="account-modal-title">添加 Cloudflare 账号</h3>
				<button onclick="closeAccountModal()" style="background: none; border: none; color: var(--text-muted); cursor: pointer;">
					<svg style="width: 20px; height: 20px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
				</button>
			</div>
			<input type="hidden" id="account-id-edit">
			<div class="form-group">
				<label for="account-name">账号别名 (如: 主账号 A)</label>
				<input type="text" id="account-name" placeholder="请输入备注名">
			</div>
			<div class="form-group">
				<label for="account-id">Account ID</label>
				<input type="text" id="account-id" placeholder="获取于 CF 控制台 Workers AI 页面" oninput="onAccountInfoChange()">
			</div>
			<div class="form-group">
				<label for="account-token">API Token (需要创建并赋予以下 3 个权限):</label>
				<div style="font-size: 12px; color: var(--text-muted); background: rgba(0,0,0,0.15); padding: 8px 12px; border-radius: 6px; margin-top: 4px; margin-bottom: 4px; line-height: 1.5; font-family: monospace;">
					• Workers AI &gt; Read <span id="perm-wa-read" style="margin-left: 8px;"></span><br>
					• Workers AI &gt; Edit <span id="perm-wa-edit" style="margin-left: 8px;"></span><br>
					• Account Analytics &gt; Read <span id="perm-aa-read" style="margin-left: 8px;"></span>
				</div>
				<input type="text" id="account-token" placeholder="CF 账号 API Token (会安全遮蔽保存)" oninput="onAccountInfoChange()">
			</div>
			
			<div id="test-result-alert" style="display: none; padding: 12px 16px; border-radius: 8px; font-size: 13px; font-weight: 500; word-break: break-word; overflow-wrap: break-word; max-height: 200px; overflow-y: auto; line-height: 1.6; border: 1px solid transparent;"></div>

			<div class="modal-footer">
				<button class="btn btn-success" onclick="testConnection()" id="btn-test-conn">测试连接</button>
				<button class="btn btn-primary" onclick="saveAccount()" id="btn-save-account" disabled>保存账号</button>
			</div>
		</div>
	</div>

	<!-- Modal: Add API Key -->
	<div class="modal-overlay" id="key-modal">
		<div class="modal-card">
			<div class="modal-header">
				<h3 id="key-modal-title">生成新 API 密钥</h3>
				<button onclick="closeKeyModal()" style="background: none; border: none; color: var(--text-muted); cursor: pointer;">
					<svg style="width: 20px; height: 20px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
				</button>
			</div>
			<div id="key-modal-form">
				<div class="form-group" style="margin-bottom: 16px;">
					<label for="key-name">密钥描述/使用客户端 (如: Cursor / NextChat)</label>
					<input type="text" id="key-name" placeholder="请输入描述名" style="width: 100%;">
				</div>
				<div class="form-group" style="margin-bottom: 16px;">
					<label for="key-group">可调用模型分组</label>
					<select id="key-group" style="width: 100%;">
						<option value="all">全部模型（免费 + 收费）</option>
						<option value="free">仅免费模型</option>
						<option value="paid">仅收费模型</option>
					</select>
					<div style="font-size: 12px; color: var(--text-muted); margin-top: 6px; line-height: 1.5;">选择「仅免费/仅收费」后，此密钥调用不属于该分组的模型会被拒绝（403）。分组依据从 Cloudflare 同步的模型清单，请先到「模型映射」页同步一次。</div>
				</div>
				<div class="form-group" style="margin-bottom: 16px;">
					<label for="key-val">API 密钥值 (可选，为空则随机生成 sk-wa-...)</label>
					<input type="text" id="key-val" placeholder="留空则随机生成密钥" style="width: 100%;">
				</div>
				<div class="modal-footer" style="margin-top: 10px; display: flex; gap: 12px; justify-content: flex-end; width: 100%;">
					<button class="btn btn-secondary" onclick="closeKeyModal()">取消</button>
					<button class="btn btn-primary" onclick="saveKey()">生成密钥</button>
				</div>
			</div>
			<div id="key-modal-success" class="hidden" style="display: flex; flex-direction: column; gap: 16px;">
				<div style="text-align: center; color: var(--success-color); font-size: 40px; margin-bottom: 8px;">🎉</div>
				<p style="font-size: 14px; text-align: center; line-height: 1.6; color: var(--text-main);">
					密钥生成成功！请务必复制保存此密钥，关闭后将无法再次完整查看。
				</p>
				<div class="form-group">
					<label>API Key</label>
					<div style="display: flex; gap: 10px;">
						<input type="text" id="generated-key-val" readonly style="flex: 1; font-family: monospace;">
						<button class="btn btn-primary" onclick="copyGeneratedKey()">复制</button>
					</div>
				</div>
				<div class="modal-footer" style="margin-top: 10px; width: 100%;">
					<button class="btn btn-secondary" onclick="closeKeyModal()" style="width: 100%;">我已保存，关闭</button>
				</div>
			</div>
		</div>
	</div>

	<!-- Modal: 供应商模型详情 -->
	<div class="modal-overlay" id="vendor-modal">
		<div class="modal-card" style="max-width: 680px;">
			<div class="modal-header">
				<div style="display:flex; align-items:center; gap:10px;">
					<div class="nc-vendor-logo" id="vendor-modal-logo">?</div>
					<div>
						<h3 id="vendor-modal-title" style="font-size:17px;">供应商</h3>
						<div class="nc-vendor-sub" id="vendor-modal-sub"></div>
					</div>
				</div>
				<button onclick="closeVendorModal()" style="background: none; border: none; color: var(--text-muted); cursor: pointer;">
					<svg style="width: 20px; height: 20px;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
				</button>
			</div>
			<div class="nc-detail" id="vendor-modal-body"></div>
		</div>
	</div>

	<script>
		let currentTab = 'overview';
		let historyChart = null;
		let modelsChart = null;
		const defaultMappings = ${JSON.stringify(DEFAULT_MODEL_MAP)};
		let customMappings = {};

		// ===== 供应商 / 任务 / 能力 / 模型 中文映射 =====
		const VENDOR_CN = {
			meta:'Meta', openai:'OpenAI', google:'Google', qwen:'通义千问', 'zai-org':'智谱 AI',
			moonshotai:'月之暗面', 'deepseek-ai':'深度求索', nvidia:'NVIDIA', baai:'智源研究院',
			'ibm-granite':'IBM', mistralai:'Mistral AI', microsoft:'微软', aisingapore:'AI Singapore',
			ai4bharat:'AI4Bharat', 'black-forest-labs':'Black Forest Labs', stabilityai:'Stability AI',
			leonardo:'Leonardo.Ai', lykon:'Lykon', runwayml:'Runway', bytedance:'字节跳动',
			recraft:'Recraft', huggingface:'Hugging Face', bartowski:'Bartowski', other:'其他'
		};
		const TASK_CN = {
			'Text Generation':'文本生成', 'Text Embeddings':'向量嵌入', 'Text-to-Image':'文生图',
			'Text-to-Speech':'语音合成', 'Automatic Speech Recognition':'语音识别',
			'Image-to-Text':'图生文', 'Text Classification':'文本分类', 'Translation':'翻译',
			'Image Classification':'图像分类', 'Dumb Pipe':'内部通道', 'Summarization':'摘要',
			'Image-to-Image':'图生图'
		};
		const CAP_CN = { functionCalling:'工具调用', vision:'视觉理解', reasoning:'推理', realtime:'实时', lora:'LoRA 微调' };
		const MODEL_CN = {
			'@cf/openai/gpt-oss-120b':'OpenAI 开源权重的大模型，面向生产环境，适合通用问答与高难度推理任务。',
			'@cf/openai/gpt-oss-20b':'OpenAI 开源权重的中等规模模型，低延迟，适合本地化与成本敏感场景。',
			'@cf/meta/llama-3.3-70b-instruct-fp8-fast':'Meta Llama 3.3 70B，指令微调，速度快，综合能力强，适合通用对话。',
			'@cf/meta/llama-3.1-8b-instruct-fp8':'Meta Llama 3.1 8B，轻量高速，适合简单对话与批量任务。',
			'@cf/meta/llama-3.2-3b-instruct':'Meta Llama 3.2 3B，超轻量，适合边缘与低延迟场景。',
			'@cf/meta/llama-3.2-1b-instruct':'Meta Llama 3.2 1B，极小模型，适合极低延迟的简单任务。',
			'@cf/meta/llama-4-scout-17b-16e-instruct':'Meta Llama 4 Scout，MoE 架构，支持长上下文与多模态。',
			'@cf/meta/llama-3.2-11b-vision-instruct':'Meta Llama 3.2 11B 视觉版，可理解图片内容并进行图文问答。',
			'@cf/google/gemma-4-26b-a4b-it':'Google Gemma 4 26B（MoE），指令微调，性能均衡。',
			'@cf/qwen/qwen3.8-27b':'通义千问 Qwen3.8 27B，中文与推理表现优秀。',
			'@cf/qwen/qwen3-30b-a3b-fp8':'通义千问 Qwen3 30B（MoE），推理与工具调用能力较强。',
			'@cf/qwen/qwq-32b':'通义 QwQ 32B 推理模型，擅长数学与复杂逻辑推理。',
			'@cf/qwen/qwen2.5-coder-32b-instruct':'通义千问 2.5 Coder 32B，专为代码生成与补全优化。',
			'@cf/zai-org/glm-5.2':'智谱 GLM-5.2，强通用对话与智能体能力（需付费计划）。',
			'@cf/zai-org/glm-5.3':'智谱 GLM-5.3，最新旗舰，综合能力更强（需付费计划）。',
			'@cf/zai-org/glm-4.7-flash':'智谱 GLM-4.7 Flash，响应快、性价比高，适合日常对话。',
			'@cf/moonshotai/kimi-k2.6':'月之暗面 Kimi K2.6，长上下文与代码能力强（需付费计划）。',
			'@cf/moonshotai/kimi-k2.7-code':'月之暗面 Kimi K2.7 Code，专为编程任务优化（需付费计划）。',
			'@cf/deepseek-ai/deepseek-v4-pro-0813':'深度求索 DeepSeek V4 Pro，旗舰推理模型（需付费计划）。',
			'@cf/deepseek-ai/deepseek-v4-flash-0731':'深度求索 DeepSeek V4 Flash，快速版（需付费计划）。',
			'@cf/deepseek-ai/deepseek-r1-distill-qwen-32b':'DeepSeek R1 蒸馏版（基于 Qwen 32B），擅长逐步推理。',
			'@cf/nvidia/nemotron-3-120b-a12b':'NVIDIA Nemotron 3 120B（MoE），面向企业级推理与智能体。',
			'@cf/ibm-granite/granite-4.0-h-micro':'IBM Granite 4.0 Micro，小巧高效，适合企业轻量任务。',
			'@cf/mistralai/mistral-small-3.1-24b-instruct':'Mistral Small 3.1 24B，指令微调，多语言与多模态兼顾。',
			'@cf/baai/bge-m3':'智源 BGE-M3 向量嵌入模型，支持多语言，适合检索与语义搜索。',
			'@cf/baai/bge-large-en-v1.5':'智源 BGE Large 英文向量嵌入，适合英文语义检索。',
			'@cf/baai/bge-base-en-v1.5':'智源 BGE Base 英文向量嵌入，轻量快速。',
			'@cf/google/embeddinggemma-300m':'Google EmbeddingGemma 300M，轻量多语言向量嵌入。',
			'@cf/qwen/qwen3-embedding-0.6b':'通义千问 Qwen3 向量嵌入 0.6B，中文语义支持好。',
			'@cf/black-forest-labs/flux-1-schnell':'Black Forest Labs FLUX.1 Schnell 文生图，生成速度快。',
			'@cf/leonardo/lucid-origin':'Leonardo Lucid Origin 文生图，画面精细。'
		};

		let autoMapping = {};
		let catalogCollapsed = false;

		function vendorCN(v){ return VENDOR_CN[v] || v; }
		function taskCN(t){ return TASK_CN[t] || t; }
		function formatCtx(n){ return (n >= 1024 && n % 1024 === 0) ? (n/1024) + 'K' : String(n); }
		function modelCN(m){
			if (MODEL_CN[m.name]) return MODEL_CN[m.name];
			var s = vendorCN(m.vendor) + ' 提供的' + taskCN(m.task) + '模型。';
			if (m.contextWindow) s += '上下文窗口 ' + formatCtx(m.contextWindow) + '。';
			if (m.paid) s += '需 Workers 付费计划。';
			return s;
		}
		function aliasForModel(name){
			var hit = null;
			Object.keys(customMappings).forEach(function(k){ if (customMappings[k] === name) hit = k; });
			if (hit) return { alias: hit, custom: true };
			Object.keys(autoMapping).forEach(function(k){ if (autoMapping[k] === name && !hit) hit = k; });
			if (hit) return { alias: hit, custom: false };
			return null;
		}

		async function loadModelPage(){
			try {
				const sres = await apiFetch('/api/settings');
				const sdata = await sres.json();
				customMappings = sdata.customModelMap || {};
				autoMapping = sdata.autoModelMap || {};
				const cres = await apiFetch('/api/models/available');
				const cdata = await cres.json();
				modelCatalog = cdata.catalog || { models: [] };
				catalogUpdatedText(cdata.updatedAt);
				renderVendors();
			} catch (e) { console.error(e); }
		}

		function renderVendors(){
			var box = document.getElementById('catalog-list');
			if (!box) return;
			var models = modelCatalog.models || [];
			var mapped = 0;
			models.forEach(function(m){ if (aliasForModel(m.name)) mapped++; });
			document.getElementById('catalog-free-count').innerText = models.filter(function(m){ return !m.paid; }).length;
			document.getElementById('catalog-paid-count').innerText = models.filter(function(m){ return m.paid; }).length;
			document.getElementById('catalog-total-count').innerText = models.length;
			var mEl = document.getElementById('catalog-mapped-count');
			if (mEl) mEl.innerText = mapped;

			var groups = {};
			models.forEach(function(m){ var v = m.vendor || 'other'; (groups[v] = groups[v] || []).push(m); });

			var kw = (document.getElementById('catalog-filter').value || '').toLowerCase();
			var grp = document.getElementById('catalog-group-filter').value || 'all';
			var vendors = Object.keys(groups).filter(function(v){
				var list = groups[v];
				if (grp === 'free' && !list.some(function(m){ return !m.paid; })) return false;
				if (grp === 'paid' && !list.some(function(m){ return m.paid; })) return false;
				if (grp === 'custom' && !list.some(function(m){ var a = aliasForModel(m.name); return a && a.custom; })) return false;
				if (kw) {
					var hit = v.toLowerCase().indexOf(kw) >= 0 || vendorCN(v).toLowerCase().indexOf(kw) >= 0;
					if (!hit) hit = list.some(function(m){ var a = aliasForModel(m.name); return m.name.toLowerCase().indexOf(kw) >= 0 || (a && a.alias.toLowerCase().indexOf(kw) >= 0); });
					if (!hit) return false;
				}
				return true;
			});

			box.innerHTML = '';
			if (models.length === 0) {
				box.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:20px;grid-column:1/-1;">尚未同步模型目录，点击右上角「从 Cloudflare 同步」。</div>';
				return;
			}
			if (vendors.length === 0) {
				box.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:20px;grid-column:1/-1;">无匹配的供应商。</div>';
				return;
			}

			vendors.sort(function(a,b){ return groups[b].length - groups[a].length; }).forEach(function(v){
				var list = groups[v];
				var free = list.filter(function(m){ return !m.paid; }).length;
				var paid = list.length - free;
				var initials = (v.replace(/[^a-zA-Z0-9]/g, '').slice(0,2) || '?').toUpperCase();
				var chips = '<span class="nc-chip">' + list.length + ' 个模型</span>';
				if (free) chips += '<span class="nc-chip free">免费 ' + free + '</span>';
				if (paid) chips += '<span class="nc-chip paid">收费 ' + paid + '</span>';
				var card = document.createElement('div');
				card.className = 'nc-vendor';
				card.setAttribute('role', 'button');
				card.setAttribute('tabindex', '0');
				card.onclick = function(){ openVendorModal(v); };
				card.onkeydown = function(ev){ if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openVendorModal(v); } };
				card.innerHTML =
					'<div class="nc-vendor-top">' +
						'<div class="nc-vendor-logo">' + sen(initials) + '</div>' +
						'<div><div class="nc-vendor-name">' + sen(vendorCN(v)) + '</div><div class="nc-vendor-sub">' + sen(v) + '</div></div>' +
					'</div>' +
					'<div class="nc-vendor-stats">' + chips + '</div>';
				box.appendChild(card);
			});
		}

		function openVendorModal(v){
			var models = (modelCatalog.models || []).filter(function(m){ return (m.vendor || 'other') === v; });
			document.getElementById('vendor-modal-title').innerText = vendorCN(v);
			document.getElementById('vendor-modal-sub').innerText = v + ' · ' + models.length + ' 个模型';
			document.getElementById('vendor-modal-logo').innerText = (v.replace(/[^a-zA-Z0-9]/g, '').slice(0,2) || '?').toUpperCase();
			var body = document.getElementById('vendor-modal-body');
			body.innerHTML = '';
			models.forEach(function(m){
				var al = aliasForModel(m.name);
				var caps = '';
				if (m.caps) { Object.keys(CAP_CN).forEach(function(k){ if (m.caps[k]) caps += '<span class="nc-cap">' + CAP_CN[k] + '</span>'; }); }
				var badges = m.paid ? '<span class="badge badge-warning">收费</span>' : '<span class="badge badge-success">免费</span>';
				if (m.beta) badges += ' <span class="badge badge-info">beta</span>';
				var aliasBlock = al
					? '<span class="nc-mrow-alias" title="点击复制别名">' + sen(al.alias) + '</span>' + (al.custom ? ' <span class="badge badge-warning">自定义</span>' : ' <span class="badge badge-info">自动</span>')
					: '<span style="font-family:JetBrains Mono,monospace;font-size:12px;color:var(--text-muted);">未映射</span>';
				var ctx = m.contextWindow ? (' · 上下文 ' + formatCtx(m.contextWindow)) : '';
				var copyPath = '<button class="btn btn-secondary nc-copy-path" style="padding:3px 8px;font-size:11px;">复制路径</button>';
				var row = document.createElement('div');
				row.className = 'nc-mrow';
				row.innerHTML =
					'<div class="nc-mrow-h">' +
						'<div style="min-width:0;">' + aliasBlock + '<div class="nc-mrow-path">' + sen(m.name) + '</div></div>' +
						'<div style="display:flex;gap:8px;align-items:center;flex-shrink:0;">' + badges + copyPath + '</div>' +
					'</div>' +
					'<div style="font-size:11.5px;color:var(--text-muted);margin-top:6px;">' + sen(taskCN(m.task)) + ctx + '</div>' +
					(caps ? '<div class="nc-caps">' + caps + '</div>' : '') +
					'<div class="nc-mrow-desc">' + sen(modelCN(m)) + '</div>';
				// 用事件绑定代替内联 onclick，避免模板字符串里的引号转义问题
				if (al) {
					var aliasEl = row.querySelector('.nc-mrow-alias');
					if (aliasEl) aliasEl.addEventListener('click', function(){ copyModelId(al.alias); });
				}
				var copyBtn = row.querySelector('.nc-copy-path');
				if (copyBtn) copyBtn.addEventListener('click', function(){ copyModelId(m.name); });
				body.appendChild(row);
			});
			document.getElementById('vendor-modal').classList.add('active');
		}
		function closeVendorModal(){ document.getElementById('vendor-modal').classList.remove('active'); }

		function toggleCatalogCollapse(){
			catalogCollapsed = !catalogCollapsed;
			var el = document.getElementById('catalog-collapse');
			var btn = document.getElementById('btn-toggle-list');
			if (el) el.style.display = catalogCollapsed ? 'none' : '';
			if (btn) btn.innerText = catalogCollapsed ? '展开列表' : '收起列表';
		}

		// ===== 聊天页 =====
		let chatHistory = [];
		let chatBusy = false;
		let chatInited = false;
		const CHAT_SUGGESTIONS = [
			'用一句话解释什么是 Cloudflare Workers AI',
			'写一个 Python 快速排序',
			'把这句话翻译成英文：你好，世界',
			'给我 3 个命名变量的好建议'
		];

		function initChat(){
			if (chatInited) return;
			chatInited = true;
			var input = document.getElementById('chat-input');
			if (input) {
				input.addEventListener('keydown', function(e){
					if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
				});
				input.addEventListener('input', function(){
					input.style.height = 'auto';
					input.style.height = Math.min(input.scrollHeight, 160) + 'px';
				});
			}
			var box = document.getElementById('chat-messages');
			if (box) {
				box.addEventListener('click', function(e){
					var btn = (e.target && e.target.closest) ? e.target.closest('.nc-act') : null;
					if (!btn) return;
					var wrap = btn.closest('.nc-msg');
					if (!wrap) return;
					var idx = Number(wrap.getAttribute('data-idx'));
					if (isNaN(idx)) return;
					var act = btn.getAttribute('data-act');
					if (act === 'copy') chatCopy(idx);
					else if (act === 'del') chatDelete(idx);
					else if (act === 'regen') chatRegenerate(idx);
					else if (act === 'edit') chatEdit(idx);
				});
			}
		}

		async function loadChatModels(){
			var sel = document.getElementById('chat-model');
			if (!sel || sel.options.length > 0) return;
			try {
				const mres = await apiFetch('/api/models/available');
				const mdata = await mres.json();
				const sres = await apiFetch('/api/settings');
				const sdata = await sres.json();
				var custom = sdata.customModelMap || {};
				var auto = sdata.autoModelMap || {};
				var aliasOf = function(name){
					var a = null;
					Object.keys(custom).forEach(function(k){ if (custom[k] === name) a = k; });
					if (a) return a;
					Object.keys(auto).forEach(function(k){ if (auto[k] === name && !a) a = k; });
					return a || String(name).split('/').pop();
				};
				var models = (mdata.catalog && mdata.catalog.models) || [];
				var chatModels = models.filter(function(m){ return m.task === 'Text Generation'; });
				if (chatModels.length === 0) chatModels = models.slice(0, 30);
				var free = chatModels.filter(function(m){ return !m.paid; });
				var paid = chatModels.filter(function(m){ return m.paid; });
				sel.innerHTML = '';
				var mk = function(list, label){
					if (!list.length) return;
					var og = document.createElement('optgroup');
					og.label = label;
					list.forEach(function(m){
						var o = document.createElement('option');
						o.value = aliasOf(m.name);
						o.textContent = aliasOf(m.name);
						og.appendChild(o);
					});
					sel.appendChild(og);
				};
				mk(free, '免费模型');
				mk(paid, '收费模型（需付费计划）');
				var st = document.getElementById('chat-status');
				if (st) st.innerText = sel.options.length + ' 个可用模型';
			} catch (e) { console.error(e); }
		}

		function buildMsgEl(role, content, idx){
			var wrap = document.createElement('div');
			wrap.className = 'nc-msg ' + (role === 'user' ? 'user' : 'assistant');
			if (idx !== undefined && idx !== null) wrap.setAttribute('data-idx', idx);
			var av = document.createElement('div');
			av.className = 'nc-avatar';
			av.textContent = role === 'user' ? '我' : 'AI';
			var col = document.createElement('div');
			col.className = 'nc-msg-col';
			var bub = document.createElement('div');
			bub.className = 'nc-bubble';
			bub.textContent = content;
			var acts = document.createElement('div');
			acts.className = 'nc-acts';
			var btns = [];
			if (role === 'user') btns.push(['编辑', 'edit']);
			btns.push(['复制', 'copy']);
			if (role === 'assistant') btns.push(['重新生成', 'regen']);
			btns.push(['删除', 'del']);
			btns.forEach(function(b){
				var el = document.createElement('button');
				el.className = 'nc-act';
				el.textContent = b[0];
				el.setAttribute('data-act', b[1]);
				acts.appendChild(el);
			});
			col.appendChild(bub);
			col.appendChild(acts);
			wrap.appendChild(av);
			wrap.appendChild(col);
			return wrap;
		}

		function chatCopy(i){
			var m = chatHistory[i];
			if (m) copyModelId(m.content);
		}
		function chatDelete(i){
			var m = chatHistory[i];
			if (!m) return;
			if (!confirm('删除这条消息？')) return;
			chatHistory.splice(i, 1);
			// 删除用户消息时，连带其后紧跟的助手回复一起删，保持成对
			if (m.role === 'user' && chatHistory[i] && chatHistory[i].role === 'assistant') chatHistory.splice(i, 1);
			renderChat();
		}
		function chatRegenerate(i){
			if (chatBusy) return;
			var m = chatHistory[i];
			if (!m || m.role !== 'assistant') return;
			chatHistory.splice(i); // 丢弃这条及之后的全部
			renderChat();
			if (chatHistory.length === 0 || chatHistory[chatHistory.length - 1].role !== 'user') return;
			runChat();
		}
		function chatEdit(i){
			if (chatBusy) return;
			var m = chatHistory[i];
			if (!m || m.role !== 'user') return;
			var box = document.getElementById('chat-messages');
			var wrap = box.querySelector('.nc-msg[data-idx="' + i + '"]');
			if (!wrap) return;
			var col = wrap.querySelector('.nc-msg-col');
			col.innerHTML = '';
			var ta = document.createElement('textarea');
			ta.className = 'nc-edit-ta';
			ta.value = m.content;
			var row = document.createElement('div');
			row.className = 'nc-edit-row';
			var save = document.createElement('button');
			save.className = 'btn btn-primary';
			save.textContent = '保存并重发';
			var cancel = document.createElement('button');
			cancel.className = 'btn btn-secondary';
			cancel.textContent = '取消';
			row.appendChild(save);
			row.appendChild(cancel);
			col.appendChild(ta);
			col.appendChild(row);
			ta.focus();
			try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e0) {}
			cancel.addEventListener('click', function(){ renderChat(); });
			save.addEventListener('click', function(){
				var nv = (ta.value || '').trim();
				if (!nv) return;
				chatHistory[i] = { role: 'user', content: nv };
				chatHistory.splice(i + 1); // 丢弃该消息之后的旧回复
				renderChat();
				runChat();
			});
		}

		function renderChat(){
			var box = document.getElementById('chat-messages');
			if (!box) return;
			box.innerHTML = '';
			if (chatHistory.length === 0) {
				var empty = document.createElement('div');
				empty.className = 'nc-chat-empty';
				var s = '<div>选择一个模型开始对话</div><div class="nc-sugg">';
				CHAT_SUGGESTIONS.forEach(function(t, i){ s += '<button data-i="' + i + '">' + sen(t) + '</button>'; });
				s += '</div>';
				empty.innerHTML = s;
				box.appendChild(empty);
				empty.querySelectorAll('.nc-sugg button').forEach(function(b){
					b.addEventListener('click', function(){
						document.getElementById('chat-input').value = CHAT_SUGGESTIONS[Number(b.getAttribute('data-i'))];
						sendChat();
					});
				});
				return;
			}
			chatHistory.forEach(function(msg, i){ box.appendChild(buildMsgEl(msg.role, msg.content, i)); });
			box.scrollTop = box.scrollHeight;
		}

		async function sendChat(){
			if (chatBusy) return;
			var input = document.getElementById('chat-input');
			var text = (input.value || '').trim();
			if (!text) return;
			var model = document.getElementById('chat-model').value;
			if (!model) { showToast('请先选择模型（先到「模型」页同步模型目录）', 'warning'); return; }
			chatHistory.push({ role: 'user', content: text });
			input.value = '';
			input.style.height = 'auto';
			renderChat();
			runChat();
		}

		async function runChat(){
			if (chatBusy) return;
			var model = document.getElementById('chat-model').value;
			if (!model) return;
			chatBusy = true;
			var sendBtn = document.getElementById('chat-send');
			if (sendBtn) sendBtn.disabled = true;
			renderChat();

			var box = document.getElementById('chat-messages');
			var wrap = buildMsgEl('assistant', '');
			wrap.removeAttribute('data-idx');
			var pendingActs = wrap.querySelector('.nc-acts');
			if (pendingActs) pendingActs.style.display = 'none';
			var bub = wrap.querySelector('.nc-bubble');
			var cursor = document.createElement('span');
			cursor.className = 'nc-cursor';
			bub.appendChild(cursor);
			box.appendChild(wrap);
			box.scrollTop = box.scrollHeight;
			var acc = '';
			var stEl = document.getElementById('chat-status');

			try {
				const res = await fetch('/api/chat', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ model: model, messages: chatHistory, stream: true })
				});
				if (!res.ok || !res.body) {
					var errText;
					try { var j = await res.json(); errText = (j.error && j.error.message) || JSON.stringify(j); }
					catch (e2) { errText = 'HTTP ' + res.status; }
					bub.textContent = '请求失败：' + errText;
					chatHistory.push({ role: 'assistant', content: '请求失败：' + errText });
				} else {
					const reader = res.body.getReader();
					const decoder = new TextDecoder();
					var buf = '';
					while (true) {
						var r = await reader.read();
						if (r.done) break;
						buf += decoder.decode(r.value, { stream: true });
						var lines = buf.split('\\n');
						buf = lines.pop();
						for (var i = 0; i < lines.length; i++) {
							var line = lines[i].trim();
							if (!line || line.indexOf('data:') !== 0) continue;
							var payload = line.slice(5).trim();
							if (payload === '[DONE]') continue;
							try {
								var jd = JSON.parse(payload);
								var delta = jd.choices && jd.choices[0] && jd.choices[0].delta;
								if (delta && typeof delta.content === 'string') {
									acc += delta.content;
									bub.textContent = acc;
									bub.appendChild(cursor);
									box.scrollTop = box.scrollHeight;
								}
							} catch (e3) {}
						}
					}
					if (cursor.parentNode) cursor.remove();
					if (!acc) { acc = '(空响应)'; bub.textContent = acc; }
					chatHistory.push({ role: 'assistant', content: acc });
				}
			} catch (err) {
				if (cursor.parentNode) cursor.remove();
				bub.textContent = '网络错误：' + err.message;
				chatHistory.push({ role: 'assistant', content: '网络错误：' + err.message });
			} finally {
				if (cursor.parentNode) cursor.remove();
				chatBusy = false;
				if (sendBtn) sendBtn.disabled = false;
				if (stEl) stEl.innerText = '';
				box.scrollTop = box.scrollHeight;
			}
		}

		function clearChat(){
			chatHistory = [];
			renderChat();
		}

		// Toast Helper
		function showToast(message, type = 'success') {
			let container = document.querySelector('.toast-container');
			if (!container) {
				container = document.createElement('div');
				container.className = 'toast-container';
				document.body.appendChild(container);
			}

			const toast = document.createElement('div');
			toast.className = \`toast toast-\${type}\`;
			
			let iconSvg = '';
			if (type === 'success') {
				iconSvg = \`<svg class="toast-icon" style="color: #ffffff;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>\`;
			} else if (type === 'error') {
				iconSvg = \`<svg class="toast-icon" style="color: #ffffff;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>\`;
			} else {
				iconSvg = \`<svg class="toast-icon" style="color: #ffffff;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>\`;
			}

			toast.innerHTML = \`\${iconSvg}<span>\${message}</span>\`;
			container.appendChild(toast);

			toast.offsetHeight; // trigger reflow
			toast.classList.add('show');

			setTimeout(() => {
				toast.classList.remove('show');
				setTimeout(() => toast.remove(), 400);
			}, 3000);
		}

		function renderUsageDetails(data) {
			let totalUsageToday = 0;
			let totalLimit = data.length * 10000;
			let historyData = {};
			let modelsToday = {};

			const usageList = document.getElementById('accounts-usage-list');

			// 记录刷新前已有卡片的最后更新时间戳
			const previousTimestamps = new Map();
			usageList.querySelectorAll('.section-card').forEach(card => {
				const id = card.dataset.id;
				const ts = parseInt(card.dataset.lastUpdated || '0', 10);
				if (id) previousTimestamps.set(id, ts);
			});

			usageList.innerHTML = '';

			if (data.length === 0) {
				usageList.innerHTML = '<div style="color: var(--text-muted); font-size:14px; text-align:center; padding: 20px; width: 100%;">没有绑定的账号，请前往“账号管理”添加账号。</div>';
				return;
			}

			data.forEach(account => {
				totalUsageToday += account.usageToday;

				// Percentage formatted to 2 decimal places
				const percentage = Math.min(100, Number(((account.usageToday / 10000) * 100).toFixed(2)));
				const warningClass = account.status === 'error' ? 'badge-danger' : (account.status === 'pending' ? 'badge-info' : (percentage >= 90 ? 'badge-warning' : 'badge-success'));
				const statusText = account.status === 'error' ? '连接异常' : (account.status === 'pending' ? '待刷新' : (percentage >= 100 ? '用尽 (10k)' : '正常运行'));
				
				// Usage rounded up (Math.ceil)
				const roundedUsage = Math.ceil(account.usageToday);
				
				const item = document.createElement('div');
				const isRefreshed = previousTimestamps.has(account.id) && previousTimestamps.get(account.id) !== account.lastUpdated;
				item.className = 'section-card' + (isRefreshed ? ' card-update-flash' : '');
				item.dataset.id = account.id;
				item.dataset.lastUpdated = account.lastUpdated || 0;
				item.style.padding = '20px';
				item.style.backgroundColor = 'rgba(255,255,255,0.01)';
				item.innerHTML = \`
					<div style="display:flex; justify-content:space-between; align-items:center; margin-bottom: 12px; gap: 12px;">
						<div style="min-width: 0; flex: 1; display: flex; align-items: center; gap: 8px;">
							<strong style="font-size:15px; font-weight:600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto;" title="\${account.name}">\${account.name}</strong>
							<span style="font-size:12px; color: var(--text-muted); font-family: monospace; white-space: nowrap; flex-shrink: 0;">(\${account.accountId.substring(0,6)}...\${account.accountId.substring(account.accountId.length-4)})</span>
						</div>
						<span class="badge \${warningClass}" style="flex-shrink: 0;">\${statusText}</span>
					</div>
					<div class="progress-container">
						<div class="progress-bar" style="width: \${percentage}%;"></div>
					</div>
					<div style="display:flex; justify-content:space-between; font-size:12px; color: var(--text-muted); margin-top: 6px;">
						<span>今日已用: \${roundedUsage.toLocaleString()} / 10,000 Neurons</span>
						<span>\${percentage.toFixed(2)}%</span>
					</div>
					\${account.error ? \`<div style="color: var(--danger-color); font-size:11px; margin-top: 8px; background: rgba(239,68,68,0.08); padding: 8px 12px; border-radius: 6px; border: 1px solid rgba(239,68,68,0.12);">错误信息: \${account.error}</div>\` : ''}
				\`;
				usageList.appendChild(item);

				if (account.history) {
					account.history.forEach(h => {
						historyData[h.date] = (historyData[h.date] || 0) + h.neurons;
					});
				}

				if (account.modelsToday) {
					account.modelsToday.forEach(m => {
						modelsToday[m.model] = (modelsToday[m.model] || 0) + m.neurons;
					});
				}
			});

			// Top stats formatting (Usage rounded up, Percentage 2 decimals)
			const roundedTotalUsageToday = Math.ceil(totalUsageToday);
			document.getElementById('stat-total-neurons').innerText = roundedTotalUsageToday.toLocaleString();
			document.getElementById('stat-accounts-count').innerText = data.length;
			
			const overallPercentage = totalLimit > 0 ? Math.min(100, Number(((totalUsageToday / totalLimit) * 100).toFixed(2))) : 0;
			document.getElementById('stat-neurons-progress').style.width = overallPercentage + '%';
			document.getElementById('stat-neurons-desc').innerText = \`\${roundedTotalUsageToday.toLocaleString()} / \${totalLimit.toLocaleString()} Neurons (\${overallPercentage.toFixed(2)}%)\`;
			
			const costSaved = (totalUsageToday / 1000) * 0.011;
			document.getElementById('stat-cost-saving').innerText = '$' + costSaved.toFixed(2);

			const dates = Object.keys(historyData).sort();
			const neuronsData = dates.map(d => historyData[d]);
			renderHistoryChart(dates, neuronsData);

			const models = Object.keys(modelsToday);
			const modelsNeurons = models.map(m => modelsToday[m]);
			renderModelsChart(models, modelsNeurons);
		}

		let isRefreshingUsage = false;

		async function loadUsageDetails(isManual = false) {
			// 如果已经在刷新中，则直接返回，避免并发请求
			if (isRefreshingUsage) return;

			const now = Date.now();
			const lastFetchedRaw = localStorage.getItem('cache_usage_details_last_fetched');
			let lastFetched = lastFetchedRaw ? parseInt(lastFetchedRaw, 10) : 0;

			// 优先从浏览器 localStorage 读取并渲染上次缓存的数据
			const cachedDataRaw = localStorage.getItem('cache_accounts_usage');
			if (cachedDataRaw) {
				try {
					const cachedData = JSON.parse(cachedDataRaw);
					renderUsageDetails(cachedData);
				} catch (e) {
					console.error('Error parsing cached usage details:', e);
				}
			}
			const cachedKeysCount = localStorage.getItem('cache_keys_count');
			if (cachedKeysCount) {
				document.getElementById('stat-keys-count').innerText = cachedKeysCount;
			}

			// 更新文字显示
			updateLastUpdatedText(lastFetched);

			// 如果不是手动刷新，且最后更新时间在 15 分钟以内，则直接使用缓存，不发起 API 请求
			if (!isManual && lastFetched && (now - lastFetched) < 15 * 60 * 1000) {
				console.log('Skipping auto refresh, last fetch was ' + Math.round((now - lastFetched) / 1000) + 's ago');
				return;
			}

			const btn = document.getElementById('btn-refresh-usage');
			let originalBtnText = '';
			if (btn) {
				originalBtnText = btn.innerHTML;
				btn.disabled = true;
				btn.innerHTML = '<span class="spinner"></span> 刷新中...';
			}

			isRefreshingUsage = true;

			try {
				const res = await apiFetch('/api/accounts/usage');
				const data = await res.json();
				
				// 渲染最新的实时数据
				renderUsageDetails(data);
				
				// 保存/更新本地缓存
				localStorage.setItem('cache_accounts_usage', JSON.stringify(data));

				// 记录更新时间戳，并更新文字
				localStorage.setItem('cache_usage_details_last_fetched', now);
				updateLastUpdatedText(now);

				// 刷新并缓存 API 密钥数
				const keysRes = await apiFetch('/api/keys');
				const keys = await keysRes.json();
				document.getElementById('stat-keys-count').innerText = keys.length;
				localStorage.setItem('cache_keys_count', keys.length);

			} catch (e) {
				console.error(e);
			} finally {
				isRefreshingUsage = false;
				if (btn) {
					btn.disabled = false;
					btn.innerHTML = originalBtnText;
				}
			}
		}

		function updateLastUpdatedText(timestamp) {
			const label = document.getElementById('txt-last-updated');
			if (!label) return;
			if (!timestamp) {
				label.innerText = '从未更新';
				return;
			}
			const date = new Date(timestamp);
			const yyyy = date.getFullYear();
			const MM = String(date.getMonth() + 1).padStart(2, '0');
			const dd = String(date.getDate()).padStart(2, '0');
			const hh = String(date.getHours()).padStart(2, '0');
			const mm = String(date.getMinutes()).padStart(2, '0');
			const ss = String(date.getSeconds()).padStart(2, '0');
			label.innerText = '最后更新: ' + yyyy + '-' + MM + '-' + dd + ' ' + hh + ':' + mm + ':' + ss;
		}

		function initTheme() {
			const savedTheme = localStorage.getItem('theme');
			if (savedTheme) {
				document.documentElement.setAttribute('data-theme', savedTheme);
			} else {
				const systemPrefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
				const defaultTheme = systemPrefersDark ? 'dark' : 'light';
				document.documentElement.setAttribute('data-theme', defaultTheme);
			}
			updateThemeIcons();
		}

		function toggleTheme() {
			const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
			const newTheme = currentTheme === 'light' ? 'dark' : 'light';
			document.documentElement.setAttribute('data-theme', newTheme);
			localStorage.setItem('theme', newTheme);
			updateThemeIcons();
			if (currentTab === 'overview') {
				loadUsageDetails();
			}
		}

		function updateThemeIcons() {
			const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
			const sunIcons = document.querySelectorAll('.theme-icon-sun');
			const moonIcons = document.querySelectorAll('.theme-icon-moon');
			if (currentTheme === 'light') {
				sunIcons.forEach(el => el.style.display = 'none');
				moonIcons.forEach(el => el.style.display = 'block');
			} else {
				sunIcons.forEach(el => el.style.display = 'block');
				moonIcons.forEach(el => el.style.display = 'none');
			}
		}

		initTheme();

		window.onload = function() {
			const openaiUrl = window.location.origin + '/v1/chat/completions';
			const anthropicUrl = window.location.origin + '/v1/messages';
			const openaiUrlEl = document.getElementById('openai-endpoint-url');
			const anthropicUrlEl = document.getElementById('anthropic-endpoint-url');
			if (openaiUrlEl) {
				openaiUrlEl.dataset.endpointUrl = openaiUrl;
				openaiUrlEl.textContent = openaiUrl;
			}
			if (anthropicUrlEl) {
				anthropicUrlEl.dataset.endpointUrl = anthropicUrl;
				anthropicUrlEl.textContent = anthropicUrl;
			}
			loadUsageDetails();
		};

		function toggleSidebar() {
			document.getElementById('sidebar').classList.toggle('active');
		}

		async function logout() {
			const res = await fetch('/api/auth/logout', { method: 'POST' });
			if (res.ok) {
				showToast('已安全退出登录');
				setTimeout(() => {
					window.location.href = '/';
				}, 800);
			}
		}

		function switchTab(tabName) {
			if (tabName === currentTab) return;
			currentTab = tabName;
			document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
			document.getElementById('menu-' + tabName).classList.add('active');

			document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
			document.getElementById('tab-' + tabName).classList.add('active');

			const titles = {
				overview: '数据看板',
				chat: '聊天',
				accounts: '账号管理',
				keys: 'API 密钥',
				settings: '模型'
			};
			const subtitles = {
				overview: '实时监控 Cloudflare AI 账号与接口状态',
				chat: '直接与模型对话，流式输出，无需配置 API Key',
				accounts: '管理 Cloudflare 账号，查看各账号今日余量与状态',
				keys: '生成调用密钥，可按免费/收费分组限制可调用的模型',
				settings: '同步模型目录并管理别名映射，支持供应商分组浏览'
			};
			document.getElementById('view-title').innerText = titles[tabName];
			var subEl = document.getElementById('view-subtitle');
			if (subEl) subEl.innerText = subtitles[tabName] || '';
			document.getElementById('sidebar').classList.remove('active');

			if (tabName === 'overview') {
				loadUsageDetails();
			} else if (tabName === 'chat') {
				initChat();
				loadChatModels();
				renderChat();
			} else if (tabName === 'accounts') {
				loadAccounts();
			} else if (tabName === 'keys') {
				loadKeys();
			} else if (tabName === 'settings') {
				loadSettings();
			}
		}

		async function apiFetch(path, options = {}) {
			const res = await fetch(path, options);
			if (res.status === 401) {
				window.location.href = '/';
				throw new Error('Unauthorized');
			}
			return res;
		}


		function renderHistoryChart(labels, data) {
			if (historyChart) historyChart.destroy();
			const isLight = document.documentElement.getAttribute('data-theme') === 'light';
			const gridColor = isLight ? 'rgba(0, 0, 0, 0.05)' : 'rgba(255, 255, 255, 0.05)';
			const textColor = isLight ? '#64748b' : '#94a3b8';
			const ctx = document.getElementById('historyChart').getContext('2d');
			const gradient = ctx.createLinearGradient(0, 0, 0, 300);
			gradient.addColorStop(0, 'rgba(255, 138, 61, 0.32)');
			gradient.addColorStop(1, 'rgba(255, 138, 61, 0.00)');
			historyChart = new Chart(ctx, {
				type: 'line',
				data: {
					labels: labels,
					datasets: [{
						label: 'Neuron 消耗数',
						data: data,
						borderColor: '#FF8A3D',
						backgroundColor: gradient,
						borderWidth: 3,
						tension: 0.3,
						fill: true,
						pointBackgroundColor: '#FF8A3D',
						pointBorderColor: 'rgba(255, 255, 255, 0.8)',
						pointBorderWidth: 1.5,
						pointRadius: 4,
						pointHoverRadius: 6,
						pointHoverBorderWidth: 3
					}]
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					plugins: { legend: { display: false } },
					scales: {
						y: { grid: { color: gridColor }, ticks: { color: textColor } },
						x: { grid: { display: false }, ticks: { color: textColor } }
					}
				}
			});
		}

		function renderModelsChart(labels, data) {
			if (modelsChart) modelsChart.destroy();
			
			const legendContainer = document.getElementById('admin-chart-legend');
			const canvasWrapper = document.getElementById('admin-canvas-wrapper');
			const legendWrapper = document.getElementById('admin-legend-wrapper');
			const placeholder = document.getElementById('admin-chart-placeholder');

			if (legendContainer) legendContainer.innerHTML = '';

			if (labels.length === 0) {
				if (canvasWrapper) canvasWrapper.style.display = 'none';
				if (legendWrapper) legendWrapper.style.display = 'none';
				if (placeholder) placeholder.style.display = 'flex';
				return;
			} else {
				if (canvasWrapper) canvasWrapper.style.display = 'flex';
				if (legendWrapper) legendWrapper.style.display = 'flex';
				if (placeholder) placeholder.style.display = 'none';
			}

			// Sort the model data descending by neurons
			const combined = labels.map((label, idx) => ({
				fullLabel: label,
				cleanLabel: label.split('/').pop(),
				value: data[idx]
			})).sort((a, b) => b.value - a.value);

			const sortedLabels = combined.map(x => x.cleanLabel);
			const sortedData = combined.map(x => x.value);

			const isLight = document.documentElement.getAttribute('data-theme') === 'light';
			const textColor = isLight ? '#64748b' : '#94a3b8';
			const borderColor = isLight ? '#ffffff' : '#1e293b';
			const ctx = document.getElementById('modelsChart').getContext('2d');
			
			modelsChart = new Chart(ctx, {
				type: 'doughnut',
				data: {
					labels: sortedLabels,
					datasets: [{
						data: sortedData,
						backgroundColor: ['#FF8A3D', '#38BDF8', '#34D399', '#FBBF24', '#A78BFA', '#FB7185'],
						borderWidth: 2,
						borderColor: borderColor
					}]
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					cutout: '70%',
					animation: {
						animateRotate: true,
						animateScale: true,
						duration: 1000,
						easing: 'easeOutQuart'
					},
					plugins: {
						legend: {
							display: false // 关闭原生图例，使用 HTML 自定义图例
						}
					}
				}
			});

			// Render Custom HTML Legend for Admin Page
			if (legendContainer) {
				const colors = ['#FF8A3D', '#38BDF8', '#34D399', '#FBBF24', '#A78BFA', '#FB7185'];
				const total = sortedData.reduce((a, b) => a + b, 0);
				
				combined.forEach((itemData, index) => {
					const label = itemData.cleanLabel;
					const fullLabel = itemData.fullLabel;
					const val = itemData.value;
					const color = colors[index % colors.length];
					const pct = total > 0 ? ((val / total) * 100).toFixed(1) : '0.0';
					
					const item = document.createElement('div');
					item.style.display = 'flex';
					item.style.alignItems = 'center';
					item.style.gap = '8px';
					item.style.fontSize = '12px';
					item.style.color = textColor;
					item.style.opacity = '0';
					item.style.transform = 'translateX(10px)';
					item.style.transition = 'all 0.4s cubic-bezier(0.16, 1, 0.3, 1)';
					
					item.innerHTML = '<span style="width: 8px; height: 8px; border-radius: 50%; background-color: ' + color + '; flex-shrink: 0; margin-right: 2px;"></span>' +
						'<span style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; font-weight: 500;" title="' + fullLabel + '">' + label + '</span>' +
						'<span style="color: var(--text-muted); font-family: monospace; font-size: 11px; flex-shrink: 0; margin-left: 4px;">' + pct + '%</span>';
					
					legendContainer.appendChild(item);
					
					// 与环形图同时开始加载，依次淡入滑出
					setTimeout(() => {
						item.style.opacity = '1';
						item.style.transform = 'translateX(0)';
					}, index * 80);
				});
			}
		}

		async function copyEndpointUrl(url) {
			if (!url) return;
			try {
				if (navigator.clipboard && window.isSecureContext) {
					await navigator.clipboard.writeText(url);
				} else {
					const input = document.createElement('input');
					input.value = url;
					input.style.position = 'fixed';
					input.style.opacity = '0';
					input.style.left = '-9999px';
					document.body.appendChild(input);
					input.select();
					document.execCommand('copy');
					document.body.removeChild(input);
				}
				showToast('已复制接入地址！');
			} catch (e) {
				console.error(e);
				showToast('复制失败，请手动复制 URL', 'error');
			}
		}

		// 账号管理页：卡片式渲染，合并「账号配置」与「实时余量」
		let acctUsageCache = {};   // id -> usage 明细
		let isRefreshingAcctCards = false;

		function loadAccounts() {
			// 兼容旧调用名，统一走卡片渲染
			return loadAccountCards(false);
		}

		async function loadAccountCards(isManual = false) {
			if (isRefreshingAcctCards) return;
			try {
				const res = await apiFetch('/api/accounts');
				const accounts = await res.json();
				renderAccountCards(accounts);
				if (accounts.length === 0) return;

				// 拉实时余量（会打 CF Analytics，较慢）
				const btn = document.getElementById('btn-refresh-acct-cards');
				let originalText = '';
				if (btn) { originalText = btn.innerHTML; btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 刷新中...'; }
				isRefreshingAcctCards = true;
				try {
					const uRes = await apiFetch('/api/accounts/usage');
					const usage = await uRes.json();
					acctUsageCache = {};
					usage.forEach(u => { acctUsageCache[u.id] = u; });
					renderAccountCards(accounts);
					const now = Date.now();
					const lbl = document.getElementById('acct-cards-updated');
					if (lbl) { const d = new Date(now); lbl.innerText = '余量更新: ' + d.toLocaleTimeString(); }
				} finally {
					isRefreshingAcctCards = false;
					if (btn) { btn.disabled = false; btn.innerHTML = originalText; }
				}
			} catch (e) {
				console.error(e);
			}
		}

		function renderAccountCards(accounts) {
			const box = document.getElementById('accounts-cards');
			if (!box) return;
			box.innerHTML = '';
			if (accounts.length === 0) {
				box.innerHTML = '<div style="color: var(--text-muted); font-size:14px; text-align:center; padding: 30px; width: 100%;">暂无配置的 Cloudflare 账号，点击右上角「添加账号」。</div>';
				return;
			}
			accounts.forEach(acc => {
				const maskedToken = acc.apiToken && acc.apiToken.length > 8 ? acc.apiToken.substring(0, 4) + '...' + acc.apiToken.substring(acc.apiToken.length - 4) : '********';
				const u = acctUsageCache[acc.id];

				let usageHtml;
				if (!u) {
					usageHtml = '<div style="font-size:12px; color: var(--text-muted); margin-top:10px;"><span class="spinner" style="vertical-align:middle;"></span> 余量待刷新...</div>';
				} else {
					const used = Math.ceil(u.usageToday || 0);
					const pct = Math.min(100, Number(((used / 10000) * 100).toFixed(2)));
					const badgeClass = u.status === 'error' ? 'badge-danger' : (u.status === 'pending' ? 'badge-info' : (pct >= 90 ? 'badge-warning' : 'badge-success'));
					const badgeText = u.status === 'error' ? '连接异常' : (u.status === 'pending' ? '待刷新' : (pct >= 100 ? '已用尽' : '正常'));
					usageHtml = \`
						<div style="display:flex; justify-content:space-between; align-items:center; margin-top:12px; margin-bottom:6px;">
							<span style="font-size:12px; color: var(--text-muted);">今日余量</span>
							<span class="badge \${badgeClass}">\${badgeText}</span>
						</div>
						<div class="progress-container"><div class="progress-bar" style="width: \${pct}%;"></div></div>
						<div style="display:flex; justify-content:space-between; font-size:12px; color: var(--text-muted); margin-top:6px;">
							<span>\${used.toLocaleString()} / 10,000 Neurons</span>
							<span>\${pct.toFixed(2)}%</span>
						</div>
						\${u.error ? \`<div style="color: var(--danger-color); font-size:11px; margin-top:8px; background: rgba(239,68,68,0.08); padding:6px 10px; border-radius:6px;">\${sen(u.error)}</div>\` : ''}
					\`;
				}

				const card = document.createElement('div');
				card.className = 'section-card';
				card.style.padding = '20px';
				card.innerHTML = \`
					<div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px;">
						<div style="min-width:0; flex:1;">
							<strong style="font-size:15px; font-weight:600; display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="\${sen(acc.name)}">\${sen(acc.name)}</strong>
							<div style="font-size:12px; color: var(--text-muted); font-family: monospace; margin-top:4px;">\${acc.accountId.substring(0,8)}...\${acc.accountId.substring(acc.accountId.length-4)}</div>
						</div>
						<div style="display:flex; gap:6px; flex-shrink:0;">
							<button class="btn btn-secondary" style="padding:5px 10px; font-size:12px; border-radius:6px;" onclick="editAccount('\${acc.id}', '\${sen(acc.name)}', '\${acc.accountId}', '\${acc.apiToken}')">编辑</button>
							<button class="btn btn-secondary" style="padding:5px 10px; font-size:12px; border-radius:6px; color: var(--danger-color);" onclick="deleteAccount('\${acc.id}')">删除</button>
						</div>
					</div>
					<div style="font-size:11px; color: var(--text-muted); font-family: monospace; margin-top:8px;">Token: \${maskedToken}</div>
					\${usageHtml}
				\`;
				box.appendChild(card);
			});
		}

		function openAddAccountModal() {
			document.getElementById('account-modal-title').innerText = '添加 Cloudflare 账号';
			document.getElementById('account-id-edit').value = '';
			document.getElementById('account-name').value = '';
			document.getElementById('account-id').value = '';
			document.getElementById('account-token').value = '';
			document.getElementById('test-result-alert').style.display = 'none';
			document.getElementById('perm-wa-read').innerHTML = '';
			document.getElementById('perm-wa-edit').innerHTML = '';
			document.getElementById('perm-aa-read').innerHTML = '';
			document.getElementById('btn-save-account').disabled = true;
			document.getElementById('account-modal').classList.add('active');
		}

		function closeAccountModal() {
			document.getElementById('account-modal').classList.remove('active');
		}

		function editAccount(id, name, accountId, apiToken) {
			document.getElementById('account-modal-title').innerText = '编辑 Cloudflare 账号';
			document.getElementById('account-id-edit').value = id;
			document.getElementById('account-name').value = name;
			document.getElementById('account-id').value = accountId;
			document.getElementById('account-token').value = apiToken;
			document.getElementById('test-result-alert').style.display = 'none';
			document.getElementById('perm-wa-read').innerHTML = '';
			document.getElementById('perm-wa-edit').innerHTML = '';
			document.getElementById('perm-aa-read').innerHTML = '';
			document.getElementById('btn-save-account').disabled = true;
			document.getElementById('account-modal').classList.add('active');
		}

		function onAccountInfoChange() {
			document.getElementById('btn-save-account').disabled = true;
			document.getElementById('test-result-alert').style.display = 'none';
			document.getElementById('perm-wa-read').innerHTML = '';
			document.getElementById('perm-wa-edit').innerHTML = '';
			document.getElementById('perm-aa-read').innerHTML = '';
		}

		function updatePermissionStatus(elementId, statusObj) {
			const el = document.getElementById(elementId);
			if (!el) return;
			if (statusObj && statusObj.success) {
				el.innerHTML = '<span style="color: #10b981; font-weight: bold; margin-left: 6px;">✅ 有效</span>';
			} else {
				const err = (statusObj && statusObj.error) ? statusObj.error : '测试失败';
				el.innerHTML = '<span style="color: #ef4444; font-weight: bold; margin-left: 6px;" title="' + err.replace(/"/g, '&quot;') + '">🔴 无效</span>';
			}
		}

		function escapeHtml(str) {
			if (!str) return '';
			return String(str)
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;')
				.replace(/'/g, '&#39;');
		}

		function setAlertStyle(el, type) {
			const styles = {
				warning: { bg: 'rgba(245, 158, 11, 0.12)', color: '#f59e0b', border: 'rgba(245, 158, 11, 0.3)' },
				success: { bg: 'rgba(16, 185, 129, 0.12)', color: '#10b981', border: 'rgba(16, 185, 129, 0.3)' },
				danger:  { bg: 'rgba(239, 68, 68, 0.12)', color: '#ef4444', border: 'rgba(239, 68, 68, 0.3)' }
			};
			const s = styles[type] || styles.danger;
			el.style.backgroundColor = s.bg;
			el.style.color = s.color;
			el.style.borderColor = s.border;
		}

		const ALERT_ICONS = {
			spinner: '<svg style="width:16px;height:16px;animation:spin 1s linear infinite;flex-shrink:0;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>',
			check:    '<svg style="width:18px;height:18px;flex-shrink:0;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>',
			warning: '<svg style="width:18px;height:18px;flex-shrink:0;margin-top:1px;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/></svg>'
		};

		async function testConnection() {
			const accountId = document.getElementById('account-id').value;
			const apiToken = document.getElementById('account-token').value;
			const id = document.getElementById('account-id-edit').value;
			const alertEl = document.getElementById('test-result-alert');
			alertEl.style.display = 'block';
			setAlertStyle(alertEl, 'warning');
			alertEl.innerHTML = '<div style="display:flex;align-items:center;gap:8px;">' + ALERT_ICONS.spinner + '<span>测试中...</span></div>';

			document.getElementById('perm-wa-read').innerHTML = '';
			document.getElementById('perm-wa-edit').innerHTML = '';
			document.getElementById('perm-aa-read').innerHTML = '';
			document.getElementById('btn-save-account').disabled = true;

			try {
				const res = await apiFetch('/api/accounts/test', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ id, accountId, apiToken })
				});
				const data = await res.json();
				if (data.permissions) {
					updatePermissionStatus('perm-wa-read', data.permissions.workersAiRead);
					updatePermissionStatus('perm-wa-edit', data.permissions.workersAiEdit);
					updatePermissionStatus('perm-aa-read', data.permissions.accountAnalyticsRead);
				}
				if (data.success) {
					setAlertStyle(alertEl, 'success');
					alertEl.innerHTML = '<div style="display:flex;align-items:center;gap:8px;">' + ALERT_ICONS.check + '<span>连接成功！API 权限全部有效</span></div>';
					showToast('连接测试成功！');
					document.getElementById('btn-save-account').disabled = false;
				} else {
					setAlertStyle(alertEl, 'danger');

					// Build structured error details from permissions data
					let errorDetailHtml = '';
					if (data.permissions) {
						const permList = [
							{ key: 'workersAiRead',       label: 'Workers AI > Read' },
							{ key: 'workersAiEdit',       label: 'Workers AI > Edit' },
							{ key: 'accountAnalyticsRead', label: 'Account Analytics > Read' }
						];
						const failedItems = permList.filter(p => {
							const perm = data.permissions[p.key];
							return perm && !perm.success;
						});
						if (failedItems.length > 0) {
							errorDetailHtml = failedItems.map(p => {
								const perm = data.permissions[p.key];
								const errMsg = escapeHtml(perm.error || '未知错误');
								return '<div style="padding:3px 0;word-break:break-all;overflow-wrap:break-word;"><span style="opacity:0.6;">●</span> <strong>' + p.label + '</strong>: ' + errMsg + '</div>';
							}).join('');
						}
					}
					if (!errorDetailHtml) {
						errorDetailHtml = '<div style="padding:3px 0;word-break:break-all;overflow-wrap:break-word;">' + escapeHtml(data.error || '部分权限验证未通过') + '</div>';
					}

					alertEl.innerHTML = '<div style="display:flex;align-items:flex-start;gap:8px;">' +
						ALERT_ICONS.warning +
						'<div style="flex:1;min-width:0;">' +
						'<div style="font-weight:700;margin-bottom:4px;">连接失败 — 以下权限验证未通过：</div>' +
						'<div style="font-size:12px;opacity:0.85;line-height:1.7;">' + errorDetailHtml + '</div>' +
						'</div>' +
						'</div>';

					showToast('测试连接失败，请检查 Token 权限', 'error');
					document.getElementById('btn-save-account').disabled = true;
				}
			} catch (e) {
				setAlertStyle(alertEl, 'danger');
				alertEl.innerHTML = '<div style="display:flex;align-items:center;gap:8px;">' + ALERT_ICONS.warning + '<span>连接超时或异常，请重试</span></div>';
				showToast('连接异常，请重试', 'error');
				document.getElementById('btn-save-account').disabled = true;
			}
		}

		async function saveAccount() {
			const id = document.getElementById('account-id-edit').value;
			const name = document.getElementById('account-name').value;
			const accountId = document.getElementById('account-id').value;
			const apiToken = document.getElementById('account-token').value;
			if (!accountId || !apiToken) {
				showToast('Account ID 和 API Token 均为必填项！', 'warning');
				return;
			}
			const res = await apiFetch('/api/accounts', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id, name, accountId, apiToken })
			});
			if (res.ok) {
				closeAccountModal();
				loadAccounts();
				showToast('账号保存成功！');
			} else {
				showToast('保存失败！', 'error');
			}
		}

		async function deleteAccount(id) {
			if (!confirm('确定要删除这个 Cloudflare 账号吗？')) return;
			const res = await apiFetch('/api/accounts', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id })
			});
			if (res.ok) {
				loadAccounts();
				showToast('账号已成功删除');
			} else {
				showToast('删除失败', 'error');
			}
		}

		async function loadKeys() {
			try {
				const res = await apiFetch('/api/keys');
				const keys = await res.json();
				const tbody = document.getElementById('keys-table-body');
				tbody.innerHTML = '';
				if (keys.length === 0) {
					tbody.innerHTML = '<tr><td colspan="5" style="text-align:center; color: var(--text-muted); padding: 30px;">暂无配置的 API 密钥</td></tr>';
					document.getElementById('no-key-warning').classList.remove('hidden');
					return;
				} else {
					document.getElementById('no-key-warning').classList.add('hidden');
				}
				keys.forEach(k => {
					const tr = document.createElement('tr');
					const dateStr = new Date(k.createdAt).toLocaleString();
					const groupLabels = { all: '<span class="badge badge-info">全部</span>', free: '<span class="badge badge-success">仅免费</span>', paid: '<span class="badge badge-warning">仅收费</span>' };
					const groupHtml = groupLabels[k.group] || groupLabels.all;
					tr.innerHTML = \`
						<td><strong style="font-weight:600;">\${sen(k.name)}</strong></td>
						<td>
							<div style="display:flex; align-items:center; gap:8px;">
								<code id="key-val-\${k.id}">\${k.key.length > 6 ? k.key.substring(0, 5) + '...' + k.key.substring(k.key.length - 1) : k.key.substring(0, Math.min(3, k.key.length)) + '...'}</code>
								<button class="btn btn-secondary" style="padding:4px 8px; font-size:11px; border-radius:6px;" onclick="copyKeyText('\${k.key}')">复制</button>
							</div>
						</td>
						<td>\${groupHtml}</td>
						<td>\${dateStr}</td>
						<td>
							<button class="btn btn-secondary" style="padding:6px 12px; font-size:12px; border-radius:6px; color: var(--danger-color);" onclick="deleteKey('\${k.id}')">删除</button>
						</td>
					\`;
					tbody.appendChild(tr);
				});
			} catch (e) {
				console.error(e);
			}
		}

		function sen(str) {
			return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
		}

		function copyKeyText(val) {
			const input = document.createElement('input');
			input.value = val;
			document.body.appendChild(input);
			input.select();
			document.execCommand('copy');
			document.body.removeChild(input);
			showToast('API Key 复制成功！');
		}

		function openAddKeyModal() {
			document.getElementById('key-name').value = '';
			document.getElementById('key-val').value = '';
			const grp = document.getElementById('key-group');
			if (grp) grp.value = 'all';
			document.getElementById('key-modal-title').innerText = '生成新 API 密钥';
			document.getElementById('key-modal-form').classList.remove('hidden');
			document.getElementById('key-modal-success').classList.add('hidden');
			document.getElementById('key-modal').classList.add('active');
		}

		function closeKeyModal() {
			document.getElementById('key-modal').classList.remove('active');
		}

		async function saveKey() {
			const name = document.getElementById('key-name').value;
			const key = document.getElementById('key-val').value;
			const grpEl = document.getElementById('key-group');
			const group = grpEl ? grpEl.value : 'all';
			if (!name) {
				showToast('请输入描述名称！', 'warning');
				return;
			}
			const res = await apiFetch('/api/keys', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ name, key, group })
			});
			if (res.ok) {
				const data = await res.json();
				loadKeys();
				document.getElementById('key-modal-title').innerText = '密钥已生成';
				document.getElementById('key-modal-form').classList.add('hidden');
				document.getElementById('key-modal-success').classList.remove('hidden');
				document.getElementById('generated-key-val').value = data.key;
			} else {
				showToast('保存密钥失败！', 'error');
			}
		}

		function copyGeneratedKey() {
			const el = document.getElementById('generated-key-val');
			el.select();
			document.execCommand('copy');
			showToast('API Key 复制成功！');
		}

		async function deleteKey(id) {
			if (!confirm('确定要删除这个 API 密钥吗？')) return;
			const res = await apiFetch('/api/keys', {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ id })
			});
			if (res.ok) {
				loadKeys();
				showToast('密钥已成功删除');
			} else {
				showToast('删除密钥失败', 'error');
			}
		}

		function copyModelId(val) {
			const input = document.createElement('input');
			input.value = val;
			document.body.appendChild(input);
			input.select();
			document.execCommand('copy');
			document.body.removeChild(input);
			showToast(\`已复制模型: \${val}\`);
		}

		async function loadSettings() { return loadModelPage(); }
		async function __legacyLoadSettings() {
			// 载入模型目录（缓存）
			loadCatalog();
			try {
				const res = await apiFetch('/api/settings');
				const data = await res.json();
				customMappings = data.customModelMap || {};
				const tbody = document.getElementById('mappings-table-body');
				tbody.innerHTML = '';
				Object.keys(customMappings).forEach(source => {
					const target = customMappings[source];
					const isPreset = Object.prototype.hasOwnProperty.call(defaultMappings, source) && defaultMappings[source] === target;
					const typeText = isPreset ? '<span class="badge badge-success">预设映射</span>' : '<span class="badge badge-warning">自定义</span>';
					const tr = document.createElement('tr');
					tr.innerHTML = \`
						<td><code style="cursor: pointer;" title="点击复制" onclick="copyModelId('\${source}')">\${source}</code></td>
						<td><code style="cursor: pointer;" title="点击复制" onclick="copyModelId('\${target}')">\${target}</code></td>
						<td>\${typeText}</td>
						<td>
							<button class="btn btn-secondary" style="padding:6px 12px; font-size:12px; border-radius:6px; color: var(--danger-color);" onclick="deleteMapping('\${source}')">删除</button>
						</td>
					\`;
					tbody.appendChild(tr);
				});
			} catch(e) {
				console.error(e);
			}
		}

		async function addMapping() {
			const source = document.getElementById('map-source').value.trim();
			const target = document.getElementById('map-target').value.trim();
			if (!source || !target) {
				showToast('请求模型名称和目标模型路径不能为空！', 'warning');
				return;
			}
			customMappings[source] = target;
			const res = await apiFetch('/api/settings', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ customModelMap: customMappings })
			});
			if (res.ok) {
				document.getElementById('map-source').value = '';
				document.getElementById('map-target').value = '';
				loadSettings();
				showToast('映射配置成功！');
			} else {
				showToast('添加映射失败！', 'error');
			}
		}

		async function restorePresetMappings() {
			const mergedMappings = { ...customMappings, ...defaultMappings };
			const hasChanges = Object.keys(defaultMappings).some(source => customMappings[source] !== defaultMappings[source]);

			if (!hasChanges && Object.keys(defaultMappings).every(source => customMappings[source] === defaultMappings[source])) {
				showToast('预设映射已存在，无需重复添加');
				return;
			}

			const res = await apiFetch('/api/settings', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ customModelMap: mergedMappings })
			});
			if (res.ok) {
				customMappings = mergedMappings;
				loadSettings();
				showToast('已恢复预设映射');
			} else {
				showToast('恢复预设映射失败！', 'error');
			}
		}

		async function deleteMapping(source) {
			if (!confirm('确定要删除此映射吗？')) return;
			delete customMappings[source];
			const res = await apiFetch('/api/settings', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ customModelMap: customMappings })
			});
			if (res.ok) {
				loadSettings();
				showToast('已删除映射');
			} else {
				showToast('删除映射失败！', 'error');
			}
		}

		// ===== Cloudflare 模型目录（自动获取 + 免费/收费分组） =====
		let modelCatalog = { models: [] };

		function catalogUpdatedText(ts) {
			const el = document.getElementById('catalog-updated');
			if (!el) return;
			if (!ts) { el.innerText = '尚未同步'; return; }
			const d = new Date(ts);
			el.innerText = '同步于 ' + d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0') + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0');
		}

		async function loadCatalog() {
			try {
				const res = await apiFetch('/api/models/available');
				const data = await res.json();
				modelCatalog = data.catalog || { models: [] };
				catalogUpdatedText(data.updatedAt);
				renderCatalog();
			} catch (e) { console.error(e); }
		}

		async function syncModels() {
			const btn = document.getElementById('btn-sync-models');
			const orig = btn ? btn.innerHTML : '';
			if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 同步中...'; }
			try {
				const res = await apiFetch('/api/models/available', { method: 'POST' });
				const data = await res.json();
				if (res.ok && data.success) {
					modelCatalog = data.catalog;
					catalogUpdatedText(data.updatedAt);
					await loadModelPage();
					showToast('模型同步成功：自动映射 ' + (data.autoMapped || 0) + ' 个，免费 ' + data.catalog.freeCount + ' / 收费 ' + data.catalog.paidCount);
				} else {
					showToast(data.error || '同步失败', 'error');
				}
			} catch (e) {
				showToast('同步异常：' + e.message, 'error');
			} finally {
				if (btn) { btn.disabled = false; btn.innerHTML = orig; }
			}
		}

		function renderCatalog() { return renderVendors(); }
		function __legacyRenderCatalog() {
			const box = document.getElementById('catalog-list');
			if (!box) return;
			const models = modelCatalog.models || [];
			document.getElementById('catalog-free-count').innerText = models.filter(m => !m.paid).length;
			document.getElementById('catalog-paid-count').innerText = models.filter(m => m.paid).length;
			document.getElementById('catalog-total-count').innerText = models.length;

			if (models.length === 0) {
				box.innerHTML = '<div style="color: var(--text-muted); font-size:13px; padding:16px; grid-column:1/-1;">尚未同步模型目录，点击右上角「从 Cloudflare 同步模型」。</div>';
				return;
			}

			const kw = (document.getElementById('catalog-filter').value || '').toLowerCase();
			const grpFilter = document.getElementById('catalog-group-filter').value || 'all';
			const filtered = models.filter(m => {
				if (grpFilter === 'free' && m.paid) return false;
				if (grpFilter === 'paid' && !m.paid) return false;
				if (kw && !(m.name.toLowerCase().includes(kw) || (m.task || '').toLowerCase().includes(kw))) return false;
				return true;
			});

			box.innerHTML = '';
			if (filtered.length === 0) {
				box.innerHTML = '<div style="color: var(--text-muted); font-size:13px; padding:16px; grid-column:1/-1;">无匹配模型。</div>';
				return;
			}
			filtered.forEach(m => {
				const badge = m.paid ? '<span class="badge badge-warning">收费</span>' : '<span class="badge badge-success">免费</span>';
				const betaBadge = m.beta ? '<span class="badge badge-info" style="margin-left:4px;">beta</span>' : '';
				const ctx = m.contextWindow ? ('ctx ' + (m.contextWindow >= 1000 ? (m.contextWindow/1000) + 'k' : m.contextWindow)) : '';
				const card = document.createElement('div');
				card.style.cssText = 'background: var(--section-item-bg); border:1px solid var(--border-color); border-radius:10px; padding:12px 14px;';
				card.innerHTML = \`
					<div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
						<code style="font-size:12px; cursor:pointer; word-break:break-all;" title="点击复制" onclick="copyModelId('\${m.name}')">\${sen(m.name)}</code>
						<span style="flex-shrink:0;">\${badge}\${betaBadge}</span>
					</div>
					<div style="font-size:11px; color:var(--text-muted); margin-top:6px; display:flex; justify-content:space-between;">
						<span>\${sen(m.task || '')}</span>
						<span>\${ctx}</span>
					</div>
				\`;
				box.appendChild(card);
			});
		}
	</script>
</body>
</html>`;

	return new Response(html, {
		headers: { 'Content-Type': 'text/html; charset=utf-8' }
	});
}

// 3. KV 未绑定时的报错页面
function handleKVError(request) {
	const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>KV 绑定异常 - NeuronGate</title>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Outfit:wght@500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
	<style>
		:root {
			--bg-color: #0b0f19;
			--card-bg: rgba(30, 41, 59, 0.45);
			--border-color: rgba(239, 68, 68, 0.2);
			--text-main: #f8fafc;
			--text-muted: #94a3b8;
			--primary-gradient: linear-gradient(135deg, #ef4444 0%, #ec4899 100%);
			--accent-color: #ec4899;
			--glass-blur: 20px;
			--card-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
			--orb-1-color: rgba(239, 68, 68, 0.08);
			--orb-2-color: rgba(236, 72, 153, 0.06);
		}

		* {
			box-sizing: border-box;
			margin: 0;
			padding: 0;
		}

		body {
			font-family: 'Inter', sans-serif;
			background-color: var(--bg-color);
			color: var(--text-main);
			min-height: 100vh;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 20px;
			position: relative;
			overflow: hidden;
		}

		/* Dynamic Background Orbs */
		.bg-orbs-container {
			position: fixed;
			top: 0;
			left: 0;
			width: 100%;
			height: 100%;
			z-index: -1;
			overflow: hidden;
			pointer-events: none;
		}

		.bg-orb {
			position: absolute;
			border-radius: 50%;
			filter: blur(100px);
			animation: float 25s infinite alternate ease-in-out;
		}

		.bg-orb-1 {
			top: -10%;
			left: -10%;
			width: 50vw;
			height: 50vw;
			background: var(--orb-1-color);
		}

		.bg-orb-2 {
			bottom: -10%;
			right: -10%;
			width: 60vw;
			height: 60vw;
			background: var(--orb-2-color);
		}

		@keyframes float {
			0% { transform: translate(0, 0) scale(1); }
			100% { transform: translate(5%, 5%) scale(1.05); }
		}

		.error-card {
			background-color: var(--card-bg);
			border: 1px solid var(--border-color);
			border-radius: 20px;
			padding: 40px;
			max-width: 500px;
			width: 100%;
			text-align: center;
			box-shadow: var(--card-shadow);
			backdrop-filter: blur(var(--glass-blur));
			-webkit-backdrop-filter: blur(var(--glass-blur));
			z-index: 10;
		}

		h1 {
			font-family: 'Outfit', sans-serif;
			font-size: 24px;
			color: #ef4444;
			margin-bottom: 16px;
			font-weight: 600;
		}

		p {
			color: var(--text-muted);
			font-size: 15px;
			line-height: 1.6;
			margin-bottom: 24px;
		}

		.code-block {
			background-color: rgba(0, 0, 0, 0.25);
			padding: 20px;
			border-radius: 12px;
			font-family: monospace;
			font-size: 13px;
			color: #e9d5ff;
			text-align: left;
			margin-bottom: 26px;
			border: 1px solid rgba(255, 255, 255, 0.05);
			line-height: 1.8;
		}

		.btn {
			display: inline-block;
			background: var(--primary-gradient);
			color: white;
			text-decoration: none;
			padding: 12px 28px;
			border-radius: 10px;
			font-weight: 600;
			font-size: 14px;
			transition: all 0.3s;
			box-shadow: 0 4px 14px rgba(239, 68, 68, 0.2);
		}

		.btn:hover {
			transform: translateY(-2px);
			box-shadow: 0 6px 20px rgba(239, 68, 68, 0.35);
			opacity: 0.95;
		}
${NEURON_THEME}
	</style>
</head>
<body>
	<div class="bg-orbs-container">
		<div class="bg-orb bg-orb-1"></div>
		<div class="bg-orb bg-orb-2"></div>
	</div>
	<div class="error-card">
		<div style="font-size: 48px; margin-bottom: 16px;">⚠️</div>
		<h1>KV 命名空间未绑定</h1>
		<p>系统检测到您未在 Cloudflare 平台中为该项目绑定 KV 命名空间，或者绑定的变量名称不为 <strong>KV</strong>。这会导致数据无法保存，系统无法正常运行。</p>
		
		<div class="code-block">
			<strong>解决方案：</strong><br>
			1. 进入您的 Cloudflare Workers/Pages 仪表盘。<br>
			2. 导航至 Settings -> Functions (或 Settings -> Variables) -> KV namespace bindings。<br>
			3. 添加绑定，将【变量名称 (Variable name)】设置为: <strong>KV</strong><br>
			4. 保存并重新部署项目即可。
		</div>
		
		<a href="https://developers.cloudflare.com/kv/learning/kv-bindings/" target="_blank" class="btn">查看官方绑定教程</a>
	</div>
</body>
</html>`;

	const url = new URL(request.url);
	if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/')) {
		return new Response(JSON.stringify({
			error: {
				message: "Cloudflare KV namespace binding 'KV' is missing. Please bind a KV namespace to 'KV' in your Worker/Pages settings.",
				type: "server_error"
			}
		}), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
	}

	return new Response(html, {
		headers: { 'Content-Type': 'text/html; charset=utf-8' }
	});
}

// 4. Password Error UI Page
function handlePasswordError(request) {
	const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>管理员密码未配置 - NeuronGate</title>
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=Outfit:wght@500;600;700&family=Space+Grotesk:wght@500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
	<style>
		:root {
			--bg-color: #0b0f19;
			--card-bg: rgba(30, 41, 59, 0.45);
			--border-color: rgba(239, 68, 68, 0.2);
			--text-main: #f8fafc;
			--text-muted: #94a3b8;
			--primary-gradient: linear-gradient(135deg, #ef4444 0%, #ec4899 100%);
			--accent-color: #ec4899;
			--glass-blur: 20px;
			--card-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
			--orb-1-color: rgba(239, 68, 68, 0.08);
			--orb-2-color: rgba(236, 72, 153, 0.06);
		}

		* {
			box-sizing: border-box;
			margin: 0;
			padding: 0;
		}

		body {
			font-family: 'Inter', sans-serif;
			background-color: var(--bg-color);
			color: var(--text-main);
			min-height: 100vh;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 20px;
			position: relative;
			overflow: hidden;
		}

		/* Dynamic Background Orbs */
		.bg-orbs-container {
			position: fixed;
			top: 0;
			left: 0;
			width: 100%;
			height: 100%;
			z-index: -1;
			overflow: hidden;
			pointer-events: none;
		}

		.bg-orb {
			position: absolute;
			border-radius: 50%;
			filter: blur(100px);
			animation: float 25s infinite alternate ease-in-out;
		}

		.bg-orb-1 {
			top: -10%;
			left: -10%;
			width: 50vw;
			height: 50vw;
			background: var(--orb-1-color);
		}

		.bg-orb-2 {
			bottom: -10%;
			right: -10%;
			width: 60vw;
			height: 60vw;
			background: var(--orb-2-color);
		}

		@keyframes float {
			0% { transform: translate(0, 0) scale(1); }
			100% { transform: translate(5%, 5%) scale(1.05); }
		}

		.error-card {
			background-color: var(--card-bg);
			border: 1px solid var(--border-color);
			border-radius: 20px;
			padding: 40px;
			max-width: 500px;
			width: 100%;
			text-align: center;
			box-shadow: var(--card-shadow);
			backdrop-filter: blur(var(--glass-blur));
			-webkit-backdrop-filter: blur(var(--glass-blur));
			z-index: 10;
		}

		h1 {
			font-family: 'Outfit', sans-serif;
			font-size: 24px;
			color: #ef4444;
			margin-bottom: 16px;
			font-weight: 600;
		}

		p {
			color: var(--text-muted);
			font-size: 15px;
			line-height: 1.6;
			margin-bottom: 24px;
		}

		.code-block {
			background-color: rgba(0, 0, 0, 0.25);
			padding: 20px;
			border-radius: 12px;
			font-family: monospace;
			font-size: 13px;
			color: #e9d5ff;
			text-align: left;
			margin-bottom: 26px;
			border: 1px solid rgba(255, 255, 255, 0.05);
			line-height: 1.8;
		}
${NEURON_THEME}
	</style>
</head>
<body>
	<div class="bg-orbs-container">
		<div class="bg-orb bg-orb-1"></div>
		<div class="bg-orb bg-orb-2"></div>
	</div>
	<div class="error-card">
		<div style="font-size: 48px; margin-bottom: 16px;">🔑</div>
		<h1>管理员密码未配置</h1>
		<p>系统检测到您未在 Cloudflare 平台中为该项目配置 <strong>ADMIN_PASSWORD</strong> 环境变量。为了您的接口 and 管理后台安全，系统已拦截所有访问，直到密码配置完成。</p>
		
		<div class="code-block">
			<strong>解决方案：</strong><br>
			1. 进入您的 Cloudflare Workers/Pages 仪表盘。<br>
			2. 导航至 Settings -> Variables (或 Settings -> Environment Variables)。<br>
			3. 点击【Add variable】，将【Variable name】设置为: <strong>ADMIN_PASSWORD</strong><br>
			4. 输入您的管理员登录密码作为其值，保存并部署即可。
		</div>
	</div>
</body>
</html>`;

	const url = new URL(request.url);
	if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/api/')) {
		return new Response(JSON.stringify({
			error: {
				message: "ADMIN_PASSWORD environment variable is missing. Please add the ADMIN_PASSWORD variable to your Worker/Pages settings.",
				type: "server_error"
			}
		}), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key' } });
	}

	return new Response(html, {
		headers: { 'Content-Type': 'text/html; charset=utf-8' }
	});
}
