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
 * 解码 MIME 编码的头部（支持多字符集）
 */
function decodeMimeHeader(str) {
  if (!str) return "";
  
  const mimeRegex = /=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi;
  return str.replace(mimeRegex, (match, charset, encoding, text) => {
    try {
      if (encoding.toUpperCase() === "B") {
        return decodeBase64(text, charset);
      } else if (encoding.toUpperCase() === "Q") {
        return decodeQuotedPrintable(text.replace(/_/g, " "), charset);
      }
    } catch (e) {}
    return match;
  });
}

/**
 * 从 Content-Type 中提取字符集
 */
function extractCharset(contentType) {
  if (!contentType) return "utf-8";
  const match = contentType.match(/charset=["']?([^"';\s]+)["']?/i);
  return match ? match[1] : "utf-8";
}

/**
 * 获取 TextDecoder，支持多种字符集
 */
function getTextDecoder(charset) {
  const normalizedCharset = (charset || "utf-8").toLowerCase().replace(/[^a-z0-9-]/g, "");
  
  // 常见字符集映射
  const charsetMap = {
    "gbk": "gbk",
    "gb2312": "gbk",
    "gb18030": "gb18030",
    "big5": "big5",
    "iso88591": "iso-8859-1",
    "iso-8859-1": "iso-8859-1",
    "windows1252": "windows-1252",
    "windows-1252": "windows-1252",
    "utf8": "utf-8",
    "utf-8": "utf-8",
  };
  
  const decoderCharset = charsetMap[normalizedCharset] || "utf-8";
  
  try {
    return new TextDecoder(decoderCharset);
  } catch (e) {
    // 如果不支持该字符集，回退到 UTF-8
    return new TextDecoder("utf-8");
  }
}

/**
 * Base64 解码为文本（支持多字符集）
 */
function decodeBase64(str, charset = "utf-8") {
  try {
    const binary = atob(str.replace(/\s/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return getTextDecoder(charset).decode(bytes);
  } catch (e) {
    return str;
  }
}

/**
 * Base64 解码为二进制数据（用于附件）
 */
function decodeBase64ToBinary(str) {
  try {
    const cleaned = str.replace(/\s/g, "");
    const binary = atob(cleaned);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch (e) {
    // 解码失败，返回原始字符串的字节
    const encoder = new TextEncoder();
    return encoder.encode(str);
  }
}

/**
 * Quoted-Printable 解码（支持多字符集）
 */
function decodeQuotedPrintable(str, charset = "utf-8") {
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
    
    return getTextDecoder(charset).decode(new Uint8Array(bytes));
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
          // 附件 - 根据 Transfer-Encoding 解码
          const filenameMatch = disposition.match(/filename=["']?([^"';\r\n]+)["']?/i);
          const encoding = (transferEncoding || "").toLowerCase();
          
          let content;
          let size;
          
          if (encoding.includes("base64")) {
            // Base64 编码的附件，解码为二进制
            content = decodeBase64ToBinary(part.body);
            size = content.length;
          } else if (encoding.includes("quoted-printable")) {
            // Quoted-Printable 编码
            const decoded = decodeQuotedPrintable(part.body);
            const encoder = new TextEncoder();
            content = encoder.encode(decoded);
            size = content.length;
          } else {
            // 无编码或 7bit/8bit，直接存储
            const encoder = new TextEncoder();
            content = encoder.encode(part.body);
            size = content.length;
          }
          
          attachments.push({
            filename: decodeMimeHeader(filenameMatch ? filenameMatch[1] : "attachment"),
            contentType: partType.split(";")[0].trim(),
            content: content,
            size: size,
          });
        } else if (partType.includes("text/html")) {
          const charset = extractCharset(part.headers["content-type"]);
          htmlContent = decodeContent(part.body, transferEncoding, charset);
        } else if (partType.includes("text/plain")) {
          const charset = extractCharset(part.headers["content-type"]);
          textContent = decodeContent(part.body, transferEncoding, charset);
        } else if (partType.includes("multipart")) {
          // 嵌套 multipart
          const nestedBoundaryMatch = partType.match(/boundary=["']?([^"';\s]+)["']?/i);
          if (nestedBoundaryMatch) {
            const nestedParts = parseMultipart(part.body, nestedBoundaryMatch[1]);
            for (const nested of nestedParts) {
              const nestedType = (nested.headers["content-type"] || "").toLowerCase();
              const nestedEncoding = nested.headers["content-transfer-encoding"] || "";
              const nestedCharset = extractCharset(nested.headers["content-type"]);
              if (nestedType.includes("text/html")) {
                htmlContent = decodeContent(nested.body, nestedEncoding, nestedCharset);
              } else if (nestedType.includes("text/plain")) {
                textContent = decodeContent(nested.body, nestedEncoding, nestedCharset);
              }
            }
          }
        }
      }
    }
  } else if (contentTypeLower.includes("text/html")) {
    const charset = extractCharset(contentType);
    htmlContent = decodeContent(bodyRaw, transferEncoding, charset);
  } else {
    const charset = extractCharset(contentType);
    textContent = decodeContent(bodyRaw, transferEncoding, charset);
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
function decodeContent(content, transferEncoding, charset = "utf-8") {
  if (!content) return "";
  
  const encoding = (transferEncoding || "").toLowerCase();
  if (encoding.includes("base64")) {
    return decodeBase64(content, charset);
  } else if (encoding.includes("quoted-printable")) {
    return decodeQuotedPrintable(content, charset);
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
