// A07 Identification and authentication failures (planted)
if (password === user.password) login(user);
const session = jwt.sign({ id: user.id }, process.env.KEY);
jwt.verify(token, key, { algorithms: ['none'] });
