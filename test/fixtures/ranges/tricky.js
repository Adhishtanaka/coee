const express = require('express');
const router = express.Router();

/**
 * Builds the page for a list of todos.
 * Braces in this comment { must not count }.
 */
function renderPage(todos) {
  const rows = todos.map(t => `<li class="${t.done ? 'done' : ''}">{${t.title}}</li>`);
  return `<ul>
    ${rows.join('')}
  </ul>`;
}

function isValidTitle(title) {
  const pattern = /^[^{}<>]{1,80}$/; // no braces { or tags
  return typeof title === 'string' && pattern.test(title);
}

// Totals per user, rounded.
const totals = items => items
  .filter(i => i.price > 0)
  .reduce((sum, i) => sum + i.price, 0);

class TodoStore {
  constructor() {
    this.items = new Map();
  }

  add(title) {
    if (!isValidTitle(title)) throw new Error('title must be 1-80 characters, no braces');
    const id = String(this.items.size + 1);
    this.items.set(id, { id, title, done: false });
    return id;
  }
}

router.post('/todos', (req, res) => {
  const id = store.add(req.body.title);
  res.status(201).json({ id });
});

module.exports = { router, renderPage, totals, TodoStore };
