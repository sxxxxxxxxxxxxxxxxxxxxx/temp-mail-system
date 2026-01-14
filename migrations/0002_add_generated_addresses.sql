-- 添加生成地址记录表，用于防止重复生成
CREATE TABLE IF NOT EXISTS generated_addresses (
  address TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

-- 创建索引以提高查询效率
CREATE INDEX IF NOT EXISTS idx_generated_addresses_created_at ON generated_addresses(created_at DESC);
