/**
 * Telegram Bot — учёт домашних полуфабрикатов
 * Cloudflare Workers + D1 + KV
 * v5 — каталог из JSON, категории, фасовки, OWNER_IDS
 */

import catalogData from '../msc/menu_english_keys.json' assert { type: 'json' };

const COMMANDS = { START: '/start' };

// ─── Меню ─────────────────────────────────────────────────────────────────────

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📦 Товары',       callback_data: 'menu_products' },
        { text: '📊 Остатки',      callback_data: 'menu_report'   },
      ],
      [
        { text: '➕ Произведено',  callback_data: 'op_produced'    },
        { text: '💰 Продано',      callback_data: 'op_sold'        },
        { text: '🗑 Списано',      callback_data: 'op_written_off' },
      ],
      [
        { text: '📋 История',      callback_data: 'menu_history'  },
        { text: '📄 Экспорт HTML', callback_data: 'export_html'   },
      ],
    ],
  };
}

function mainMenuMessage() { return '👩‍🍳 *Главное меню*\n\nВыберите действие:'; }
function backKeyboard()     { return { inline_keyboard: [[{ text: '↩️ Назад',  callback_data: 'menu_main' }]] }; }
function cancelKeyboard()   { return { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'menu_main' }]] }; }

// ─── D1: товары ───────────────────────────────────────────────────────────────

async function getProducts(env, includeArchived = false) {
  const sql = includeArchived
    ? 'SELECT * FROM products ORDER BY archived, category, name'
    : 'SELECT * FROM products WHERE archived = 0 ORDER BY category, name';
  const { results } = await env.DB.prepare(sql).all();
  return results;
}

async function getProductById(env, id) {
  return env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(id).first();
}

async function getProductsByCategory(env, category, includeArchived = false) {
  const sql = includeArchived
    ? 'SELECT * FROM products WHERE category = ? ORDER BY name'
    : 'SELECT * FROM products WHERE category = ? AND archived = 0 ORDER BY name';
  return (await env.DB.prepare(sql).bind(category).all()).results;
}

async function getCategories(env) {
  const { results } = await env.DB.prepare(
    'SELECT DISTINCT category FROM products WHERE archived = 0 AND category != \'\' ORDER BY category'
  ).all();
  return results.map(r => r.category);
}

