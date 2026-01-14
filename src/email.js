/**
 * 邮件接收处理（Cloudflare Email Routing）
 */

import { generateId, parseEmailAddress, isAllowedDomain, extractPreview, htmlToText } from "./utils.js";

/**
 * 解析 MIME 邮件内容
 */
async function parseMimeEmail(message) {
  const rawEmail = await new Response(message.raw).text();
  
  // 分离头部和正文
  const headerEndIndex = rawEmail.indexOf("\r\n\r\n");
  const headersRaw = headerEndIndex > 0 ? rawEmail.substring(0, headerEndIndex) : rawEmail;
  const bodyRaw = headerEndIndex > 0 ? rawEmail.substring(headerEndIndex + 4) : "";

  // 解析头部
  const headers = parseHeaders(headersRaw);
  
  // 解析正文
  const contentType = headers["content-type"] || "text/plain";
  const transferEncoding = headers["content-transfer-encoding"] || "";
  const { textContent, htmlContent, attachments } = parseBody(bodyRaw, contentType, transferEncoding);

  return {
    headers,
    textContent,
    htmlContent,
    attachments,
    rawEmail,
  };
}

/**
 * 解析邮件头部
 */
function parseHeaders(headersRaw) {
  const headers = {};
  const lines = headersRaw.split(/\r?\n/);
  let currentKey = "";
  let currentValue = "";

  for (const line of lines) {
    if (/^\s/.test(line)) {
      // 续行
      currentValue += " " + line.trim();
    } else {
      if (currentKey) {
        headers[currentKey.toLowerCase()] = decodeMimeHeader(currentValue);
      }
      const colonIndex = line.indexOf(":");
      if (colonIndex > 0) {
        currentKey = line.substring(0, colonIndex).trim();
        currentValue = line.substring(colonIndex + 1).trim();
      }
    }
  }
  if (currentKey) {
    headers[currentKey.toLowerCase()] = decodeMimeHeader(currentValue);
  }

  return headers;
}

/**
 * 解码 MIME 编码的头部
 */
function decodeMimeHeader(str) {
  if (!str) return "";
  
  const mimeRegex = /=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi;
  return str.replace(mimeRegex, (match, charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === "B") {
        return decodeBase64(text);
      } else if (encoding.toUpperCase() === "Q") {
        return decodeQuotedPrintable(text.replace(/_/g, " "));
      }
    } catch (e) {}
    return match;
  });
}

/**
 * Base64 解码 (支持 UTF-8)
 */
function decodeBase64(str) {
  try {
    const binary = atob(str.replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder("utf-8").decode(bytes);
  } catch (e) {
    return str;
  }
}

/**
 * Quoted-Printable 解码 (支持 UTF-8)
 */
function decodeQuotedPrintable(str) {
  try {
    // 先处理软换行
    const cleaned = str.replace(/=\r?\n/g, "");
    
    // 收集所有字节
    const bytes = [];
    let i = 0;
    while (i < cleaned.length) {
      if (cleaned[i] === "=" && i + 2 < cleaned.length) {
        const hex = cleaned.substring(i + 1, i + 3);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          bytes.push(parseInt(hex, 16));
          i += 3;
          continue;
        }
      }
      bytes.push(cleaned.charCodeAt(i));
      i++;
    }
    
    return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
  } catch (e) {
    return str;
  }
}

/**
 * 解析邮件正文
 */
