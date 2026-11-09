// A05 Security misconfiguration (planted)
app.use((err, req, res, next) => res.status(500).json({ error: err.stack }));
app.use(cors({ origin: '*' }));
app.use('/files', serveIndex('public'));
