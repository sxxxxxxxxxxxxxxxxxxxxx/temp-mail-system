/**
 * Cloudflare Worker 主入口
 * 处理 HTTP 请求和邮件接收
 */

import { handleEmail } from "./email.js";
import {
  getDomains,
  generateId,
  generatePrefix,
  isAllowedDomain,
  jsonResponse,
  corsResponse,
  extractPreview,
} from "./utils.js";

export default {
  /**
   * HTTP 请求处理
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS 预检
    if (request.method === "OPTIONS") {
      return corsResponse();
    }

    // API 路由
    if (path.startsWith("/api/")) {
      return handleApi(path, url, env);
    }

    // 静态资源
    return env.ASSETS.fetch(request);
  },

  /**
   * 邮件接收处理（Email Routing）
   */
  async email(message, env, ctx) {
    await handleEmail(message, env);
  },
};

/**
 * API 路由处理
 */
async function handleApi(path, url, env) {
  try {
    // GET /api/domains - 获取域名列表
    if (path === "/api/domains") {
      const domains = getDomains(env);
      return jsonResponse({ domains });
    }

    // GET /api/generate - 生成随机邮箱
    if (path === "/api/generate") {
      const domains = getDomains(env);
      let domain = url.searchParams.get("domain");
      
      if (!domain || !domains.includes(domain.toLowerCase())) {
        domain = domains[Math.floor(Math.random() * domains.length)];
      } else {
        domain = domain.toLowerCase();
      }

      const prefix = generatePrefix(10);
      const address = `${prefix}@${domain}`;

      return jsonResponse({ address, prefix, domain });
    }

    // GET /api/inbox - 获取收件箱
    if (path === "/api/inbox") {
      const address = url.searchParams.get("address");
      
      if (!address) {
        return jsonResponse({ success: false, error: "请提供邮箱地址", messages: [] }, 400);
      }

      if (!isAllowedDomain(address, env)) {
        return jsonResponse({ success: false, error: "不支持的域名", messages: [] }, 400);
      }

      const addressLower = address.toLowerCase();
      
      // 查询邮件列表
      const result = await env.DB.prepare(`
        SELECT id, address, from_address, from_name, subject, text_content, has_attachments, created_at
        FROM emails
        WHERE address = ?
        ORDER BY created_at DESC
        LIMIT 50
      `).bind(addressLower).all();

      const messages = (result.results || []).map(row => ({
        id: row.id,
        from: row.from_name ? `${row.from_name} <${row.from_address}>` : row.from_address,
        subject: row.subject,
        preview: extractPreview(row.text_content),
        date: new Date(row.created_at).toISOString(),
        hasAttachments: row.has_attachments === 1,
      }));

      return jsonResponse({
        success: true,
        address: addressLower,
        messages,
        count: messages.length,
      });
    }

    // GET /api/message - 获取邮件详情
    if (path === "/api/message") {
      const address = url.searchParams.get("address");
      const id = url.searchParams.get("id");

      if (!address || !id) {
        return jsonResponse({ success: false, error: "请提供邮箱地址和邮件ID" }, 400);
      }

      if (!isAllowedDomain(address, env)) {
        return jsonResponse({ success: false, error: "不支持的域名" }, 400);
      }

      const addressLower = address.toLowerCase();

      // 查询邮件
      const email = await env.DB.prepare(`
        SELECT * FROM emails WHERE id = ? AND address = ?
      `).bind(id, addressLower).first();

      if (!email) {
        return jsonResponse({ success: false, error: "邮件不存在" }, 404);
      }

      // 查询附件
      const attachmentsResult = await env.DB.prepare(`
        SELECT id, filename, content_type, size FROM attachments WHERE email_id = ?
      `).bind(id).all();

      const attachments = (attachmentsResult.results || []).map(att => ({
        id: att.id,
        filename: att.filename,
        contentType: att.content_type,
        size: att.size,
      }));

      return jsonResponse({
        success: true,
        message: {
          id: email.id,
          from: email.from_name ? `${email.from_name} <${email.from_address}>` : email.from_address,
          to: email.address,
          subject: email.subject,
          text: email.text_content,
          html: email.html_content,
          date: new Date(email.created_at).toISOString(),
          attachments,
        },
      });
    }

    // GET /api/attachment - 下载附件
    if (path === "/api/attachment") {
      const id = url.searchParams.get("id");

      if (!id) {
        return jsonResponse({ success: false, error: "请提供附件ID" }, 400);
      }

      const attachment = await env.DB.prepare(`
        SELECT * FROM attachments WHERE id = ?
      `).bind(id).first();

      if (!attachment) {
        return jsonResponse({ success: false, error: "附件不存在" }, 404);
      }

      return new Response(attachment.content, {
        headers: {
          "Content-Type": attachment.content_type || "application/octet-stream",
          "Content-Disposition": `attachment; filename="${attachment.filename}"`,
        },
      });
    }

    // GET /api/delete - 删除邮件（可选）
    if (path === "/api/delete") {
      const address = url.searchParams.get("address");
      const id = url.searchParams.get("id");

      if (!address || !id) {
        return jsonResponse({ success: false, error: "请提供邮箱地址和邮件ID" }, 400);
      }

      await env.DB.prepare(`
        DELETE FROM emails WHERE id = ? AND address = ?
      `).bind(id, address.toLowerCase()).run();

      return jsonResponse({ success: true });
    }

    // 404
    return jsonResponse({ error: "Not Found" }, 404);

  } catch (error) {
    console.error("API Error:", error);
    return jsonResponse({ success: false, error: "服务器错误" }, 500);
  }
}

