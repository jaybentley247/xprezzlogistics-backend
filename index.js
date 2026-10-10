const { createApp } = require("./app");
const { connect, migrate } = require("./db");

const {
  PORT = 5000,
  ADMIN_USERNAME = "admin",
  ADMIN_PASSWORD,
  TOKEN_SECRET,
  CORS_ORIGIN,
  DATABASE_URL,
} = process.env;

const missing = ["ADMIN_PASSWORD", "TOKEN_SECRET", "DATABASE_URL"].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(
    `Missing ${missing.join(", ")}. Copy backend/.env.example to backend/.env and fill them in.`,
  );
  process.exit(1);
}

async function main() {
  const db = connect(DATABASE_URL);
  await migrate(db);

  const app = createApp({
    db,
    adminUsername: ADMIN_USERNAME,
    adminPassword: ADMIN_PASSWORD,
    tokenSecret: TOKEN_SECRET,
    corsOrigin: CORS_ORIGIN,
  });

  app.listen(PORT, () => {
    console.log(`Xprezz Logistics API listening on http://localhost:${PORT}`);
  });
}

main().catch((err) => {
  console.error("Failed to start:", err.message);
  process.exit(1);
});
