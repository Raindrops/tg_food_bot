-- Товары (расширенный справочник)
CREATE TABLE IF NOT EXISTS products (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  category        TEXT    NOT NULL DEFAULT '',
  custom_made     INTEGER NOT NULL DEFAULT 0,
  avg_weight      INTEGER NOT NULL DEFAULT 0,
  shelf_life_days INTEGER NOT NULL DEFAULT 7,
  kcal            REAL,
  proteins        REAL,
  fats            REAL,
  carbohydrates   REAL,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    DEFAULT (datetime('now'))
);

-- Варианты фасовки товара (из batch_variants)
CREATE TABLE IF NOT EXISTS product_variants (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  price       INTEGER NOT NULL,
  pieces      INTEGER,
  grams       INTEGER,
  ml          INTEGER
);

-- Партии
CREATE TABLE IF NOT EXISTS batches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id  INTEGER REFERENCES product_variants(id),
  product_id  INTEGER NOT NULL REFERENCES products(id),
  pieces      INTEGER NOT NULL DEFAULT 0,
  grams       INTEGER NOT NULL DEFAULT 0,
  produced_at TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT    NOT NULL,
  note        TEXT
);

-- Операции
CREATE TABLE IF NOT EXISTS operations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT    NOT NULL CHECK(type IN ('produced','sold','written_off')),
  product_id INTEGER NOT NULL REFERENCES products(id),
  batch_id   INTEGER REFERENCES batches(id),
  pieces     INTEGER NOT NULL DEFAULT 0,
  grams      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_products_category   ON products(category);
CREATE INDEX IF NOT EXISTS idx_variants_product     ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_batches_product      ON batches(product_id);
CREATE INDEX IF NOT EXISTS idx_batches_variant      ON batches(variant_id);
CREATE INDEX IF NOT EXISTS idx_batches_expires      ON batches(expires_at);
CREATE INDEX IF NOT EXISTS idx_ops_product          ON operations(product_id);
CREATE INDEX IF NOT EXISTS idx_ops_batch            ON operations(batch_id);
CREATE INDEX IF NOT EXISTS idx_ops_date             ON operations(created_at);