async function createProduct(env, name, category, customMade, avgWeight, shelfLifeDays, kcal, proteins, fats, carbs) {
  return env.DB.prepare(
    `INSERT INTO products (name, category, custom_made, avg_weight, shelf_life_days, kcal, proteins, fats, carbohydrates)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
  ).bind(name, category || '', customMade ? 1 : 0, avgWeight || 0, shelfLifeDays || 7, kcal ?? null, proteins ?? null, fats ?? null, carbs ?? null).first();
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

// ─── Загрузка каталога из JSON ────────────────────────────────────────────────

let catalogSeeded = false;

async function seedCatalog(env) {
  if (catalogSeeded) return;
  const { results } = await env.DB.prepare('SELECT COUNT(*) AS cnt FROM products').all();
  if (results[0].cnt > 0) { catalogSeeded = true; return; }

  for (const item of catalogData) {
    const product = await createProduct(
      env, item.name, item.category, item.custom_made,
      0, 7,
      item.nutritional_value_per_100g?.kcal,
      item.nutritional_value_per_100g?.proteins,
      item.nutritional_value_per_100g?.fats,
      item.nutritional_value_per_100g?.carbohydrates
    );
    for (const v of item.batch_variants) {
      await createVariant(env, product.id, v.price, v.pieces, v.grams, v.ml);
    }
  }
  catalogSeeded = true;
}

// ─── D1: партии ───────────────────────────────────────────────────────────────

// Партии товара у которых ещё есть остаток (pieces > 0 после списаний)
async function getActiveBatches(env, productId) {
  const { results } = await env.DB.prepare(`
    SELECT
      b.id,
      b.product_id,
      b.produced_at,
      b.expires_at,
      b.note,
      b.pieces                                              AS total_pieces,
      b.grams                                               AS total_grams,
      b.pieces - COALESCE(SUM(o.pieces), 0)                AS remaining_pieces,
      b.grams  - COALESCE(SUM(o.grams),  0)                AS remaining_grams
    FROM batches b
    LEFT JOIN operations o
      ON o.batch_id = b.id AND o.type != 'produced'
    WHERE b.product_id = ?
    GROUP BY b.id
    HAVING remaining_pieces > 0
    ORDER BY b.produced_at ASC
  `).bind(productId).all();
  return results;
}

async function createBatch(env, productId, pieces, grams, expiresAt) {
  return env.DB.prepare(
    'INSERT INTO batches (product_id, pieces, grams, expires_at) VALUES (?, ?, ?, ?) RETURNING *'
  ).bind(productId, pieces, grams, expiresAt).first();
}

async function getBatchById(env, id) {
  return env.DB.prepare('SELECT * FROM batches WHERE id = ?').bind(id).first();
}

// ─── D1: операции ────────────────────────────────────────────────────────────

async function addOperation(env, type, productId, batchId, pieces, grams) {
  await env.DB.prepare(
    'INSERT INTO operations (type, product_id, batch_id, pieces, grams) VALUES (?, ?, ?, ?, ?)'
  ).bind(type, productId, batchId ?? null, pieces, grams).run();
}

async function getHistory(env, limit = 20) {
  const { results } = await env.DB.prepare(`
    SELECT o.id, o.type, o.pieces, o.grams, o.created_at,
           p.name AS product_name,
           b.produced_at AS batch_date
    FROM operations o
    JOIN products p ON p.id = o.product_id
    LEFT JOIN batches b ON b.id = o.batch_id
    ORDER BY o.created_at DESC
    LIMIT ?
  `).bind(limit).all();
  return results;
}

// Остатки суммарно + информация о партиях (для пометок)
async function getStockWithBatches(env) {
  // Суммарные остатки по товарам
  const { results: stock } = await env.DB.prepare(`
    SELECT
      p.id, p.name, p.category, p.avg_weight, p.shelf_life_days,
      COALESCE(SUM(CASE WHEN o.type='produced'    THEN o.pieces ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN o.type!='produced' THEN o.pieces ELSE 0 END), 0) AS pieces,
      COALESCE(SUM(CASE WHEN o.type='produced'    THEN o.grams  ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN o.type!='produced' THEN o.grams  ELSE 0 END), 0) AS grams
    FROM products p
    LEFT JOIN operations o ON o.product_id = p.id
    WHERE p.archived = 0
    GROUP BY p.id
    ORDER BY p.category, p.name
  `).all();

  // Партии с проблемами (истекают сегодня/завтра или уже просрочены)
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const tomorrowStr = new Date(now.getTime() + 86400000).toISOString().slice(0, 10);

  const { results: alertBatches } = await env.DB.prepare(`
    SELECT
      b.product_id,
      b.expires_at,
      b.pieces - COALESCE(SUM(o.pieces), 0) AS remaining_pieces
    FROM batches b
    LEFT JOIN operations o ON o.batch_id = b.id AND o.type != 'produced'
    WHERE b.expires_at <= ?
    GROUP BY b.id
    HAVING remaining_pieces > 0
    ORDER BY b.expires_at ASC
  `).bind(tomorrowStr + 'T23:59:59').all();

  return { stock, alertBatches, todayStr, tomorrowStr };
}

async function getHistoryByPeriod(env, days = 30) {
  const { results } = await env.DB.prepare(`
    SELECT o.type, o.pieces, o.grams, o.created_at,
           p.name AS product_name,
           b.produced_at AS batch_date, b.expires_at
    FROM operations o
    JOIN products p ON p.id = o.product_id
    LEFT JOIN batches b ON b.id = o.batch_id
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

const OP_LABELS = {
  produced:    { emoji: '➕', verb: 'Произведено', pastVerb: 'Добавлено', sign: '+' },
  sold:        { emoji: '💰', verb: 'Продано',     pastVerb: 'Записано',  sign: '-' },
  written_off: { emoji: '🗑', verb: 'Списано',     pastVerb: 'Списано',   sign: '-' },
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

function addDays(isoStr, days) {
  const d = new Date(isoStr);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

function batchStatusEmoji(expiresAt, todayStr) {
  const expDate = expiresAt.slice(0, 10);
  if (expDate < todayStr)  return '🔴'; // просрочена
  if (expDate === todayStr) return '🟠'; // истекает сегодня
  const tomorrow = new Date(todayStr);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  if (expDate === tomorrow.toISOString().slice(0, 10)) return '🟡'; // истекает завтра
  return '🟢';
}

// ─── Текстовый отчёт по остаткам ─────────────────────────────────────────────

async function buildReport(env) {
  const { stock, alertBatches, todayStr } = await getStockWithBatches(env);

  if (stock.length === 0) {
    return '📊 *Остатки*\n\nТоваров пока нет. Добавьте через 📦 Товары.';
  }

  // Группируем предупреждения по товарам
  const alerts = {};
  for (const b of alertBatches) {
    if (!alerts[b.product_id]) alerts[b.product_id] = [];
    alerts[b.product_id].push(b);
  }

  const lines = ['📊 *Текущие остатки*\n'];
  let lastCat = '';
  for (const r of stock) {
    if (r.category && r.category !== lastCat) {
      lastCat = r.category;
      lines.push(`\n*${r.category}:*`);
    }
    const kg = (r.grams / 1000).toFixed(2);
    const stockWarn = r.pieces < 0 ? '⚠️ ' : '';
    lines.push(`${stockWarn}*${r.name}*: ${r.pieces} шт · ${r.grams} г · ${kg} кг`);

    // Пометки по партиям
    if (alerts[r.id]) {
      for (const b of alerts[r.id]) {
        const emoji = batchStatusEmoji(b.expires_at, todayStr);
        const expDate = formatDate(b.expires_at);
        const isExpired = b.expires_at.slice(0, 10) < todayStr;
        const label = isExpired ? 'просрочена' : `истекает ${expDate}`;
        lines.push(`  ${emoji} Партия от ${formatDate(b.expires_at.slice(0,10) < todayStr ? b.expires_at : b.expires_at)}: ${label}, ${b.remaining_pieces} шт`);
      }
    }
  }

  lines.push('\n🟢 свежая  🟡 завтра  🟠 сегодня  🔴 просрочена');
  lines.push('_Остаток = Произведено − Продано − Списано_');
  return lines.join('\n');
}

// ─── Текстовая история ────────────────────────────────────────────────────────

async function buildHistoryText(env) {
  const rows = await getHistory(env, 20);
  if (rows.length === 0) return '📋 *История операций*\n\nОпераций пока нет.';

  const lines = ['📋 *Последние 20 операций*\n'];
  for (const r of rows) {
    const l = OP_LABELS[r.type];
    const batch = r.batch_date ? ` (партия ${formatDate(r.batch_date)})` : '';
    lines.push(`${l.emoji} ${formatDateTime(r.created_at)} · *${r.product_name}*${batch} · ${l.sign}${r.pieces} шт`);
  }
  return lines.join('\n');
}

// ─── HTML отчёт ───────────────────────────────────────────────────────────────

async function buildHtmlReport(env) {
  const { stock, alertBatches, todayStr } = await getStockWithBatches(env);
  const history = await getHistoryByPeriod(env, 30);

  const now = new Date().toLocaleString('ru-RU', {
    timeZone: 'UTC', day: '2-digit', month: '2-digit',
    year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

  const alerts = {};
  for (const b of alertBatches) {
    if (!alerts[b.product_id]) alerts[b.product_id] = [];
    alerts[b.product_id].push(b);
  }

  let lastCat = '';
  const stockRows = stock.map(r => {
    const catRow = (r.category && r.category !== lastCat)
      ? `<tr class="category-row"><td colspan="7"><strong>${lastCat = r.category}</strong></td></tr>`
      : '';
    const kg = (r.grams / 1000).toFixed(2);
    const warn = r.pieces < 0;
    let alertHtml = '';
    if (alerts[r.id]) {
      alertHtml = alerts[r.id].map(b => {
        const emoji = batchStatusEmoji(b.expires_at, todayStr);
        const isExpired = b.expires_at.slice(0,10) < todayStr;
        return `<div class="batch-alert">${emoji} Партия от ${formatDate(b.expires_at)}: ${isExpired ? 'просрочена' : 'истекает ' + formatDate(b.expires_at)}, ${b.remaining_pieces} шт</div>`;
      }).join('');
    }
    return `${catRow}<tr class="${warn ? 'warn' : ''}">
      <td>${r.name}${alertHtml}</td>
      <td>${r.category || '—'}</td>
      <td>${r.avg_weight || '—'}</td>
      <td>${r.shelf_life_days} дн</td>
      <td>${r.pieces}</td>
      <td>${r.grams}</td>
      <td>${kg}</td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">Нет данных</td></tr>';

  const historyRows = history.map(r => {
    const l = OP_LABELS[r.type];
    const kg = (r.grams / 1000).toFixed(2);
    const batch = r.batch_date ? `от ${formatDate(r.batch_date)}` : '—';
    return `<tr>
      <td>${formatDateTime(r.created_at)}</td>
      <td>${l.emoji} ${l.verb}</td>
      <td>${r.product_name}</td>
      <td>${batch}</td>
      <td>${l.sign}${r.pieces} шт</td>
      <td>${l.sign}${kg} кг</td>
    </tr>`;
  }).join('') || '<tr><td colspan="6" class="empty">Нет операций за 30 дней</td></tr>';

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
  .batch-alert{font-size:.8rem;color:#888;margin-top:4px}
  .category-row td{background:#fdf8f5;font-weight:700;color:#d95f3b;padding:6px 11px!important;border-bottom:2px solid #f0e8e0}
  .empty{text-align:center;color:#ccc;padding:24px!important}
  .legend{font-size:.8rem;color:#aaa;margin-top:8px}
  .footer{margin-top:16px;font-size:.75rem;color:#bbb;text-align:center}
  @media print{body{background:#fff;padding:0}.header{border-radius:0}}
</style>
</head><body>
<div class="card">
  <div class="header">
    <h1>🥟 Отчёт по остаткам</h1>
    <p>Сформировано: ${now} UTC</p>
  </div>
  <div class="body">
    <h2>Текущие остатки</h2>
    <table>
      <thead><tr><th>Товар</th><th>Категория</th><th>Вес/шт</th><th>Срок</th><th>Штук</th><th>Граммы</th><th>Кг</th></tr></thead>
      <tbody>${stockRows}</tbody>
    </table>
    <div class="legend">🟢 свежая &nbsp; 🟡 истекает завтра &nbsp; 🟠 истекает сегодня &nbsp; 🔴 просрочена</div>

    <h2>История за 30 дней</h2>
    <table>
      <thead><tr><th>Дата</th><th>Операция</th><th>Товар</th><th>Партия</th><th>Штук</th><th>Кг</th></tr></thead>
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

async function answerCallback(token, id, text = '') {
  return tgRequest(token, 'answerCallbackQuery', { callback_query_id: id, text });
}

async function sendHtmlDocument(token, chatId, html, filename) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('document', new Blob([html], { type: 'text/html' }), filename);
  form.append('caption', '📄 Откройте в браузере → Ctrl+P → Сохранить как PDF');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form });
  return res.json();
}

// ─── Клавиатуры ───────────────────────────────────────────────────────────────

function productListKeyboard(products, callbackPrefix) {
  let lastCat = '';
  const buttons = [];
  for (const p of products) {
    if (p.category && p.category !== lastCat) {
      lastCat = p.category;
      buttons.push([{ text: `— ${p.category} —`, callback_data: 'noop' }]);
    }
    const detail = p.avg_weight ? ` · ${p.avg_weight}г/шт` : '';
    buttons.push([{
      text: `${p.name}${detail}`,
      callback_data: `${callbackPrefix}:${p.id}`,
    }]);
  }
  buttons.push([{ text: '↩️ Назад', callback_data: 'menu_main' }]);
  return { inline_keyboard: buttons };
}

function batchListKeyboard(batches, opType, todayStr) {
  const buttons = batches.map(b => {
    const emoji = batchStatusEmoji(b.expires_at, todayStr);
    return [{
      text: `${emoji} Партия от ${formatDate(b.produced_at)} · ${b.remaining_pieces} шт · до ${formatDate(b.expires_at)}`,
      callback_data: `batch_select:${opType}:${b.id}`,
    }];
  });
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
  const products = await getProducts(env);
  const label    = OP_LABELS[opType];

  if (products.length === 0) {
    await editMessage(token, chatId, msgId,
      `${label.emoji} *${label.verb}*\n\nСначала добавьте товары через меню 📦 Товары.`,
      { reply_markup: backKeyboard() });
    return;
  }

  await editMessage(token, chatId, msgId,
    `${label.emoji} *${label.verb}*\n\nВыберите товар:`,
    { reply_markup: productListKeyboard(products, `op_select:${opType}`) });
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
      await sendHtmlDocument(token, chatId, html, `остатки_${todayStr}.html`);
      await editMessage(token, chatId, msgId, mainMenuMessage(), { reply_markup: mainMenuKeyboard() });
      return;
    }

    // Меню товаров
    if (data === 'menu_products') {
      const products = await getProducts(env, true);
      const active   = products.filter(p => !p.archived);
      const archived = products.filter(p => p.archived);

      let text = '📦 *Товары*\n\n';
      if (active.length) {
        let lastCat = '';
        for (const p of active) {
          if (p.category && p.category !== lastCat) {
            lastCat = p.category;
            text += `\n*${p.category}:*\n`;
          }
          const detail = p.avg_weight ? ` — ${p.avg_weight}г/шт · ${p.shelf_life_days} дн` : '';
          text += `• ${p.name}${detail}\n`;
        }
      } else {
        text += '_Нет активных товаров_';
      }
      if (archived.length) text += '\n\n*Архив:*\n' + archived.map(p => `• ${p.name}`).join('\n');

      await editMessage(token, chatId, msgId, text, {
        reply_markup: {
          inline_keyboard: [
            [{ text: '➕ Добавить товар',  callback_data: 'product_add'     }],
            [{ text: '🗄 Архивировать',    callback_data: 'product_archive'  }],
            [{ text: '♻️ Разархивировать', callback_data: 'product_unarchive'}],
            [{ text: '↩️ Назад',           callback_data: 'menu_main'        }],
          ],
        },
      });
      return;
    }

    // Заглушка для некликабельных элементов (категории и т.п.)
    if (data === 'noop') return;

    // Добавить товар
    if (data === 'product_add') {
      await setUserState(env, chatId, { step: 'add_product_name', data: {} });
      await editMessage(token, chatId, msgId,
        '📦 *Добавление товара*\n\nШаг 1 из 3\nВведите *название* товара:',
        { reply_markup: cancelKeyboard() });
      return;
    }

    // Архивировать товар — показываем список активных
    if (data === 'product_archive') {
      const products = await getProducts(env);
      if (products.length === 0) {
        await editMessage(token, chatId, msgId, '📦 Нет активных товаров.', { reply_markup: backKeyboard() });
        return;
      }
      await editMessage(token, chatId, msgId, '🗄 *Архивировать товар*\n\nВыберите товар:', {
        reply_markup: productListKeyboard(products, 'do_archive'),
      });
      return;
    }

    // Разархивировать — показываем список архивных
    if (data === 'product_unarchive') {
      const all      = await getProducts(env, true);
      const archived = all.filter(p => p.archived);
      if (archived.length === 0) {
        await editMessage(token, chatId, msgId, '📦 Архив пуст.', { reply_markup: backKeyboard() });
        return;
      }
      const buttons = archived.map(p => [{ text: p.name, callback_data: `do_unarchive:${p.id}` }]);
      buttons.push([{ text: '↩️ Назад', callback_data: 'menu_main' }]);
      await editMessage(token, chatId, msgId, '♻️ *Разархивировать товар*\n\nВыберите товар:', {
        reply_markup: { inline_keyboard: buttons },
      });
      return;
    }

    // Подтвердить архивацию
    if (data.startsWith('do_archive:')) {
      const productId = parseInt(data.split(':')[1], 10);
      const product   = await getProductById(env, productId);
      if (!product) return;
      await archiveProduct(env, productId);
      await editMessage(token, chatId, msgId,
        `🗄 Товар *${product.name}* перемещён в архив.\nДанные сохранены.`,
        { reply_markup: backKeyboard() });
      return;
    }

    // Подтвердить разархивацию
    if (data.startsWith('do_unarchive:')) {
      const productId = parseInt(data.split(':')[1], 10);
      const product   = await getProductById(env, productId);
      if (!product) return;
      await unarchiveProduct(env, productId);
      await editMessage(token, chatId, msgId,
        `✅ Товар *${product.name}* восстановлен из архива.`,
        { reply_markup: backKeyboard() });
      return;
    }

    // Начать операцию
    if (data === 'op_produced')    { await startOperation(token, env, chatId, msgId, 'produced');    return; }
    if (data === 'op_sold')        { await startOperation(token, env, chatId, msgId, 'sold');        return; }
    if (data === 'op_written_off') { await startOperation(token, env, chatId, msgId, 'written_off'); return; }

    // Выбор товара для операции
    if (data.startsWith('op_select:')) {
      const [, opType, productIdStr] = data.split(':');
      const productId = parseInt(productIdStr, 10);
      const product   = await getProductById(env, productId);
      if (!product) return;

      const variants = await getVariants(env, productId);
      const label = OP_LABELS[opType];

      if (opType === 'produced') {
        if (variants.length > 0) {
          // Если есть фасовки — показываем выбор варианта
          await editMessage(token, chatId, msgId,
            `${label.emoji} *${label.verb}: ${product.name}*\n\nВыберите вариант фасовки:`,
            { reply_markup: variantListKeyboard(variants, opType, productId) });
        } else {
          // Нет фасовок — сразу запрашиваем количество
          await setUserState(env, chatId, { step: 'op_enter_pieces', data: { opType, productId } });
          await editMessage(token, chatId, msgId,
            `${label.emoji} *${label.verb}: ${product.name}*\n\nВведите количество в *штуках*:`,
            { reply_markup: cancelKeyboard() });
        }
      } else {
        // Для продажи/списания — показываем список партий
        const batches = await getActiveBatches(env, productId);
        if (batches.length === 0) {
          await editMessage(token, chatId, msgId,
            `⚠️ У товара *${product.name}* нет активных партий.\nСначала добавьте производство.`,
            { reply_markup: backKeyboard() });
          return;
        }
        await setUserState(env, chatId, { step: 'op_enter_pieces', data: { opType, productId } });
        await editMessage(token, chatId, msgId,
          `${label.emoji} *${label.verb}: ${product.name}*\n\nВыберите партию:`,
          { reply_markup: batchListKeyboard(batches, opType, todayStr) });
      }
      return;
    }

    // Выбор варианта фасовки для операции
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
        data: { opType, productId, variantId, variantPkgPieces: variant.pieces, variantGrams: variant.grams, variantMl: variant.ml }
      });

      await editMessage(token, chatId, msgId,
        `${label.emoji} *${label.verb}: ${product.name}*\n📦 Фасовка: ${detail} — ${variant.price} ₽\n\nВведите количество *упаковок*:`,
        { reply_markup: cancelKeyboard() });
      return;
    }

    // Выбор партии для операции
    if (data.startsWith('batch_select:')) {
      const [, opType, batchIdStr] = data.split(':');
      const batchId = parseInt(batchIdStr, 10);
      const batch   = await getBatchById(env, batchId);
      if (!batch) return;

      const product = await getProductById(env, batch.product_id);
      const label   = OP_LABELS[opType];

      await setUserState(env, chatId, { step: 'op_enter_pieces', data: { opType, productId: batch.product_id, batchId } });
      await editMessage(token, chatId, msgId,
        `${label.emoji} *${label.verb}: ${product.name}*\n📦 Партия от ${formatDate(batch.produced_at)} · до ${formatDate(batch.expires_at)}\n\nВведите количество в *штуках*:`,
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

    const state = await getUserState(env, chatId);

    // Добавление товара — шаг 1: название
    if (state.step === 'add_product_name') {
      if (text.length < 2) {
        await sendMessage(token, chatId, '⚠️ Слишком короткое. Введите название:');
        return;
      }
      await setUserState(env, chatId, { step: 'add_product_weight', data: { name: text } });
      await sendMessage(token, chatId,
        `📦 *Добавление товара*\n\nШаг 2 из 3\nТовар: *${text}*\n\nВведите средний вес *одной штуки* в граммах:\n_Например: 20_`,
        { reply_markup: cancelKeyboard() });
      return;
    }

    // Добавление товара — шаг 2: вес
    if (state.step === 'add_product_weight') {
      const avgWeight = parseInt(text, 10);
      if (isNaN(avgWeight) || avgWeight <= 0) {
        await sendMessage(token, chatId, '⚠️ Введите целое число больше 0, например: `20`');
        return;
      }
      await setUserState(env, chatId, { step: 'add_product_shelf', data: { ...state.data, avgWeight } });
      await sendMessage(token, chatId,
        `📦 *Добавление товара*\n\nШаг 3 из 3\nТовар: *${state.data.name}*, ${avgWeight} г/шт\n\nВведите *срок годности* в днях:\n_Например: 5_`,
        { reply_markup: cancelKeyboard() });
      return;
    }

    // Добавление товара — шаг 3: срок годности
    if (state.step === 'add_product_shelf') {
      const shelfDays = parseInt(text, 10);
      if (isNaN(shelfDays) || shelfDays <= 0) {
        await sendMessage(token, chatId, '⚠️ Введите целое число больше 0, например: `5`');
        return;
      }
      const { name, avgWeight } = state.data;
      const product = await createProduct(env, name, '', false, avgWeight, shelfDays);
      await clearUserState(env, chatId);
      await sendMessage(token, chatId,
        `✅ Товар добавлен!\n\n📌 *${product.name}*\n⚖️ ${product.avg_weight} г/шт\n📅 Срок годности: ${product.shelf_life_days} дн`,
        { reply_markup: mainMenuKeyboard() });
      return;
    }

    // Операция — ввод штук
    if (state.step === 'op_enter_pieces') {
      const quantity = parseInt(text, 10);
      if (isNaN(quantity) || quantity <= 0) {
        await sendMessage(token, chatId, '⚠️ Введите целое число больше 0, например: `5`');
        return;
      }

      const { opType, productId, batchId, variantId, variantPkgPieces, variantGrams, variantMl } = state.data;
      const product = await getProductById(env, productId);

      // Расчёт: если указана фасовка — умножаем на количество упаковок
      let pieces = quantity;
      let grams  = 0;
      if (variantGrams) {
        grams = quantity * variantGrams;
        pieces = quantity; // количество упаковок
      } else if (variantPkgPieces) {
        pieces = quantity * variantPkgPieces;
        grams = 0;
      } else if (variantMl) {
        grams = quantity * variantMl; // храним мл в grams для совместимости
        pieces = quantity;
      } else {
        grams = quantity * (product.avg_weight || 0);
      }

      if (opType === 'produced') {
        const now       = new Date().toISOString();
        const expiresAt = addDays(now, product.shelf_life_days);
        const batch     = await createBatch(env, productId, pieces, grams, expiresAt);
        // Если production с фасовкой — проставляем variant_id в batch
        if (variantId) {
          await env.DB.prepare('UPDATE batches SET variant_id = ? WHERE id = ?').bind(variantId, batch.id).run();
        }
        await addOperation(env, 'produced', productId, batch.id, pieces, grams);
        await clearUserState(env, chatId);

        await sendMessage(token, chatId,
          `✅ *Произведено!*\n\n📌 ${product.name}\n• ${pieces} шт · ${grams} г\n📅 Партия до: ${formatDate(expiresAt)}`,
          { reply_markup: mainMenuKeyboard() });
      } else {
        const batch = await getBatchById(env, batchId);
        await addOperation(env, opType, productId, batchId, pieces, grams);
        await clearUserState(env, chatId);

        const label = OP_LABELS[opType];
        await sendMessage(token, chatId,
          `✅ *${label.pastVerb}!*\n\n📌 ${product.name}\n• ${pieces} шт · ${grams} г\n📦 Партия от ${formatDate(batch.produced_at)}`,
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
