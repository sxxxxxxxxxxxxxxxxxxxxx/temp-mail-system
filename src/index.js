/**
 * Cloudflare Worker 主入口
 * 处理 HTTP 请求和邮件接收
 */

import { handleEmail } from "./email.js";
import {
  CONFIG,
  getDomains,
  generateId,
  generatePrefix,
  isAllowedDomain,
  jsonResponse,
  corsResponse,
  extractPreview,
  getClientIP,
  checkRateLimit,
  rateLimitResponse,
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
      return handleApi(path, url, env, request);
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
async function handleApi(path, url, env, request) {
  const method = request.method.toUpperCase();
  const clientIP = getClientIP(request);
  
  try {
    // GET /api/domains - 获取域名列表（不限制速率）
    if (path === "/api/domains") {
      const domains = getDomains(env);
      return jsonResponse({ domains });
    }

    // 对需要速率限制的端点进行检查
    const rateLimitedEndpoints = ["/api/generate", "/api/inbox", "/api/message", "/api/delete"];
    if (rateLimitedEndpoints.includes(path)) {
      const rateLimit = await checkRateLimit(env, clientIP, path);
      if (!rateLimit.allowed) {
        return rateLimitResponse(rateLimit.resetAt);
      }
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

      // 如果有自定义前缀
      if (customPrefix) {
        // 验证前缀格式：只允许字母、数字、点、下划线、连字符，长度 1-64
        if (!/^[a-zA-Z0-9._-]{1,64}$/.test(customPrefix)) {
          return jsonResponse({ 
            success: false, 
            error: "前缀只能包含字母、数字、点、下划线、连字符，长度1-64位" 
          }, 400);
        }
        
        prefix = customPrefix.toLowerCase();
        address = `${prefix}@${domain}`;
        
        // 检查是否已存在（同时检查 generated_addresses 和 emails 表）
        const existingGenerated = await env.DB.prepare(`
          SELECT address FROM generated_addresses WHERE address = ?
        `).bind(address).first();
        
        const existingEmail = await env.DB.prepare(`
          SELECT address FROM emails WHERE address = ? LIMIT 1
        `).bind(address).first();
        
        if (existingGenerated || existingEmail) {
          return jsonResponse({ 
            success: false, 
            error: "该邮箱地址已被使用，请尝试其他前缀" 
          }, 400);
        }
      } else {
        // 生成随机邮箱，确保不重复
        while (attempts < maxAttempts) {
          prefix = generatePrefix(CONFIG.PREFIX_LENGTH);
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

      return jsonResponse({ success: true, address, prefix, domain });
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
        LIMIT ${CONFIG.INBOX_LIMIT}
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

    // GET /api/attachment - 下载附件（需要验证邮箱归属）
    if (path === "/api/attachment") {
      const id = url.searchParams.get("id");
      const address = url.searchParams.get("address");

      if (!id) {
        return jsonResponse({ success: false, error: "请提供附件ID" }, 400);
      }

      if (!address) {
        return jsonResponse({ success: false, error: "请提供邮箱地址" }, 400);
      }

      if (!isAllowedDomain(address, env)) {
        return jsonResponse({ success: false, error: "不支持的域名" }, 400);
      }

      const addressLower = address.toLowerCase();

      // 查询附件并验证邮箱归属
      const attachment = await env.DB.prepare(`
        SELECT a.* FROM attachments a
        INNER JOIN emails e ON a.email_id = e.id
        WHERE a.id = ? AND e.address = ?
      `).bind(id, addressLower).first();

      if (!attachment) {
        return jsonResponse({ success: false, error: "附件不存在或无权访问" }, 404);
      }

      // 对文件名进行 RFC 5987 编码以支持中文
      const encodedFilename = encodeURIComponent(attachment.filename).replace(/'/g, "%27");
      
      return new Response(attachment.content, {
        headers: {
          "Content-Type": attachment.content_type || "application/octet-stream",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodedFilename}`,
          "Cache-Control": "private, max-age=3600",
        },
      });
    }

    // DELETE /api/delete - 删除邮件（支持 DELETE 和 POST 方法）
    if (path === "/api/delete") {
      // 只允许 DELETE 或 POST 方法
      if (method !== "DELETE" && method !== "POST") {
        return jsonResponse({ 
          success: false, 
          error: "请使用 DELETE 或 POST 方法" 
        }, 405);
      }

      const address = url.searchParams.get("address");
      const id = url.searchParams.get("id");

      if (!address || !id) {
        return jsonResponse({ success: false, error: "请提供邮箱地址和邮件ID" }, 400);
      }

      if (!isAllowedDomain(address, env)) {
        return jsonResponse({ success: false, error: "不支持的域名" }, 400);
      }

      const addressLower = address.toLowerCase();

      // 先检查邮件是否存在
      const email = await env.DB.prepare(`
        SELECT id FROM emails WHERE id = ? AND address = ?
      `).bind(id, addressLower).first();

      if (!email) {
        return jsonResponse({ success: false, error: "邮件不存在或无权删除" }, 404);
      }

      // 删除邮件（附件会通过外键级联删除）
      await env.DB.prepare(`
        DELETE FROM emails WHERE id = ? AND address = ?
      `).bind(id, addressLower).run();

      return jsonResponse({ success: true, message: "邮件已删除" });
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
  const now = Date.now();
  const emailExpireTime = now - CONFIG.EMAIL_EXPIRE_MS;
  const addressExpireTime = now - CONFIG.ADDRESS_EXPIRE_MS;
  const rateLimitExpireTime = now - CONFIG.RATE_LIMIT_WINDOW_MS * 2; // 保留 2 个窗口期的记录
  
  try {
    // 删除过期邮件（附件会通过 ON DELETE CASCADE 自动删除）
    const result = await env.DB.prepare(`
      DELETE FROM emails WHERE created_at < ?
    `).bind(emailExpireTime).run();
    
    console.log(`Deleted ${result.changes || 0} old emails`);
    
    // 清理生成地址记录表（保留最近 7 天的记录以防短期内重复）
    const addressResult = await env.DB.prepare(`
      DELETE FROM generated_addresses WHERE created_at < ?
    `).bind(addressExpireTime).run();
    
    console.log(`Deleted ${addressResult.changes || 0} old address records`);
    
    // 清理过期的速率限制记录
    const rateLimitResult = await env.DB.prepare(`
      DELETE FROM rate_limits WHERE window_start < ?
    `).bind(rateLimitExpireTime).run();
    
    console.log(`Deleted ${rateLimitResult.changes || 0} old rate limit records`);
    
    return {
      emailsDeleted: result.changes || 0,
      addressRecordsDeleted: addressResult.changes || 0,
      rateLimitRecordsDeleted: rateLimitResult.changes || 0,
    };
  } catch (error) {
    console.error("Error during cleanup:", error);
    throw error;
  }
}
