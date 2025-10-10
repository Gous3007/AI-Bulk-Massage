var express = require('express');
var router = express.Router();

/* GET home page. */
router.get('/', function(req, res, next) {
  res.render('index');
});

// router.get("/dashbord", function(req, res, next) {
//   res.render("dashbord");
// });

router.get("/scanner",(req,res,next)=>{
  res.render("scanner");
});

module.exports = router;
