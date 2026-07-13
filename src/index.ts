import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { z } from "zod";

interface Env {
	MyMCP: DurableObjectNamespace<MyMCP>;
}

type Bindings = Env & {
	BIYING_LICENCE: string;
	MCP_ACCESS_KEY?: string;
};

type CacheEntry = {
	expiresAt: number;
	data: unknown;
};

const API_BASE = "https://api.biyingapi.com";

function jsonResult(data: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(data) }],
	};
}

function errorResult(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	return {
		isError: true,
		content: [{ type: "text" as const, text: `数据请求失败：${message}` }],
	};
}

export class MyMCP extends McpAgent<Bindings> {
	server = new McpServer({
		name: "A股波段投资数据助手",
		version: "1.0.0",
	});

	private cache = new Map<string, CacheEntry>();

	private async biyingGet(
		path: string,
		params: Record<string, string | number | undefined> = {},
		ttlSeconds = 60,
	): Promise<unknown> {
		const licence = this.env.BIYING_LICENCE;
		if (!licence) throw new Error("Cloudflare 中缺少 BIYING_LICENCE Secret");

		const query = new URLSearchParams();
		for (const [key, value] of Object.entries(params)) {
			if (value !== undefined && value !== "") query.set(key, String(value));
		}
		query.sort();

		const cacheKey = `${path}?${query.toString()}`;
		const cached = this.cache.get(cacheKey);
		if (cached && cached.expiresAt > Date.now()) return cached.data;

		const url = new URL(`${API_BASE}/${path}/${encodeURIComponent(licence)}`);
		url.search = query.toString();

		const response = await fetch(url, {
			headers: { Accept: "application/json" },
		});
		const raw = await response.text();
		if (!response.ok) {
			throw new Error(`毕盈API返回 HTTP ${response.status}`);
		}

		let data: unknown;
		try {
			data = JSON.parse(raw);
		} catch {
			throw new Error(`毕盈API未返回有效JSON：${raw.slice(0, 120)}`);
		}

		this.cache.set(cacheKey, {
			expiresAt: Date.now() + ttlSeconds * 1000,
			data,
		});
		return data;
	}

	async init() {
		this.server.registerTool(
			"get_stock_analysis_pack",
			{
				description:
					"获取一只沪深A股的波段分析数据包，包括实时行情、5分钟K线、日K、周K、所属行业概念和近四季度财务指标。分析A股时优先调用此工具一次，避免重复请求。",
				inputSchema: {
					code: z.string().regex(/^\d{6}$/).describe("6位A股代码，如603916"),
					market: z.enum(["SH", "SZ"]).describe("交易所：SH或SZ"),
					adjust: z
						.enum(["n", "f", "b", "fr", "br"])
						.default("f")
						.describe("复权：n不复权，f前复权，b后复权，fr等比前复权，br等比后复权"),
					intradayBars: z.number().int().min(12).max(96).default(48),
					dailyBars: z.number().int().min(30).max(250).default(120),
					weeklyBars: z.number().int().min(20).max(150).default(80),
				},
			},
			async ({ code, market, adjust, intradayBars, dailyBars, weeklyBars }) => {
				try {
					const symbol = `${code}.${market}`;
					const [quote, intraday, daily, weekly, classifications, financials] =
						await Promise.all([
							this.biyingGet(`hsrl/ssjy/${code}`, {}, 45),
							this.biyingGet(
								`hsstock/latest/${symbol}/5/n`,
								{ lt: intradayBars },
								240,
							),
							this.biyingGet(
								`hsstock/latest/${symbol}/d/${adjust}`,
								{ lt: dailyBars },
								900,
							),
							this.biyingGet(
								`hsstock/latest/${symbol}/w/${adjust}`,
								{ lt: weeklyBars },
								3600,
							),
							this.biyingGet(`hszg/zg/${code}`, {}, 86400),
							this.biyingGet(`hscp/cwzb/${code}`, {}, 86400),
						]);

					return jsonResult({
						source: "毕盈API",
						fetchedAt: new Date().toISOString(),
						symbol,
						adjust,
						quote,
						bars: { intraday5m: intraday, daily, weekly },
						classifications,
						financials,
					});
				} catch (error) {
					return errorResult(error);
				}
			},
		);

		this.server.registerTool(
			"get_etf_quote",
			{
				description:
					"获取沪深场内ETF实时行情。毕盈当前文档未明确提供ETF历史K线，因此本工具只返回实时行情。",
				inputSchema: {
					code: z.string().regex(/^\d{6}$/).describe("6位ETF代码，如510300或159915"),
				},
			},
			async ({ code }) => {
				try {
					const quote = await this.biyingGet(`fd/real/time/${code}`, {}, 45);
					return jsonResult({
						source: "毕盈API",
						fetchedAt: new Date().toISOString(),
						code,
						quote,
					});
				} catch (error) {
					return errorResult(error);
				}
			},
		);

		this.server.registerTool(
			"get_index_bars",
			{
				description:
					"获取沪深指数K线，用于比较大盘环境和个股相对强弱，如000001.SH上证指数、399001.SZ深证成指。",
				inputSchema: {
					symbol: z
						.string()
						.regex(/^\d{6}\.(SH|SZ)$/)
						.describe("指数代码及市场，如000001.SH"),
					interval: z.enum(["5", "15", "30", "60", "d", "w", "m"]).default("d"),
					limit: z.number().int().min(10).max(250).default(120),
				},
			},
			async ({ symbol, interval, limit }) => {
				try {
					const bars = await this.biyingGet(
						`hsindex/latest/${symbol}/${interval}`,
						{ lt: limit },
						interval === "d" || interval === "w" || interval === "m" ? 900 : 240,
					);
					return jsonResult({
						source: "毕盈API",
						fetchedAt: new Date().toISOString(),
						symbol,
						interval,
						bars,
					});
				} catch (error) {
					return errorResult(error);
				}
			},
		);
	}
}

export default {
	fetch(request: Request, env: Bindings, ctx: ExecutionContext) {
		const url = new URL(request.url);

		if (url.pathname === "/mcp") {
			if (env.MCP_ACCESS_KEY && url.searchParams.get("key") !== env.MCP_ACCESS_KEY) {
				return new Response("Unauthorized", { status: 401 });
			}
			return MyMCP.serve("/mcp").fetch(request, env, ctx);
		}

		return new Response("A股波段投资数据助手已运行", { status: 200 });
	},
};
