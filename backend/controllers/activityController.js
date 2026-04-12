const pool = require('../db');

function formatSizeGender(usSize, gender) {
  const size = String(usSize || '').trim();
  const g = String(gender || '').trim();
  return [size, g].filter(Boolean).join(' ');
}

async function getAvailableQtyMap(itemIds = []) {
  const ids = [...new Set((itemIds || []).map((id) => Number(id)).filter((id) => Number.isFinite(id)))];
  if (!ids.length) return new Map();

  const placeholders = ids.map(() => '?').join(', ');
  const [rows] = await pool.query(
    `SELECT item_id,
            COALESCE(SUM(CASE WHEN status = 'AVAILABLE' AND is_deleted = 0 THEN 1 ELSE 0 END), 0) AS available_count
     FROM pairs
     WHERE item_id IN (${placeholders})
     GROUP BY item_id`,
    ids
  );

  return new Map(rows.map((r) => [Number(r.item_id), Number(r.available_count || 0)]));
}

async function getActivity(req, res) {
  const limit = parseInt(req.query.limit || '50', 10);
  try {
    const [rows] = await pool.query(
      `SELECT al.*, i.item_name, i.colorway, p.us_size, p.gender, b.brand_name
       FROM activity_log al
       LEFT JOIN items i ON al.item_id = i.item_id
       LEFT JOIN pairs p ON al.pair_id = p.pair_id
       LEFT JOIN brands b ON i.brand_id = b.brand_id
       WHERE al.action_type NOT IN (
         'LOGIN', 'LOGOUT', 'REGISTER', 'UPDATE_PROFILE', 'CHANGE_PASSWORD',
         'CREATE_STAFF', 'CREATE_ADMIN', 'EDIT_STAFF', 'ACTIVATE_STAFF',
         'DEACTIVATE_STAFF', 'UPDATE_STAFF_ROLE', 'RESET_STAFF_PASSWORD'
       )
       ORDER BY al.timestamp DESC
       LIMIT ?`,
      [limit]
    );

    const missingQtyItemIds = rows
      .filter((r) => (r.quantity === null || r.quantity === undefined) && r.item_id !== null && r.item_id !== undefined)
      .map((r) => r.item_id);
    const qtyMap = await getAvailableQtyMap(missingQtyItemIds);

    const activity = rows.map((r) => {
      const pairLabel = formatSizeGender(r.us_size, r.gender);
      const fallbackQty = (r.item_id !== null && r.item_id !== undefined) ? (qtyMap.get(Number(r.item_id)) ?? 0) : null;
      return {
        log_id: r.log_id,
        timestamp: r.timestamp,
        action_type: r.action_type,
        item_display: r.item_name
          ? `${r.item_name}${r.colorway ? ' ' + r.colorway : ''}${pairLabel ? ' ' + pairLabel : ''}`
          : '',
        quantity: (r.quantity === null || r.quantity === undefined) ? fallbackQty : r.quantity,
        sold_price: r.sold_price,
        brand_name: r.brand_name
      };
    });
    return res.json({ activity });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch activity' });
  }
}

module.exports = { getActivity };
