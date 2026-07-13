import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

interface Env {
	MyMCP: DurableObjectNamespace<MyMCP>;
}

type Bindings = Env & {
	BIYING_LICENCE: string;
	MCP_ACCESS_KEY?: string;
	ACTION_API_KEY?: string;
};

type CacheEntry = { expiresAt: number; data: unknown };

type StockPackInput = {
	code: string;
	market: "SH" | "SZ";
	adjust: "n" | "f" | "b" | "fr" | "br";
	intradayBars: number;
	dailyBars: number;
	weeklyBars: number;
};

const API_BASE = "https://api.biyingapi.com";
const responseCache = new Map<string, CacheEntry>();

const OPENAPI_SCHEMA = {
	openapi: "3.1.0",
	info: {
		title: "A股波段投资数据接口",
		description: "为个人A股和场内ETF波段分析提供实时行情、K线、行业概念和财务数据。",
		version: "1.0.0",
	},
	servers: [{ url: "https://a-share-investor-mcp.zwwang1995.workers.dev" }],
	paths: {
		"/api/stock-analysis": {
			get: {
				operationId: "getStockAnalysisPack",
				summary: "获取A股波段分析数据包",
				description:
					"一次返回实时行情、5分钟K线、日K、周K、所属行业概念和近四季度财务指标。分析沪深A股时优先使用。",
				parameters: [
					{
						name: "code",
						in: "query",
						required: true,
						description: "6位A股代码，例如603916",
						schema: { type: "string", pattern: "^[0-9]{6}$" },
					},
					{
						name: "market",
						in: "query",
						required: true,
						description: "交易所，SH为上交所，SZ为深交所",
						schema: { type: "string", enum: ["SH", "SZ"] },
					},
					{
						name: "adjust",
						in: "query",
						required: false,
						description: "复权方式，默认前复权f",
						schema: {
							type: "string",
							enum: ["n", "f", "b", "fr", "br"],
							default: "f",
						},
					},
				],
				responses: {
					"200": {
						description: "股票分析数据包",
						content: {
							"application/json": {
								schema: { type: "object", additionalProperties: true },
							},
						},
					},
					"400": { description: "参数错误" },
					"502": { description: "上游数据接口错误" },
				},
			},
		},
		"/api/etf-quote": {
			get: {
				operationId: "getEtfQuote",
				summary: "获取场内ETF实时行情",
				description: "返回沪深场内ETF实时行情。毕盈文档未明确提供ETF历史K线。",
				parameters: [
					{
						name: "code",
						in: "query",
						required: true,
						description: "6位ETF代码，例如510300或159915",
						schema: { type: "string", pattern: "^[0-9]{6}$" },
					},
				],
				responses: {
					"200": {
						description: "ETF实时行情",
						content: {
							"application/json": {
								schema: { type: "object", additionalProperties: true },
							},
						},
					},
					"400": { description: "参数错误" },
					"502": { description: "上游数据接口错误" },
				},
			},
		},
		"/api/index-bars": {
			get: {
				operationId: "getIndexBars",
				summary: "获取沪深指数K线",
				description: "用于判断大盘环境以及比较个股相对强弱。",
				parameters: [
					{
						name: "symbol",
						in: "query",
						required: true,
						description: "指数代码及市场，例如000001.SH或399001.SZ",
						schema: { type: "string", pattern: "^[0-9]{6}\\.(SH|SZ)$" },
					},
					{
						name: "interval",
						in: "query",
						required: false,
						description: "K线周期，默认日线d",
						schema: {
							type: "string",
							enum: ["5", "15", "30", "60", "d", "w", "m"],
							default: "d",
						},
					},
					{
						name: "limit",
						in: "query",
						required: false,
						description: "返回K线数量，10至250，默认120",
						schema: { type: "integer", minimum: 10, maximum: 250, default: 120 },
					},
				],
				responses: {
					"200": {
						description: "指数K线",
						content: {
							"application/json": {
								schema: { type: "object", additionalProperties: true },
							},
						},
					},
					"400": { description: "参数错误" },
					"502": { description: "上游数据接口错误" },
				},
			},
		},
	},
} as const;

function corsHeaders(contentType = "application/json; charset=utf-8") {
	return {
		"Content-Type": contentType,
		"Access-Control-Allow-Origin": "*",
		"Access-Control-Allow-Methods": "GET, OPTIONS",
		"Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
	};
}

function jsonResponse(data: unknown, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: corsHeaders(),
	});
}

function jsonResult(data: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
}

function errorResult(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return {
		isError: true,
		content: [{ type: "text" as const, text: `数据请求失败：${message}` }],
	};
}

function cleanError(error: unknown) {
	return error instanceof Error ? error.message : "未知错误";
}

