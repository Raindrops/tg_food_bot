# Архитектура Telegram-бота учёта полуфабрикатов

## 1. Обзор

Telegram-бот для учёта домашних полуфабрикатов (котлеты, блинчики, супы и т.д.).
Позволяет вести справочник товаров с категориями и фасовками, учитывать
производство/продажу/списание, смотреть остатки и выгружать HTML-отчёт.

---

## 2. Технологический стек

| Компонент          | Технология |
|--------------------|------------|
| Хостинг            | Cloudflare Workers |
| База данных        | Cloudflare D1 (SQLite-based) |
| Кэш состояний      | Cloudflare KV (TTL 600s) |
| Внешнее API        | Telegram Bot API (webhook) |
| Язык               | JavaScript (ES modules) |
| Деплой             | Wrangler CLI |
| Каталог товаров    | JSON-файл `msc/menu_pancakes_fixed.json` (импорт при первом запуске) |

---

## 3. Структура проекта

```
tg_food_bot/
├── docs/
│   └── ARCHITECTURE.md
├── msc/
│   └── menu_pancakes_fixed.json   # Каталог товаров (импорт)
├── src/
│   └── index.js                   # Основной код воркера
├── schema.sql                     # DDL для D1 (5 таблиц, индексы)
└── wrangler.toml                  # Конфиг Cloudflare Workers
```

---

## 4. База данных (D1)

### 4.1 Схема

```sql
categories (id, name)
    │
    └── products (id, name, category_id → categories.id,
    │                by_weight, custom_made,
    │                kcal, proteins, fats, carbohydrates,
    │                archived, created_at)
    │       │
    │       └── product_variants (id, product_id → products.id,
    │                             price, pieces, grams, ml)
    │
    └── batches (id, variant_id → product_variants.id,
                 product_id → products.id,
                 pieces, grams, ml, produced_at, note)
                    │
                    └── operations (id, type [produced/sold/written_off],
                                    product_id → products.id,
                                    batch_id → batches.id,
                                    pieces, grams, ml, created_at)
```

### 4.2 Таблицы

#### categories
| Поле | Тип | Описание |
|------|-----|----------|
| id | INTEGER PK | Автоинкремент |
| name | TEXT UNIQUE | Название категории |

#### products
| Поле | Тип | Описание |
|------|-----|----------|
| id | INTEGER PK | Автоинкремент |
| name | TEXT | Название товара |
| category_id | INTEGER → categories.id | Категория |
| custom_made | INTEGER (0/1) | На заказ (флаг) |
| by_weight | INTEGER (0/1) | Весовой (1) или штучный (0) |
| kcal, proteins, fats, carbohydrates | REAL | КБЖУ на 100г |
| archived | INTEGER (0/1) | 0 — активен, 1 — архив |
| created_at | TEXT | Дата создания |

#### product_variants
Варианты фасовки товара (из `batch_variants` в JSON-каталоге, макс. 2 на товар).

| Поле | Тип | Описание |
|------|-----|----------|
| id | INTEGER PK | Автоинкремент |
| product_id | INTEGER → products.id | Товар |
| price | INTEGER | Цена в рублях |
| pieces | INTEGER | Количество единиц в порции |
| grams | INTEGER | Вес в граммах (NULL если не применимо) |
| ml | INTEGER | Объём в мл (NULL если не применимо) |

Для каждого товара поля в варианте взаимоисключающие: срабатывает только grams
или ml. pieces указывается для штучных товаров.

#### batches
Партия товара (результат производства). Напрямую в UI не отображается.

| Поле | Тип | Описание |
|------|-----|----------|
| id | INTEGER PK | Автоинкремент |
| variant_id | INTEGER → product_variants.id | Вариант фасовки (опционально) |
| product_id | INTEGER → products.id | Товар |
| pieces | INTEGER | Количество единиц |
| grams | INTEGER | Вес в граммах |
| ml | INTEGER | Объём в мл |
| produced_at | TEXT | Дата производства |
| note | TEXT | Заметка (не используется в UI) |

#### operations
Движение товара (производство, продажа, списание).

| Поле | Тип | Описание |
|------|-----|----------|
| id | INTEGER PK | Автоинкремент |
| type | TEXT CHECK | `produced` / `sold` / `written_off` |
| product_id | INTEGER → products.id | Товар |
| batch_id | INTEGER → batches.id | Партия (для `produced`) |
| pieces | INTEGER | Количество штук |
| grams | INTEGER | Вес в граммах |
| ml | INTEGER | Объём в мл |
| created_at | TEXT | Дата операции |

### 4.3 Индексы

- `categories(name)` — быстрый поиск по имени
- `products(category_id)` — товары в категории
- `product_variants(product_id)` — варианты товара
- `batches(product_id)`, `batches(variant_id)` — партии по товару/варианту
- `operations(product_id)`, `operations(batch_id)`, `operations(created_at)` — история

### 4.4 Расчёт остатка

