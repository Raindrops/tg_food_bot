/**
 * Telegram Bot — учёт домашних полуфабрикатов
 * Cloudflare Workers + D1 + KV
 * v5 — каталог из JSON, категории, фасовки, OWNER_IDS
 */

import catalogData from '../msc/menu_pancakes_fixed.json' assert { type: 'json' };

const COMMANDS = { START: '/start' };

// ─── Меню ─────────────────────────────────────────────────────────────────────

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📦 Номенклатура', callback_data: 'menu_products' },
        { text: '📊 Склад',        callback_data: 'menu_report'   },
      ],
      [
        { text: '➕ Выпуск',       callback_data: 'op_produced'    },
        { text: '💰 Продажа',     callback_data: 'op_sold'        },
        { text: '🗑 Потери',      callback_data: 'op_written_off' },
      ],
      [
        { text: '📋 История',      callback_data: 'menu_history'  },
        { text: '📄 Отчет HTML',   callback_data: 'export_html'   },
      ],
    ],
  };
}

function mainMenuMessage() { return '👩‍🍳 *Главное меню*'; }
function backKeyboard()     { return { inline_keyboard: [[{ text: '↩️ Назад',  callback_data: 'menu_main' }]] }; }
function cancelKeyboard()   { return { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'menu_main' }]] }; }

// ─── D1: товары ───────────────────────────────────────────────────────────────

async function getProducts(env, includeArchived = false) {
  const sql = includeArchived
    ? `SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id ORDER BY p.archived, c.name, p.name`
    : `SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.archived = 0 ORDER BY c.name, p.name`;
  const { results } = await env.DB.prepare(sql).all();
  return results;
}

async function getProductById(env, id) {
  return env.DB.prepare(
    'SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?'
  ).bind(id).first();
}

async function getProductsByCategory(env, category, includeArchived = false) {
  const sql = includeArchived
    ? `SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE c.name = ? ORDER BY p.name`
    : `SELECT p.*, c.name AS category FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE c.name = ? AND p.archived = 0 ORDER BY p.name`;
  return (await env.DB.prepare(sql).bind(category).all()).results;
}

async function getCategories(env) {
  const { results } = await env.DB.prepare(
    'SELECT name FROM categories ORDER BY name'
  ).all();
  return results.map(r => r.name);
}

async function createProduct(env, name, categoryId, customMade, byWeight, kcal, proteins, fats, carbs) {
  return env.DB.prepare(
    `INSERT INTO products (name, category_id, custom_made, by_weight, kcal, proteins, fats, carbohydrates)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).bind(name, categoryId, customMade ? 1 : 0, byWeight ? 1 : 0, kcal ?? null, proteins ?? null, fats ?? null, carbs ?? null).first();
}

async function updateProduct(env, id, fields) {
  const set = Object.keys(fields).map(k => `${k} = ?`).join(', ');
  const vals = Object.values(fields);
  await env.DB.prepare(`UPDATE products SET ${set} WHERE id = ?`).bind(...vals, id).run();
}

async function archiveProduct(env, id) {
  await env.DB.prepare('UPDATE products SET archived = 1 WHERE id = ?').bind(id).run();
}

async function unarchiveProduct(env, id) {
  await env.DB.prepare('UPDATE products SET archived = 0 WHERE id = ?').bind(id).run();
}

// ─── D1: варианты фасовки ────────────────────────────────────────────────────

async function getVariants(env, productId) {
  const { results } = await env.DB.prepare(
    'SELECT * FROM product_variants WHERE product_id = ? ORDER BY price'
  ).bind(productId).all();
  return results;
}

async function getVariantById(env, id) {
  return env.DB.prepare('SELECT * FROM product_variants WHERE id = ?').bind(id).first();
}

async function createVariant(env, productId, price, pieces, grams, ml) {
  return env.DB.prepare(
    'INSERT INTO product_variants (product_id, price, pieces, grams, ml) VALUES (?, ?, ?, ?, ?) RETURNING *'
  ).bind(productId, price, pieces ?? null, grams ?? null, ml ?? null).first();
}

async function deleteVariant(env, id) {
  await env.DB.prepare('DELETE FROM product_variants WHERE id = ?').bind(id).run();
}

// ─── Загрузка каталога из JSON ────────────────────────────────────────────────

async function seedCatalog(env) {
  const { results } = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM categories').all();
  if (results[0].cnt > 0) return;

  for (const item of catalogData) {
    const cat = item.category ? await ensureCategory(env, item.category) : null;
    const product = await createProduct(
      env, item.name, cat?.id ?? null, item.custom_made, item.by_weight ?? false,
      item.nutritional_value_per_100g?.kcal,
      item.nutritional_value_per_100g?.proteins,
      item.nutritional_value_per_100g?.fats,
      item.nutritional_value_per_100g?.carbohydrates
    );
    for (const v of item.batch_variants) {
      await createVariant(env, product.id, v.price, v.pieces, v.grams, v.ml);
    }
  }
}

// ─── D1: партии ───────────────────────────────────────────────────────────────

async function createBatch(env, productId, pieces, grams, ml = 0) {
  return env.DB.prepare(
    'INSERT INTO batches (product_id, pieces, grams, ml) VALUES (?, ?, ?, ?) RETURNING *'
  ).bind(productId, pieces, grams, ml).first();
}

// ─── D1: операции ────────────────────────────────────────────────────────────

async function addOperation(env, type, productId, batchId, pieces, grams, ml = 0) {
  await env.DB.prepare(
    'INSERT INTO operations (type, product_id, batch_id, pieces, grams, ml) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(type, productId, batchId ?? null, pieces, grams, ml).run();
}

async function getProductStock(env, productId) {
  const row = await env.DB.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type='produced' THEN pieces ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type!='produced' THEN pieces ELSE 0 END), 0) AS pieces,
      COALESCE(SUM(CASE WHEN type='produced' THEN grams ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type!='produced' THEN grams ELSE 0 END), 0) AS grams,
      COALESCE(SUM(CASE WHEN type='produced' THEN ml ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN type!='produced' THEN ml ELSE 0 END), 0) AS ml
    FROM operations WHERE product_id = ?
  `).bind(productId).first();
  return row || { pieces: 0, grams: 0, ml: 0 };
}

async function filterInStock(env, products) {
  const result = [];
  for (const p of products) {
    const stock = await getProductStock(env, p.id);
    if ((stock.pieces || 0) > 0 || (stock.grams || 0) > 0 || (stock.ml || 0) > 0) result.push(p);
  }
  return result;
}

function getProductType(product, variants) {
  if (variants.length === 0) return { type: 'pieces', minBatch: null, mlPerPortion: null };
  if (product.by_weight) return { type: 'grams', minStep: 0.5 };
  const hasMl = variants.some(v => v.ml != null && v.ml > 0);
  if (hasMl) {
    const minBatch = Math.min(...variants.filter(v => v.ml).map(v => v.pieces || 1));
    return { type: 'pieces', minBatch, mlPerPortion: variants[0].ml };
  }
  const hasPieces = variants.some(v => v.pieces != null && v.pieces > 0);
  if (hasPieces) {
    const minBatch = Math.min(...variants.filter(v => v.pieces).map(v => v.pieces));
    return { type: 'pieces', minBatch, mlPerPortion: null };
  }
  return { type: 'pieces', minBatch: 1, mlPerPortion: null };
}

async function getHistory(env, limit = 20) {
  const { results } = await env.DB.prepare(`
    SELECT o.id, o.type, o.pieces, o.grams, o.ml, o.created_at,
           p.name AS product_name,
           EXISTS (SELECT 1 FROM product_variants WHERE product_id = p.id AND ml IS NOT NULL)     AS has_ml,
           EXISTS (SELECT 1 FROM product_variants WHERE product_id = p.id AND grams IS NOT NULL)  AS has_grams,
           EXISTS (SELECT 1 FROM product_variants WHERE product_id = p.id AND pieces IS NOT NULL) AS has_pieces
    FROM operations o
    JOIN products p ON p.id = o.product_id
    ORDER BY o.created_at DESC
    LIMIT ?
  `).bind(limit).all();
  return results;
}

