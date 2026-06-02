/**
 * Telegram Bot для учёта домашних полуфабрикатов
 * Cloudflare Workers + KV Storage
 *
 * KV структура:
 *   products          → JSON: { [id]: { name, unit_piece, unit_gram } }
 *   operations        → JSON: [ { type, productId, pieces, grams, date } ]
 *   state:{chatId}    → JSON: { step, data } — состояние диалога пользователя
 */

const COMMANDS = {
  START: '/start',
};

// ─── Главное меню ────────────────────────────────────────────────────────────

function mainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '📦 Товары', callback_data: 'menu_products' },
        { text: '📊 Остатки', callback_data: 'menu_report' },
      ],
      [
        { text: '➕ Произведено', callback_data: 'op_produced' },
        { text: '💰 Продано', callback_data: 'op_sold' },
        { text: '🗑 Списано', callback_data: 'op_written_off' },
      ],
    ],
  };
}

function mainMenuMessage() {
  return '👩‍🍳 *Главное меню*\n\nВыберите действие:';
}

// ─── Работа с KV ─────────────────────────────────────────────────────────────

async function getProducts(env) {
  const raw = await env.KV.get('products');
  return raw ? JSON.parse(raw) : {};
}

async function saveProducts(env, products) {
  await env.KV.put('products', JSON.stringify(products));
}

async function getOperations(env) {
  const raw = await env.KV.get('operations');
  return raw ? JSON.parse(raw) : [];
}

async function addOperation(env, operation) {
  const ops = await getOperations(env);
  ops.push({ ...operation, date: new Date().toISOString() });
  await env.KV.put('operations', JSON.stringify(ops));
}

async function getUserState(env, chatId) {
  const raw = await env.KV.get(`state:${chatId}`);
  return raw ? JSON.parse(raw) : { step: null, data: {} };
}

async function setUserState(env, chatId, state) {
  await env.KV.put(`state:${chatId}`, JSON.stringify(state), {
    expirationTtl: 600, // 10 минут — автоочистка зависших диалогов
  });
}

async function clearUserState(env, chatId) {
  await env.KV.delete(`state:${chatId}`);
}

// ─── Отчёт по остаткам ────────────────────────────────────────────────────────

async function buildReport(env) {
  const products = await getProducts(env);
  const operations = await getOperations(env);

  if (Object.keys(products).length === 0) {
    return '📊 *Остатки*\n\nТоваров пока нет. Добавьте товары через меню 📦 Товары.';
  }

  // Считаем итоги по каждому товару
  const totals = {};
  for (const id of Object.keys(products)) {
    totals[id] = { pieces: 0, grams: 0 };
  }

  for (const op of operations) {
    if (!totals[op.productId]) continue;
    const sign = op.type === 'produced' ? 1 : -1;
    totals[op.productId].pieces += sign * (op.pieces || 0);
    totals[op.productId].grams += sign * (op.grams || 0);
  }

  const lines = ['📊 *Текущие остатки*\n'];
  for (const [id, product] of Object.entries(products)) {
    const t = totals[id] || { pieces: 0, grams: 0 };
    const piecesStr = t.pieces >= 0 ? `${t.pieces} шт` : `⚠️ ${t.pieces} шт`;
    const gramsStr = t.grams >= 0 ? `${t.grams} г` : `⚠️ ${t.grams} г`;
    lines.push(`• *${product.name}*: ${piecesStr} / ${gramsStr}`);
  }

  lines.push('\n_Остаток = Произведено − Продано − Списано_');
  return lines.join('\n');
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
  return tgRequest(token, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'Markdown',
    ...extra,
  });
}

async function editMessage(token, chatId, messageId, text, extra = {}) {
  return tgRequest(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'Markdown',
    ...extra,
  });
}

async function answerCallback(token, callbackQueryId, text = '') {
  return tgRequest(token, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
  });
}

// ─── Построение клавиатуры выбора товара ─────────────────────────────────────

function productListKeyboard(products, callbackPrefix) {
  const buttons = Object.entries(products).map(([id, p]) => [
    { text: p.name, callback_data: `${callbackPrefix}:${id}` },
  ]);
  buttons.push([{ text: '↩️ Назад', callback_data: 'menu_main' }]);
  return { inline_keyboard: buttons };
}

// ─── Обработка операций (произведено / продано / списано) ─────────────────────

const OP_LABELS = {
  produced: { emoji: '➕', verb: 'Произведено', pastVerb: 'Добавлено' },
  sold: { emoji: '💰', verb: 'Продано', pastVerb: 'Записано' },
  written_off: { emoji: '🗑', verb: 'Списано', pastVerb: 'Списано' },
};

async function startOperation(token, env, chatId, msgId, opType) {
  const products = await getProducts(env);
  const label = OP_LABELS[opType];

  if (Object.keys(products).length === 0) {
    await editMessage(
      token, chatId, msgId,
      `${label.emoji} *${label.verb}*\n\nСначала добавьте товары через меню 📦 Товары.`,
      { inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'menu_main' }]] }
    );
    return;
  }

  await editMessage(
    token, chatId, msgId,
    `${label.emoji} *${label.verb}*\n\nВыберите товар:`,
    { reply_markup: productListKeyboard(products, `op_select:${opType}`) }
  );
}

// ─── Обработчик входящих обновлений ──────────────────────────────────────────

