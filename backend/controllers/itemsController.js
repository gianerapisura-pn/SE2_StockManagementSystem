const bcrypt = require('bcrypt');
const pool = require('../db');
const { logActivity } = require('../utils/logger');
const { recomputeItemStatus, isWaitingStock } = require('../utils/status');

async function logWaitingStockIfNeeded(userId, itemId, itemName, statusInfo) {
  if (!statusInfo || !statusInfo.changed || statusInfo.status !== 'WAITING_STOCK') return;

  await logActivity({
    user_id: userId,
    action_type: 'WAITING_STOCK',
    item_id: itemId,
    description: `Item moved to waiting stock (${itemName || `Item #${itemId}`})`
  });
}

function isArchivedView(req) {
  return String(req.query.view || 'active').toLowerCase() === 'archived';
}

async function getItems(req, res) {
  const search = req.query.search ? `%${req.query.search}%` : '%';
  const itemStatusFilter = isArchivedView(req) ? 'INACTIVE' : 'ACTIVE';

  try {
    const [rows] = await pool.query(
      `SELECT i.*, b.brand_name,
              SUM(CASE WHEN p.status = 'AVAILABLE' AND p.is_deleted = 0 THEN 1 ELSE 0 END) AS qty_available,
              SUM(CASE WHEN p.status = 'SOLD' AND p.is_deleted = 0 THEN 1 ELSE 0 END) AS qty_sold,
              SUM(CASE WHEN p.is_deleted = 0 THEN 1 ELSE 0 END) AS qty_total
       FROM items i
       JOIN brands b ON i.brand_id = b.brand_id
       LEFT JOIN pairs p ON p.item_id = i.item_id
       WHERE i.is_deleted = 0
         AND i.item_status = ?
         AND (
           i.item_name LIKE ? OR i.sku LIKE ? OR i.colorway LIKE ? OR b.brand_name LIKE ?
         )
       GROUP BY i.item_id
       ORDER BY i.created_at DESC`,
      [itemStatusFilter, search, search, search, search]
    );

    const items = [];
    for (const row of rows) {
      const qtyAvailable = Number(row.qty_available || 0);
      const qtySold = Number(row.qty_sold || 0);
      const qtyTotal = Number(row.qty_total || 0);
      const targetQty = Number(row.target_qty || 1);
      const computedStatus = isWaitingStock(qtyAvailable, targetQty) ? 'WAITING_STOCK' : 'IN_STOCK';
      const status = row.item_status === 'ACTIVE' ? computedStatus : row.status;

      if (row.item_status === 'ACTIVE' && row.status !== computedStatus) {
        await pool.query(
          `UPDATE items SET status = ?, updated_at = NOW() WHERE item_id = ?`,
          [computedStatus, row.item_id]
        );
      }

      items.push({
        ...row,
        target_qty: targetQty,
        qty_available: qtyAvailable,
        qty_sold: qtySold,
        qty_total: qtyTotal,
        status
      });
    }

    return res.json({ items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to fetch items' });
  }
}

async function createItem(req, res) {
  const { item_name, sku, colorway, brand_id, target_qty } = req.body;
  const parsedTargetQty = Number(target_qty);
  if (!item_name || !sku || !colorway || !brand_id || !Number.isFinite(parsedTargetQty) || parsedTargetQty < 1) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const [[dup]] = await pool.query('SELECT item_id FROM items WHERE sku = ? AND is_deleted = 0', [sku]);
    if (dup) return res.status(409).json({ error: 'Item with this SKU already exists' });

    const [result] = await pool.query(
      `INSERT INTO items (item_name, sku, colorway, brand_id, target_qty, status, item_status, last_movement_type, last_movement_at)
       VALUES (?, ?, ?, ?, ?, 'WAITING_STOCK', 'ACTIVE', 'CREATED', NOW())`,
      [item_name, sku, colorway, brand_id, Math.floor(parsedTargetQty)]
    );

    const itemId = result.insertId;

    await logActivity({
      user_id: req.session.user.user_id,
      action_type: 'ADD_ITEM',
      item_id: itemId,
      description: `Added item ${item_name}`
    });

    return res.json({ item_id: itemId });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to add item' });
  }
}

async function updateItem(req, res) {
  const { itemId } = req.params;
  const { item_name, colorway, brand_id, target_qty } = req.body;

  try {
    const parsedTargetQty = Number(target_qty);
    if (!item_name || !colorway || !brand_id || !Number.isFinite(parsedTargetQty) || parsedTargetQty < 1) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const [result] = await pool.query(
      `UPDATE items
       SET item_name = ?, colorway = ?, brand_id = ?, target_qty = ?, updated_at = NOW(), last_movement_type = 'EDITED', last_movement_at = NOW()
       WHERE item_id = ? AND is_deleted = 0 AND item_status = 'ACTIVE'`,
      [item_name, colorway, brand_id, Math.floor(parsedTargetQty), itemId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ error: 'Active item not found' });
    }

    await recomputeItemStatus(itemId);

    await logActivity({
      user_id: req.session.user.user_id,
      action_type: 'EDIT_ITEM',
      item_id: itemId,
      description: 'Edited item'
    });

    return res.json({ message: 'Item updated' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to edit item' });
  }
}

async function archiveItem(req, res) {
  const { itemId } = req.params;

  try {
    const [[item]] = await pool.query(
      `SELECT item_id, item_name, item_status
       FROM items
       WHERE item_id = ? AND is_deleted = 0`,
      [itemId]
    );

    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.item_status === 'INACTIVE') {
      return res.status(409).json({ error: 'Item is already archived' });
    }

    await pool.query(
      `UPDATE items SET item_status = 'INACTIVE', updated_at = NOW() WHERE item_id = ?`,
      [itemId]
    );

    await logActivity({
      user_id: req.session.user.user_id,
      action_type: 'ARCHIVE_ITEM',
      item_id: itemId,
      description: `Archived item ${item.item_name}`
    });

    return res.json({ message: 'Item archived' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to archive item' });
  }
}

async function restoreItem(req, res) {
  const { itemId } = req.params;

  try {
    const [[item]] = await pool.query(
      `SELECT item_id, item_name, item_status
       FROM items
       WHERE item_id = ? AND is_deleted = 0`,
      [itemId]
    );

    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.item_status === 'ACTIVE') {
      return res.status(409).json({ error: 'Item is already active' });
    }

    await pool.query(
      `UPDATE items SET item_status = 'ACTIVE', updated_at = NOW() WHERE item_id = ?`,
      [itemId]
    );

    await recomputeItemStatus(itemId);

    await logActivity({
      user_id: req.session.user.user_id,
      action_type: 'RESTORE_ITEM',
      item_id: itemId,
      description: `Restored item ${item.item_name}`
    });

    return res.json({ message: 'Item restored' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to restore item' });
  }
}

async function markItemSold(req, res) {
  const { itemId } = req.params;
  const { sold_price } = req.body || {};

  try {
    const [[item]] = await pool.query(
      `SELECT item_id, item_name, status, target_qty, item_status
       FROM items
       WHERE item_id = ? AND is_deleted = 0`,
      [itemId]
    );

    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.item_status !== 'ACTIVE') {
      return res.status(400).json({ error: 'Archived item cannot be sold.' });
    }

    const [[countRow]] = await pool.query(
      `SELECT
         SUM(CASE WHEN status = 'AVAILABLE' AND is_deleted = 0 THEN 1 ELSE 0 END) AS available_count,
         SUM(CASE WHEN is_deleted = 0 THEN 1 ELSE 0 END) AS total_count
       FROM pairs
       WHERE item_id = ?`,
      [itemId]
    );

    const availableCount = Number(countRow.available_count || 0);
    const waiting = isWaitingStock(availableCount, item.target_qty);

    if (waiting) {
      const statusInfo = await recomputeItemStatus(itemId);
      await logWaitingStockIfNeeded(req.session.user.user_id, itemId, item.item_name, statusInfo);
      return res.status(400).json({ error: 'This item is in Waiting Stock and cannot be sold yet until restocked.' });
    }

    const [[pair]] = await pool.query(
      `SELECT pair_id, selling_price
       FROM pairs
       WHERE item_id = ? AND status = 'AVAILABLE' AND is_deleted = 0
       ORDER BY created_at ASC, pair_id ASC
       LIMIT 1`,
      [itemId]
    );

    if (!pair) {
      const statusInfo = await recomputeItemStatus(itemId);
      await logWaitingStockIfNeeded(req.session.user.user_id, itemId, item.item_name, statusInfo);
      return res.status(400).json({ error: 'This item is in Waiting Stock and cannot be sold yet until restocked.' });
    }

    const priceToUse = sold_price || pair.selling_price;

    await pool.query(
      `UPDATE pairs SET status = 'SOLD', sold_at = NOW(), sold_price = ? WHERE pair_id = ?`,
      [priceToUse, pair.pair_id]
    );

    await pool.query(
      `UPDATE items SET last_movement_type = 'SOLD', last_movement_at = NOW() WHERE item_id = ?`,
      [itemId]
    );

    const statusInfo = await recomputeItemStatus(itemId);

    await logActivity({
      user_id: req.session.user.user_id,
      action_type: 'MARK_SOLD',
      item_id: itemId,
      pair_id: pair.pair_id,
      quantity: 1,
      sold_price: priceToUse,
      description: 'Pair marked sold via item endpoint'
    });

    await logWaitingStockIfNeeded(req.session.user.user_id, itemId, item.item_name, statusInfo);

    return res.json({ message: 'Item marked as sold successfully.' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to mark item as sold' });
  }
}

async function permanentDeleteItem(req, res) {
  const { itemId } = req.params;
  const adminPassword = String((req.body || {}).admin_password || '');

  try {
    if (!adminPassword) {
      return res.status(400).json({ error: 'Admin password is required to permanently delete an item.' });
    }

    const [[admin]] = await pool.query(
      `SELECT password_hash
       FROM users
       WHERE user_id = ? AND role = 'Admin' AND is_active = 1
       LIMIT 1`,
      [req.session.user.user_id]
    );

    if (!admin) {
      return res.status(403).json({ error: 'Only active Admin accounts can permanently delete items.' });
    }

    const validPassword = await bcrypt.compare(adminPassword, admin.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid admin password.' });
    }

    const [[item]] = await pool.query(
      `SELECT item_id, item_name, item_status
       FROM items
       WHERE item_id = ? AND is_deleted = 0`,
      [itemId]
    );

    if (!item) return res.status(404).json({ error: 'Item not found' });
    if (item.item_status !== 'INACTIVE') {
      return res.status(400).json({ error: 'Archive this item first before permanently deleting it.' });
    }

    await pool.query('UPDATE items SET is_deleted = 1 WHERE item_id = ?', [itemId]);
    await pool.query('UPDATE pairs SET is_deleted = 1 WHERE item_id = ?', [itemId]);

    await logActivity({
      user_id: req.session.user.user_id,
      action_type: 'DELETE_ITEM',
      item_id: itemId,
      description: `Deleted item permanently (${item.item_name})`
    });

    return res.json({ message: 'Item permanently deleted' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to delete item' });
  }
}

module.exports = {
  getItems,
  createItem,
  updateItem,
  archiveItem,
  restoreItem,
  markItemSold,
  permanentDeleteItem
};