// Суммарные остатки по товарам
async function getStockWithBatches(env) {
  const { results: stock } = await env.DB.prepare(`
    SELECT
      p.id, p.name, c.name AS category,
      COALESCE(SUM(CASE WHEN o.type='produced'    THEN o.pieces ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN o.type!='produced' THEN o.pieces ELSE 0 END), 0) AS pieces,
      COALESCE(SUM(CASE WHEN o.type='produced'    THEN o.grams  ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN o.type!='produced' THEN o.grams  ELSE 0 END), 0) AS grams,
      COALESCE(SUM(CASE WHEN o.type='produced'    THEN o.ml  ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN o.type!='produced' THEN o.ml  ELSE 0 END), 0) AS ml,
      EXISTS (SELECT 1 FROM product_variants WHERE product_id = p.id AND ml IS NOT NULL)     AS has_ml,
      EXISTS (SELECT 1 FROM product_variants WHERE product_id = p.id AND pieces IS NOT NULL) AS has_pieces,
      EXISTS (SELECT 1 FROM product_variants WHERE product_id = p.id AND grams IS NOT NULL)  AS has_grams
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN operations o ON o.product_id = p.id
    WHERE p.archived = 0
    GROUP BY p.id
    HAVING pieces != 0 OR grams != 0 OR ml != 0
    ORDER BY c.name, p.name
  `).all();

  return { stock };
}

async function getHistoryByPeriod(env, days = 30) {
  const { results } = await env.DB.prepare(`
    SELECT o.type, o.pieces, o.grams, o.ml, o.created_at,
           p.name AS product_name,
           EXISTS (SELECT 1 FROM product_variants WHERE product_id = p.id AND ml IS NOT NULL)     AS has_ml,
           EXISTS (SELECT 1 FROM product_variants WHERE product_id = p.id AND grams IS NOT NULL)  AS has_grams,
           EXISTS (SELECT 1 FROM product_variants WHERE product_id = p.id AND pieces IS NOT NULL) AS has_pieces
    FROM operations o
    JOIN products p ON p.id = o.product_id
    WHERE o.created_at >= datetime('now', ?)
    ORDER BY o.created_at DESC
  `).bind(`-${days} days`).all();
  return results;
}

// ─── Состояние диалога (KV) ───────────────────────────────────────────────────

async function getUserState(env, chatId) {
  const raw = await env.KV.get(`state:${chatId}`);
  return raw ? JSON.parse(raw) : { step: null, data: {} };
}

async function setUserState(env, chatId, state) {
  await env.KV.put(`state:${chatId}`, JSON.stringify(state), { expirationTtl: 600 });
}

async function clearUserState(env, chatId) {
  await env.KV.delete(`state:${chatId}`);
}

// ─── Форматирование ───────────────────────────────────────────────────────────

const CATEGORY_EMOJIS = {
  'Супы': '🥣',
  'Изделия из говядины': '🐄',
  'Изделия из курицы': '🐔',
  'Изделия из творога': '🥛',
  'Мясные изделия': '🥩',
  'Блинчики': '🥞',
  'Рыбная продукция': '🐟',
  'Прочее': '📦',
};

function catEmoji(category) {
  return CATEGORY_EMOJIS[category] || '📁';
}

function parseYesNo(text) {
  const t = text.toLowerCase().trim();
  if (['да','д','yes','y','1'].includes(t)) return true;
  if (['нет','н','no','n','0'].includes(t)) return false;
  return null;
}

function productCardText(product, variants) {
  const parts = [];
  if (product.kcal != null) parts.push(`${product.kcal} ккал`);
  const pps = [];
  if (product.proteins != null) pps.push(product.proteins);
  if (product.fats != null) pps.push(product.fats);
  if (product.carbohydrates != null) pps.push(product.carbohydrates);
  if (pps.length) parts.push(pps.join('/'));

  const vDetail = variants.map(v => {
    const d = v.pieces ? `${v.pieces} шт` : v.grams ? `${v.grams} г` : v.ml ? `${v.ml} мл` : '?';
    return `${d} — ${v.price} ₽`;
  }).join(', ');

  let text = `📦 *${product.name}*\n`;
  text += `📂 Категория: ${product.category ? `${catEmoji(product.category)} ${product.category}` : '—'}\n`;
  if (parts.length) text += `📊 КБЖУ: ${parts.join(' · ')}\n`;
  text += `📝 ${product.by_weight ? 'Весовой' : 'Штучный'} · На заказ: ${product.custom_made ? 'да' : 'нет'}\n`;
  if (variants.length) text += `🔄 Варианты: ${vDetail}`;
  return text;
}

async function finishAddProduct(env, chatId, state, token) {
  const { name, categoryId, byWeight, customMade, kcal, proteins, fats, carbs, variants } = state.data;
  const product = await createProduct(env, name, categoryId ?? null, customMade, byWeight, kcal, proteins, fats, carbs);
  for (const v of variants) {
    await createVariant(env, product.id, v.price, v.pieces || null, v.grams || null, v.ml || null);
  }
  await clearUserState(env, chatId);
  await editMessage(token, chatId, state.promptMsgId,
    `✅ Товар добавлен!\n\n📌 *${product.name}*`,
    { reply_markup: mainMenuKeyboard() });
}

const OP_LABELS = {
  produced:    { emoji: '➕', verb: 'Изготовить', pastVerb: 'Изготовлено', sign: '+' },
  sold:        { emoji: '💰', verb: 'Продать',    pastVerb: 'Продано',    sign: '-' },
  written_off: { emoji: '🗑', verb: 'Списать',    pastVerb: 'Списано',    sign: '-' },
};

function formatDate(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return `${String(d.getUTCDate()).padStart(2,'0')}.${String(d.getUTCMonth()+1).padStart(2,'0')}`;
}

