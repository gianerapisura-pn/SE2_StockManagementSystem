const pool = require('../db');

async function getAvailableQtyByItemId(itemId) {
  const [[row]] = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN status = 'AVAILABLE' AND is_deleted = 0 THEN 1 ELSE 0 END), 0) AS available_count
     FROM pairs
     WHERE item_id = ?`,
    [itemId]
  );
  return Number(row.available_count || 0);
}

async function logActivity({ user_id, action_type, item_id = null, pair_id = null, quantity = null, sold_price = null, description = null }) {
  let resolvedQty = quantity;
  if ((resolvedQty === null || resolvedQty === undefined) && item_id !== null && item_id !== undefined) {
    try {
      resolvedQty = await getAvailableQtyByItemId(item_id);
    } catch (_err) {
      resolvedQty = null;
    }
  }

  await pool.query(
    `INSERT INTO activity_log (user_id, action_type, item_id, pair_id, quantity, sold_price, description)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [user_id, action_type, item_id, pair_id, resolvedQty, sold_price, description]
  );
}

module.exports = { logActivity };
