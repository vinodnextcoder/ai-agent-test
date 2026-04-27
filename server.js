const express = require('express');
const app = express();
const PORT = 3000;

// GET endpoint
app.get('/', (req, res) => {
  res.json({ message: 'Hello from the server!' });
});

// GET endpoint with path parameter
app.get('/api/users/:id', (req, res) => {
  const userId = req.params.id;
  res.json({ userId: userId, name: `User ${userId}` });
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
