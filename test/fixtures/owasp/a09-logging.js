// A09 Security logging and monitoring failures (planted)
app.post('/session', (req, res) => {
  console.log('login attempt', email, password);
  logger.info('search', req.query);
  try { charge(card); } catch (e) {}
});
