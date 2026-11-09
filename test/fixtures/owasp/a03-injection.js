// A03 Injection (planted)
app.post('/login', async (req, res) => {
  const user = await User.findOne(req.body);
  res.json(user);
});
app.get('/search', (req, res) => {
  db.query(`SELECT * FROM users WHERE name = '${req.query.name}'`);
  exec('ping ' + req.query.host);
  list.innerHTML = req.query.q;
});