async function handleUpdate(update, env, token) {
  // ── Callback query (кнопки) ──────────────────────────────────────────────
  if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message.chat.id;
    const msgId = cb.message.message_id;
    const data = cb.data;

    await answerCallback(token, cb.id);

    // Главное меню
    if (data === 'menu_main') {
      await clearUserState(env, chatId);
      await editMessage(token, chatId, msgId, mainMenuMessage(), {
        reply_markup: mainMenuKeyboard(),
      });
      return;
    }

    // Отчёт
    if (data === 'menu_report') {
      const report = await buildReport(env);
      await editMessage(token, chatId, msgId, report, {
        reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'menu_main' }]] },
      });
      return;
    }

    // Меню товаров
    if (data === 'menu_products') {
      const products = await getProducts(env);
      const list = Object.values(products).map(p => `• ${p.name}`).join('\n') || '_Список пуст_';
      await editMessage(
        token, chatId, msgId,
        `📦 *Товары*\n\n${list}`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '➕ Добавить товар', callback_data: 'product_add' }],
              [{ text: '↩️ Назад', callback_data: 'menu_main' }],
            ],
          },
        }
      );
      return;
    }

    // Начать добавление товара
    if (data === 'product_add') {
      await setUserState(env, chatId, { step: 'add_product_name', data: {} });
      await editMessage(
        token, chatId, msgId,
        '📦 *Добавление товара*\n\nВведите название товара:',
        { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'menu_main' }]] } }
      );
      return;
    }

    // Начать операцию: произведено / продано / списано
    if (data === 'op_produced') { await startOperation(token, env, chatId, msgId, 'produced'); return; }
    if (data === 'op_sold') { await startOperation(token, env, chatId, msgId, 'sold'); return; }
    if (data === 'op_written_off') { await startOperation(token, env, chatId, msgId, 'written_off'); return; }

    // Выбор товара для операции: op_select:{opType}:{productId}
    if (data.startsWith('op_select:')) {
      const [, opType, productId] = data.split(':');
      const products = await getProducts(env);
      const product = products[productId];
      if (!product) return;

      const label = OP_LABELS[opType];
      await setUserState(env, chatId, { step: 'op_enter_pieces', data: { opType, productId, msgId } });
      await editMessage(
        token, chatId, msgId,
        `${label.emoji} *${label.verb}: ${product.name}*\n\nВведите количество в *штуках*:`,
        { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'menu_main' }]] } }
      );
      return;
    }

    return;
  }

  // ── Текстовые сообщения ──────────────────────────────────────────────────
  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();

    // /start — всегда сбрасываем состояние и показываем меню
    if (text === COMMANDS.START) {
      await clearUserState(env, chatId);
      await sendMessage(token, chatId, mainMenuMessage(), { reply_markup: mainMenuKeyboard() });
      return;
    }

    // Проверяем состояние диалога
    const state = await getUserState(env, chatId);

    // ── Добавление товара: шаг 1 — название ──────────────────────────────
    if (state.step === 'add_product_name') {
      if (text.length < 2) {
        await sendMessage(token, chatId, '⚠️ Название слишком короткое. Попробуйте ещё раз:');
        return;
      }
      await setUserState(env, chatId, { step: 'add_product_done', data: { name: text } });

      const products = await getProducts(env);
      const id = `p_${Date.now()}`;
      products[id] = { name: text };
      await saveProducts(env, products);
      await clearUserState(env, chatId);

      await sendMessage(
        token, chatId,
        `✅ Товар *${text}* добавлен!`,
        { reply_markup: mainMenuKeyboard() }
      );
      return;
    }

    // ── Операция: шаг 1 — штуки ──────────────────────────────────────────
    if (state.step === 'op_enter_pieces') {
      const pieces = parseInt(text, 10);
      if (isNaN(pieces) || pieces < 0) {
        await sendMessage(token, chatId, '⚠️ Введите целое число (штуки), например: `50`');
        return;
      }
      const newState = { step: 'op_enter_grams', data: { ...state.data, pieces } };
      await setUserState(env, chatId, newState);

      const products = await getProducts(env);
      const product = products[state.data.productId];
      const label = OP_LABELS[state.data.opType];

      await sendMessage(
        token, chatId,
        `${label.emoji} *${label.verb}: ${product.name}*\n✔️ Штук: ${pieces}\n\nТеперь введите вес в *граммах*:`,
        { reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'menu_main' }]] } }
      );
      return;
    }

    // ── Операция: шаг 2 — граммы ─────────────────────────────────────────
    if (state.step === 'op_enter_grams') {
      const grams = parseInt(text, 10);
      if (isNaN(grams) || grams < 0) {
        await sendMessage(token, chatId, '⚠️ Введите целое число (граммы), например: `2500`');
        return;
      }

      const { opType, productId, pieces } = state.data;
      await addOperation(env, { type: opType, productId, pieces, grams });
      await clearUserState(env, chatId);

      const products = await getProducts(env);
      const product = products[productId];
      const label = OP_LABELS[opType];

      await sendMessage(
        token, chatId,
        `✅ *${label.pastVerb}!*\n\n📌 ${product.name}\n• ${pieces} шт\n• ${grams} г`,
        { reply_markup: mainMenuKeyboard() }
      );
      return;
    }

    // Любое другое сообщение — показываем меню
    await sendMessage(token, chatId, mainMenuMessage(), { reply_markup: mainMenuKeyboard() });
  }
}

// ─── Cloudflare Worker entrypoint ─────────────────────────────────────────────

export default {
  async fetch(request, env) {
    // Проверка секретного токена в URL (?secret=XXX)
    const url = new URL(request.url);
    if (url.searchParams.get('secret') !== env.SECRET) {
      return new Response('Forbidden', { status: 403 });
    }

    if (request.method !== 'POST') {
      return new Response('OK');
    }

    try {
      const update = await request.json();
      await handleUpdate(update, env, env.BOT_TOKEN);
    } catch (e) {
      console.error('Error:', e);
    }

    return new Response('OK');
  },
};
