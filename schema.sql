-- Товары
CREATE TABLE IF NOT EXISTS products (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  avg_weight      INTEGER NOT NULL,        -- средний вес 1 шт в граммах
  shelf_life_days INTEGER NOT NULL DEFAULT 7, -- срок годности в днях
  archived        INTEGER NOT NULL DEFAULT 0, -- 0=активен, 1=архив
  created_at      TEXT    DEFAULT (datetime('now'))
);

-- Партии
CREATE TABLE IF NOT EXISTS batches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  pieces      INTEGER NOT NULL DEFAULT 0,
  grams       INTEGER NOT NULL DEFAULT 0,
  produced_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT    NOT NULL,            -- produced_at + shelf_life_days
  note        TEXT                         -- необязательная заметка
);

-- Операции
CREATE TABLE IF NOT EXISTS operations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT    NOT NULL CHECK(type IN ('produced','sold','written_off')),
  product_id INTEGER NOT NULL REFERENCES products(id),
  batch_id   INTEGER REFERENCES batches(id), -- NULL только для 'produced'
  pieces     INTEGER NOT NULL DEFAULT 0,
  grams      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_batches_product    ON batches(product_id);
CREATE INDEX IF NOT EXISTS idx_batches_expires    ON batches(expires_at);
CREATE INDEX IF NOT EXISTS idx_ops_product        ON operations(product_id);
CREATE INDEX IF NOT EXISTS idx_ops_batch          ON operations(batch_id);
CREATE INDEX IF NOT EXISTS idx_ops_date           ON operations(created_at);
