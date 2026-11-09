// A01 Broken access control (planted, for coee's tests)
router.get('/orders/:id', async (req, res) => {
  const order = await Order.findById(req.params.id);
  res.json(order);
});
router.post('/users', async (req, res) => {
  const user = await User.create(req.body);
  res.json(user);
});
router.get('/download', (req, res) => res.sendFile('./files/' + req.query.name));
router.get('/go', (req, res) => res.redirect(req.query.next));
