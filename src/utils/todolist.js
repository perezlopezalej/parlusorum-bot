const fs = require('fs');
const path = require('path').join(__dirname, '../../data/todo.json');

function loadTodos() {
  if (!fs.existsSync(path)) return [];
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch { return []; }
}

function saveTodos(todos) {
  fs.writeFileSync(path, JSON.stringify(todos, null, 2));
}

function addTodo(task, username) {
  const todos = loadTodos();
  todos.push({ task, addedBy: username, done: false, ts: Date.now() });
  saveTodos(todos);
  return todos.length;
}

function completeTodo(index) {
  const todos = loadTodos();
  if (index < 1 || index > todos.length) return false;
  todos[index - 1].done = true;
  saveTodos(todos);
  return true;
}

function clearTodos() {
  saveTodos([]);
}

function getTodos() {
  return loadTodos();
}

module.exports = { addTodo, completeTodo, clearTodos, getTodos };