Остаток вычисляется через SUM по `operations`:

```
pieces_rem = SUM(produced.pieces) − SUM(sold+written_off.pieces)
grams_rem  = SUM(produced.grams)  − SUM(sold+written_off.grams)
ml_rem     = SUM(produced.ml)     − SUM(sold+written_off.ml)
```

Единица измерения определяется по типу товара:
- `by_weight=1` → grams
- variants с `ml IS NOT NULL` → ml
- variants с `pieces IS NOT NULL` → pieces/grams

Продажа/списание проверяют остаток в соответствующей единице (мл / г / шт).

---

## 5. Основные потоки (User Flows)

### 5.1 Главное меню

```
👩‍🍳 Главное меню
┌─────────────────────┬─────────────────────┐
│ 📦 Товары           │ 📊 Остатки          │
├─────────────────────┼─────────────────────┤
│ ➕ Изготовить       │ 💰 Продать          │
│ 🗑 Списать          │                     │
├─────────────────────┼─────────────────────┤
│ 📋 История          │ 📄 Экспорт HTML     │
└─────────────────────┴─────────────────────┘
```

### 5.2 Товары (menu_products)

```
📦 Товары → [Список категорий]
              ├── 🥣 Супы → [Кнопки товаров (все, архивные помечены 🗄)]
              │               ├── Нажать на товар → [Карточка товара]
              │               │                      ├── 🗄 Архивировать / ♻️ Восстановить
              │               │                      ├── ✏️ Варианты
              │               │                      └── ↩️ Назад
              │               ├── ➕ Добавить
              │               └── ↩️ Назад
              ├── ...
              └── 📋 Все товары → [Плоский текстовый список]
                                   └── ↩️ Назад
```

- **Карточка товара** — показывает категорию, КБЖУ, тип (весовой/штучный), на заказ,
  варианты фасовки, текущий остаток. Из карточки можно архивировать/восстановить
  и управлять вариантами.
- **Все товары** — плоский текст с группировкой по категориям.

### 5.3 Операции (produced / sold / written_off)

```
➕ Изготовить → [Категории] → [Товары с остатком >0]
              → [Ввод количества (кг / порции / штуки)]
              → ✅ Изготовлено

💰 Продать / 🗑 Списать → [Категории с товарами в наличии]
                        → [Товары с остатком >0]
                        → [Выбор варианта фасовки]
                        → [Ввод количества упаковок]
                        → ✅ Продано / ✅ Списано
```

Производство (➕):
- Весовые товары: ввод в кг (шаг 0.5)
- Штучные с мл: ввод порций, объём = порции × mlPerPortion (хранится в ml)
- Штучные с г: ввод штук, вес = штуки × gramsPerPiece (хранится в grams)

Продажа/списание:
- Выбор варианта фасовки (5 шт — 410₽ / 10 шт — 800₽ и т.д.)
- Ввод количества упаковок
- Проверка остатка по ml/grams/pieces
- Запись в `operations` без `batch_id`

### 5.4 Добавление товара (product_add)

Доступно только внутри категории, категория проставляется автоматически.

```
Шаг 1:  Название                        (текст)
Шаг 2:  Весовой?                        (Да / Нет)
Шаг 3:  На заказ?                       (Да / Нет)
Шаг 4:  КБЖУ на 100г (калории/б/ж/у)   (текст или пропуск)
Шаг 5:  [штучные] Тип: Граммы / Мл      (inline-кнопки)
        [весовые] → пропускается (grams по умолчанию)
Шаг 6:  Единиц в порции                  (целое число)
Шаг 7:  Размер порции (г / мл)          (число)
Шаг 8:  Цена                            (целое число, рубли)
  → предложение добавить второй вариант (макс. 2)
  → ✅ Товар добавлен + варианты
```

### 5.5 Управление вариантами (из карточки товара)

```
✏️ Варианты → [Список текущих вариантов]
               ├── ➕ Добавить вариант  (если < 2)
               ├── 🗑 Удалить вариант   (для каждого, если > 1)
               └── ↩️ Назад
```

### 5.6 Отчёты

- **📊 Остатки** — текстовый отчёт с группировкой по категориям,
  единицы (шт / кг / л) в зависимости от типа товара
- **📄 Экспорт HTML** — полноценный HTML-документ со стилями,
  колонки Шт / Вес / Объём, итоговая строка по кг и л

### 5.7 История (📋)

Последние 20 операций. Формат:
```
➕ 01.06 14:30 · Блинчики с творогом · +10 шт · 1.00 кг
💰 01.06 15:00 · Суп рисовый · -2 порций · 0.60 л
```

---

## 6. Машина состояний (Dialog State)

Хранится в **KV** с TTL 600 секунд (10 минут).
Ключ: `state:{chatId}`, значение — JSON.

