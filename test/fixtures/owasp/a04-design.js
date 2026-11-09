// A04 Insecure design (planted)
app.use(express.json());
const upload = multer({ dest: 'uploads/' });
app.get('/filter', (req, res) => {
  const re = new RegExp(req.query.pattern);
  res.json(items.filter(i => re.test(i.name)));
});
