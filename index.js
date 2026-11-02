const express = require('express');
const path = require('path');

const app = express();
const publicDir = path.join(__dirname, 'public');

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.use(express.static(publicDir));
app.use((req, res) => res.sendFile(path.join(publicDir, 'index.html')));

if (!process.env.VERCEL) app.listen(3000, () => console.log('http://localhost:3000'));

module.exports = app;