async function biyingGet(
	env: Bindings,
	path: string,
	params: Record<string, string | number | undefined> = {},
	ttlSeconds = 60,
): Promise<unknown> {
	const licence = env.BIYING_LICENCE;
	if (!licence) throw new Error("Cloudflare 中缺少 BIYING_LICENCE Secret");

	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== "") query.set(key, String(value));
	}
	query.sort();

	const cacheKey = `${path}?${query.toString()}`;
	const cached = responseCache.get(cacheKey);
	if (cached && cached.expiresAt > Date.now()) return cached.data;

	const url = new URL(`${API_BASE}/${path}/${encodeURIComponent(licence)}`);
	url.search = query.toString();
	const response = await fetch(url, { headers: { Accept: "application/json" } });
	const raw = await response.text();

	if (!response.ok) {
		const safeMessage = raw.replaceAll(licence, "***").slice(0, 200).trim();
		throw new Error(
			`毕盈API返回 HTTP ${response.status}${safeMessage ? `：${safeMessage}` : ""}`,
		);
	}

	let data: unknown;
	try {
		data = JSON.parse(raw);
	} catch {
		throw new Error(`毕盈API未返回有效JSON：${raw.slice(0, 120)}`);
	}

	responseCache.set(cacheKey, {
		expiresAt: Date.now() + ttlSeconds * 1000,
		data,
	});
	return data;
}

async function getStockAnalysisPack(env: Bindings, input: StockPackInput) {
	const symbol = `${input.code}.${input.market}`;
	const names = [
		"quote",
		"intraday5m",
		"daily",
		"weekly",
		"classifications",
		"financials",
	] as const;
	const settled = await Promise.allSettled([
			biyingGet(env, `hsrl/ssjy/${input.code}`, {}, 45),
			biyingGet(
				env,
				`hsstock/history/${symbol}/5/n`,
				{ lt: input.intradayBars },
				240,
			),
			biyingGet(
				env,
				`hsstock/history/${symbol}/d/${input.adjust}`,
				{ lt: input.dailyBars },
				900,
			),
			biyingGet(
				env,
				`hsstock/history/${symbol}/w/${input.adjust}`,
				{ lt: input.weeklyBars },
				3600,
			),
			biyingGet(env, `hszg/zg/${input.code}`, {}, 86400),
			biyingGet(env, `hscp/cwzb/${input.code}`, {}, 86400),
		]);

	const values: Record<(typeof names)[number], unknown | null> = {
		quote: null,
		intraday5m: null,
		daily: null,
		weekly: null,
		classifications: null,
		financials: null,
	};
	const errors: Partial<Record<(typeof names)[number], string>> = {};

	settled.forEach((result, index) => {
		const name = names[index];
		if (result.status === "fulfilled") {
			values[name] = result.value;
		} else {
			errors[name] = cleanError(result.reason);
		}
	});

	const successfulItems = names.filter((name) => values[name] !== null);
	const failedItems = names.filter((name) => values[name] === null);

	return {
		source: "毕盈API",
		fetchedAt: new Date().toISOString(),
		symbol,
		adjust: input.adjust,
		dataQuality: {
			status:
				failedItems.length === 0
					? "complete"
					: successfulItems.length === 0
						? "failed"
						: "partial",
			successfulItems,
			failedItems,
			errors,
		},
		quote: values.quote,
		bars: {
			intraday5m: values.intraday5m,
			daily: values.daily,
			weekly: values.weekly,
		},
		classifications: values.classifications,
		financials: values.financials,
	};
}

async function getEtfQuote(env: Bindings, code: string) {
	const quote = await biyingGet(env, `fd/real/time/${code}`, {}, 45);
	return {
		source: "毕盈API",
		fetchedAt: new Date().toISOString(),
		code,
		quote,
	};
}

