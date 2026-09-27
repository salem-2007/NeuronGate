/**
 * WorkersAI2API - Node/Docker 运行时适配层
 *
 * 原项目是 Cloudflare Worker（export default { fetch(request, env, ctx) }），
 * 只依赖 Web 标准 API + 一个 KV 绑定。这里用 Node 内置 http 服务把它跑起来：
 *   - 把 Node 的 req/res 桥接成标准 Request/Response
 *   - 用一个「文件落盘」的 KV 垫片替代 Cloudflare KV（只需 get/put/delete）
 *   - env 直接透传 process.env（ADMIN_PASSWORD / CUSTOM_MODEL_MAP 等）
 *
 * 需要 Node 18+（推荐 20/22），全局已有 fetch / Request / Response / crypto / ReadableStream。
 */

import http from 'node:http';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import workerModule from './_worker.js';

const worker = workerModule?.default || workerModule;

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const KV_PATH = process.env.KV_PATH || '/data/kv.json';

// ----------------------------------------------------
// 文件落盘 KV 垫片
// 原代码只用到：KV.get(key) / KV.put(key, value) / KV.delete(key)
// value 都是字符串（JSON.stringify 后的结果）。这里用一个 {key: string} 的
// JSON 文件持久化，挂到 volume 上就能跨重启保留配置。
// ----------------------------------------------------
class FileKV {
	constructor(filePath) {
		this.filePath = filePath;
		this.store = {};
		this._writeChain = Promise.resolve();
	}

	async init() {
		try {
			const raw = await fs.readFile(this.filePath, 'utf8');
			this.store = JSON.parse(raw) || {};
			console.log(`[KV] 已从 ${this.filePath} 载入 ${Object.keys(this.store).length} 个键`);
		} catch (e) {
			if (e.code === 'ENOENT') {
				await fs.mkdir(path.dirname(this.filePath), { recursive: true });
				this.store = {};
				console.log(`[KV] ${this.filePath} 不存在，已初始化空存储`);
			} else {
				console.error(`[KV] 载入失败，使用空存储：${e.message}`);
				this.store = {};
			}
		}
	}

	// 原子写：写临时文件后 rename，避免写一半损坏
	async _flush() {
		const tmp = `${this.filePath}.tmp`;
		const data = JSON.stringify(this.store);
		this._writeChain = this._writeChain.then(async () => {
			await fs.writeFile(tmp, data, 'utf8');
			await fs.rename(tmp, this.filePath);
		}).catch(err => console.error(`[KV] 写盘失败：${err.message}`));
		return this._writeChain;
	}

	// Cloudflare KV.get 支持 (key, {type}) —— 原代码只用字符串形式，这里够用
	async get(key /*, options */) {
		const v = this.store[key];
		return v === undefined ? null : v;
	}

	async put(key, value /*, options */) {
		this.store[key] = typeof value === 'string' ? value : String(value);
		await this._flush();
	}

	async delete(key) {
		delete this.store[key];
		await this._flush();
	}

	// 占位，原代码未使用
	async list() {
		return { keys: Object.keys(this.store).map(name => ({ name })), list_complete: true };
	}
}

// ----------------------------------------------------
// Node IncomingMessage -> 标准 Request
// ----------------------------------------------------
function nodeReqToRequest(req) {
	const host = req.headers.host || `localhost:${PORT}`;
	const url = `http://${host}${req.url}`;

	const headers = new Headers();
	for (const [k, v] of Object.entries(req.headers)) {
		if (v === undefined) continue;
		if (Array.isArray(v)) {
			for (const item of v) headers.append(k, item);
		} else {
			headers.set(k, v);
		}
	}

	const init = { method: req.method, headers };

	// GET/HEAD 不能带 body
	if (req.method !== 'GET' && req.method !== 'HEAD') {
		return new Promise((resolve, reject) => {
			const chunks = [];
			req.on('data', c => chunks.push(c));
			req.on('end', () => {
				const body = Buffer.concat(chunks);
				if (body.length > 0) init.body = body;
				resolve(new Request(url, init));
			});
			req.on('error', reject);
		});
	}

	return Promise.resolve(new Request(url, init));
}

// ----------------------------------------------------
// 标准 Response -> Node ServerResponse
// ----------------------------------------------------
async function writeResponse(response, res) {
	const headers = {};
	response.headers.forEach((value, key) => {
		// set-cookie 单独处理，避免多值被逗号合并
		if (key.toLowerCase() === 'set-cookie') return;
		headers[key] = value;
	});

	// 正确还原 set-cookie（undici 提供 getSetCookie）
	let setCookies = [];
	if (typeof response.headers.getSetCookie === 'function') {
		setCookies = response.headers.getSetCookie();
	} else {
		const sc = response.headers.get('set-cookie');
		if (sc) setCookies = [sc];
	}
	if (setCookies.length > 0) headers['set-cookie'] = setCookies;

	res.writeHead(response.status, headers);

	if (!response.body) {
		res.end();
		return;
	}

	// 把 Web ReadableStream 转成 Node 流并回压式写出（SSE 流式也走这里）
	const nodeStream = Readable.fromWeb(response.body);
	nodeStream.pipe(res);
	nodeStream.on('error', err => {
		console.error(`[HTTP] 响应流错误：${err.message}`);
		res.destroy(err);
	});
}

// ----------------------------------------------------
// 启动
// ----------------------------------------------------
async function main() {
	if (!process.env.ADMIN_PASSWORD) {
		console.warn('[WARN] 未设置 ADMIN_PASSWORD 环境变量，管理面板将拒绝访问。请通过 -e ADMIN_PASSWORD=... 设置。');
	}

	const kv = new FileKV(KV_PATH);
	await kv.init();

	// env：透传所有环境变量，并注入 KV 绑定
	const env = { ...process.env, KV: kv };
	// ctx 桩：原代码未真正使用 waitUntil
	const ctx = { waitUntil: (p) => { if (p && typeof p.catch === 'function') p.catch(() => {}); }, passThroughOnException: () => {} };

	const server = http.createServer(async (req, res) => {
		try {
			const request = await nodeReqToRequest(req);
			const response = await worker.fetch(request, env, ctx);
			await writeResponse(response, res);
		} catch (err) {
			console.error(`[HTTP] 处理请求出错：${err.stack || err.message}`);
			if (!res.headersSent) {
				res.writeHead(500, { 'Content-Type': 'application/json' });
			}
			res.end(JSON.stringify({ error: { message: 'Internal Server Error', type: 'server_error' } }));
		}
	});

	server.listen(PORT, HOST, () => {
		console.log(`WorkersAI2API 已启动: http://${HOST}:${PORT}`);
		console.log(`KV 持久化文件: ${KV_PATH}`);
	});

	const shutdown = (sig) => {
		console.log(`\n收到 ${sig}，正在关闭...`);
		server.close(() => process.exit(0));
		setTimeout(() => process.exit(0), 5000).unref();
	};
	process.on('SIGTERM', () => shutdown('SIGTERM'));
	process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch(err => {
	console.error('启动失败：', err);
	process.exit(1);
});
