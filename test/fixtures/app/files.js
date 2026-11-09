// Deliberately insecure, for coee's integration tests.
const { exec } = require('child_process');
const fs = require('fs');
exports.read = name => fs.readFileSync('./uploads/' + name);
exports.thumbnail = (title, done) => exec('convert ' + title + ' out.png', done);
exports.calc = expr => eval(expr);
exports.page = todos => '<ul>' + todos.map(t => '<li>' + t.title + '</li>').join('') + '</ul>';
