const todos = [];
exports.list = () => todos;
exports.add = title => { todos.push({ title }); };
