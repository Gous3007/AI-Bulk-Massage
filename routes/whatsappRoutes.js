const express = require('express');
const router = express.Router();

router.get('/send-message', (req, res) => res.render('send-message'));

module.exports = router;