```json
{
  "step": "add_product_name"
        | "add_product_by_weight"
        | "add_product_custom"
        | "add_product_kbju"
        | "add_product_vtype"
        | "add_product_vpieces"
        | "add_product_vsize"
        | "add_product_vprice"
        | "add_product_more_v"
        | "add_var_card_vtype"
        | "add_var_card_vpieces"
        | "add_var_card_vsize"
        | "add_var_card_vprice"
        | "op_enter_pieces"
        | null,
  "data": { ... },
  "promptMsgId": 12345
}
```

- `promptMsgId` — ID сообщения бота, которое содержит форму ввода.
  При ответе пользователя это сообщение редактируется (результат вместо формы),
  а не создаётся новое.

---

## 7. Callback-префиксы клавиатур

| Префикс | Назначение |
|---------|------------|
| `menu_main` | Главное меню |
| `menu_products` | Список категорий товаров |
| `menu_report` | Текстовый отчёт |
| `menu_history` | История операций |
| `export_html` | HTML-отчёт |
| `prod_cat_view:Name` | Товары в категории |
| `prod_all` | Все товары (текст) |
| `view_product:id` | Карточка товара |
| `arch_this_product:id` | Архивировать из карточки |
| `unarch_this_product:id` | Восстановить из карточки |
| `edit_variants:id` | Управление вариантами |
| `add_var_from_card:id` | Добавить вариант из карточки |
| `add_var_vtype:grams\|ml` | Выбор типа варианта (карточка) |
| `del_variant:vid:pid` | Удалить вариант |
| `product_add:Cat` | Добавить товар (категория известна) |
| `add_bw:1\|0` | Весовой да/нет |
| `add_cust:1\|0` | На заказ да/нет |
| `add_vtype:grams\|ml` | Выбор типа варианта (добавление) |
| `add_more_v:1\|0` | Добавить ещё один вариант? |
| `op_produced` / `op_sold` / `op_written_off` | Выбор операции |
| `cat_select:opType:Cat` | Категория для операции |
| `cat_list:opType` | Назад к списку категорий (операция) |
| `op_select:opType:id` | Выбор товара для операции |
| `variant_select:opType:pid:vid` | Выбор варианта фасовки |

---

## 8. Форматирование

### 8.1 Эмодзи категорий

```js
CATEGORY_EMOJIS = {
  'Супы': '🥣',
  'Изделия из говядины': '🐄',
  'Изделия из курицы': '🐔',
  'Изделия из творога': '🥛',
  'Мясные изделия': '🥩',
  'Блинчики': '🥞',
  'Рыбная продукция': '🐟',
  'Прочее': '📦',
}
```

### 8.2 Метки операций

```js
OP_LABELS = {
  produced:    { emoji: '➕', verb: 'Изготовить', pastVerb: 'Изготовлено', sign: '+' },
  sold:        { emoji: '💰', verb: 'Продать',    pastVerb: 'Продано',     sign: '-' },
  written_off: { emoji: '🗑', verb: 'Списать',    pastVerb: 'Списано',     sign: '-' },
}
```

---

## 9. Загрузка каталога (seedCatalog)

При первом обращении к боту проверяется наличие записей в `categories`.
Если таблица пуста, данные из `msc/menu_pancakes_fixed.json` загружаются в D1:

1. Для каждого товара создаётся/находится категория
2. Создаётся запись в `products` (category_id, by_weight, КБЖУ)
3. Для каждого `batch_variant` создаётся запись в `product_variants`

Флаг `catalogSeeded` предотвращает повторные проверки в рамках одного
холодного старта воркера.

---

## 10. Безопасность

- **SECRET** — параметр запроса (`?secret=...`), проверяется при каждом
  вызове webhook. Задаётся через `wrangler secret put SECRET`.
- **OWNER_IDS** — список Telegram ID через запятую. Бот игнорирует
  все запросы от других пользователей.
  Поддерживается обратная совместимость с `OWNER_ID`.

---

## 11. Развёртывание

```bash
# Создать/обновить секреты
npx wrangler secret put BOT_TOKEN
npx wrangler secret put SECRET
npx wrangler secret put OWNER_IDS

# Применить схему БД
npx wrangler d1 execute food_bot_db --file=schema.sql --remote

# Деплой
npx wrangler deploy
```

Worker URL: `https://food-bot.wof-frozen.workers.dev`

---

## 12. Webhook

```bash
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://food-bot.wof-frozen.workers.dev?secret=<SECRET>"
```

---

## 13. Примечания

- Все даты в БД и API — UTC. В HTML-отчёте время VLAT (UTC+10).
- Единица измерения товара определяется по `by_weight` и вариантам:
  `by_weight=1` → кг, variants с ml → мл, variants с pieces → шт.
- Категории без товаров в наличии не показываются при продаже/списании.
- Товары с нулевым остатком не показываются в отчёте и скрыты
  при выборе для продажи/списания.
- Удаление товаров не предусмотрено — только архивация (данные сохраняются).
  Архивировать можно только при нулевом остатке.
- Архив/разархив — только из карточки товара (нет отдельных кнопок в справочнике).
