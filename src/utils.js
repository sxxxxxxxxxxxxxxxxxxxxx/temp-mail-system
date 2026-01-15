/**
 * 工具函数
 */

// ============ 配置常量 ============
export const CONFIG = {
  // 邮箱前缀长度
  PREFIX_LENGTH: 10,
  // 邮箱最大查询数量
  INBOX_LIMIT: 50,
  // 预览文本最大长度
  PREVIEW_MAX_LENGTH: 150,
  // 邮件过期时间（毫秒）- 24小时
  EMAIL_EXPIRE_MS: 24 * 60 * 60 * 1000,
  // 地址记录过期时间（毫秒）- 7天
  ADDRESS_EXPIRE_MS: 7 * 24 * 60 * 60 * 1000,
  // 速率限制 - 时间窗口（毫秒）- 1分钟
  RATE_LIMIT_WINDOW_MS: 60 * 1000,
  // 速率限制 - 每个时间窗口最大请求数
  RATE_LIMIT_MAX_REQUESTS: {
    "/api/generate": 10,      // 每分钟最多生成 10 个邮箱
    "/api/inbox": 60,         // 每分钟最多查询 60 次收件箱
    "/api/message": 60,       // 每分钟最多查看 60 封邮件
    "/api/delete": 30,        // 每分钟最多删除 30 封邮件
    "default": 100,           // 默认每分钟 100 次
  },
};

// 支持的域名列表（从环境变量读取）
export function getDomains(env) {
  const domainsStr = env.DOMAINS || "2art.fun,sumeetsxiang.com,wadao.world,wearwave.live";
  return domainsStr.split(",").map(d => d.trim().toLowerCase()).filter(Boolean);
}

// 生成唯一 ID
export function generateId() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 10);
  return `${timestamp}${random}`;
}

// 生成随机邮箱前缀
export function generatePrefix(length = 10) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let result = "";
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  for (let i = 0; i < length; i++) {
    result += chars.charAt(array[i] % chars.length);
  }
  return result;
}

// 检查是否为允许的域名
export function isAllowedDomain(address, env) {
  if (!address) return false;
  const domains = getDomains(env);
  const lower = address.toLowerCase();
  return domains.some(domain => lower.endsWith(`@${domain}`));
}

// JSON 响应
export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

// CORS 预检响应
export function corsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

// 解析邮件地址
export function parseEmailAddress(address) {
  if (!address) return { name: "", email: "" };
  
  // 格式: "Name" <email@domain.com> 或 email@domain.com
  const match = address.match(/^(?:"?([^"<]*)"?\s*)?<?([^>]+)>?$/);
  if (match) {
    return {
      name: (match[1] || "").trim(),
      email: (match[2] || "").trim().toLowerCase(),
    };
  }
  return { name: "", email: address.trim().toLowerCase() };
}

// 提取预览文本
export function extractPreview(text, maxLength = 150) {
  if (!text) return "";
  // 移除多余空白
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.substring(0, maxLength) + "...";
}

// HTML 转文本
export function htmlToText(html) {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// 获取客户端 IP
export function getClientIP(request) {
  // Cloudflare 提供的真实 IP 头
  return request.headers.get("CF-Connecting-IP") || 
         request.headers.get("X-Real-IP") || 
         request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
         "unknown";
}

/**
 * 检查速率限制
 * @returns {Object} { allowed: boolean, remaining: number, resetAt: number }
 */
export async function checkRateLimit(env, ip, endpoint) {
  const now = Date.now();
  const windowStart = Math.floor(now / CONFIG.RATE_LIMIT_WINDOW_MS) * CONFIG.RATE_LIMIT_WINDOW_MS;
  const maxRequests = CONFIG.RATE_LIMIT_MAX_REQUESTS[endpoint] || CONFIG.RATE_LIMIT_MAX_REQUESTS.default;
  
  try {
    // 查询当前窗口的请求数
    const result = await env.DB.prepare(`
      SELECT request_count FROM rate_limits 
      WHERE ip = ? AND endpoint = ? AND window_start = ?
    `).bind(ip, endpoint, windowStart).first();
    
    const currentCount = result?.request_count || 0;
    
    if (currentCount >= maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: windowStart + CONFIG.RATE_LIMIT_WINDOW_MS,
      };
    }
    
    // 增加计数（使用 UPSERT）
    await env.DB.prepare(`
      INSERT INTO rate_limits (ip, endpoint, window_start, request_count)
      VALUES (?, ?, ?, 1)
      ON CONFLICT (ip, endpoint, window_start) 
      DO UPDATE SET request_count = request_count + 1
    `).bind(ip, endpoint, windowStart).run();
    
    return {
      allowed: true,
      remaining: maxRequests - currentCount - 1,
      resetAt: windowStart + CONFIG.RATE_LIMIT_WINDOW_MS,
    };
  } catch (error) {
    // 如果速率限制检查失败，允许请求继续（优雅降级）
    console.error("Rate limit check failed:", error);
    return { allowed: true, remaining: -1, resetAt: 0 };
  }
}

// 速率限制响应
export function rateLimitResponse(resetAt) {
  const retryAfter = Math.ceil((resetAt - Date.now()) / 1000);
  return new Response(JSON.stringify({ 
    success: false, 
    error: "请求过于频繁，请稍后再试",
    retryAfter: retryAfter > 0 ? retryAfter : 60,
  }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfter > 0 ? retryAfter : 60),
      "Access-Control-Allow-Origin": "*",
    },
  });
}
