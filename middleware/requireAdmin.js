const express = require('express');
const router = express.Router();
const tokenDb = require('../utils/tokenDb'); // hast du schon im Server

// Balance eines Users
router.get('/users/:id/balance', async (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ ok:false, message:'Ungültige ID' });

  try {
    const state = await tokenDb.getTokens(id); // { balance, purchased, ... }
    return res.json({ ok:true, ...state });
  } catch (e) {
    console.error('admin balance error:', e);
    return res.status(500).json({ ok:false, message:'Serverfehler' });
  }
});

module.exports = router;
