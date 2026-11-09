const http = require('http');
const store = require('./store');

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'GET') return send(res, 200, store.list());
  send(res, 405, { error: 'Method not allowed' });
});

module.exports = server;
