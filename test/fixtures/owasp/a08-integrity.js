// A08 Software and data integrity failures (planted)
app.post('/settings', (req, res) => {
  const settings = _.merge({}, defaults, req.body);
  const plugin = require(req.query.plugin);
  res.json(plugin(settings));
});
