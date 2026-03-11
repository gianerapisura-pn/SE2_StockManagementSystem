const express = require('express');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const itemsController = require('../controllers/itemsController');

const router = express.Router();

router.use(requireAuth);

router.get('/', itemsController.getItems);
router.post('/', itemsController.createItem);
router.put('/:itemId/archive', itemsController.archiveItem);
router.put('/:itemId/restore', itemsController.restoreItem);
router.put('/:itemId', itemsController.updateItem);
router.post('/:itemId/mark-sold', itemsController.markItemSold);
router.delete('/:itemId/permanent', requireAdmin, itemsController.permanentDeleteItem);
router.delete('/:itemId', requireAdmin, itemsController.permanentDeleteItem);

module.exports = router;