async function getIndexBars(
	env: Bindings,
	symbol: string,
	interval: "5" | "15" | "30" | "60" | "d" | "w" | "m",
	limit: number,
) {
	const end = new Date();
	const start = new Date(end);
	const calendarDays =
		interval === "m"
			? limit * 35
			: interval === "w"
				? limit * 8
				: interval === "d"
					? Math.ceil(limit * 1.8)
					: Math.max(10, Math.ceil(limit / 48) * 3);
	start.setUTCDate(start.getUTCDate() - calendarDays);
	const formatDate = (date: Date) =>
		`${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;

	const bars = await biyingGet(
		env,
		`hsindex/history/${symbol}/${interval}`,
		{ st: formatDate(start), et: formatDate(end) },
		interval === "d" || interval === "w" || interval === "m" ? 900 : 240,
	);
	const limitedBars = Array.isArray(bars) ? bars.slice(-limit) : bars;
	return {
		source: "毕盈API",
		fetchedAt: new Date().toISOString(),
		symbol,
		interval,
		bars: limitedBars,
	};
}

function numberParam(
	value: string | null,
	fallback: number,
	minimum: number,
	maximum: number,
) {
	if (value === null || value === "") return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
		throw new Error(`数值参数必须为${minimum}至${maximum}之间的整数`);
	}
	return parsed;
}

function checkActionAuth(request: Request, env: Bindings) {
	if (!env.ACTION_API_KEY) return true;
	const authorization = request.headers.get("Authorization");
	const customKey = request.headers.get("X-API-Key");
	return authorization === `Bearer ${env.ACTION_API_KEY}` || customKey === env.ACTION_API_KEY;
}

async function handleRestApi(request: Request, env: Bindings, url: URL) {
	if (!checkActionAuth(request, env)) {
		return jsonResponse({ error: "Unauthorized" }, 401);
	}

	try {
		if (url.pathname === "/api/stock-analysis") {
			const code = url.searchParams.get("code") ?? "";
			const market = (url.searchParams.get("market") ?? "").toUpperCase();
			const adjust = url.searchParams.get("adjust") ?? "f";

			if (!/^\d{6}$/.test(code)) throw new Error("code必须是6位股票代码");
			if (market !== "SH" && market !== "SZ") throw new Error("market必须是SH或SZ");
			if (!(["n", "f", "b", "fr", "br"] as string[]).includes(adjust)) {
				throw new Error("adjust参数不正确");
			}

			const data = await getStockAnalysisPack(env, {
				code,
				market,
				adjust: adjust as StockPackInput["adjust"],
				intradayBars: 48,
				dailyBars: 120,
				weeklyBars: 80,
			});
			return jsonResponse(data);
		}

		if (url.pathname === "/api/etf-quote") {
			const code = url.searchParams.get("code") ?? "";
			if (!/^\d{6}$/.test(code)) throw new Error("code必须是6位ETF代码");
			return jsonResponse(await getEtfQuote(env, code));
		}

		if (url.pathname === "/api/index-bars") {
			const symbol = (url.searchParams.get("symbol") ?? "").toUpperCase();
			const interval = url.searchParams.get("interval") ?? "d";
			const limit = numberParam(url.searchParams.get("limit"), 120, 10, 250);

			if (!/^\d{6}\.(SH|SZ)$/.test(symbol)) {
				throw new Error("symbol格式应类似000001.SH或399001.SZ");
			}
			if (!(["5", "15", "30", "60", "d", "w", "m"] as string[]).includes(interval)) {
				throw new Error("interval参数不正确");
			}

			return jsonResponse(
				await getIndexBars(
					env,
					symbol,
					interval as "5" | "15" | "30" | "60" | "d" | "w" | "m",
					limit,
				),
			);
		}

		return jsonResponse({ error: "Not found" }, 404);
	} catch (error) {
		const message = cleanError(error);
		const isInputError =
			message.includes("必须") || message.includes("格式") || message.includes("参数");
		return jsonResponse({ error: message }, isInputError ? 400 : 502);
	}
}

export class MyMCP extends McpAgent<Bindings> {
	server = new McpServer({ name: "A股波段投资数据助手", version: "1.1.0" });

	async init() {
		this.server.registerTool(
			"get_stock_analysis_pack",
			{
				description:
					"获取沪深A股实时行情、5分钟K线、日K、周K、行业概念和近四季度财务指标。",
				inputSchema: {
					code: z.string().regex(/^\d{6}$/),
					market: z.enum(["SH", "SZ"]),
					adjust: z.enum(["n", "f", "b", "fr", "br"]).default("f"),
					intradayBars: z.number().int().min(12).max(96).default(48),
					dailyBars: z.number().int().min(30).max(250).default(120),
					weeklyBars: z.number().int().min(20).max(150).default(80),
				},
			},
			async (input) => {
				try {
					return jsonResult(await getStockAnalysisPack(this.env, input));
				} catch (error) {
					return errorResult(error);
				}
			},
		);

		this.server.registerTool(
			"get_etf_quote",
			{
				description: "获取沪深场内ETF实时行情。",
				inputSchema: { code: z.string().regex(/^\d{6}$/) },
			},
			async ({ code }) => {
				try {
					return jsonResult(await getEtfQuote(this.env, code));
				} catch (error) {
					return errorResult(error);
				}
			},
		);

		this.server.registerTool(
			"get_index_bars",
			{
				description: "获取沪深指数K线，用于判断市场环境和比较相对强弱。",
				inputSchema: {
					symbol: z.string().regex(/^\d{6}\.(SH|SZ)$/),
					interval: z.enum(["5", "15", "30", "60", "d", "w", "m"]).default("d"),
					limit: z.number().int().min(10).max(250).default(120),
				},
			},
			async ({ symbol, interval, limit }) => {
				try {
					return jsonResult(await getIndexBars(this.env, symbol, interval, limit));
				} catch (error) {
					return errorResult(error);
				}
			},
		);
	}
}

export default {
	async fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return new Response(null, { status: 204, headers: corsHeaders() });
		}

		if (url.pathname === "/openapi.json") return jsonResponse(OPENAPI_SCHEMA);

		if (url.pathname.startsWith("/api/")) {
			if (request.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
			return handleRestApi(request, env, url);
		}

		if (url.pathname === "/mcp") {
			if (env.MCP_ACCESS_KEY && url.searchParams.get("key") !== env.MCP_ACCESS_KEY) {
				return new Response("Unauthorized", { status: 401 });
			}
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("A股波段投资数据助手已运行（MCP + GPT Action）", {
			status: 200,
			headers: corsHeaders("text/plain; charset=utf-8"),
		});
	},
};
