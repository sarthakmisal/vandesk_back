const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 5500;
app.use(express.static(path.join(__dirname, "public")));
app.get("/api/health", (req, res) => {
  res.json({ message: "Server is running" });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;