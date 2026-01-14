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

  /**
   * 定时任务处理 - 自动清理旧邮件
   */
  async scheduled(event, env, ctx) {
    try {
      console.log("Starting scheduled cleanup job...");
      await cleanupOldEmails(env);
      console.log("Cleanup job completed successfully");
    } catch (error) {
      console.error("Cleanup job failed:", error);
    }
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

    // GET /api/generate - 生成随机邮箱（防重复）
    if (path === "/api/generate") {
      const domains = getDomains(env);
      const customPrefix = url.searchParams.get("prefix");
      let domain = url.searchParams.get("domain");
      
      if (!domain || !domains.includes(domain.toLowerCase())) {
        domain = domains[Math.floor(Math.random() * domains.length)];
      } else {
        domain = domain.toLowerCase();
      }

      let address;
      let prefix;
      let attempts = 0;
      const maxAttempts = 10;

      // 如果有自定义前缀，直接使用
      if (customPrefix && /^[a-zA-Z0-9._-]+$/.test(customPrefix)) {
        prefix = customPrefix.toLowerCase();
        address = `${prefix}@${domain}`;
        
        // 检查是否已存在
        const existing = await env.DB.prepare(`
          SELECT address FROM generated_addresses WHERE address = ?
        `).bind(address).first();
        
        if (existing) {
          return jsonResponse({ 
            success: false, 
            error: "该邮箱地址已被使用，请尝试其他前缀" 
          }, 400);
        }
      } else {
        // 生成随机邮箱，确保不重复
        while (attempts < maxAttempts) {
          prefix = generatePrefix(10);
          address = `${prefix}@${domain}`;
          
          // 检查数据库中是否已存在
          const existing = await env.DB.prepare(`
            SELECT address FROM generated_addresses WHERE address = ?
          `).bind(address).first();
          
          if (!existing) {
            break;
          }
          
          attempts++;
        }
        
        if (attempts >= maxAttempts) {
          return jsonResponse({ 
            success: false, 
            error: "生成邮箱失败，请稍后重试" 
          }, 500);
        }
      }

      // 记录生成的邮箱地址
      await env.DB.prepare(`
        INSERT INTO generated_addresses (address, created_at)
        VALUES (?, ?)
      `).bind(address, Date.now()).run();

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

/**
 * 清理超过 24 小时的旧邮件和附件
 */
async function cleanupOldEmails(env) {
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  
  try {
    // 删除超过 24 小时的邮件（附件会通过 ON DELETE CASCADE 自动删除）
    const result = await env.DB.prepare(`
      DELETE FROM emails WHERE created_at < ?
    `).bind(oneDayAgo).run();
    
    console.log(`Deleted ${result.changes || 0} old emails`);
    
    // 清理生成地址记录表（保留最近 7 天的记录以防短期内重复）
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const addressResult = await env.DB.prepare(`
      DELETE FROM generated_addresses WHERE created_at < ?
    `).bind(sevenDaysAgo).run();
    
    console.log(`Deleted ${addressResult.changes || 0} old address records`);
    
    return {
      emailsDeleted: result.changes || 0,
      addressRecordsDeleted: addressResult.changes || 0,
    };
  } catch (error) {
    console.error("Error during cleanup:", error);
    throw error;
  }
}