function formatDateTime(isoStr) {
  if (!isoStr) return '—';
  const d = new Date(isoStr);
  return `${String(d.getUTCDate()).padStart(2,'0')}.${String(d.getUTCMonth()+1).padStart(2,'0')} ${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
}

async function ensureCategory(env, name) {
  let cat = await env.DB.prepare('SELECT * FROM categories WHERE name = ?').bind(name).first();
  if (!cat) {
    cat = await env.DB.prepare('INSERT INTO categories (name) VALUES (?) RETURNING *').bind(name).first();
  }
  return cat;
}

// ─── Текстовый отчёт по остаткам ─────────────────────────────────────────────

async function buildReport(env) {
  const { stock } = await getStockWithBatches(env);

  if (stock.length === 0) {
    return '📊 *Остатки*\n\nТоваров пока нет. Добавьте через 📦 Товары.';
  }

  const lines = ['📊 *Текущие остатки*\n'];
  let lastCat = '';
  for (const r of stock) {
    if (r.category && r.category !== lastCat) {
      lastCat = r.category;
      lines.push(`\n${catEmoji(r.category)} *${r.category}:*`);
    }

    let parts = [];
    if (r.has_ml) {
      parts.push(`${r.pieces} порций / ${(r.ml / 1000).toFixed(2)} л`);
    } else if (r.has_grams && r.has_pieces && r.grams > 0) {
      parts.push(`${r.pieces} шт / ${(r.grams / 1000).toFixed(2)} кг`);
    } else if (r.has_grams) {
      parts.push(`${(r.grams / 1000).toFixed(2)} кг`);
    } else {
      parts.push(`${r.pieces} шт`);
    }

    lines.push(`*${r.name}*: ${parts.join(' · ')}`);
  }

  return lines.join('\n');
}

// ─── Текстовая история ────────────────────────────────────────────────────────

async function buildHistoryText(env) {
  const rows = await getHistory(env, 20);
  if (rows.length === 0) return '📋 *История операций*\n\nОпераций пока нет.';

  const lines = ['📋 *Последние 20 операций*\n'];
  for (const r of rows) {
    const l = OP_LABELS[r.type];
    let detail;
    if (r.has_ml) detail = `${r.pieces} порций / ${(r.ml / 1000).toFixed(2)} л`;
    else if (r.has_grams && r.has_pieces && r.grams > 0) detail = `${r.pieces} шт / ${(r.grams / 1000).toFixed(2)} кг`;
    else if (r.has_grams) detail = `${(r.grams / 1000).toFixed(2)} кг`;
    else detail = `${r.pieces} шт`;
    lines.push(`${l.emoji} ${formatDateTime(r.created_at)} · *${r.product_name}* · ${l.sign}${detail}`);
  }
  return lines.join('\n');
}

// ─── HTML отчёт ───────────────────────────────────────────────────────────────

async function buildHtmlReport(env) {
  const { stock } = await getStockWithBatches(env);
  const history = await getHistoryByPeriod(env, 30);

  const now = new Date().toLocaleString('ru-RU', {
    timeZone: 'Asia/Vladivostok', day: '2-digit', month: '2-digit',
    year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  let totalKg = 0, totalL = 0;
  let lastCat = '';
  const stockRows = stock.map(r => {
    const catRow = (r.category && r.category !== lastCat)
      ? `<tr class="category-row"><td colspan="4"><strong>${catEmoji(r.category)} ${lastCat = r.category}</strong></td></tr>`
      : '';

    let pcsStr = '—', weightStr = '—', volumeStr = '—';
    if (r.has_ml) {
      pcsStr = `${r.pieces} порций`;
      volumeStr = `${(r.ml / 1000).toFixed(2)} л`;
      totalL += r.ml / 1000;
    } else if (r.has_grams && r.has_pieces && r.grams > 0) {
      pcsStr = `${r.pieces} шт`;
      weightStr = `${(r.grams / 1000).toFixed(2)} кг`;
      totalKg += r.grams / 1000;
    } else if (r.has_grams) {
      weightStr = `${(r.grams / 1000).toFixed(2)} кг`;
      totalKg += r.grams / 1000;
    } else {
      pcsStr = `${r.pieces} шт`;
    }

    const warn = r.pieces < 0;
    return `${catRow}<tr class="${warn ? 'warn' : ''}">
      <td>${r.name}</td>
      <td>${pcsStr}</td>
      <td>${weightStr}</td>
      <td>${volumeStr}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="empty">Нет данных</td></tr>';

  const totalRow = (totalKg > 0 || totalL > 0)
    ? `<tr class="total-row"><td><strong>Итого</strong></td><td>—</td><td>${totalKg > 0 ? totalKg.toFixed(2) + ' кг' : '—'}</td><td>${totalL > 0 ? totalL.toFixed(2) + ' л' : '—'}</td></tr>`
    : '';

  const historyRows = history.map(r => {
    const l = OP_LABELS[r.type];
    let detail;
    if (r.has_ml) detail = `${l.sign}${r.pieces} порций / ${(r.ml / 1000).toFixed(2)} л`;
    else if (r.has_grams && r.has_pieces && r.grams > 0) detail = `${l.sign}${r.pieces} шт / ${(r.grams / 1000).toFixed(2)} кг`;
    else if (r.has_grams) detail = `${l.sign}${(r.grams / 1000).toFixed(2)} кг`;
    else detail = `${l.sign}${r.pieces} шт`;
    return `<tr>
      <td>${formatDateTime(r.created_at)}</td>
      <td>${l.emoji} ${l.verb}</td>
      <td>${r.product_name}</td>
      <td>${detail}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="4" class="empty">Нет операций за 30 дней</td></tr>';

  return `<!DOCTYPE html>
<html lang="ru"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Отчёт — Остатки</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Nunito:wght@400;600;700;800&display=swap');
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Nunito',sans-serif;background:#f5f0eb;padding:24px 16px;color:#2d2d2d}
  h2{font-size:.9rem;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:.06em;margin:24px 0 10px}
  .card{max-width:800px;margin:0 auto}
  .header{background:linear-gradient(135deg,#e8826a,#d95f3b);color:#fff;padding:24px 28px;border-radius:16px 16px 0 0}
  .header h1{font-size:1.4rem;font-weight:800;margin-bottom:4px}
  .header p{font-size:.85rem;opacity:.85}
  .body{background:#fff;padding:24px 28px;border-radius:0 0 16px 16px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
  table{width:100%;border-collapse:collapse;font-size:.88rem;margin-bottom:8px}
  thead th{padding:9px 11px;text-align:left;font-weight:700;color:#aaa;font-size:.75rem;text-transform:uppercase;letter-spacing:.05em;border-bottom:2px solid #f0e8e0}
  tbody td{padding:11px 11px;border-bottom:1px solid #f5f0eb;vertical-align:top}
  tbody tr:last-child td{border-bottom:none}
  tbody tr:hover{background:#fdf8f5}
  tbody tr.warn td{color:#c0392b;background:#fff5f5}
  .category-row td{background:#fdf8f5;font-weight:700;color:#d95f3b;padding:6px 11px!important;border-bottom:2px solid #f0e8e0}
  .total-row td{font-weight:700;border-top:2px solid #d95f3b;padding:11px 11px}
  .empty{text-align:center;color:#ccc;padding:24px!important}
  .footer{margin-top:16px;font-size:.75rem;color:#bbb;text-align:center}
  @media print{body{background:#fff;padding:0}.header{border-radius:0}}
</style>
</head><body>
<div class="card">
  <div class="header">
    <h1>🥟 Отчёт по остаткам</h1>
    <p>Сформировано: ${now} VLAT</p>
  </div>
  <div class="body">
    <h2>Текущие остатки</h2>
    <table>
      <thead><tr><th>Товар</th><th>Шт</th><th>Вес</th><th>Объём</th></tr></thead>
      <tbody>${stockRows}</tbody>
      ${totalRow}
    </table>

    <h2>История за 30 дней</h2>
    <table>
      <thead><tr><th>Дата</th><th>Операция</th><th>Товар</th><th>Количество</th></tr></thead>
      <tbody>${historyRows}</tbody>
    </table>
    <div class="footer">Остаток = Произведено − Продано − Списано &nbsp;•&nbsp; Ctrl+P → Сохранить как PDF</div>
  </div>
</div>
</body></html>`;
}

// ─── Telegram API ─────────────────────────────────────────────────────────────

async function tgRequest(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendMessage(token, chatId, text, extra = {}) {
  return tgRequest(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...extra });
}

async function editMessage(token, chatId, messageId, text, extra = {}) {
  return tgRequest(token, 'editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'Markdown', ...extra });
}

async function deleteMessage(token, chatId, messageId) {
  return tgRequest(token, 'deleteMessage', { chat_id: chatId, message_id: messageId });
}

async function answerCallback(token, id, text = '') {
  return tgRequest(token, 'answerCallbackQuery', { callback_query_id: id, text });
}

async function sendHtmlDocument(token, chatId, html, filename) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', new Blob([html], { type: 'text/html' }), filename);
  form.append('caption', '📄 Откройте в браузере → Ctrl+P → Сохранить как PDF');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
  const json = await res.json();
  return json.ok ? json.result.message_id : null;
}

async function deleteDocMessage(env, chatId) {
  const key = `docMsg:${chatId}`;
  const msgId = await env.KV.get(key);
  if (msgId) { await env.KV.delete(key); } // удаляем ключ, сообщение удалим снаружи
  return msgId ? parseInt(msgId, 10) : null;
}

// ─── Клавиатуры ───────────────────────────────────────────────────────────────

function productListKeyboard(products, callbackPrefix, backData = 'menu_main', showCategoryHeaders = true) {
  let lastCat = '';
  const buttons = [];
  for (const p of products) {
    if (showCategoryHeaders && p.category && p.category !== lastCat) {
      lastCat = p.category;
      buttons.push([{ text: `${catEmoji(p.category)} ${p.category}`, callback_data: 'noop' }]);
    }
    buttons.push([{
      text: `${p.name}`,
      callback_data: `${callbackPrefix}:${p.id}`,
    }]);
  }
  buttons.push([{ text: '↩️ Назад', callback_data: backData }]);
  return { inline_keyboard: buttons };
}

async function opProductListKeyboard(env, products, callbackPrefix, backData = 'menu_main') {
  const buttons = [];
  for (const p of products) {
    const stock = await getProductStock(env, p.id);
    const vars  = await getVariants(env, p.id);
    let suffix = '';
    if (stock.ml > 0) {
      suffix = ` — ${stock.pieces} порций / ${(stock.ml / 1000).toFixed(2)} л`;
    } else if (p.by_weight && stock.grams > 0) {
      suffix = ` — ${(stock.grams / 1000).toFixed(2)} кг`;
    } else if (stock.grams > 0 && stock.pieces > 0) {
      suffix = ` — ${stock.pieces} шт / ${(stock.grams / 1000).toFixed(2)} кг`;
    } else if (stock.pieces > 0) {
      suffix = ` — ${stock.pieces} шт`;
    } else {
      suffix = ' — 0';
    }
    buttons.push([{ text: `${p.name}${suffix}`, callback_data: `${callbackPrefix}:${p.id}` }]);
  }
  buttons.push([{ text: '↩️ Назад', callback_data: backData }]);
  return { inline_keyboard: buttons };
}

function categoryListKeyboard(categories, opType) {
  const buttons = categories.map(c => [{
    text: `${catEmoji(c)} ${c}`,
    callback_data: `cat_select:${opType}:${c}`,
  }]);
  buttons.push([{ text: '↩️ Назад', callback_data: 'menu_main' }]);
  return { inline_keyboard: buttons };
}

function variantListKeyboard(variants, opTypePrefix, productId) {
  const buttons = variants.map(v => {
    const detail = v.pieces ? `${v.pieces} шт` : v.grams ? `${v.grams} г` : v.ml ? `${v.ml} мл` : '?';
    return [{
      text: `${detail} — ${v.price} ₽`,
      callback_data: `variant_select:${opTypePrefix}:${productId}:${v.id}`,
    }];
  });
  buttons.push([{ text: '↩️ Назад', callback_data: 'menu_main' }]);
  return { inline_keyboard: buttons };
}

// ─── Операции ─────────────────────────────────────────────────────────────────

async function startOperation(token, env, chatId, msgId, opType) {
  const label    = OP_LABELS[opType];
  let categories = await getCategories(env);

  if (categories.length === 0) {
    const products = opType === 'produced'
      ? await getProducts(env)
      : await filterInStock(env, await getProducts(env));
    if (products.length === 0) {
      const msg = opType === 'produced'
        ? 'Сначала добавьте товары через меню 📦 Товары.'
        : 'Нет товаров в наличии. Сначала добавьте производство.';
      await editMessage(token, chatId, msgId,
        `${label.emoji} *${label.verb}*\n\n${msg}`,
        { reply_markup: backKeyboard() });
      return;
    }
    await editMessage(token, chatId, msgId,
      `${label.emoji} *${label.verb}*`,
      { reply_markup: opType === 'produced'
        ? productListKeyboard(products, `op_select:${opType}`)
        : await opProductListKeyboard(env, products, `op_select:${opType}`) });
    return;
  }

  if (opType !== 'produced') {
    const inStockCategories = [];
    for (const c of categories) {
      const inStock = await filterInStock(env, await getProductsByCategory(env, c));
      if (inStock.length > 0) inStockCategories.push(c);
    }
    categories = inStockCategories;
    if (categories.length === 0) {
      await editMessage(token, chatId, msgId,
        `${label.emoji} *${label.verb}*\n\nНет категорий с товарами в наличии.`,
        { reply_markup: backKeyboard() });
      return;
    }
  }

  // Сначала показываем категории
  await editMessage(token, chatId, msgId,
    `${label.emoji} *${label.verb}*`,
    { reply_markup: categoryListKeyboard(categories, opType) });
}

async function startCategoryProducts(token, env, chatId, msgId, opType, category) {
  const label = OP_LABELS[opType];
  let products = await getProductsByCategory(env, category);
  if (opType !== 'produced') products = await filterInStock(env, products);
  if (products.length === 0) {
    const msg = opType === 'produced'
      ? 'В категории нет товаров.'
      : 'В категории нет товаров в наличии.';
    await editMessage(token, chatId, msgId,
      `${label.emoji} *${label.verb}*\n\n${msg}`,
      { reply_markup: backKeyboard() });
    return;
  }
  await editMessage(token, chatId, msgId,
    `${label.emoji} *${label.verb}: ${catEmoji(category)} ${category}*`,
    { reply_markup: opType === 'produced'
      ? productListKeyboard(products, `op_select:${opType}`, `cat_list:${opType}`, false)
      : await opProductListKeyboard(env, products, `op_select:${opType}`, `cat_list:${opType}`) });
}

// ─── Главный обработчик ───────────────────────────────────────────────────────

async function handleUpdate(update, env, token) {
  // Защита — только владельцы (OWNER_IDS — список ID через запятую)
  const chatId =
    update.callback_query?.message?.chat?.id ||
    update.message?.chat?.id;

  if (!chatId) return;

  const ownerList = (env.OWNER_IDS || env.OWNER_ID || '').split(',').map(s => s.trim()).filter(Boolean);
  if (ownerList.length && !ownerList.includes(String(chatId))) return;

  const todayStr = new Date().toISOString().slice(0, 10);

  // Автозагрузка каталога из JSON при первом обращении
  await seedCatalog(env);

  // ── Callback query ──────────────────────────────────────────────────────────
  if (update.callback_query) {
    const cb   = update.callback_query;
    const msgId = cb.message.message_id;
    const data  = cb.data;

    await answerCallback(token, cb.id);

    // Удаляем предыдущий документ (отчёт), если есть
    const prevDocId = await deleteDocMessage(env, chatId);
    if (prevDocId) try { await deleteMessage(token, chatId, prevDocId); } catch (_) {}

    // Главное меню
    if (data === 'menu_main') {
      await clearUserState(env, chatId);
      await editMessage(token, chatId, msgId, mainMenuMessage(), { reply_markup: mainMenuKeyboard() });
      return;
    }

    // Отчёт
    if (data === 'menu_report') {
      const report = await buildReport(env);
      await editMessage(token, chatId, msgId, report, { reply_markup: backKeyboard() });
      return;
    }

    // История
    if (data === 'menu_history') {
      const hist = await buildHistoryText(env);
      await editMessage(token, chatId, msgId, hist, { reply_markup: backKeyboard() });
      return;
    }

    // Экспорт
    if (data === 'export_html') {
      await editMessage(token, chatId, msgId, '⏳ Генерирую отчёт...', { reply_markup: backKeyboard() });
      const html = await buildHtmlReport(env);
      const docMsgId = await sendHtmlDocument(token, chatId, html, `остатки_${todayStr}.html`);
      if (docMsgId) await env.KV.put(`docMsg:${chatId}`, String(docMsgId));
      await editMessage(token, chatId, msgId, mainMenuMessage(), { reply_markup: mainMenuKeyboard() });
      return;
    }

    // Меню товаров — показываем категории
    if (data === 'menu_products') {
      const cats = await getCategories(env);
      if (cats.length === 0) {
        await editMessage(token, chatId, msgId, '📦 *Товары*\n\nНет категорий.', { reply_markup: backKeyboard() });
        return;
      }
      const buttons = cats.map(c => [{ text: `${catEmoji(c)} ${c}`, callback_data: `prod_cat_view:${c}` }]);
      buttons.push(
        [{ text: '📋 Все товары', callback_data: 'prod_all' }],
        [{ text: '↩️ Назад', callback_data: 'menu_main' }]
      );
      await editMessage(token, chatId, msgId, '📦 *Товары*', {
        reply_markup: { inline_keyboard: buttons },
      });
      return;
    }

    // Показать товары в категории (все, архивные помечены)
    if (data.startsWith('prod_cat_view:')) {
      const category = data.slice(14);
      const allProducts = await getProducts(env, true);
      const products = allProducts.filter(p => p.category === category);
      if (products.length === 0) {
        await editMessage(token, chatId, msgId,
          `📦 *${catEmoji(category)} ${category}*\n\n_Нет товаров_`,
          { reply_markup: { inline_keyboard: [
            [{ text: '➕ Добавить', callback_data: `product_add:${category}` }],
            [{ text: '↩️ Назад', callback_data: 'menu_products' }],
          ]}});
        return;
      }
      const buttons = products.map(p => [{
        text: `${p.name}${p.archived ? ' 🗄' : ''}`,
        callback_data: `view_product:${p.id}`,
      }]);
      buttons.push(
        [{ text: '➕ Добавить', callback_data: `product_add:${category}` }],
        [{ text: '↩️ Назад', callback_data: 'menu_products' }]
      );
      await editMessage(token, chatId, msgId,
        `📦 *${catEmoji(category)} ${category}*`,
        { reply_markup: { inline_keyboard: buttons } });
      return;
    }

    // Показать все товары (плоский список)
    if (data === 'prod_all') {
      const products = await getProducts(env, true);
      const active   = products.filter(p => !p.archived);
      const archived = products.filter(p => p.archived);

      let text = '📋 *Все товары*\n\n';
      if (active.length) {
        let lastCat = '';
        for (const p of active) {
          if (p.category && p.category !== lastCat) {
            lastCat = p.category;
            text += `\n${catEmoji(p.category)} *${p.category}:*\n`;
          }
          text += `• ${p.name}\n`;
        }
      } else {
        text += '_Нет активных товаров_';
      }
      if (archived.length) text += '\n\n*Архив:*\n' + archived.map(p => `• ${p.name}`).join('\n');

      await editMessage(token, chatId, msgId, text, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '↩️ Назад', callback_data: 'menu_products' }],
          ],
        },
      });
      return;
    }

    // Карточка товара
    if (data.startsWith('view_product:')) {
      const productId = parseInt(data.split(':')[1], 10);
      const product   = await getProductById(env, productId);
      if (!product) return;
      const variants  = await getVariants(env, productId);
      const stock     = await getProductStock(env, productId);
      const hasStock  = (stock.pieces || 0) > 0 || (stock.grams || 0) > 0 || (stock.ml || 0) > 0;

      let text = productCardText(product, variants);
      text += `\n\n📦 Остаток: `;
      if (stock.ml) text += `${stock.pieces} порций / ${(stock.ml / 1000).toFixed(2)} л`;
      else if (stock.grams) text += `${(stock.grams / 1000).toFixed(2)} кг`;
      else if (stock.pieces) text += `${stock.pieces} шт`;
      else text += '0';

      const buttons = [];
      if (product.archived) {
        buttons.push([{ text: '♻️ Восстановить', callback_data: `unarch_this_product:${product.id}` }]);
      } else {
        buttons.push([{ text: '🗄 Архивировать', callback_data: `arch_this_product:${product.id}` }]);
      }
      buttons.push([{ text: '✏️ Варианты', callback_data: `edit_variants:${product.id}` }]);
      const category = product.category || '';
      buttons.push([{ text: '↩️ Назад', callback_data: category ? `prod_cat_view:${category}` : 'menu_products' }]);

      await editMessage(token, chatId, msgId, text, { reply_markup: { inline_keyboard: buttons } });
      return;
    }

    // Архивировать из карточки товара
    if (data.startsWith('arch_this_product:')) {
      const productId = parseInt(data.split(':')[1], 10);
      const product   = await getProductById(env, productId);
      if (!product) return;
      const stock = await getProductStock(env, productId);
      if ((stock.pieces || 0) > 0 || (stock.grams || 0) > 0 || (stock.ml || 0) > 0) {
        await editMessage(token, chatId, msgId,
          `⚠️ Нельзя архивировать товар с остатками!\n\n📌 *${product.name}*`,
          { reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: `view_product:${product.id}` }]] } });
        return;
      }
      await archiveProduct(env, productId);
      await editMessage(token, chatId, msgId,
        `🗄 Товар *${product.name}* перемещён в архив.\nДанные сохранены.`,
        { reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: `view_product:${product.id}` }]] } });
      return;
    }

    // Разархивировать из карточки товара
    if (data.startsWith('unarch_this_product:')) {
      const productId = parseInt(data.split(':')[1], 10);
      const product   = await getProductById(env, productId);
      if (!product) return;
      await unarchiveProduct(env, productId);
      await editMessage(token, chatId, msgId,
        `✅ Товар *${product.name}* восстановлен из архива.`,
        { reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: `view_product:${product.id}` }]] } });
      return;
    }

    // Управление вариантами из карточки
    if (data.startsWith('edit_variants:')) {
      const productId = parseInt(data.split(':')[1], 10);
      const product   = await getProductById(env, productId);
      if (!product) return;
      const variants  = await getVariants(env, productId);
      let text = `✏️ *Варианты: ${product.name}*\n\n`;
      if (variants.length === 0) {
        text += '_Нет вариантов_';
      } else {
        for (const v of variants) {
          const detail = v.pieces ? `${v.pieces} шт` : '';
          const size = v.grams ? `${v.grams} г` : v.ml ? `${v.ml} мл` : '';
          text += `• ${[detail, size, `${v.price} ₽`].filter(Boolean).join(' / ')}\n`;
        }
      }
      const buttons = [];
      if (variants.length < 2) {
        buttons.push([{ text: '➕ Добавить вариант', callback_data: `add_var_from_card:${productId}` }]);
      }
      if (variants.length > 1) {
        for (const v of variants) {
          buttons.push([{ text: `🗑 Удалить ${v.pieces ? `${v.pieces} шт ` : ''}${v.price}₽`, callback_data: `del_variant:${v.id}:${productId}` }]);
        }
      }
      buttons.push([{ text: '↩️ Назад', callback_data: `view_product:${productId}` }]);
      await editMessage(token, chatId, msgId, text, { reply_markup: { inline_keyboard: buttons } });
      return;
    }

    // Добавить вариант из карточки
    if (data.startsWith('add_var_from_card:')) {
      const productId = parseInt(data.split(':')[1], 10);
      const product   = await getProductById(env, productId);
      if (!product) return;
      const variants  = await getVariants(env, productId);
      if (variants.length >= 2) {
        await editMessage(token, chatId, msgId,
          '⚠️ Максимум 2 варианта.',
          { reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: `edit_variants:${productId}` }]] } });
        return;
      }
      await setUserState(env, chatId, {
        step: product.by_weight ? 'add_var_card_vpieces' : 'add_var_card_vtype',
        data: { productId, byWeight: product.by_weight, currentVariant: { type: product.by_weight ? 'grams' : null } }, promptMsgId: msgId
      });
      if (product.by_weight) {
        await editMessage(token, chatId, msgId,
          '✏️ *Новый вариант*\n\nСколько *единиц товара* в порции? (целое число):',
          { reply_markup: cancelKeyboard() });
      } else {
        await editMessage(token, chatId, msgId,
          '✏️ *Новый вариант*\n\nВыберите *тип*:',
          { reply_markup: {
            inline_keyboard: [
              [{ text: 'Граммы', callback_data: 'add_var_vtype:grams' }],
              [{ text: 'Миллилитры', callback_data: 'add_var_vtype:ml' }],
              [{ text: '❌ Отмена', callback_data: `edit_variants:${productId}` }],
            ],
          }});
      }
      return;
    }

    // Добавление варианта из карточки — тип
    if (data.startsWith('add_var_vtype:')) {
      const state = await getUserState(env, chatId);
      if (state.step !== 'add_var_card_vtype') return;
      state.data.currentVariant = { type: data.slice(14) };
      state.step = 'add_var_card_vpieces';
      await setUserState(env, chatId, state);
      await editMessage(token, chatId, state.promptMsgId,
        '✏️ *Новый вариант*\n\nСколько *единиц товара* в порции? (целое число):',
        { reply_markup: cancelKeyboard() });
      return;
    }

    // Удалить вариант
    if (data.startsWith('del_variant:')) {
      const parts = data.split(':');
      const variantId = parseInt(parts[1], 10);
      const productId = parseInt(parts[2], 10);
      const variants = await getVariants(env, productId);
      if (variants.length <= 1) {
        await editMessage(token, chatId, msgId,
          '⚠️ Нельзя удалить единственный вариант.',
          { reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: `edit_variants:${productId}` }]] } });
        return;
      }
      await deleteVariant(env, variantId);
      await editMessage(token, chatId, msgId,
        `✅ Вариант удалён.`,
        { reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: `edit_variants:${productId}` }]] } });
      return;
    }

    // Заглушка для некликабельных элементов (категории и т.п.)
    if (data === 'noop') return;

    // Добавить товар — из категории (категория известна)
    if (data.startsWith('product_add:')) {
      const { categoryName } = { categoryName: data.slice(12) };
      const cat = await ensureCategory(env, categoryName);
      await setUserState(env, chatId, {
        step: 'add_product_name', data: { categoryId: cat.id, variants: [] }, promptMsgId: msgId
      });
      await editMessage(token, chatId, msgId,
        '📦 *Добавление товара — шаг 1*\n\nВведите *название* товара:',
        { reply_markup: cancelKeyboard() });
      return;
    }

    // Добавление — весовой да/нет
    if (data.startsWith('add_bw:')) {
      const state = await getUserState(env, chatId);
      if (state.step !== 'add_product_by_weight') return;
      state.data.byWeight = data.charAt(7) === '1';
      state.step = 'add_product_custom';
      await setUserState(env, chatId, state);
      await editMessage(token, chatId, state.promptMsgId,
        '📦 *Добавление товара — шаг 3*\n\nТовар *на заказ*?',
        { reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Да', callback_data: 'add_cust:1' }],
            [{ text: '❌ Нет', callback_data: 'add_cust:0' }],
            [{ text: '❌ Отмена', callback_data: 'menu_main' }],
          ],
        }});
      return;
    }

    // Добавление — на заказ да/нет
    if (data.startsWith('add_cust:')) {
      const state = await getUserState(env, chatId);
      if (state.step !== 'add_product_custom') return;
      state.data.customMade = data.charAt(9) === '1';
      state.step = 'add_product_kbju';
      await setUserState(env, chatId, state);
      await editMessage(token, chatId, state.promptMsgId,
        '📦 *Добавление товара — шаг 4*\n\nВведите *КБЖУ на 100г* в формате:\nкалории/белки/жиры/углеводы\n\nНапример: `210/11/8/24`\nИли отправьте «-» чтобы пропустить:',
        { reply_markup: cancelKeyboard() });
      return;
    }

    // Добавление — тип варианта (граммы/мл) для штучных
    if (data.startsWith('add_vtype:')) {
      const state = await getUserState(env, chatId);
      if (state.step !== 'add_product_vtype') return;
      state.data.currentVariant = { type: data.slice(10) }; // 'grams' or 'ml'
      state.step = 'add_product_vpieces';
      await setUserState(env, chatId, state);
      await editMessage(token, chatId, state.promptMsgId,
        '📦 *Добавление товара — вариант*\n\nСколько *единиц товара* в порции? (целое число):',
        { reply_markup: cancelKeyboard() });
      return;
    }

    // Добавление — добавить ещё один вариант?
    if (data.startsWith('add_more_v:')) {
      const state = await getUserState(env, chatId);
      if (state.step !== 'add_product_more_v') return;
      if (data.charAt(10) === '1') {
        state.step = state.data.byWeight ? 'add_product_vpieces' : 'add_product_vtype';
        await setUserState(env, chatId, state);
        if (state.data.byWeight) {
          await editMessage(token, chatId, state.promptMsgId,
            '📦 *Добавление товара — вариант 2*\n\nСколько *единиц товара* в порции? (целое число):',
            { reply_markup: cancelKeyboard() });
        } else {
          await editMessage(token, chatId, state.promptMsgId,
            '📦 *Добавление товара — вариант 2*\n\nВыберите *тип*:',
            { reply_markup: {
              inline_keyboard: [
                [{ text: 'Граммы', callback_data: 'add_vtype:grams' }],
                [{ text: 'Миллилитры', callback_data: 'add_vtype:ml' }],
                [{ text: '❌ Отмена', callback_data: 'menu_main' }],
              ],
            }});
        }
      } else {
        await finishAddProduct(env, chatId, state, token);
      }
      return;
    }

    // Начать операцию
    if (data === 'op_produced')    { await startOperation(token, env, chatId, msgId, 'produced');    return; }
    if (data === 'op_sold')        { await startOperation(token, env, chatId, msgId, 'sold');        return; }
    if (data === 'op_written_off') { await startOperation(token, env, chatId, msgId, 'written_off'); return; }

    // Выбор категории для операции
    if (data.startsWith('cat_select:')) {
      const [, opType, ...catParts] = data.split(':');
      const category = catParts.join(':');
      await startCategoryProducts(token, env, chatId, msgId, opType, category);
      return;
    }

    // Вернуться к списку категорий в операции
    if (data.startsWith('cat_list:')) {
      const [, opType] = data.split(':');
      await startOperation(token, env, chatId, msgId, opType);
      return;
    }

    // Выбор товара для операции
    if (data.startsWith('op_select:')) {
      const [, opType, productIdStr] = data.split(':');
      const productId = parseInt(productIdStr, 10);
      const product   = await getProductById(env, productId);
      if (!product) return;

      const variants = await getVariants(env, productId);
      const label = OP_LABELS[opType];

      if (opType === 'produced') {
        const { type, minBatch, mlPerPortion } = getProductType(product, variants);
        let gramsPerPiece = 0;
        if (type === 'pieces' && !mlPerPortion) {
          const v = variants.find(v => v.pieces && v.grams);
          if (v) gramsPerPiece = Math.round(v.grams / v.pieces);
        }
        await setUserState(env, chatId, {
          step: 'op_enter_pieces',
          data: { opType, productId, type, minBatch, mlPerPortion, gramsPerPiece },
          promptMsgId: msgId
        });
        if (type === 'grams') {
          await editMessage(token, chatId, msgId,
            `${label.emoji} *${label.verb}: ${product.name}*\n\nВведите вес в *кг* (например: 2.5; шаг 0.5 кг):`,
            { reply_markup: cancelKeyboard() });
        } else {
          const hint = mlPerPortion ? 'порций' : 'штук';
          const extra = minBatch ? ` (кратно ${minBatch})` : '';
          await editMessage(token, chatId, msgId,
            `${label.emoji} *${label.verb}: ${product.name}*\n\nВведите количество в *${hint}*${extra} (например: ${minBatch || 10}):`,
            { reply_markup: cancelKeyboard() });
        }
      } else {
        // Sold / Written off — show variants
        if (variants.length === 0) {
          await editMessage(token, chatId, msgId,
            `⚠️ У товара *${product.name}* нет вариантов для продажи.`,
            { reply_markup: backKeyboard() });
          return;
        }
        await editMessage(token, chatId, msgId,
          `${label.emoji} *${label.verb}: ${product.name}*\n\nВыберите вариант фасовки:`,
          { reply_markup: variantListKeyboard(variants, opType, productId) });
      }
      return;
    }

    // Выбор варианта фасовки для продажи/списания
    if (data.startsWith('variant_select:')) {
      const [, opType, productIdStr, variantIdStr] = data.split(':');
      const productId = parseInt(productIdStr, 10);
      const variantId = parseInt(variantIdStr, 10);
      const product   = await getProductById(env, productId);
      const variant   = await getVariantById(env, variantId);
      if (!product || !variant) return;

      const label = OP_LABELS[opType];
      const detail = variant.pieces ? `${variant.pieces} шт` : variant.grams ? `${variant.grams} г` : variant.ml ? `${variant.ml} мл` : '?';

      await setUserState(env, chatId, {
        step: 'op_enter_pieces',
        data: {
          opType, productId,
          variantId: variant.id,
          variantPkgPieces: variant.pieces,
          variantGrams: variant.grams,
          variantMl: variant.ml,
          type: variant.grams ? 'grams' : 'pieces'
        },
        promptMsgId: msgId
      });

      await editMessage(token, chatId, msgId,
        `${label.emoji} *${label.verb}: ${product.name}*\n📦 Фасовка: ${detail} — ${variant.price} ₽\n\nВведите количество *упаковок*:`,
        { reply_markup: cancelKeyboard() });
      return;
    }

    return;
  }

  // ── Текстовые сообщения ─────────────────────────────────────────────────────
  if (update.message) {
    const msg  = update.message;
    const text = (msg.text || '').trim();

    if (text === COMMANDS.START) {
      await clearUserState(env, chatId);
      await sendMessage(token, chatId, mainMenuMessage(), { reply_markup: mainMenuKeyboard() });
      return;
    }

    // Удаляем предыдущий документ (отчёт), если есть
    const prevDocId = await deleteDocMessage(env, chatId);
    if (prevDocId) try { await deleteMessage(token, chatId, prevDocId); } catch (_) {}

    const state = await getUserState(env, chatId);

    // Удаляем сообщение пользователя, чтобы инлайн-блок не сдвигался
    if (state.step) {
      try { await deleteMessage(token, chatId, msg.message_id); } catch (_) {}
    }

    // Добавление товара — шаг 1: название → весовой?
    if (state.step === 'add_product_name') {
      if (text.length < 2) {
        await editMessage(token, chatId, state.promptMsgId,
          '⚠️ Слишком короткое. Введите название:\n_Повторите ввод_',
          { reply_markup: cancelKeyboard() });
        return;
      }
      state.data.name = text;
      state.step = 'add_product_by_weight';
      await setUserState(env, chatId, state);
      await editMessage(token, chatId, state.promptMsgId,
        '📦 *Добавление товара — шаг 2*\n\nТовар *весовой*?',
        { reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Да', callback_data: 'add_bw:1' }],
            [{ text: '❌ Нет', callback_data: 'add_bw:0' }],
            [{ text: '❌ Отмена', callback_data: 'menu_main' }],
          ],
        }});
      return;
    }

    // Добавление товара — КБЖУ
    if (state.step === 'add_product_kbju') {
      let kcal, proteins, fats, carbs;
      if (text !== '-') {
        const parts = text.split(/[\/\s]+/).map(s => parseFloat(s.replace(',', '.')));
        kcal = parts[0] >= 0 ? parts[0] : null;
        proteins = parts[1] >= 0 ? parts[1] : null;
        fats = parts[2] >= 0 ? parts[2] : null;
        carbs = parts[3] >= 0 ? parts[3] : null;
      }
      state.data.kcal = kcal;
      state.data.proteins = proteins;
      state.data.fats = fats;
      state.data.carbs = carbs;
      // Переход к вариантам
      state.step = state.data.byWeight ? 'add_product_vpieces' : 'add_product_vtype';
      state.data.currentVariant = { type: state.data.byWeight ? 'grams' : null };
      await setUserState(env, chatId, state);
      if (state.data.byWeight) {
        await editMessage(token, chatId, state.promptMsgId,
          '📦 *Добавление товара — вариант*\n\nСколько *единиц товара* в порции? (целое число):',
          { reply_markup: cancelKeyboard() });
      } else {
        await editMessage(token, chatId, state.promptMsgId,
          '📦 *Добавление товара — вариант*\n\nВыберите *тип*:',
          { reply_markup: {
            inline_keyboard: [
              [{ text: 'Граммы', callback_data: 'add_vtype:grams' }],
              [{ text: 'Миллилитры', callback_data: 'add_vtype:ml' }],
              [{ text: '❌ Отмена', callback_data: 'menu_main' }],
            ],
          }});
      }
      return;
    }

    // Добавление товара — вариант: единиц в порции
    if (state.step === 'add_product_vpieces') {
      const quantity = parseInt(text, 10);
      if (isNaN(quantity) || quantity <= 0) {
        await editMessage(token, chatId, state.promptMsgId,
          '⚠️ Введите целое число больше 0\n_Повторите ввод_',
          { reply_markup: cancelKeyboard() });
        return;
      }
      state.data.currentVariant.pieces = quantity;
      state.step = 'add_product_vsize';
      await setUserState(env, chatId, state);
      const unit = state.data.currentVariant.type === 'ml' ? 'мл' : 'г';
      await editMessage(token, chatId, state.promptMsgId,
        `📦 *Добавление товара — вариант*\n\nУкажите *размер порции* в *${unit}* (например: 500):`,
        { reply_markup: cancelKeyboard() });
      return;
    }

    // Добавление товара — вариант: размер порции
    if (state.step === 'add_product_vsize') {
      const val = parseFloat(text.replace(',', '.'));
      if (isNaN(val) || val <= 0) {
        await editMessage(token, chatId, state.promptMsgId,
          '⚠️ Введите число больше 0\n_Повторите ввод_',
          { reply_markup: cancelKeyboard() });
        return;
      }
      const type = state.data.currentVariant.type;
      state.data.currentVariant[type] = Math.round(val);
      state.step = 'add_product_vprice';
      await setUserState(env, chatId, state);
      await editMessage(token, chatId, state.promptMsgId,
        '📦 *Добавление товара — вариант*\n\nУкажите *цену* в рублях (целое число):',
        { reply_markup: cancelKeyboard() });
      return;
    }

    // Добавление товара — вариант: цена
    if (state.step === 'add_product_vprice') {
      const price = parseInt(text, 10);
      if (isNaN(price) || price <= 0) {
        await editMessage(token, chatId, state.promptMsgId,
          '⚠️ Введите целое число больше 0\n_Повторите ввод_',
          { reply_markup: cancelKeyboard() });
        return;
      }
      state.data.currentVariant.price = price;
      state.data.variants.push({ ...state.data.currentVariant });
      state.data.currentVariant = { type: state.data.byWeight ? 'grams' : null };
      const variantCount = state.data.variants.length;
      if (variantCount < 2) {
        state.step = 'add_product_more_v';
        await setUserState(env, chatId, state);
        await editMessage(token, chatId, state.promptMsgId,
          '📦 *Добавление товара*\n\nДобавить *ещё один* вариант?',
          { reply_markup: {
            inline_keyboard: [
              [{ text: '✅ Да', callback_data: 'add_more_v:1' }],
              [{ text: '❌ Нет', callback_data: 'add_more_v:0' }],
            ],
          }});
      } else {
        await finishAddProduct(env, chatId, state, token);
      }
      return;
    }

    // Добавление варианта из карточки — единиц в порции
    if (state.step === 'add_var_card_vpieces') {
      const quantity = parseInt(text, 10);
      if (isNaN(quantity) || quantity <= 0) {
        await editMessage(token, chatId, state.promptMsgId,
          '⚠️ Введите целое число больше 0\n_Повторите ввод_',
          { reply_markup: cancelKeyboard() });
        return;
      }
      state.data.currentVariant = state.data.currentVariant || { type: 'grams' };
      state.data.currentVariant.pieces = quantity;
      state.step = 'add_var_card_vsize';
      await setUserState(env, chatId, state);
      const unit = state.data.currentVariant.type === 'ml' ? 'мл' : 'г';
      await editMessage(token, chatId, state.promptMsgId,
        `✏️ *Новый вариант*\n\nУкажите *размер порции* в *${unit}* (например: 500):`,
        { reply_markup: cancelKeyboard() });
      return;
    }

    // Добавление варианта из карточки — размер
    if (state.step === 'add_var_card_vsize') {
      const val = parseFloat(text.replace(',', '.'));
      if (isNaN(val) || val <= 0) {
        await editMessage(token, chatId, state.promptMsgId,
          '⚠️ Введите число больше 0\n_Повторите ввод_',
          { reply_markup: cancelKeyboard() });
        return;
      }
      const type = state.data.currentVariant.type || 'grams';
      state.data.currentVariant[type] = Math.round(val);
      state.step = 'add_var_card_vprice';
      await setUserState(env, chatId, state);
      await editMessage(token, chatId, state.promptMsgId,
        '✏️ *Новый вариант*\n\nУкажите *цену* в рублях (целое число):',
        { reply_markup: cancelKeyboard() });
      return;
    }

    // Добавление варианта из карточки — цена → создаём
    if (state.step === 'add_var_card_vprice') {
      const price = parseInt(text, 10);
      if (isNaN(price) || price <= 0) {
        await editMessage(token, chatId, state.promptMsgId,
          '⚠️ Введите целое число больше 0\n_Повторите ввод_',
          { reply_markup: cancelKeyboard() });
        return;
      }
      const { productId, currentVariant } = state.data;
      await createVariant(env, productId, price, currentVariant.pieces || null, currentVariant.grams || null, currentVariant.ml || null);
      await clearUserState(env, chatId);
      await editMessage(token, chatId, state.promptMsgId,
        `✅ Вариант добавлен!`,
        { reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: `edit_variants:${productId}` }]] } });
      return;
    }

    // Операция — ввод количества
    if (state.step === 'op_enter_pieces') {
      const { opType, productId, type, minBatch, minStep, mlPerPortion, gramsPerPiece,
              variantId, variantPkgPieces, variantGrams, variantMl } = state.data;

      // Парсинг и валидация
      let quantity;
      if (type === 'grams' && !variantGrams) {
        // Производство весового — ввод в кг
        quantity = parseFloat(text.replace(',', '.'));
        if (isNaN(quantity) || quantity <= 0) {
          await editMessage(token, chatId, state.promptMsgId,
            '⚠️ Введите число больше 0 (например: 2.5)\n_Повторите ввод_',
            { reply_markup: cancelKeyboard() });
          return;
        }
        if (!Number.isInteger(quantity * 2)) {
          await editMessage(token, chatId, state.promptMsgId,
            '⚠️ Вес должен быть кратен 0.5 кг (например: 1.0, 1.5, 2.0)\n_Повторите ввод_',
            { reply_markup: cancelKeyboard() });
          return;
        }
      } else {
        // Целое число (штуки, порции, упаковки)
        quantity = parseInt(text, 10);
        if (isNaN(quantity) || quantity <= 0) {
          await editMessage(token, chatId, state.promptMsgId,
            '⚠️ Введите целое число больше 0\n_Повторите ввод_',
            { reply_markup: cancelKeyboard() });
          return;
        }
        if (minBatch && quantity % minBatch !== 0) {
          await editMessage(token, chatId, state.promptMsgId,
            `⚠️ Количество должно быть кратно ${minBatch}\n_Повторите ввод_`,
            { reply_markup: cancelKeyboard() });
          return;
        }
      }

      const product = await getProductById(env, productId);

      // Расчёт pieces, grams и ml
      let pieces = 0;
      let grams  = 0;
      let ml     = 0;

      if (variantGrams) {
        grams   = quantity * variantGrams;
        pieces  = quantity;
      } else if (variantPkgPieces) {
        pieces  = quantity * variantPkgPieces;
      } else if (variantMl) {
        ml      = quantity * variantMl;
        pieces  = quantity;
      } else if (type === 'grams') {
        grams   = Math.round(quantity * 1000);
        pieces  = 0;
      } else if (mlPerPortion) {
        pieces  = quantity;
        ml      = quantity * mlPerPortion;
      } else if (gramsPerPiece) {
        pieces  = quantity;
        grams   = quantity * gramsPerPiece;
      } else {
        pieces  = quantity;
      }

      // Проверка остатка для продажи/списания
      if (opType !== 'produced') {
        const stock = await getProductStock(env, productId);
        let insufficient, stockDetail, reqDetail;
        if (variantMl || mlPerPortion) {
          insufficient = ml > (stock.ml || 0);
          stockDetail = `${(stock.ml / 1000).toFixed(2)} л`;
          reqDetail = `${(ml / 1000).toFixed(2)} л`;
        } else if (type === 'grams') {
          insufficient = grams > (stock.grams || 0);
          stockDetail = `${(stock.grams / 1000).toFixed(2)} кг`;
          reqDetail = `${(grams / 1000).toFixed(2)} кг`;
        } else {
          insufficient = pieces > (stock.pieces || 0);
          stockDetail = `${stock.pieces} шт`;
          reqDetail = `${pieces} шт`;
        }
        if (insufficient) {
          await editMessage(token, chatId, state.promptMsgId,
            `⚠️ Недостаточно остатка!\n\n📌 *${product.name}*\n📦 Доступно: ${stockDetail}\nЗапрошено: ${reqDetail}`,
            { reply_markup: backKeyboard() });
          await clearUserState(env, chatId);
          return;
        }
      }

      // Форматирование детали
      let detail;
      if (variantMl) {
        detail = `${pieces} порций / ${ml} мл`;
      } else if (variantGrams) {
        detail = `${pieces} шт / ${grams} г`;
      } else if (variantPkgPieces) {
        detail = `${pieces} шт`;
      } else if (ml > 0) {
        detail = `${pieces} порций / ${ml} мл`;
      } else if (type === 'grams') {
        detail = `${grams} г (${quantity} кг)`;
      } else if (grams > 0) {
        detail = `${pieces} шт / ${grams} г`;
      } else {
        detail = `${pieces} шт`;
      }

      if (opType === 'produced') {
        const batch = await createBatch(env, productId, pieces, grams, ml);
        await addOperation(env, 'produced', productId, batch.id, pieces, grams, ml);
        await clearUserState(env, chatId);
        await editMessage(token, chatId, state.promptMsgId,
          `✅ *Произведено!*\n\n📌 ${product.name}\n• ${detail}`,
          { reply_markup: mainMenuKeyboard() });
      } else {
        await addOperation(env, opType, productId, null, pieces, grams, ml);
        await clearUserState(env, chatId);
        const label = OP_LABELS[opType];
        await editMessage(token, chatId, state.promptMsgId,
          `✅ *${label.pastVerb}!*\n\n📌 ${product.name}\n• ${detail}`,
          { reply_markup: mainMenuKeyboard() });
      }
      return;
    }

    await sendMessage(token, chatId, mainMenuMessage(), { reply_markup: mainMenuKeyboard() });
  }
}

// ─── Cloudflare Worker entrypoint ─────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.searchParams.get('secret') !== env.SECRET) {
      return new Response('Forbidden', { status: 403 });
    }
    if (request.method !== 'POST') return new Response('OK');
    try {
      const update = await request.json();
      await handleUpdate(update, env, env.BOT_TOKEN);
    } catch (e) {
      console.error('Error:', e);
    }
    return new Response('OK');
  },
};
