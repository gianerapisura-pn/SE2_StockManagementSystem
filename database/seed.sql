USE db_1800soles_stock_management;

DELETE FROM activity_log;
DELETE FROM pairs;
DELETE FROM items;
DELETE FROM password_resets;
-- Intentionally do not delete users.
-- This allows the project to run with zero default users.
-- while preserving any real users that already registered.

SET @adidas := (SELECT brand_id FROM brands WHERE brand_name='Adidas');
SET @nike := (SELECT brand_id FROM brands WHERE brand_name='Nike');

INSERT INTO items (item_name, sku, colorway, brand_id, target_qty, item_condition, status, last_movement_type, last_movement_at)
VALUES
('Jordan 4', 'DC7770-160', 'Sail', @nike, 10, 'Brand New', 'IN_STOCK', 'SOLD', '2026-04-20 10:11:00'),
('Spezial', 'ADI-SPZL-001', 'Core Black', @adidas, 10, 'Brand New', 'IN_STOCK', 'STOCK_IN', '2026-04-20 09:05:00');

SET @item1 := (SELECT item_id FROM items WHERE sku='DC7770-160');
SET @item2 := (SELECT item_id FROM items WHERE sku='ADI-SPZL-001');

INSERT INTO pairs (pair_code, item_id, us_size, gender, pair_condition, cost_price, selling_price, status, sold_at, sold_price)
VALUES
('P-001', @item1, '8', 'Male', 'New', 2400.00, 3200.00, 'AVAILABLE', NULL, NULL),
('P-002', @item1, '8', 'Male', 'New', 2400.00, 3200.00, 'AVAILABLE', NULL, NULL),
('P-003', @item1, '8', 'Male', 'New', 2400.00, 3200.00, 'AVAILABLE', NULL, NULL),
('P-004', @item1, '8.5', 'Male', 'New', 2400.00, 3200.00, 'AVAILABLE', NULL, NULL),
('P-005', @item1, '8.5', 'Male', 'New', 2400.00, 3200.00, 'AVAILABLE', NULL, NULL),
('P-006', @item1, '8.5', 'Male', 'New', 2400.00, 3200.00, 'AVAILABLE', NULL, NULL),
('P-007', @item1, '9', 'Male', 'New', 2400.00, 3200.00, 'AVAILABLE', NULL, NULL),
('P-008', @item1, '9', 'Male', 'New', 2400.00, 3200.00, 'AVAILABLE', NULL, NULL),
('P-009', @item1, '9', 'Male', 'New', 2400.00, 3200.00, 'AVAILABLE', NULL, NULL),
('P-018', @item1, '8.5', 'Male', 'New', 2400.00, 3200.00, 'SOLD', '2026-04-19 10:10:00', 3200.00),
('P-019', @item1, '9', 'Male', 'New', 2400.00, 3200.00, 'SOLD', '2026-04-20 10:11:00', 3200.00),
('P-010', @item2, '8', 'Male', 'New', 2500.00, 3300.00, 'AVAILABLE', NULL, NULL),
('P-011', @item2, '8', 'Male', 'New', 2500.00, 3300.00, 'AVAILABLE', NULL, NULL),
('P-012', @item2, '8', 'Male', 'New', 2500.00, 3300.00, 'AVAILABLE', NULL, NULL),
('P-013', @item2, '8.5', 'Male', 'New', 2500.00, 3300.00, 'AVAILABLE', NULL, NULL),
('P-014', @item2, '8.5', 'Male', 'New', 2500.00, 3300.00, 'AVAILABLE', NULL, NULL),
('P-015', @item2, '8.5', 'Male', 'New', 2500.00, 3300.00, 'AVAILABLE', NULL, NULL),
('P-016', @item2, '9', 'Male', 'New', 2500.00, 3300.00, 'AVAILABLE', NULL, NULL),
('P-017', @item2, '9', 'Male', 'New', 2500.00, 3300.00, 'AVAILABLE', NULL, NULL);

-- Optional activity seed: inserts only if at least one user exists.
-- This avoids FK errors when running with zero default users.
SET @seed_user := (SELECT user_id FROM users ORDER BY created_at ASC LIMIT 1);

INSERT INTO activity_log (user_id, action_type, item_id, pair_id, quantity, sold_price, description, timestamp)
SELECT
  @seed_user,
  src.action_type,
  src.item_id,
  src.pair_id,
  src.quantity,
  src.sold_price,
  src.description,
  src.timestamp
FROM (
  SELECT 'STOCK_IN' AS action_type, @item1 AS item_id, (SELECT pair_id FROM pairs WHERE pair_code='P-001') AS pair_id, 1 AS quantity, NULL AS sold_price, 'Stocked in Jordan 4 pair P-001' AS description, '2026-04-18 09:00:00' AS timestamp
  UNION ALL
  SELECT 'STOCK_IN', @item1, (SELECT pair_id FROM pairs WHERE pair_code='P-002'), 1, NULL, 'Stocked in Jordan 4 pair P-002', '2026-04-19 09:01:00'
  UNION ALL
  SELECT 'STOCK_IN', @item2, (SELECT pair_id FROM pairs WHERE pair_code='P-010'), 1, NULL, 'Stocked in Spezial pair P-010', '2026-04-19 09:05:00'
  UNION ALL
  SELECT 'STOCK_IN', @item2, (SELECT pair_id FROM pairs WHERE pair_code='P-011'), 1, NULL, 'Stocked in Spezial pair P-011', '2026-04-20 09:06:00'
  UNION ALL
  SELECT 'MARK_SOLD', @item1, (SELECT pair_id FROM pairs WHERE pair_code='P-018'), 1, 3200.00, 'Sold Jordan 4 pair P-018', '2026-04-19 10:10:00'
  UNION ALL
  SELECT 'MARK_SOLD', @item1, (SELECT pair_id FROM pairs WHERE pair_code='P-019'), 1, 3200.00, 'Sold Jordan 4 pair P-019', '2026-04-20 10:11:00'
) AS src
WHERE @seed_user IS NOT NULL;
