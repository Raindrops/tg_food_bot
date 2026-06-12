DROP TABLE IF EXISTS operations;
DROP TABLE IF EXISTS batches;
DROP TABLE IF EXISTS product_variants;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS categories;

CREATE TABLE categories (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE products (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT    NOT NULL,
  category_id     INTEGER REFERENCES categories(id),
  custom_made     INTEGER NOT NULL DEFAULT 0,
  kcal            REAL,
  proteins        REAL,
  fats            REAL,
  carbohydrates   REAL,
  by_weight       INTEGER NOT NULL DEFAULT 0,
  archived        INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT    DEFAULT (datetime('now'))
);

CREATE TABLE product_variants (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  price       INTEGER NOT NULL,
  pieces      INTEGER,
  grams       INTEGER,
  ml          INTEGER
);

CREATE TABLE batches (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  variant_id  INTEGER REFERENCES product_variants(id),
  product_id  INTEGER NOT NULL REFERENCES products(id),
  pieces      INTEGER NOT NULL DEFAULT 0,
  grams       INTEGER NOT NULL DEFAULT 0,
  ml          INTEGER NOT NULL DEFAULT 0,
  produced_at TEXT    NOT NULL DEFAULT (datetime('now')),
  note        TEXT
);

CREATE TABLE operations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  type       TEXT    NOT NULL CHECK(type IN ('produced','sold','written_off')),
  product_id INTEGER NOT NULL REFERENCES products(id),
  batch_id   INTEGER REFERENCES batches(id),
  pieces     INTEGER NOT NULL DEFAULT 0,
  grams      INTEGER NOT NULL DEFAULT 0,
  ml         INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_categories_name  ON categories(name);
CREATE INDEX IF NOT EXISTS idx_products_cat     ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_variants_product ON product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_batches_product  ON batches(product_id);
CREATE INDEX IF NOT EXISTS idx_batches_variant  ON batches(variant_id);
CREATE INDEX IF NOT EXISTS idx_ops_product      ON operations(product_id);
CREATE INDEX IF NOT EXISTS idx_ops_batch        ON operations(batch_id);
CREATE INDEX IF NOT EXISTS idx_ops_date         ON operations(created_at);