function parseBody(bodyRaw, contentType, transferEncoding = "") {
  let textContent = "";
  let htmlContent = "";
  const attachments = [];

  const contentTypeLower = contentType.toLowerCase();

  if (contentTypeLower.includes("multipart")) {
    // 多部分邮件
    const boundaryMatch = contentType.match(/boundary=["']?([^"';\s]+)["']?/i);
    if (boundaryMatch) {
      const boundary = boundaryMatch[1];
      const parts = parseMultipart(bodyRaw, boundary);

      for (const part of parts) {
        const partType = (part.headers["content-type"] || "").toLowerCase();
        const disposition = (part.headers["content-disposition"] || "").toLowerCase();
        const transferEncoding = part.headers["content-transfer-encoding"] || "";

        if (disposition.includes("attachment")) {
          // 附件
          const filenameMatch = disposition.match(/filename=["']?([^"';\r\n]+)["']?/i);
          attachments.push({
            filename: decodeMimeHeader(filenameMatch ? filenameMatch[1] : "attachment"),
            contentType: partType.split(";")[0].trim(),
            content: part.body,
            size: part.body.length,
          });
        } else if (partType.includes("text/html")) {
          htmlContent = decodeContent(part.body, transferEncoding);
        } else if (partType.includes("text/plain")) {
          textContent = decodeContent(part.body, transferEncoding);
        } else if (partType.includes("multipart")) {
          // 嵌套 multipart
          const nestedBoundaryMatch = partType.match(/boundary=["']?([^"';\s]+)["']?/i);
          if (nestedBoundaryMatch) {
            const nestedParts = parseMultipart(part.body, nestedBoundaryMatch[1]);
            for (const nested of nestedParts) {
              const nestedType = (nested.headers["content-type"] || "").toLowerCase();
              const nestedEncoding = nested.headers["content-transfer-encoding"] || "";
              if (nestedType.includes("text/html")) {
                htmlContent = decodeContent(nested.body, nestedEncoding);
              } else if (nestedType.includes("text/plain")) {
                textContent = decodeContent(nested.body, nestedEncoding);
              }
            }
          }
        }
      }
    }
  } else if (contentTypeLower.includes("text/html")) {
    htmlContent = decodeContent(bodyRaw, transferEncoding);
  } else {
    textContent = decodeContent(bodyRaw, transferEncoding);
  }

  return { textContent, htmlContent, attachments };
}

/**
 * 解析多部分内容
 */
function parseMultipart(body, boundary) {
  const parts = [];
  const boundaryDelimiter = `--${boundary}`;
  const sections = body.split(boundaryDelimiter);

  for (let i = 1; i < sections.length; i++) {
    const section = sections[i].trim();
    if (section.startsWith("--") || !section) continue;

    const headerEndIndex = section.indexOf("\r\n\r\n");
    if (headerEndIndex === -1) continue;

    const partHeaders = parseHeaders(section.substring(0, headerEndIndex));
    const partBody = section.substring(headerEndIndex + 4).replace(/\r\n$/, "");

    parts.push({ headers: partHeaders, body: partBody });
  }

  return parts;
}

/**
 * 解码内容
 */
function decodeContent(content, transferEncoding) {
  if (!content) return "";
  
  const encoding = (transferEncoding || "").toLowerCase();
  if (encoding.includes("base64")) {
    return decodeBase64(content);
  } else if (encoding.includes("quoted-printable")) {
    return decodeQuotedPrintable(content);
  }
  return content;
}

/**
 * 处理接收到的邮件
 */
export async function handleEmail(message, env) {
  try {
    // 获取收件人地址
    const toAddress = message.to.toLowerCase();
    
    // 检查是否为允许的域名
    if (!isAllowedDomain(toAddress, env)) {
      console.log(`Rejected email to ${toAddress}: domain not allowed`);
      return;
    }

    // 解析邮件
    const parsed = await parseMimeEmail(message);
    const fromParsed = parseEmailAddress(parsed.headers["from"]);

    // 生成邮件 ID
    const id = generateId();
    const now = Date.now();

    // 获取文本内容
    let textContent = parsed.textContent;
    if (!textContent && parsed.htmlContent) {
      textContent = htmlToText(parsed.htmlContent);
    }

    // 存储邮件到 D1
    await env.DB.prepare(`
      INSERT INTO emails (id, address, from_address, from_name, subject, text_content, html_content, raw_email, has_attachments, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      toAddress,
      fromParsed.email,
      fromParsed.name,
      parsed.headers["subject"] || "(无主题)",
      textContent,
      parsed.htmlContent,
      parsed.rawEmail,
      parsed.attachments.length > 0 ? 1 : 0,
      now
    ).run();

    // 存储附件
    for (const attachment of parsed.attachments) {
      const attachmentId = generateId();
      await env.DB.prepare(`
        INSERT INTO attachments (id, email_id, filename, content_type, size, content, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        attachmentId,
        id,
        attachment.filename,
        attachment.contentType,
        attachment.size,
        attachment.content,
        now
      ).run();
    }

    console.log(`Email saved: ${id} to ${toAddress} from ${fromParsed.email}`);
  } catch (error) {
    console.error("Error handling email:", error);
  }
}

