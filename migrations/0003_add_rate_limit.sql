-- 速率限制表
CREATE TABLE IF NOT EXISTS rate_limits (
  ip TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER DEFAULT 1,
  PRIMARY KEY (ip, endpoint, window_start)
);

-- 创建索引以便清理过期记录
CREATE INDEX IF NOT EXISTS idx_rate_limits_window ON rate_limits(window_start);
