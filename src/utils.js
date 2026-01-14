/**
 * 工具函数
 */

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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

