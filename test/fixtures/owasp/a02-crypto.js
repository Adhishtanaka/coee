// A02 Cryptographic failures (planted)
const token = jwt.sign({ id }, 'supersecret', { expiresIn: '1h' });
const digest = crypto.createHash('md5').update(password).digest('hex');
const reset = Math.random().toString(36).slice(2);
await fetch('http://payments.example.com/charge');
https.request({ rejectUnauthorized: false });
