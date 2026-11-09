// A10 Server-side request forgery (planted)
app.get('/preview', async (req, res) => {
  const preview = await fetch(req.query.url);
  const status = await fetch(`https://${req.query.host}/health`);
  res.json({ preview: await preview.text(), status: status.status });
});
