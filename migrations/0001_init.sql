-- 临时邮箱系统数据库初始化
-- 邮件表
CREATE TABLE IF NOT EXISTS emails (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL,
  from_address TEXT,
  from_name TEXT,
  subject TEXT,
  text_content TEXT,
  html_content TEXT,
  raw_email TEXT,
  has_attachments INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_emails_address ON emails(address);
CREATE INDEX IF NOT EXISTS idx_emails_created_at ON emails(created_at DESC);

-- 附件表
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  email_id TEXT NOT NULL,
  filename TEXT,
  content_type TEXT,
  size INTEGER,
  content BLOB,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (email_id) REFERENCES emails(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_attachments_email_id ON attachments(email_id);

